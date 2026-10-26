import { formatCanonicalType } from "../../../runtime/src/canonical-type.ts";
import type { CanonicalType } from "../../../runtime/src/canonical-type.ts";
import { compareText } from "../../../schema-diff/src/stable-json.ts";
import { refuse } from "./safety.ts";
import { quoteIdentifier, quoteLiteral } from "./sql.ts";

/*
 * PostgreSQL's types and constants, written from what a canonical schema
 * says a type is (D-039): never from how a source spelled it, which may be
 * another database's spelling, or name a type that has been renamed since.
 */

/** What a canonical schema calls PostgreSQL, where it names a dialect. */
export const POSTGRESQL = "postgresql";

/**
 * A canonical type as PostgreSQL writes it. An enumerated type is its name;
 * a type of PostgreSQL's own without a canonical meaning (`other`) is its
 * name, quoted, with its modifiers as constants.
 */
export function postgresType(type: CanonicalType): string {
  switch (type.kind) {
    case "boolean":
      return "boolean";
    case "integer":
      return type.bits === 16 ? "smallint" : type.bits === 32 ? "integer" : "bigint";
    case "decimal":
      return type.precision === undefined ? "numeric" : `numeric(${type.precision},${type.scale ?? 0})`;
    case "float":
      return type.bits === 32 ? "real" : "double precision";
    case "text":
      return "text";
    case "varchar":
      return type.length === undefined ? "varchar" : `varchar(${type.length})`;
    case "char":
      // `char` alone is char(1) to PostgreSQL: the type without a length is the one it calls bpchar.
      return type.length === undefined ? "bpchar" : `char(${type.length})`;
    case "uuid":
      return "uuid";
    case "date":
      return "date";
    case "time":
    case "timestamp":
      return `${type.kind}${type.precision === undefined ? "" : `(${type.precision})`}${type.withTimeZone ? " with time zone" : ""}`;
    case "interval":
      return type.precision === undefined ? "interval" : `interval(${type.precision})`;
    case "json":
      return type.binary ? "jsonb" : "json";
    case "binary":
      return "bytea";
    case "enum":
      return quoteIdentifier(type.name);
    case "array":
      return `${postgresType(type.element)}[]`;
    case "other": {
      if (type.dialect !== POSTGRESQL) {
        return refuse("type-not-representable", `The type ${formatCanonicalType(type)} is a type of another database than PostgreSQL, and the schema does not say what it is.`);
      }
      const modifiers = type.modifiers ?? [];
      // An interval of some fields (`interval day to second`): its modifiers are numbers of PostgreSQL's own, which its type syntax does not take.
      if (type.name === "interval" || modifiers.some((modifier) => typeof modifier === "number" && !Number.isSafeInteger(modifier))) {
        return refuse("type-not-representable", `The type ${formatCanonicalType(type)} is kept with modifiers as PostgreSQL holds them, not as it reads them in a type.`);
      }
      // A type of another schema is named with it: `extensions.citext`.
      const dot = type.name.indexOf(".");
      const name = dot < 0 ? quoteIdentifier(type.name) : `${quoteIdentifier(type.name.slice(0, dot))}.${quoteIdentifier(type.name.slice(dot + 1))}`;
      // PostgreSQL hands every modifier to the type as text, so one written as a text is the same modifier.
      return `${name}${modifiers.length === 0 ? "" : `(${modifiers.map((modifier) => (typeof modifier === "number" ? String(modifier) : quoteLiteral(modifier))).join(",")})`}`;
    }
  }
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * JSON text of a value, with the keys of every object in code point order:
 * the same text for the same value, in whatever order its keys were set.
 * `undefined` for what JSON has no text for.
 */
function jsonText(value: unknown): string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map(jsonText);
    return items.includes(undefined) ? undefined : `[${items.join(",")}]`;
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    return undefined;
  }
  const members = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => compareText(a, b))
    .map(([key, inner]) => [JSON.stringify(key), jsonText(inner)] as const);
  return members.some(([, text]) => text === undefined) ? undefined : `{${members.map(([key, text]) => `${key}:${text}`).join(",")}}`;
}

function notA(what: string, value: unknown): never {
  return refuse("value-not-representable", `${JSON.stringify(value) ?? String(value)} is not ${what}.`);
}

/** One value of a type that is no array, as SQL. */
function scalarLiteral(type: Exclude<CanonicalType, { kind: "array" }>, value: unknown, inArray: boolean): string {
  switch (type.kind) {
    case "boolean":
      return typeof value === "boolean" ? String(value) : notA("true or false", value);
    case "integer":
      // An element of an array that a number does not hold exactly is kept as its digits.
      if (inArray && typeof value === "string" && /^[+-]?\d+$/.test(value)) {
        return value;
      }
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return notA("a whole number", value);
      }
      return Number.isSafeInteger(value) ? String(value) : refuse("value-not-representable", `${value} is beyond the whole numbers a schema holds exactly, so it is not known which number was meant.`);
    case "decimal":
    case "float":
      return typeof value === "number" && Number.isFinite(value) ? String(value) : notA("a number", value);
    case "json": {
      const text = jsonText(value);
      if (text === undefined) {
        return notA("a JSON value", value);
      }
      // In an array the elements are of the array's type; alone the constant says its own.
      return `${quoteLiteral(text)}${inArray ? "" : `::${postgresType(type)}`}`;
    }
    case "binary": {
      // A schema holds bytes as base64; PostgreSQL reads them as hexadecimal digits.
      if (typeof value !== "string" || !BASE64.test(value)) {
        return notA("bytes (as base64)", value);
      }
      const hex = [...atob(value)].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      return `${quoteLiteral(`\\x${hex}`)}${inArray ? "" : "::bytea"}`;
    }
    default:
      // Text, and what PostgreSQL reads from a text: a date, a UUID, a value of an enumerated type.
      return typeof value === "string" ? quoteLiteral(value) : notA(`a value of the type ${formatCanonicalType(type)}`, value);
  }
}

/**
 * A constant of a type, as the default of a column of that type. Refuses a
 * value that is no value of the type, and one that the schema does not hold
 * exactly: it is never written as something else.
 */
export function defaultLiteral(type: CanonicalType, value: unknown): string {
  if (type.kind !== "array") {
    return scalarLiteral(type, value, false);
  }
  // An array of arrays is an array of more dimensions, of the same elements.
  let element = type.element;
  while (element.kind === "array") {
    element = element.element;
  }
  const of = element;
  const items = (list: unknown): string => {
    if (!Array.isArray(list)) {
      return notA("an array", list);
    }
    return `ARRAY[${list.map((item: unknown) => (item === null ? "NULL" : Array.isArray(item) ? items(item) : scalarLiteral(of, item, true))).join(",")}]`;
  };
  // The type is said with the array: PostgreSQL cannot tell it of an array without elements.
  return `${items(value)}::${postgresType(type)}`;
}
