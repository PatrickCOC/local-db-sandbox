import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ColumnSchema, DatabaseSchema, EnumType, TableSchema } from "../../runtime/src/index.ts";
import { CHANGE_ORDER, diffSchemas } from "../../schema-diff/src/index.ts";
import type { SchemaChange, SchemaDiff } from "../../schema-diff/src/index.ts";
import { exampleAfter, exampleBefore } from "../../schema-diff/test/example.ts";
import { BIGINT, BOOLEAN, INTEGER, TEXT, TIMESTAMPTZ, column, enumType, keyColumn, origin, renamed, schema, table } from "../../schema-diff/test/support.ts";
import { readSchemaDocument, toSchemaDocument } from "../../storage-json/src/index.ts";
import { DiffApplicationError, MigrationPlanError, applyDiff, planMigration } from "../src/index.ts";
import { assertSameSchema, deepFreeze } from "./support/semantic-form.ts";
import type { FormOptions } from "./support/semantic-form.ts";

/*
 * applyDiff(A, diff(A, B)) means B (D-038). Each test here states a schema
 * and what it became, has the diff made, applies it to the first, and
 * compares the result with the second by what the two mean. The schema that
 * is given, and the diff, are frozen: applying must change neither.
 */

/** The kinds of change that some test here has applied. */
const applied = new Set<string>();

function carried(before: DatabaseSchema, afterSchema: DatabaseSchema, options: FormOptions = {}): { diff: SchemaDiff; result: DatabaseSchema } {
  const diff = diffSchemas(before, afterSchema);
  diff.changes.forEach((change) => applied.add(change.op));
  const result = applyDiff(deepFreeze(structuredClone(before)), deepFreeze(structuredClone(diff)));
  assertSameSchema(result, afterSchema, options);
  return { diff, result };
}

const ops = (diff: SchemaDiff): string[] => diff.changes.map((change) => change.op);
const tableOf = (result: DatabaseSchema, name: string): TableSchema => {
  const found = result.tables.find((candidate) => candidate.name === name);
  assert.ok(found, `table ${name}`);
  return found;
};
const columnOf = (result: DatabaseSchema, tableName: string, name: string): ColumnSchema => {
  const found = tableOf(result, tableName).columns.find((candidate) => candidate.name === name);
  assert.ok(found, `column ${tableName}.${name}`);
  return found;
};

/** An object as it is after `renames`: created as the first name, called the last one now. */
function tracked(names: string[], file = "0002_rename.sql"): { origin: ReturnType<typeof origin>; renames?: ReturnType<typeof renamed>[] } {
  const [first, ...rest] = names as [string, ...string[]];
  const renames = rest.map((to, index) => renamed(names[index] as string, to, file, index + 1));
  return { origin: origin(first), ...(renames.length > 0 && { renames }) };
}

const status: EnumType = { name: "status", values: ["draft", "live"], origin: origin("status") };
const statusColumn = (name: string, type = "status", extra: Partial<ColumnSchema> = {}): ColumnSchema => column(name, enumType(type), { enum: { name: type, values: ["draft", "live"] }, ...extra });

describe("applyDiff: tables", () => {
  test("a table that is added comes with its columns, key, unique constraints, checks, indexes, and foreign keys", () => {
    const users = table("users", [keyColumn("id")]);
    const posts = table(
      "posts",
      [keyColumn("id"), column("author", INTEGER, { nullable: false, references: { table: "users", column: "id", onDelete: "CASCADE", name: "posts_author_fkey" } }), column("slug", TEXT), column("n", BIGINT, { default: 0 })],
      { primaryKey: { name: "posts_pkey", columns: ["id"] }, uniques: [{ name: "posts_slug_key", columns: ["slug"] }], checks: [{ name: "posts_n_check", expression: "n >= 0" }], indexes: [{ name: "posts_author_idx", columns: ["author", "n"] }] },
    );
    const { diff, result } = carried(schema([users]), schema([users, posts]));
    assert.deepEqual(ops(diff), ["addTable", "addIndex", "addForeignKey"]);
    // The columns of a new table are in the order the diff gives them.
    assert.deepEqual(tableOf(result, "posts").columns.map((entry) => entry.name), ["id", "author", "slug", "n"]);
    assert.deepEqual(columnOf(result, "posts", "id").primary, true);
  });

  test("a table that is dropped goes with everything it has; a foreign key into it goes first", () => {
    const users = table("users", [keyColumn("id")]);
    const posts = table("posts", [keyColumn("id"), column("author", INTEGER, { references: { table: "users", column: "id", name: "posts_author_fkey" } })], { indexes: [{ name: "posts_author_idx", columns: ["author"] }] });
    carried(schema([users, posts]), schema([users]));
    const { diff } = carried(schema([users, posts]), schema([table("posts", [keyColumn("id"), column("author")], { indexes: [{ name: "posts_author_idx", columns: ["author"] }] })]));
    assert.deepEqual(ops(diff), ["dropForeignKey", "dropTable"]);
  });

  test("a renamed table keeps what it has, and what refers to it follows", () => {
    const users = (name: string): TableSchema => table(name, [keyColumn("id"), column("boss", INTEGER, { references: { table: name, column: "id", name: "boss_fkey" } })], { ...tracked(name === "users" ? ["users"] : ["users", name]) });
    const posts = (target: string): TableSchema =>
      table("posts", [keyColumn("id"), column("author", INTEGER, { references: { table: target, column: "id", name: "posts_author_fkey" } }), column("editor")], {
        foreignKeys: [{ name: "posts_pair_fkey", columns: ["editor", "author"], references: { table: target, columns: ["id", "boss"] } }],
      });
    const { diff, result } = carried(schema([users("users"), posts("users")]), schema([users("accounts"), posts("accounts")]));
    assert.deepEqual(ops(diff), ["renameTable"]);
    assert.deepEqual(result.tables.map((entry) => entry.name), ["accounts", "posts"]);
    assert.equal(columnOf(result, "accounts", "boss").references?.table, "accounts");
  });

  test("a table that takes the name of a dropped one is renamed, and the dropped one is gone", () => {
    const before = schema([table("a", [keyColumn("id"), column("x")], { origin: origin("a") }), table("b", [keyColumn("id"), column("y")], { origin: origin("b") })]);
    const afterSchema = schema([table("a", [keyColumn("id"), column("y")], { ...tracked(["b", "a"]) })]);
    const { diff } = carried(before, afterSchema);
    assert.deepEqual(ops(diff), ["dropTable", "renameTable"]);
  });

  test("tables that exchange their names, and tables that pass a name on", () => {
    const made = (name: string, created: string, marker: string): TableSchema => table(name, [keyColumn("id"), column(marker)], { ...tracked(created === name ? [name] : [created, "tmp", name]) });
    const swapped = carried(schema([made("a", "a", "of_a"), made("b", "b", "of_b")]), schema([made("b", "a", "of_a"), made("a", "b", "of_b")]));
    assert.deepEqual(ops(swapped.diff), ["renameTable", "renameTable"]);
    assert.deepEqual(tableOf(swapped.result, "a").columns.map((entry) => entry.name), ["id", "of_b"]);

    const chain = (name: string, created: string, marker: string): TableSchema => table(name, [keyColumn("id"), column(marker)], { ...tracked(created === name ? [name] : [created, name]) });
    const passed = carried(schema([chain("a", "a", "of_a"), chain("b", "b", "of_b")]), schema([chain("b", "a", "of_a"), chain("c", "b", "of_b")]));
    assert.deepEqual(ops(passed.diff), ["renameTable", "renameTable"]);
    assert.deepEqual(tableOf(passed.result, "b").columns.map((entry) => entry.name), ["id", "of_a"]);
  });
});

