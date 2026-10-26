import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canonicalTypeKey } from "../../runtime/src/index.ts";
import type { CanonicalType, ColumnSchema } from "../../runtime/src/index.ts";
import { collect, column, table } from "./support.ts";

/*
 * A column's type, three ways (D-036): what it is (the canonical type), how
 * the migration spelled it (the declared type), and what PostgreSQL calls it
 * (the dialect type). The expectations are PostgreSQL's own rules, written
 * out by hand.
 */

/** The columns of a table `t` whose columns `c0`, `c1`, ... have the given types. */
async function columnsOf(types: readonly string[], before = ""): Promise<ColumnSchema[]> {
  const result = await collect({ "1.sql": `${before}create table t (\n${types.map((type, index) => `  c${index} ${type}`).join(",\n")}\n);` });
  return table(result, "t").columns;
}

/** One type, and the ways PostgreSQL lets it be written. */
const SPELLINGS: [CanonicalType, string[]][] = [
  [{ kind: "integer", bits: 16 }, ["smallint", "int2", "smallserial", "serial2"]],
  [{ kind: "integer", bits: 32 }, ["integer", "int", "int4", "serial", "serial4", "INTEGER", "pg_catalog.int4"]],
  [{ kind: "integer", bits: 64 }, ["bigint", "int8", "bigserial", "serial8"]],
  // float(1) to float(24) is real; float(25) to float(53), and float, is double precision.
  [{ kind: "float", bits: 32 }, ["real", "float4", "float(24)"]],
  [{ kind: "float", bits: 64 }, ["double precision", "float8", "float", "float(25)"]],
  [{ kind: "decimal" }, ["numeric", "decimal", "dec"]],
  // PostgreSQL takes a modifier as text, so it may be written as text.
  [{ kind: "decimal", precision: 12, scale: 2 }, ["numeric(12,2)", "decimal(12, 2)", "dec(12,2)", "numeric('12', '2')"]],
  // Since PostgreSQL 15 a scale may be negative, and greater than the precision.
  [{ kind: "decimal", precision: 5, scale: -2 }, ["numeric(5, -2)", "decimal(5,-2)"]],
  [{ kind: "decimal", precision: 3, scale: 5 }, ["numeric(3, 5)"]],
  // numeric(p) is numeric(p, 0).
  [{ kind: "decimal", precision: 10, scale: 0 }, ["numeric(10)", "numeric(10,0)", "decimal(10)"]],
  [{ kind: "boolean" }, ["boolean", "bool"]],
  [{ kind: "text" }, ["text"]],
  [{ kind: "varchar" }, ["varchar", "character varying"]],
  [{ kind: "varchar", length: 20 }, ["varchar(20)", "character varying(20)", "VARCHAR ( 20 )"]],
  // character without a length is character(1).
  [{ kind: "char", length: 1 }, ["char", "character", "char(1)", "character(1)"]],
  [{ kind: "char", length: 3 }, ["char(3)", "character(3)", "bpchar(3)"]],
  [{ kind: "uuid" }, ["uuid"]],
  [{ kind: "date" }, ["date"]],
  [{ kind: "time", withTimeZone: false }, ["time", "time without time zone"]],
  [{ kind: "time", withTimeZone: true }, ["timetz", "time with time zone"]],
  [{ kind: "time", withTimeZone: false, precision: 3 }, ["time(3)", "time(3) without time zone"]],
  [{ kind: "timestamp", withTimeZone: false }, ["timestamp", "timestamp without time zone"]],
  [{ kind: "timestamp", withTimeZone: true }, ["timestamptz", "timestamp with time zone", "Timestamp With Time Zone"]],
  [{ kind: "timestamp", withTimeZone: true, precision: 3 }, ["timestamptz(3)", "timestamp(3) with time zone"]],
  // A precision of 0 is a precision.
  [{ kind: "timestamp", withTimeZone: false, precision: 0 }, ["timestamp(0)", "timestamp(0) without time zone"]],
  [{ kind: "interval" }, ["interval"]],
  [{ kind: "interval", precision: 3 }, ["interval(3)"]],
  [{ kind: "json", binary: false }, ["json"]],
  [{ kind: "json", binary: true }, ["jsonb"]],
  [{ kind: "binary" }, ["bytea"]],
  // Declared sizes and dimensions are not part of an array's type.
  [{ kind: "array", element: { kind: "integer", bits: 32 } }, ["integer[]", "int4[]", "int[][]", "int[3]", "integer array", "integer array[3]"]],
  [{ kind: "array", element: { kind: "varchar", length: 10 } }, ["varchar(10)[]", "character varying(10) array"]],
  [{ kind: "array", element: { kind: "timestamp", withTimeZone: true } }, ["timestamptz[]", "timestamp with time zone[]"]],
];

