import type { FieldType, ImportIssue, ImportResult, ImportedCollection, ImportedField, JsonValue } from "./definition.ts";
import { TypeormImportError, loadEntityFiles } from "./load.ts";

/*
 * Reads TypeORM's decorator metadata (`getMetadataArgsStorage()`), which is
 * filled when entity classes are loaded. No DataSource is created and no
 * database is contacted. Anything not understood is reported as an issue.
 */

// The parts of TypeORM's metadata args that are read here.
interface TableArgs {
  target: unknown;
  name?: string;
  type: string;
}
interface ColumnArgs {
  target: unknown;
  propertyName: string;
  mode: string;
  options: Record<string, unknown>;
}
interface RelationArgs {
  target: unknown;
  propertyName: string;
  relationType: string;
  type: unknown;
  options: Record<string, unknown>;
}
interface PropertyArgs {
  target: unknown;
  propertyName: string;
  name?: string;
  referencedColumnName?: string;
  strategy?: string;
}
interface Storage {
  tables: TableArgs[];
  columns: ColumnArgs[];
  relations: RelationArgs[];
  generations: PropertyArgs[];
  joinColumns: PropertyArgs[];
  joinTables: PropertyArgs[];
  relationIds: PropertyArgs[];
  embeddeds: PropertyArgs[];
  entityListeners: PropertyArgs[];
  [other: string]: { target: unknown }[];
}

const TYPES: Record<Exclude<FieldType, "unknown">, string[]> = {
  string: [
    "varchar", "char", "text", "uuid", "citext", "nvarchar", "nchar", "varchar2", "nvarchar2",
    "tinytext", "mediumtext", "longtext", "character varying", "character", "string", "enum", "simple-enum",
    // A time of day is text to the application.
    "time", "timetz", "time with time zone", "time without time zone",
  ],
  number: [
    "int", "integer", "smallint", "tinyint", "mediumint", "int2", "int4", "float", "float4", "float8",
    "double", "double precision", "real", "number",
  ],
  boolean: ["boolean", "bool"],
  date: [
    "date", "datetime", "datetime2", "timestamp", "timestamptz", "timestamp with time zone",
    "timestamp without time zone",
  ],
  json: ["json", "jsonb", "simple-json"],
  array: ["simple-array"],
  binary: ["bytea", "blob", "tinyblob", "mediumblob", "longblob", "binary", "varbinary"],
};
// Most drivers return these as strings to avoid losing precision.
const STRING_NUMBERS = ["bigint", "int8", "decimal", "numeric", "dec"];

const SPECIAL_COLUMNS: Record<string, { type: FieldType; decorator: string }> = {
  createDate: { type: "date", decorator: "@CreateDateColumn" },
  updateDate: { type: "date", decorator: "@UpdateDateColumn" },
  deleteDate: { type: "date", decorator: "@DeleteDateColumn" },
  version: { type: "number", decorator: "@VersionColumn" },
};

/** The sandbox field type for a declared column type name, when the name is recognized. */
export function fieldTypeOf(declared: string): Exclude<FieldType, "unknown"> | undefined {
  const name = declared.toLowerCase();
  const known = Object.entries(TYPES).find(([, names]) => names.includes(name));
  return known === undefined ? undefined : (known[0] as Exclude<FieldType, "unknown">);
}

const CONSTRAINT_LISTS =["indices", "uniques", "checks", "exclusions"];

function className(target: unknown): string {
  return typeof target === "function" ? target.name : String(target);
}

/** The class and its parent classes, so inherited columns are included. */
function inheritanceChain(target: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = target; typeof current === "function" && current !== Function.prototype; ) {
    chain.push(current);
    current = Object.getPrototypeOf(current);
  }
  return chain;
}

function toJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map(toJson);
    return items.includes(undefined) ? undefined : (items as JsonValue[]);
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value).map(([key, item]) => [key, toJson(item)] as const);
    return entries.some(([, item]) => item === undefined) ? undefined : (Object.fromEntries(entries) as JsonValue);
  }
  return undefined;
}

/** A whole number that a column declares, as a number or as its digits; nothing for anything else. */
function wholeNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
}

function enumValues(declared: unknown): (string | number)[] | undefined {
  if (typeof declared === "function") {
    return undefined;
  }
  const raw = Array.isArray(declared) ? declared : typeof declared === "object" && declared !== null ? declared : undefined;
  if (raw === undefined) {
    return undefined;
  }
  // A numeric TypeScript enum object also maps each value back to its name; keep the values only.
  const values = Array.isArray(raw)
    ? raw
    : Object.entries(raw)
        .filter(([key, value]) => typeof value === "number" || typeof (raw as Record<string, unknown>)[String(value)] !== "number" || key === value)
        .map(([, value]) => value);
  return values.every((value) => typeof value === "string" || typeof value === "number")
    ? (values as (string | number)[])
    : undefined;
}

