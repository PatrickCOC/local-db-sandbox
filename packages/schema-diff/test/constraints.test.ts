import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ColumnSchema, DatabaseSchema, PrimaryKeyConstraint, TableSchema } from "../../runtime/src/index.ts";
import { INTEGER, changes, column, keyColumn, ops, origin, renamed, schema, table } from "./support.ts";

const parents = table("parents", [keyColumn("id")], { primaryKey: { name: "parents_pkey", columns: ["id"] } });
const pairs = table("pairs", [keyColumn("x"), keyColumn("y")], { primaryKey: { name: "pairs_pkey", columns: ["x", "y"] } });

/** The evidence of a rename from `from` to `to`, as the tests record renames. */
const evidence = (from: string, to: string): unknown => ({ origin: origin(from), renames: [renamed(from, to)] });
/** The provenance of an object created as `from` and since renamed to `to`. */
const was = (from: string, to: string): { origin: ReturnType<typeof origin>; renames: ReturnType<typeof renamed>[] } => ({ origin: origin(from), renames: [renamed(from, to)] });

describe("schema diff: primary keys", () => {
  /** A table `t` with the columns a, b, c, none nullable, and the given key. */
  function keyed(primaryKey: PrimaryKeyConstraint | undefined, flagged: string[] = primaryKey?.columns ?? []): DatabaseSchema {
    const columns = ["a", "b", "c"].map((name) => column(name, INTEGER, { nullable: false, primary: flagged.includes(name) }));
    return schema([table("t", columns, primaryKey === undefined ? {} : { primaryKey })]);
  }

  test("a key is added and dropped", () => {
    const key = { name: "t_pkey", columns: ["a"] };
    assert.deepEqual(changes(keyed(undefined), keyed(key)), [{ op: "addPrimaryKey", table: "t", constraint: "t_pkey", after: key }]);
    assert.deepEqual(changes(keyed(key), keyed(undefined)), [{ op: "dropPrimaryKey", table: "t", constraint: "t_pkey", before: key }]);
  });

  test("a key over several columns is added with its columns in the key's order", () => {
    const key = { name: "t_pkey", columns: ["c", "a"] };
    assert.deepEqual(changes(keyed(undefined), keyed(key)), [{ op: "addPrimaryKey", table: "t", constraint: "t_pkey", after: key }]);
  });

  test("a key with other columns, or the same columns in another order, is dropped and added", () => {
    const one = { name: "t_pkey", columns: ["a"] };
    const two = { name: "t_pkey", columns: ["a", "b"] };
    const reversed = { name: "t_pkey", columns: ["b", "a"] };
    assert.deepEqual(changes(keyed(one), keyed(two)), [
      { op: "dropPrimaryKey", table: "t", constraint: "t_pkey", before: one },
      { op: "addPrimaryKey", table: "t", constraint: "t_pkey", after: two },
    ]);
    assert.deepEqual(changes(keyed(two), keyed(reversed)), [
      { op: "dropPrimaryKey", table: "t", constraint: "t_pkey", before: two },
      { op: "addPrimaryKey", table: "t", constraint: "t_pkey", after: reversed },
    ]);
    assert.deepEqual(changes(keyed(two), keyed(two)), []);
  });

  test("a key with a recorded rename is renamed; another name without one is a drop and an add", () => {
    const before = { name: "t_pkey", columns: ["a", "b"], origin: origin("t_pkey") };
    const after = { name: "t_key", columns: ["a", "b"], ...was("t_pkey", "t_key") };
    assert.deepEqual(changes(keyed(before), keyed(after)), [{ op: "renameConstraint", table: "t", kind: "primaryKey", constraint: "t_key", from: "t_pkey", evidence: evidence("t_pkey", "t_key") }]);
    assert.deepEqual(ops(keyed({ name: "t_pkey", columns: ["a", "b"] }), keyed({ name: "t_key", columns: ["a", "b"] })), ["dropPrimaryKey", "addPrimaryKey"]);
    // Renamed, and over other columns: not the same key.
    assert.deepEqual(ops(keyed(before), keyed({ ...after, columns: ["a"] })), ["dropPrimaryKey", "addPrimaryKey"]);
  });

  test("a key known only from its columns (a schema without key constraints) is the key over those columns, in any order and under any name", () => {
    assert.deepEqual(changes(keyed(undefined, ["a", "b"]), keyed({ name: "t_pkey", columns: ["b", "a"] })), []);
    assert.deepEqual(changes(keyed({ name: "t_pkey", columns: ["b", "a"] }), keyed(undefined, ["a", "b"])), []);
    assert.deepEqual(changes(keyed(undefined, ["a", "b"]), keyed(undefined, ["a", "b"])), []);
    assert.deepEqual(changes(keyed(undefined, ["a"]), keyed({ name: "t_pkey", columns: ["a", "b"] })), [
      { op: "dropPrimaryKey", table: "t", before: { columns: ["a"] } },
      { op: "addPrimaryKey", table: "t", constraint: "t_pkey", after: { name: "t_pkey", columns: ["a", "b"] } },
    ]);
  });

  test("a column that becomes a key column is also made not null, before the key is added", () => {
    const before = schema([table("t", [column("a"), column("b")])]);
    const after = schema([table("t", [keyColumn("a"), column("b")], { primaryKey: { name: "t_pkey", columns: ["a"] } })]);
    assert.deepEqual(changes(before, after), [
      { op: "setNotNull", table: "t", column: "a" },
      { op: "addPrimaryKey", table: "t", constraint: "t_pkey", after: { name: "t_pkey", columns: ["a"] } },
    ]);
  });
});

