import type { CanonicalType, ColumnType } from "../../runtime/src/index.ts";
import type { PgNode } from "./parser.ts";

/*
 * PostgreSQL's column types, three ways:
 *
 * - `type`: how the runtime stores the values (the storage type).
 * - `canonical`: what the type is, independent of spelling (D-036): `integer`
 *   and `int4` are both a 32-bit integer; `varchar(50)` and `varchar(100)`
 *   differ. A PostgreSQL type with no canonical meaning is kept as
 *   PostgreSQL's (`other`), with its modifiers.
 * - `dialectType`: the type as PostgreSQL names it internally, with its
 *   modifiers (`int4`, `varchar(20)`, `timestamptz(3)`, `text[]`).
 *
 * The spelling a migration used (`integer`, `timestamp with time zone`) is
 * read from its text by the collector; the parse tree has already replaced
 * it with PostgreSQL's internal name.
 */

export const POSTGRESQL = "postgresql";

/** The storage type of each of PostgreSQL's internal type names. */
const STORAGE: Record<string, ColumnType> = {
  int2: "integer",
  int4: "integer",
  int8: "integer",
  oid: "integer",
  float4: "real",
  float8: "real",
  numeric: "numeric",
  bool: "boolean",
  timestamp: "datetime",
  timestamptz: "datetime",
  date: "date",
  json: "json",
  jsonb: "json",
  bytea: "binary",
  text: "text",
  varchar: "text",
  bpchar: "text",
  char: "text",
  name: "text",
  uuid: "text",
  citext: "text",
  time: "text",
  timetz: "text",
  interval: "text",
  inet: "text",
  cidr: "text",
  macaddr: "text",
  macaddr8: "text",
  money: "text",
  bit: "text",
  varbit: "text",
  xml: "text",
  tsvector: "text",
  tsquery: "text",
};

/** Types the parse tree leaves as they were written. */
const ALIASES: Record<string, string> = {
  integer: "int4",
  int: "int4",
  smallint: "int2",
  bigint: "int8",
  serial: "int4",
  serial4: "int4",
  smallserial: "int2",
  serial2: "int2",
  bigserial: "int8",
  serial8: "int8",
  real: "float4",
  decimal: "numeric",
  boolean: "bool",
  "character varying": "varchar",
  character: "bpchar",
};

const SERIAL = new Set(["serial", "serial4", "smallserial", "serial2", "bigserial", "serial8"]);

/** `interval` over all fields (PostgreSQL's INTERVAL_FULL_RANGE), and without a precision (INTERVAL_FULL_PRECISION). */
const INTERVAL_FULL_RANGE = 32767;
const INTERVAL_FULL_PRECISION = 65535;

export interface ColumnTypeInfo {
  /** How the runtime stores the values. */
  type: ColumnType;
  canonical: CanonicalType;
  /** PostgreSQL's own name for the type, with modifiers and `[]`. */
  dialectType: string;
  /** Written as `serial`, `bigserial`, ...: an integer whose default is the next value of a sequence. */
  serial: boolean;
  /** The enumerated type the column takes, when it is one. */
  enumName?: string;
  /** Not a type the collector knows: its values are stored as given. */
  unknown: boolean;
}

function names(typeName: PgNode): string[] {
  return ((typeName.names ?? []) as PgNode[]).map((part) => String(part.String?.sval ?? ""));
}

/**
 * A type's modifiers as PostgreSQL takes them (typenameTypeMod): constants,
 * and names, which the parser reads as column references
 * (`geometry(Point, 4326)`). Anything else PostgreSQL refuses. PostgreSQL
 * hands every modifier to the type as text, so a whole number written as
 * text is that number: `numeric('12', '2')` is `numeric(12, 2)`.
 */
function modifierValues(typeName: PgNode): (number | string)[] {
  return ((typeName.typmods ?? []) as PgNode[]).map((modifier) => {
    const constant = modifier.A_Const;
    if (constant === undefined) {
      const fields = (modifier.ColumnRef?.fields ?? []) as PgNode[];
      const name = fields.length === 1 ? fields[0]?.String?.sval : undefined;
      return typeof name === "string" ? name : "?";
    }
    if ("ival" in constant) {
      return Number(constant.ival?.ival ?? 0);
    }
    const text = String(constant.sval?.sval ?? constant.fval?.fval ?? "?");
    return /^[+-]?\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : text;
  });
}