describe("applyDiff: columns", () => {
  const withColumns = (...columns: ColumnSchema[]): DatabaseSchema => schema([table("t", [keyColumn("id"), ...columns])]);
  /** A column of an enumerated type that only the column gives. */
  const statusColumnOf = (name: string): ColumnSchema => column(name, enumType("status"), { enum: { name: "status", values: ["draft", "live"] } });

  test("a column is added at the end, dropped, and renamed", () => {
    const { result } = carried(withColumns(column("a"), column("b", TEXT, { origin: origin("b") })), withColumns(column("renamed", TEXT, { ...tracked(["b", "renamed"]) }), column("c", BOOLEAN, { nullable: false, default: false })));
    assert.deepEqual(tableOf(result, "t").columns.map((entry) => entry.name), ["id", "renamed", "c"]);
  });

  test("what is over a renamed column follows it: the key, constraints, indexes, and foreign keys from here and to here", () => {
    const parent = (name: string): TableSchema =>
      table("parent", [column(name, INTEGER, { nullable: false, primary: true, ...tracked(name === "code" ? ["code"] : ["code", name]) }), column("other")], {
        primaryKey: { name: "parent_pkey", columns: [name] },
        uniques: [{ name: "parent_pair_key", columns: ["other", name] }],
        indexes: [{ name: "parent_code_idx", columns: [name] }],
        foreignKeys: [{ name: "parent_self_fkey", columns: ["other", name], references: { table: "parent", columns: [name, "other"] } }],
      });
    const child = (name: string): TableSchema => table("child", [keyColumn("id"), column("parent", INTEGER, { references: { table: "parent", column: name, name: "child_parent_fkey" } })]);
    const { diff } = carried(schema([parent("code"), child("code")]), schema([parent("key"), child("key")]));
    assert.deepEqual(ops(diff), ["renameColumn"]);
  });

  test("a column renamed onto the name of a dropped one, and a new column under the old name of a renamed one", () => {
    const onto = carried(withColumns(column("a", TEXT, { origin: origin("a") }), column("b", INTEGER, { origin: origin("b") })), withColumns(column("a", INTEGER, { ...tracked(["b", "a"]) })));
    assert.deepEqual(ops(onto.diff), ["dropColumn", "renameColumn"]);
    assert.equal(columnOf(onto.result, "t", "a").type, "integer");

    const under = carried(withColumns(column("rate", INTEGER, { origin: origin("rate") })), withColumns(column("reference_rate", INTEGER, { ...tracked(["rate", "reference_rate"]) }), column("rate", TEXT, { origin: origin("rate", "0002_rename.sql", 2) })));
    assert.deepEqual(ops(under.diff), ["renameColumn", "addColumn"]);
    assert.deepEqual([columnOf(under.result, "t", "reference_rate").type, columnOf(under.result, "t", "rate").type], ["integer", "text"]);
  });

  test("columns that exchange their names, and columns that pass a name on, also in a renamed table", () => {
    const of = (tableName: string, first: string, second: string, third?: string): DatabaseSchema =>
      schema([
        table(
          tableName,
          [
            keyColumn("id"),
            column(first, INTEGER, { ...tracked(first === "a" ? ["a"] : ["a", "tmp", first].filter((name, index, all) => all.indexOf(name) === index)) }),
            column(second, TEXT, { ...tracked(second === "b" ? ["b"] : ["b", second]) }),
            ...(third === undefined ? [] : [column(third, BOOLEAN, { ...tracked(third === "c" ? ["c"] : ["c", third]) })]),
          ],
          { ...tracked(tableName === "t" ? ["t"] : ["t", tableName]), indexes: [{ name: "t_first_idx", columns: [first] }] },
        ),
      ]);
    const swapped = carried(of("t", "a", "b"), of("u", "b", "a"));
    assert.deepEqual(ops(swapped.diff), ["renameTable", "renameColumn", "renameColumn"]);
    assert.deepEqual([columnOf(swapped.result, "u", "b").type, columnOf(swapped.result, "u", "a").type], ["integer", "text"]);
    assert.deepEqual(tableOf(swapped.result, "u").indexes?.[0]?.columns, ["b"]);
    // a -> b, b -> c, c -> a: every name is taken by another column.
    const rotated = carried(of("t", "a", "b", "c"), of("t", "b", "c", "a"));
    assert.deepEqual(ops(rotated.diff), ["renameColumn", "renameColumn", "renameColumn"]);
    assert.deepEqual(["a", "b", "c"].map((name) => columnOf(rotated.result, "t", name).type), ["boolean", "integer", "text"]);
  });

  test("a column's type, by canonical type and, without one, by what was declared", () => {
    const { result } = carried(withColumns(column("n"), column("s", TEXT)), withColumns(column("n", BIGINT), column("s", { type: "text", canonicalType: { kind: "varchar", length: 20 }, declaredType: "varchar(20)" })));
    assert.deepEqual([columnOf(result, "t", "n").canonicalType, columnOf(result, "t", "n").declaredType], [{ kind: "integer", bits: 64 }, "bigint"]);
    const declared = carried(withColumns(column("n", { type: "integer", declaredType: "int" })), withColumns(column("n", { type: "text", declaredType: "varchar" })), { types: "declared" });
    assert.deepEqual(ops(declared.diff), ["alterColumnType"]);
    assert.deepEqual([columnOf(declared.result, "t", "n").type, columnOf(declared.result, "t", "n").declaredType, columnOf(declared.result, "t", "n").canonicalType], ["text", "varchar", undefined]);
    // The before side says what its type is and the after side does not: the result does not keep saying it.
    const forgotten = carried(withColumns(column("n", INTEGER), statusColumnOf("s")), schema([table("t", [keyColumn("id"), column("n", { type: "text", declaredType: "varchar" }), column("s", { type: "text", declaredType: "label" })])]), { types: "declared" });
    assert.deepEqual([columnOf(forgotten.result, "t", "n").canonicalType, columnOf(forgotten.result, "t", "s").canonicalType, columnOf(forgotten.result, "t", "s").enum], [undefined, undefined, undefined]);
  });

  test("what the source's database calls a type is not kept when the type changes: it is no longer known", () => {
    const { result } = carried(withColumns(column("n", INTEGER, { sourceDialectType: { dialect: "postgresql", type: "int4" } }), column("m", INTEGER, { sourceDialectType: { dialect: "postgresql", type: "int4" } })), withColumns(column("n", BIGINT), column("m")));
    assert.deepEqual([columnOf(result, "t", "n").sourceDialectType, columnOf(result, "t", "m").sourceDialectType], [undefined, { dialect: "postgresql", type: "int4" }]);
  });

  test("nullability, both ways", () => {
    const { diff } = carried(withColumns(column("a"), column("b", TEXT, { nullable: false })), withColumns(column("a", INTEGER, { nullable: false }), column("b", TEXT)));
    assert.deepEqual(ops(diff), ["dropNotNull", "setNotNull"]);
  });

  test("defaults of every kind are set, changed, and dropped", () => {
    const kinds: Partial<ColumnSchema>[] = [
      { default: 5 },
      { default: { a: [1, { b: null }] } },
      { default: false },
      { defaultFunction: "current_timestamp", defaultExpression: "now()" },
      { generated: "increment" },
      { generated: "uuid", defaultExpression: "gen_random_uuid()" },
      { defaultExpression: "next_code()" },
    ];
    const type = (extra: Partial<ColumnSchema>): typeof INTEGER => (extra.defaultFunction !== undefined ? TIMESTAMPTZ : INTEGER);
    for (const [index, from] of kinds.entries()) {
      for (const to of [...kinds.slice(index + 1), {}]) {
        // Only the default changes: the type is the one both defaults can have.
        const shared = type(from) === TIMESTAMPTZ || type(to) === TIMESTAMPTZ ? TIMESTAMPTZ : INTEGER;
        carried(withColumns(column("c", shared, from)), withColumns(column("c", shared, to)));
        carried(withColumns(column("c", shared, to)), withColumns(column("c", shared, from)));
      }
    }
    const { result } = carried(withColumns(column("c", INTEGER, { default: 5 })), withColumns(column("c", INTEGER, { generated: "uuid", defaultExpression: "gen_random_uuid()" })));
    assert.deepEqual([columnOf(result, "t", "c").default, columnOf(result, "t", "c").generated, columnOf(result, "t", "c").defaultExpression], [undefined, "uuid", "gen_random_uuid()"]);
    // A default that the runtime computes keeps how the source wrote it.
    const computed = carried(withColumns(column("at", TIMESTAMPTZ)), withColumns(column("at", TIMESTAMPTZ, { defaultFunction: "current_timestamp", defaultExpression: "now()" })));
    assert.deepEqual([columnOf(computed.result, "t", "at").defaultFunction, columnOf(computed.result, "t", "at").defaultExpression], ["current_timestamp", "now()"]);
  });

  test("a numbered key that gets another default is no longer numbered, by the source or by the runtime", () => {
    const numbered = schema([table("t", [keyColumn("id", INTEGER, { generated: "increment", autoIncrement: true })])]);
    const { result } = carried(numbered, schema([table("t", [keyColumn("id", INTEGER, { default: 7 })])]));
    assert.deepEqual([columnOf(result, "t", "id").autoIncrement, columnOf(result, "t", "id").generated, columnOf(result, "t", "id").default], [undefined, undefined, 7]);
    carried(numbered, schema([table("t", [keyColumn("id")])]));
  });

  test("a numbered column that is one of several key columns, or is no integer, is not numbered by the runtime", () => {
    const several = carried(schema([table("t", [keyColumn("a"), keyColumn("b")])]), schema([table("t", [keyColumn("a", INTEGER, { generated: "increment" }), keyColumn("b")])]));
    assert.deepEqual([columnOf(several.result, "t", "a").generated, columnOf(several.result, "t", "a").autoIncrement], ["increment", undefined]);
    const text = carried(schema([table("t", [keyColumn("a", TEXT)])]), schema([table("t", [keyColumn("a", TEXT, { generated: "increment" })])]));
    assert.deepEqual([columnOf(text.result, "t", "a").generated, columnOf(text.result, "t", "a").autoIncrement], ["increment", undefined]);
  });

  test("a column that is numbered is numbered by the runtime only as a single integer key, as a collector would say it", () => {
    const { result } = carried(schema([table("t", [keyColumn("id"), column("n")])]), schema([table("t", [keyColumn("id", INTEGER, { generated: "increment", autoIncrement: true }), column("n", INTEGER, { generated: "increment" })])]));
    assert.deepEqual([columnOf(result, "t", "id").autoIncrement, columnOf(result, "t", "id").generated], [true, "increment"]);
    assert.deepEqual([columnOf(result, "t", "n").autoIncrement, columnOf(result, "t", "n").generated], [undefined, "increment"]);
    // The key goes: the column is still numbered where it came from, and no longer by the runtime.
    const unkeyed = carried(schema([table("t", [keyColumn("id", INTEGER, { generated: "increment", autoIncrement: true })])]), schema([table("t", [column("id", INTEGER, { nullable: false, generated: "increment" })])]));
    assert.deepEqual([columnOf(unkeyed.result, "t", "id").autoIncrement, columnOf(unkeyed.result, "t", "id").generated, columnOf(unkeyed.result, "t", "id").primary], [undefined, "increment", false]);
  });
});

