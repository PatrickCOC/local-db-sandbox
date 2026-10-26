import { diffSchemas } from "../src/index.ts";
import type { SchemaChange } from "../src/index.ts";
import type { CanonicalType, ColumnSchema, ColumnType, DatabaseSchema, EnumType, SchemaOrigin, SchemaRename, TableSchema } from "../../runtime/src/index.ts";

/*
 * Canonical schemas written by hand, for the tests of the diff. Nothing here
 * comes from a collector: the diff reads canonical schemas, whatever made
 * them. The provenance names a source of its own (`test`).
 */

/** A column's type: how it is stored, what it is, and how it was spelled. */
export interface TestType {
  type: ColumnType;
  canonicalType?: CanonicalType;
  declaredType?: string;
}

/** What the diff says of a column's type that has all three. */
export function typeState(type: TestType): { storage: ColumnType; canonical?: CanonicalType; declared?: string } {
  return { storage: type.type, ...(type.canonicalType !== undefined && { canonical: type.canonicalType }), ...(type.declaredType !== undefined && { declared: type.declaredType }) };
}

export const INTEGER: TestType = { type: "integer", canonicalType: { kind: "integer", bits: 32 }, declaredType: "integer" };
export const BIGINT: TestType = { type: "integer", canonicalType: { kind: "integer", bits: 64 }, declaredType: "bigint" };
export const TEXT: TestType = { type: "text", canonicalType: { kind: "text" }, declaredType: "text" };
export const BOOLEAN: TestType = { type: "boolean", canonicalType: { kind: "boolean" }, declaredType: "boolean" };
export const TIMESTAMPTZ: TestType = { type: "datetime", canonicalType: { kind: "timestamp", withTimeZone: true }, declaredType: "timestamptz" };
export const JSONB: TestType = { type: "json", canonicalType: { kind: "json", binary: true }, declaredType: "jsonb" };

/** A column of an enumerated type, by the type's name. */
export function enumType(name: string): TestType {
  return { type: "text", canonicalType: { kind: "enum", name }, declaredType: name };
}

/** A nullable column that is not a key column. */
export function column(name: string, type: TestType = INTEGER, extra: Partial<ColumnSchema> = {}): ColumnSchema {
  return { name, ...type, nullable: true, primary: false, ...extra };
}

/** A key column. */
export function keyColumn(name: string, type: TestType = INTEGER, extra: Partial<ColumnSchema> = {}): ColumnSchema {
  return column(name, type, { nullable: false, primary: true, ...extra });
}

export function table(name: string, columns: ColumnSchema[], extra: Partial<TableSchema> = {}): TableSchema {
  return { name, columns, ...extra };
}

export function schema(tables: TableSchema[], enums: EnumType[] = []): DatabaseSchema {
  return { tables, types: { enums } };
}

const sha = (file: string): string => `sha256-of-${file}`;

/** Created under `name` by statement `statement` of `file`. */
export function origin(name: string, file = "0001_init.sql", statement = 1): SchemaOrigin {
  return { source: "test", file, sha256: sha(file), statement, line: statement, name };
}

/** Renamed by statement `statement` of `file`. */
export function renamed(from: string, to: string, file = "0002_rename.sql", statement = 1): SchemaRename {
  return { from, to, at: { source: "test", file, sha256: sha(file), statement, line: statement } };
}

export function changes(before: DatabaseSchema, after: DatabaseSchema): SchemaChange[] {
  return diffSchemas(before, after).changes;
}

/** The kinds of the changes, in their order. */
export function ops(before: DatabaseSchema, after: DatabaseSchema): string[] {
  return changes(before, after).map((change) => change.op);
}
