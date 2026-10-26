import { canonicalTypeKey, copyCanonicalType } from "../../runtime/src/canonical-type.ts";
import type { CanonicalType } from "../../runtime/src/canonical-type.ts";
import { copyExpressionName, namesAfterRename } from "../../runtime/src/expression-names.ts";
import type { RenamedThing } from "../../runtime/src/expression-names.ts";
import { copyIndexKey } from "../../runtime/src/index-definition.ts";
import type { CheckConstraint, ColumnSchema, DatabaseSchema, Deferrable, EnumType, ExpressionName, IndexDefinition, ObjectProvenance, PrimaryKeyConstraint, TableSchema, UniqueConstraint } from "../../runtime/src/index.ts";
import type { CheckState, ColumnState, DefaultState, EnumState, ForeignKeyState, IndexState, PrimaryKeyState, TableState, TypeState, UniqueState } from "../../schema-diff/src/index.ts";
import { compareText, stableStringify } from "../../schema-diff/src/stable-json.ts";

/*
 * A canonical schema as something that can be changed step by step (D-038):
 * a copy of its own, with what a schema says in two places said in one.
 *
 * - A table's foreign keys are one list. A schema keeps a key over one
 *   column on that column (`references`) and the others in the table's list;
 *   the model remembers which, and writes them back the same way.
 * - A table's primary key is always there as a key, also when only the
 *   columns' marks give it (`implicit`).
 * - The enumerated types are one list, also those that only columns give
 *   (`listed: false`).
 *
 * What the text of an expression names is kept with the text (D-040). A
 * rename is followed there exactly where the schema says what the text
 * names; where it does not, a text that the rename can reach may be stale
 * from then on, and is said to be.
 *
 * Things refer to each other by name, as in a schema, and a rename here
 * takes what refers to the renamed thing along. Everything that reads a
 * schema as the diff's states (`ir.ts` of the schema diff) is here too, so
 * that a state is made in one place.
 */

export interface ModelColumn extends Omit<ColumnSchema, "references"> {}

export interface ModelPrimaryKey extends PrimaryKeyConstraint {
  /** Only the columns' marks give this key: the schema has no constraint for it, and so no name and no order of its own. */
  implicit?: true;
}

export interface ModelForeignKey extends ObjectProvenance {
  name?: string;
  columns: string[];
  table: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
  deferrable?: Deferrable;
  sourceClauses?: string[];
  /** Written on its column (`references`), not in the table's list. At most one key of a column is. */
  inline: boolean;
}

export interface ModelTable extends ObjectProvenance {
  name: string;
  columns: ModelColumn[];
  primaryKey?: ModelPrimaryKey;
  uniques: UniqueConstraint[];
  foreignKeys: ModelForeignKey[];
  checks: CheckConstraint[];
  indexes: IndexDefinition[];
  /** The lists the schema had for this table, also empty ones: they are written back as they were. */
  lists: Set<"uniques" | "foreignKeys" | "checks" | "indexes">;
}

export interface ModelEnum extends EnumType {
  /** In the schema's list of types. A type that only columns give is not. */
  listed: boolean;
}

function normalizeAction(action: string | undefined): string {
  return action === undefined ? "NO ACTION" : action.trim().replace(/\s+/g, " ").toUpperCase();
}

/** The names of the enumerated types a canonical type is made of: its own, or that of its elements. */
function enumNamesIn(type: CanonicalType | undefined): string[] {
  return type === undefined ? [] : type.kind === "enum" ? [type.name] : type.kind === "array" ? enumNamesIn(type.element) : [];
}

function withEnumRenamed(type: CanonicalType, from: string, to: string): CanonicalType {
  if (type.kind === "enum") {
    return type.name === from ? { kind: "enum", name: to } : type;
  }
  if (type.kind === "array") {
    const element = withEnumRenamed(type.element, from, to);
    return element === type.element ? type : { kind: "array", element };
  }
  return type;
}

// --- a schema read as the diff's states ------------------------------------------