describe("applyDiff: keys, constraints, and indexes", () => {
  const withTable = (extra: Partial<TableSchema>, columns: ColumnSchema[] = [column("id", INTEGER, { nullable: false }), column("a"), column("b")]): DatabaseSchema => schema([table("t", columns, extra)]);
  const keyed = (names: string[], extra: Partial<TableSchema> = {}): DatabaseSchema =>
    withTable(extra, [column("id", INTEGER, { nullable: false, primary: names.includes("id") }), column("a", INTEGER, { nullable: false, primary: names.includes("a") }), column("b", INTEGER, { nullable: false, primary: names.includes("b") })]);

  test("a primary key is added, dropped, renamed, and put over other columns or in another order", () => {
    carried(keyed([]), keyed(["id"], { primaryKey: { name: "t_pkey", columns: ["id"] } }));
    carried(keyed(["id"], { primaryKey: { name: "t_pkey", columns: ["id"] } }), keyed([]));
    const reordered = carried(keyed(["a", "b"], { primaryKey: { name: "t_pkey", columns: ["a", "b"] } }), keyed(["a", "b"], { primaryKey: { name: "t_pkey", columns: ["b", "a"] } }));
    assert.deepEqual(ops(reordered.diff), ["dropPrimaryKey", "addPrimaryKey"]);
    assert.deepEqual(tableOf(reordered.result, "t").primaryKey?.columns, ["b", "a"]);
    const renamedKey = carried(keyed(["id"], { primaryKey: { name: "t_pkey", columns: ["id"], origin: origin("t_pkey") } }), keyed(["id"], { primaryKey: { name: "t_key", columns: ["id"], ...tracked(["t_pkey", "t_key"]) } }));
    assert.deepEqual(ops(renamedKey.diff), ["renameConstraint"]);
    assert.equal(tableOf(renamedKey.result, "t").primaryKey?.name, "t_key");
  });

  test("a key that only the columns' marks give (no name, no order of its own) is applied as that", () => {
    const { diff, result } = carried(keyed([]), keyed(["a", "id"]));
    assert.deepEqual(ops(diff), ["addPrimaryKey"]);
    assert.deepEqual(tableOf(result, "t").columns.map((entry) => entry.primary), [true, true, false]);
    assert.equal(tableOf(result, "t").primaryKey, undefined);
    carried(keyed(["a", "id"]), keyed(["b"]));
  });

  test("unique constraints and checks, with names and without", () => {
    const { diff } = carried(
      withTable({ uniques: [{ name: "t_a_key", columns: ["a"] }, { columns: ["a", "b"] }], checks: [{ name: "t_a_check", expression: "a > 0" }, { expression: "b > 0" }] }),
      withTable({ uniques: [{ name: "t_b_key", columns: ["b"] }, { columns: ["b", "a"] }], checks: [{ name: "t_a_check", expression: "a >= 0" }, { expression: "b <> 0" }] }),
    );
    assert.deepEqual(ops(diff), ["dropCheck", "dropCheck", "dropUnique", "dropUnique", "addUnique", "addUnique", "addCheck", "addCheck"]);
    const renamedCheck = carried(withTable({ checks: [{ name: "c1", expression: "a > 0", origin: origin("c1") }], uniques: [{ name: "u1", columns: ["a"], origin: origin("u1") }] }), withTable({ checks: [{ name: "c2", expression: "a > 0", ...tracked(["c1", "c2"]) }], uniques: [{ name: "u2", columns: ["a"], ...tracked(["u1", "u2"]) }] }));
    assert.deepEqual(ops(renamedCheck.diff), ["renameConstraint", "renameConstraint"]);
  });

  test("a constraint without a name is the one the diff describes, not the first the table has", () => {
    const { result } = carried(withTable({ checks: [{ expression: "a > 0" }, { expression: "b > 0" }], uniques: [{ columns: ["a"] }, { columns: ["b"] }] }), withTable({ checks: [{ expression: "a > 0" }], uniques: [{ columns: ["a"] }] }));
    assert.deepEqual([tableOf(result, "t").checks, tableOf(result, "t").uniques], [[{ expression: "a > 0" }], [{ columns: ["a"] }]]);
    const keys = (targets: string[]): DatabaseSchema => schema([table("target", [keyColumn("id"), column("code")]), table("t", [keyColumn("id"), column("a")], { foreignKeys: targets.map((target) => ({ columns: ["a"], references: { table: "target", columns: [target] } })) })]);
    assert.deepEqual(tableOf(carried(keys(["id", "code"]), keys(["id"])).result, "t").foreignKeys, [{ columns: ["a"], references: { table: "target", columns: ["id"] } }]);
  });

  test("of two constraints without names that are alike, one is dropped and one stays", () => {
    const { result } = carried(withTable({ checks: [{ expression: "a > 0" }, { expression: "a > 0" }], uniques: [{ columns: ["a"] }, { columns: ["a"] }] }), withTable({ checks: [{ expression: "a > 0" }], uniques: [{ columns: ["a"] }] }));
    assert.deepEqual([tableOf(result, "t").checks?.length, tableOf(result, "t").uniques?.length], [1, 1]);
  });

  test("indexes: over columns, over expressions, with a condition, unique, renamed", () => {
    const { diff } = carried(
      withTable({ indexes: [{ name: "i1", columns: ["a"] }, { name: "i2", columns: ["a", "b"], unique: true }, { name: "i3", columns: [], expressions: ["lower(x)"], origin: origin("i3") }] }),
      withTable({ indexes: [{ name: "i1", columns: ["b"] }, { name: "i2", columns: ["a", "b"], unique: true, where: "a > 0" }, { name: "i4", columns: [], expressions: ["lower(x)"], ...tracked(["i3", "i4"]) }] }),
    );
    assert.deepEqual(ops(diff), ["dropIndex", "dropIndex", "renameIndex", "addIndex", "addIndex"]);
  });

  test("foreign keys: of one column and of several, their actions, names, and the two places a schema keeps them", () => {
    const target = table("target", [keyColumn("id"), column("code", INTEGER, { nullable: false })], { uniques: [{ name: "target_pair_key", columns: ["id", "code"] }] });
    const referring = (reference: ColumnSchema["references"], several: TableSchema["foreignKeys"]): TableSchema => table("referring", [keyColumn("id"), column("a", INTEGER, reference === undefined ? {} : { references: reference }), column("b")], several === undefined ? {} : { foreignKeys: several });
    const single = { table: "target", column: "id", name: "a_fkey" };
    const pair = { name: "pair_fkey", columns: ["a", "b"], references: { table: "target", columns: ["id", "code"] } };
    // Added, the action changed, and dropped.
    carried(schema([target, referring(undefined, undefined)]), schema([target, referring(single, [pair])]));
    const changed = carried(schema([target, referring(single, [pair])]), schema([target, referring({ ...single, onDelete: "CASCADE" }, [{ ...pair, onUpdate: "set null" }])]));
    assert.deepEqual(ops(changed.diff), ["dropForeignKey", "dropForeignKey", "addForeignKey", "addForeignKey"]);
    carried(schema([target, referring(single, [pair])]), schema([target, referring(undefined, undefined)]));
    // A second key over one column is kept in the table's list; the column has room for one.
    const second = carried(schema([target, referring(single, undefined)]), schema([target, referring(single, [{ name: "a_code_fkey", columns: ["a"], references: { table: "target", columns: ["code"] } }])]));
    assert.deepEqual([columnOf(second.result, "referring", "a").references?.name, tableOf(second.result, "referring").foreignKeys?.map((key) => key.name)], ["a_fkey", ["a_code_fkey"]]);
    // No action is said by saying nothing, as a schema says it.
    const plain = carried(schema([target, referring(undefined, undefined)]), schema([target, referring({ ...single, onUpdate: "NO ACTION" }, [{ ...pair, onDelete: "no action" }])]));
    assert.deepEqual([columnOf(plain.result, "referring", "a").references, tableOf(plain.result, "referring").foreignKeys], [single, [pair]]);
    // Renamed, and without a name.
    const renamedKey = carried(schema([target, referring({ ...single, origin: origin("a_fkey") }, undefined)]), schema([target, referring({ ...single, name: "a_target_fkey", ...tracked(["a_fkey", "a_target_fkey"]) }, undefined)]));
    assert.deepEqual(ops(renamedKey.diff), ["renameConstraint"]);
    carried(schema([target, referring({ table: "target", column: "id" }, undefined)]), schema([target, referring({ table: "target", column: "code" }, undefined)]));
  });

  test("tables that refer to each other are added together and dropped together", () => {
    const a = table("a", [keyColumn("id"), column("b_id", INTEGER, { references: { table: "b", column: "id", name: "a_b_fkey" } })]);
    const b = table("b", [keyColumn("id"), column("a_id", INTEGER, { references: { table: "a", column: "id", name: "b_a_fkey" } })]);
    const other = table("other", [keyColumn("id")]);
    carried(schema([other]), schema([other, a, b]));
    const { diff } = carried(schema([other, a, b]), schema([other]));
    assert.deepEqual(ops(diff), ["dropTable", "dropTable"]);
  });

  test("a foreign key to a table the schema does not have is kept as it is, and follows no rename", () => {
    const of = (name: string): DatabaseSchema => schema([table(name, [keyColumn("id"), column("ghost_id", INTEGER, { references: { table: "ghost", column: "id", name: "ghost_fkey" } })], { ...tracked(name === "t" ? ["t"] : ["t", name]) })]);
    const { result } = carried(of("t"), of("u"));
    assert.equal(columnOf(result, "u", "ghost_id").references?.table, "ghost");
  });
});

