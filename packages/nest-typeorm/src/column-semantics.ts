import type { ColumnType } from "../../runtime/src/index.ts";

/*
 * What a column of a TypeORM entity is, three times over.
 *
 * An application declares a column under the type name of the database it
 * was written for: `timestamptz`, `int8`, `bytea`. On the sandbox that
 * column has
 *
 * - a logical type: what its values are to the application. It comes from
 *   the declaration and nothing here changes it;
 * - a type for TypeORM's SQLite dialect, which is what TypeORM is given in
 *   the declared type's place while it builds a DataSource. It is chosen so
 *   that TypeORM's own conversion of values, on the way to the database and
 *   back, is the one the logical type has in production;
 * - a storage type, which is how the runtime holds the values in SQLite and
 *   in the JSON fixture.
 *
 * Where TypeORM's SQLite dialect has no conversion that gives the
 * application the value it gets in production, a column transformer makes
 * up the difference. This file is the only place that decides any of that.
 */

/** What a column's values are to the application, whichever database the entity was written for. */
export type LogicalType =
  | "boolean"
  | "integer"
  | "bigint"
  | "decimal"
  | "float"
  | "text"
  | "uuid"
  | "enum"
  | "datetime"
  | "date"
  | "time"
  | "json"
  | "simple-array"
  | "array"
  | "binary";

const NAMES: Record<Exclude<LogicalType, "array">, string[]> = {
  boolean: ["boolean", "bool"],
  integer: ["int", "integer", "tinyint", "smallint", "mediumint", "int2", "int4", "number"],
  bigint: ["bigint", "int8", "unsigned big int"],
  decimal: ["decimal", "numeric", "dec", "fixed"],
  float: ["float", "float4", "float8", "double", "double precision", "real"],
  text: [
    "varchar", "char", "text", "citext", "nvarchar", "nchar", "varchar2", "nvarchar2", "tinytext", "mediumtext", "longtext",
    "character varying", "character", "varying character", "native character", "clob", "string",
  ],
  uuid: ["uuid"],
  enum: ["enum", "simple-enum"],
  datetime: ["datetime", "datetime2", "timestamp", "timestamptz", "timestamp with time zone", "timestamp without time zone", "timestamp with local time zone"],
  date: ["date"],
  time: ["time", "timetz", "time with time zone", "time without time zone"],
  json: ["json", "jsonb", "simple-json"],
  "simple-array": ["simple-array"],
  binary: ["bytea", "blob", "tinyblob", "mediumblob", "longblob", "binary", "varbinary"],
};
const BY_NAME = new Map(Object.entries(NAMES).flatMap(([logical, names]) => names.map((name): [string, LogicalType] => [name, logical as LogicalType])));
/** A property's own type, which TypeORM uses when the column declares none. */
const BY_CONSTRUCTOR = new Map<unknown, LogicalType>([
  [String, "text"],
  [Number, "integer"],
  [Boolean, "boolean"],
  [Date, "datetime"],
  [Buffer, "binary"],
]);
/** Columns that TypeORM fills itself, by the kind of their decorator. */
const BY_MODE: Record<string, LogicalType> = { createDate: "datetime", updateDate: "datetime", deleteDate: "datetime", version: "integer" };

/** The logical type of a declared type name or property type, when it is one this file knows. */
export function logicalTypeOf(declared: unknown, mode = "regular"): LogicalType | undefined {
  if (typeof declared === "string") {
    return BY_NAME.get(declared.toLowerCase());
  }
  return BY_CONSTRUCTOR.get(declared) ?? BY_MODE[mode];
}

/**
 * How the runtime stores a column of a logical type. A numeric enum is stored
 * as an integer; `numericEnum` says that the column is one.
 */
export function storageTypeOf(logical: LogicalType | undefined, numericEnum = false): ColumnType {
  switch (logical) {
    case "boolean":
      return "boolean";
    case "integer":
    case "bigint":
      return "integer";
    case "decimal":
      return "numeric";
    case "float":
      return "real";
    case "text":
    case "uuid":
    case "time":
      return "text";
    case "enum":
      return numericEnum ? "integer" : "text";
    case "datetime":
      return "datetime";
    case "date":
      return "date";
    case "json":
    case "simple-array":
    case "array":
      return "json";
    case "binary":
      return "binary";
    case undefined:
      return "any";
  }
}