class EntityImport {
  readonly fields: ImportedField[] = [];
  readonly chain: unknown[];
  readonly source: string;
  readonly name: string;
  readonly target: unknown;

  constructor(target: unknown, name: string) {
    this.target = target;
    this.name = name;
    this.source = className(target);
    this.chain = inheritanceChain(target);
  }

  /** Entries declared on this class or a parent; a subclass declaration replaces the parent's. */
  own<T extends { target: unknown; propertyName?: string }>(entries: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const target of this.chain) {
      const declared = entries.filter((entry) => entry.target === target);
      const fresh = declared.filter((entry) => entry.propertyName === undefined || !seen.has(entry.propertyName));
      for (const entry of fresh) {
        if (entry.propertyName !== undefined) {
          seen.add(entry.propertyName);
        }
      }
      // Parent declarations come first, as they do in the class body.
      result.unshift(...fresh);
    }
    return result;
  }

  primaryFields(): ImportedField[] {
    return this.fields.filter((field) => field.primary);
  }
}

function importColumn(entity: EntityImport, column: ColumnArgs, storage: Storage, report: Report): ImportedField | undefined {
  const { options, propertyName, mode } = column;
  const issue = (kind: ImportIssue["kind"], message: string, omits?: ImportIssue["omits"]): void => report(kind, entity, propertyName, message, omits);

  const special = SPECIAL_COLUMNS[mode];
  if (mode !== "regular" && special === undefined) {
    // A virtual property is no column of the table.
    issue("unsupported", `Column kind "${mode}" is not supported; the property was skipped.`, mode.startsWith("virtual") ? undefined : "column");
    return undefined;
  }

  const field: ImportedField = { name: propertyName, type: "unknown", primary: options.primary === true, nullable: false };
  if (typeof options.name === "string" && options.name !== propertyName) {
    field.column = options.name;
  }
  const declared = options.type;
  // What the type takes beyond its name: kept as declared, for whoever says what the column is in its database.
  const [length, precision, scale] = [wholeNumber(options.length), wholeNumber(options.precision), wholeNumber(options.scale)];
  Object.assign(field, { ...(length !== undefined && length > 0 && { length }), ...(precision !== undefined && { precision }), ...(scale !== undefined && { scale }) });
  if (typeof options.enumName === "string" && options.enumName !== "") {
    field.enumName = options.enumName;
  }
  if (special !== undefined) {
    field.type = special.type;
    field.sourceType = special.decorator;
    if (typeof declared === "string") {
      field.declaredType = declared;
    }
    field.nullable = mode === "deleteDate";
    // The time a row is created or updated at has a default in its database (`now()`), which is not imported.
    issue("note", `${special.decorator} is imported as a plain field; the sandbox does not set or update it.`, mode === "createDate" || mode === "updateDate" ? "default" : undefined);
  } else if (typeof declared === "string") {
    field.sourceType = declared;
    const known = fieldTypeOf(declared);
    if (known !== undefined) {
      field.type = known;
    } else if (STRING_NUMBERS.includes(declared.toLowerCase())) {
      field.type = "string";
      issue("ambiguous", `Type "${declared}" is imported as a string, because most drivers return it as one.`);
    } else {
      issue("ambiguous", `Column type "${declared}" is not recognized; imported with unknown type.`);
    }
  } else if (typeof declared === "function") {
    field.sourceType = declared.name;
    const byConstructor = new Map<unknown, FieldType>([
      [String, "string"],
      [Number, "number"],
      [Boolean, "boolean"],
      [Date, "date"],
      [Buffer, "binary"],
    ]);
    const type = byConstructor.get(declared);
    if (type !== undefined) {
      field.type = type;
    } else {
      issue("ambiguous", `Property type "${declared.name}" does not map to a simple type; add an explicit column type. Imported with unknown type.`);
    }
  } else {
    issue("ambiguous", "No column type could be determined; imported with unknown type.");
  }

  if (options.array === true) {
    field.type = "array";
    field.array = true;
  }
  if (options.enum !== undefined) {
    const values = enumValues(options.enum);
    if (values === undefined) {
      issue("ambiguous", "Enum values could not be read statically; they were not imported.");
    } else if (options.array !== true) {
      // For an array column the enum describes the elements; the field itself stays an array.
      field.enum = values;
      field.type = values.every((value) => typeof value === "number") ? "number" : "string";
    } else {
      field.elementEnum = values;
    }
  }

  if (!field.primary && special === undefined) {
    field.nullable = options.nullable === true;
  }

  if (options.default !== undefined) {
    const value = typeof options.default === "function" ? undefined : toJson(options.default);
    if (value === undefined) {
      issue("unsupported", "The default is a database expression or non-static value; it was not imported.", "default");
    } else if ((field.type === "array" || field.type === "json") && typeof value === "string") {
      issue("unsupported", "The default is the stored text form of the value, not the value itself; it was not imported.", "default");
    } else {
      field.default = value;
    }
  }

  const generation = entity.own(storage.generations).find((entry) => entry.propertyName === propertyName);
  if (generation?.strategy !== undefined) {
    field.generated = generation.strategy;
  }

  if (options.transformer !== undefined) {
    issue("unsupported", "The column transformer is not applied; stored and exposed values may differ from the application.");
  }
  if (options.select === false) {
    issue("note", "select: false is ignored; the sandbox always returns this field.");
  }
  return field;
}

