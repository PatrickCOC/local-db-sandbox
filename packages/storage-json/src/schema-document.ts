import { canonicalTypeProblem, copyCanonicalType } from "../../runtime/src/canonical-type.ts";
import type { CanonicalType } from "../../runtime/src/canonical-type.ts";
import { EXPRESSION_NAME_KINDS, copyExpressionName } from "../../runtime/src/expression-names.ts";
import { copyIndexKey, indexKeysProblem } from "../../runtime/src/index-definition.ts";
import type {
  CheckConstraint,
  ColumnReference,
  ColumnSchema,
  ColumnType,
  DatabaseSchema,
  DefaultFunction,
  Deferrable,
  EnumType,
  ExpressionName,
  ForeignKeyConstraint,
  IndexDefinition,
  IndexKey,
  ObjectProvenance,
  PrimaryKeyConstraint,
  SchemaOrigin,
  SchemaRename,
  SchemaTypes,
  SourceClauses,
  SourcePosition,
  TableSchema,
  UniqueConstraint,
} from "../../runtime/src/index.ts";
import { JsonStorageError } from "./storage-error.ts";

/*
 * The stored form of the sandbox's canonical schema: `schema.json` in a
 * directory database, and `$tableSchema` in a single-file database.
 *
 * It describes tables as the sandbox's relational runtime needs them, so
 * that a database can be opened without the ORM project or the migrations it
 * was created from. It is not a general database schema language: the
 * storage types are the runtime's own ten.
 *
 * Unique constraints, foreign keys over several columns, indexes, checks,
 * enumerated values, and computed defaults were added with directory format
 * 4 (D-033). Format 4 was amended before it was released (D-036) to hold as
 * well: enumerated types at the schema level (`types.enums`), which columns
 * name; the primary key as a constraint, with its name and column order;
 * each column's canonical type and its type in the source's dialect; and
 * provenance (`origin`, `renames`). A single-file database (format 1)
 * cannot hold any of these: its readers do not know these keys.
 *
 * Version 2 of the document (directory format 5, D-040) also holds how an
 * index is built and what its keys are (`method`, `keys`, `include`),
 * whether a key or a foreign key is deferrable, the clauses of a source that
 * the schema has no place for (`sourceClauses`), and what the text of an
 * expression names, with what each of those things is called now (`names`).
 *
 * A version 1 document is still read. It could say none of that, and what it
 * does not say means something else there: an index without a method is one
 * whose method was not kept, and an expression whose names are not given is
 * one that a rename may have reached unseen (`markPossiblyStale`). So the
 * version decides how a document is read, and a version 1 document with a
 * key of version 2 is refused.
 */

/** The version of the document that is written. */
export const SCHEMA_VERSION = 2;
/** The version before it, which is still read, and which a single file (format 1) is written in. */
const LEGACY_SCHEMA_VERSION = 1;

/** The keys of an object of the document: those every version has, and those that version 2 added. */
interface Keys {
  known: readonly string[];
  since2?: readonly string[];
}

const COLUMN_TYPES: readonly ColumnType[] = ["integer", "real", "numeric", "text", "boolean", "datetime", "date", "json", "binary", "any"];
const DOCUMENT_KEYS: Keys = { known: ["schemaVersion", "types", "tables"] };
const TYPES_KEYS: Keys = { known: ["enums"] };
const ENUM_KEYS: Keys = { known: ["name", "values", "sourceDialectType", "origin", "renames", "valueRenames"] };
const TABLE_KEYS: Keys = { known: ["name", "columns", "primaryKey", "uniques", "foreignKeys", "indexes", "checks", "origin", "renames"] };
const COLUMN_KEYS: Keys = {
  known: [
    "column",
    "property",
    "type",
    "declaredType",
    "canonicalType",
    "sourceDialectType",
    "nullable",
    "primaryKey",
    "generated",
    "default",
    "defaultFunction",
    "defaultExpression",
    "references",
    "enum",
    "origin",
    "renames",
  ],
  since2: ["defaultNames", "defaultMayBeStale"],
};
const REFERENCE_KEYS: Keys = { known: ["table", "column", "onDelete", "onUpdate", "name", "origin", "renames"], since2: ["deferrable", "sourceClauses"] };
const PRIMARY_KEY_KEYS: Keys = { known: ["name", "columns", "origin", "renames"], since2: ["include", "deferrable", "sourceClauses"] };
const UNIQUE_KEYS: Keys = { known: ["name", "columns", "origin", "renames"], since2: ["include", "deferrable", "nullsNotDistinct", "sourceClauses"] };
const FOREIGN_KEY_KEYS: Keys = { known: ["name", "columns", "references", "onDelete", "onUpdate", "origin", "renames"], since2: ["deferrable", "sourceClauses"] };
const INDEX_KEYS: Keys = { known: ["name", "columns", "unique", "expressions", "where", "origin", "renames"], since2: ["method", "keys", "include", "nullsNotDistinct", "names", "mayBeStale", "sourceClauses"] };
const CHECK_KEYS: Keys = { known: ["name", "expression", "origin", "renames"], since2: ["names", "mayBeStale", "sourceClauses"] };
const INDEX_KEY_KEYS: Keys = { known: ["column", "expression", "order", "nulls", "operatorClass", "collation"] };
const EXPRESSION_NAME_KEYS: Keys = { known: ["kind", "name", "now", "type"] };
const DEFERRABLE: readonly Deferrable[] = ["immediate", "deferred"];
const DIALECT_TYPE_KEYS: Keys = { known: ["dialect", "type"] };
const POSITION_KEYS: Keys = { known: ["source", "file", "sha256", "statement", "line"] };
const ORIGIN_KEYS: Keys = { known: [...POSITION_KEYS.known, "name", "generatedName"] };
const RENAME_KEYS: Keys = { known: ["from", "to", "at"] };
const FOREIGN_KEY_TARGET_KEYS: Keys = { known: ["table", "columns"] };
const DEFAULT_FUNCTIONS: readonly DefaultFunction[] = ["current_timestamp", "current_date"];

/** Provenance as it is stored: on tables, columns, keys, constraints, indexes, and enumerated types. */
interface DocumentProvenance {
  origin?: SchemaOrigin;
  renames?: SchemaRename[];
}