export function typeState(column: ModelColumn): TypeState {
  return {
    storage: column.type,
    ...(column.canonicalType !== undefined && { canonical: copyCanonicalType(column.canonicalType) }),
    ...(column.declaredType !== undefined && { declared: column.declaredType }),
    ...(column.canonicalType === undefined && column.enum !== undefined && { enum: column.enum.name }),
  };
}

/** What a schema says of the text of an expression: what it names, or that it may be stale. */
interface TextNames {
  names?: readonly ExpressionName[] | undefined;
  mayBeStale?: boolean | undefined;
}

/** What a schema says of a text, as a state and as a schema have it: copies, and only what is said. */
function textOf(text: TextNames): { names?: ExpressionName[]; mayBeStale?: true } {
  return text.names !== undefined ? { names: text.names.map(copyExpressionName) } : text.mayBeStale === true ? { mayBeStale: true } : {};
}

/** Whether an index has a text: an expression among its keys, or a condition. */
function hasText(index: { expressions?: readonly string[] | undefined; where?: string | undefined }): boolean {
  return (index.expressions?.length ?? 0) > 0 || index.where !== undefined;
}

/** What a key or a constraint is beyond its columns, as a state and as a schema have it: only what says something. */
function partsOf(key: { include?: readonly string[] | undefined; deferrable?: Deferrable | undefined; sourceClauses?: readonly string[] | undefined }): { include?: string[]; deferrable?: Deferrable; sourceClauses?: string[] } {
  return {
    ...(key.include !== undefined && key.include.length > 0 && { include: [...key.include] }),
    ...(key.deferrable !== undefined && { deferrable: key.deferrable }),
    ...(key.sourceClauses !== undefined && key.sourceClauses.length > 0 && { sourceClauses: [...key.sourceClauses] }),
  };
}

export function defaultState(column: ModelColumn): DefaultState | undefined {
  if (column.autoIncrement === true || column.generated === "increment") {
    return { kind: "increment" };
  }
  // The text of the default, when it has one, with what the schema says of it.
  const text = column.defaultExpression === undefined ? {} : { expression: column.defaultExpression, ...textOf({ names: column.defaultNames, mayBeStale: column.defaultMayBeStale }) };
  if (column.defaultFunction !== undefined) {
    return { kind: "function", function: column.defaultFunction, ...text };
  }
  // A default of null is no default.
  if (column.default !== undefined && column.default !== null) {
    return { kind: "value", value: structuredClone(column.default) };
  }
  if (column.generated !== undefined) {
    return { kind: "generated", strategy: column.generated, ...text };
  }
  return column.defaultExpression === undefined ? undefined : { kind: "expression", expression: column.defaultExpression, ...textOf({ names: column.defaultNames, mayBeStale: column.defaultMayBeStale }) };
}

const originOf = (object: ObjectProvenance): { origin?: NonNullable<ObjectProvenance["origin"]> } => (object.origin === undefined ? {} : { origin: { ...object.origin } });

export function columnState(column: ModelColumn): ColumnState {
  const fallback = defaultState(column);
  return { name: column.name, type: typeState(column), nullable: column.nullable, ...(fallback !== undefined && { default: fallback }), ...originOf(column) };
}

export function primaryKeyState(key: ModelPrimaryKey): PrimaryKeyState {
  return { ...(key.name !== undefined && { name: key.name }), columns: [...key.columns], ...partsOf(key), ...originOf(key) };
}

export function uniqueState(unique: UniqueConstraint): UniqueState {
  const { include, deferrable, sourceClauses } = partsOf(unique);
  return {
    ...(unique.name !== undefined && { name: unique.name }),
    columns: [...unique.columns],
    ...(include !== undefined && { include }),
    ...(deferrable !== undefined && { deferrable }),
    ...(unique.nullsNotDistinct === true && { nullsNotDistinct: true as const }),
    ...(sourceClauses !== undefined && { sourceClauses }),
    ...originOf(unique),
  };
}

export function foreignKeyState(key: ModelForeignKey): ForeignKeyState {
  return {
    ...(key.name !== undefined && { name: key.name }),
    columns: [...key.columns],
    references: { table: key.table, columns: [...key.refColumns] },
    onDelete: normalizeAction(key.onDelete),
    onUpdate: normalizeAction(key.onUpdate),
    ...partsOf(key),
    ...originOf(key),
  };
}

