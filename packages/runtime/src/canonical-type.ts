/*
 * The canonical type of a column: what the column is, independent of how a
 * dialect spells it (D-036). `integer` and `int4` of PostgreSQL are both
 * `{ kind: "integer", bits: 32 }`; `varchar(50)` and `varchar(100)` are not
 * the same type. Two columns of equal canonical types have the same type,
 * whatever their declared spellings.
 *
 * It is the target every schema source maps its own types into. A source's
 * type without a meaning of its own here is kept as that source's type
 * (`other`), compared by the dialect's name and modifiers, never guessed.
 *
 * It decides nothing in the runtime: how the runtime stores values is the
 * column's storage type (`ColumnSchema.type`).
 */

export type CanonicalType =
  | { kind: "boolean" }
  /** A whole number of 16, 32, or 64 bits. */
  | { kind: "integer"; bits: 16 | 32 | 64 }
  /** An exact decimal; without precision, of any size. `scale` defaults to 0 when there is a precision, and may be below zero or above the precision. */
  | { kind: "decimal"; precision?: number; scale?: number }
  /** A binary floating-point number of 32 or 64 bits. */
  | { kind: "float"; bits: 32 | 64 }
  /** Text of any length. */
  | { kind: "text" }
  /** Text of at most `length` characters; without a length, of any length (still a type of its own, not `text`). */
  | { kind: "varchar"; length?: number }
  /** Text of exactly `length` characters, padded; without a length, of any length. */
  | { kind: "char"; length?: number }
  | { kind: "uuid" }
  | { kind: "date" }
  /** A time of day; `precision` is the number of fractional digits of the seconds. */
  | { kind: "time"; withTimeZone: boolean; precision?: number }
  /** A date and time; `withTimeZone` says that it is a moment (stored in UTC), not a local date and time. */
  | { kind: "timestamp"; withTimeZone: boolean; precision?: number }
  /** A span of time over all fields; one restricted to some fields is a dialect's `other`. */
  | { kind: "interval"; precision?: number }
  /** JSON; `binary` for JSON stored decomposed (PostgreSQL's `jsonb`), which drops duplicate keys and whitespace. */
  | { kind: "json"; binary: boolean }
  /** Bytes. */
  | { kind: "binary" }
  /** An enumerated type of the schema, by name (`DatabaseSchema.types.enums`). */
  | { kind: "enum"; name: string }
  /** An array of another type. Declared sizes and dimensions do not make arrays differ. */
  | { kind: "array"; element: CanonicalType }
  /** A type of one dialect without a canonical meaning: compared by its dialect, name, and modifiers. */
  | { kind: "other"; dialect: string; name: string; modifiers?: (number | string)[] };

export type CanonicalTypeKind = CanonicalType["kind"];

const KINDS: readonly CanonicalTypeKind[] = [
  "boolean",
  "integer",
  "decimal",
  "float",
  "text",
  "varchar",
  "char",
  "uuid",
  "date",
  "time",
  "timestamp",
  "interval",
  "json",
  "binary",
  "enum",
  "array",
  "other",
];

/**
 * A text that is equal for two canonical types exactly when they are the same
 * type. Defaults are made explicit: `decimal(10)` is `decimal(10,0)`.
 */
export function canonicalTypeKey(type: CanonicalType): string {
  switch (type.kind) {
    case "integer":
    case "float":
      return `${type.kind}(${type.bits})`;
    case "decimal":
      return type.precision === undefined ? "decimal" : `decimal(${type.precision},${type.scale ?? 0})`;
    case "varchar":
    case "char":
      return type.length === undefined ? type.kind : `${type.kind}(${type.length})`;
    case "time":
    case "timestamp":
      return `${type.kind}${type.precision === undefined ? "" : `(${type.precision})`}${type.withTimeZone ? " with time zone" : ""}`;
    case "interval":
      return type.precision === undefined ? "interval" : `interval(${type.precision})`;
    case "json":
      return type.binary ? "json(binary)" : "json";
    case "enum":
      return `enum(${JSON.stringify(type.name)})`;
    case "array":
      return `${canonicalTypeKey(type.element)}[]`;
    case "other":
      return `other(${JSON.stringify(type.dialect)},${JSON.stringify(type.name)}${type.modifiers === undefined || type.modifiers.length === 0 ? "" : `,${JSON.stringify(type.modifiers)}`})`;
    default:
      return type.kind;
  }
}

/** Whether two canonical types are the same type. */
export function sameCanonicalType(a: CanonicalType, b: CanonicalType): boolean {
  return canonicalTypeKey(a) === canonicalTypeKey(b);
}

