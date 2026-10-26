import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { TableSchema } from "../../runtime/src/index.ts";
import { BIGINT, INTEGER, TEXT, changes, column, enumType, keyColumn, ops, origin, renamed, schema, table, typeState } from "./support.ts";

/*
 * An object that is renamed onto the name of one that is dropped: "drop the
 * old column, rename its replacement into its place". The dropped object and
 * the renamed one are two objects under one name, at different places of the
 * list. What goes is listed before the renames, in the names the before side
 * has, so that the name is free when it is taken, and the two cannot be
 * mistaken for each other.
 */

const evidence = (from: string, to: string): unknown => ({ origin: origin(from), renames: [renamed(from, to)] });

describe("schema diff: a rename onto the name of something that is dropped", () => {
  test("a table: the old one is dropped first, and what referred to it is not taken to refer to the renamed one", () => {
    const users = (name: string, extra: Partial<TableSchema> = {}): TableSchema => table(name, [keyColumn("id"), column("name", TEXT)], extra);
    const posts = table("posts", [keyColumn("id"), column("author", INTEGER, { references: { table: "users", column: "id", name: "posts_author_fkey" } })]);
    const before = schema([users("users", { origin: origin("users") }), posts, users("users_new", { origin: origin("users_new") })]);
    const after = schema([users("users", { origin: origin("users_new"), renames: [renamed("users_new", "users")] }), posts]);
    const key = { name: "posts_author_fkey", columns: ["author"], references: { table: "users", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" };
    assert.deepEqual(changes(before, after), [
      // The key to the table that goes. It is not the key to the table that takes the name, though both read "users".
      { op: "dropForeignKey", table: "posts", constraint: "posts_author_fkey", before: key },
      {
        op: "dropTable",
        table: "users",
        before: {
          name: "users",
          columns: [
            { name: "id", type: typeState(INTEGER), nullable: false },
            { name: "name", type: typeState(TEXT), nullable: true },
          ],
          primaryKey: { columns: ["id"] },
          uniques: [],
          checks: [],
          foreignKeys: [],
          indexes: [],
          origin: origin("users"),
        },
      },
      { op: "renameTable", table: "users", from: "users_new", evidence: evidence("users_new", "users") },
      { op: "addForeignKey", table: "posts", constraint: "posts_author_fkey", after: key },
    ]);
  });

  test("a column: its key, constraints, and indexes go with the old column and come again on the renamed one", () => {
    const before = schema([
      table("t", [keyColumn("id"), column("price", TEXT, { origin: origin("price") }), column("price_cents", BIGINT, { origin: origin("price_cents") })], {
        uniques: [{ name: "t_price_once", columns: ["price"] }],
        indexes: [{ name: "t_price", columns: ["price"] }],
      }),
    ]);
    const after = schema([
      table("t", [keyColumn("id"), column("price", BIGINT, { origin: origin("price_cents"), renames: [renamed("price_cents", "price")] })], {
        uniques: [{ name: "t_price_once", columns: ["price"] }],
        indexes: [{ name: "t_price", columns: ["price"] }],
      }),
    ]);
    assert.deepEqual(changes(before, after), [
      { op: "dropUnique", table: "t", constraint: "t_price_once", before: { name: "t_price_once", columns: ["price"] } },
      { op: "dropIndex", table: "t", index: "t_price", before: { name: "t_price", columns: ["price"], unique: false } },
      { op: "dropColumn", table: "t", column: "price", before: { name: "price", type: typeState(TEXT), nullable: true, origin: origin("price") } },
      { op: "renameColumn", table: "t", column: "price", from: "price_cents", evidence: evidence("price_cents", "price") },
      { op: "addUnique", table: "t", constraint: "t_price_once", after: { name: "t_price_once", columns: ["price"] } },
      { op: "addIndex", table: "t", index: "t_price", after: { name: "t_price", columns: ["price"], unique: false } },
    ]);
  });

  test("a key column: the key over the old column is not the key over the renamed one", () => {
    const before = schema([table("t", [keyColumn("id", INTEGER, { origin: origin("id") }), column("uid", BIGINT, { nullable: false, origin: origin("uid") })], { primaryKey: { name: "t_pkey", columns: ["id"] } })]);
    const after = schema([table("t", [keyColumn("id", BIGINT, { origin: origin("uid"), renames: [renamed("uid", "id")] })], { primaryKey: { name: "t_pkey", columns: ["id"] } })]);
    assert.deepEqual(ops(before, after), ["dropPrimaryKey", "dropColumn", "renameColumn", "addPrimaryKey"]);
  });

  test("a foreign key to a column that goes, while another column takes its name, is dropped and added", () => {
    const target = (columns: TableSchema["columns"]): TableSchema => table("target", columns);
    const referring = table("referring", [keyColumn("id"), column("ref", INTEGER, { references: { table: "target", column: "code", name: "referring_ref_fkey" } })]);
    const before = schema([target([keyColumn("id"), column("code", INTEGER, { origin: origin("code") }), column("code2", INTEGER, { origin: origin("code2") })]), referring]);
    const after = schema([target([keyColumn("id"), column("code", INTEGER, { origin: origin("code2"), renames: [renamed("code2", "code")] })]), referring]);
    assert.deepEqual(ops(before, after), ["dropForeignKey", "dropColumn", "renameColumn", "addForeignKey"]);
  });

  test("an index and a constraint: the old one is dropped before the other takes its name", () => {
    const withIndexes = (indexes: TableSchema["indexes"], uniques: TableSchema["uniques"]): TableSchema => table("t", [keyColumn("id"), column("a"), column("b")], { indexes, uniques });
    const before = schema([
      withIndexes(
        [
          { name: "i", columns: ["a"], origin: origin("i") },
          { name: "i_new", columns: ["b"], origin: origin("i_new") },
        ],
        [
          { name: "k", columns: ["a"], origin: origin("k") },
          { name: "k_new", columns: ["b"], origin: origin("k_new") },
        ],
      ),
    ]);
    const after = schema([withIndexes([{ name: "i", columns: ["b"], origin: origin("i_new"), renames: [renamed("i_new", "i")] }], [{ name: "k", columns: ["b"], origin: origin("k_new"), renames: [renamed("k_new", "k")] }])]);
    assert.deepEqual(changes(before, after), [
      { op: "dropUnique", table: "t", constraint: "k", before: { name: "k", columns: ["a"], origin: origin("k") } },
      { op: "dropIndex", table: "t", index: "i", before: { name: "i", columns: ["a"], unique: false, origin: origin("i") } },
      { op: "renameConstraint", table: "t", kind: "unique", constraint: "k", from: "k_new", evidence: evidence("k_new", "k") },
      { op: "renameIndex", table: "t", index: "i", from: "i_new", evidence: evidence("i_new", "i") },
    ]);
  });

  test("an enumerated type: a type holds no rows, so the type of that name is changed and the other dropped", () => {
    // A type can only be dropped after the columns that use it have another type, which is after the renames.
    const using = (type: string): TableSchema => table("t", [keyColumn("id"), column("c", enumType(type))]);
    const before = schema([using("s_new")], [
      { name: "s", values: ["a"], origin: origin("s") },
      { name: "s_new", values: ["a", "b"], origin: origin("s_new") },
    ]);
    const after = schema([using("s")], [{ name: "s", values: ["a", "b"], origin: origin("s_new"), renames: [renamed("s_new", "s")] }]);
    assert.deepEqual(changes(before, after), [
      { op: "addEnumValue", enum: "s", value: "b", afterValue: "a" },
      { op: "alterColumnType", table: "t", column: "c", before: typeState(enumType("s_new")), after: typeState(enumType("s")), comparedBy: "canonical" },
      { op: "dropEnumType", enum: "s_new", before: { name: "s_new", values: ["a", "b"], origin: origin("s_new") } },
    ]);
  });

  test("a name that is not taken from anything: a plain rename, as before", () => {
    const before = schema([table("t", [keyColumn("id"), column("price_cents", BIGINT, { origin: origin("price_cents") })])]);
    const after = schema([table("t", [keyColumn("id"), column("price", BIGINT, { origin: origin("price_cents"), renames: [renamed("price_cents", "price")] })])]);
    assert.deepEqual(ops(before, after), ["renameColumn"]);
  });
});

describe("schema diff: what goes is named as the before side names it", () => {
  test("a dropped constraint and index of a renamed table, on a renamed column: by the old names, before the renames", () => {
    const before = schema([
      table("users", [keyColumn("id"), column("mail", TEXT, { origin: origin("mail") })], {
        uniques: [{ name: "users_mail_key", columns: ["mail"] }],
        indexes: [{ name: "users_mail_idx", columns: ["mail"] }],
        checks: [{ name: "users_mail_check", expression: "mail <> ''" }],
        origin: origin("users"),
      }),
    ]);
    const after = schema([table("accounts", [keyColumn("id"), column("email", TEXT, { origin: origin("mail"), renames: [renamed("mail", "email")] })], { origin: origin("users"), renames: [renamed("users", "accounts")] })]);
    assert.deepEqual(changes(before, after), [
      { op: "dropCheck", table: "users", constraint: "users_mail_check", before: { name: "users_mail_check", expression: "mail <> ''" } },
      { op: "dropUnique", table: "users", constraint: "users_mail_key", before: { name: "users_mail_key", columns: ["mail"] } },
      { op: "dropIndex", table: "users", index: "users_mail_idx", before: { name: "users_mail_idx", columns: ["mail"], unique: false } },
      { op: "renameTable", table: "accounts", from: "users", evidence: evidence("users", "accounts") },
      { op: "renameColumn", table: "accounts", column: "email", from: "mail", evidence: evidence("mail", "email") },
    ]);
  });

  test("a constraint that changed on a renamed table: dropped under the old names, added under the new ones", () => {
    const before = schema([table("users", [keyColumn("id"), column("a"), column("b")], { uniques: [{ name: "u", columns: ["a"] }], origin: origin("users") })]);
    const after = schema([table("accounts", [keyColumn("id"), column("a"), column("b")], { uniques: [{ name: "u", columns: ["a", "b"] }], origin: origin("users"), renames: [renamed("users", "accounts")] })]);
    assert.deepEqual(changes(before, after), [
      { op: "dropUnique", table: "users", constraint: "u", before: { name: "u", columns: ["a"] } },
      { op: "renameTable", table: "accounts", from: "users", evidence: evidence("users", "accounts") },
      { op: "addUnique", table: "accounts", constraint: "u", after: { name: "u", columns: ["a", "b"] } },
    ]);
  });

  test("a dropped column of a renamed table", () => {
    const before = schema([table("users", [keyColumn("id"), column("gone", TEXT)], { origin: origin("users") })]);
    const after = schema([table("accounts", [keyColumn("id")], { origin: origin("users"), renames: [renamed("users", "accounts")] })]);
    assert.deepEqual(changes(before, after), [
      { op: "dropColumn", table: "users", column: "gone", before: { name: "gone", type: typeState(TEXT), nullable: true } },
      { op: "renameTable", table: "accounts", from: "users", evidence: evidence("users", "accounts") },
    ]);
  });
});