/** `omits`: what of the entity's schema the collections lack because of it (`ImportIssue.omits`). */
type Report = (kind: ImportIssue["kind"], entity: EntityImport | undefined, property: string | undefined, message: string, omits?: ImportIssue["omits"]) => void;

function importRelation(
  entity: EntityImport,
  relation: RelationArgs,
  entities: EntityImport[],
  storage: Storage,
  typeorm: Record<string, any>,
  report: Report,
): void {
  const { propertyName, relationType } = relation;
  const issue = (kind: ImportIssue["kind"], message: string, omits?: ImportIssue["omits"]): void => report(kind, entity, propertyName, message, omits);
  const joinColumns = entity.own(storage.joinColumns).filter((entry) => entry.propertyName === propertyName);

  if (relationType === "many-to-many") {
    if (entity.own(storage.joinTables).some((entry) => entry.propertyName === propertyName)) {
      issue("unsupported", "Many-to-many relations need a join table, which is not generated.", "table");
    }
    return;
  }
  // The other side of the relation holds the key.
  if (relationType === "one-to-many" || (relationType === "one-to-one" && joinColumns.length === 0)) {
    return;
  }
  if (joinColumns.length > 1) {
    issue("unsupported", "Relations with several join columns are not supported; no key field was imported.", "column");
    return;
  }

  let targetClass: unknown;
  try {
    targetClass = typeof relation.type === "function" && relation.type.prototype === undefined ? (relation.type as () => unknown)() : relation.type;
  } catch {
    targetClass = undefined;
  }
  const target = entities.find(
    (candidate) => candidate.target === targetClass || candidate.source === targetClass || candidate.name === targetClass,
  );
  const joinColumn = joinColumns[0];

  let referenced: ImportedField | undefined;
  if (target === undefined) {
    issue("ambiguous", `The related entity "${className(targetClass)}" was not imported, so the key field's type and target are unknown.`, "key");
  } else if (joinColumn?.referencedColumnName !== undefined) {
    referenced = target.fields.find((field) => field.name === joinColumn.referencedColumnName);
    if (referenced === undefined) {
      issue("ambiguous", `Referenced column "${joinColumn.referencedColumnName}" was not found on ${target.source}.`, "key");
    }
  } else if (target.primaryFields().length === 1) {
    referenced = target.primaryFields()[0];
  } else {
    issue("unsupported", `${target.source} does not have exactly one primary column; no key field was imported.`, "column");
    return;
  }

  const referencedName = referenced?.name ?? joinColumn?.referencedColumnName ?? "id";
  const name = joinColumn?.name ?? (new typeorm.DefaultNamingStrategy().joinColumnName(propertyName, referencedName) as string);
  const onDelete = relation.options.onDelete;
  const references =
    target !== undefined && referenced !== undefined
      ? { collection: target.name, field: referenced.name, ...(typeof onDelete === "string" && { onDelete }) }
      : undefined;

  // Many entities also declare the key as its own @Column; reuse that field.
  const existing = entity.fields.find((field) => field.name === name);
  if (existing !== undefined) {
    if (references !== undefined) {
      existing.references = references;
    }
    return;
  }
  const field: ImportedField = {
    name,
    type: referenced?.type ?? "unknown",
    primary: false,
    nullable: relation.options.nullable !== false,
  };
  if (referenced?.sourceType !== undefined) {
    field.sourceType = referenced.sourceType;
    // A key column is of the type of the column it refers to, with what that type takes.
    const { length, precision, scale } = referenced;
    Object.assign(field, { ...(length !== undefined && { length }), ...(precision !== undefined && { precision }), ...(scale !== undefined && { scale }) });
  }
  if (references !== undefined) {
    field.references = references;
  }
  entity.fields.push(field);
}

