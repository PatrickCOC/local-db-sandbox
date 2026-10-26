import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ColumnSchema, DatabaseSchema, EnumType, TableSchema } from "../../runtime/src/index.ts";
import { diffSchemas } from "../../schema-diff/src/index.ts";
import { exampleAfter, exampleBefore } from "../../schema-diff/test/example.ts";
import { BOOLEAN, INTEGER, TEXT, column, enumType, keyColumn, origin, renamed, schema, table } from "../../schema-diff/test/support.ts";
import { DiffApplicationError, MigrationPlanError, applyPlan, planMigration, stringifyMigrationPlan } from "../src/index.ts";
import type { MigrationPlan, MigrationStep } from "../src/index.ts";
import { listedDifferently } from "./support/history-generator.ts";
import { assertSameSchema, deepFreeze } from "./support/semantic-form.ts";

/*
 * The plan of a diff (D-038): the diff's changes as steps that can each be
 * carried out when its turn comes. Each test states a schema and what it
 * became, has the diff made and planned, and looks at the steps. Every plan
 * is also carried out, step by step and under the rules a database has on
 * the way, and must give the second schema.
 */

function planned(before: DatabaseSchema, afterSchema: DatabaseSchema): MigrationPlan {
  const diff = diffSchemas(before, afterSchema);
  const plan = planMigration(deepFreeze(structuredClone(before)), deepFreeze(structuredClone(diff)));
  assertSameSchema(applyPlan(deepFreeze(structuredClone(before)), plan), afterSchema);
  return plan;
}

/** A step in a few words: what it does, to what, and why if the planner added it. */
function brief(step: MigrationStep): string {
  const note = `${step.planned === undefined ? "" : ` [${step.planned}]`}${step.temporaryName === true ? " [temporary]" : ""}`;
  switch (step.op) {
    case "renameTable":
      return `rename table ${step.from} -> ${step.table}${note}`;
    case "renameColumn":
      return `rename column ${step.table}.${step.from} -> ${step.column}${note}`;
    case "renameConstraint":
      return `rename constraint ${step.table}.${step.from} -> ${step.constraint}${note}`;
    case "renameIndex":
      return `rename index ${step.table}.${step.from} -> ${step.index}${note}`;
    case "renameEnumType":
      return `rename type ${step.from} -> ${step.enum}${note}`;
    case "renameEnumValue":
      return `rename value ${step.enum}.${step.from} -> ${step.to}${note}`;
    case "addEnumValue":
      return `add value ${step.enum}.${step.value}${step.afterValue !== undefined ? ` after ${step.afterValue}` : step.beforeValue !== undefined ? ` before ${step.beforeValue}` : ""}`;
    case "removeEnumValue":
      return `remove value ${step.enum}.${step.value}`;
    default:
      return `${step.op} ${"table" in step ? step.table : step.enum}${"column" in step ? `.${step.column}` : ""}${"constraint" in step && step.constraint !== undefined ? ` ${step.constraint}` : ""}${"index" in step ? ` ${step.index}` : ""}${note}`;
  }
}

const steps = (plan: MigrationPlan): string[] => plan.steps.map(brief);

/** An object as it is after renames: created as the first name, called the last one now. */
function tracked(names: string[]): { origin: ReturnType<typeof origin>; renames?: ReturnType<typeof renamed>[] } {
  const [first, ...rest] = names as [string, ...string[]];
  const renames = rest.map((to, index) => renamed(names[index] as string, to, "0002_rename.sql", index + 1));
  return { origin: origin(first), ...(renames.length > 0 && { renames }) };
}

/** The history of an object that was created as `created` and is called `name` now, by way of another name when the two differ. */
const history = (created: string, name: string): ReturnType<typeof tracked> => tracked(created === name ? [name] : [created, `${created}_on_the_way`, name]);

describe("planMigration: a diff that can be carried out as it is listed", () => {
  test("is planned as its own changes, in their order", () => {
    const diff = diffSchemas(exampleBefore(), exampleAfter());
    const plan = planMigration(exampleBefore(), diff);
    assert.equal(plan.version, 1);
    assert.deepEqual(
      plan.steps.map((step) => step.op),
      diff.changes.map((change) => change.op),
    );
    // A step that is a change of the diff is that change, and nothing more.
    assert.deepEqual(plan.steps, diff.changes);
    assertSameSchema(applyPlan(exampleBefore(), plan), exampleAfter());
  });

  test("a schema that stays as it is has a plan of no steps", () => {
    assert.deepEqual(planned(exampleBefore(), exampleBefore()), { version: 1, steps: [] });
  });
});

