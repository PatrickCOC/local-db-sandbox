import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SCHEMA_DIFF_VERSION, diffSchemas } from "../src/index.ts";
import type { TableSchema } from "../../runtime/src/index.ts";
import { BIGINT, INTEGER, TEXT, changes, column, keyColumn, ops, origin, renamed, schema, table, typeState } from "./support.ts";

const parents = table("parents", [keyColumn("id")], { primaryKey: { name: "parents_pkey", columns: ["id"] } });

const children = table(
  "children",
  [keyColumn("id"), column("parent_id", INTEGER, { references: { table: "parents", column: "id", onDelete: "CASCADE", name: "children_parent_id_fkey" } }), column("code", TEXT)],
  {
    primaryKey: { name: "children_pkey", columns: ["id"] },
    uniques: [{ name: "children_code_key", columns: ["code"] }],
    checks: [{ name: "children_code_check", expression: "code <> ''" }],
    indexes: [{ name: "children_parent_idx", columns: ["parent_id"] }],
  },
);

/** `children` as the diff describes a table: its columns, key, unique constraints, and checks. */
const childrenState = {
  name: "children",
  columns: [
    { name: "id", type: typeState(INTEGER), nullable: false },
    { name: "parent_id", type: typeState(INTEGER), nullable: true },
    { name: "code", type: typeState(TEXT), nullable: true },
  ],
  primaryKey: { name: "children_pkey", columns: ["id"] },
  uniques: [{ name: "children_code_key", columns: ["code"] }],
  checks: [{ name: "children_code_check", expression: "code <> ''" }],
};
const childrenForeignKey = { name: "children_parent_id_fkey", columns: ["parent_id"], references: { table: "parents", columns: ["id"] }, onDelete: "CASCADE", onUpdate: "NO ACTION" };
const childrenIndex = { name: "children_parent_idx", columns: ["parent_id"], unique: false };