/** A canonical type as people write types: `integer`, `varchar(100)`, `timestamp with time zone`, `text[]`. */
export function formatCanonicalType(type: CanonicalType): string {
  switch (type.kind) {
    case "integer":
      return type.bits === 16 ? "smallint" : type.bits === 32 ? "integer" : "bigint";
    case "float":
      return type.bits === 32 ? "real" : "double precision";
    case "decimal":
      return type.precision === undefined ? "numeric" : `numeric(${type.precision},${type.scale ?? 0})`;
    case "time":
    case "timestamp":
      return `${type.kind}${type.precision === undefined ? "" : `(${type.precision})`}${type.withTimeZone ? " with time zone" : ""}`;
    case "json":
      return type.binary ? "json (binary)" : "json";
    case "enum":
      return `enum ${type.name}`;
    case "array":
      return `${formatCanonicalType(type.element)}[]`;
    case "other":
      return `${type.name}${type.modifiers === undefined || type.modifiers.length === 0 ? "" : `(${type.modifiers.join(",")})`} (${type.dialect})`;
    default:
      return canonicalTypeKey(type);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown, minimum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

/** Keys each kind may have besides `kind`, and whether they are required. */
const FIELDS: Record<CanonicalTypeKind, Record<string, boolean>> = {
  boolean: {},
  integer: { bits: true },
  decimal: { precision: false, scale: false },
  float: { bits: true },
  text: {},
  varchar: { length: false },
  char: { length: false },
  uuid: {},
  date: {},
  time: { withTimeZone: true, precision: false },
  timestamp: { withTimeZone: true, precision: false },
  interval: { precision: false },
  json: { binary: true },
  binary: {},
  enum: { name: true },
  array: { element: true },
  other: { dialect: true, name: true, modifiers: false },
};

/**
 * What is wrong with a value that should be a canonical type (as stored in a
 * schema document), or `undefined` when it is one.
 */
export function canonicalTypeProblem(value: unknown): string | undefined {
  if (!isPlainObject(value) || typeof value.kind !== "string" || !KINDS.includes(value.kind as CanonicalTypeKind)) {
    return `it needs a "kind", one of ${KINDS.join(", ")}`;
  }
  const kind = value.kind as CanonicalTypeKind;
  const fields = FIELDS[kind];
  const unknown = Object.keys(value).find((key) => key !== "kind" && !Object.hasOwn(fields, key));
  if (unknown !== undefined) {
    return `"${unknown}" is not a field of the kind "${kind}"`;
  }
  const missing = Object.entries(fields).find(([key, required]) => required && value[key] === undefined)?.[0];
  if (missing !== undefined) {
    return `the kind "${kind}" needs "${missing}"`;
  }
  switch (kind) {
    case "integer":
      return [16, 32, 64].includes(value.bits as number) ? undefined : '"bits" must be 16, 32, or 64';
    case "float":
      return [32, 64].includes(value.bits as number) ? undefined : '"bits" must be 32 or 64';
    case "decimal":
      if (value.precision !== undefined && !isCount(value.precision, 1)) {
        return '"precision" must be a whole number, 1 or more';
      }
      // A scale may be below zero (rounding to the left of the point) and above the precision; dialects that take neither refuse it themselves.
      if (value.scale !== undefined && (!Number.isSafeInteger(value.scale) || value.precision === undefined)) {
        return '"scale" must be a whole number, and needs a "precision"';
      }
      return undefined;
    case "varchar":
    case "char":
      return value.length === undefined || isCount(value.length, 1) ? undefined : '"length" must be a whole number, 1 or more';
    case "time":
    case "timestamp":
      if (typeof value.withTimeZone !== "boolean") {
        return '"withTimeZone" must be true or false';
      }
      return value.precision === undefined || isCount(value.precision, 0) ? undefined : '"precision" must be a whole number, 0 or more';
    case "interval":
      return value.precision === undefined || isCount(value.precision, 0) ? undefined : '"precision" must be a whole number, 0 or more';
    case "json":
      return typeof value.binary === "boolean" ? undefined : '"binary" must be true or false';
    case "enum":
      return typeof value.name === "string" && value.name !== "" ? undefined : '"name" must be the name of an enumerated type';
    case "array": {
      const problem = canonicalTypeProblem(value.element);
      return problem === undefined ? undefined : `its "element": ${problem}`;
    }
    case "other":
      if (typeof value.dialect !== "string" || value.dialect === "" || typeof value.name !== "string" || value.name === "") {
        return '"dialect" and "name" must be names';
      }
      return value.modifiers === undefined || (Array.isArray(value.modifiers) && value.modifiers.every((modifier) => typeof modifier === "number" || typeof modifier === "string"))
        ? undefined
        : '"modifiers" must be a list of numbers and texts';
    default:
      return undefined;
  }
}

/** A copy of a canonical type with only its own fields, in a fixed order. */
export function copyCanonicalType(type: CanonicalType): CanonicalType {
  switch (type.kind) {
    case "integer":
    case "float":
      return { kind: type.kind, bits: type.bits } as CanonicalType;
    case "decimal":
      return { kind: "decimal", ...(type.precision !== undefined && { precision: type.precision }), ...(type.scale !== undefined && { scale: type.scale }) };
    case "varchar":
    case "char":
      return { kind: type.kind, ...(type.length !== undefined && { length: type.length }) };
    case "time":
    case "timestamp":
      return { kind: type.kind, withTimeZone: type.withTimeZone, ...(type.precision !== undefined && { precision: type.precision }) };
    case "interval":
      return { kind: "interval", ...(type.precision !== undefined && { precision: type.precision }) };
    case "json":
      return { kind: "json", binary: type.binary };
    case "enum":
      return { kind: "enum", name: type.name };
    case "array":
      return { kind: "array", element: copyCanonicalType(type.element) };
    case "other":
      return { kind: "other", dialect: type.dialect, name: type.name, ...(type.modifiers !== undefined && type.modifiers.length > 0 && { modifiers: [...type.modifiers] }) };
    default:
      return { kind: type.kind } as CanonicalType;
  }
}