describe("planMigration: tables that are dropped", () => {
  const refers = (name: string, ...targets: string[]): TableSchema =>
    table(name, [keyColumn("id"), ...targets.map((target) => column(`${target}_id`, INTEGER, { references: { table: target, column: "id", name: `${name}_${target}_fkey` } }))]);
  const kept = table("kept", [keyColumn("id")]);

  test("a table goes before the table it refers to, whatever the two are called", () => {
    // By name, "a" comes first; it is referred to by "b", which therefore goes first.
    assert.deepEqual(steps(planned(schema([kept, refers("a"), refers("b", "a")]), schema([kept]))), ["dropTable b", "dropTable a"]);
    assert.deepEqual(steps(planned(schema([kept, refers("a", "b"), refers("b")]), schema([kept]))), ["dropTable a", "dropTable b"]);
    // A chain of three, against the order of their names, and listed in another order.
    assert.deepEqual(steps(planned(schema([refers("a"), kept, refers("c", "b"), refers("b", "a")]), schema([kept]))), ["dropTable c", "dropTable b", "dropTable a"]);
  });

  test("a table that refers to itself is dropped as it is", () => {
    assert.deepEqual(steps(planned(schema([kept, refers("tree", "tree")]), schema([kept]))), ["dropTable tree"]);
  });

  test("tables that refer to each other: the foreign keys between them go first, as steps of their own", () => {
    const plan = planned(schema([kept, refers("a", "b", "kept"), refers("b", "a")]), schema([kept]));
    assert.deepEqual(steps(plan), ["dropForeignKey b b_a_fkey [tables-dropped-together]", "dropTable a", "dropTable b"]);
    // The step says what it drops, and the table that goes afterwards no longer has that key.
    const [dropKey, dropA, dropB] = plan.steps as [MigrationStep, MigrationStep, MigrationStep];
    assert.deepEqual(dropKey, { op: "dropForeignKey", table: "b", constraint: "b_a_fkey", before: { name: "b_a_fkey", columns: ["a_id"], references: { table: "a", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" }, planned: "tables-dropped-together" });
    assert.deepEqual(dropA.op === "dropTable" && dropA.before.foreignKeys?.map((key) => key.name), ["a_b_fkey", "a_kept_fkey"]);
    assert.deepEqual(dropB.op === "dropTable" && dropB.before.foreignKeys, []);
  });

  test("three tables in a ring, and a table that only refers into the ring", () => {
    const plan = planned(schema([kept, refers("a", "b"), refers("b", "c"), refers("c", "a"), refers("outside", "b")]), schema([kept]));
    // What only refers goes first; then one key of the ring is dropped, and the rest follows by itself.
    assert.deepEqual(steps(plan), ["dropTable outside", "dropForeignKey c c_a_fkey [tables-dropped-together]", "dropTable a", "dropTable b", "dropTable c"]);
  });

  test("a foreign key from a table that stays is dropped by the diff itself, before the table it refers to", () => {
    const plan = planned(schema([refers("kept_too", "gone"), refers("gone")]), schema([table("kept_too", [keyColumn("id"), column("gone_id")])]));
    assert.deepEqual(steps(plan), ["dropForeignKey kept_too kept_too_gone_fkey", "dropTable gone"]);
  });

  test("a column that goes waits for the table whose foreign key refers to it; only a key between tables that go is dropped ahead", () => {
    // "t" stays and loses "c". "u" and "w" go and refer to each other; "u" also refers to t.c.
    const t = (withColumn: boolean): TableSchema => table("t", [keyColumn("id"), ...(withColumn ? [column("c")] : [])]);
    const u = table("u", [keyColumn("id"), column("c_ref", INTEGER, { references: { table: "t", column: "c", name: "u_c_fkey" } }), column("w_id", INTEGER, { references: { table: "w", column: "id", name: "u_w_fkey" } })]);
    const w = table("w", [keyColumn("id"), column("u_id", INTEGER, { references: { table: "u", column: "id", name: "w_u_fkey" } })]);
    const plan = planned(schema([t(true), u, w]), schema([t(false)]));
    // One key between the two tables is in the way; the key to t.c goes with its table, and needs no step.
    assert.deepEqual(steps(plan), ["dropForeignKey w w_u_fkey [tables-dropped-together]", "dropTable u", "dropColumn t.c", "dropTable w"]);
  });

  test("the foreign keys that are dropped ahead are in one order, also when nothing but where they come from tells them apart", () => {
    const made = (statement: number): { columns: string[]; references: { table: string; columns: string[] }; origin: ReturnType<typeof origin> } => ({ columns: ["m_id"], references: { table: "m", columns: ["id"] }, origin: origin("n_m_id_fkey", "0001_init.sql", statement) });
    const of = (keys: ReturnType<typeof made>[]): DatabaseSchema =>
      schema([kept, table("m", [keyColumn("id"), column("n_id", INTEGER, { references: { table: "n", column: "id", name: "m_n_fkey" } })]), table("n", [keyColumn("id"), column("m_id")], { foreignKeys: keys })]);
    const [first, second] = [made(3), made(4)];
    const text = (before: DatabaseSchema): string => stringifyMigrationPlan(planMigration(before, diffSchemas(before, schema([kept]))));
    assert.equal(text(of([first, second])), text(of([second, first])));
    assert.equal(planMigration(of([first, second]), diffSchemas(of([first, second]), schema([kept]))).steps.filter((step) => step.planned === "tables-dropped-together").length, 2);
  });

  test("a foreign key over several columns between tables that are dropped together", () => {
    const pair = (name: string, other: string): TableSchema =>
      table(name, [keyColumn("id"), column("x"), column("y")], { foreignKeys: [{ name: `${name}_${other}_fkey`, columns: ["x", "y"], references: { table: other, columns: ["id", "x"] } }], uniques: [{ name: `${name}_key`, columns: ["id", "x"] }] });
    assert.deepEqual(steps(planned(schema([kept, pair("m", "n"), pair("n", "m")]), schema([kept]))), ["dropForeignKey n n_m_fkey [tables-dropped-together]", "dropTable m", "dropTable n"]);
  });
});

describe("planMigration: renames that need an order, or a name in between", () => {
  const made = (name: string, created: string): TableSchema => table(name, [keyColumn("id"), column(`of_${created}`)], { ...history(created, name) });

  test("a name that is passed on: the one that gives it up goes first", () => {
    assert.deepEqual(steps(planned(schema([made("a", "a"), made("b", "b")]), schema([made("b", "a"), made("c", "b")]))), ["rename table b -> c", "rename table a -> b"]);
    // Against the order of the names as well.
    assert.deepEqual(steps(planned(schema([made("b", "b"), made("c", "c")]), schema([made("a", "b"), made("b", "c")]))), ["rename table b -> a", "rename table c -> b"]);
    // Three in a row.
    assert.deepEqual(steps(planned(schema([made("a", "a"), made("b", "b"), made("c", "c")]), schema([made("b", "a"), made("c", "b"), made("d", "c")]))), ["rename table c -> d", "rename table b -> c", "rename table a -> b"]);
  });

  test("two tables exchange their names: one goes by way of a temporary name", () => {
    const plan = planned(schema([made("a", "a"), made("b", "b")]), schema([made("b", "a"), made("a", "b")]));
    assert.deepEqual(steps(plan), ["rename table a -> migration_tmp_1 [rename-cycle] [temporary]", "rename table b -> a", "rename table migration_tmp_1 -> b"]);
    const [away, second, back] = plan.steps as [MigrationStep, MigrationStep, MigrationStep];
    // The step out of the way is the planner's; the step that gives the table its name completes the diff's rename, and has its evidence.
    assert.deepEqual(away, { op: "renameTable", table: "migration_tmp_1", from: "a", planned: "rename-cycle", temporaryName: true });
    assert.deepEqual([second.op === "renameTable" && second.evidence?.origin.name, back.op === "renameTable" && back.evidence?.origin.name], ["b", "a"]);
    assert.deepEqual("planned" in back || "temporaryName" in back, false);
  });

  test("three tables pass their names round: one name in between is enough", () => {
    const plan = planned(schema([made("a", "a"), made("b", "b"), made("c", "c")]), schema([made("b", "a"), made("c", "b"), made("a", "c")]));
    assert.deepEqual(steps(plan), ["rename table a -> migration_tmp_1 [rename-cycle] [temporary]", "rename table c -> a", "rename table b -> c", "rename table migration_tmp_1 -> b"]);
  });

  test("a table that waits for a name of a ring does not get a temporary name itself", () => {
    // a and b exchange their names; c takes the name d gives up, and d takes one nothing has.
    const plan = planned(schema([made("a", "a"), made("b", "b"), made("c", "c"), made("d", "d")]), schema([made("b", "a"), made("a", "b"), made("d", "c"), made("e", "d")]));
    assert.deepEqual(steps(plan), ["rename table d -> e", "rename table c -> d", "rename table a -> migration_tmp_1 [rename-cycle] [temporary]", "rename table b -> a", "rename table migration_tmp_1 -> b"]);
  });

  test("two rings get two temporary names, numbered in the order of the plan", () => {
    const plan = planned(schema([made("a", "a"), made("b", "b"), made("x", "x"), made("y", "y")]), schema([made("b", "a"), made("a", "b"), made("y", "x"), made("x", "y")]));
    assert.deepEqual(steps(plan), [
      "rename table a -> migration_tmp_1 [rename-cycle] [temporary]",
      "rename table b -> a",
      "rename table migration_tmp_1 -> b",
      "rename table x -> migration_tmp_2 [rename-cycle] [temporary]",
      "rename table y -> x",
      "rename table migration_tmp_2 -> y",
    ]);
  });

  test("a temporary name is one that nothing in either schema has", () => {
    const bystander = table("migration_tmp_1", [keyColumn("id"), column("migration_tmp_2")], { indexes: [{ name: "migration_tmp_3", columns: ["id"] }] });
    const plan = planned(schema([made("a", "a"), made("b", "b"), bystander]), schema([made("b", "a"), made("a", "b"), bystander]));
    assert.deepEqual(steps(plan)[0], "rename table a -> migration_tmp_4 [rename-cycle] [temporary]");
    // Whatever kind of thing has the name: a type, a value, a constraint.
    const others = schema(
      [made("a", "a"), made("b", "b"), table("other", [keyColumn("id")], { checks: [{ name: "migration_tmp_3", expression: "id > 0" }] })],
      [{ name: "migration_tmp_1", values: ["migration_tmp_2"] }],
    );
    const afterOthers = schema([made("b", "a"), made("a", "b"), others.tables[2] as TableSchema], others.types.enums);
    assert.deepEqual(steps(planned(others, afterOthers))[0], "rename table a -> migration_tmp_4 [rename-cycle] [temporary]");
    // Nor one that only the schema it leads to has: here a table that the same diff adds.
    const added = planned(schema([made("a", "a"), made("b", "b")]), schema([made("b", "a"), made("a", "b"), table("migration_tmp_1", [keyColumn("id")])]));
    assert.deepEqual(steps(added), ["rename table a -> migration_tmp_2 [rename-cycle] [temporary]", "rename table b -> a", "rename table migration_tmp_2 -> b", "addTable migration_tmp_1"]);
  });

  test("a table renamed onto the name of a dropped one: the old occupant goes first", () => {
    const plan = planned(schema([made("a", "a"), made("b", "b")]), schema([made("b", "a")]));
    assert.deepEqual(steps(plan), ["dropTable b", "rename table a -> b"]);
  });

  test("columns of one table: a name passed on, names exchanged, and the same in a table that is renamed too", () => {
    const of = (tableName: string, names: [string, string, string]): DatabaseSchema =>
      schema([
        table(tableName, [keyColumn("id"), column(names[0], INTEGER, { ...history("a", names[0]) }), column(names[1], TEXT, { ...history("b", names[1]) }), column(names[2], BOOLEAN, { ...history("c", names[2]) })], {
          ...history("t", tableName),
          indexes: [{ name: "t_first_idx", columns: [names[0]] }],
        }),
      ]);
    assert.deepEqual(steps(planned(of("t", ["a", "b", "c"]), of("t", ["b", "x", "c"]))), ["rename column t.b -> x", "rename column t.a -> b"]);
    assert.deepEqual(steps(planned(of("t", ["a", "b", "c"]), of("u", ["b", "a", "c"]))), [
      "rename table t -> u",
      "rename column u.a -> migration_tmp_1 [rename-cycle] [temporary]",
      "rename column u.b -> a",
      "rename column u.migration_tmp_1 -> b",
    ]);
  });

  test("the names of keys, constraints, and indexes are given up before they are taken, across tables", () => {
    // The tables pass their names on, and their keys with them: a_pkey must be free before the other table's key takes it.
    const keyed = (name: string, created: string): TableSchema =>
      table(name, [keyColumn("id")], { ...history(created, name), primaryKey: { name: `${name}_pkey`, columns: ["id"], ...history(`${created}_pkey`, `${name}_pkey`) }, indexes: [{ name: `${name}_idx`, columns: ["id"], ...history(`${created}_idx`, `${name}_idx`) }] });
    const plan = planned(schema([keyed("a", "a"), keyed("b", "b")]), schema([keyed("b", "a"), keyed("c", "b")]));
    assert.deepEqual(steps(plan), ["rename table b -> c", "rename table a -> b", "rename constraint c.b_pkey -> c_pkey", "rename constraint b.a_pkey -> b_pkey", "rename index c.b_idx -> c_idx", "rename index b.a_idx -> b_idx"]);
    // Exchanged between two tables: no database lets two keys or two indexes have one name on the way.
    const exchanged = (name: string, key: string, index: string): TableSchema =>
      table(name, [keyColumn("id")], { primaryKey: { name: key, columns: ["id"], ...history(`${name}_pkey`, key) }, indexes: [{ name: index, columns: ["id"], ...history(`${name}_idx`, index) }] });
    assert.deepEqual(steps(planned(schema([exchanged("m", "m_pkey", "m_idx"), exchanged("n", "n_pkey", "n_idx")]), schema([exchanged("m", "n_pkey", "n_idx"), exchanged("n", "m_pkey", "m_idx")]))), [
      "rename constraint m.m_pkey -> migration_tmp_1 [rename-cycle] [temporary]",
      "rename constraint n.n_pkey -> m_pkey",
      "rename constraint m.migration_tmp_1 -> n_pkey",
      "rename index m.m_idx -> migration_tmp_2 [rename-cycle] [temporary]",
      "rename index n.n_idx -> m_idx",
      "rename index m.migration_tmp_2 -> n_idx",
    ]);
  });

  test("constraints of one table: a name passed on, and names exchanged", () => {
    const of = (key: string, unique: string, check: string): DatabaseSchema =>
      schema([
        table("t", [keyColumn("id"), column("a")], { primaryKey: { name: key, columns: ["id"], ...history("k", key) }, uniques: [{ name: unique, columns: ["a"], ...history("u", unique) }], checks: [{ name: check, expression: "a > 0", ...history("c", check) }] }),
      ]);
    // The key gives its name up and the unique constraint takes it: both are named afterwards, so nothing is left to say.
    assert.deepEqual(steps(planned(of("k", "u", "c"), of("p", "k", "c"))), ["rename constraint t.k -> p", "rename constraint t.u -> k"]);
    assert.deepEqual(steps(planned(of("k", "u", "c"), of("u", "c", "k"))), ["rename constraint t.c -> migration_tmp_1 [rename-cycle] [temporary]", "rename constraint t.u -> c", "rename constraint t.k -> u", "rename constraint t.migration_tmp_1 -> k"]);
  });

  test("names that go round between things of different kinds: a table and an index, a table and a type, a key and an index", () => {
    // Somewhere a table and an index are both relations, a key has an index of its name, a table has a type of its name: no name is two things on the way.
    const tableAndIndex = planned(
      schema([table("a", [keyColumn("id")], { ...history("a", "a"), indexes: [{ name: "b", columns: ["id"], ...history("b", "b") }] })]),
      schema([table("b", [keyColumn("id")], { ...history("a", "b"), indexes: [{ name: "a", columns: ["id"], ...history("b", "a") }] })]),
    );
    assert.deepEqual(steps(tableAndIndex), ["rename table a -> migration_tmp_1 [rename-cycle] [temporary]", "rename index migration_tmp_1.b -> a", "rename table migration_tmp_1 -> b"]);

    const typed = (tableName: string, typeName: string): DatabaseSchema =>
      schema([table(tableName, [keyColumn("id"), column("state", enumType(typeName), { enum: { name: typeName, values: ["on"] } })], { ...history("x", tableName) })], [{ name: typeName, values: ["on"], ...history("y", typeName) }]);
    // The one whose name comes first moves out of the way, whatever kind it is: here the table.
    assert.deepEqual(steps(planned(typed("x", "y"), typed("y", "x"))), ["rename table x -> migration_tmp_1 [rename-cycle] [temporary]", "rename type y -> x", "rename table migration_tmp_1 -> y"]);

    const keyAndIndex = (key: string, index: string): DatabaseSchema =>
      schema([table("t", [keyColumn("id")], { primaryKey: { name: key, columns: ["id"], ...history("k", key) }, indexes: [{ name: index, columns: ["id"], ...history("i", index) }] })]);
    assert.deepEqual(steps(planned(keyAndIndex("k", "i"), keyAndIndex("i", "k"))), ["rename index t.i -> migration_tmp_1 [rename-cycle] [temporary]", "rename constraint t.k -> i", "rename index t.migration_tmp_1 -> k"]);
  });

  test("a table takes the name an index gives up, which is a relation's name as well: the index goes first", () => {
    const before = schema([table("a", [keyColumn("id")], { ...history("a", "a"), indexes: [{ name: "b", columns: ["id"], ...history("b", "b") }] })]);
    const afterSchema = schema([table("b", [keyColumn("id")], { ...history("a", "b"), indexes: [{ name: "c", columns: ["id"], ...history("b", "c") }] })]);
    assert.deepEqual(steps(planned(before, afterSchema)), ["rename index a.b -> c", "rename table a -> b"]);
  });
});

describe("planMigration: several changes to one enumerated type", () => {
  const typed = (values: string[], renames?: EnumType["valueRenames"], fallback = values[0]): DatabaseSchema => {
    const name = "status";
    const type: EnumType = { name, values, ...history("status", name), ...(renames !== undefined && { valueRenames: renames }) };
    const state: ColumnSchema = column("state", enumType(name), { enum: { name, values }, default: fallback });
    return schema([table("posts", [keyColumn("id"), state])], [type]);
  };

  test("values are added in the order in which each has what it is put next to", () => {
    // By name, "a" would be added first; it is put after "z", which has to be there.
    assert.deepEqual(steps(planned(typed(["m"]), typed(["m", "z", "a"], undefined, "m"))), ["add value status.z after m", "add value status.a after z"]);
    // Of the values that can be added, the first by name is; "b" waits for "c".
    assert.deepEqual(steps(planned(typed(["m"]), typed(["c", "b", "m", "a"], undefined, "m"))), ["add value status.a after m", "add value status.c before m", "add value status.b after c"]);
  });

  test("a value's name that is passed on, and two values that exchange their names", () => {
    const passed = planned(typed(["a", "b"]), typed(["b", "c"], [renamed("b", "c", "0002_rename.sql", 1), renamed("a", "b", "0002_rename.sql", 2)]));
    assert.deepEqual(steps(passed), ["rename value status.b -> c", "rename value status.a -> b"]);
    const exchanged = planned(typed(["a", "b"]), typed(["b", "a"], [renamed("a", "tmp", "0002_rename.sql", 1), renamed("b", "a", "0002_rename.sql", 2), renamed("tmp", "b", "0002_rename.sql", 3)]));
    assert.deepEqual(steps(exchanged), ["rename value status.a -> migration_tmp_1 [rename-cycle] [temporary]", "rename value status.b -> a", "rename value status.migration_tmp_1 -> b"]);
  });

  test("a type that is renamed, with values renamed, added, and removed, and a default that moves to a new value", () => {
    const before = typed(["draft", "live", "old"]);
    const afterSchema = schema(
      [table("posts", [keyColumn("id"), column("state", enumType("post_status"), { enum: { name: "post_status", values: ["idea", "draft", "public", "review"] }, default: "review" })])],
      [{ name: "post_status", values: ["idea", "draft", "public", "review"], ...tracked(["status", "post_status"]), valueRenames: [renamed("live", "public", "0002_rename.sql", 2)] }],
    );
    assert.deepEqual(steps(planned(before, afterSchema)), [
      "rename type status -> post_status",
      "rename value post_status.live -> public",
      "add value post_status.idea before draft",
      "add value post_status.review after public",
      "setDefault posts.state",
      "remove value post_status.old",
    ]);
  });
});

describe("planMigration: the same plan whatever order things are listed in", () => {
  test("a schema listed in another order, and a diff whose changes are in another order, give the same bytes", () => {
    const diff = diffSchemas(exampleBefore(), exampleAfter());
    const expected = stringifyMigrationPlan(planMigration(exampleBefore(), diff));
    assert.equal(stringifyMigrationPlan(planMigration(exampleBefore(), diff)), expected);
    assert.equal(stringifyMigrationPlan(planMigration(listedDifferently(exampleBefore(), 7), { ...diff, changes: [...diff.changes].reverse() })), expected);
  });

  test("the plan as JSON: its version first, then the steps, each with its keys in the diff's order", () => {
    const made = (name: string, created: string): TableSchema => table(name, [keyColumn("id")], { ...history(created, name) });
    const plan = planned(schema([made("a", "a"), made("b", "b")]), schema([made("b", "a"), made("a", "b")]));
    const text = stringifyMigrationPlan(plan);
    assert.match(text, /^\{\n {2}"version": 1,\n {2}"steps": \[\n {4}\{\n {6}"op": "renameTable",\n {6}"table": "migration_tmp_1",\n {6}"from": "a",\n {6}"planned": "rename-cycle",\n {6}"temporaryName": true\n {4}\},\n/);
    assert.deepEqual(JSON.parse(text), plan);
    // Without indentation: the same keys in the same order, on one line.
    assert.equal(stringifyMigrationPlan(plan, 0), JSON.stringify({ version: 1, steps: (JSON.parse(text) as MigrationPlan).steps }));
    assert.equal(stringifyMigrationPlan({ version: 1, steps: [] }), '{\n  "version": 1,\n  "steps": []\n}');
  });

  test("the plan does not share anything with the diff or the schema it was made from", () => {
    const before = exampleBefore();
    const diff = diffSchemas(before, exampleAfter());
    const plan = planMigration(before, diff);
    const text = stringifyMigrationPlan(plan);
    for (const change of diff.changes) {
      (change as { op: string }).op = "changed afterwards";
    }
    before.tables.length = 0;
    assert.equal(stringifyMigrationPlan(plan), text);
  });
});

describe("planMigration: what cannot be planned is refused", () => {
  test("a diff that does not fit the schema, with what applyDiff says of it", () => {
    const diff = diffSchemas(exampleBefore(), exampleAfter());
    assert.throws(() => planMigration(schema([]), diff), (error: unknown) => error instanceof DiffApplicationError && /there is no table/.test(error.message));
  });

  test("a table that goes while a foreign key of a table that stays refers to it: the diff would have to drop that key", () => {
    const users = table("users", [keyColumn("id")]);
    const posts = table("posts", [keyColumn("id"), column("author", INTEGER, { references: { table: "users", column: "id", name: "posts_author_fkey" } })]);
    const before = schema([users, posts]);
    // The diff of the two schemas drops the key first. One that leaves it out is not carried out by dropping it anyway.
    const diff = diffSchemas(before, schema([table("posts", [keyColumn("id"), column("author")])]));
    assert.deepEqual(diff.changes.map((change) => change.op), ["dropForeignKey", "dropTable"]);
    assert.throws(
      () => planMigration(before, { ...diff, changes: diff.changes.slice(1) }),
      (error: unknown) => error instanceof MigrationPlanError && error.message === 'dropTable "users" cannot be carried out, at any point of the plan: the foreign key "posts_author_fkey" of table "posts" refers to it.',
    );
  });

  test("a schema that has a foreign key to nothing, which the diff does not touch: the plan would leave it", () => {
    const of = (extra: ColumnSchema[]): DatabaseSchema => schema([table("orders", [keyColumn("id"), column("customer", INTEGER, { references: { table: "customers", column: "id", name: "orders_customer_fkey" } }), ...extra])]);
    assert.throws(
      () => planMigration(of([]), diffSchemas(of([]), of([column("note")]))),
      (error: unknown) =>
        error instanceof MigrationPlanError && error.message === 'The diff leads to a schema that a database would refuse: the foreign key "orders_customer_fkey" of table "orders" refers to the table "customers", which the schema does not have.',
    );
  });

  test("a schema that no database would take: a foreign key to a table that is not there", () => {
    const before = schema([table("t", [keyColumn("id")])]);
    const afterSchema = schema([table("t", [keyColumn("id"), column("ghost_id", INTEGER, { references: { table: "ghost", column: "id", name: "t_ghost_fkey" } })])]);
    assert.throws(
      () => planMigration(before, diffSchemas(before, afterSchema)),
      (error: unknown) => error instanceof MigrationPlanError && error.message === 'addForeignKey "t_ghost_fkey" of table "t" cannot be carried out, at any point of the plan: there is no table "ghost" for it to refer to.',
    );
  });
});
