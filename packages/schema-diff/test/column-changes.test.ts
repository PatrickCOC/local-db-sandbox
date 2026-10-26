import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ColumnSchema, DatabaseSchema } from "../../runtime/src/index.ts";
import { BIGINT, INTEGER, TEXT, TIMESTAMPTZ, changes, column, enumType, keyColumn, ops, schema, table, typeState } from "./support.ts";
import type { TestType } from "./support.ts";

/** A schema with one table `t`, whose column `c` is as given. */
function withColumn(type: TestType, extra: Partial<ColumnSchema> = {}): DatabaseSchema {
  return schema([table("t", [keyColumn("id"), column("c", type, extra)])], [{ name: "mood", values: ["ok"] }, { name: "feeling", values: ["ok"] }]);
}

describe("schema diff: column types", () => {
  test("a column of another type is altered, and the change gives both types", () => {
    assert.deepEqual(changes(withColumn(INTEGER), withColumn(BIGINT)), [
      { op: "alterColumnType", table: "t", column: "c", before: typeState(INTEGER), after: typeState(BIGINT), comparedBy: "canonical" },
    ]);
  });

  test("types are compared by what they are, not by how they were spelled or are stored", () => {
    const same: [TestType, TestType][] = [
      [INTEGER, { ...INTEGER, declaredType: "int4" }],
      [TIMESTAMPTZ, { ...TIMESTAMPTZ, declaredType: "timestamp with time zone" }],
      // decimal(10) is decimal(10, 0).
      [
        { type: "numeric", canonicalType: { kind: "decimal", precision: 10 }, declaredType: "numeric(10)" },
        { type: "numeric", canonicalType: { kind: "decimal", precision: 10, scale: 0 }, declaredType: "decimal(10,0)" },
      ],
      // The storage type is the runtime's business.
      [
        { type: "text", canonicalType: { kind: "uuid" }, declaredType: "uuid" },
        { type: "any", canonicalType: { kind: "uuid" } },
      ],
      [
        { type: "any", canonicalType: { kind: "other", dialect: "mysql", name: "mediumint" } },
        { type: "integer", canonicalType: { kind: "other", dialect: "mysql", name: "mediumint", modifiers: [] }, declaredType: "MEDIUMINT" },
      ],
    ];
    for (const [before, after] of same) {
      assert.deepEqual(changes(withColumn(before), withColumn(after)), [], `${before.declaredType} and ${after.declaredType}`);
    }
  });

  test("types that are not the same type differ, whatever their storage", () => {
    const text = (canonicalType: TestType["canonicalType"]): TestType => ({ type: "text", canonicalType });
    const different: [TestType, TestType][] = [
      [text({ kind: "varchar", length: 50 }), text({ kind: "varchar", length: 100 })],
      [text({ kind: "varchar" }), text({ kind: "text" })],
      [text({ kind: "char", length: 3 }), text({ kind: "varchar", length: 3 })],
      [text({ kind: "timestamp", withTimeZone: false }), text({ kind: "timestamp", withTimeZone: true })],
      [text({ kind: "timestamp", withTimeZone: true }), text({ kind: "timestamp", withTimeZone: true, precision: 3 })],
      [text({ kind: "json", binary: false }), text({ kind: "json", binary: true })],
      [text({ kind: "decimal", precision: 10, scale: 2 }), text({ kind: "decimal", precision: 12, scale: 2 })],
      [text({ kind: "decimal" }), text({ kind: "decimal", precision: 10 })],
      [text({ kind: "integer", bits: 32 }), text({ kind: "array", element: { kind: "integer", bits: 32 } })],
      [text({ kind: "array", element: { kind: "integer", bits: 32 } }), text({ kind: "array", element: { kind: "integer", bits: 64 } })],
      [enumType("mood"), enumType("feeling")],
      // A type of one dialect: by its dialect, its name, and its modifiers.
      [text({ kind: "other", dialect: "postgresql", name: "inet" }), text({ kind: "other", dialect: "postgresql", name: "cidr" })],
      [text({ kind: "other", dialect: "postgresql", name: "point" }), text({ kind: "other", dialect: "mysql", name: "point" })],
      [text({ kind: "other", dialect: "postgresql", name: "geometry", modifiers: ["point", 4326] }), text({ kind: "other", dialect: "postgresql", name: "geometry", modifiers: ["polygon", 4326] })],
    ];
    for (const [before, after] of different) {
      assert.deepEqual(changes(withColumn(before), withColumn(after)), [{ op: "alterColumnType", table: "t", column: "c", before: typeState(before), after: typeState(after), comparedBy: "canonical" }], JSON.stringify([before, after]));
    }
  });

  test("without a canonical type on both sides, the storage type and the declared spelling are compared, apart from case and spaces", () => {
    const declared = (declaredType?: string, type: TestType["type"] = "text"): TestType => ({ type, ...(declaredType !== undefined && { declaredType }) });
    assert.deepEqual(changes(withColumn(declared("VARCHAR(20)")), withColumn(declared("varchar(20)"))), []);
    assert.deepEqual(changes(withColumn(declared("character  varying(20)")), withColumn(declared(" character varying(20)"))), []);
    assert.deepEqual(changes(withColumn(declared()), withColumn(declared())), []);
    assert.deepEqual(changes(withColumn(declared("varchar(20)")), withColumn(declared("varchar(40)"))), [
      { op: "alterColumnType", table: "t", column: "c", before: { storage: "text", declared: "varchar(20)" }, after: { storage: "text", declared: "varchar(40)" }, comparedBy: "declared" },
    ]);
    assert.deepEqual(changes(withColumn(declared(undefined, "integer")), withColumn(declared(undefined, "text"))), [
      { op: "alterColumnType", table: "t", column: "c", before: { storage: "integer" }, after: { storage: "text" }, comparedBy: "declared" },
    ]);
  });

  test("a spelling is never taken to mean a canonical type: when one side has none, the spellings must agree", () => {
    const spelled: TestType = { type: "integer", declaredType: "integer" };
    assert.deepEqual(changes(withColumn(spelled), withColumn(INTEGER)), []);
    // "int" may well be the same type as "integer"; the diff does not know, and says that it compared spellings.
    assert.deepEqual(changes(withColumn({ type: "integer", declaredType: "int" }), withColumn(INTEGER)), [
      { op: "alterColumnType", table: "t", column: "c", before: { storage: "integer", declared: "int" }, after: typeState(INTEGER), comparedBy: "declared" },
    ]);
  });

  test("without canonical types, a column of another enumerated type is altered", () => {
    const of = (name: string): Partial<ColumnSchema> => ({ enum: { name, values: ["ok"] } });
    assert.deepEqual(changes(withColumn({ type: "text" }, of("mood")), withColumn({ type: "text" }, of("mood"))), []);
    assert.deepEqual(changes(withColumn({ type: "text" }, of("mood")), withColumn({ type: "text" }, of("feeling"))), [
      { op: "alterColumnType", table: "t", column: "c", before: { storage: "text", enum: "mood" }, after: { storage: "text", enum: "feeling" }, comparedBy: "declared" },
    ]);
  });
});

