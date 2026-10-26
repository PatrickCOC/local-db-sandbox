import type { DatabaseSync } from "node:sqlite";
import { SandboxDialectUnsupportedError } from "./runtime.ts";

/*
 * SQL functions of other databases that the runtime provides itself.
 *
 * The runtime does not translate SQL (docs/COMPATIBILITY.md). A function is
 * different from syntax: SQLite lets a function be defined under any name, so
 * a statement that calls one reaches SQLite as it was written, and SQLite
 * calls back here. Nothing of the statement is read or rewritten.
 *
 * Only what is listed in this file is provided, each as a stated subset. A
 * call outside its subset fails with `SandboxDialectUnsupportedError`; it is
 * never answered with something close.
 */

/** Defines the compatibility functions on a database. Called once, when the runtime opens it. */
export function registerCompatibilityFunctions(database: DatabaseSync): void {
  // Integers are passed as BigInts, so that one too large for a number is refused by TO_CHAR itself and not by the engine.
  database.function("TO_CHAR", { deterministic: true, useBigIntArguments: true }, (value: unknown, format: unknown) => toChar(value, format));
}

function unsupported(problem: string): SandboxDialectUnsupportedError {
  return new SandboxDialectUnsupportedError(
    `TO_CHAR: ${problem} The sandbox's TO_CHAR formats a date or a date-time with ${SUPPORTED.join(", ")}, punctuation, digits, and text in double quotes. ` +
      "It does not format numbers, names of months or days, time zones, or anything else of PostgreSQL's TO_CHAR.",
  );
}

/** The patterns that are provided. All but AM and PM are numbers, and are recognized in any case, as PostgreSQL recognizes them. */
const SUPPORTED = ["YYYY", "YY", "MM", "DD", "HH24", "HH12", "HH", "MI", "SS", "MS", "AM", "PM"];

/**
 * Every date and time pattern and modifier of PostgreSQL's TO_CHAR, so that
 * one that is not provided is recognized for what it is and refused. Without
 * this list `SSSS` (seconds since midnight) would be read as `SS` twice, and
 * `DDTH` as a day followed by text.
 */
const POSTGRES_PATTERNS = [
  ...SUPPORTED,
  "SSSSS", "SSSS", "US", "FF1", "FF2", "FF3", "FF4", "FF5", "FF6", "A.M.", "P.M.",
  "Y,YYY", "YYY", "Y", "IYYY", "IYY", "IY", "I", "BC", "AD", "B.C.", "A.D.",
  "MONTH", "MON", "DAY", "DY", "DDD", "IDDD", "ID", "D", "WW", "IW", "W", "CC", "J", "Q", "RM",
  "TZH", "TZM", "TZ", "OF", "FM", "TH", "FX", "TM", "SP",
].sort((a, b) => b.length - a.length);