export interface SchemaDocumentColumn extends DocumentProvenance {
  /** Column name in the database, as SQL uses it. */
  column: string;
  /** Key of the value in the table's rows, which is the property name in application code. */
  property: string;
  /** How the values are stored. */
  type: ColumnType;
  /** The type as the source of the definitions declared it, when they came from one. */
  declaredType?: string;
  /** What the type is, independent of its spelling. */
  canonicalType?: CanonicalType;
  /** The type as the source's dialect names it. */
  sourceDialectType?: { dialect: string; type: string };
  nullable: boolean;
  primaryKey: boolean;
  /** How a value is generated when none is given: `increment`, `uuid`, or another strategy name. */
  generated?: string;
  /** Static default value. */
  default?: unknown;
  /** A default the database computes: `current_timestamp` or `current_date`. */
  defaultFunction?: DefaultFunction;
  /** The default as the schema's source wrote it; information only. */
  defaultExpression?: string;
  /** What `defaultExpression` names, with what each of those things is called now. */
  defaultNames?: ExpressionName[];
  /** It is not known what `defaultExpression` names, and a rename may have reached it. */
  defaultMayBeStale?: boolean;
  /** The table and column this column refers to, and what happens to the row when that row is deleted or its key changes. */
  references?: ColumnReference;
  /** The name of the enumerated type (of `types.enums`) whose values the column takes. */
  enum?: string;
}

export interface SchemaDocumentTable extends DocumentProvenance {
  name: string;
  columns: SchemaDocumentColumn[];
  primaryKey?: PrimaryKeyConstraint;
  uniques?: UniqueConstraint[];
  foreignKeys?: ForeignKeyConstraint[];
  indexes?: IndexDefinition[];
  checks?: CheckConstraint[];
}

export interface SchemaDocument {
  schemaVersion: number;
  /** Present when the schema has enumerated types. */
  types?: { enums: EnumType[] };
  tables: SchemaDocumentTable[];
}

// --- what a single file cannot hold -----------------------------------------------

function hasProvenance(entry: ObjectProvenance | undefined): boolean {
  return entry !== undefined && (entry.origin !== undefined || (entry.renames !== undefined && entry.renames.length > 0));
}

function tableHasProvenance(table: TableSchema): boolean {
  return (
    hasProvenance(table) ||
    hasProvenance(table.primaryKey) ||
    table.columns.some((column) => hasProvenance(column) || hasProvenance(column.references)) ||
    [...(table.uniques ?? []), ...(table.foreignKeys ?? []), ...(table.indexes ?? []), ...(table.checks ?? [])].some(hasProvenance)
  );
}

/**
 * What of the definitions a single-file database (format 1) cannot store: a
 * line for the schema's enumerated types, and a line per table. Empty when it
 * can store all of it.
 */
export function beyondFileFormat(tables: readonly TableSchema[], types?: SchemaTypes): string[] {
  const found: string[] = [];
  if (types !== undefined && types.enums.length > 0) {
    found.push(`enumerated types: ${types.enums.map((type) => type.name).join(", ")}`);
  }
  for (const table of tables) {
    const parts = [
      table.primaryKey !== undefined ? "primary key names or order" : undefined,
      table.uniques?.length ? "unique constraints" : undefined,
      table.foreignKeys?.length ? "foreign keys over several columns" : undefined,
      table.indexes?.length ? "indexes" : undefined,
      table.checks?.length ? "check constraints" : undefined,
      table.columns.some((column) => column.enum !== undefined) ? "enumerated values" : undefined,
      table.columns.some((column) => column.defaultFunction !== undefined || column.defaultExpression !== undefined) ? "computed defaults" : undefined,
      table.columns.some((column) => column.references?.onUpdate !== undefined || column.references?.name !== undefined) ? "named foreign keys or ON UPDATE actions" : undefined,
      table.columns.some((column) => column.references?.deferrable !== undefined || (column.references?.sourceClauses?.length ?? 0) > 0) ? "deferrable foreign keys or clauses of the source" : undefined,
      table.columns.some((column) => column.canonicalType !== undefined || column.sourceDialectType !== undefined) ? "canonical types" : undefined,
      tableHasProvenance(table) ? "provenance" : undefined,
    ].filter((part): part is string => part !== undefined);
    if (parts.length > 0) {
      found.push(`${table.name}: ${parts.join(", ")}`);
    }
  }
  return found;
}

// --- writing ----------------------------------------------------------------------

function positionOf(position: SourcePosition): SourcePosition {
  return { source: position.source, file: position.file, sha256: position.sha256, statement: position.statement, line: position.line };
}

function renameOf(rename: SchemaRename): SchemaRename {
  return { from: rename.from, to: rename.to, at: positionOf(rename.at) };
}

/** `origin` and `renames` as they are stored: copies, in a fixed order, and only what is known. */
function provenanceOf(entry: ObjectProvenance): DocumentProvenance {
  return {
    ...(entry.origin !== undefined && {
      origin: { ...positionOf(entry.origin), name: entry.origin.name, ...(entry.origin.generatedName === true && { generatedName: true }) },
    }),
    ...(entry.renames !== undefined && entry.renames.length > 0 && { renames: entry.renames.map(renameOf) }),
  };
}

function dialectTypeOf(value: { dialect: string; type: string }): { dialect: string; type: string } {
  return { dialect: value.dialect, type: value.type };
}

/**
 * What a text names as it is stored, for an object that has a text: the
 * names, also when there are none (the text is known to name nothing that a
 * rename reaches), or that the text may be stale. `key` and `flag` are the
 * keys the two stand under.
 */
function textOf<K extends string, F extends string>(hasText: boolean, names: readonly ExpressionName[] | undefined, mayBeStale: boolean | undefined, key: K, flag: F): { [P in K]?: ExpressionName[] } & { [P in F]?: boolean } {
  if (!hasText) {
    return {};
  }
  return (names !== undefined ? { [key]: names.map(copyExpressionName) } : mayBeStale === true ? { [flag]: true } : {}) as { [P in K]?: ExpressionName[] } & { [P in F]?: boolean };
}

/** `deferrable` and `sourceClauses` as they are stored, and only when they say something. */
function beyondOf(entry: SourceClauses & { deferrable?: Deferrable }): SourceClauses & { deferrable?: Deferrable } {
  return {
    ...(entry.deferrable !== undefined && { deferrable: entry.deferrable }),
    ...(entry.sourceClauses !== undefined && entry.sourceClauses.length > 0 && { sourceClauses: [...entry.sourceClauses] }),
  };
}

