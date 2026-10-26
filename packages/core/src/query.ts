import { SandboxError } from "./errors.ts";
import type { Row } from "./state.ts";

/**
 * Internal query model. Adapters (REST, CLI, ...) translate their own
 * syntax into this shape; it is not tied to HTTP query strings.
 */
export interface FilterSpec {
  field: string;
  op: "eq";
  value: unknown;
}

export interface SortSpec {
  field: string;
  direction: "asc" | "desc";
}

export interface QuerySpec {
  collection: string;
  filters?: FilterSpec[];
  sort?: SortSpec[];
  offset?: number;
  limit?: number;
}

export interface QueryResult {
  rows: Row[];
  /** Number of rows matching the filters, before offset and limit. */
  total: number;
}

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function field(row: Row, name: string): unknown {
  return Object.hasOwn(row, name) ? row[name] : undefined;
}

/** Scalars match by string form, so `true` matches `"true"` and `1` matches `"1"`. */
function equals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) {
    return true;
  }
  return isScalar(actual) && isScalar(expected) && String(actual) === String(expected);
}

/** Orders two present values: numbers numerically, everything else by string form. */
function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function validate(spec: QuerySpec): void {
  for (const filter of spec.filters ?? []) {
    if (typeof filter.field !== "string" || filter.field === "" || filter.op !== "eq") {
      throw new SandboxError("INVALID_QUERY", 'Filters need a field name and the "eq" operator.');
    }
  }
  for (const sort of spec.sort ?? []) {
    if (typeof sort.field !== "string" || sort.field === "" || (sort.direction !== "asc" && sort.direction !== "desc")) {
      throw new SandboxError("INVALID_QUERY", 'Sort entries need a field name and a direction of "asc" or "desc".');
    }
  }
  if (spec.offset !== undefined && !isCount(spec.offset)) {
    throw new SandboxError("INVALID_QUERY", "Offset must be a non-negative integer.");
  }
  if (spec.limit !== undefined && !isCount(spec.limit)) {
    throw new SandboxError("INVALID_QUERY", "Limit must be a non-negative integer.");
  }
}

/**
 * Applies filters, then sort, then offset/limit to a collection's rows.
 * Rows without a value for a sort field are placed last in either direction.
 */
export function runQuery(rows: Row[], spec: QuerySpec): QueryResult {
  validate(spec);

  const filters = spec.filters ?? [];
  const matched = rows.filter((row) => filters.every((filter) => equals(field(row, filter.field), filter.value)));

  const sort = spec.sort ?? [];
  if (sort.length > 0) {
    matched.sort((rowA, rowB) => {
      for (const { field: name, direction } of sort) {
        const a = field(rowA, name) ?? undefined;
        const b = field(rowB, name) ?? undefined;
        if (a === undefined || b === undefined) {
          if (a !== b) {
            return a === undefined ? 1 : -1;
          }
          continue;
        }
        const order = compare(a, b);
        if (order !== 0) {
          return direction === "asc" ? order : -order;
        }
      }
      return 0;
    });
  }

  const offset = spec.offset ?? 0;
  const end = spec.limit === undefined ? undefined : offset + spec.limit;
  return { rows: matched.slice(offset, end), total: matched.length };
}