describe("applyDiff: enumerated types", () => {
  const withType = (type: EnumType | undefined, columns: ColumnSchema[] = []): DatabaseSchema => schema([table("posts", [keyColumn("id"), ...columns])], type === undefined ? [] : [type]);

  test("a type is added with a column of it, and dropped when its column goes or takes another type", () => {
    carried(withType(undefined), withType(status, [statusColumn("state")]));
    carried(withType(status, [statusColumn("state")]), withType(undefined));
    const { diff, result } = carried(withType(status, [statusColumn("state", "status", { default: "draft" })]), withType(undefined, [column("state", TEXT, { default: "draft" })]));
    assert.deepEqual(ops(diff), ["alterColumnType", "dropEnumType"]);
    assert.equal(columnOf(result, "posts", "state").enum, undefined);
  });

  test("a renamed type: its columns follow, also a column of arrays of it", () => {
    const columns = (name: string): ColumnSchema[] => [statusColumn("state", name), column("history", { type: "json", canonicalType: { kind: "array", element: { kind: "array", element: { kind: "enum", name } } }, declaredType: `${name}[]` })];
    const { diff, result } = carried(withType(status, columns("status")), withType({ ...status, name: "post_status", ...tracked(["status", "post_status"]) }, columns("post_status")));
    assert.deepEqual(ops(diff), ["renameEnumType"]);
    assert.deepEqual([columnOf(result, "posts", "state").enum?.name, columnOf(result, "posts", "state").canonicalType], ["post_status", { kind: "enum", name: "post_status" }]);
    assert.deepEqual(columnOf(result, "posts", "history").canonicalType, { kind: "array", element: { kind: "array", element: { kind: "enum", name: "post_status" } } });
    assert.deepEqual(result.types.enums.map((type) => [type.name, type.renames?.length]), [["post_status", 1]]);
  });

  test("values are added where the change says: at the start, in between, at the end, and one after another", () => {
    const of = (values: string[]): DatabaseSchema => withType({ ...status, values }, [statusColumn("state", "status", { enum: { name: "status", values } })]);
    for (const values of [["first", "draft", "live"], ["draft", "between", "live"], ["draft", "live", "last"], ["a", "b", "draft", "c", "d", "live", "e", "f"]]) {
      const { diff, result } = carried(of(["draft", "live"]), of(values));
      assert.deepEqual(new Set(ops(diff)), new Set(["addEnumValue"]));
      assert.deepEqual([result.types.enums[0]?.values, columnOf(result, "posts", "state").enum?.values], [values, values]);
    }
    carried(withType({ ...status, values: [] }), withType({ ...status, values: ["a", "b"] }));
  });

  test("a value is removed, values are put in another order, and both at once with values added", () => {
    const of = (values: string[]): DatabaseSchema => withType({ ...status, values });
    assert.deepEqual(ops(carried(of(["a", "b", "c"]), of(["a", "c"])).diff), ["removeEnumValue"]);
    assert.deepEqual(ops(carried(of(["a", "b", "c"]), of(["c", "a", "b"])).diff), ["replaceEnumValues"]);
    assert.deepEqual(ops(carried(of(["a", "b", "c", "d"]), of(["new", "d", "a", "other"])).diff), ["replaceEnumValues"]);
    assert.deepEqual(ops(carried(of(["a", "b", "c"]), of(["x", "a", "y", "c", "z"])).diff), ["addEnumValue", "addEnumValue", "addEnumValue", "removeEnumValue"]);
  });

  test("a renamed value: a default that is the value follows, and the type records the rename", () => {
    const of = (values: string[], value: string, renames: EnumType["valueRenames"]): DatabaseSchema =>
      withType({ ...status, values, ...(renames !== undefined && { valueRenames: renames }) }, [statusColumn("state", "status", { default: value, enum: { name: "status", values } }), column("note", TEXT, { default: value })]);
    const { diff, result } = carried(of(["draft", "live"], "live", undefined), of(["draft", "public"], "public", [renamed("live", "public")]));
    assert.deepEqual(ops(diff), ["renameEnumValue", "setDefault"]);
    assert.deepEqual([columnOf(result, "posts", "state").default, result.types.enums[0]?.valueRenames], ["public", [renamed("live", "public")]]);
  });

  test("values that exchange their names, a type and a value renamed at once, and several things on one type", () => {
    const swapped = (values: string[], renames: EnumType["valueRenames"]): DatabaseSchema => withType({ ...status, values, ...(renames !== undefined && { valueRenames: renames }) }, [statusColumn("state", "status", { default: values[0], enum: { name: "status", values } })]);
    const exchange = carried(swapped(["a", "b", "c"], undefined), swapped(["b", "a", "c"], [renamed("a", "tmp", "0002_rename.sql", 1), renamed("b", "a", "0002_rename.sql", 2), renamed("tmp", "b", "0002_rename.sql", 3)]));
    assert.deepEqual(ops(exchange.diff), ["renameEnumValue", "renameEnumValue"]);
    assert.equal(columnOf(exchange.result, "posts", "state").default, "b");
    // The diff gives the renames value by value; the type records them in the order in which they happened.
    assert.deepEqual(exchange.result.types.enums[0]?.valueRenames, [renamed("a", "tmp", "0002_rename.sql", 1), renamed("b", "a", "0002_rename.sql", 2), renamed("tmp", "b", "0002_rename.sql", 3)]);

    const before = withType({ ...status, values: ["draft", "live", "old"] }, [statusColumn("state", "status", { default: "live", enum: { name: "status", values: ["draft", "live", "old"] } })]);
    const afterSchema = withType({ name: "post_status", values: ["idea", "draft", "public", "review"], ...tracked(["status", "post_status"]), valueRenames: [renamed("live", "public", "0002_rename.sql", 2)] }, [
      statusColumn("state", "post_status", { default: "review", enum: { name: "post_status", values: ["idea", "draft", "public", "review"] } }),
    ]);
    const { diff } = carried(before, afterSchema);
    assert.deepEqual(ops(diff), ["renameEnumType", "renameEnumValue", "addEnumValue", "addEnumValue", "setDefault", "removeEnumValue"]);
  });

  test("a default follows a renamed value on a column of the type, not on a column of arrays of it: as the diff reads defaults", () => {
    const of = (value: string, renames: EnumType["valueRenames"]): DatabaseSchema =>
      withType({ ...status, values: ["draft", value], ...(renames !== undefined && { valueRenames: renames }) }, [column("history", { type: "json", canonicalType: { kind: "array", element: { kind: "enum", name: "status" } }, declaredType: "status[]" }, { default: "live" })]);
    const { diff, result } = carried(of("live", undefined), of("public", [renamed("live", "public")]));
    assert.deepEqual(ops(diff), ["renameEnumValue"]);
    assert.equal(columnOf(result, "posts", "history").default, "live");
  });

  test("a type that only columns give is changed on every column that has it, and stays a type that only columns give", () => {
    const given = (values: string[]): DatabaseSchema => schema([table("a", [keyColumn("id"), column("s", { type: "text" }, { enum: { name: "status", values } })]), table("b", [keyColumn("id"), column("s", { type: "text" }, { enum: { name: "status", values } })])]);
    const { result } = carried(given(["draft"]), given(["draft", "live"]), { types: "declared" });
    assert.deepEqual([result.types.enums, columnOf(result, "a", "s").enum, columnOf(result, "b", "s").enum], [[], { name: "status", values: ["draft", "live"] }, { name: "status", values: ["draft", "live"] }]);
  });
});