function enumTypeOf(type: EnumType): EnumType {
  return {
    name: type.name,
    values: [...type.values],
    ...(type.sourceDialectType !== undefined && { sourceDialectType: dialectTypeOf(type.sourceDialectType) }),
    ...provenanceOf(type),
    ...(type.valueRenames !== undefined && type.valueRenames.length > 0 && { valueRenames: type.valueRenames.map(renameOf) }),
  };
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The enumerated types to store: those given, in their order, then those that
 * columns name and that are not given, in the order they are first named. A
 * type is defined once: a column that resolves a type to other values than
 * the type's is an error.
 */
function enumTypesOf(tables: readonly TableSchema[], types: SchemaTypes | undefined): EnumType[] {
  const enums = new Map<string, EnumType>();
  for (const type of types?.enums ?? []) {
    if (enums.has(type.name)) {
      throw new JsonStorageError(`The enumerated type "${type.name}" is defined more than once.`);
    }
    enums.set(type.name, enumTypeOf(type));
  }
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.enum === undefined) {
        continue;
      }
      const known = enums.get(column.enum.name);
      if (known === undefined) {
        enums.set(column.enum.name, { name: column.enum.name, values: [...column.enum.values] });
      } else if (!sameValues(known.values, column.enum.values)) {
        throw new JsonStorageError(
          `The enumerated type "${column.enum.name}" has the values (${known.values.join(", ")}), but "${table.name}"."${column.name}" gives it the values (${column.enum.values.join(", ")}). A type is defined once.`,
        );
      }
    }
  }
  return [...enums.values()];
}

function columnOf(column: ColumnSchema): SchemaDocumentColumn {
  const generated = column.generated ?? (column.autoIncrement ? "increment" : undefined);
  const reference = column.references;
  return {
    column: column.name,
    property: column.key ?? column.name,
    type: column.type,
    ...(column.declaredType !== undefined && { declaredType: column.declaredType }),
    ...(column.canonicalType !== undefined && { canonicalType: copyCanonicalType(column.canonicalType) }),
    ...(column.sourceDialectType !== undefined && { sourceDialectType: dialectTypeOf(column.sourceDialectType) }),
    nullable: column.nullable,
    primaryKey: column.primary,
    ...(generated !== undefined && { generated }),
    ...(column.default !== undefined && { default: column.default }),
    ...(column.defaultFunction !== undefined && { defaultFunction: column.defaultFunction }),
    ...(column.defaultExpression !== undefined && { defaultExpression: column.defaultExpression }),
    ...textOf(column.defaultExpression !== undefined, column.defaultNames, column.defaultMayBeStale, "defaultNames", "defaultMayBeStale"),
    ...(reference !== undefined && {
      references: {
        table: reference.table,
        column: reference.column,
        ...(reference.onDelete !== undefined && { onDelete: reference.onDelete }),
        ...(reference.onUpdate !== undefined && { onUpdate: reference.onUpdate }),
        ...(reference.name !== undefined && { name: reference.name }),
        ...beyondOf(reference),
        ...provenanceOf(reference),
      },
    }),
    ...(column.enum !== undefined && { enum: column.enum.name }),
    ...provenanceOf(column),
  };
}

function nonEmpty<T, U>(list: readonly T[] | undefined, write: (entry: T) => U): U[] | undefined {
  return list === undefined || list.length === 0 ? undefined : list.map(write);
}

function tableOf(table: TableSchema): SchemaDocumentTable {
  const primaryKey = table.primaryKey;
  const uniques = nonEmpty(
    table.uniques,
    (unique): UniqueConstraint => ({
      ...(unique.name !== undefined && { name: unique.name }),
      columns: [...unique.columns],
      ...(unique.include !== undefined && unique.include.length > 0 && { include: [...unique.include] }),
      ...(unique.deferrable !== undefined && { deferrable: unique.deferrable }),
      ...(unique.nullsNotDistinct === true && { nullsNotDistinct: true }),
      ...beyondOf({ ...(unique.sourceClauses !== undefined && { sourceClauses: unique.sourceClauses }) }),
      ...provenanceOf(unique),
    }),
  );
  const foreignKeys = nonEmpty(
    table.foreignKeys,
    (key): ForeignKeyConstraint => ({
      ...(key.name !== undefined && { name: key.name }),
      columns: [...key.columns],
      references: { table: key.references.table, columns: [...key.references.columns] },
      ...(key.onDelete !== undefined && { onDelete: key.onDelete }),
      ...(key.onUpdate !== undefined && { onUpdate: key.onUpdate }),
      ...beyondOf(key),
      ...provenanceOf(key),
    }),
  );
  const indexes = nonEmpty(table.indexes, (index): IndexDefinition => {
    return {
      name: index.name,
      columns: [...index.columns],
      ...(index.unique === true && { unique: true }),
      ...(index.expressions !== undefined && index.expressions.length > 0 && { expressions: [...index.expressions] }),
      ...(index.where !== undefined && { where: index.where }),
      ...(index.method !== undefined && { method: index.method }),
      ...(index.keys !== undefined && { keys: index.keys.map(copyIndexKey) }),
      ...(index.include !== undefined && index.include.length > 0 && { include: [...index.include] }),
      ...(index.nullsNotDistinct === true && { nullsNotDistinct: true }),
      ...textOf((index.expressions?.length ?? 0) > 0 || index.where !== undefined, index.names, index.mayBeStale, "names", "mayBeStale"),
      ...beyondOf({ ...(index.sourceClauses !== undefined && { sourceClauses: index.sourceClauses }) }),
      ...provenanceOf(index),
    };
  });
  const checks = nonEmpty(table.checks, (check): CheckConstraint => {
    return {
      ...(check.name !== undefined && { name: check.name }),
      expression: check.expression,
      ...textOf(true, check.names, check.mayBeStale, "names", "mayBeStale"),
      ...beyondOf({ ...(check.sourceClauses !== undefined && { sourceClauses: check.sourceClauses }) }),
      ...provenanceOf(check),
    };
  });
  return {
    name: table.name,
    columns: table.columns.map(columnOf),
    ...(primaryKey !== undefined && {
      primaryKey: {
        ...(primaryKey.name !== undefined && { name: primaryKey.name }),
        columns: [...primaryKey.columns],
        ...(primaryKey.include !== undefined && primaryKey.include.length > 0 && { include: [...primaryKey.include] }),
        ...beyondOf(primaryKey),
        ...provenanceOf(primaryKey),
      },
    }),
    ...(uniques !== undefined && { uniques }),
    ...(foreignKeys !== undefined && { foreignKeys }),
    ...(indexes !== undefined && { indexes }),
    ...(checks !== undefined && { checks }),
    ...provenanceOf(table),
  };
}

