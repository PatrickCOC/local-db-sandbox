import type { ImportedField } from "../../import-typeorm/src/index.ts";
import type { CanonicalType, EnumType } from "../../runtime/src/index.ts";

/*
 * The canonical type of a column of a TypeORM entity (D-040): what the
 * column is in the database the entity was written for.
 *
 * An entity declares a type by a name, or by none, and TypeORM's driver for
 * a database decides what column that is. The reading here is that of
 * TypeORM's PostgreSQL driver (`PostgresDriver.normalizeType`, the same in
 * 0.3.17 and 0.3.31; a test holds this file to both): `float` is a number of
 * 64 bits, `simple-json` and `simple-array` are text, a `Date` property is a
 * date and time without a time zone, and an enumerated column is of a type
 * of its own, named after its table and column.
 *
 * A name that PostgreSQL does not have (`tinyint`, `datetime`, `longtext`)
 * is not given a meaning: such a column has no canonical type, and keeps
 * what was declared. Nothing here is PostgreSQL's parser, catalog, or SQL;
 * it is what TypeORM's metadata means.
 */

/** The dialect a type without a canonical meaning is kept as a type of. */
const POSTGRESQL = "postgresql";

/** What TypeORM's PostgreSQL driver calls a declared type, where that is another name: its `normalizeType`. */
const NORMALIZED: Readonly<Record<string, string>> = {
  // A property's own type, by the name of its constructor.
  Number: "integer",
  String: "character varying",
  Date: "timestamp without time zone",
  Boolean: "boolean",
  int: "integer",
  int4: "integer",
  varchar: "character varying",
  timestamp: "timestamp without time zone",
  timestamptz: "timestamp with time zone",
  time: "time without time zone",
  timetz: "time with time zone",
  bool: "boolean",
  "simple-array": "text",
  "simple-json": "text",
  "simple-enum": "enum",
  int2: "smallint",
  int8: "bigint",
  decimal: "numeric",
  float8: "double precision",
  float: "double precision",
  float4: "real",
  char: "character",
  varbit: "bit varying",
};

/** The type of the columns that TypeORM fills itself, by their decorator: its driver's `mappedDataTypes`. */
const SPECIAL: Readonly<Record<string, string>> = {
  "@CreateDateColumn": "timestamp",
  "@UpdateDateColumn": "timestamp",
  "@DeleteDateColumn": "timestamp",
  "@VersionColumn": "int4",
};

/** Types of PostgreSQL that TypeORM's driver takes, that have no canonical meaning, and that say nothing beyond their name. */
const OTHER = new Set([
  "money", "citext", "hstore", "point", "line", "lseg", "box", "path", "polygon", "circle", "cidr", "inet", "macaddr", "macaddr8", "tsvector", "tsquery", "xml", "jsonpath",
  "int4range", "int8range", "numrange", "tsrange", "tstzrange", "daterange", "int4multirange", "int8multirange", "nummultirange", "tsmultirange", "tstzmultirange", "datemultirange",
  "ltree", "cube",
]);

/**
 * The name PostgreSQL has for a declared type, as TypeORM's PostgreSQL
 * driver gives it: a type name as an entity declares it, or the name of a
 * property's constructor (`Number`, `String`, `Date`, `Boolean`). A name the
 * driver does not know stands for itself.
 */
export function postgresTypeName(declared: string): string {
  return Object.hasOwn(NORMALIZED, declared) ? (NORMALIZED[declared] as string) : declared;
}

/** What a column of PostgreSQL of this name is. `undefined` for a name PostgreSQL does not have, or one that needs more than is declared. */
function typeNamed(name: string, field: ImportedField): CanonicalType | undefined {
  const { length, precision, scale } = field;
  const fraction = precision === undefined ? {} : { precision };
  switch (name) {
    case "boolean":
      return { kind: "boolean" };
    case "smallint":
      return { kind: "integer", bits: 16 };
    case "integer":
      return { kind: "integer", bits: 32 };
    case "bigint":
      return { kind: "integer", bits: 64 };
    case "numeric":
      // TypeORM writes the digits after the point only with the digits in all.
      return { kind: "decimal", ...(precision !== undefined && { precision, ...(scale !== undefined && { scale }) }) };
    case "real":
      return { kind: "float", bits: 32 };
    case "double precision":
      return { kind: "float", bits: 64 };
    case "text":
      return { kind: "text" };
    case "character varying":
      return { kind: "varchar", ...(length !== undefined && { length }) };
    case "character":
      // PostgreSQL's `character` without a length is one character.
      return { kind: "char", length: length ?? 1 };
    case "uuid":
      return { kind: "uuid" };
    case "date":
      return { kind: "date" };
    case "timestamp without time zone":
      return { kind: "timestamp", withTimeZone: false, ...fraction };
    case "timestamp with time zone":
      return { kind: "timestamp", withTimeZone: true, ...fraction };
    case "time without time zone":
      return { kind: "time", withTimeZone: false, ...fraction };
    case "time with time zone":
      return { kind: "time", withTimeZone: true, ...fraction };
    case "interval":
      return { kind: "interval", ...fraction };
    case "json":
      return { kind: "json", binary: false };
    case "jsonb":
      return { kind: "json", binary: true };
    case "bytea":
      return { kind: "binary" };
    default:
      return OTHER.has(name) ? { kind: "other", dialect: POSTGRESQL, name } : undefined;
  }
}

/**
 * The canonical type of an imported field of the table `table`, and the
 * enumerated type it is of when it is of one. `undefined` when the
 * declaration is of no type PostgreSQL has: then nothing is said.
 */
export function canonicalTypeOf(field: ImportedField, table: string): { type: CanonicalType; enumType?: EnumType } | undefined {
  // A column that TypeORM fills is of the type its decorator states, or of the one the driver has for it.
  const declared = field.sourceType === undefined ? undefined : Object.hasOwn(SPECIAL, field.sourceType) ? (field.declaredType ?? SPECIAL[field.sourceType]) : field.sourceType;
  if (declared === undefined) {
    return undefined;
  }
  const name = postgresTypeName(declared);
  const many = <T extends { type: CanonicalType }>(of: T): T => (field.array === true ? { ...of, type: { kind: "array", element: of.type } } : of);
  if (name === "enum") {
    // The values of an array's elements, or the column's own. Every value of an enumerated type of PostgreSQL is a text.
    const values = field.array === true ? field.elementEnum : field.enum;
    if (values === undefined) {
      return undefined;
    }
    // As TypeORM names the type: by the name the column gives it, or after the table and the column.
    const enumName = field.enumName ?? `${table}_${(field.column ?? field.name).toLowerCase()}_enum`;
    return many({ type: { kind: "enum", name: enumName }, enumType: { name: enumName, values: values.map(String) } });
  }
  const type = typeNamed(name, field);
  return type === undefined ? undefined : many({ type });
}
