import type { Row } from "../../core/src/index.ts";
import type { ColumnSchema, ColumnType, TableSchema } from "../../runtime/src/index.ts";

/*
 * A JSON database file says nothing about column types. When no other
 * description of a collection exists (such as ORM entities), its table is
 * described from the rows themselves. This is deliberately simple and only
 * looks at the values that are there.
 */

function typeOf(values: unknown[]): ColumnType {
  const kinds = new Set(
    values.map((value) => {
      if (typeof value === "boolean") {
        return "boolean";
      }
      if (typeof value === "number") {
        return Number.isInteger(value) ? "integer" : "real";
      }
      return typeof value === "string" ? "text" : "json";
    }),
  );
  if (kinds.size === 0) {
    return "any";
  }
  if (kinds.size === 1) {
    return [...kinds][0] as ColumnType;
  }
  if (kinds.size === 2 && kinds.has("integer") && kinds.has("real")) {
    return "real";
  }
  // Numbers and text can share a column as they are. Anything else is kept exactly, as JSON text.
  return kinds.has("boolean") || kinds.has("json") ? "json" : "any";
}

/**
 * The table for one collection, from its rows:
 *
 * - one column per key that appears in any row, in order of first appearance;
 * - type from the values: all booleans, integers, numbers, or strings give
 *   that type; objects and arrays, and mixtures involving booleans, give
 *   `json`; a mixture of numbers and strings, or only nulls, gives `any`;
 * - every column is nullable, except the key;
 * - `id` is the primary key when every row has a different, non-null number
 *   or string `id`, and is generated when those are all integers;
 * - an empty collection has no keys to look at. It gets a generated integer
 *   `id` column only, the key the sandbox assumes elsewhere.
 */
export function inferTableSchema(name: string, rows: Row[]): TableSchema {
  if (rows.length === 0) {
    return { name, columns: [{ name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true }] };
  }
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  const columns = keys.map((key): ColumnSchema => {
    const values = rows.map((row) => row[key]).filter((value) => value !== null && value !== undefined);
    return { name: key, type: typeOf(values), nullable: true, primary: false };
  });

  const id = columns.find((column) => column.name === "id");
  const ids = rows.map((row) => row.id);
  if (id !== undefined && (id.type === "integer" || id.type === "text") && ids.every((value) => value !== null && value !== undefined) && new Set(ids).size === ids.length) {
    id.primary = true;
    id.nullable = false;
    if (id.type === "integer") {
      id.autoIncrement = true;
    }
  }
  return { name, columns };
}