describe("canonical types of PostgreSQL's column types", () => {
  test("every spelling of one type gives the same canonical type", async () => {
    const spellings = SPELLINGS.flatMap(([canonical, written]) => written.map((type) => ({ type, canonical })));
    const columns = await columnsOf(spellings.map(({ type }) => type));
    assert.equal(columns.length, spellings.length);
    for (const [index, { type, canonical }] of spellings.entries()) {
      assert.deepEqual(columns[index]?.canonicalType, canonical, type);
    }
  });

  test("types that PostgreSQL keeps apart are different canonical types", async () => {
    const pairs: [string, string][] = [
      ["smallint", "integer"],
      ["integer", "bigint"],
      ["real", "double precision"],
      ["numeric", "numeric(10)"],
      ["numeric(10,2)", "numeric(10,3)"],
      ["numeric(10,2)", "numeric(12,2)"],
      ["text", "varchar"],
      ["varchar", "varchar(50)"],
      ["varchar(50)", "varchar(100)"],
      ["char(3)", "varchar(3)"],
      ["uuid", "text"],
      ["date", "timestamp"],
      ["time", "timetz"],
      ["timestamp", "timestamptz"],
      ["timestamp", "timestamp(3)"],
      ["timestamp(3)", "timestamp(6)"],
      ["interval", "interval(3)"],
      ["json", "jsonb"],
      ["integer", "integer[]"],
      ["integer[]", "bigint[]"],
    ];
    const columns = await columnsOf(pairs.flat());
    for (const [index, [first, second]] of pairs.entries()) {
      const a = columns[index * 2]?.canonicalType;
      const b = columns[index * 2 + 1]?.canonicalType;
      assert.ok(a !== undefined && b !== undefined, `${first}, ${second}`);
      assert.notEqual(canonicalTypeKey(a), canonicalTypeKey(b), `${first} and ${second}`);
    }
  });

  test("an enumerated type is named, also as the element of an array and when it is written with its schema", async () => {
    const [plain, qualified, array] = await columnsOf(["mood", "public.mood", "mood[]"], "create type mood as enum ('ok', 'meh');\n");
    assert.deepEqual(plain?.canonicalType, { kind: "enum", name: "mood" });
    assert.deepEqual(qualified?.canonicalType, { kind: "enum", name: "mood" });
    assert.deepEqual(array?.canonicalType, { kind: "array", element: { kind: "enum", name: "mood" } });
    // The enumerated values are enforced for a column of the type; an array of them is stored as JSON.
    assert.deepEqual([plain?.type, plain?.enum, array?.type, array?.enum], ["text", { name: "mood", values: ["ok", "meh"] }, "json", undefined]);
  });

  test("a type without a canonical meaning stays PostgreSQL's, with its name and modifiers", async () => {
    const cases: [string, CanonicalType][] = [
      ["inet", { kind: "other", dialect: "postgresql", name: "inet" }],
      ["citext", { kind: "other", dialect: "postgresql", name: "citext" }],
      ["money", { kind: "other", dialect: "postgresql", name: "money" }],
      ["bit(3)", { kind: "other", dialect: "postgresql", name: "bit", modifiers: [3] }],
      ["bit varying(5)", { kind: "other", dialect: "postgresql", name: "varbit", modifiers: [5] }],
      // A type of another schema is not looked up: it is named with its schema.
      ["extensions.citext", { kind: "other", dialect: "postgresql", name: "extensions.citext" }],
      // PostgreSQL takes a modifier that is a name as that name, in lower case unless it is quoted.
      ["geometry(Point, 4326)", { kind: "other", dialect: "postgresql", name: "geometry", modifiers: ["point", 4326] }],
      ['geometry("PointZ", 4326)', { kind: "other", dialect: "postgresql", name: "geometry", modifiers: ["PointZ", 4326] }],
      ["inet[]", { kind: "array", element: { kind: "other", dialect: "postgresql", name: "inet" } }],
    ];
    const columns = await columnsOf(cases.map(([type]) => type));
    for (const [index, [type, canonical]] of cases.entries()) {
      assert.deepEqual(columns[index]?.canonicalType, canonical, type);
    }
  });

  test("modifiers keep such types apart: two geometries of different shapes are not one type", async () => {
    const [point, polygon, otherSrid] = await columnsOf(["geometry(Point, 4326)", "geometry(Polygon, 4326)", "geometry(Point, 3857)"]);
    assert.ok(point?.canonicalType !== undefined && polygon?.canonicalType !== undefined && otherSrid?.canonicalType !== undefined);
    assert.notEqual(canonicalTypeKey(point.canonicalType), canonicalTypeKey(polygon.canonicalType));
    assert.notEqual(canonicalTypeKey(point.canonicalType), canonicalTypeKey(otherSrid.canonicalType));
    assert.deepEqual([point.sourceDialectType?.type, polygon.sourceDialectType?.type], ["geometry(point,4326)", "geometry(polygon,4326)"]);
  });

  test("an interval restricted to some fields is not the interval over all fields", async () => {
    const [full, dayToSecond, year] = await columnsOf(["interval", "interval day to second", "interval year"]);
    assert.deepEqual(full?.canonicalType, { kind: "interval" });
    for (const restricted of [dayToSecond, year]) {
      assert.equal(restricted?.canonicalType?.kind, "other");
      assert.deepEqual([(restricted?.canonicalType as { dialect?: string }).dialect, (restricted?.canonicalType as { name?: string }).name], ["postgresql", "interval"]);
    }
    assert.ok(dayToSecond?.canonicalType !== undefined && year?.canonicalType !== undefined);
    assert.notEqual(canonicalTypeKey(dayToSecond.canonicalType), canonicalTypeKey(year.canonicalType));
  });
});