/**
 * The document to store for a schema. The enumerated types are written once,
 * under `types.enums` (the types given, and those that columns name), and
 * columns name their type. A schema without enumerated types and without the
 * keys of format 4 gives the document it always gave.
 */
export function toSchemaDocument(tables: readonly TableSchema[], types?: SchemaTypes): SchemaDocument {
  const enums = enumTypesOf(tables, types);
  return {
    schemaVersion: SCHEMA_VERSION,
    ...(enums.length > 0 && { types: { enums } }),
    tables: tables.map(tableOf),
  };
}

/**
 * The document a single-file database (format 1) stores: of version 1, as
 * it has always been. Such a file holds nothing that version 2 added
 * (`beyondFileFormat` says what a file cannot hold), so only the number
 * differs.
 */
export function toFileSchemaDocument(tables: readonly TableSchema[]): SchemaDocument {
  return { ...toSchemaDocument(tables), schemaVersion: LEGACY_SCHEMA_VERSION };
}

// --- reading ----------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** The enumerated types that a canonical type names, the element types of arrays included. */
function enumNamesOf(type: CanonicalType): string[] {
  return type.kind === "enum" ? [type.name] : type.kind === "array" ? enumNamesOf(type.element) : [];
}

/**
 * The schema in a stored document: its tables and its enumerated types.
 * `where` names the document in messages. A document written by hand may
 * leave out `property` (the column name), `nullable` (true, except for key
 * columns), and `primaryKey` (false; a column that the table's `primaryKey`
 * lists is a key column).
 *
 * A column's `enum` names a type of `types.enums`. The column is given that
 * type's values (`ColumnSchema.enum`), which the runtime needs to create the
 * table; the type is defined once, in `types.enums`.
 */
