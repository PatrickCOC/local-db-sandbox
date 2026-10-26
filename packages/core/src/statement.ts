import type { QuerySpec } from "./query.ts";

/*
 * SQL-like text describing local operations, for diagnostics only.
 * Nothing here is parsed or executed, and no SQL dialect is targeted.
 */

const MAX_LITERAL_LENGTH = 60;

function name(identifier: string): string {
  return /^\w+$/.test(identifier) ? identifier : `"${identifier.replaceAll('"', '""')}"`;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  let text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  if (text.length > MAX_LITERAL_LENGTH) {
    text = `${text.slice(0, MAX_LITERAL_LENGTH)}...`;
  }
  return `'${text.replaceAll("'", "''")}'`;
}

/** Fields of a row-like input other than its ID field; tolerates invalid input. */
function fields(row: unknown, idField: string): [string, unknown][] {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return [];
  }
  return Object.entries(row).filter(([key]) => key !== idField);
}

export function selectStatement(spec: QuerySpec): string {
  let text = `SELECT * FROM ${name(spec.collection)}`;
  const filters = spec.filters ?? [];
  if (filters.length > 0) {
    text += ` WHERE ${filters.map((filter) => `${name(String(filter.field))} = ${literal(filter.value)}`).join(" AND ")}`;
  }
  const sort = spec.sort ?? [];
  if (sort.length > 0) {
    text += ` ORDER BY ${sort.map((entry) => `${name(String(entry.field))} ${entry.direction === "desc" ? "DESC" : "ASC"}`).join(", ")}`;
  }
  if (spec.limit !== undefined) {
    text += ` LIMIT ${spec.limit}`;
  }
  if (spec.offset !== undefined) {
    text += ` OFFSET ${spec.offset}`;
  }
  return text;
}

export function selectByIdStatement(collection: string, id: unknown, idField = "id"): string {
  return `SELECT * FROM ${name(collection)} WHERE ${name(idField)} = ${literal(id)}`;
}

export function insertStatement(collection: string, row: unknown, id?: unknown, idField = "id"): string {
  const entries = fields(row, idField);
  const rowId = id ?? (row as Record<string, unknown> | null | undefined)?.[idField];
  if (rowId !== undefined) {
    entries.unshift([idField, rowId]);
  }
  if (entries.length === 0) {
    return `INSERT INTO ${name(collection)} DEFAULT VALUES`;
  }
  const columns = entries.map(([key]) => name(key)).join(", ");
  const values = entries.map(([, value]) => literal(value)).join(", ");
  return `INSERT INTO ${name(collection)} (${columns}) VALUES (${values})`;
}

export function updateStatement(collection: string, id: unknown, changes: unknown, idField = "id"): string {
  const assignments = fields(changes, idField).map(([key, value]) => `${name(key)} = ${literal(value)}`);
  const set = assignments.length > 0 ? assignments.join(", ") : "/* no fields */";
  return `UPDATE ${name(collection)} SET ${set} WHERE ${name(idField)} = ${literal(id)}`;
}

export function deleteStatement(collection: string, id: unknown, idField = "id"): string {
  return `DELETE FROM ${name(collection)} WHERE ${name(idField)} = ${literal(id)}`;
}