describe("the declared type and the dialect type of a column", () => {
  test("the declared type is the migration's spelling; the dialect type is PostgreSQL's own name", async () => {
    const cases: [written: string, declared: string, dialect: string][] = [
      ["integer", "integer", "int4"],
      ["INT", "INT", "int4"],
      ["int4", "int4", "int4"],
      ["bigint", "bigint", "int8"],
      ["smallint", "smallint", "int2"],
      ["bigserial", "bigserial", "int8"],
      ["double precision", "double precision", "float8"],
      ["real", "real", "float4"],
      ["decimal(10, 2)", "decimal(10, 2)", "numeric(10,2)"],
      ["boolean", "boolean", "bool"],
      ["character varying(20)", "character varying(20)", "varchar(20)"],
      ["character(3)", "character(3)", "bpchar(3)"],
      ["char", "char", "bpchar(1)"],
      ["timestamp with time zone", "timestamp with time zone", "timestamptz"],
      ["timestamp without time zone", "timestamp without time zone", "timestamp"],
      ["time(3) with time zone", "time(3) with time zone", "timetz(3)"],
      ["text[]", "text[]", "text[]"],
      ["integer array", "integer array", "int4[]"],
      ["character varying(10)[]", "character varying(10)[]", "varchar(10)[]"],
      ["mood", "mood", "mood"],
      ["public.mood", "public.mood", "mood"],
    ];
    const columns = await columnsOf(cases.map(([written]) => written), "create type mood as enum ('ok');\n");
    assert.deepEqual(
      columns.map((entry) => [entry.declaredType, entry.sourceDialectType]),
      cases.map(([, declared, dialect]) => [declared, { dialect: "postgresql", type: dialect }]),
    );
  });

  test("the declared type is the type alone: what follows it in the column's definition is not part of it", async () => {
    const result = await collect({
      "1.sql": `
        create table parents (id int primary key);
        create table t (
          a integer not null default 0,
          b text collate "C" not null,
          c numeric(12,2) check (c > 0),
          d int generated always as identity,
          e bigint references parents,
          f varchar(20) primary key,
          g double precision unique,
          h timestamp
            with time zone  default now() not null,
          i int constraint i_positive check (i > 0),
          j text null,
          k character varying
        );`,
    });
    assert.deepEqual(
      table(result, "t").columns.map((entry) => [entry.name, entry.declaredType]),
      [
        ["a", "integer"],
        ["b", "text"],
        ["c", "numeric(12,2)"],
        ["d", "int"],
        ["e", "bigint"],
        ["f", "varchar(20)"],
        ["g", "double precision"],
        ["h", "timestamp with time zone"],
        ["i", "int"],
        ["j", "text"],
        ["k", "character varying"],
      ],
    );
  });

  test("ALTER COLUMN ... TYPE changes the declared, the dialect, the canonical, and the storage type together", async () => {
    const result = await collect({
      "1.sql": "create table t (a integer, b varchar(10), c text);",
      "2.sql": `
        alter table t alter column a type numeric(12, 2) using a::numeric;
        alter table t alter column b set data type character varying(40);
        alter table t alter column c type timestamptz using c::timestamptz;`,
    });
    const shape = (name: string): unknown[] => {
      const found = column(result, "t", name);
      return [found.type, found.declaredType, found.sourceDialectType?.type, found.canonicalType];
    };
    assert.deepEqual(shape("a"), ["numeric", "numeric(12, 2)", "numeric(12,2)", { kind: "decimal", precision: 12, scale: 2 }]);
    assert.deepEqual(shape("b"), ["text", "character varying(40)", "varchar(40)", { kind: "varchar", length: 40 }]);
    assert.deepEqual(shape("c"), ["datetime", "timestamptz", "timestamptz", { kind: "timestamp", withTimeZone: true }]);
  });

  test("a column added by ALTER TABLE has its type like one of CREATE TABLE", async () => {
    const result = await collect({ "1.sql": "create table t (id int);\nalter table t add column amount decimal(8,3) not null default 0, add column tags text[];" });
    assert.deepEqual(
      [column(result, "t", "amount").declaredType, column(result, "t", "amount").sourceDialectType?.type, column(result, "t", "amount").canonicalType],
      ["decimal(8,3)", "numeric(8,3)", { kind: "decimal", precision: 8, scale: 3 }],
    );
    assert.deepEqual([column(result, "t", "tags").declaredType, column(result, "t", "tags").canonicalType], ["text[]", { kind: "array", element: { kind: "text" } }]);
  });
});