describe("applyDiff: schemas that say less than a collector's: types that only columns give, keys without names", () => {
  /** What a database directory would store of a schema, read back: fails for a schema the storage refuses. */
  const stored = (value: DatabaseSchema): DatabaseSchema => readSchemaDocument(JSON.parse(JSON.stringify(toSchemaDocument(value.tables, value.types))), "the result");
  const givenBy = (name: string): ColumnSchema => column(name, { type: "text" }, { enum: { name: "status", values: ["draft", "live"] } });
  const arrays = (name: string): ColumnSchema => column(name, { type: "json", canonicalType: { kind: "array", element: { kind: "enum", name: "status" } }, declaredType: "status[]" });
  const listed: EnumType = { name: "status", values: ["draft", "live"] };

  test("a type that only columns give is still a type when the last column that gives it goes", () => {
    // The before side lists no types; the after side lists the type, and the diff has nothing to say of it.
    const before = schema([table("a", [keyColumn("id"), givenBy("s")]), table("b", [keyColumn("id"), givenBy("s")])]);
    const tableGone = carried(before, schema([table("b", [keyColumn("id")])], [listed]), { types: "declared" });
    assert.deepEqual(ops(tableGone.diff), ["dropColumn", "dropTable"]);
    assert.deepEqual(tableGone.result.types.enums, [listed]);
    // While a column still gives it, it stays a type that only columns give.
    const oneLeft = carried(before, schema([table("b", [keyColumn("id"), givenBy("s")])], [listed]), { types: "declared" });
    assert.deepEqual(oneLeft.result.types.enums, []);
    // The column takes another type instead of going.
    const retyped = carried(schema([table("a", [keyColumn("id"), givenBy("s")])]), schema([table("a", [keyColumn("id"), column("s", TEXT)])], [listed]), { types: "declared" });
    assert.deepEqual(retyped.result.types.enums, [listed]);
  });

  test("a column of arrays of a type that only columns gave: the result names a type it has, and can be stored", () => {
    const before = schema([table("a", [keyColumn("id"), givenBy("s")])]);
    const afterSchema = schema([table("a", [keyColumn("id"), arrays("history")])], [listed]);
    const { result } = carried(before, afterSchema);
    assert.deepEqual(result.types.enums, [listed]);
    assertSameSchema(stored(result), afterSchema);
  });

  test("a type that goes while a column of arrays of it stays as it was declared: the column no longer says what its type is", () => {
    // The after side has no canonical types and no type: its column is the same as far as it says, and the type is dropped.
    const before = schema([table("posts", [keyColumn("id"), arrays("tags")])], [listed]);
    const afterSchema = schema([table("posts", [keyColumn("id", { type: "integer", declaredType: "integer" }), column("tags", { type: "json", declaredType: "status[]" })])]);
    const { diff, result } = carried(before, afterSchema, { types: "declared" });
    assert.deepEqual(ops(diff), ["dropEnumType"]);
    assert.deepEqual([columnOf(result, "posts", "tags").canonicalType, columnOf(result, "posts", "tags").declaredType, columnOf(result, "posts", "id").canonicalType], [undefined, "status[]", { kind: "integer", bits: 32 }]);
    assertSameSchema(stored(result), afterSchema, { types: "declared" });
    // No database gets there: a column cannot be of a type that is gone. The plan says so.
    assert.throws(
      () => planMigration(before, diff),
      (error: unknown) => error instanceof MigrationPlanError && error.message === 'dropEnumType "status" cannot be carried out, at any point of the plan: the column "posts"."tags" is of this type.',
    );
  });

  test("a name that the diff gives to a constraint is taken from the constraint that had it, when the after side does not name that one", () => {
    // Before, the key is called "k". Afterwards the key has no name (only the columns' marks give it), and "k" is another constraint's.
    const named = (extra: Partial<TableSchema>): DatabaseSchema => schema([table("t", [column("id", INTEGER, { nullable: false, primary: true }), column("a"), column("b")], { primaryKey: { name: "k", columns: ["id"] }, ...extra })]);
    const unnamed = (extra: Partial<TableSchema>): DatabaseSchema => schema([table("t", [column("id", INTEGER, { nullable: false, primary: true }), column("a"), column("b")], extra)]);
    const cases: [string, DatabaseSchema, DatabaseSchema, string[]][] = [
      ["a constraint renamed to it", named({ uniques: [{ name: "u", columns: ["a"], origin: origin("u") }] }), unnamed({ uniques: [{ name: "k", columns: ["a"], ...tracked(["u", "k"]) }] }), ["renameConstraint"]],
      ["a unique constraint added under it", named({}), unnamed({ uniques: [{ name: "k", columns: ["a"] }] }), ["addUnique"]],
      ["a check added under it", named({}), unnamed({ checks: [{ name: "k", expression: "a > 0" }] }), ["addCheck"]],
      ["a foreign key added under it", named({}), unnamed({ foreignKeys: [{ name: "k", columns: ["a", "b"], references: { table: "t", columns: ["id", "a"] } }] }), ["addForeignKey"]],
    ];
    for (const [title, before, afterSchema, expected] of cases) {
      const { diff, result } = carried(before, afterSchema, { names: true });
      assert.deepEqual(ops(diff), expected, title);
      assert.equal(tableOf(result, "t").primaryKey?.name, undefined, title);
      assert.deepEqual(columnOf(result, "t", "id").primary, true, title);
      // A plan needs to know what the key is to be called: the after side does not say.
      assert.throws(
        () => planMigration(before, diff),
        (error: unknown) =>
          error instanceof MigrationPlanError &&
          error.message === 'Table "t": the name "k" is given to another constraint, and the primary key, which has it, is left without a name. A plan has to rename it, and nothing says to what: give it a name in the schema to arrive at.',
        title,
      );
    }
    // Names that go on from one constraint to the next, the last of them to one that is left without a name.
    const chain = carried(
      named({ uniques: [{ name: "u", columns: ["a"], origin: origin("u") }], checks: [{ name: "c", expression: "a > 0", origin: origin("c") }] }),
      unnamed({ uniques: [{ name: "k", columns: ["a"], ...tracked(["u", "k"]) }], checks: [{ name: "u", expression: "a > 0", ...tracked(["c", "u"]) }] }),
      { names: true },
    );
    assert.deepEqual(ops(chain.diff), ["renameConstraint", "renameConstraint"]);
    assert.deepEqual([tableOf(chain.result, "t").primaryKey?.name, tableOf(chain.result, "t").uniques?.[0]?.name, tableOf(chain.result, "t").checks?.[0]?.name], [undefined, "k", "u"]);
    // Only a constraint that the diff says nothing of gives its name up. A name that the diff itself gives twice is had twice, as the schema it describes has it (a schema file may; a plan may not).
    const twice = carried(
      named({ uniques: [{ name: "u", columns: ["a"], origin: origin("u") }] }),
      unnamed({ uniques: [{ name: "k", columns: ["a"], ...tracked(["u", "k"]) }], checks: [{ name: "k", expression: "a > 0" }], foreignKeys: [{ name: "k", columns: ["a", "b"], references: { table: "t", columns: ["id", "a"] } }] }),
      { names: true },
    );
    assert.deepEqual(ops(twice.diff), ["renameConstraint", "addCheck", "addForeignKey"]);
    assert.deepEqual(
      [tableOf(twice.result, "t").primaryKey?.name, tableOf(twice.result, "t").uniques?.[0]?.name, tableOf(twice.result, "t").checks?.[0]?.name, tableOf(twice.result, "t").foreignKeys?.[0]?.name],
      [undefined, "k", "k", "k"],
    );
    // The other way round: a unique constraint keeps a name that the key is given.
    const keyNamed = carried(schema([table("t", [column("id", INTEGER, { nullable: false }), column("a")], { uniques: [{ name: "k", columns: ["a"] }] })]), schema([table("t", [column("id", INTEGER, { nullable: false, primary: true }), column("a")], { primaryKey: { name: "k", columns: ["id"] }, uniques: [{ columns: ["a"] }] })]));
    assert.deepEqual([tableOf(keyNamed.result, "t").primaryKey?.name, tableOf(keyNamed.result, "t").uniques], ["k", [{ columns: ["a"] }]]);
  });

  test("a key that only the columns' marks give is the same key whatever order the table lists its columns in", () => {
    const of = (names: string[], keyed: boolean): DatabaseSchema => schema([table("t", names.map((name) => column(name, INTEGER, { nullable: false, primary: keyed && name !== "c" })))]);
    const diff = diffSchemas(of(["a", "b", "c"], true), of(["a", "b", "c"], false));
    assert.deepEqual(ops(diff), ["dropPrimaryKey"]);
    assertSameSchema(applyDiff(of(["b", "c", "a"], true), diff), of(["a", "b", "c"], false));
  });

  test("what a change says a default was is compared as the diff compares defaults: a computed one by what it computes", () => {
    const of = (expression: string | undefined, nullable: boolean): DatabaseSchema => schema([table("t", [keyColumn("id"), column("at", TIMESTAMPTZ, { nullable, ...(expression !== undefined && { defaultFunction: "current_timestamp" as const, defaultExpression: expression }) })])]);
    const diff = diffSchemas(of("now()", true), of(undefined, true));
    assert.deepEqual(ops(diff), ["dropDefault"]);
    // The same schema from a source that wrote the default another way.
    assertSameSchema(applyDiff(of("CURRENT_TIMESTAMP", true), diff), of(undefined, true));
  });

  test("what a change says an expression was is compared as the diff compares expressions: apart from its layout", () => {
    const of = (check: string, where: string, expression: string, fallback: string | undefined): DatabaseSchema =>
      schema([table("t", [keyColumn("id"), column("n", INTEGER, { ...(fallback !== undefined && { defaultExpression: fallback }) })], { checks: fallback === undefined ? [] : [{ name: "c", expression: check }], indexes: fallback === undefined ? [] : [{ name: "i", columns: ["n"], expressions: [expression], where }] })]);
    const before = of("n > 0", "n is not null", "lower(x)", "f(1, 2)");
    const otherLayout = of("  n   >\n 0 ", "n  is\tnot null", "lower(x)  ", " f(1,   2)");
    const bare = of("", "", "", undefined);
    const diff = diffSchemas(before, bare);
    assert.deepEqual(ops(diff), ["dropCheck", "dropIndex", "dropDefault"]);
    // The diff takes the two for the same schema, so what it says of one fits the other.
    assert.deepEqual(diffSchemas(before, otherLayout).changes, []);
    assertSameSchema(applyDiff(otherLayout, diff), bare);
    // Within a quoted text a space is part of what is said: there the two differ, for the diff and here.
    const quoted = (text: string): DatabaseSchema => schema([table("t", [keyColumn("id"), column("note")], { checks: [{ name: "c", expression: text }] })]);
    assert.deepEqual(ops(diffSchemas(quoted("note <> 'a b'"), quoted("note <> 'a  b'"))), ["dropCheck", "addCheck"]);
    assert.throws(() => applyDiff(quoted("note <> 'a  b'"), diffSchemas(quoted("note <> 'a b'"), schema([table("t", [keyColumn("id"), column("note")])]))), /^DiffApplicationError: dropCheck "c" of table "t": the check is not what the change says it was\./);
  });

  test("of two constraints or indexes of one name, which a schema file may have, the one a change describes is the one it means", () => {
    const of = (uniques: TableSchema["uniques"], indexes: TableSchema["indexes"]): DatabaseSchema => schema([table("t", [keyColumn("id"), column("a"), column("b")], { uniques, indexes })]);
    const twice = [{ name: "same", columns: ["a"] }, { name: "same", columns: ["b"] }];
    for (const order of [twice, [...twice].reverse()]) {
      const { result } = carried(of(order, order), of([twice[0] as { name: string; columns: string[] }], [twice[0] as { name: string; columns: string[] }]));
      assert.deepEqual([tableOf(result, "t").uniques, tableOf(result, "t").indexes], [[{ name: "same", columns: ["a"] }], [{ name: "same", columns: ["a"] }]]);
    }
  });
});