export function checkState(check: CheckConstraint): CheckState {
  return { ...(check.name !== undefined && { name: check.name }), expression: check.expression, ...textOf(check), ...partsOf(check), ...originOf(check) };
}

export function indexState(index: IndexDefinition): IndexState {
  const { include, sourceClauses } = partsOf(index);
  return {
    name: index.name,
    columns: [...index.columns],
    ...(index.expressions !== undefined && index.expressions.length > 0 && { expressions: [...index.expressions] }),
    unique: index.unique === true,
    ...(index.where !== undefined && { where: index.where }),
    ...(index.method !== undefined && { method: index.method }),
    ...(index.keys !== undefined && { keys: index.keys.map(copyIndexKey) }),
    ...(include !== undefined && { include }),
    ...(index.nullsNotDistinct === true && { nullsNotDistinct: true as const }),
    ...(hasText(index) ? textOf(index) : {}),
    ...(sourceClauses !== undefined && { sourceClauses }),
    ...originOf(index),
  };
}

// --- a state read as what a schema holds -----------------------------------------

export function uniqueFromState(state: UniqueState): UniqueConstraint {
  const { origin: _origin, ...unique } = uniqueState(state);
  return { ...unique, ...originOf(state) };
}

export function checkFromState(state: CheckState): CheckConstraint {
  const { origin: _origin, ...check } = checkState(state);
  return { ...check, ...originOf(state) };
}

export function indexFromState(state: IndexState): IndexDefinition {
  const { origin: _origin, unique, ...index } = indexState(state);
  return { ...index, ...(unique && { unique: true }), ...originOf(state) };
}

/** A rename is followed in a text: exactly, where the schema says what the text names; and where it does not, the text may be stale from here on. */
function followIn(text: { names?: ExpressionName[]; mayBeStale?: boolean }, renamed: RenamedThing): void {
  if (text.names !== undefined) {
    text.names = namesAfterRename(text.names, renamed);
  } else {
    text.mayBeStale = true;
  }
}

/** As `followIn`, for a column's default, when that is an expression. */
function followInDefault(column: ModelColumn, renamed: RenamedThing): void {
  if (column.defaultExpression === undefined) {
    return;
  }
  if (column.defaultNames !== undefined) {
    column.defaultNames = namesAfterRename(column.defaultNames, renamed);
  } else {
    column.defaultMayBeStale = true;
  }
}

export function enumState(type: ModelEnum): EnumState {
  return { name: type.name, values: [...type.values], ...originOf(type) };
}

/** States in one order, whatever order they are listed in. */
function inOrder<T extends { name?: string }>(states: T[]): T[] {
  const keyOf = (state: T): string => `${state.name ?? ""}\u0000${stableStringify(state)}`;
  return [...states].sort((a, b) => compareText(keyOf(a), keyOf(b)));
}

/** A table as a change describes it. `withDependents`: with its foreign keys and indexes, as for a table that is dropped. */
export function tableState(table: ModelTable, withDependents: boolean): TableState {
  return {
    name: table.name,
    columns: table.columns.map(columnState),
    ...(table.primaryKey !== undefined && { primaryKey: primaryKeyState(table.primaryKey) }),
    uniques: inOrder(table.uniques.map(uniqueState)),
    checks: inOrder(table.checks.map(checkState)),
    ...(withDependents && { foreignKeys: inOrder(table.foreignKeys.map(foreignKeyState)), indexes: inOrder(table.indexes.map(indexState)) }),
    ...originOf(table),
  };
}