export function readSchemaDocument(document: unknown, where: string): DatabaseSchema {
  const fail = (problem: string): never => {
    throw new JsonStorageError(`${where}${problem}`);
  };
  if (!isPlainObject(document) || !Array.isArray(document.tables)) {
    return fail(' must be an object with a "tables" list.');
  }
  if (document.schemaVersion !== undefined && document.schemaVersion !== SCHEMA_VERSION && document.schemaVersion !== LEGACY_SCHEMA_VERSION) {
    return fail(` has schemaVersion ${String(document.schemaVersion)}; this version reads schemaVersion ${LEGACY_SCHEMA_VERSION} and ${SCHEMA_VERSION}.`);
  }
  // A document that states no version was written by hand, and says what it means: it is read as the current version.
  const legacy = document.schemaVersion === LEGACY_SCHEMA_VERSION;
  const unknownKey = (value: Record<string, unknown>, keys: Keys, what: string): void => {
    const since2 = keys.since2 ?? [];
    for (const key of Object.keys(value)) {
      if (since2.includes(key)) {
        if (legacy) {
          fail(`: ${what} has the key "${key}", which a schemaVersion ${LEGACY_SCHEMA_VERSION} document does not have.`);
        }
      } else if (!keys.known.includes(key)) {
        fail(`: ${what} has the unknown key "${key}".`);
      }
    }
  };
  unknownKey(document, DOCUMENT_KEYS, "the schema");

  /** `deferrable` of a key or a foreign key, checked. */
  const deferrableOf = (entry: Record<string, unknown>, what: string): { deferrable?: Deferrable } => {
    if (entry.deferrable === undefined) {
      return {};
    }
    if (!DEFERRABLE.includes(entry.deferrable as Deferrable)) {
      return fail(`: "deferrable" of ${what} must be "immediate" or "deferred".`);
    }
    return { deferrable: entry.deferrable as Deferrable };
  };
  /** `sourceClauses` of a constraint or an index, checked. */
  const clausesOf = (entry: Record<string, unknown>, what: string): SourceClauses => {
    if (entry.sourceClauses === undefined) {
      return {};
    }
    if (!isTextList(entry.sourceClauses)) {
      return fail(`: "sourceClauses" of ${what} must be a list of text.`);
    }
    return entry.sourceClauses.length > 0 ? { sourceClauses: [...entry.sourceClauses] } : {};
  };
  const flagOf = (entry: Record<string, unknown>, key: string, what: string): boolean => {
    if (entry[key] !== undefined && typeof entry[key] !== "boolean") {
      fail(`: "${key}" of ${what} must be true or false.`);
    }
    return entry[key] === true;
  };
  /**
   * What a text names, checked: the names under `key`, or that the text may
   * be stale, under `flag`; nothing when the document says neither.
   * `hasText`: whether the object has a text at all, and what it lacks when
   * it has none. `ofDefault`: the text is a default, which names no column.
   */
  const textIn = (entry: Record<string, unknown>, key: string, flag: string, what: string, hasText: true | string, ofDefault = false): { names?: ExpressionName[]; mayBeStale?: true } => {
    const mayBeStale = flagOf(entry, flag, what);
    const value = entry[key];
    for (const given of [...(value !== undefined ? [key] : []), ...(entry[flag] !== undefined ? [flag] : [])]) {
      if (hasText !== true) {
        fail(`: "${given}" of ${what}: ${hasText}.`);
      }
    }
    if (value === undefined) {
      return mayBeStale ? { mayBeStale: true } : {};
    }
    if (mayBeStale) {
      fail(`: "${flag}" of ${what} says that it is not known what the text names, and "${key}" says what it names: it is one or the other.`);
    }
    if (!Array.isArray(value)) {
      return fail(`: "${key}" of ${what} must be a list.`);
    }
    const names: ExpressionName[] = [];
    for (const [index, item] of (value as unknown[]).entries()) {
      const inName = `name ${index + 1} of "${key}" of ${what}`;
      if (!isPlainObject(item)) {
        return fail(`: ${inName} must be an object with a "kind" and a "name".`);
      }
      unknownKey(item, EXPRESSION_NAME_KEYS, inName);
      const kind = item.kind as ExpressionName["kind"];
      if (!EXPRESSION_NAME_KINDS.includes(kind)) {
        fail(`: "kind" of ${inName} must be one of ${EXPRESSION_NAME_KINDS.join(", ")}.`);
      }
      if (!isName(item.name)) {
        return fail(`: ${inName} needs a "name".`);
      }
      if (item.now !== undefined && !isName(item.now)) {
        fail(`: "now" of ${inName} must be a name.`);
      }
      if (item.now === item.name) {
        fail(`: "now" of ${inName} is the name the text has; it is left out then.`);
      }
      if (kind === "value" ? !isName(item.type) : item.type !== undefined) {
        fail(kind === "value" ? `: ${inName} is a value, and needs the "type" it is a value of.` : `: "type" of ${inName} is for a value.`);
      }
      if (ofDefault && (kind === "column" || kind === "table")) {
        fail(`: ${inName} is of a ${kind}: a default names no column, and not its table.`);
      }
      // A text has a name for one thing of a kind; a value is its type's.
      const earlier = names.findIndex((other) => other.kind === kind && other.name === item.name && other.type === item.type);
      if (earlier >= 0) {
        fail(`: ${inName} is of the ${kind} "${item.name}"${kind === "value" ? ` of "${String(item.type)}"` : ""}, which name ${earlier + 1} is of already.`);
      }
      names.push({ kind, name: item.name, ...(typeof item.now === "string" && { now: item.now }), ...(typeof item.type === "string" && { type: item.type }) });
    }
    return { names };
  };

  const position = (value: unknown, what: string, keys: Keys): SourcePosition => {
    if (!isPlainObject(value)) {
      return fail(`: ${what} must be an object with "source", "file", "sha256", "statement", and "line".`);
    }
    unknownKey(value, keys, what);
    for (const key of ["source", "file", "sha256"]) {
      if (!isName(value[key])) {
        fail(`: "${key}" of ${what} must be a name.`);
      }
    }
    for (const key of ["statement", "line"]) {
      if (!isCount(value[key])) {
        fail(`: "${key}" of ${what} must be a whole number, 1 or more.`);
      }
    }
    return { source: value.source as string, file: value.file as string, sha256: value.sha256 as string, statement: value.statement as number, line: value.line as number };
  };
  const renames = (value: unknown, what: string): SchemaRename[] => {
    if (!Array.isArray(value)) {
      return fail(`: ${what} must be a list of renames.`);
    }
    return value.map((entry: unknown, index: number): SchemaRename => {
      const inRename = `rename ${index + 1} of ${what}`;
      if (!isPlainObject(entry)) {
        return fail(`: ${inRename} must be an object with "from", "to", and "at".`);
      }
      unknownKey(entry, RENAME_KEYS, inRename);
      if (!isName(entry.from) || !isName(entry.to)) {
        return fail(`: ${inRename} needs the names "from" and "to".`);
      }
      return { from: entry.from, to: entry.to, at: position(entry.at, `"at" of ${inRename}`, POSITION_KEYS) };
    });
  };
  /** The `origin` and `renames` of an entry, checked. */
  const provenance = (entry: Record<string, unknown>, what: string): DocumentProvenance => {
    const result: DocumentProvenance = {};
    if (entry.origin !== undefined) {
      const inOrigin = `"origin" of ${what}`;
      const at = position(entry.origin, inOrigin, ORIGIN_KEYS);
      const origin = entry.origin as Record<string, unknown>;
      if (!isName(origin.name)) {
        fail(`: "name" of ${inOrigin} must be a name.`);
      }
      if (origin.generatedName !== undefined && typeof origin.generatedName !== "boolean") {
        fail(`: "generatedName" of ${inOrigin} must be true or false.`);
      }
      result.origin = { ...at, name: origin.name as string, ...(origin.generatedName === true && { generatedName: true }) };
    }
    if (entry.renames !== undefined) {
      const list = renames(entry.renames, `"renames" of ${what}`);
      if (list.length > 0) {
        result.renames = list;
      }
    }
    return result;
  };
  const dialectType = (value: unknown, what: string): { dialect: string; type: string } => {
    if (!isPlainObject(value) || !isName(value.dialect) || !isName(value.type)) {
      return fail(`: ${what} must name a "dialect" and a "type".`);
    }
    unknownKey(value, DIALECT_TYPE_KEYS, what);
    return { dialect: value.dialect, type: value.type };
  };

  // The enumerated types first: columns name them.
  const enums = new Map<string, EnumType>();
  if (document.types !== undefined) {
    const types = document.types;
    if (!isPlainObject(types)) {
      return fail(': "types" must be an object with a list of "enums".');
    }
    unknownKey(types, TYPES_KEYS, '"types"');
    if (types.enums !== undefined && !Array.isArray(types.enums)) {
      return fail(': "enums" of "types" must be a list.');
    }
    for (const [index, entry] of ((types.enums ?? []) as unknown[]).entries()) {
      if (!isPlainObject(entry) || !isName(entry.name)) {
        return fail(`: enumerated type ${index + 1} needs a "name".`);
      }
      const inType = `enumerated type "${entry.name}"`;
      unknownKey(entry, ENUM_KEYS, inType);
      if (enums.has(entry.name)) {
        fail(`: ${inType} is defined more than once.`);
      }
      const values = entry.values;
      if (!isTextList(values)) {
        return fail(`: ${inType} needs a list of text "values".`);
      }
      const repeated = values.find((value, place) => values.indexOf(value) !== place);
      if (repeated !== undefined) {
        fail(`: ${inType} has the value "${repeated}" more than once.`);
      }
      const valueRenames = entry.valueRenames === undefined ? [] : renames(entry.valueRenames, `"valueRenames" of ${inType}`);
      enums.set(entry.name, {
        name: entry.name,
        values: [...values],
        ...(entry.sourceDialectType !== undefined && { sourceDialectType: dialectType(entry.sourceDialectType, `"sourceDialectType" of ${inType}`) }),
        ...provenance(entry, inType),
        ...(valueRenames.length > 0 && { valueRenames }),
      });
    }
  }

  const names = new Set<string>();
  const tables = document.tables.map((table: unknown, tableIndex: number): TableSchema => {
    if (!isPlainObject(table) || typeof table.name !== "string" || table.name === "") {
      return fail(`: table ${tableIndex + 1} needs a name.`);
    }
    const tableName = table.name;
    const inTable = `table "${tableName}"`;
    unknownKey(table, TABLE_KEYS, inTable);
    if (names.has(tableName)) {
      fail(`: ${inTable} is defined more than once.`);
    }
    names.add(tableName);
    if (!Array.isArray(table.columns) || table.columns.length === 0) {
      return fail(`: ${inTable} needs at least one column.`);
    }

    const columnNames = new Set<string>();
    /** Columns whose nullability the document states. For the others it follows from whether they are key columns. */
    const statedNullable = new Set<string>();
    /** The `primaryKey` flag of each column, as the document states it. */
    const flags = new Map<string, boolean | undefined>();
    const columns = table.columns.map((entry: unknown, columnIndex: number): ColumnSchema => {
      if (!isPlainObject(entry) || typeof entry.column !== "string" || entry.column === "") {
        return fail(`: column ${columnIndex + 1} of ${inTable} needs a "column" name.`);
      }
      const inColumn = `column "${entry.column}" of ${inTable}`;
      unknownKey(entry, COLUMN_KEYS, inColumn);
      if (columnNames.has(entry.column)) {
        fail(`: ${inColumn} is defined more than once.`);
      }
      columnNames.add(entry.column);
      if (!COLUMN_TYPES.includes(entry.type as ColumnType)) {
        fail(`: ${inColumn} has the type ${JSON.stringify(entry.type)}; expected one of ${COLUMN_TYPES.join(", ")}.`);
      }
      for (const flag of ["nullable", "primaryKey"]) {
        if (entry[flag] !== undefined && typeof entry[flag] !== "boolean") {
          fail(`: "${flag}" of ${inColumn} must be true or false.`);
        }
      }
      for (const text of ["property", "generated", "declaredType"]) {
        if (entry[text] !== undefined && (typeof entry[text] !== "string" || entry[text] === "")) {
          fail(`: "${text}" of ${inColumn} must be a name.`);
        }
      }
      flags.set(entry.column, entry.primaryKey as boolean | undefined);
      if (typeof entry.nullable === "boolean") {
        statedNullable.add(entry.column);
      }
      const primary = entry.primaryKey === true;
      const column: ColumnSchema = {
        name: entry.column,
        type: entry.type as ColumnType,
        nullable: typeof entry.nullable === "boolean" ? entry.nullable : !primary,
        primary,
      };
      if (typeof entry.property === "string" && entry.property !== entry.column) {
        column.key = entry.property;
      }
      if (typeof entry.declaredType === "string") {
        column.declaredType = entry.declaredType;
      }
      if (entry.canonicalType !== undefined) {
        const problem = canonicalTypeProblem(entry.canonicalType);
        if (problem !== undefined) {
          fail(`: "canonicalType" of ${inColumn} is not a canonical type: ${problem}.`);
        }
        const canonical = copyCanonicalType(entry.canonicalType as CanonicalType);
        const unknownType = enumNamesOf(canonical).find((name) => !enums.has(name));
        if (unknownType !== undefined) {
          fail(`: "canonicalType" of ${inColumn} names the enumerated type "${unknownType}", which "types.enums" does not define.`);
        }
        column.canonicalType = canonical;
      }
      if (entry.sourceDialectType !== undefined) {
        column.sourceDialectType = dialectType(entry.sourceDialectType, `"sourceDialectType" of ${inColumn}`);
      }
      if (typeof entry.generated === "string") {
        column.generated = entry.generated;
      }
      if (entry.default !== undefined) {
        column.default = entry.default;
      }
      if (entry.references !== undefined) {
        const target = entry.references;
        if (!isPlainObject(target) || typeof target.table !== "string" || typeof target.column !== "string") {
          return fail(`: "references" of ${inColumn} needs a "table" and a "column".`);
        }
        const inReference = `"references" of ${inColumn}`;
        unknownKey(target, REFERENCE_KEYS, inReference);
        for (const action of ["onDelete", "onUpdate"]) {
          if (target[action] !== undefined && typeof target[action] !== "string") {
            fail(`: "${action}" of ${inColumn} must be text such as "CASCADE".`);
          }
        }
        if (target.name !== undefined && (typeof target.name !== "string" || target.name === "")) {
          fail(`: "name" in "references" of ${inColumn} must be a name.`);
        }
        column.references = {
          table: target.table,
          column: target.column,
          ...(typeof target.onDelete === "string" && { onDelete: target.onDelete }),
          ...(typeof target.onUpdate === "string" && { onUpdate: target.onUpdate }),
          ...(typeof target.name === "string" && { name: target.name }),
          ...deferrableOf(target, inReference),
          ...clausesOf(target, inReference),
          ...provenance(target, inReference),
        };
      }
      if (entry.defaultFunction !== undefined) {
        if (!DEFAULT_FUNCTIONS.includes(entry.defaultFunction as DefaultFunction)) {
          fail(`: "defaultFunction" of ${inColumn} must be one of ${DEFAULT_FUNCTIONS.join(", ")}.`);
        }
        if (entry.default !== undefined) {
          fail(`: ${inColumn} has both "default" and "defaultFunction"; it can have one.`);
        }
        column.defaultFunction = entry.defaultFunction as DefaultFunction;
      }
      if (entry.defaultExpression !== undefined) {
        if (typeof entry.defaultExpression !== "string" || entry.defaultExpression === "") {
          fail(`: "defaultExpression" of ${inColumn} must be text.`);
        }
        column.defaultExpression = entry.defaultExpression as string;
      }
      const defaultText = textIn(entry, "defaultNames", "defaultMayBeStale", inColumn, column.defaultExpression !== undefined ? true : 'the column has no "defaultExpression"', true);
      if (defaultText.names !== undefined) {
        column.defaultNames = defaultText.names;
      }
      if (defaultText.mayBeStale === true) {
        column.defaultMayBeStale = true;
      }
      if (entry.enum !== undefined) {
        if (isPlainObject(entry.enum)) {
          fail(
            `: "enum" of ${inColumn} is an inline definition. Declare the enumerated type once, under "types": { "enums": [{ "name": ..., "values": [...] }] }, and name it here ("enum": "<type name>").`,
          );
        }
        if (!isName(entry.enum)) {
          fail(`: "enum" of ${inColumn} must name an enumerated type of "types.enums".`);
        }
        const type = enums.get(entry.enum as string);
        if (type === undefined) {
          return fail(`: "enum" of ${inColumn} names the enumerated type "${String(entry.enum)}", which "types.enums" does not define.`);
        }
        column.enum = { name: type.name, values: [...type.values] };
      }
      // The canonical type and `enum` say the same thing twice when a column of an enumerated type carries the type's values; they must agree. A column may also name its type by the canonical type alone (D-040): then it carries no values, and the runtime checks none.
      if (column.canonicalType?.kind === "enum" && column.enum !== undefined && column.enum.name !== column.canonicalType.name) {
        fail(`: ${inColumn} names the enumerated type "${column.enum.name}" in "enum", but its canonical type is of the enumerated type "${column.canonicalType.name}".`);
      }
      if (column.enum !== undefined && column.canonicalType !== undefined && column.canonicalType.kind !== "enum") {
        fail(`: ${inColumn} names the enumerated type "${column.enum.name}" in "enum", but its canonical type is of the kind "${column.canonicalType.kind}".`);
      }
      Object.assign(column, provenance(entry, inColumn));
      return column;
    });

    const constraintList = <T>(key: string, keys: Keys, read: (entry: Record<string, unknown>, what: string) => T): T[] | undefined => {
      const list = table[key];
      if (list === undefined) {
        return undefined;
      }
      if (!Array.isArray(list)) {
        return fail(`: "${key}" of ${inTable} must be a list.`);
      }
      return list.map((entry: unknown, index: number): T => {
        const what = `entry ${index + 1} of "${key}" of ${inTable}`;
        if (!isPlainObject(entry)) {
          return fail(`: ${what} must be an object.`);
        }
        unknownKey(entry, keys, what);
        if (entry.name !== undefined && (typeof entry.name !== "string" || entry.name === "")) {
          fail(`: "name" of ${what} must be a name.`);
        }
        return { ...read(entry, what), ...provenance(entry, what) };
      });
    };
    const columnsOf = (value: unknown, what: string, mayBeEmpty = false): string[] => {
      if (!isTextList(value) || (!mayBeEmpty && value.length === 0)) {
        return fail(`: ${what} needs a list of column names.`);
      }
      const missing = value.find((name) => !columnNames.has(name));
      if (missing !== undefined) {
        fail(`: ${what} names the column "${missing}", which ${inTable} does not have.`);
      }
      return [...value];
    };
    const named = (entry: Record<string, unknown>): { name?: string } => (typeof entry.name === "string" ? { name: entry.name } : {});
    /** `include` of a key or an index: columns of the table; nothing for none. */
    const includeOf = (entry: Record<string, unknown>, what: string): { include?: string[] } => {
      const include = entry.include === undefined ? [] : columnsOf(entry.include, `"include" of ${what}`);
      return include.length > 0 ? { include } : {};
    };

    // The primary key as a constraint: its columns are the key columns, in the key's order.
    let primaryKey: PrimaryKeyConstraint | undefined;
    if (table.primaryKey !== undefined) {
      const entry = table.primaryKey;
      const what = `"primaryKey" of ${inTable}`;
      if (!isPlainObject(entry)) {
        return fail(`: ${what} must be an object with a list of "columns".`);
      }
      unknownKey(entry, PRIMARY_KEY_KEYS, what);
      if (entry.name !== undefined && !isName(entry.name)) {
        fail(`: "name" of ${what} must be a name.`);
      }
      const keyColumns = columnsOf(entry.columns, what);
      const repeated = keyColumns.find((name, place) => keyColumns.indexOf(name) !== place);
      if (repeated !== undefined) {
        fail(`: ${what} names the column "${repeated}" more than once.`);
      }
      for (const column of columns) {
        const listed = keyColumns.includes(column.name);
        const flag = flags.get(column.name);
        if (flag === true && !listed) {
          fail(`: column "${column.name}" of ${inTable} is marked as a key column, but ${what} does not list it.`);
        }
        if (flag === false && listed) {
          fail(`: column "${column.name}" of ${inTable} is marked as not a key column, but ${what} lists it.`);
        }
        if (listed) {
          column.primary = true;
          if (!statedNullable.has(column.name)) {
            column.nullable = false;
          }
        }
      }
      primaryKey = { ...named(entry), columns: keyColumns, ...includeOf(entry, what), ...deferrableOf(entry, what), ...clausesOf(entry, what), ...provenance(entry, what) };
    }

    const uniques = constraintList("uniques", UNIQUE_KEYS, (entry, what): UniqueConstraint => {
      const nullsNotDistinct = flagOf(entry, "nullsNotDistinct", what);
      return { ...named(entry), columns: columnsOf(entry.columns, what), ...includeOf(entry, what), ...deferrableOf(entry, what), ...(nullsNotDistinct && { nullsNotDistinct: true }), ...clausesOf(entry, what) };
    });
    const foreignKeys = constraintList("foreignKeys", FOREIGN_KEY_KEYS, (entry, what): ForeignKeyConstraint => {
      const target = entry.references;
      if (!isPlainObject(target) || typeof target.table !== "string" || !isTextList(target.columns) || target.columns.length === 0) {
        return fail(`: "references" of ${what} needs a "table" and a list of "columns".`);
      }
      unknownKey(target, FOREIGN_KEY_TARGET_KEYS, `"references" of ${what}`);
      for (const action of ["onDelete", "onUpdate"]) {
        if (entry[action] !== undefined && typeof entry[action] !== "string") {
          fail(`: "${action}" of ${what} must be text such as "CASCADE".`);
        }
      }
      return {
        ...named(entry),
        columns: columnsOf(entry.columns, what),
        references: { table: target.table, columns: [...target.columns] },
        ...(typeof entry.onDelete === "string" && { onDelete: entry.onDelete }),
        ...(typeof entry.onUpdate === "string" && { onUpdate: entry.onUpdate }),
        ...deferrableOf(entry, what),
        ...clausesOf(entry, what),
      };
    });
    /** The `keys` of an index, each checked as far as one key goes; `undefined` when the index has none. */
    const keysOf = (value: unknown, what: string): IndexKey[] | undefined => {
      if (value === undefined) {
        return undefined;
      }
      if (!Array.isArray(value) || !value.every(isPlainObject)) {
        return fail(`: "keys" of ${what} must be a list of keys.`);
      }
      return value.map((key: Record<string, unknown>, index: number): IndexKey => {
        const inKey = `key ${index + 1} of ${what}`;
        unknownKey(key, INDEX_KEY_KEYS, inKey);
        for (const text of ["column", "expression", "operatorClass", "collation"]) {
          if (key[text] !== undefined && !isName(key[text])) {
            fail(`: "${text}" of ${inKey} must be a name.`);
          }
        }
        // What an order or a place for NULLs may be is said with the rest of what keys have to be, below.
        return copyIndexKey(key as IndexKey);
      });
    };
    const indexes = constraintList("indexes", INDEX_KEYS, (entry, what): IndexDefinition => {
      if (typeof entry.name !== "string") {
        return fail(`: ${what} needs a "name".`);
      }
      if (entry.unique !== undefined && typeof entry.unique !== "boolean") {
        fail(`: "unique" of ${what} must be true or false.`);
      }
      if (entry.expressions !== undefined && !isTextList(entry.expressions)) {
        fail(`: "expressions" of ${what} must be a list of text.`);
      }
      if (entry.where !== undefined && (typeof entry.where !== "string" || entry.where === "")) {
        fail(`: "where" of ${what} must be text.`);
      }
      if (entry.method !== undefined && !isName(entry.method)) {
        fail(`: "method" of ${what} must be a name.`);
      }
      const expressions = entry.expressions as string[] | undefined;
      const columns = columnsOf(entry.columns, what, (expressions?.length ?? 0) > 0);
      const keys = keysOf(entry.keys, what);
      const problem = indexKeysProblem({ columns, expressions, keys });
      if (problem !== undefined) {
        fail(`: ${what}: ${problem}.`);
      }
      const nullsNotDistinct = flagOf(entry, "nullsNotDistinct", what);
      if (nullsNotDistinct && entry.unique !== true) {
        fail(`: "nullsNotDistinct" of ${what} is for a unique index.`);
      }
      const text = textIn(entry, "names", "mayBeStale", what, (expressions?.length ?? 0) > 0 || entry.where !== undefined ? true : "the index has no expression and no condition");
      return {
        name: entry.name,
        columns,
        ...(entry.unique === true && { unique: true }),
        ...(expressions !== undefined && expressions.length > 0 && { expressions: [...expressions] }),
        ...(typeof entry.where === "string" && { where: entry.where }),
        ...(typeof entry.method === "string" && { method: entry.method }),
        ...(keys !== undefined && { keys }),
        ...includeOf(entry, what),
        ...(nullsNotDistinct && { nullsNotDistinct: true }),
        ...text,
        ...clausesOf(entry, what),
      };
    });
    const checks = constraintList("checks", CHECK_KEYS, (entry, what): CheckConstraint => {
      if (typeof entry.expression !== "string" || entry.expression === "") {
        return fail(`: ${what} needs an "expression".`);
      }
      return { ...named(entry), expression: entry.expression, ...textIn(entry, "names", "mayBeStale", what, true), ...clausesOf(entry, what) };
    });

    // The database can generate the key only when it is the table's one key column and an integer.
    const keys = columns.filter((column) => column.primary);
    const [key] = keys;
    if (keys.length === 1 && key !== undefined && key.generated === "increment" && key.type === "integer") {
      key.autoIncrement = true;
    }
    return {
      name: tableName,
      columns,
      ...(primaryKey !== undefined && { primaryKey }),
      ...(uniques !== undefined && uniques.length > 0 && { uniques }),
      ...(foreignKeys !== undefined && foreignKeys.length > 0 && { foreignKeys }),
      ...(indexes !== undefined && indexes.length > 0 && { indexes }),
      ...(checks !== undefined && checks.length > 0 && { checks }),
      ...provenance(table, inTable),
    };
  });
  if (legacy) {
    markPossiblyStale(tables, enums);
  }
  return { tables, types: { enums: [...enums.values()] } };
}