describe("applyDiff: a schema and what it became, with most kinds of change at once", () => {
  test("the example of the diff's own tests", () => {
    const { diff } = carried(exampleBefore(), exampleAfter());
    assert.equal(diff.changes.length, 29);
    carried(exampleAfter(), exampleBefore());
    carried(schema([]), exampleAfter());
    carried(exampleBefore(), schema([]));
  });
});

describe("applyDiff: what the result keeps of where things come from", () => {
  test("what the diff does not touch is the same object's copy, with all it had", () => {
    const untouched = table("kept", [keyColumn("id", INTEGER, { key: "identifier", sourceDialectType: { dialect: "postgresql", type: "int4" }, origin: origin("id"), renames: [renamed("key", "id")] })], {
      origin: origin("kept"),
      primaryKey: { name: "kept_pkey", columns: ["id"], origin: origin("kept_pkey") },
      // Lists that are there and empty stay there and empty.
      uniques: [],
      indexes: [],
    });
    const type: EnumType = { name: "mood", values: ["ok"], origin: origin("mood"), sourceDialectType: { dialect: "postgresql", type: "mood" }, valueRenames: [renamed("fine", "ok")] };
    const { result } = carried(schema([untouched, table("gone", [keyColumn("id")])], [type]), schema([untouched], [type]));
    assert.deepEqual(result, schema([untouched], [type]));
  });

  test("a renamed object has the renames the diff gives as evidence added to its own, so that a later diff still knows it", () => {
    const at = (names: string[]): DatabaseSchema => schema([table(names.at(-1) as string, [keyColumn("id"), column(`c_${names.at(-1)}`, INTEGER, { ...tracked(names.map((name) => `c_${name}`)) })], { ...tracked(names) })]);
    const first = carried(at(["a"]), at(["a", "b"]));
    assert.deepEqual(tableOf(first.result, "b").renames, [renamed("a", "b", "0002_rename.sql", 1)]);
    assert.deepEqual(columnOf(first.result, "b", "c_b").renames, [renamed("c_a", "c_b", "0002_rename.sql", 1)]);
    // From the result to a later state: still a rename, not a drop and an add.
    assert.deepEqual(ops(diffSchemas(first.result, at(["a", "b", "c"]))), ["renameTable", "renameColumn"]);
    assert.deepEqual(first.result, at(["a", "b"]));
  });

  test("what is added has the origin the diff states for it", () => {
    const added = table("new", [keyColumn("id", INTEGER, { origin: origin("id", "0002_add.sql", 1) })], { origin: origin("new", "0002_add.sql", 1), primaryKey: { name: "new_pkey", columns: ["id"], origin: origin("new_pkey", "0002_add.sql", 1) } });
    const { result } = carried(schema([]), schema([added]));
    assert.deepEqual([tableOf(result, "new").origin, columnOf(result, "new", "id").origin, tableOf(result, "new").primaryKey?.origin], [origin("new", "0002_add.sql", 1), origin("id", "0002_add.sql", 1), origin("new_pkey", "0002_add.sql", 1)]);
  });

  test("an enumerated type that is added, or gets values added, says nothing of where it comes from: the diff does not carry all of its history", () => {
    /*
     * The type was created with the values a and b, which then exchanged
     * their names. The diff says that the type is added, with its origin and
     * the values it has now, and nothing of the exchange. With that origin
     * and no history, the result would be taken for the type before the
     * exchange, and a diff with the after side would report the exchange as
     * something still to do.
     */
    const exchanged: EnumType = { name: "mood", values: ["b", "a"], origin: origin("mood"), valueRenames: [renamed("a", "tmp", "0001_init.sql", 2), renamed("b", "a", "0001_init.sql", 3), renamed("tmp", "b", "0001_init.sql", 4)] };
    const afterSchema = schema([], [exchanged]);
    const { result } = carried(schema([]), afterSchema);
    assert.deepEqual(result.types.enums, [{ name: "mood", values: ["b", "a"] }]);
    assert.deepEqual(diffSchemas(result, afterSchema).changes, []);
    assert.deepEqual(ops(diffSchemas({ tables: [], types: { enums: [{ name: "mood", values: ["b", "a"], origin: origin("mood") }] } }, afterSchema)), ["renameEnumValue", "renameEnumValue", "replaceEnumValues"]);
    // The same for a type that is there and gets a value: where the value's name comes from is not in the diff.
    const grown = carried(schema([], [status]), schema([], [{ ...status, values: ["draft", "live", "archived"] }]));
    assert.deepEqual(grown.result.types.enums, [{ name: "status", values: ["draft", "live", "archived"] }]);
    // A type whose values the diff only renames, removes, or leaves keeps what it had.
    const kept = carried(schema([], [{ ...status, values: ["draft", "live", "old"] }]), schema([], [{ ...status, values: ["draft", "public"], valueRenames: [renamed("live", "public")] }]));
    assert.deepEqual(kept.result.types.enums, [{ ...status, values: ["draft", "public"], valueRenames: [renamed("live", "public")] }]);
  });

  test("a diff that renames nothing fits the same schema from another source: where a thing comes from is not what it was", () => {
    const before = schema([table("t", [keyColumn("id", INTEGER, { origin: origin("id") }), column("gone", TEXT, { origin: origin("gone") })], { origin: origin("t"), checks: [{ name: "c", expression: "id > 0", origin: origin("c") }] }), table("old", [keyColumn("id", INTEGER, { origin: origin("id") })], { origin: origin("old") })]);
    const afterSchema = schema([table("t", [keyColumn("id", INTEGER, { origin: origin("id") })], { origin: origin("t") })]);
    const diff = diffSchemas(before, afterSchema);
    assert.deepEqual(ops(diff), ["dropCheck", "dropColumn", "dropTable"]);
    const elsewhere = JSON.parse(JSON.stringify(before, (key, inner: unknown) => (key === "origin" ? { ...(inner as object), file: "squashed.sql", sha256: "another" } : inner))) as DatabaseSchema;
    assertSameSchema(applyDiff(elsewhere, diff), afterSchema);
    assertSameSchema(applyDiff(JSON.parse(JSON.stringify(before, (key, inner: unknown) => (key === "origin" ? undefined : inner))) as DatabaseSchema, diff), afterSchema);
  });

  test("where things come from never decides anything: a schema without any of it is changed the same way", () => {
    const strip = (value: DatabaseSchema): DatabaseSchema => JSON.parse(JSON.stringify(value, (key, inner: unknown) => (key === "origin" || key === "renames" || key === "valueRenames" ? undefined : inner))) as DatabaseSchema;
    // Without origins nothing is a rename, so the diff is another one; applied, it gives the same schema.
    carried(strip(exampleBefore()), strip(exampleAfter()));
    carried(strip(exampleBefore()), exampleAfter());
  });
});