describe("schema diff: tables", () => {
  test("two schemas that are the same have no differences", () => {
    assert.deepEqual(diffSchemas(schema([parents, children]), schema([parents, children])), { diffVersion: SCHEMA_DIFF_VERSION, changes: [] });
    assert.deepEqual(diffSchemas(schema([]), schema([])), { diffVersion: 1, changes: [] });
  });

  test("a table that only the after side has is added; its indexes and foreign keys are changes of their own, after it", () => {
    assert.deepEqual(changes(schema([parents]), schema([parents, children])), [
      { op: "addTable", table: "children", after: childrenState },
      { op: "addIndex", table: "children", index: "children_parent_idx", after: childrenIndex },
      { op: "addForeignKey", table: "children", constraint: "children_parent_id_fkey", after: childrenForeignKey },
    ]);
  });

  test("a table that only the before side has is dropped, and the change says what it had", () => {
    assert.deepEqual(changes(schema([parents, children]), schema([parents])), [
      { op: "dropTable", table: "children", before: { ...childrenState, foreignKeys: [childrenForeignKey], indexes: [childrenIndex] } },
    ]);
  });

  test("a foreign key of a table that stays, to a table that is dropped, is dropped first", () => {
    const { name: _name, columns: _columns, ...rest } = children;
    const orphans = table("children", [keyColumn("id"), column("parent_id"), column("code", TEXT)], rest);
    assert.deepEqual(ops(schema([parents, children]), schema([orphans])), ["dropForeignKey", "dropTable"]);
    assert.deepEqual(changes(schema([parents, children]), schema([orphans]))[0], { op: "dropForeignKey", table: "children", constraint: "children_parent_id_fkey", before: childrenForeignKey });
  });

  test("a table with a recorded rename is renamed: the change names both names and gives the evidence", () => {
    const before = table("a", [keyColumn("id")], { origin: origin("a") });
    const after = table("b", [keyColumn("id")], { origin: origin("a"), renames: [renamed("a", "b")] });
    assert.deepEqual(changes(schema([before]), schema([after])), [{ op: "renameTable", table: "b", from: "a", evidence: { origin: origin("a"), renames: [renamed("a", "b")] } }]);
  });

  test("a table under another name without a recorded rename is dropped and added, however alike the two are", () => {
    const columns = [keyColumn("id"), column("name", TEXT)];
    // No provenance at all.
    assert.deepEqual(ops(schema([table("a", columns)]), schema([table("b", columns)])), ["dropTable", "addTable"]);
    // The same origin, but no rename is recorded.
    assert.deepEqual(ops(schema([table("a", columns, { origin: origin("a") })]), schema([table("b", columns, { origin: origin("a") })])), ["dropTable", "addTable"]);
    // A recorded rename, but of a table of another origin.
    assert.deepEqual(
      ops(schema([table("a", columns, { origin: origin("a", "0001_init.sql", 1) })]), schema([table("b", columns, { origin: origin("a", "0009_other.sql", 4), renames: [renamed("a", "b")] })])),
      ["dropTable", "addTable"],
    );
    // A recorded rename that does not start at the before side's name.
    assert.deepEqual(ops(schema([table("a", columns, { origin: origin("x") })]), schema([table("b", columns, { origin: origin("x"), renames: [renamed("x", "b")] })])), ["dropTable", "addTable"]);
  });

  test("what refers to a renamed table follows it: only the rename is a change", () => {
    const families = table("families", [keyColumn("id")], { primaryKey: { name: "parents_pkey", columns: ["id"] }, origin: origin("parents"), renames: [renamed("parents", "families")] });
    const { name: _name, columns: _columns, ...rest } = children;
    const follows = table("children", [keyColumn("id"), column("parent_id", INTEGER, { references: { table: "families", column: "id", onDelete: "CASCADE", name: "children_parent_id_fkey" } }), column("code", TEXT)], rest);
    assert.deepEqual(ops(schema([{ ...parents, origin: origin("parents") }, children]), schema([families, follows])), ["renameTable"]);
  });

  test("a renamed table that also changed: the other changes name it by its new name", () => {
    const before = table("a", [keyColumn("id")], { origin: origin("a") });
    const after = table("b", [keyColumn("id"), column("note", TEXT)], { origin: origin("a"), renames: [renamed("a", "b")] });
    assert.deepEqual(changes(schema([before]), schema([after])), [
      { op: "renameTable", table: "b", from: "a", evidence: { origin: origin("a"), renames: [renamed("a", "b")] } },
      { op: "addColumn", table: "b", column: "note", after: { name: "note", type: typeState(TEXT), nullable: true } },
    ]);
  });

  test("a table that was renamed, and a new table under its old name: a rename and an added table", () => {
    const before = table("a", [keyColumn("id"), column("kept", TEXT)], { origin: origin("a") });
    const moved = table("b", [keyColumn("id"), column("kept", TEXT)], { origin: origin("a"), renames: [renamed("a", "b")] });
    const fresh = table("a", [keyColumn("id"), column("other", BIGINT)], { origin: origin("a", "0003_again.sql", 1) });
    assert.deepEqual(changes(schema([before]), schema([fresh, moved])), [
      { op: "renameTable", table: "b", from: "a", evidence: { origin: origin("a"), renames: [renamed("a", "b")] } },
      {
        op: "addTable",
        table: "a",
        after: {
          name: "a",
          columns: [
            { name: "id", type: typeState(INTEGER), nullable: false },
            { name: "other", type: typeState(BIGINT), nullable: true },
          ],
          primaryKey: { columns: ["id"] },
          uniques: [],
          checks: [],
          origin: origin("a", "0003_again.sql", 1),
        },
      },
    ]);
  });
});