function numberAt(modifiers: readonly (number | string)[], index: number): number | undefined {
  const value = modifiers[index];
  return typeof value === "number" ? value : undefined;
}

/** The canonical type of a scalar (not array) type, by PostgreSQL's internal name. */
function scalarCanonical(internal: string, qualified: string | undefined, modifiers: readonly (number | string)[]): CanonicalType {
  const other = (): CanonicalType => ({ kind: "other", dialect: POSTGRESQL, name: qualified ?? internal, ...(modifiers.length > 0 && { modifiers: [...modifiers] }) });
  if (qualified !== undefined) {
    return other();
  }
  const first = numberAt(modifiers, 0);
  switch (internal) {
    case "bool":
      return { kind: "boolean" };
    case "int2":
      return { kind: "integer", bits: 16 };
    case "int4":
      return { kind: "integer", bits: 32 };
    case "int8":
      return { kind: "integer", bits: 64 };
    case "float4":
      return { kind: "float", bits: 32 };
    case "float8":
      return { kind: "float", bits: 64 };
    case "numeric":
      // numeric(p) is numeric(p, 0).
      return first === undefined ? { kind: "decimal" } : { kind: "decimal", precision: first, scale: numberAt(modifiers, 1) ?? 0 };
    case "text":
      return { kind: "text" };
    case "varchar":
      return first === undefined ? { kind: "varchar" } : { kind: "varchar", length: first };
    case "bpchar":
      // `char` arrives as bpchar(1); bpchar written as such has no length.
      return first === undefined ? { kind: "char" } : { kind: "char", length: first };
    case "uuid":
      return { kind: "uuid" };
    case "date":
      return { kind: "date" };
    case "time":
    case "timetz":
      return { kind: "time", withTimeZone: internal === "timetz", ...(first !== undefined && { precision: first }) };
    case "timestamp":
    case "timestamptz":
      return { kind: "timestamp", withTimeZone: internal === "timestamptz", ...(first !== undefined && { precision: first }) };
    case "interval": {
      if (modifiers.length === 0) {
        return { kind: "interval" };
      }
      const precision = numberAt(modifiers, 1);
      if (first === INTERVAL_FULL_RANGE) {
        return precision === undefined || precision === INTERVAL_FULL_PRECISION ? { kind: "interval" } : { kind: "interval", precision };
      }
      // Restricted to some fields (`interval day to second`): PostgreSQL's own.
      return other();
    }
    case "json":
      return { kind: "json", binary: false };
    case "jsonb":
      return { kind: "json", binary: true };
    case "bytea":
      return { kind: "binary" };
    default:
      return other();
  }
}

/** A `TypeName` node's type. `enums` are the enumerated types known at this point of the migrations. */
export function columnType(typeName: PgNode, enums: ReadonlySet<string>): ColumnTypeInfo {
  const parts = names(typeName);
  const last = parts.at(-1) ?? "";
  const schema = parts.length > 1 ? parts[0] : undefined;
  const qualified = schema !== undefined && schema !== "pg_catalog" && schema !== "public" ? `${schema}.${last}` : undefined;
  const isArray = Array.isArray(typeName.arrayBounds) && typeName.arrayBounds.length > 0;
  const modifiers = modifierValues(typeName);
  const internal = qualified === undefined ? (ALIASES[last] ?? last) : last;
  const written = `${qualified ?? internal}${modifiers.length === 0 ? "" : `(${modifiers.join(",")})`}`;
  const dialectType = `${written}${isArray ? "[]" : ""}`;
  const enumName = qualified === undefined && enums.has(last) ? last : undefined;
  const scalar: CanonicalType = enumName !== undefined ? { kind: "enum", name: enumName } : scalarCanonical(internal, qualified, modifiers);
  if (isArray) {
    // PostgREST and the drivers hand arrays to applications as JSON arrays.
    return { type: "json", canonical: { kind: "array", element: scalar }, dialectType, serial: false, unknown: false };
  }
  if (enumName !== undefined) {
    return { type: "text", canonical: scalar, dialectType: enumName, serial: false, enumName, unknown: false };
  }
  const storage = qualified === undefined ? STORAGE[internal] : undefined;
  return {
    type: storage ?? "any",
    canonical: scalar,
    dialectType,
    serial: qualified === undefined && SERIAL.has(last),
    unknown: storage === undefined,
  };
}