/**
 * What a version 1 document could not say of its expressions (D-040). A
 * rename leaves the text of an expression as it was, and version 1 had no
 * place to record what a text names. So where a rename is recorded that may
 * have reached a text, the text is taken to be possibly stale: an expression
 * of a table, when the table or one of its columns was renamed; and every
 * expression, a default too, when an enumerated type or a value of one was,
 * since a text of any table may name those. (A default names no column.)
 *
 * A document that records no rename is not touched: one written by hand
 * records none. Nor is a document of version 2, which says what it means.
 */
function markPossiblyStale(tables: TableSchema[], enums: ReadonlyMap<string, EnumType>): void {
  const recorded = (entry: ObjectProvenance): boolean => (entry.renames?.length ?? 0) > 0;
  const typesRenamed = [...enums.values()].some((type) => recorded(type) || (type.valueRenames?.length ?? 0) > 0);
  for (const table of tables) {
    if (typesRenamed || recorded(table) || table.columns.some(recorded)) {
      for (const check of table.checks ?? []) {
        check.mayBeStale = true;
      }
      for (const index of table.indexes ?? []) {
        if ((index.expressions?.length ?? 0) > 0 || index.where !== undefined) {
          index.mayBeStale = true;
        }
      }
    }
    for (const column of table.columns) {
      if (typesRenamed && column.defaultExpression !== undefined) {
        column.defaultMayBeStale = true;
      }
    }
  }
}

