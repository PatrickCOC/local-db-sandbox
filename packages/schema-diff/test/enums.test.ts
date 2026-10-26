import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DatabaseSchema, EnumType, TableSchema } from "../../runtime/src/index.ts";
import { changes, column, enumType, keyColumn, ops, origin, renamed, schema, table } from "./support.ts";

/** A schema with the enumerated types given, and no tables. */
const types = (...enums: EnumType[]): DatabaseSchema => schema([], enums);
const values = (...names: string[]): EnumType => ({ name: "e", values: names });

describe("schema diff: enumerated types", () => {
  test("a type is added and dropped, with its values in their order", () => {
    const mood: EnumType = { name: "mood", values: ["ok", "meh"] };
    assert.deepEqual(changes(types(), types(mood)), [{ op: "addEnumType", enum: "mood", after: { name: "mood", values: ["ok", "meh"] } }]);
    assert.deepEqual(changes(types(mood), types()), [{ op: "dropEnumType", enum: "mood", before: { name: "mood", values: ["ok", "meh"] } }]);
    assert.deepEqual(changes(types(mood), types(mood)), []);
  });

  test("a value is added where the after side has it: after the value before it, or before the first", () => {
    assert.deepEqual(changes(types(values("a", "c")), types(values("a", "b", "c", "d"))), [
      { op: "addEnumValue", enum: "e", value: "b", afterValue: "a" },
      { op: "addEnumValue", enum: "e", value: "d", afterValue: "c" },
    ]);
    assert.deepEqual(changes(types(values("b")), types(values("a", "b"))), [{ op: "addEnumValue", enum: "e", value: "a", beforeValue: "b" }]);
  });

  test("several added values come in an order in which each can be placed by what is there already", () => {
    assert.deepEqual(changes(types(values("c")), types(values("a", "b", "c"))), [
      { op: "addEnumValue", enum: "e", value: "a", beforeValue: "c" },
      { op: "addEnumValue", enum: "e", value: "b", afterValue: "a" },
    ]);
    // A type without values: the first value has nothing to stand next to.
    assert.deepEqual(changes(types(values()), types(values("x", "y"))), [
      { op: "addEnumValue", enum: "e", value: "x" },
      { op: "addEnumValue", enum: "e", value: "y", afterValue: "x" },
    ]);
  });

  test("a value that the after side does not have is removed", () => {
    assert.deepEqual(changes(types(values("a", "b", "c")), types(values("a", "c"))), [{ op: "removeEnumValue", enum: "e", value: "b" }]);
  });

  test("the same values in another order cannot be reached by adding and removing: the values are replaced", () => {
    assert.deepEqual(changes(types(values("a", "b", "c")), types(values("c", "a", "b"))), [{ op: "replaceEnumValues", enum: "e", before: ["a", "b", "c"], after: ["c", "a", "b"] }]);
    assert.deepEqual(changes(types(values("a", "b")), types(values("b", "x", "a"))), [{ op: "replaceEnumValues", enum: "e", before: ["a", "b"], after: ["b", "x", "a"] }]);
  });

  test("a value with a recorded rename is renamed", () => {
    const before: EnumType = { name: "status", values: ["draft", "live"], origin: origin("status") };
    const after: EnumType = { name: "status", values: ["draft", "published"], origin: origin("status"), valueRenames: [renamed("live", "published")] };
    assert.deepEqual(changes(types(before), types(after)), [
      { op: "renameEnumValue", enum: "status", from: "live", to: "published", evidence: { origin: origin("status"), renames: [renamed("live", "published")] } },
    ]);
  });

  test("a value under another name without a recorded rename is added and removed", () => {
    assert.deepEqual(changes(types(values("draft", "live")), types(values("draft", "published"))), [
      { op: "addEnumValue", enum: "e", value: "published", afterValue: "draft" },
      { op: "removeEnumValue", enum: "e", value: "live" },
    ]);
    // A recorded rename, but of a type of another origin.
    const before: EnumType = { name: "e", values: ["live"], origin: origin("e", "0001_init.sql", 1) };
    const after: EnumType = { name: "e", values: ["published"], origin: origin("e", "0007_again.sql", 3), valueRenames: [renamed("live", "published")] };
    assert.deepEqual(ops(types(before), types(after)), ["addEnumValue", "removeEnumValue"]);
  });

  test("the evidence of a renamed value is its renames since the before side", () => {
    const first = renamed("live", "published", "0002_rename.sql", 1);
    const second = renamed("published", "public", "0003_rename.sql", 1);
    const original: EnumType = { name: "e", values: ["live"], origin: origin("e") };
    const between: EnumType = { name: "e", values: ["published"], origin: origin("e"), valueRenames: [first] };
    const final: EnumType = { name: "e", values: ["public"], origin: origin("e"), valueRenames: [first, second] };
    assert.deepEqual(changes(types(original), types(final)), [{ op: "renameEnumValue", enum: "e", from: "live", to: "public", evidence: { origin: origin("e"), renames: [first, second] } }]);
    assert.deepEqual(changes(types(between), types(final)), [{ op: "renameEnumValue", enum: "e", from: "published", to: "public", evidence: { origin: origin("e"), renames: [second] } }]);
    assert.deepEqual(changes(types(final), types(final)), []);
  });

  test("renames that the two sides do not share from the start are no evidence", () => {
    const before: EnumType = { name: "e", values: ["published"], origin: origin("e"), valueRenames: [renamed("live", "published")] };
    const after: EnumType = { name: "e", values: ["public"], origin: origin("e"), valueRenames: [renamed("live", "public")] };
    assert.deepEqual(ops(types(before), types(after)), ["addEnumValue", "removeEnumValue"]);
    // The before side's "published" was once "shown"; the after side's was once "live". They do not tell one story.
    const other: EnumType = { name: "e", values: ["published"], origin: origin("e"), valueRenames: [renamed("shown", "published")] };
    const later: EnumType = { name: "e", values: ["public"], origin: origin("e"), valueRenames: [renamed("live", "published"), renamed("published", "public", "0003_rename.sql", 1)] };
    assert.deepEqual(ops(types(other), types(later)), ["addEnumValue", "removeEnumValue"]);
    // The same rename, made by another statement, is another rename.
    const elsewhere: EnumType = { name: "e", values: ["published"], origin: origin("e"), valueRenames: [renamed("live", "published", "0002_rename.sql", 9)] };
    assert.deepEqual(ops(types(elsewhere), types(later)), ["addEnumValue", "removeEnumValue"]);
    assert.deepEqual(ops(types(before), types(later)), ["renameEnumValue"]);
  });

  test("a renamed value that the before side never had is an added value", () => {
    const before: EnumType = { name: "e", values: ["a"], origin: origin("e") };
    const after: EnumType = { name: "e", values: ["a", "y"], origin: origin("e"), valueRenames: [renamed("x", "y")] };
    assert.deepEqual(changes(types(before), types(after)), [{ op: "addEnumValue", enum: "e", value: "y", afterValue: "a" }]);
  });

  test("renames that lead to a value the after side does not have are no evidence: values keep the before side's names", () => {
    const before: EnumType = { name: "e", values: ["draft", "live"], origin: origin("e") };
    const after: EnumType = { name: "e", values: ["draft"], origin: origin("e"), valueRenames: [renamed("live", "published")] };
    assert.deepEqual(changes(types(before), types(after)), [{ op: "removeEnumValue", enum: "e", value: "live" }]);
  });

  test("renames that would give a type one value twice are no evidence at all", () => {
    // By this history "c" is the former "a", but "b" was there when "a" is said to have become "b": it does not hang together.
    const before: EnumType = { name: "e", values: ["a", "b"], origin: origin("e") };
    const after: EnumType = { name: "e", values: ["b", "c"], origin: origin("e"), valueRenames: [renamed("a", "b", "0002_rename.sql", 1), renamed("b", "c", "0002_rename.sql", 2)] };
    assert.deepEqual(changes(types(before), types(after)), [
      { op: "addEnumValue", enum: "e", value: "c", afterValue: "b" },
      { op: "removeEnumValue", enum: "e", value: "a" },
    ]);
  });

  test("values that were renamed and are in another order: what is replaced is said in the values' new names", () => {
    const before: EnumType = { name: "e", values: ["a", "b", "c"], origin: origin("e") };
    const after: EnumType = { name: "e", values: ["c", "x", "b"], origin: origin("e"), valueRenames: [renamed("a", "x")] };
    assert.deepEqual(changes(types(before), types(after)), [
      { op: "renameEnumValue", enum: "e", from: "a", to: "x", evidence: { origin: origin("e"), renames: [renamed("a", "x")] } },
      { op: "replaceEnumValues", enum: "e", before: ["x", "b", "c"], after: ["c", "x", "b"] },
    ]);
  });

  test("a type with a recorded rename is renamed, and its other changes name it by its new name", () => {
    const before: EnumType = { name: "status", values: ["draft", "live"], origin: origin("status") };
    const after: EnumType = { name: "post_status", values: ["draft", "review", "public"], origin: origin("status"), renames: [renamed("status", "post_status")], valueRenames: [renamed("live", "public", "0002_rename.sql", 2)] };
    assert.deepEqual(changes(types(before), types(after)), [
      { op: "renameEnumType", enum: "post_status", from: "status", evidence: { origin: origin("status"), renames: [renamed("status", "post_status")] } },
      { op: "renameEnumValue", enum: "post_status", from: "live", to: "public", evidence: { origin: origin("status"), renames: [renamed("live", "public", "0002_rename.sql", 2)] } },
      { op: "addEnumValue", enum: "post_status", value: "review", afterValue: "draft" },
    ]);
  });

  test("a type under another name without a recorded rename is added and dropped", () => {
    assert.deepEqual(ops(types({ name: "status", values: ["a"] }), types({ name: "post_status", values: ["a"] })), ["addEnumType", "dropEnumType"]);
  });
});