interface Moment {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

type Part = string | ((moment: Moment) => string);

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

const FIELDS: Record<string, (moment: Moment, pattern: string) => string> = {
  YYYY: ({ year }) => pad(year, 4),
  YY: ({ year }) => pad(year % 100, 2),
  MM: ({ month }) => pad(month, 2),
  DD: ({ day }) => pad(day, 2),
  HH24: ({ hour }) => pad(hour, 2),
  HH12: ({ hour }) => pad(((hour + 11) % 12) + 1, 2),
  HH: ({ hour }) => pad(((hour + 11) % 12) + 1, 2),
  MI: ({ minute }) => pad(minute, 2),
  SS: ({ second }) => pad(second, 2),
  MS: ({ millisecond }) => pad(millisecond, 3),
  // The meridiem is written in the case the pattern was written in.
  AM: ({ hour }, pattern) => (pattern[0] === pattern[0]?.toUpperCase() ? (hour < 12 ? "AM" : "PM") : hour < 12 ? "am" : "pm"),
  PM: ({ hour }, pattern) => (pattern[0] === pattern[0]?.toUpperCase() ? (hour < 12 ? "AM" : "PM") : hour < 12 ? "am" : "pm"),
};

const formats = new Map<string, Part[]>();

/** A format as its parts: text to copy, and fields to fill in. Throws for a pattern that is not provided. */
function partsOf(format: string): Part[] {
  const known = formats.get(format);
  if (known !== undefined) {
    return known;
  }
  const parts: Part[] = [];
  const text = (literal: string): void => {
    const last = parts.at(-1);
    if (typeof last === "string") {
      parts[parts.length - 1] = last + literal;
    } else {
      parts.push(literal);
    }
  };
  for (let index = 0; index < format.length; ) {
    const character = format[index] as string;
    if (character === '"') {
      // Text in double quotes is copied; a backslash keeps the character after it.
      let literal = "";
      for (index += 1; index < format.length && format[index] !== '"'; index += 1) {
        if (format[index] === "\\" && index + 1 < format.length) {
          index += 1;
        }
        literal += format[index];
      }
      index += 1;
      text(literal);
    } else if (/[A-Za-z]/.test(character)) {
      const rest = format.slice(index).toUpperCase();
      const pattern = POSTGRES_PATTERNS.find((candidate) => rest.startsWith(candidate));
      if (pattern === undefined) {
        const run = /^[A-Za-z]+/.exec(format.slice(index))?.[0] as string;
        throw unsupported(`"${run}" in the format ${JSON.stringify(format)} is not a pattern. Text that is to be copied has to be in double quotes.`);
      }
      const written = format.slice(index, index + pattern.length);
      const field = FIELDS[pattern];
      if (field === undefined) {
        throw unsupported(`the pattern "${written}" in the format ${JSON.stringify(format)} is not supported.`);
      }
      parts.push((moment) => field(moment, written));
      index += pattern.length;
    } else {
      text(character);
      index += 1;
    }
  }
  if (formats.size >= 256) {
    formats.clear();
  }
  formats.set(format, parts);
  return parts;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * The fields of a date or a date-time as the runtime holds one: SQLite's
 * `YYYY-MM-DD HH:MM:SS.SSS`, ISO 8601 text, or a day alone. The fields are
 * taken as they are written, which for the runtime's own values is UTC; no
 * time zone is applied. Text that carries an offset is brought to UTC first,
 * as SQLite's own date functions do. `undefined` for anything else.
 */
function momentOf(value: string): Moment | undefined {
  const match = DATE_TIME.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((group) => Number(match[group] ?? 0)) as [number, number, number, number, number, number];
  const millisecond = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  const daysInMonth = new Date(Date.UTC(2000, month, 0)).getUTCDate() + (month === 2 && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? -1 : 0);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const moment = { year, month, day, hour, minute, second, millisecond };
  const offset = /^([+-])(\d{2}):?(\d{2})?$/.exec(match[8] ?? "");
  const minutes = offset === null ? 0 : (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0));
  if (minutes === 0) {
    return moment;
  }
  // The same moment in UTC. setUTCFullYear, because Date.UTC reads a year below 100 as 19xx.
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute - minutes, second, millisecond);
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
    hour: utc.getUTCHours(),
    minute: utc.getUTCMinutes(),
    second: utc.getUTCSeconds(),
    millisecond: utc.getUTCMilliseconds(),
  };
}

/**
 * PostgreSQL's `TO_CHAR(value, format)` for a date or a date-time and a
 * format made of the patterns in `SUPPORTED`. NULL for a NULL value or
 * format, as on PostgreSQL. The value's fields are formatted as the runtime
 * holds them, in UTC: PostgreSQL formats a `timestamptz` in the session's
 * time zone, which the sandbox does not have.
 */
export function toChar(value: unknown, format: unknown): string | null {
  if (value === null || value === undefined || format === null || format === undefined) {
    return null;
  }
  if (typeof format !== "string") {
    throw unsupported("its format has to be text.");
  }
  if (typeof value === "number" || typeof value === "bigint") {
    throw unsupported(`formatting a number (${String(value)}) is not supported.`);
  }
  if (typeof value !== "string") {
    throw unsupported("its value has to be a date or a date-time, as text.");
  }
  const parts = partsOf(format);
  const moment = momentOf(value);
  if (moment === undefined) {
    throw unsupported(`${JSON.stringify(value)} is not a date or a date-time it can read: it reads YYYY-MM-DD, alone or followed by a time.`);
  }
  return parts.map((part) => (typeof part === "string" ? part : part(moment))).join("");
}
