import { fromStoredValue, toStoredValue } from "../../runtime/src/index.ts";
import type { ColumnSchema, SqlValue } from "../../runtime/src/index.ts";
import { PostgrestError, unsupported } from "./errors.ts";

/*
 * Values as PostgREST receives and sends them, turned into the runtime's
 * logical values and back. Every conversion between logical and stored
 * values is the column codec's (toStoredValue / fromStoredValue); this file
 * only reads PostgREST's text and JSON forms. So a date-time that arrives as
 * `2026-10-06T12:00:00Z` is stored exactly as the fixture's date-times are,
 * and compares with them.
 */

/** PostgreSQL's spellings of true and false, which PostgREST passes on. */
const TRUE = /^(t|true|y|yes|on|1)$/i;
const FALSE = /^(f|false|n|no|off|0)$/i;
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
/** A PostgreSQL date: the day, optionally followed by a time that is ignored. */
const DATE = /^\d{4}-\d\d-\d\d([T ].*)?$/;

/** The type to name in an error: the one the schema's source declared, else the storage type. */
function typeName(column: ColumnSchema): string {
  return column.declaredType ?? column.type;
}

function invalid(column: ColumnSchema, value: unknown): PostgrestError {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // 22007: invalid date-time format; 22P02: invalid text representation.
  const code = column.type === "datetime" || column.type === "date" ? "22007" : "22P02";
  return new PostgrestError(400, code, `invalid input syntax for type ${typeName(column)}: "${text}"`);
}

/** Through the codec; a value it refuses is PostgreSQL's invalid input. */
function stored(column: ColumnSchema, logical: unknown, original: unknown): SqlValue {
  try {
    return toStoredValue(column, logical);
  } catch {
    throw invalid(column, original);
  }
}

function integerValue(text: string): number | bigint {
  const value = BigInt(text);
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/** Text of a PostgreSQL scalar of the column's type, as it appears in a filter or a JSON string. */
function fromText(column: ColumnSchema, text: string): SqlValue {
  switch (column.type) {
    case "integer":
      if (!INTEGER.test(text)) {
        throw invalid(column, text);
      }
      return integerValue(text);
    case "real":
    case "numeric":
      if (!DECIMAL.test(text)) {
        throw invalid(column, text);
      }
      return Number(text);
    case "boolean":
      if (TRUE.test(text)) {
        return stored(column, true, text);
      }
      if (FALSE.test(text)) {
        return stored(column, false, text);
      }
      throw invalid(column, text);
    case "date":
      if (!DATE.test(text)) {
        throw invalid(column, text);
      }
      return stored(column, text, text);
    case "datetime":
      return stored(column, text, text);
    default:
      return text;
  }
}

/** A filter's value (`col=eq.<value>`), always text in the query string, as the runtime stores it. */
export function filterValue(column: ColumnSchema, text: string): SqlValue {
  if (column.type === "json" || column.type === "binary") {
    throw unsupported(`Filtering on the ${typeName(column)} column "${column.name}"`);
  }
  return fromText(column, text);
}

/** A value of a JSON request body, as the runtime stores it. JSON `null` and a missing key are both NULL. */
export function bodyValue(column: ColumnSchema, value: unknown): SqlValue {
  if (value === null || value === undefined) {
    return null;
  }
  switch (column.type) {
    case "json":
      return stored(column, value, value);
    case "binary": {
      // PostgREST takes bytea as PostgreSQL's hex text, `\x0102...`.
      if (typeof value !== "string" || !/^\\x([0-9a-fA-F]{2})*$/.test(value)) {
        throw invalid(column, value);
      }
      return stored(column, Buffer.from(value.slice(2), "hex").toString("base64"), value);
    }
    case "integer":
      if (typeof value === "number") {
        if (!Number.isInteger(value)) {
          throw invalid(column, value);
        }
        return value;
      }
      break;
    case "real":
    case "numeric":
      if (typeof value === "number") {
        return value;
      }
      break;
    case "boolean":
      if (typeof value === "boolean") {
        return stored(column, value, value);
      }
      break;
    case "text":
      // PostgreSQL turns any JSON value given for a text column into its text.
      return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
    case "any":
      if (typeof value === "string" || typeof value === "number") {
        return value;
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      throw invalid(column, value);
    default:
      break;
  }
  if (typeof value !== "string") {
    throw invalid(column, value);
  }
  return fromText(column, value);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/**
 * A date-time as PostgreSQL writes it into JSON for a session in UTC, which a
 * Supabase session is: `2026-10-06T12:00:00+00:00`, with a fraction only when
 * there is one. A column declared `timestamp` (without time zone) has no
 * offset.
 */
function datetimeJson(column: ColumnSchema, iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const milliseconds = date.getUTCMilliseconds();
  const text =
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}` +
    (milliseconds === 0 ? "" : `.${pad(milliseconds, 3).replace(/0+$/, "")}`);
  const withoutZone = column.declaredType !== undefined && /^timestamp(\s*\(\d+\))?(\s+without\s+time\s+zone)?$/i.test(column.declaredType.trim());
  return withoutZone ? text : `${text}+00:00`;
}

/** A stored value as PostgREST would put it in a JSON response. */
export function responseValue(column: ColumnSchema, value: unknown): unknown {
  const logical = fromStoredValue(column, value);
  if (logical === null) {
    return null;
  }
  if (column.type === "datetime" && typeof logical === "string") {
    return datetimeJson(column, logical);
  }
  if (column.type === "binary" && typeof logical === "string") {
    return `\\x${Buffer.from(logical, "base64").toString("hex")}`;
  }
  return logical;
}