const UNORDERED_LISTS = new Set(["uniques", "checks", "foreignKeys", "indexes"]);
/** What a schema says of where a thing comes from and of what a text names: no part of what the thing is. */
const INFORMATION = new Set(["origin", "names", "mayBeStale"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The spaces that SQL takes for layout, as the schema diff has them. */
const LAYOUT = "[ \\t\\n\\r\\f\\v]+";
const EXPRESSIONS = new Set(["expression", "expressions", "where"]);

/**
 * An expression as the schema diff compares expressions: as written, apart
 * from its layout, and exactly when it has a character that quotes in some
 * dialect or starts a comment. (The diff keeps this rule to itself; a test
 * holds the two together.)
 */
function expressionText(text: string): string {
  const trimmed = text.replace(new RegExp(`^${LAYOUT}|${LAYOUT}$`, "g"), "");
  return /['"`$#[]|--|\/\*/.test(trimmed) ? trimmed : trimmed.replace(new RegExp(LAYOUT, "g"), " ");
}

/**
 * A state as text that two states share exactly when they mean the same, as
 * the schema diff compares them. Where a thing comes from is left out; a
 * type is its canonical type when it has one, and what was declared
 * otherwise; a default that the runtime computes is what it computes; an
 * expression is its text apart from its layout, whatever the schema says of
 * what the text names; and a list whose order says nothing is in one order.
 */
export function comparable(state: unknown): string {
  const plain = (value: unknown, key?: string): unknown => {
    if (typeof value === "string" && key !== undefined && EXPRESSIONS.has(key)) {
      return expressionText(value);
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => plain(item, key !== undefined && EXPRESSIONS.has(key) ? key : undefined));
      // The columns of a table are states; the columns of a key are names, and their order is the key's. What a key or an index carries along has no order.
      const unordered = key !== undefined && (UNORDERED_LISTS.has(key) || key === "include" || (key === "columns" && items.some(isPlainObject)));
      return unordered ? items.map((item) => stableStringify(item)).sort(compareText) : items;
    }
    if (!isPlainObject(value)) {
      return value;
    }
    if ("storage" in value) {
      const type = value as unknown as TypeState;
      return type.canonical !== undefined ? { canonical: canonicalTypeKey(type.canonical) } : { storage: type.storage, declared: (type.declared ?? "").trim().replace(/\s+/g, " ").toLowerCase(), enum: type.enum };
    }
    // A default that is a value is compared as it is: its keys are its own.
    if (value.kind === "value") {
      return { kind: "value", value: value.value };
    }
    // A default that the runtime computes is what it computes, however the source wrote it (`now()`, `current_timestamp`).
    if (value.kind === "function" && typeof value.function === "string") {
      return { kind: "function", function: value.function };
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !INFORMATION.has(name))
        .map(([name, inner]) => [name, plain(inner, name)]),
    );
  };
  return stableStringify(plain(state));
}

// --- the model -------------------------------------------------------------------

export class SchemaModel {
  tables: ModelTable[];
  enums: ModelEnum[];

  private constructor(tables: ModelTable[], enums: ModelEnum[]) {
    this.tables = tables;
    this.enums = enums;
  }

  /** A model of a schema. The schema is copied: nothing done to the model reaches it. */
  static from(schema: DatabaseSchema): SchemaModel {
    const copy = structuredClone(schema);
    const enums: ModelEnum[] = copy.types.enums.map((type) => ({ ...type, listed: true }));
    // Types that only columns give; of columns that disagree, the first by table and column, as the diff takes it.
    const given = copy.tables
      .flatMap((table) => table.columns.flatMap((column) => (column.enum === undefined ? [] : [{ place: `${table.name}\u0000${column.name}`, type: column.enum }])))
      .sort((a, b) => compareText(a.place, b.place));
    for (const { type } of given) {
      if (!enums.some((known) => known.name === type.name)) {
        enums.push({ name: type.name, values: [...type.values], listed: false });
      }
    }
    const tables = copy.tables.map((table): ModelTable => {
      const foreignKeys: ModelForeignKey[] = [];
      const columns = table.columns.map(({ references, ...column }): ModelColumn => {
        if (references !== undefined) {
          const { table: target, column: refColumn, ...rest } = references;
          foreignKeys.push({ ...rest, columns: [column.name], table: target, refColumns: [refColumn], inline: true });
        }
        return column;
      });
      for (const { references, ...key } of table.foreignKeys ?? []) {
        foreignKeys.push({ ...key, table: references.table, refColumns: references.columns, inline: false });
      }
      const marked = columns.filter((column) => column.primary).map((column) => column.name);
      const primaryKey: ModelPrimaryKey | undefined = table.primaryKey ?? (marked.length === 0 ? undefined : { columns: marked, implicit: true });
      return {
        name: table.name,
        columns,
        ...(primaryKey !== undefined && { primaryKey }),
        uniques: table.uniques ?? [],
        foreignKeys,
        checks: table.checks ?? [],
        indexes: table.indexes ?? [],
        lists: new Set((["uniques", "foreignKeys", "checks", "indexes"] as const).filter((list) => table[list] !== undefined)),
        ...(table.origin !== undefined && { origin: table.origin }),
        ...(table.renames !== undefined && { renames: table.renames }),
      };
    });
    return new SchemaModel(tables, enums);
  }

  /** The model as a canonical schema, of its own: later changes to the model do not reach it. */
  toSchema(): DatabaseSchema {
    const tables = this.tables.map((table): TableSchema => {
      const inline = new Map(table.foreignKeys.filter((key) => key.inline).map((key) => [key.columns[0] as string, key]));
      const listed = table.foreignKeys.filter((key) => !key.inline);
      const kept = <T>(list: "uniques" | "foreignKeys" | "checks" | "indexes", items: T[]): Record<string, T[]> => (items.length > 0 || table.lists.has(list) ? { [list]: items } : {});
      const { implicit: _implicit, ...primaryKey } = table.primaryKey ?? {};
      return structuredClone({
        name: table.name,
        columns: table.columns.map((column): ColumnSchema => {
          const key = inline.get(column.name);
          if (key === undefined) {
            return column;
          }
          const { columns: _columns, table: target, refColumns, inline: _inline, ...rest } = key;
          return { ...column, references: { table: target, column: refColumns[0] as string, ...rest } };
        }),
        ...(table.primaryKey !== undefined && table.primaryKey.implicit !== true && { primaryKey: primaryKey as PrimaryKeyConstraint }),
        ...kept("uniques", table.uniques),
        ...kept(
          "foreignKeys",
          listed.map(({ table: target, refColumns, inline: _inline, columns, name, onDelete, onUpdate, ...provenance }) => ({
            ...(name !== undefined && { name }),
            columns,
            references: { table: target, columns: refColumns },
            ...(onDelete !== undefined && { onDelete }),
            ...(onUpdate !== undefined && { onUpdate }),
            ...provenance,
          })),
        ),
        ...kept("indexes", table.indexes),
        ...kept("checks", table.checks),
        ...(table.origin !== undefined && { origin: table.origin }),
        ...(table.renames !== undefined && { renames: table.renames }),
      }) as TableSchema;
    });
    // A type that only columns gave is written with the types once no column gives it any more: it is still a type of the schema.
    const given = new Set(this.tables.flatMap((table) => table.columns.flatMap((column) => (column.enum === undefined ? [] : [column.enum.name]))));
    const enums = this.enums.filter((type) => type.listed || !given.has(type.name)).map(({ listed: _listed, ...type }) => structuredClone(type));
    return { tables, types: { enums } };
  }

  table(name: string): ModelTable | undefined {
    return this.tables.find((table) => table.name === name);
  }

  enumType(name: string): ModelEnum | undefined {
    return this.enums.find((type) => type.name === name);
  }

  /** The columns whose type is, or is made of, an enumerated type. */
  columnsOfEnum(name: string): { table: ModelTable; column: ModelColumn }[] {
    return this.tables.flatMap((table) => table.columns.filter((column) => column.enum?.name === name || enumNamesIn(column.canonicalType).includes(name)).map((column) => ({ table, column })));
  }

  /** The foreign keys that refer to a table, with the table each is on. */
  referencesTo(target: ModelTable): { table: ModelTable; key: ModelForeignKey }[] {
    return this.tables.flatMap((table) => table.foreignKeys.filter((key) => key.table === target.name).map((key) => ({ table, key })));
  }

  // --- renames: what refers to the renamed thing follows ---------------------------

  /** The texts of a table that can name its columns and the table itself: its checks, and its indexes that have an expression or a condition. */
  #textsOf(table: ModelTable): { names?: ExpressionName[]; mayBeStale?: boolean }[] {
    return [...table.checks, ...table.indexes.filter(hasText)];
  }

  renameTable(table: ModelTable, to: string): void {
    const from = table.name;
    table.name = to;
    this.#textsOf(table).forEach((text) => followIn(text, { kind: "table", from, to }));
    for (const other of this.tables) {
      for (const key of other.foreignKeys) {
        if (key.table === from) {
          key.table = to;
        }
      }
    }
  }

  renameColumn(table: ModelTable, column: ModelColumn, to: string): void {
    const from = column.name;
    const follow = (names: string[] | undefined): void => {
      names?.forEach((name, index) => {
        if (name === from) {
          names[index] = to;
        }
      });
    };
    // The keys that refer to this table, from wherever; its own keys to itself are among them.
    for (const { key } of this.referencesTo(table)) {
      follow(key.refColumns);
    }
    column.name = to;
    // The key, constraints, and indexes over it, and those that carry it along.
    for (const object of [...(table.primaryKey === undefined ? [] : [table.primaryKey]), ...table.uniques, ...table.indexes]) {
      follow(object.columns);
      follow(object.include);
    }
    table.foreignKeys.forEach((key) => follow(key.columns));
    for (const index of table.indexes) {
      index.keys?.forEach((key) => {
        if (key.column === from) {
          key.column = to;
        }
      });
    }
    this.#textsOf(table).forEach((text) => followIn(text, { kind: "column", from, to }));
  }

  /** A type or a value of one is renamed: a text of any table may name it, and so may a default. */
  #followEverywhere(renamed: RenamedThing): void {
    for (const table of this.tables) {
      this.#textsOf(table).forEach((text) => followIn(text, renamed));
      table.columns.forEach((column) => followInDefault(column, renamed));
    }
  }

  renameEnum(type: ModelEnum, to: string): void {
    const from = type.name;
    type.name = to;
    this.#followEverywhere({ kind: "type", from, to });
    // What the source's database calls the type was its old name.
    delete type.sourceDialectType;
    for (const { column } of this.columnsOfEnum(from)) {
      if (column.enum?.name === from) {
        column.enum.name = to;
      }
      if (column.canonicalType !== undefined) {
        column.canonicalType = withEnumRenamed(column.canonicalType, from, to);
      }
      delete column.sourceDialectType;
    }
  }

  renameEnumValue(type: ModelEnum, from: string, to: string): void {
    this.setEnumValues(
      type,
      type.values.map((value) => (value === from ? to : value)),
    );
    this.#followEverywhere({ kind: "value", type: type.name, from, to });
    // A default that is the value follows it, on a column whose type is this one (not on one of arrays of it).
    for (const { column } of this.columnsOfEnum(type.name)) {
      const scalar = column.enum?.name === type.name || (column.canonicalType?.kind === "enum" && column.canonicalType.name === type.name);
      if (scalar && column.default === from) {
        column.default = to;
      }
    }
  }

  /** Gives a type its values, and every column that carries a copy of them. */
  setEnumValues(type: ModelEnum, values: string[]): void {
    type.values = values;
    for (const { column } of this.columnsOfEnum(type.name)) {
      if (column.enum?.name === type.name) {
        column.enum.values = [...values];
      }
    }
  }

  // --- columns from what a change says ---------------------------------------------

  setColumnType(column: ModelColumn, type: TypeState): void {
    column.type = type.storage;
    if (type.canonical !== undefined) {
      column.canonicalType = copyCanonicalType(type.canonical);
    } else {
      delete column.canonicalType;
    }
    if (type.declared !== undefined) {
      column.declaredType = type.declared;
    } else {
      delete column.declaredType;
    }
    // What the source's database called the old type says nothing of the new one.
    delete column.sourceDialectType;
    const enumName = type.canonical?.kind === "enum" ? type.canonical.name : type.enum;
    if (enumName !== undefined) {
      column.enum = { name: enumName, values: [...(this.enumType(enumName)?.values ?? [])] };
    } else {
      delete column.enum;
    }
  }

  setColumnDefault(column: ModelColumn, state: DefaultState | undefined): void {
    delete column.default;
    delete column.defaultFunction;
    delete column.defaultExpression;
    delete column.defaultNames;
    delete column.defaultMayBeStale;
    delete column.generated;
    delete column.autoIncrement;
    // What the change says of the default's text, when the default has one.
    if (state !== undefined && state.kind !== "value" && state.kind !== "increment" && state.expression !== undefined) {
      const { names, mayBeStale } = textOf(state);
      Object.assign(column, { ...(names !== undefined && { defaultNames: names }), ...(mayBeStale === true && { defaultMayBeStale: true }) });
    }
    switch (state?.kind) {
      case "value":
        column.default = structuredClone(state.value);
        break;
      case "function":
        column.defaultFunction = state.function;
        if (state.expression !== undefined) {
          column.defaultExpression = state.expression;
        }
        break;
      case "increment":
        column.generated = "increment";
        break;
      case "generated":
        column.generated = state.strategy;
        if (state.expression !== undefined) {
          column.defaultExpression = state.expression;
        }
        break;
      case "expression":
        column.defaultExpression = state.expression;
        break;
      default:
        break;
    }
  }

  columnFromState(state: ColumnState): ModelColumn {
    const column: ModelColumn = { name: state.name, type: state.type.storage, nullable: state.nullable, primary: false, ...(state.origin !== undefined && { origin: { ...state.origin } }) };
    this.setColumnType(column, state.type);
    this.setColumnDefault(column, state.default);
    return column;
  }

  /** Gives a table its primary key, and marks the key's columns. A key without a name and an origin is one that only the marks give. */
  setPrimaryKey(table: ModelTable, state: PrimaryKeyState | undefined): void {
    if (state === undefined) {
      delete table.primaryKey;
    } else {
      const parts = partsOf(state);
      // A key that says nothing but its columns, and not where it comes from, is one that only the marks give.
      const implicit = state.name === undefined && state.origin === undefined && Object.keys(parts).length === 0;
      table.primaryKey = { ...(state.name !== undefined && { name: state.name }), columns: [...state.columns], ...parts, ...(state.origin !== undefined && { origin: { ...state.origin } }), ...(implicit && { implicit: true as const }) };
    }
    for (const column of table.columns) {
      column.primary = state?.columns.includes(column.name) ?? false;
    }
  }

  tableFromState(state: TableState): ModelTable {
    const table: ModelTable = {
      name: state.name,
      columns: state.columns.map((column) => this.columnFromState(column)),
      uniques: state.uniques.map(uniqueFromState),
      foreignKeys: [],
      checks: state.checks.map(checkFromState),
      indexes: [],
      lists: new Set(),
      ...(state.origin !== undefined && { origin: { ...state.origin } }),
    };
    this.setPrimaryKey(table, state.primaryKey);
    return table;
  }

  foreignKeyFromState(table: ModelTable, state: ForeignKeyState): ModelForeignKey {
    const [only] = state.columns;
    return {
      ...(state.name !== undefined && { name: state.name }),
      columns: [...state.columns],
      table: state.references.table,
      refColumns: [...state.references.columns],
      // A schema says no action by saying nothing.
      ...(state.onDelete !== "NO ACTION" && { onDelete: state.onDelete }),
      ...(state.onUpdate !== "NO ACTION" && { onUpdate: state.onUpdate }),
      ...partsOf(state),
      inline: state.columns.length === 1 && !table.foreignKeys.some((key) => key.inline && key.columns[0] === only),
      ...(state.origin !== undefined && { origin: { ...state.origin } }),
    };
  }

  /**
   * Says of a table's numbered columns whether the runtime numbers them: it
   * does for a single integer key, as a collector says it. For a table whose
   * key a change has touched, or for the one column whose default or type
   * one has.
   */
  settleNumbering(table: ModelTable, only?: ModelColumn): void {
    for (const column of table.columns) {
      if ((only !== undefined && column !== only) || (column.autoIncrement !== true && column.generated !== "increment")) {
        continue;
      }
      column.generated = "increment";
      if (table.primaryKey?.columns.length === 1 && table.primaryKey.columns[0] === column.name && column.type === "integer") {
        column.autoIncrement = true;
      } else {
        delete column.autoIncrement;
      }
    }
  }
}

export { enumNamesIn, hasText, normalizeAction };