describe("applyDiff: the same result whatever order things are listed in", () => {
  const reversed = (value: DatabaseSchema): DatabaseSchema => ({
    tables: [...value.tables].reverse().map((entry) => ({
      ...entry,
      ...(entry.uniques !== undefined && { uniques: [...entry.uniques].reverse() }),
      ...(entry.checks !== undefined && { checks: [...entry.checks].reverse() }),
      ...(entry.indexes !== undefined && { indexes: [...entry.indexes].reverse() }),
      ...(entry.foreignKeys !== undefined && { foreignKeys: [...entry.foreignKeys].reverse() }),
    })),
    types: { enums: [...value.types.enums].reverse() },
  });

  test("the changes of a diff in another order give the same schema, to the byte", () => {
    const diff = diffSchemas(exampleBefore(), exampleAfter());
    const expected = applyDiff(exampleBefore(), diff);
    assert.deepEqual(applyDiff(exampleBefore(), diff), expected);
    assert.deepEqual(applyDiff(exampleBefore(), { ...diff, changes: [...diff.changes].reverse() }), expected);
    const rotated = [...diff.changes.slice(11), ...diff.changes.slice(0, 11)];
    assert.deepEqual(applyDiff(exampleBefore(), { ...diff, changes: rotated }), expected);
  });

  test("a schema that lists its tables, constraints, indexes, and types in another order gives a schema that means the same", () => {
    const diff = diffSchemas(exampleBefore(), exampleAfter());
    assertSameSchema(applyDiff(reversed(exampleBefore()), diff), exampleAfter());
  });
});