/** Converts already-loaded TypeORM metadata into an import result. */
export function importFromMetadata(typeorm: Record<string, any>, exported: Set<unknown>): ImportResult {
  const storage = typeorm.getMetadataArgsStorage() as Storage;
  const naming = new typeorm.DefaultNamingStrategy();
  const issues: ImportIssue[] = [];
  const report: Report = (kind, entity, property, message, omits) => {
    issues.push({ kind, ...(entity && { entity: entity.source }), ...(property !== undefined && { property }), message, ...(omits !== undefined && { omits }) });
  };

  for (const value of exported) {
    if (typeof typeorm.EntitySchema === "function" && value instanceof typeorm.EntitySchema) {
      const name = String((value as { options?: { name?: unknown } }).options?.name ?? "EntitySchema");
      issues.push({ kind: "unsupported", entity: name, message: "Entities defined with EntitySchema are not supported; only decorated classes are imported.", omits: "table" });
    }
  }

  const entities: EntityImport[] = [];
  for (const table of storage.tables.filter((candidate) => exported.has(candidate.target))) {
    const entity = new EntityImport(table.target, naming.tableName(className(table.target), table.name) as string);
    if (table.type !== "regular") {
      // A view is no table.
      report("unsupported", entity, undefined, `Entity kind "${table.type}" is not supported; the entity was skipped.`, table.type === "view" ? undefined : "table");
    } else if (entity.chain.some((target) => storage.inheritances?.some((entry) => entry.target === target))) {
      report("unsupported", entity, undefined, "Table inheritance (@TableInheritance) is not supported; the entity was skipped.", "table");
    } else if (entities.some((other) => other.name === entity.name)) {
      report("unsupported", entity, undefined, `Collection name "${entity.name}" is already used by another entity; the entity was skipped.`, "table");
    } else {
      entities.push(entity);
    }
  }

  for (const entity of entities) {
    for (const column of entity.own(storage.columns)) {
      const field = importColumn(entity, column, storage, report);
      if (field !== undefined) {
        entity.fields.push(field);
      }
    }
    for (const embedded of entity.own(storage.embeddeds)) {
      report("unsupported", entity, embedded.propertyName, "Embedded entities are not supported; the property was skipped.", "column");
    }
    for (const relationId of entity.own(storage.relationIds)) {
      report("unsupported", entity, relationId.propertyName, "@RelationId is not supported; the property was skipped.");
    }
    if (entity.own(storage.entityListeners).length > 0) {
      report("unsupported", entity, undefined, "Lifecycle hooks (@BeforeInsert, @AfterLoad, ...) are not run by the sandbox.");
    }
    if (CONSTRAINT_LISTS.some((list) => storage[list]?.some((entry) => entity.chain.includes(entry.target)))) {
      report("note", entity, undefined, "Indexes and unique/check constraints are not enforced by the sandbox.", "constraints");
    }
  }

  // Relations come second, once every entity's primary column is known.
  for (const entity of entities) {
    for (const relation of entity.own(storage.relations)) {
      importRelation(entity, relation, entities, storage, typeorm, report);
    }
    const primary = entity.primaryFields();
    if (primary.length !== 1 || primary[0]?.name !== "id") {
      const found = primary.length === 0 ? "none" : primary.map((field) => field.name).join(", ");
      report("ambiguous", entity, undefined, `The sandbox identifies rows by a field named "id", but the primary column is: ${found}. Routes such as /${entity.name}/:id will not find rows by that key.`);
    }
  }

  const collections: ImportedCollection[] = entities.map((entity) => ({
    name: entity.name,
    source: entity.source,
    fields: entity.fields,
  }));
  return { collections, issues };
}

/**
 * Imports the TypeORM entity classes found at `path` (a file or a folder).
 *
 * Entity files are loaded inside their own project, using that project's
 * `typeorm` (and `typescript` for TypeScript sources). Loading runs the
 * files' top-level code, as starting the application would.
 */
export function importTypeorm(path: string): ImportResult {
  const { typeorm, exported } = loadEntityFiles(path);
  const result = importFromMetadata(typeorm, exported);
  if (result.collections.length === 0) {
    const details = result.issues.map((issue) => `\n  - ${issue.entity ?? ""}: ${issue.message}`).join("");
    throw new TypeormImportError(`No importable TypeORM entities found in ${path}.${details}`, { reason: "no-entities" });
  }
  return result;
}