describe("schema diff: enumerated types and the columns that use them", () => {
  /** Three columns of two tables, all of the type `status`. */
  function using(type: EnumType, defaultValue?: string): DatabaseSchema {
    const of = enumType(type.name);
    const state = { enum: { name: type.name, values: [...type.values] } };
    return schema(
      [
        table("posts", [keyColumn("id"), column("state", of, { ...state, nullable: false, ...(defaultValue !== undefined && { default: defaultValue }) }), column("previous", of, state)]),
        table("comments", [keyColumn("id"), column("state", of, state), column("history", { type: "json", canonicalType: { kind: "array", element: { kind: "enum", name: type.name } } })]),
      ],
      [type],
    );
  }
  const status: EnumType = { name: "status", values: ["draft", "live"], origin: origin("status") };

  test("a change of a type that several columns use is one change of the type, and none of the columns", () => {
    assert.deepEqual(changes(using(status), using({ ...status, values: ["draft", "review", "live"] })), [{ op: "addEnumValue", enum: "status", value: "review", afterValue: "draft" }]);
    assert.deepEqual(changes(using({ ...status, values: ["draft", "review", "live"] }), using(status)), [{ op: "removeEnumValue", enum: "status", value: "review" }]);
    assert.deepEqual(ops(using(status), using({ ...status, values: ["draft", "published"], valueRenames: [renamed("live", "published")] })), ["renameEnumValue"]);
    assert.deepEqual(ops(using(status), using({ ...status, values: ["live", "draft"] })), ["replaceEnumValues"]);
  });

  test("columns follow a renamed type: only the type is renamed", () => {
    assert.deepEqual(ops(using(status), using({ ...status, name: "post_status", renames: [renamed("status", "post_status")] })), ["renameEnumType"]);
  });

  test("a default that is a renamed value follows the rename; another default is a change", () => {
    const renamedValue: EnumType = { ...status, values: ["draft", "published"], valueRenames: [renamed("live", "published")] };
    assert.deepEqual(ops(using(status, "live"), using(renamedValue, "published")), ["renameEnumValue"]);
    // The default that is replaced is named as it is called by then: the rename stands before it in the list.
    assert.deepEqual(changes(using(status, "live"), using(renamedValue, "draft")).at(-1), {
      op: "setDefault",
      table: "posts",
      column: "state",
      before: { kind: "value", value: "published" },
      after: { kind: "value", value: "draft" },
    });
  });

  test("what a column was is said in the names that hold where the change stands: after the renames, a renamed type and value by their new names", () => {
    const text = { type: "text" as const, canonicalType: { kind: "text" as const }, declaredType: "text" };
    const after = schema(
      [
        table("posts", [keyColumn("id"), column("state", text, { nullable: false }), column("previous", enumType("post_status"), { enum: { name: "post_status", values: ["draft", "public"] }, default: "draft" })]),
        table("comments", [keyColumn("id"), column("history", { type: "json", canonicalType: { kind: "array", element: { kind: "enum", name: "post_status" } } })]),
      ],
      [{ ...status, name: "post_status", values: ["draft", "public"], renames: [renamed("status", "post_status")], valueRenames: [renamed("live", "public", "0002_rename.sql", 2)] }],
    );
    const before = using(status, "live");
    before.tables[0]!.columns[2]!.default = "live";
    assert.deepEqual(
      changes(before, after).filter((change) => !change.op.startsWith("rename")),
      [
        // A column that goes stands before the renames: its type is still called "status".
        { op: "dropColumn", table: "comments", column: "state", before: { name: "state", type: { storage: "text", canonical: { kind: "enum", name: "status" }, declared: "status" }, nullable: true } },
        // posts.state had the default "live", which is called "public" by now, and the type "status", now "post_status".
        { op: "dropDefault", table: "posts", column: "state", before: { kind: "value", value: "public" } },
        { op: "alterColumnType", table: "posts", column: "state", before: { storage: "text", canonical: { kind: "enum", name: "post_status" }, declared: "status" }, after: { storage: "text", canonical: { kind: "text" }, declared: "text" }, comparedBy: "canonical" },
        { op: "setDefault", table: "posts", column: "previous", before: { kind: "value", value: "public" }, after: { kind: "value", value: "draft" } },
      ],
    );
  });

  test("a renamed type whose columns say their type by name alone (no canonical type): the columns follow it", () => {
    const of = (name: string): DatabaseSchema =>
      schema([table("posts", [keyColumn("id"), column("state", { type: "text", declaredType: "state" }, { enum: { name, values: ["draft"] } })])], [{ name, values: ["draft"], origin: origin("status"), ...(name !== "status" && { renames: [renamed("status", name)] }) }]);
    assert.deepEqual(ops(of("status"), of("post_status")), ["renameEnumType"]);
    // When such a column also changes, what it was is said by the type's new name.
    const changed = of("post_status");
    changed.tables[0]!.columns[1] = column("state", { type: "integer", declaredType: "state" });
    assert.deepEqual(changes(of("status"), changed).at(-1), {
      op: "alterColumnType",
      table: "posts",
      column: "state",
      before: { storage: "text", declared: "state", enum: "post_status" },
      after: { storage: "integer", declared: "state" },
      comparedBy: "declared",
    });
  });

  test("a default that is a renamed value follows the rename on a column that has the canonical type alone", () => {
    const of = (value: string, type: EnumType): DatabaseSchema => schema([table("posts", [keyColumn("id"), column("state", enumType("status"), { default: value })])], [type]);
    const renamedValue: EnumType = { ...status, values: ["draft", "published"], valueRenames: [renamed("live", "published")] };
    assert.deepEqual(ops(of("live", status), of("published", renamedValue)), ["renameEnumValue"]);
  });

  test("a type that two columns give with different values: the first column by table and name says what it is, however they are listed", () => {
    const given = (name: string, values: string[]): TableSchema => table(name, [keyColumn("id"), column("state", { type: "text" }, { enum: { name: "status", values } })]);
    const agreed = schema([given("a", ["draft"]), given("b", ["draft"])]);
    assert.deepEqual(changes(schema([given("a", ["draft"]), given("b", ["draft", "gone"])]), agreed), []);
    assert.deepEqual(changes(schema([given("b", ["draft", "gone"]), given("a", ["draft"])]), agreed), []);
  });

  test("a type that only columns give (a schema without a list of its types) is compared all the same", () => {
    // What a schema made in code may look like: the values are on the column, and `types.enums` is empty.
    const onColumns = (...values: string[]): DatabaseSchema =>
      schema([
        table("posts", [keyColumn("id"), column("state", { type: "text" }, { enum: { name: "status", values } }), column("previous", { type: "text" }, { enum: { name: "status", values } })]),
      ]);
    assert.deepEqual(changes(onColumns("draft", "live"), onColumns("draft", "live")), []);
    assert.deepEqual(changes(onColumns("draft", "live"), onColumns("draft", "review", "live")), [{ op: "addEnumValue", enum: "status", value: "review", afterValue: "draft" }]);
    assert.deepEqual(changes(onColumns("draft", "live"), onColumns("draft")), [{ op: "removeEnumValue", enum: "status", value: "live" }]);
    // The same type, once listed by the schema and once given by its columns only.
    const listed = schema(onColumns("draft", "live").tables, [{ name: "status", values: ["draft", "live"] }]);
    assert.deepEqual(changes(listed, onColumns("draft", "live")), []);
    assert.deepEqual(changes(onColumns("draft", "live"), listed), []);
    assert.deepEqual(changes(schema([table("posts", [keyColumn("id")])]), onColumns("draft")).map((change) => change.op), ["addEnumType", "addColumn", "addColumn"]);
  });

  test("a new type and a column of it: the type comes before the column", () => {
    const before = schema([table("posts", [keyColumn("id")])]);
    const after = schema([table("posts", [keyColumn("id"), column("state", enumType("status"), { enum: { name: "status", values: ["draft"] } })])], [{ name: "status", values: ["draft"] }]);
    assert.deepEqual(ops(before, after), ["addEnumType", "addColumn"]);
    assert.deepEqual(ops(after, before), ["dropColumn", "dropEnumType"]);
  });
});
