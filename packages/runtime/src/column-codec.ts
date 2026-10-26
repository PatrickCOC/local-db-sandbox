import type { ColumnSchema, SqlValue } from "./runtime.ts";

/*
 * The one place where a column's values change form between what they are
 * to whoever uses the sandbox (the logical value, which is also how the
 * fixture holds them) and how SQLite holds them (the stored value).
 *
 * The runtime uses it to load the fixture and to write snapshots; adapters
 * that receive values from outside (the PostgREST endpoint) use it for
 * every value they hand the runtime and every row they return. There are
 * no other copies of these rules: a second copy is how one column comes to
 * hold the same moment as two different texts.
 *
 * By storage type (`ColumnSchema.type`):
 *
 * | type       | logical                              | stored                                  |
 * |------------|--------------------------------------|-----------------------------------------|
 * | `datetime` | ISO 8601 text, `...T...Z`            | `YYYY-MM-DD HH:MM:SS.SSS`, UTC          |
 * | `date`     | `YYYY-MM-DD`                         | the same                                |
 * | `boolean`  | `true` / `false`                     | `1` / `0`                               |
 * | `integer`  | number; text of the digits beyond 2^53 | 64-bit integer                        |
 * | `numeric`  | number                               | number (SQLite has no exact decimal)    |
 * | `json`     | any JSON value                       | its JSON text                           |
 * | `binary`   | Base64 text                          | bytes                                   |
 * | others     | as given                             | as given                                |
 */

function keyOf(column: ColumnSchema): string {
  return column.key ?? column.name;
}

/** SQLite's own date-time text format, in UTC: `YYYY-MM-DD HH:MM:SS.SSS`. */
export function toDatetimeText(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

/*
 * Date-time text with an optional time, fraction, and offset, separated by
 * `T` or a space: what ISO 8601, PostgreSQL (`2026-10-06 12:00:00+00`), and
 * SQLite write. Read here rather than by `Date`, which takes text without an
 * offset as local time: a moment written without a zone is UTC to the
 * runtime, as it is to SQLite's own date functions.
 */
const DATETIME_TEXT = /^(\d{4}-\d\d-\d\d)(?:[T ](\d\d:\d\d)(?::(\d\d)(?:\.(\d+))?)?)?\s*(Z|z|[+-]\d\d(?::?\d\d)?)?$/;

/**
 * The moment that date-time text stands for, or `undefined` when it is not
 * date-time text. Text without an offset is UTC. Digits of the fraction
 * beyond milliseconds are dropped.
 */
export function parseDatetime(text: string): Date | undefined {
  const match = DATETIME_TEXT.exec(text.trim());
  if (match === null) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  const [, day, time = "00:00", seconds = "00", fraction = "", zone] = match;
  let offset = "Z";
  if (zone !== undefined && zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offset = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || "00"}`;
  }
  const date = new Date(`${day}T${time}:${seconds}.${fraction.padEnd(3, "0").slice(0, 3)}${offset}`);
  // `Date` rolls an impossible day over to the next month; such text is not a date.
  return Number.isNaN(date.getTime()) || (offset === "Z" && date.toISOString().slice(0, 10) !== day) ? undefined : date;
}

/** An integer of SQLite as a JavaScript value: a number, or the text of its digits when a number cannot hold it exactly. */
export function exactInteger(value: bigint): number | string {
  return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString();
}

/** A logical value (as the fixture holds it) as it is stored in SQLite. Throws a `TypeError` naming the column when it does not fit. */
export function toStoredValue(column: ColumnSchema, value: unknown): SqlValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (column.type === "json") {
    return JSON.stringify(value);
  }
  if (column.type === "binary") {
    if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new TypeError(`"${keyOf(column)}" holds ${typeof value === "string" ? "text that is not Base64" : Array.isArray(value) ? "an array" : `a ${typeof value}`}, but its column type is binary: its fixture value is the Base64 text of the bytes.`);
    }
    return Buffer.from(value, "base64");
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError(`"${keyOf(column)}" holds ${Array.isArray(value) ? "an array" : `a ${typeof value}`}, but its column type is ${column.type}.`);
  }
  if (column.type === "datetime") {
    const date = typeof value === "number" ? new Date(value) : parseDatetime(value);
    if (date === undefined || Number.isNaN(date.getTime())) {
      throw new TypeError(`"${keyOf(column)}" holds ${JSON.stringify(value)}, which is not a date-time.`);
    }
    return toDatetimeText(date);
  }
  if (column.type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d/.test(value)) {
      throw new TypeError(`"${keyOf(column)}" holds ${JSON.stringify(value)}, which is not a date (YYYY-MM-DD).`);
    }
    return value.slice(0, 10);
  }
  return value;
}

/** A value read from SQLite as its logical value (as the fixture holds it). */
export function fromStoredValue(column: ColumnSchema, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (column.type === "boolean" && (value === 0 || value === 1)) {
    return value === 1;
  }
  if (column.type === "datetime" && typeof value === "string") {
    const date = parseDatetime(value);
    return date === undefined ? value : date.toISOString();
  }
  if (column.type === "json" && typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  }
  return typeof value === "bigint" ? exactInteger(value) : value;
}