/**
 * The table definitions of a stored document (see `readSchemaDocument`), each
 * column's enumerated type resolved.
 */
export function parseSchemaDocument(document: unknown, where: string): TableSchema[] {
  return readSchemaDocument(document, where).tables;
}

/** Whether two sets of table definitions would be stored as the same document. */
export function sameSchema(a: readonly TableSchema[] | undefined, b: readonly TableSchema[] | undefined): boolean {
  return JSON.stringify(toSchemaDocument(a ?? [])) === JSON.stringify(toSchemaDocument(b ?? []));
}

/** Whether two schemas, their tables and their enumerated types, would be stored as the same document. */
export function sameDatabaseSchema(
  a: { tables?: readonly TableSchema[] | undefined; types?: SchemaTypes | undefined },
  b: { tables?: readonly TableSchema[] | undefined; types?: SchemaTypes | undefined },
): boolean {
  return JSON.stringify(toSchemaDocument(a.tables ?? [], a.types)) === JSON.stringify(toSchemaDocument(b.tables ?? [], b.types));
}

/**
 * The stored definitions after new ones are given: a table that is given
 * again is replaced where it is, a table that is not is kept, and tables that
 * are new are added at the end.
 *
 * Whoever gives definitions knows its own tables, as an application knows its
 * entities, and may not know every table of the database. So what it does
 * not mention is not taken to be gone.
 */
/** The enumerated types of a schema with those that are given: one of a name that is stored already replaces it, in its place; the others are kept, and new ones follow. */
export function mergeTypes(stored: SchemaTypes | undefined, given: SchemaTypes): SchemaTypes {
  const replacements = new Map(given.enums.map((type) => [type.name, type]));
  const kept = (stored?.enums ?? []).map((type) => replacements.get(type.name) ?? type);
  const known = new Set(kept.map((type) => type.name));
  return { enums: [...kept, ...given.enums.filter((type) => !known.has(type.name))] };
}

export function mergeSchemas(stored: readonly TableSchema[] | undefined, given: readonly TableSchema[]): TableSchema[] {
  const replacements = new Map(given.map((table) => [table.name, table]));
  const kept = (stored ?? []).map((table) => replacements.get(table.name) ?? table);
  const known = new Set(kept.map((table) => table.name));
  return [...kept, ...given.filter((table) => !known.has(table.name))];
}
