import assert from "node:assert/strict";
import { canonicalTypeKey, indexKeys } from "../../../runtime/src/index.ts";
import type { ColumnSchema, DatabaseSchema, TableSchema } from "../../../runtime/src/index.ts";
import { diffSchemas } from "../../../schema-diff/src/index.ts";

/*
 * What a canonical schema means, as plain data that two schemas can be
 * compared by: no provenance, no spellings, nothing of what a text names
 * (which is information about the text), and no order where the order of a
 * list says nothing. It is written here, apart from the diff and from the
 * migration package, so that a result is not only judged by the code that
 * made it.
 */

export interface FormOptions {
  /**
   * How column types are told apart: by canonical type, or, for schemas of
   * which one has none, by what was declared (storage type, spelling, and
   * enumerated type), as the diff does then.
   */
  types?: "canonical" | "declared";
  /** Leave out the names of keys and constraints: for a schema that has none compared with one that has. */
  names?: boolean;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with the keys of every object in one order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner)
            .filter(([, member]) => member !== undefined)
            .sort(([a], [b]) => byText(a, b)),
        )
      : inner,
  );
}

const action = (value: string | undefined): string => (value ?? "NO ACTION").trim().replace(/\s+/g, " ").toUpperCase();

function typeOf(column: ColumnSchema, types: "canonical" | "declared"): string {
  if (types === "canonical" && column.canonicalType !== undefined) {
    return `canonical ${canonicalTypeKey(column.canonicalType)}`;
  }
  const enumName = column.enum?.name ?? (column.canonicalType?.kind === "enum" ? column.canonicalType.name : undefined);
  return `declared ${column.type} ${(column.declaredType ?? "").trim().replace(/\s+/g, " ").toLowerCase()} ${enumName ?? ""}`;
}

function defaultOf(column: ColumnSchema): string {
  if (column.autoIncrement === true || column.generated === "increment") {
    return "increment";
  }
  if (column.defaultFunction !== undefined) {
    return `function ${column.defaultFunction}`;
  }
  if (column.default !== undefined && column.default !== null) {
    return `value ${stable(column.default)}`;
  }
  if (column.generated !== undefined) {
    return `generated ${column.generated} ${column.defaultExpression ?? ""}`;
  }
  return column.defaultExpression === undefined ? "none" : `expression ${column.defaultExpression}`;
}

/** What a key, a constraint, or an index is beyond its columns: what it carries along (in no order), whether it is deferrable, whether two NULLs are the same to it, and the clauses the schema has no place for. */
function beyond(item: { include?: readonly string[] | undefined; deferrable?: string | undefined; nullsNotDistinct?: boolean | undefined; sourceClauses?: readonly string[] | undefined } = {}): unknown[] {
  return [[...(item.include ?? [])].sort(byText), item.deferrable ?? null, item.nullsNotDistinct === true, [...(item.sourceClauses ?? [])]];
}

function tableForm(table: TableSchema, options: Required<FormOptions>): unknown {
  const named = <T extends { name?: string }>(item: T): string | null => (options.names ? (item.name ?? null) : null);
  const keyColumns = table.primaryKey?.columns ?? table.columns.filter((column) => column.primary).map((column) => column.name);
  const keyName = table.primaryKey === undefined ? null : named(table.primaryKey);
  const foreignKeys = [
    ...table.columns.flatMap((column) =>
      column.references === undefined ? [] : [[named(column.references), [column.name], column.references.table, [column.references.column], action(column.references.onDelete), action(column.references.onUpdate), ...beyond(column.references)]],
    ),
    ...(table.foreignKeys ?? []).map((key) => [named(key), key.columns, key.references.table, key.references.columns, action(key.onDelete), action(key.onUpdate), ...beyond(key)]),
  ];
  return {
    name: table.name,
    // The order of a table's columns says nothing.
    columns: table.columns.map((column) => [column.name, typeOf(column, options.types), column.nullable, defaultOf(column)]).sort((a, b) => byText(String(a[0]), String(b[0]))),
    // A key without a name may be one that only the columns' marks give, which has no order of its own.
    primaryKey: keyColumns.length === 0 ? null : [keyName, keyName === null ? [...keyColumns].sort(byText) : keyColumns, ...beyond(table.primaryKey)],
    uniques: (table.uniques ?? []).map((unique) => stable([named(unique), unique.columns, ...beyond(unique)])).sort(byText),
    foreignKeys: foreignKeys.map(stable).sort(byText),
    // The keys of an index in their order, each with what it says; none for an index that does not say where its columns and expressions stand.
    indexes: (table.indexes ?? []).map((index) => stable([index.name, index.columns, index.unique === true, index.expressions ?? [], index.where ?? null, index.method ?? null, indexKeys(index) ?? null, ...beyond(index)])).sort(byText),
    checks: (table.checks ?? []).map((check) => stable([named(check), check.expression, [...(check.sourceClauses ?? [])]])).sort(byText),
  };
}

/** The schema's enumerated types: those it lists, and those that only its columns give (the first by table and column). */
function enumsOf(schema: DatabaseSchema): [string, string[]][] {
  const types = new Map(schema.types.enums.map((type) => [type.name, type.values]));
  const given = schema.tables
    .flatMap((table) => table.columns.flatMap((column) => (column.enum === undefined ? [] : [{ place: `${table.name}\u0000${column.name}`, type: column.enum }])))
    .sort((a, b) => byText(a.place, b.place));
  for (const { type } of given) {
    if (!types.has(type.name)) {
      types.set(type.name, type.values);
    }
  }
  return [...types].sort(([a], [b]) => byText(a, b));
}

export function semanticForm(schema: DatabaseSchema, options: FormOptions = {}): unknown {
  const resolved = { types: options.types ?? "canonical", names: options.names ?? true };
  return {
    enums: enumsOf(schema),
    tables: schema.tables.map((table) => tableForm(table, resolved)).sort((a, b) => byText((a as { name: string }).name, (b as { name: string }).name)),
  };
}

/** What a schema says of its history: where its objects come from, and that a rename may have reached a text of which it does not say what it names. */
const HISTORY = new Set(["origin", "renames", "valueRenames", "mayBeStale", "defaultMayBeStale"]);

/** A copy of a schema that says nothing of where its objects come from, nor of what may have happened to them since. */
export function withoutProvenance(schema: DatabaseSchema): DatabaseSchema {
  return JSON.parse(JSON.stringify(schema, (key, inner: unknown) => (HISTORY.has(key) ? undefined : inner))) as DatabaseSchema;
}

/**
 * Fails unless the two schemas mean the same: by the form above, and by the
 * diff, which finds nothing between them. Where things come from is no part
 * of what a schema means, so the diff is given the two without it.
 */
export function assertSameSchema(actual: DatabaseSchema, expected: DatabaseSchema, options: FormOptions = {}, message?: string): void {
  assert.deepEqual(semanticForm(actual, options), semanticForm(expected, options), message);
  assert.deepEqual(diffSchemas(withoutProvenance(actual), withoutProvenance(expected)).changes, [], message);
}

/** The value and everything in it, frozen: a write to it throws. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