describe("schema diff: columns", () => {
  const before = table("t", [keyColumn("id"), column("x")]);

  test("a column that only the after side has is added, with its type, nullability, and default", () => {
    const after = table("t", [keyColumn("id"), column("x"), column("note", TEXT, { nullable: false, default: "" })]);
    assert.deepEqual(changes(schema([before]), schema([after])), [
      { op: "addColumn", table: "t", column: "note", after: { name: "note", type: typeState(TEXT), nullable: false, default: { kind: "value", value: "" } } },
    ]);
  });

  test("a column that only the before side has is dropped, and the change says what it was", () => {
    const after = table("t", [keyColumn("id")]);
    assert.deepEqual(changes(schema([before]), schema([after])), [{ op: "dropColumn", table: "t", column: "x", before: { name: "x", type: typeState(INTEGER), nullable: true } }]);
  });

  test("a column with a recorded rename is renamed", () => {
    const from = table("t", [keyColumn("id"), column("x", INTEGER, { origin: origin("x") })]);
    const to = table("t", [keyColumn("id"), column("y", INTEGER, { origin: origin("x"), renames: [renamed("x", "y")] })]);
    assert.deepEqual(changes(schema([from]), schema([to])), [{ op: "renameColumn", table: "t", column: "y", from: "x", evidence: { origin: origin("x"), renames: [renamed("x", "y")] } }]);
  });

  test("a column under another name without a recorded rename is dropped and added", () => {
    const to = table("t", [keyColumn("id"), column("y")]);
    assert.deepEqual(ops(schema([before]), schema([to])), ["dropColumn", "addColumn"]);
    const sameOrigin = (name: string): TableSchema => table("t", [keyColumn("id"), column(name, INTEGER, { origin: origin("x") })]);
    assert.deepEqual(ops(schema([sameOrigin("x")]), schema([sameOrigin("y")])), ["dropColumn", "addColumn"]);
  });

  test("the evidence of a rename is the renames since the before side's name, not the whole history", () => {
    const history = [renamed("x", "y", "0002_rename.sql", 1), renamed("y", "z", "0003_rename.sql", 1)];
    const final = table("t", [keyColumn("id"), column("z", INTEGER, { origin: origin("x"), renames: history })]);
    const original = table("t", [keyColumn("id"), column("x", INTEGER, { origin: origin("x") })]);
    const between = table("t", [keyColumn("id"), column("y", INTEGER, { origin: origin("x"), renames: [history[0]!] })]);
    assert.deepEqual(changes(schema([original]), schema([final])), [{ op: "renameColumn", table: "t", column: "z", from: "x", evidence: { origin: origin("x"), renames: history } }]);
    assert.deepEqual(changes(schema([between]), schema([final])), [{ op: "renameColumn", table: "t", column: "z", from: "y", evidence: { origin: origin("x"), renames: [history[1]] } }]);
    // Nothing since the before side: the two are the same.
    assert.deepEqual(changes(schema([final]), schema([final])), []);
  });

  test("what is on a renamed column follows it: keys, constraints, indexes, and foreign keys to it do not change", () => {
    const target = (name: string): TableSchema =>
      table("t", [keyColumn("id"), column(name, INTEGER, { origin: origin("x"), ...(name !== "x" && { renames: [renamed("x", name)] }), references: { table: "parents", column: "id", name: "t_x_fkey" } })], {
        primaryKey: { name: "t_pkey", columns: ["id"] },
        uniques: [{ name: "t_x_key", columns: [name] }],
        indexes: [{ name: "t_x_idx", columns: ["id", name] }],
        foreignKeys: [{ name: "t_pair_fkey", columns: ["id", name], references: { table: "t", columns: ["id", name] } }],
      });
    const referring = (name: string): TableSchema => table("u", [keyColumn("id"), column("t_x", INTEGER, { references: { table: "t", column: name, name: "u_t_x_fkey" } })]);
    assert.deepEqual(ops(schema([parents, target("x"), referring("x")]), schema([parents, target("y"), referring("y")])), ["renameColumn"]);
  });

  test("a renamed key column: the key is not dropped and added", () => {
    const keyed = (name: string): TableSchema =>
      table("t", [keyColumn(name, INTEGER, { origin: origin("id"), ...(name !== "id" && { renames: [renamed("id", name)] }) }), keyColumn("part")], { primaryKey: { name: "t_pkey", columns: ["part", name] } });
    assert.deepEqual(ops(schema([keyed("id")]), schema([keyed("key")])), ["renameColumn"]);
  });

  test("a renamed column that also changed: the other changes name it by its new name", () => {
    const from = table("t", [keyColumn("id"), column("x", INTEGER, { origin: origin("x") })]);
    const to = table("t", [keyColumn("id"), column("y", BIGINT, { origin: origin("x"), renames: [renamed("x", "y")], nullable: false })]);
    assert.deepEqual(changes(schema([from]), schema([to])), [
      { op: "renameColumn", table: "t", column: "y", from: "x", evidence: { origin: origin("x"), renames: [renamed("x", "y")] } },
      { op: "alterColumnType", table: "t", column: "y", before: typeState(INTEGER), after: typeState(BIGINT), comparedBy: "canonical" },
      { op: "setNotNull", table: "t", column: "y" },
    ]);
  });

  test("a column that was renamed, and a new column under its old name: a rename and an added column", () => {
    const from = table("t", [keyColumn("id"), column("rate", INTEGER, { origin: origin("rate") })]);
    const to = table("t", [keyColumn("id"), column("reference_rate", INTEGER, { origin: origin("rate"), renames: [renamed("rate", "reference_rate")] }), column("rate", TEXT, { origin: origin("rate", "0003_again.sql", 2) })]);
    assert.deepEqual(changes(schema([from]), schema([to])), [
      { op: "renameColumn", table: "t", column: "reference_rate", from: "rate", evidence: { origin: origin("rate"), renames: [renamed("rate", "reference_rate")] } },
      { op: "addColumn", table: "t", column: "rate", after: { name: "rate", type: typeState(TEXT), nullable: true, origin: origin("rate", "0003_again.sql", 2) } },
    ]);
  });

  test("the order of a table's columns is not compared", () => {
    const reordered = table("t", [column("x"), keyColumn("id")]);
    assert.deepEqual(changes(schema([before]), schema([reordered])), []);
  });
});