/** A schema with the table `t` (columns id, a, b, c) and what else is given, and the tables it may refer to. */
function withTable(extra: Partial<TableSchema> = {}, columns: ColumnSchema[] = [keyColumn("id"), column("a"), column("b"), column("c")]): DatabaseSchema {
  return schema([parents, pairs, table("t", columns, extra)]);
}

describe("schema diff: unique constraints", () => {
  const unique = (name: string | undefined, ...columns: string[]): Partial<TableSchema> => ({ uniques: [{ ...(name !== undefined && { name }), columns }] });

  test("a unique constraint is added and dropped, over one column or several", () => {
    assert.deepEqual(changes(withTable(), withTable(unique("t_a_key", "a"))), [{ op: "addUnique", table: "t", constraint: "t_a_key", after: { name: "t_a_key", columns: ["a"] } }]);
    assert.deepEqual(changes(withTable(unique("t_a_b_key", "a", "b")), withTable()), [{ op: "dropUnique", table: "t", constraint: "t_a_b_key", before: { name: "t_a_b_key", columns: ["a", "b"] } }]);
  });

  test("a constraint over other columns, or the same columns in another order, is dropped and added", () => {
    assert.deepEqual(changes(withTable(unique("u", "a", "b")), withTable(unique("u", "b", "a"))), [
      { op: "dropUnique", table: "t", constraint: "u", before: { name: "u", columns: ["a", "b"] } },
      { op: "addUnique", table: "t", constraint: "u", after: { name: "u", columns: ["b", "a"] } },
    ]);
    assert.deepEqual(ops(withTable(unique("u", "a")), withTable(unique("u", "a", "b"))), ["dropUnique", "addUnique"]);
  });

  test("a constraint with a recorded rename is renamed; another name without one is a drop and an add", () => {
    const before = withTable({ uniques: [{ name: "t_a_key", columns: ["a"], origin: origin("t_a_key") }] });
    const after = withTable({ uniques: [{ name: "a_once", columns: ["a"], ...was("t_a_key", "a_once") }] });
    assert.deepEqual(changes(before, after), [{ op: "renameConstraint", table: "t", kind: "unique", constraint: "a_once", from: "t_a_key", evidence: evidence("t_a_key", "a_once") }]);
    assert.deepEqual(ops(withTable(unique("t_a_key", "a")), withTable(unique("a_once", "a"))), ["dropUnique", "addUnique"]);
  });

  test("a constraint without a name is the constraint over its columns", () => {
    assert.deepEqual(changes(withTable(unique(undefined, "a", "b")), withTable(unique("t_a_b_key", "a", "b"))), []);
    assert.deepEqual(changes(withTable(unique(undefined, "a", "b")), withTable(unique(undefined, "a", "b"))), []);
    assert.deepEqual(changes(withTable(unique(undefined, "a")), withTable(unique(undefined, "b"))), [
      { op: "dropUnique", table: "t", before: { columns: ["a"] } },
      { op: "addUnique", table: "t", after: { columns: ["b"] } },
    ]);
  });

  test("several constraints of one table: each is matched on its own", () => {
    const before = withTable({ uniques: [{ name: "t_a_key", columns: ["a"] }, { name: "t_b_key", columns: ["b"] }, { name: "t_c_key", columns: ["c"] }] });
    const after = withTable({ uniques: [{ name: "t_c_key", columns: ["c"] }, { name: "t_a_b_key", columns: ["a", "b"] }, { name: "t_a_key", columns: ["a"] }] });
    assert.deepEqual(changes(before, after), [
      { op: "dropUnique", table: "t", constraint: "t_b_key", before: { name: "t_b_key", columns: ["b"] } },
      { op: "addUnique", table: "t", constraint: "t_a_b_key", after: { name: "t_a_b_key", columns: ["a", "b"] } },
    ]);
  });
});