describe("schema diff: nullability", () => {
  test("a column that may no longer be null, and one that now may", () => {
    assert.deepEqual(changes(withColumn(TEXT), withColumn(TEXT, { nullable: false })), [{ op: "setNotNull", table: "t", column: "c" }]);
    assert.deepEqual(changes(withColumn(TEXT, { nullable: false }), withColumn(TEXT)), [{ op: "dropNotNull", table: "t", column: "c" }]);
  });
});

describe("schema diff: defaults", () => {
  test("a default that is given, changed, and taken away", () => {
    assert.deepEqual(changes(withColumn(INTEGER), withColumn(INTEGER, { default: 0 })), [{ op: "setDefault", table: "t", column: "c", after: { kind: "value", value: 0 } }]);
    assert.deepEqual(changes(withColumn(INTEGER, { default: 0 }), withColumn(INTEGER, { default: 1 })), [
      { op: "setDefault", table: "t", column: "c", before: { kind: "value", value: 0 }, after: { kind: "value", value: 1 } },
    ]);
    assert.deepEqual(changes(withColumn(INTEGER, { default: 0 }), withColumn(INTEGER)), [{ op: "dropDefault", table: "t", column: "c", before: { kind: "value", value: 0 } }]);
  });

  test("constant defaults are compared as values: an object by its content, not the order of its keys", () => {
    assert.deepEqual(changes(withColumn(INTEGER, { default: { a: 1, b: [1, { x: 1, y: 2 }] } }), withColumn(INTEGER, { default: { b: [1, { y: 2, x: 1 }], a: 1 } })), []);
    assert.deepEqual(changes(withColumn(INTEGER, { default: [1, 2] }), withColumn(INTEGER, { default: [2, 1] })), [
      { op: "setDefault", table: "t", column: "c", before: { kind: "value", value: [1, 2] }, after: { kind: "value", value: [2, 1] } },
    ]);
    // A number and its digits as text are not the same value.
    assert.deepEqual(changes(withColumn(INTEGER, { default: 0 }), withColumn(INTEGER, { default: "0" })), [
      { op: "setDefault", table: "t", column: "c", before: { kind: "value", value: 0 }, after: { kind: "value", value: "0" } },
    ]);
    assert.deepEqual(changes(withColumn(INTEGER, { default: false }), withColumn(INTEGER, { default: false })), []);
  });

  test("a default of null is no default", () => {
    assert.deepEqual(changes(withColumn(TEXT, { default: null }), withColumn(TEXT)), []);
    assert.deepEqual(changes(withColumn(TEXT), withColumn(TEXT, { default: null })), []);
    assert.deepEqual(changes(withColumn(TEXT, { default: null }), withColumn(TEXT, { default: "x" })), [{ op: "setDefault", table: "t", column: "c", after: { kind: "value", value: "x" } }]);
  });

  test("a constant default with odd keys is compared in full", () => {
    // JSON.parse makes "__proto__" a key like any other; it must not be lost on the way.
    const odd = JSON.parse('{"__proto__": {"admin": true}, "10": 1, "2": 1, "a": 1}') as unknown;
    const plain = JSON.parse('{"10": 1, "2": 1, "a": 1}') as unknown;
    assert.deepEqual(changes(withColumn(INTEGER, { default: odd }), withColumn(INTEGER, { default: odd })), []);
    assert.deepEqual(ops(withColumn(INTEGER, { default: odd }), withColumn(INTEGER, { default: plain })), ["setDefault"]);
  });

  test("a computed default is compared by what it computes, not by how the source wrote it", () => {
    const now = (defaultExpression: string): Partial<ColumnSchema> => ({ defaultFunction: "current_timestamp", defaultExpression });
    assert.deepEqual(changes(withColumn(TIMESTAMPTZ, now("now()")), withColumn(TIMESTAMPTZ, now("CURRENT_TIMESTAMP"))), []);
    assert.deepEqual(changes(withColumn(TIMESTAMPTZ, now("now()")), withColumn(TIMESTAMPTZ, { defaultFunction: "current_timestamp" })), []);
    assert.deepEqual(changes(withColumn(TIMESTAMPTZ, now("now()")), withColumn(TIMESTAMPTZ, { default: "2026-01-01T00:00:00.000Z" })), [
      {
        op: "setDefault",
        table: "t",
        column: "c",
        before: { kind: "function", function: "current_timestamp", expression: "now()" },
        after: { kind: "value", value: "2026-01-01T00:00:00.000Z" },
      },
    ]);
    assert.deepEqual(changes(withColumn(TIMESTAMPTZ, { defaultFunction: "current_timestamp" }), withColumn(TIMESTAMPTZ, { defaultFunction: "current_date" })), [
      { op: "setDefault", table: "t", column: "c", before: { kind: "function", function: "current_timestamp" }, after: { kind: "function", function: "current_date" } },
    ]);
  });

  test("a numbered column: the next number is one default, however the schema marks it", () => {
    assert.deepEqual(changes(withColumn(INTEGER, { generated: "increment" }), withColumn(INTEGER, { generated: "increment", autoIncrement: true })), []);
    assert.deepEqual(changes(withColumn(INTEGER), withColumn(INTEGER, { generated: "increment" })), [{ op: "setDefault", table: "t", column: "c", after: { kind: "increment" } }]);
    assert.deepEqual(changes(withColumn(INTEGER, { autoIncrement: true }), withColumn(INTEGER)), [{ op: "dropDefault", table: "t", column: "c", before: { kind: "increment" } }]);
  });

  test("a default the source's database generates is compared by its strategy and its expression", () => {
    const uuid = (defaultExpression: string): Partial<ColumnSchema> => ({ generated: "uuid", defaultExpression });
    assert.deepEqual(changes(withColumn(TEXT, uuid("gen_random_uuid()")), withColumn(TEXT, uuid("gen_random_uuid()"))), []);
    assert.deepEqual(changes(withColumn(TEXT, uuid("gen_random_uuid()")), withColumn(TEXT, uuid("uuid_generate_v4()"))), [
      {
        op: "setDefault",
        table: "t",
        column: "c",
        before: { kind: "generated", strategy: "uuid", expression: "gen_random_uuid()" },
        after: { kind: "generated", strategy: "uuid", expression: "uuid_generate_v4()" },
      },
    ]);
  });

  test("another expression is compared as text, apart from its layout", () => {
    const expression = (defaultExpression: string): Partial<ColumnSchema> => ({ defaultExpression });
    assert.deepEqual(changes(withColumn(TEXT, expression("lower(name)")), withColumn(TEXT, expression("  lower(name)\n"))), []);
    assert.deepEqual(changes(withColumn(TEXT, expression("a + b")), withColumn(TEXT, expression("a\n    +   b"))), []);
    assert.deepEqual(changes(withColumn(TEXT, expression("lower(name)")), withColumn(TEXT, expression("upper(name)"))), [
      { op: "setDefault", table: "t", column: "c", before: { kind: "expression", expression: "lower(name)" }, after: { kind: "expression", expression: "upper(name)" } },
    ]);
    // Two spellings that may mean the same are a change: the diff does not read expressions.
    assert.equal(changes(withColumn(TEXT, expression("a+b")), withColumn(TEXT, expression("a + b"))).length, 1);
  });

  test("spaces inside a quoted text, and line ends after a comment, are part of an expression", () => {
    const expression = (defaultExpression: string): Partial<ColumnSchema> => ({ defaultExpression });
    for (const [before, after] of [
      ["'a  b' || name", "'a b' || name"],
      ['"my  column" + 1', '"my column" + 1'],
      ["`my  column` + 1", "`my column` + 1"],
      ["$$a  b$$ || name", "$$a b$$ || name"],
      ["a -- note\n + b", "a -- note + b"],
      ["a /* one  two */ + b", "a /* one two */ + b"],
    ] as const) {
      assert.deepEqual(changes(withColumn(TEXT, expression(before)), withColumn(TEXT, expression(after))), [
        { op: "setDefault", table: "t", column: "c", before: { kind: "expression", expression: before }, after: { kind: "expression", expression: after } },
      ]);
    }
    // The same text is the same expression, quotes or not.
    assert.deepEqual(changes(withColumn(TEXT, expression("'a  b' || name")), withColumn(TEXT, expression("  'a  b' || name "))), []);
  });

  test("the changes of one column come in an order they can be made in", () => {
    assert.deepEqual(changes(withColumn(INTEGER, { default: 1 }), withColumn(TEXT, { nullable: false })), [
      { op: "dropDefault", table: "t", column: "c", before: { kind: "value", value: 1 } },
      { op: "alterColumnType", table: "t", column: "c", before: typeState(INTEGER), after: typeState(TEXT), comparedBy: "canonical" },
      { op: "setNotNull", table: "t", column: "c" },
    ]);
    assert.deepEqual(changes(withColumn(INTEGER, { nullable: false }), withColumn(TEXT, { default: "x" })), [
      { op: "alterColumnType", table: "t", column: "c", before: typeState(INTEGER), after: typeState(TEXT), comparedBy: "canonical" },
      { op: "dropNotNull", table: "t", column: "c" },
      { op: "setDefault", table: "t", column: "c", after: { kind: "value", value: "x" } },
    ]);
  });
});