describe("applyDiff: a diff that does not fit the schema is refused", () => {
  const users = (): TableSchema =>
    table("users", [keyColumn("id"), column("name", TEXT, { origin: origin("name") }), column("age", INTEGER, { default: 18 }), statusColumn("state")], {
      origin: origin("users"),
      primaryKey: { name: "users_pkey", columns: ["id"] },
      uniques: [{ name: "users_name_key", columns: ["name"] }],
      indexes: [{ name: "users_age_idx", columns: ["age"] }],
      // As a collector gives it: with what its text names. (A check of which nothing says what it names, nor where it comes from, is not followed through a rename.)
      checks: [{ name: "users_age_check", expression: "age > 0", names: [{ kind: "column", name: "age" }] }],
    });
  const base = (): DatabaseSchema => schema([users()], [status]);
  const refused = (target: DatabaseSchema, changes: SchemaChange[], message: RegExp): void => {
    assert.throws(
      () => applyDiff(target, { diffVersion: 1, changes }),
      (error: unknown) => error instanceof DiffApplicationError && message.test(error.message),
      String(message),
    );
  };
  /** The changes that turn `base()` into another schema. */
  const toward = (afterSchema: DatabaseSchema): SchemaChange[] => diffSchemas(base(), afterSchema).changes;

  test("a diff of another version, and a change of a kind that is not known", () => {
    assert.throws(() => applyDiff(base(), { diffVersion: 2, changes: [] } as unknown as SchemaDiff), (error: unknown) => error instanceof DiffApplicationError && /^This is a schema diff of version 2; version 1 is the one that can be applied\.$/.test(error.message));
    refused(base(), [{ op: "truncateTable", table: "users" } as unknown as SchemaChange], /^truncateTable: this kind of change is not known\.$/);
  });

  test("what is dropped, renamed, or changed must be there", () => {
    const empty = schema([table("other", [keyColumn("id")])]);
    refused(empty, toward(schema([], [status])), /^dropTable "users": there is no table "users"\.$/);
    const without = (drop: (entry: TableSchema) => void): DatabaseSchema => {
      const entry = users();
      drop(entry);
      return schema([entry], [status]);
    };
    const bare = without((entry) => {
      entry.columns = entry.columns.filter((candidate) => candidate.name === "id");
      delete entry.uniques;
      delete entry.indexes;
      delete entry.checks;
      delete entry.primaryKey;
      (entry.columns[0] as ColumnSchema).primary = false;
    });
    refused(bare, toward(without((entry) => (entry.columns = entry.columns.filter((candidate) => candidate.name !== "age" || delete entry.indexes)))), /^dropIndex "users_age_idx" of table "users": table "users" has no index "users_age_idx"\.$/);
    refused(bare, toward(without((entry) => delete entry.uniques)), /^dropUnique "users_name_key" of table "users": table "users" has no unique constraint "users_name_key"\.$/);
    refused(bare, toward(without((entry) => delete entry.checks)), /^dropCheck "users_age_check" of table "users": table "users" has no check "users_age_check"\.$/);
    refused(bare, toward(without((entry) => ((entry.columns[3] as ColumnSchema).nullable = false))), /^setNotNull "users"\."state": table "users" has no column "state"\.$/);
    refused(bare, [{ op: "dropPrimaryKey", table: "users", constraint: "users_pkey", before: { name: "users_pkey", columns: ["id"] } }], /^dropPrimaryKey "users_pkey" of table "users": table "users" has no primary key\.$/);
    refused(empty, [{ op: "addEnumValue", enum: "status", value: "x" }], /^addEnumValue "x" of enumerated type "status": there is no enumerated type "status"\.$/);
    refused(base(), [{ op: "removeEnumValue", enum: "status", value: "x" }], /^removeEnumValue "x" of enumerated type "status": the type has no value "x"\.$/);
    refused(base(), [{ op: "addEnumValue", enum: "status", value: "x", afterValue: "nowhere" }], /^addEnumValue "x" of enumerated type "status": the type has no value "nowhere" to put it after\.$/);
  });

  test("what is added must not be there already", () => {
    refused(base(), diffSchemas(schema([], [status]), base()).changes, /^addTable "users": there is a table "users" already\.$/);
    refused(base(), [{ op: "addColumn", table: "users", column: "age", after: { name: "age", type: { storage: "integer" }, nullable: true } }], /^addColumn "users"\."age": table "users" has a column "age" already\.$/);
    refused(base(), [{ op: "addEnumType", enum: "status", after: { name: "status", values: [] } }], /^addEnumType "status": there is an enumerated type "status" already\.$/);
    refused(base(), [{ op: "addEnumValue", enum: "status", value: "live" }], /^addEnumValue "live" of enumerated type "status": the type has the value "live" already\.$/);
    refused(base(), [{ op: "addPrimaryKey", table: "users", after: { columns: ["age"] } }], /^addPrimaryKey of table "users": table "users" has a primary key already\.$/);
    refused(base(), [{ op: "addIndex", table: "users", index: "users_age_idx", after: { name: "users_age_idx", columns: ["name"], unique: false } }], /^addIndex "users_age_idx" of table "users": table "users" has an index "users_age_idx" already\.$/);
    refused(base(), [{ op: "addUnique", table: "users", constraint: "u", after: { name: "u", columns: ["nope"] } }], /^addUnique "u" of table "users": table "users" has no column "nope"\.$/);
  });

  test("a rename needs the object it was found for: the one with the origin the diff gives as evidence", () => {
    const renamedName = (): DatabaseSchema => schema([{ ...users(), columns: users().columns.map((entry) => (entry.name === "name" ? { ...entry, name: "full_name", renames: [renamed("name", "full_name")] } : entry)), uniques: [{ name: "users_name_key", columns: ["full_name"] }] }], [status]);
    const changes = toward(renamedName());
    assert.deepEqual(changes.map((change) => change.op), ["renameColumn"]);
    const recreated = schema([{ ...users(), columns: users().columns.map((entry) => (entry.name === "name" ? { ...entry, origin: origin("name", "0003_again.sql", 4) } : entry)) }], [status]);
    refused(recreated, changes, /^renameColumn "users"\."name" to "full_name": the column "users"\."name" is not the one the change renames: it was created by statement 4 of 0003_again\.sql as "name", and the change renames what statement 1 of 0001_init\.sql created as "name"\.$/);
    const unknown = schema([{ ...users(), columns: users().columns.map(({ origin: _origin, ...entry }) => entry) }], [status]);
    refused(unknown, changes, /^renameColumn "users"\."name" to "full_name": the column "users"\."name" does not say where it comes from, so it cannot be told to be the one the change renames\.$/);
    refused(renamedName(), changes, /^renameColumn "users"\."name" to "full_name": table "users" has no column "name"\.$/);
    const taken = schema([{ ...users(), columns: [...users().columns, column("full_name")] }], [status]);
    refused(taken, changes, /^renameColumn "users"\."name" to "full_name": table "users" has a column "full_name" already\.$/);
  });

  test("what the change says a thing was must be what the schema has", () => {
    const other = (change: (entry: TableSchema) => void): DatabaseSchema => {
      const entry = users();
      change(entry);
      return schema([entry], [status]);
    };
    const ageBigint = other((entry) => (entry.columns[2] = column("age", BIGINT, { default: 18 })));
    refused(ageBigint, toward(other((entry) => (entry.columns[2] = column("age", TEXT, { default: 18 })))), /^alterColumnType "users"\."age": the column's type is not what the change says it was\. The schema has \{"canonical":"integer\(64\)"\}; the change says \{"canonical":"integer\(32\)"\}\.$/);
    refused(ageBigint, toward(other((entry) => entry.columns.splice(2, 1) && delete entry.indexes && delete entry.checks)), /^dropColumn "users"\."age": the column is not what the change says it was\./);
    const ageNoDefault = other((entry) => (entry.columns[2] = column("age")));
    refused(ageNoDefault, toward(other((entry) => (entry.columns[2] = column("age")))), /^dropDefault "users"\."age": the column's default is not what the change says it was\. The schema has none; the change says \{"kind":"value","value":18\}\.$/);
    refused(ageNoDefault, toward(other((entry) => (entry.columns[2] = column("age", INTEGER, { default: 21 })))), /^setDefault "users"\."age": the column's default is not what the change says it was\. The schema has none; the change says \{"kind":"value","value":18\}\.$/);
    refused(other((entry) => (entry.uniques = [{ name: "users_name_key", columns: ["name", "age"] }])), toward(other((entry) => delete entry.uniques)), /^dropUnique "users_name_key" of table "users": the unique constraint is not what the change says it was\./);
    refused(other((entry) => (entry.columns[1] = column("name", TEXT, { nullable: false, origin: origin("name") }))), toward(other((entry) => (entry.columns[1] = column("name", TEXT, { nullable: false, origin: origin("name") })))), /^setNotNull "users"\."name": the column is not null already\.$/);
    refused(schema([users()], [{ ...status, values: ["live", "draft"] }]), [{ op: "replaceEnumValues", enum: "status", before: ["draft", "live"], after: ["live", "draft"] }], /^replaceEnumValues of enumerated type "status": the type's values are not what the change says they were\. The schema has \["live","draft"\]; the change says \["draft","live"\]\.$/);
  });

  test("what is no diff, and what is no change, is said to be none", () => {
    const of = (diff: unknown): (() => unknown) => () => applyDiff(base(), diff as SchemaDiff);
    assert.throws(of({ diffVersion: 1 }), /^DiffApplicationError: This schema diff has no list of changes.$/);
    assert.throws(of({ diffVersion: 1, changes: "none" }), /^DiffApplicationError: This schema diff has no list of changes.$/);
    assert.throws(of({ diffVersion: 1, changes: [null] }), /^DiffApplicationError: Change 1 of the diff is not a change.$/);
    assert.throws(of({ diffVersion: 1, changes: [{ op: "dropTable", table: "posts", before: { name: "posts", columns: [], uniques: [], checks: [] } }, "x"] }), /^DiffApplicationError: Change 2 of the diff is not a change.$/);
    assert.throws(of(null), /^DiffApplicationError: This is not a schema diff.$/);
  });

  test("a change that says two things, or is not all there", () => {
    const state = { name: "v", columns: [{ name: "id", type: { storage: "integer" as const }, nullable: false }], uniques: [], checks: [] };
    refused(base(), [{ op: "addTable", table: "u", after: state }], /^addTable "u": the change is of "u", and what it describes is called "v"\.$/);
    refused(base(), [{ op: "addColumn", table: "users", column: "b", after: { name: "c", type: { storage: "integer" }, nullable: true } }], /^addColumn "users"\."b": the change is of "b", and what it describes is called "c"\.$/);
    refused(base(), [{ op: "addIndex", table: "users", index: "i", after: { name: "j", columns: ["id"], unique: false } }], /^addIndex "i" of table "users": the change is of "i", and what it describes is called "j"\.$/);
    refused(base(), [{ op: "addUnique", table: "users", constraint: "u1", after: { name: "u2", columns: ["id"] } }], /^addUnique "u1" of table "users": the change is of "u1", and what it describes is called "u2"\.$/);
    refused(base(), [{ op: "addUnique", table: "users", after: { name: "u2", columns: ["id"] } }], /^addUnique of table "users": the change names no constraint, and what it describes is called "u2"\.$/);
    refused(base(), [{ op: "addEnumType", enum: "mood", after: { name: "feeling", values: [] } }], /^addEnumType "mood": the change is of "mood", and what it describes is called "feeling"\.$/);
    // A table is added with its own columns, keys, and checks; its foreign keys and indexes are changes of their own.
    refused(base(), [{ op: "addTable", table: "v", after: { ...state, primaryKey: { columns: ["nope"] } } }], /^addTable "v": its primary key is over the column "nope", which it does not have\.$/);
    refused(base(), [{ op: "addTable", table: "v", after: { ...state, uniques: [{ name: "v_key", columns: ["id", "nope"] }] } }], /^addTable "v": its unique constraint "v_key" is over the column "nope", which it does not have\.$/);
    refused(base(), [{ op: "addTable", table: "v", after: { ...state, indexes: [{ name: "v_idx", columns: ["id"], unique: false }] } }], /^addTable "v": an added table's indexes are changes of their own; this one lists 1\.$/);
    refused(base(), [{ op: "addTable", table: "v", after: { ...state, foreignKeys: [{ columns: ["id"], references: { table: "users", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" }] } }], /^addTable "v": an added table's foreign keys are changes of their own; this one lists 1\.$/);
    // What is missing from a change is said, not stumbled over.
    refused(base(), [{ op: "addTable", table: "v" } as unknown as SchemaChange], /^addTable "v": the change has no "after"\.$/);
    refused(base(), [{ op: "addColumn", table: "users", column: "x", after: { name: "x", nullable: true } } as unknown as SchemaChange], /^addColumn "users"\."x": "after" has no "type"\.$/);
    refused(base(), [{ op: "dropColumn", table: "users" } as unknown as SchemaChange], /^dropColumn "users"\.<none>: the change has no "column"\.$/);
    refused(base(), [{ op: "addForeignKey", table: "users", after: { columns: ["id"], onDelete: "NO ACTION", onUpdate: "NO ACTION" } } as unknown as SchemaChange], /^addForeignKey of table "users": "after" has no "references"\.$/);
    refused(base(), [{ op: "renameColumn", table: "users", column: "label" } as unknown as SchemaChange], /^renameColumn "users"\.<none> to "label": the change has no "from"\.$/);
  });

  test("a diff whose changes do not go together", () => {
    // A column goes while a key that the diff leaves alone is over it.
    refused(base(), [{ op: "dropColumn", table: "users", column: "name", before: { name: "name", type: { storage: "text", canonical: { kind: "text" }, declared: "text" }, nullable: true, origin: origin("name") } }], /^The diff leaves a schema that does not hold together: the unique constraint "users_name_key" of table "users" is over the column "name", which the table does not have\.$/);
    // A type goes while a column still has it.
    refused(base(), [{ op: "dropEnumType", enum: "status", before: { name: "status", values: ["draft", "live"], origin: origin("status") } }], /^The diff leaves a schema that does not hold together: the column "users"\."state" is of the enumerated type "status", which the schema does not have\.$/);
    // Two columns are given one name.
    const both = base();
    (both.tables[0] as TableSchema).columns.push(column("nick", TEXT, { origin: origin("nick") }));
    const evidence = (name: string): { origin: ReturnType<typeof origin>; renames: ReturnType<typeof renamed>[] } => ({ origin: origin(name), renames: [renamed(name, "label")] });
    refused(
      both,
      [
        { op: "renameColumn", table: "users", column: "label", from: "name", evidence: evidence("name") },
        { op: "renameColumn", table: "users", column: "label", from: "nick", evidence: evidence("nick") },
      ],
      /^renameColumn "users"\."nick" to "label": another change gives the name "label" to another column of table "users"\.$/,
    );
    // A column is renamed in a table by a name that no table has afterwards: the table that had it is renamed away.
    const moved = schema([{ ...users(), origin: origin("users") }], [status]);
    refused(
      moved,
      [
        { op: "renameTable", table: "accounts", from: "users", evidence: { origin: origin("users"), renames: [renamed("users", "accounts")] } },
        { op: "renameColumn", table: "users", column: "label", from: "name", evidence: evidence("name") },
      ],
      /^renameColumn "users"\."name" to "label": there is no table "users"\.$/,
    );
    // One object is renamed twice.
    refused(
      base(),
      [
        { op: "renameColumn", table: "users", column: "label", from: "name", evidence: evidence("name") },
        { op: "renameColumn", table: "users", column: "title", from: "name", evidence: { origin: origin("name"), renames: [renamed("name", "title")] } },
      ],
      /^renameColumn "users"\."name" to "title": another change renames the column "users"\."name" as well\.$/,
    );
  });
});

describe("applyDiff: every kind of change", () => {

  test("is applied by some test of this file", () => {
    assert.deepEqual(
      CHANGE_ORDER.filter((op) => !applied.has(op)),
      [],
    );
  });
});