export interface ValueTransformer {
  to(value: unknown): unknown;
  from(value: unknown): unknown;
}

/** The parts of a column's decorator options that decide its type and its values. */
export interface ColumnDeclaration {
  type?: unknown;
  array?: unknown;
  enum?: unknown;
  default?: unknown;
  scale?: unknown;
  transformer?: unknown;
  [other: string]: unknown;
}

/** What TypeORM is given in place of a column's declaration while a sandbox DataSource is built. */
export interface SqliteDeclaration {
  /** Options to set; a key with the value `undefined` is removed. */
  set: Partial<ColumnDeclaration>;
  /** Appended to the column's own transformers. */
  transformer?: ValueTransformer;
}

/**
 * TypeORM also hands transformers its find operators (`MoreThan(5)`) and the
 * functions it takes for raw SQL. Those are not values.
 */
function isValue(typeorm: Record<string, any>, value: unknown): boolean {
  return value !== null && value !== undefined && typeof value !== "function" && !(typeof typeorm.FindOperator === "function" && value instanceof typeorm.FindOperator);
}

/**
 * What the node-postgres driver does with an object bound to a parameter: it
 * sends the object's JSON text. TypeORM itself does not convert a value
 * written to a text column, so on PostgreSQL an entity can declare a column
 * as `varchar` or `text`, be saved with an object in it, and read the JSON
 * text back as a string. TypeORM's SQLite dialect passes the object on
 * unchanged, and SQLite cannot bind it.
 *
 * Arrays and dates are left alone, because node-postgres does not send those
 * as JSON. Reading is not changed: the column holds text, as it does in
 * production.
 */
function objectAsJsonText(typeorm: Record<string, any>): ValueTransformer {
  const isJsonObject = (value: unknown): boolean =>
    typeof value === "object" && isValue(typeorm, value) && !Array.isArray(value) && !(value instanceof Date) && !ArrayBuffer.isView(value);
  return { to: (value) => (isJsonObject(value) ? JSON.stringify(value) : value), from: (value) => value };
}

/**
 * A 64-bit integer. PostgreSQL's and MySQL's drivers, as TypeORM sets them
 * up, return it as the text of its digits, because a JavaScript number cannot
 * hold every such value. SQLite stores it as an integer either way: text
 * that is written to an integer column is converted by SQLite, exactly.
 */
const integerAsText: ValueTransformer = {
  to: (value) => value,
  from: (value) => (typeof value === "number" || typeof value === "bigint" ? String(value) : value),
};

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** A decimal number, given as text, rounded half away from zero to `scale` digits after the point, as PostgreSQL and MySQL round one they store. */
export function roundDecimal(text: string, scale: number): string | undefined {
  const match = DECIMAL.exec(text.trim());
  if (match === null || (match[2] === "" && (match[3] ?? "") === "")) {
    return undefined;
  }
  const whole = match[2] === "" ? "0" : (match[2] as string);
  const fraction = match[3] ?? "";
  let digits = BigInt(whole + fraction.slice(0, scale).padEnd(scale, "0"));
  if ((fraction[scale] ?? "0") >= "5") {
    digits += 1n;
  }
  const all = digits.toString().padStart(scale + 1, "0");
  const rounded = scale === 0 ? all : `${all.slice(0, -scale)}.${all.slice(-scale)}`;
  return match[1] === "-" && digits !== 0n ? `-${rounded}` : rounded;
}

/** A number as the text of a decimal, without an exponent. */
function decimalText(value: number): string {
  const text = String(value);
  return /e/i.test(text) ? value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : text;
}

/**
 * A decimal with a fixed number of digits. PostgreSQL's and MySQL's drivers
 * return it as text with all the digits of its scale (`"12.50"`), and the
 * database rounds what it is given to that scale. SQLite stores it as a
 * number; so the value is rounded before it is written, and read back as
 * text of the same form. Without a declared scale nothing is rounded.
 *
 * SQLite's number is a 64-bit float: a decimal of more than about 15
 * significant digits is not held exactly. That is SQLite's, and is not hidden
 * here by keeping such a value as text, which would compare as text in SQL.
 */