describe("schema diff: foreign keys", () => {
  const single = (references: ColumnSchema["references"]): ColumnSchema[] => [keyColumn("id"), column("a", INTEGER, references === undefined ? {} : { references }), column("b"), column("c")];
  const toParents = { table: "parents", column: "id", name: "t_a_fkey" };
  const toParentsState = { name: "t_a_fkey", columns: ["a"], references: { table: "parents", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" };
  const pair = { name: "t_pair_fkey", columns: ["a", "b"], references: { table: "pairs", columns: ["x", "y"] } };
  const pairState = { ...pair, onDelete: "NO ACTION", onUpdate: "NO ACTION" };

  test("a foreign key of one column is added and dropped", () => {
    assert.deepEqual(changes(withTable({}, single(undefined)), withTable({}, single(toParents))), [{ op: "addForeignKey", table: "t", constraint: "t_a_fkey", after: toParentsState }]);
    assert.deepEqual(changes(withTable({}, single(toParents)), withTable({}, single(undefined))), [{ op: "dropForeignKey", table: "t", constraint: "t_a_fkey", before: toParentsState }]);
  });

  test("a foreign key over several columns is added and dropped, with its columns and the columns it refers to in order", () => {
    assert.deepEqual(changes(withTable(), withTable({ foreignKeys: [pair] })), [{ op: "addForeignKey", table: "t", constraint: "t_pair_fkey", after: pairState }]);
    assert.deepEqual(changes(withTable({ foreignKeys: [pair] }), withTable()), [{ op: "dropForeignKey", table: "t", constraint: "t_pair_fkey", before: pairState }]);
    assert.deepEqual(changes(withTable({ foreignKeys: [pair] }), withTable({ foreignKeys: [pair] })), []);
  });

  test("a key that refers to other columns, or pairs its columns differently, is dropped and added", () => {
    const crossed = { ...pair, references: { table: "pairs", columns: ["y", "x"] } };
    assert.deepEqual(changes(withTable({ foreignKeys: [pair] }), withTable({ foreignKeys: [crossed] })), [
      { op: "dropForeignKey", table: "t", constraint: "t_pair_fkey", before: pairState },
      { op: "addForeignKey", table: "t", constraint: "t_pair_fkey", after: { ...pairState, references: { table: "pairs", columns: ["y", "x"] } } },
    ]);
    assert.deepEqual(ops(withTable({ foreignKeys: [pair] }), withTable({ foreignKeys: [{ ...pair, columns: ["b", "a"] }] })), ["dropForeignKey", "addForeignKey"]);
    assert.deepEqual(ops(withTable({}, single(toParents)), withTable({}, single({ ...toParents, table: "pairs", column: "x" }))), ["dropForeignKey", "addForeignKey"]);
  });

  test("another action on delete or on update is a dropped and an added key, each with its actions", () => {
    assert.deepEqual(changes(withTable({}, single({ ...toParents, onDelete: "CASCADE" })), withTable({}, single({ ...toParents, onDelete: "SET NULL" }))), [
      { op: "dropForeignKey", table: "t", constraint: "t_a_fkey", before: { ...toParentsState, onDelete: "CASCADE" } },
      { op: "addForeignKey", table: "t", constraint: "t_a_fkey", after: { ...toParentsState, onDelete: "SET NULL" } },
    ]);
    assert.deepEqual(changes(withTable({ foreignKeys: [pair] }), withTable({ foreignKeys: [{ ...pair, onUpdate: "CASCADE" }] })), [
      { op: "dropForeignKey", table: "t", constraint: "t_pair_fkey", before: pairState },
      { op: "addForeignKey", table: "t", constraint: "t_pair_fkey", after: { ...pairState, onUpdate: "CASCADE" } },
    ]);
    // RESTRICT is not NO ACTION.
    assert.deepEqual(ops(withTable({}, single(toParents)), withTable({}, single({ ...toParents, onDelete: "RESTRICT" }))), ["dropForeignKey", "addForeignKey"]);
  });

  test("no action is the action of a key that gives none, however it is written", () => {
    for (const action of ["NO ACTION", "no action", " No  Action "]) {
      assert.deepEqual(changes(withTable({}, single(toParents)), withTable({}, single({ ...toParents, onDelete: action, onUpdate: action }))), [], action);
    }
    assert.deepEqual(changes(withTable({}, single({ ...toParents, onDelete: "cascade" })), withTable({}, single({ ...toParents, onDelete: "CASCADE" }))), []);
  });

  test("a key of one column is the same key whether the schema keeps it with the column or with the table", () => {
    const withColumn = withTable({}, single({ ...toParents, onDelete: "CASCADE" }));
    const withTheTable = withTable({ foreignKeys: [{ name: "t_a_fkey", columns: ["a"], references: { table: "parents", columns: ["id"] }, onDelete: "CASCADE" }] });
    assert.deepEqual(changes(withColumn, withTheTable), []);
    assert.deepEqual(changes(withTheTable, withColumn), []);
  });

  test("a key with a recorded rename is renamed; a key without a name is the key of its definition", () => {
    const before = withTable({ foreignKeys: [{ ...pair, origin: origin("t_pair_fkey") }] });
    const after = withTable({ foreignKeys: [{ ...pair, name: "t_pairs", ...was("t_pair_fkey", "t_pairs") }] });
    assert.deepEqual(changes(before, after), [{ op: "renameConstraint", table: "t", kind: "foreignKey", constraint: "t_pairs", from: "t_pair_fkey", evidence: evidence("t_pair_fkey", "t_pairs") }]);
    const { name: _name, ...unnamed } = toParents;
    assert.deepEqual(changes(withTable({}, single(unnamed)), withTable({}, single(toParents))), []);
    const { name: _constraint, ...unnamedState } = toParentsState;
    assert.deepEqual(changes(withTable({}, single(unnamed)), withTable({}, single({ ...unnamed, onDelete: "CASCADE" }))), [
      { op: "dropForeignKey", table: "t", before: unnamedState },
      { op: "addForeignKey", table: "t", after: { ...unnamedState, onDelete: "CASCADE" } },
    ]);
  });
});

describe("schema diff: indexes", () => {
  const index = (name: string, columns: string[], extra: Record<string, unknown> = {}): Partial<TableSchema> => ({ indexes: [{ name, columns, ...extra }] });

  test("an index is added and dropped", () => {
    assert.deepEqual(changes(withTable(), withTable(index("t_a_idx", ["a", "b"]))), [{ op: "addIndex", table: "t", index: "t_a_idx", after: { name: "t_a_idx", columns: ["a", "b"], unique: false } }]);
    assert.deepEqual(changes(withTable(index("t_a_idx", ["a"], { unique: true })), withTable()), [{ op: "dropIndex", table: "t", index: "t_a_idx", before: { name: "t_a_idx", columns: ["a"], unique: true } }]);
  });

  test("an index over other columns, in another order, unique or not, or with another condition is dropped and added", () => {
    assert.deepEqual(changes(withTable(index("i", ["a"])), withTable(index("i", ["a"], { unique: true }))), [
      { op: "dropIndex", table: "t", index: "i", before: { name: "i", columns: ["a"], unique: false } },
      { op: "addIndex", table: "t", index: "i", after: { name: "i", columns: ["a"], unique: true } },
    ]);
    assert.deepEqual(ops(withTable(index("i", ["a", "b"])), withTable(index("i", ["b", "a"]))), ["dropIndex", "addIndex"]);
    assert.deepEqual(ops(withTable(index("i", ["a"])), withTable(index("i", ["a"], { where: "b is null" }))), ["dropIndex", "addIndex"]);
    assert.deepEqual(ops(withTable(index("i", ["a"], { where: "b is null" })), withTable(index("i", ["a"], { where: "c is null" }))), ["dropIndex", "addIndex"]);
    assert.deepEqual(ops(withTable(index("i", [], { expressions: ["lower(a)"] })), withTable(index("i", [], { expressions: ["upper(a)"] }))), ["dropIndex", "addIndex"]);
  });

  test("expressions and conditions are compared as text, apart from their layout; an index says what it is over", () => {
    assert.deepEqual(changes(withTable(index("i", ["a"], { expressions: ["a + b"], where: "c is null" })), withTable(index("i", ["a"], { expressions: ["a  +\n b"], where: " c  is null " }))), []);
    assert.deepEqual(changes(withTable(), withTable(index("i", ["a"], { unique: true, expressions: ["lower(b)"], where: "c is null" }))), [
      { op: "addIndex", table: "t", index: "i", after: { name: "i", columns: ["a"], expressions: ["lower(b)"], unique: true, where: "c is null" } },
    ]);
  });

  test("an index with a recorded rename is renamed; another name without one is a drop and an add", () => {
    const before = withTable({ indexes: [{ name: "t_a_idx", columns: ["a"], origin: origin("t_a_idx") }] });
    const after = withTable({ indexes: [{ name: "by_a", columns: ["a"], ...was("t_a_idx", "by_a") }] });
    assert.deepEqual(changes(before, after), [{ op: "renameIndex", table: "t", index: "by_a", from: "t_a_idx", evidence: evidence("t_a_idx", "by_a") }]);
    assert.deepEqual(ops(withTable(index("t_a_idx", ["a"])), withTable(index("by_a", ["a"]))), ["dropIndex", "addIndex"]);
    // Renamed, and over other columns: the old index is dropped and the new one added, under their own names.
    assert.deepEqual(changes(before, withTable({ indexes: [{ name: "by_a", columns: ["a", "b"], ...was("t_a_idx", "by_a") }] })), [
      { op: "dropIndex", table: "t", index: "t_a_idx", before: { name: "t_a_idx", columns: ["a"], unique: false, origin: origin("t_a_idx") } },
      { op: "addIndex", table: "t", index: "by_a", after: { name: "by_a", columns: ["a", "b"], unique: false, origin: origin("t_a_idx") } },
    ]);
  });
});

describe("schema diff: check constraints", () => {
  const check = (name: string | undefined, expression: string): Partial<TableSchema> => ({ checks: [{ ...(name !== undefined && { name }), expression }] });

  test("a check is added and dropped", () => {
    assert.deepEqual(changes(withTable(), withTable(check("t_a_check", "a > 0"))), [{ op: "addCheck", table: "t", constraint: "t_a_check", after: { name: "t_a_check", expression: "a > 0" } }]);
    assert.deepEqual(changes(withTable(check("t_a_check", "a > 0")), withTable()), [{ op: "dropCheck", table: "t", constraint: "t_a_check", before: { name: "t_a_check", expression: "a > 0" } }]);
  });

  test("a check with another expression is dropped and added; the layout of an expression is not a difference", () => {
    assert.deepEqual(changes(withTable(check("t_a_check", "a > 0")), withTable(check("t_a_check", "a > 1"))), [
      { op: "dropCheck", table: "t", constraint: "t_a_check", before: { name: "t_a_check", expression: "a > 0" } },
      { op: "addCheck", table: "t", constraint: "t_a_check", after: { name: "t_a_check", expression: "a > 1" } },
    ]);
    assert.deepEqual(changes(withTable(check("t_check", "a > 0 and b > 0")), withTable(check("t_check", "a > 0\n      and b > 0"))), []);
    // Within a quoted text, spaces are part of it.
    assert.deepEqual(ops(withTable(check("c", "a::text <> 'x  y'")), withTable(check("c", "a::text <> 'x y'"))), ["dropCheck", "addCheck"]);
  });

  test("an expression is only compared apart from its layout when nothing in it could make a space count", () => {
    const differ = (first: string, second: string): void => assert.deepEqual(ops(withTable(check("c", first)), withTable(check("c", second))), ["dropCheck", "addCheck"], `${JSON.stringify(first)} and ${JSON.stringify(second)}`);
    // A character that starts a comment in some dialect, and a name in brackets, which is how some dialects quote.
    differ("a # 1\n > 0", "a # 1 > 0");
    differ("[first  name] > 0", "[first name] > 0");
    // A no-break space, and other spaces of Unicode, are not layout to a database.
    differ("a > 0", "a > 0");
    differ("a >  0", "a > 0");
    assert.deepEqual(changes(withTable(check("c", "a\t>\r\n  0")), withTable(check("c", " a > 0\f"))), []);
  });

  test("a check with a recorded rename is renamed; a check without a name is the check of its expression", () => {
    const before = withTable({ checks: [{ name: "t_a_check", expression: "a > 0", origin: origin("t_a_check") }] });
    const after = withTable({ checks: [{ name: "a_positive", expression: "a > 0", ...was("t_a_check", "a_positive") }] });
    assert.deepEqual(changes(before, after), [{ op: "renameConstraint", table: "t", kind: "check", constraint: "a_positive", from: "t_a_check", evidence: evidence("t_a_check", "a_positive") }]);
    assert.deepEqual(changes(withTable(check(undefined, "a > 0")), withTable(check("t_a_check", "a > 0"))), []);
    assert.deepEqual(changes(withTable(check(undefined, "a > 0")), withTable(check(undefined, "a > 1"))), [
      { op: "dropCheck", table: "t", before: { expression: "a > 0" } },
      { op: "addCheck", table: "t", after: { expression: "a > 1" } },
    ]);
  });
});

describe("schema diff: constraints and what they are on", () => {
  test("a dropped column takes its constraints and indexes with it: they are dropped first", () => {
    const before = withTable({ uniques: [{ name: "t_a_key", columns: ["a"] }], indexes: [{ name: "t_a_idx", columns: ["a"] }] }, [keyColumn("id"), column("a", INTEGER, { references: { table: "parents", column: "id", name: "t_a_fkey" } }), column("b"), column("c")]);
    const after = withTable({}, [keyColumn("id"), column("b"), column("c")]);
    assert.deepEqual(ops(before, after), ["dropForeignKey", "dropUnique", "dropIndex", "dropColumn"]);
  });

  test("what a dropped constraint was is said as the before side has it: what goes stands before the renames", () => {
    const before = schema([
      { ...parents, origin: origin("parents") },
      table("t", [keyColumn("id"), column("a", INTEGER, { origin: origin("a"), references: { table: "parents", column: "id", name: "t_a_fkey" } }), column("b")], {
        uniques: [{ name: "t_a_b_key", columns: ["a", "b"] }],
        indexes: [{ name: "t_a_idx", columns: ["a"] }],
        foreignKeys: [{ name: "t_pair_fkey", columns: ["a", "b"], references: { table: "t", columns: ["b", "a"] } }],
      }),
    ]);
    const after = schema([
      { ...parents, name: "families", origin: origin("parents"), renames: [renamed("parents", "families")] },
      table("t", [keyColumn("id"), column("a2", INTEGER, { origin: origin("a"), renames: [renamed("a", "a2")] }), column("b")]),
    ]);
    assert.deepEqual(changes(before, after), [
      { op: "dropForeignKey", table: "t", constraint: "t_a_fkey", before: { name: "t_a_fkey", columns: ["a"], references: { table: "parents", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" } },
      { op: "dropForeignKey", table: "t", constraint: "t_pair_fkey", before: { name: "t_pair_fkey", columns: ["a", "b"], references: { table: "t", columns: ["b", "a"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" } },
      { op: "dropUnique", table: "t", constraint: "t_a_b_key", before: { name: "t_a_b_key", columns: ["a", "b"] } },
      { op: "dropIndex", table: "t", index: "t_a_idx", before: { name: "t_a_idx", columns: ["a"], unique: false } },
      { op: "renameTable", table: "families", from: "parents", evidence: evidence("parents", "families") },
      { op: "renameColumn", table: "t", column: "a2", from: "a", evidence: evidence("a", "a2") },
    ]);
  });

  test("a dropped table's foreign keys name the tables and columns they refer to as the before side calls them", () => {
    const before = schema([
      { ...parents, columns: [keyColumn("id", INTEGER, { origin: origin("id") })], origin: origin("parents") },
      table("gone", [keyColumn("id"), column("parent_id", INTEGER, { references: { table: "parents", column: "id", name: "gone_parent_id_fkey" } })]),
    ]);
    const after = schema([
      { name: "families", columns: [keyColumn("key", INTEGER, { origin: origin("id"), renames: [renamed("id", "key")] })], primaryKey: { name: "parents_pkey", columns: ["key"] }, origin: origin("parents"), renames: [renamed("parents", "families")] },
    ]);
    const dropped = changes(before, after).find((change) => change.op === "dropTable");
    assert.deepEqual(dropped?.op === "dropTable" && dropped.before.foreignKeys, [
      { name: "gone_parent_id_fkey", columns: ["parent_id"], references: { table: "parents", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" },
    ]);
    // The table goes before `parents` is renamed, and no key is left behind that would refer to it.
    assert.deepEqual(ops(before, after), ["dropTable", "renameTable", "renameColumn"]);
  });

  test("a foreign key to a renamed column of a table that is named, and listed, after its own: the key follows", () => {
    // The table with the keys comes first by name; the renamed column is in the table that comes last.
    const target = (name: string): TableSchema => table("z_target", [keyColumn("id"), column(name, INTEGER, { origin: origin("code"), ...(name !== "code" && { renames: [renamed("code", name)] }) })]);
    const referring = (name: string): TableSchema =>
      table("a_referring", [keyColumn("id"), column("ref", INTEGER, { references: { table: "z_target", column: name, name: "a_ref_fkey" } }), column("pair")], {
        foreignKeys: [{ name: "a_pair_fkey", columns: ["pair", "ref"], references: { table: "z_target", columns: ["id", name] } }],
      });
    assert.deepEqual(ops(schema([referring("code"), target("code")]), schema([referring("code2"), target("code2")])), ["renameColumn"]);
    assert.deepEqual(ops(schema([target("code"), referring("code")]), schema([target("code2"), referring("code2")])), ["renameColumn"]);
  });

  test("an added column gets its constraints after it is there", () => {
    const before = withTable({}, [keyColumn("id"), column("b"), column("c")]);
    const after = withTable({ uniques: [{ name: "t_a_key", columns: ["a"] }], indexes: [{ name: "t_a_idx", columns: ["a"] }], checks: [{ name: "t_a_check", expression: "a > 0" }] }, [
      keyColumn("id"),
      column("a", INTEGER, { references: { table: "parents", column: "id", name: "t_a_fkey" } }),
      column("b"),
      column("c"),
    ]);
    assert.deepEqual(ops(before, after), ["addColumn", "addUnique", "addCheck", "addIndex", "addForeignKey"]);
  });
});