function decimalAsText(typeorm: Record<string, any>, scale: number | undefined): ValueTransformer {
  return {
    to: (value) => {
      if (scale === undefined || !isValue(typeorm, value) || (typeof value !== "number" && typeof value !== "string")) {
        return value;
      }
      return (typeof value === "number" && !Number.isFinite(value) ? undefined : roundDecimal(typeof value === "number" ? decimalText(value) : value, scale)) ?? value;
    },
    from: (value) => {
      if (typeof value === "number") {
        return scale === undefined ? decimalText(value) : (roundDecimal(decimalText(value), scale) ?? decimalText(value));
      }
      // An integer too large for a number arrives as text of its digits.
      return typeof value === "string" && scale !== undefined ? (roundDecimal(value, scale) ?? value) : value;
    },
  };
}

/** TypeORM's `simple-array` holds text: whatever is saved, its elements are read back as strings. */
const elementsAsText: ValueTransformer = {
  to: (value) => value,
  from: (value) => (Array.isArray(value) ? value.map((element) => (element === null ? element : String(element))) : value),
};

/** An array of date-times. The array is stored as JSON, where a date is ISO text; PostgreSQL's driver returns `Date` elements. */
const elementsAsDates: ValueTransformer = {
  to: (value) => value,
  from: (value) => (Array.isArray(value) ? value.map((element) => (typeof element === "string" ? new Date(element) : element)) : value),
};

/** Binary data. `node:sqlite` returns a plain `Uint8Array`; PostgreSQL's and MySQL's drivers return a `Buffer`. */
const bytesAsBuffer: ValueTransformer = {
  to: (value) => value,
  from: (value) => (value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value),
};

/**
 * What TypeORM's SQLite dialect is given for a column, so that it accepts the
 * column and converts its values as the application's own database does.
 * `undefined` when the declaration is not one this file knows; it is then
 * left as it is, and TypeORM refuses it if its SQLite dialect does not know
 * it either.
 *
 * `supported` is the list of type names that dialect accepts. A name it
 * accepts and converts correctly is kept.
 */
export function sqliteDeclaration(typeorm: Record<string, any>, declaration: ColumnDeclaration, mode: string, supported: ReadonlySet<string>): SqliteDeclaration | undefined {
  const declared = typeof declaration.type === "string" ? declaration.type.toLowerCase() : undefined;
  const element = logicalTypeOf(declaration.type, mode);
  if (declaration.array === true) {
    // An array is kept as JSON text; array operators in SQL are not available.
    return {
      set: {
        type: "simple-json",
        array: false,
        // The enum of the elements means nothing to a JSON column.
        enum: undefined,
        // PostgreSQL's text for an empty array. Read as JSON it would be an empty object.
        ...(declaration.default === "{}" && { default: "[]" }),
      },
      ...(element === "datetime" ? { transformer: elementsAsDates } : (element === "bigint" || element === "decimal") && { transformer: elementsAsText }),
    };
  }
  /** The declared name when the dialect knows it, otherwise the name it has for the same thing. */
  const kept = (fallback: string): Partial<ColumnDeclaration> => (declared === undefined || supported.has(declared) ? {} : { type: fallback });
  switch (element) {
    case "boolean":
      return { set: kept("boolean") };
    case "integer":
      return { set: kept("integer") };
    case "bigint":
      return { set: kept("bigint"), transformer: integerAsText };
    case "decimal":
      return { set: kept("decimal"), transformer: decimalAsText(typeorm, typeof declaration.scale === "number" ? declaration.scale : undefined) };
    case "float":
      return { set: kept("double") };
    case "text":
      return { set: kept("varchar"), transformer: objectAsJsonText(typeorm) };
    case "uuid":
      return { set: kept("varchar") };
    case "enum":
      return { set: { type: "simple-enum" } };
    case "datetime":
      // A column TypeORM fills itself may declare no type at all, and then gets the dialect's own.
      return { set: declared === undefined ? {} : { type: "datetime" } };
    case "date":
      return { set: kept("date") };
    case "time":
      return { set: kept("time") };
    case "json":
      return { set: declared === "json" && supported.has("json") ? {} : { type: "simple-json" } };
    case "simple-array":
      // Kept as a JSON array, so that the fixture shows one; read as TypeORM reads a simple-array.
      return { set: { type: "simple-json" }, transformer: elementsAsText };
    case "binary":
      return { set: declared === undefined ? {} : { type: "blob" }, transformer: bytesAsBuffer };
    case "array":
    case undefined:
      return undefined;
  }
}
