import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CheckConstraint, ColumnSchema, DatabaseSchema, EnumType, ExpressionName, IndexDefinition, TableSchema } from "../../runtime/src/index.ts";
import { diffSchemas } from "../../schema-diff/src/index.ts";
import { INTEGER, TEXT, column, enumType, keyColumn, origin, renamed, schema, table } from "../../schema-diff/test/support.ts";
import { DiffApplicationError, MigrationPlanError, applyDiff, applyPlan, planMigration, stringifyMigrationPlan, validatePlan } from "../src/index.ts";
import type { MigrationPlan, MigrationStep } from "../src/index.ts";
import { comparable } from "../src/model.ts";
import { listedDifferently } from "./support/history-generator.ts";
import { assertSameSchema, deepFreeze } from "./support/semantic-form.ts";

/*
 * What the canonical schema holds since D-040, through the migration
 * package: how an index is built and what its keys are, what a key or a
 * constraint is beyond its columns, and what the text of an expression
 * names. A diff applied, and its plan carried out, give the schema the diff
 * was made for, with all of it.
 */

/** The diff applied, and its plan carried out: both mean the after side, and the plan arrives there. */
function carried(before: DatabaseSchema, after: DatabaseSchema): { result: DatabaseSchema; plan: MigrationPlan; ops: string[] } {
  const diff = diffSchemas(before, after);
  const result = applyDiff(deepFreeze(structuredClone(before)), deepFreeze(structuredClone(diff)));
  assertSameSchema(result, after);
  const plan = planMigration(deepFreeze(structuredClone(before)), deepFreeze(structuredClone(diff)));
  assertSameSchema(applyPlan(deepFreeze(structuredClone(before)), plan), after, {}, "the plan");
  assert.equal(validatePlan(before, plan, after), undefined);
  return { result, plan, ops: plan.steps.map((step) => step.op) };
}

const tableOf = (result: DatabaseSchema, name = "t"): TableSchema => {
  const found = result.tables.find((candidate) => candidate.name === name);
  assert.ok(found, `table ${name}`);
  return found;
};

function refusedPlan(run: () => unknown, message: string | RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof MigrationPlanError, String(error));
    if (typeof message === "string") {
      assert.equal(error.message, message);
    } else {
      assert.match(error.message, message);
    }
    return true;
  });
}

describe("the migration model: what an index, a key, and a constraint are beyond their columns", () => {
  const COLUMNS = (): ColumnSchema[] => [keyColumn("id"), column("a"), column("b", TEXT), column("tags", TEXT), column("p")];
  const plain = (): DatabaseSchema => schema([table("p", [keyColumn("id"), column("x")], { primaryKey: { name: "p_pkey", columns: ["id"] }, uniques: [{ name: "p_pair", columns: ["id", "x"] }] }), table("t", COLUMNS())]);
  const INDEXES: IndexDefinition[] = [
    { name: "by_tags", columns: ["tags"], method: "gin", keys: [{ column: "tags", operatorClass: "gin_trgm_ops" }] },
    { name: "ordered", columns: ["a", "b"], unique: true, keys: [{ column: "a", order: "desc", nulls: "last" }, { column: "b", collation: "C" }], include: ["tags", "p"], nullsNotDistinct: true, where: "a > 0", names: [{ kind: "column", name: "a" }] },
    { name: "mixed", columns: ["a"], expressions: ["lower(b)"], keys: [{ expression: "lower(b)" }, { column: "a" }], names: [{ kind: "column", name: "b" }], sourceClauses: ["WITH (fillfactor=70)"] },
    { name: "hashed", columns: ["b"], method: "hash" },
  ];
  const full = (): DatabaseSchema =>
    schema([
      table("p", [keyColumn("id"), column("x")], { primaryKey: { name: "p_pkey", columns: ["id"] }, uniques: [{ name: "p_pair", columns: ["id", "x"] }] }),
      table("t", [...COLUMNS().slice(0, 4), column("p", INTEGER, { references: { table: "p", column: "id", name: "t_p", onDelete: "CASCADE", deferrable: "deferred", sourceClauses: ["MATCH FULL"] } })], {
        primaryKey: { name: "t_pkey", columns: ["id"], include: ["a"], deferrable: "immediate", sourceClauses: ["USING INDEX TABLESPACE fast"] },
        uniques: [{ name: "t_b", columns: ["b"], include: ["tags", "a"], deferrable: "deferred", nullsNotDistinct: true, sourceClauses: ["WITH (fillfactor=70)"] }],
        foreignKeys: [{ name: "t_pair", columns: ["id", "a"], references: { table: "p", columns: ["id", "x"] }, deferrable: "immediate", sourceClauses: ["NOT VALID"] }],
        indexes: INDEXES,
        checks: [{ name: "k", expression: "a > 0", names: [{ kind: "column", name: "a" }], sourceClauses: ["NO INHERIT"] }],
      }),
    ]);

  test("a diff that adds all of it, applied, gives all of it, and the plan arrives there", () => {
    const { result, ops } = carried(plain(), full());
    assert.deepEqual(ops, ["dropPrimaryKey", "addPrimaryKey", "addUnique", "addCheck", "addIndex", "addIndex", "addIndex", "addIndex", "addForeignKey", "addForeignKey"]);
    const t = tableOf(result);
    assert.deepEqual(t.primaryKey, tableOf(full()).primaryKey);
    assert.deepEqual(t.uniques, tableOf(full()).uniques);
    assert.deepEqual(t.foreignKeys, tableOf(full()).foreignKeys);
    assert.deepEqual(t.checks, tableOf(full()).checks);
    assert.deepEqual([...(t.indexes ?? [])].sort((x, y) => (x.name < y.name ? -1 : 1)), [...INDEXES].sort((x, y) => (x.name < y.name ? -1 : 1)));
    assert.deepEqual(t.columns[4]?.references, tableOf(full()).columns[4]?.references);
  });

  test("a diff that takes all of it away finds each thing by all it is", () => {
    const t = tableOf(carried(full(), plain()).result);
    assert.deepEqual([t.primaryKey, t.uniques, t.foreignKeys, t.indexes, t.checks, t.columns[4]?.references], [undefined, [], [], [], [], undefined]);
  });

  test("the plan of it has the same bytes however the schemas list their objects, and whatever order the objects got their keys in", () => {
    const text = (before: DatabaseSchema, after: DatabaseSchema): string => stringifyMigrationPlan(planMigration(before, diffSchemas(before, after)));
    for (const [before, after] of [[plain, full], [full, plain]] as const) {
      const expected = text(before(), after());
      assert.equal(text(before(), after()), expected);
      assert.equal(text(listedDifferently(before(), 7), listedDifferently(after(), 11)), expected);
    }
    assert.notEqual(text(plain(), full()), text(full(), plain()));
  });

  test("a table that comes, and one that goes, has all of it", () => {
    const other = (): DatabaseSchema => schema([full().tables[0] as TableSchema]);
    const byName = (list: readonly IndexDefinition[] | undefined): IndexDefinition[] => [...(list ?? [])].sort((x, y) => (x.name < y.name ? -1 : 1));
    const added = tableOf(carried(other(), full()).result);
    assert.deepEqual({ ...added, indexes: byName(added.indexes) }, { ...tableOf(full()), indexes: byName(INDEXES) });
    carried(full(), other());
  });

  test("each of them makes another thing of the same columns: the one goes and the other comes", () => {
    const one = (index: Partial<IndexDefinition>): DatabaseSchema => schema([table("t", COLUMNS(), { indexes: [{ name: "i", columns: ["a", "b"], ...index }] })]);
    for (const after of [{ method: "gist" }, { keys: [{ column: "a", order: "desc" as const }, { column: "b" }] }, { include: ["p"] }, { unique: true, nullsNotDistinct: true }, { sourceClauses: ["WITH (fillfactor=70)"] }]) {
      const { ops, result } = carried(one({}), one(after));
      assert.deepEqual(ops, ["dropIndex", "addIndex"]);
      assert.deepEqual(tableOf(result).indexes, [{ name: "i", columns: ["a", "b"], ...after }]);
      carried(one(after), one({}));
    }
  });

  test("a primary key without a name that says more than its columns is a key of its own, not what the columns' marks give", () => {
    const keyed = (primaryKey?: NonNullable<TableSchema["primaryKey"]>): DatabaseSchema => schema([table("t", [keyColumn("id"), column("a")], primaryKey === undefined ? {} : { primaryKey })]);
    for (const more of [{ deferrable: "deferred" as const }, { include: ["a"] }, { sourceClauses: ["USING INDEX TABLESPACE fast"] }]) {
      const { result, ops } = carried(keyed(), keyed({ columns: ["id"], ...more }));
      assert.deepEqual(ops, ["dropPrimaryKey", "addPrimaryKey"]);
      assert.deepEqual(tableOf(result).primaryKey, { columns: ["id"], ...more });
      // And back: what the marks give is what is left.
      assert.equal(tableOf(carried(keyed({ columns: ["id"], ...more }), keyed()).result).primaryKey, undefined);
    }
  });

  test("an index whose keys are not its columns and expressions is not added: the change does not hold together", () => {
    const before = schema([table("t", [keyColumn("id"), column("a"), column("b", TEXT)])]);
    const adding = (index: object): MigrationPlan => ({ version: 1, steps: [{ op: "addIndex", table: "t", index: "i", after: { name: "i", unique: false, columns: ["a"], ...index } }] as MigrationStep[] });
    refusedPlan(() => applyPlan(before, adding({ keys: [{ column: "b" }] })), /^Step 1, addIndex "i" of table "t": what the change says of its keys does not hold together: /);
    refusedPlan(() => applyPlan(before, adding({ expressions: ["lower(b)"], keys: [{ column: "a" }] })), /^Step 1, addIndex "i" of table "t": what the change says of its keys does not hold together: /);
    refusedPlan(() => applyPlan(before, adding({ keys: [{ column: "a", expression: "lower(b)" }] })), /^Step 1, addIndex "i" of table "t": what the change says of its keys does not hold together: /);
    // Keys that are the columns, each with what it says, are taken.
    assert.deepEqual(tableOf(applyPlan(before, adding({ keys: [{ column: "a", order: "desc" }] }))).indexes, [{ name: "i", columns: ["a"], keys: [{ column: "a", order: "desc" }] }]);
  });

  test("a renamed column is followed in what a key or an index carries along, and in the keys of an index", () => {
    const tracked = (name: string): Partial<ColumnSchema> => ({ origin: origin("a", "0001_init.sql", 2), ...(name !== "a" && { renames: [renamed("a", name)] }) });
    const of = (name: string): DatabaseSchema =>
      schema([
        table("t", [keyColumn("id"), column(name, INTEGER, tracked(name)), column("b", TEXT)], {
          primaryKey: { name: "t_pkey", columns: ["id"], include: [name] },
          uniques: [{ name: "u", columns: ["b"], include: [name] }],
          indexes: [{ name: "i", columns: [name, "b"], keys: [{ column: name, order: "desc" }, { column: "b" }], include: [name] }],
        }),
      ]);
    const { ops, result } = carried(of("a"), of("amount"));
    assert.deepEqual(ops, ["renameColumn"]);
    assert.deepEqual([tableOf(result).primaryKey?.include, tableOf(result).uniques?.[0]?.include, tableOf(result).indexes?.[0]], [["amount"], ["amount"], { name: "i", columns: ["amount", "b"], keys: [{ column: "amount", order: "desc" }, { column: "b" }], include: ["amount"] }]);
  });

  test("a change that describes another thing than the schema has does not fit", () => {
    const diff = diffSchemas(full(), plain());
    const other = full();
    (tableOf(other).indexes as IndexDefinition[])[0] = { name: "by_tags", columns: ["tags"], method: "gist" };
    assert.throws(
      () => applyDiff(other, diff),
      (error: unknown) => error instanceof DiffApplicationError && /dropIndex "by_tags" of table "t": the index is not what the change says it was\./.test(error.message),
    );
  });

  test("what a key or an index carries along is no order: the same columns in another order are the same thing", () => {
    assert.equal(comparable({ name: "u", columns: ["b"], include: ["tags", "a"] }), comparable({ name: "u", columns: ["b"], include: ["a", "tags"] }));
    assert.notEqual(comparable({ name: "u", columns: ["b", "a"] }), comparable({ name: "u", columns: ["a", "b"] }));
    // The keys of an index are an order, and an expression among them is compared as an expression is: apart from its layout.
    assert.equal(comparable({ name: "i", keys: [{ expression: "lower( b )" }, { column: "a" }] }), comparable({ name: "i", keys: [{ expression: "lower( b  )" }, { column: "a" }] }));
    assert.notEqual(comparable({ name: "i", keys: [{ column: "a" }, { expression: "lower(b)" }] }), comparable({ name: "i", keys: [{ expression: "lower(b)" }, { column: "a" }] }));
  });
});

describe("the migration model: what the text of an expression names", () => {
  const A = origin("a", "0001_init.sql", 2);
  const names = (...entries: [string, string?][]): ExpressionName[] => entries.map(([name, now]) => ({ kind: "column", name, ...(now !== undefined && now !== name && { now }) }));
  /**
   * A column that was created as `a`, with a check and an index over it, and
   * `qty` with a check. `called`: what the column was called, one name after
   * the other. `taken`: another column has the name `a`. `more`: another
   * column altogether. `known`: the schema says what its texts name.
   */
  const tracked = (called: string[], options: { taken?: boolean; more?: boolean; known?: boolean } = {}): DatabaseSchema => {
    const now = called.at(-1) as string;
    const text = (...entries: [string, string?][]): { names?: ExpressionName[] } => (options.known !== false ? { names: names(...entries) } : {});
    const history = called.slice(1).map((to, index) => renamed(called[index] as string, to, "0002_rename.sql", index + 1));
    return schema([
      table(
        "t",
        [
          keyColumn("id"),
          column(now, INTEGER, { origin: A, ...(history.length > 0 && { renames: history }) }),
          column("qty"),
          ...(options.taken === true ? [column("a", TEXT, { origin: origin("a", "0003_more.sql") })] : []),
          ...(options.more === true ? [column("more", TEXT)] : []),
        ],
        {
          checks: [
            { name: "k1", expression: "a > 0", ...text(["a", now]), origin: origin("k1", "0001_init.sql", 3) },
            { name: "k2", expression: "qty > 0", ...text(["qty"]), origin: origin("k2", "0001_init.sql", 4) },
          ],
          indexes: [
            { name: "i", columns: [], expressions: ["a + qty"], where: "a > 0", ...text(["a", now], ["qty"]), origin: origin("i", "0001_init.sql", 5) },
            { name: "plain", columns: ["qty"] },
          ],
        },
      ),
    ]);
  };
  const checkOf = (result: DatabaseSchema, name: string): CheckConstraint | undefined => tableOf(result).checks?.find((check) => check.name === name);

  test("a rename is followed in the names of the texts it reaches, and in no other: the plan arrives at what the after side says", () => {
    const { ops, result } = carried(tracked(["a"]), tracked(["a", "amount"]));
    assert.deepEqual(ops, ["renameColumn"]);
    assert.deepEqual([checkOf(result, "k1")?.names, checkOf(result, "k2")?.names], [names(["a", "amount"]), names(["qty"])]);
    assert.deepEqual(tableOf(result).indexes?.map((index) => index.names), [names(["a", "amount"], ["qty"]), undefined]);
  });

  test("a text is not stale by a name that it does not have, whatever takes that name afterwards", () => {
    // The case this is for: a column is renamed, and another takes its name. The check over `qty` is the check it was.
    const { ops, result } = carried(tracked(["a"]), tracked(["a", "amount"], { taken: true }));
    assert.deepEqual(ops, ["renameColumn", "addColumn"]);
    assert.deepEqual([checkOf(result, "k1")?.names, checkOf(result, "k2")?.names], [names(["a", "amount"]), names(["qty"])]);
  });

  test("a column that has the name again which a text has for it leaves the text as it was written", () => {
    const { ops, result } = carried(tracked(["a", "amount"]), tracked(["a", "amount", "a"]));
    assert.deepEqual(ops, ["renameColumn"]);
    assert.deepEqual(checkOf(result, "k1")?.names, names(["a"]));
    // Through several renames, the text's name stays and what it is called now follows.
    assert.deepEqual(checkOf(carried(tracked(["a"]), tracked(["a", "x", "y", "z"])).result, "k1")?.names, names(["a", "z"]));
  });

  test("a check that is written again over the column that took the name goes before the rename and comes after it", () => {
    const again = tracked(["a", "amount"], { taken: true });
    (tableOf(again).checks as CheckConstraint[])[0] = { name: "k1", expression: "a > 0", names: names(["a"]), origin: origin("k1", "0003_more.sql", 2) };
    const { ops, result } = carried(tracked(["a"]), again);
    assert.deepEqual(ops, ["dropCheck", "renameColumn", "addColumn", "addCheck"]);
    assert.deepEqual(checkOf(result, "k1"), { name: "k1", expression: "a > 0", names: names(["a"]), origin: origin("k1", "0003_more.sql", 2) });
    // A plan written by hand that renames and leaves the check does not arrive: its check is over the renamed column.
    const byHand: MigrationPlan = { version: 1, steps: diffSchemas(tracked(["a"]), again).changes.filter((change) => !/Check/.test(change.op)) as MigrationStep[] };
    refusedPlan(() => validatePlan(tracked(["a"]), byHand, again), 'The plan does not arrive at the schema it is for: dropCheck "k1" of table "t" is still to do, and 1 more change.');
  });

  test("a text of which the schema does not say what it names may be stale once a rename has reached its table", () => {
    const unknown = { known: false };
    const result = applyDiff(tracked(["a"], unknown), diffSchemas(tracked(["a"], unknown), tracked(["a", "amount"], unknown)));
    assert.deepEqual([checkOf(result, "k1"), checkOf(result, "k2")].map((check) => [check?.names, check?.mayBeStale]), [
      [undefined, true],
      [undefined, true],
    ]);
    assert.deepEqual(tableOf(result).indexes?.map((index) => [index.name, index.mayBeStale]), [
      ["i", true],
      // An index over columns alone has no text.
      ["plain", undefined],
    ]);
    // Nothing is said of a text that no rename has reached.
    const untouched = applyDiff(tracked(["a"], unknown), diffSchemas(tracked(["a"], unknown), tracked(["a"], { known: false, more: true })));
    assert.deepEqual(tableOf(untouched).checks?.map((check) => check.mayBeStale), [undefined, undefined]);
    // And the plan of such a pair arrives: the checks are the objects they were.
    carried(tracked(["a"], unknown), tracked(["a", "amount"], unknown));
  });

  const FEELING = origin("feeling", "0001_init.sql", 1);
  const moods = (name: string, values: string[], more: Partial<EnumType> = {}): EnumType => ({ name, values, origin: FEELING, ...(name !== "feeling" && { renames: [renamed("feeling", name)] }), ...more });
  const typed = (type: EnumType, text: { names?: ExpressionName[]; defaultNames?: ExpressionName[] }, tableName = "t"): DatabaseSchema =>
    schema(
      [
        table(
          tableName,
          [keyColumn("id"), column("state", enumType(type.name), { origin: origin("state", "0001_init.sql", 3) }), column("note", TEXT, { defaultExpression: "('sad'::feeling)::text", ...(text.defaultNames !== undefined && { defaultNames: text.defaultNames }), origin: origin("note", "0001_init.sql", 4) })],
          { checks: [{ name: "k", expression: "t.state <> 'sad'::feeling", ...(text.names !== undefined && { names: text.names }), origin: origin("k", "0001_init.sql", 5) }], origin: origin("t", "0001_init.sql", 2), ...(tableName !== "t" && { renames: [renamed("t", tableName)] }) },
        ),
      ],
      [type],
    );
  const written = (type: string, value = "sad", tableName = "t"): { names: ExpressionName[]; defaultNames: ExpressionName[] } => {
    const ofType: ExpressionName[] = [
      { kind: "type", name: "feeling", ...(type !== "feeling" && { now: type }) },
      { kind: "value", name: "sad", ...(value !== "sad" && { now: value }), type },
    ];
    return { names: [{ kind: "column", name: "state" }, { kind: "table", name: "t", ...(tableName !== "t" && { now: tableName }) }, ...ofType], defaultNames: ofType };
  };

  test("the renames of a table, of an enumerated type, and of a value are followed in a check and in a default", () => {
    const before = typed(moods("feeling", ["sad", "glad"]), written("feeling"));
    const after = typed(moods("mood", ["blue", "glad"], { valueRenames: [renamed("sad", "blue")] }), written("mood", "blue", "u"), "u");
    const { ops, result } = carried(before, after);
    assert.deepEqual(ops, ["renameEnumType", "renameEnumValue", "renameTable"]);
    assert.deepEqual(tableOf(result, "u").checks?.[0]?.names, written("mood", "blue", "u").names);
    assert.deepEqual(tableOf(result, "u").columns[2]?.defaultNames, written("mood", "blue", "u").defaultNames);
    // And back: every name is its thing's again.
    assert.deepEqual(tableOf(carried(after, before).result).checks?.[0]?.names, written("feeling").names);
  });

  test("a default of which the schema does not say what it names may be stale once a type or a value is renamed, and not when its table is", () => {
    const before = typed(moods("feeling", ["sad", "glad"]), {});
    /** The renames of a diff alone, as a plan written by hand: what a rename by itself leaves of the texts. */
    const renamesOf = (after: DatabaseSchema): DatabaseSchema => applyPlan(before, { version: 1, steps: diffSchemas(before, after).changes.filter((change) => change.op.startsWith("rename")) as MigrationStep[] });
    for (const after of [typed(moods("mood", ["sad", "glad"]), {}), typed(moods("feeling", ["blue", "glad"], { valueRenames: [renamed("sad", "blue")] }), {})]) {
      const result = renamesOf(after);
      assert.deepEqual([tableOf(result).columns[2]?.defaultMayBeStale, tableOf(result).checks?.[0]?.mayBeStale], [true, true]);
      // The diff of such a pair sets the default again: it has no object to be known by, and the plan arrives.
      assert.deepEqual(carried(before, after).ops.filter((op) => !op.startsWith("rename")), ["setDefault"]);
    }
    const moved = renamesOf(typed(moods("feeling", ["sad", "glad"]), {}, "u"));
    assert.deepEqual([tableOf(moved, "u").columns[2]?.defaultMayBeStale, tableOf(moved, "u").checks?.[0]?.mayBeStale], [undefined, true]);
  });

  test("a default that is set has what the change says of its text, and one that is dropped has nothing left", () => {
    const of = (defaults: Partial<ColumnSchema>): DatabaseSchema => schema([table("t", [keyColumn("id"), column("code", TEXT, defaults)])]);
    const stale: ExpressionName[] = [{ kind: "function", name: "slug", now: "make_slug" }];
    assert.deepEqual(tableOf(carried(of({}), of({ defaultExpression: "slug('x')", defaultNames: stale })).result).columns[1]?.defaultNames, stale);
    assert.deepEqual(tableOf(carried(of({}), of({ defaultExpression: "slug('x')", defaultMayBeStale: true })).result).columns[1]?.defaultMayBeStale, true);
    assert.deepEqual(tableOf(carried(of({ defaultExpression: "slug('x')", defaultNames: stale }), of({ defaultExpression: "slug('y')", defaultNames: [] })).result).columns[1]?.defaultNames, []);
    const dropped = tableOf(carried(of({ defaultExpression: "slug('x')", defaultNames: stale }), of({})).result).columns[1];
    assert.deepEqual([dropped?.defaultNames, dropped?.defaultMayBeStale, dropped?.defaultExpression], [undefined, undefined, undefined]);
    const replaced = tableOf(carried(of({ defaultExpression: "slug('x')", defaultMayBeStale: true }), of({ default: "x" })).result).columns[1];
    assert.deepEqual([replaced?.default, replaced?.defaultMayBeStale], ["x", undefined]);
  });

  test("what a schema says of a text is information: a change that says something else of it, of the same text, still fits", () => {
    const of = (text: Partial<CheckConstraint>): DatabaseSchema => schema([table("t", [keyColumn("id"), column("a")], { checks: [{ name: "k", expression: "a > 0", ...text }] })]);
    const bare = schema([table("t", [keyColumn("id"), column("a")])]);
    const diff = diffSchemas(of({ names: names(["a"]) }), bare);
    for (const text of [{}, { mayBeStale: true }, { names: names(["old", "a"]) }]) {
      assert.deepEqual(tableOf(applyDiff(of(text), diff)).checks, []);
    }
  });
});

describe("the rules of a plan: a column is not dropped while something is over it, carries it along, or names it", () => {
  const COLUMNS = (): ColumnSchema[] => [keyColumn("id"), column("a"), column("b", TEXT)];
  const dropped = (): DatabaseSchema => schema([table("t", [keyColumn("id"), column("b", TEXT)])]);
  /** What is in the way, the step that takes it away, why the column cannot go as a step, and why a schema without the column does not hold together. */
  const cases: [string, Partial<TableSchema>, string, string, string][] = [
    ["a check that names it", { checks: [{ name: "k", expression: "a > 0", names: [{ kind: "column", name: "a" }] }] }, "dropCheck", 'the check "k" names it.', 'the check "k" of table "t" names the column "a", which the table does not have.'],
    [
      "a check that names it by the name it had",
      { checks: [{ name: "k", expression: "old > 0", names: [{ kind: "column", name: "old", now: "a" }] }] },
      "dropCheck",
      'the check "k" names it.',
      'the check "k" of table "t" names the column "a", which the table does not have.',
    ],
    [
      "an index whose expression names it",
      { indexes: [{ name: "i", columns: [], expressions: ["a + 1"], names: [{ kind: "column", name: "a" }] }] },
      "dropIndex",
      'the index "i" names it in an expression or in its condition.',
      'the index "i" of table "t" names the column "a", which the table does not have.',
    ],
    [
      "an index whose condition names it",
      { indexes: [{ name: "i", columns: ["b"], where: "a > 0", names: [{ kind: "column", name: "a" }] }] },
      "dropIndex",
      'the index "i" names it in an expression or in its condition.',
      'the index "i" of table "t" names the column "a", which the table does not have.',
    ],
    ["an index that carries it along", { indexes: [{ name: "i", columns: ["b"], include: ["a"] }] }, "dropIndex", 'the index "i" carries it along.', 'the index "i" of table "t" is over the column "a", which the table does not have.'],
    [
      "a unique constraint that carries it along",
      { uniques: [{ name: "u", columns: ["b"], include: ["a"] }] },
      "dropUnique",
      'the unique constraint "u" carries it along.',
      'the unique constraint "u" of table "t" is over the column "a", which the table does not have.',
    ],
    [
      "a primary key that carries it along",
      { primaryKey: { name: "t_pkey", columns: ["id"], include: ["a"] } },
      "dropPrimaryKey",
      'the primary key "t_pkey" carries it along.',
      'the primary key "t_pkey" of table "t" is over the column "a", which the table does not have.',
    ],
  ];
  for (const [title, more, drop, reason, whole] of cases) {
    test(`${title}: it goes first, and where it stays the column cannot go`, () => {
      const before = schema([table("t", COLUMNS(), more)]);
      // The diff that takes both away: the thing goes before the column.
      const { ops } = (() => {
        const diff = diffSchemas(before, dropped());
        const plan = planMigration(before, diff);
        assertSameSchema(applyPlan(before, plan), dropped());
        return { ops: plan.steps.map((step) => step.op) };
      })();
      assert.deepEqual(ops.slice(0, 2), drop === "dropPrimaryKey" ? ["dropPrimaryKey", "dropColumn"] : [drop, "dropColumn"]);
      // A schema that keeps the thing and has no such column does not hold together: PostgreSQL drops the thing with the column, and says nothing.
      const column = diffSchemas(before, dropped()).changes.filter((change) => change.op === "dropColumn");
      for (const run of [() => applyDiff(before, { diffVersion: 1, changes: column }), () => planMigration(before, { diffVersion: 1, changes: column })]) {
        assert.throws(run, (error: unknown) => error instanceof DiffApplicationError && new RegExp(`^The diff leaves a schema that does not hold together: ${whole.replace(/[()]/g, "\\$&")}$`).test(error.message));
      }
      // And as a step, the column cannot go while the thing is there.
      refusedPlan(() => validatePlan(before, { version: 1, steps: column as MigrationStep[] }), `Step 1, dropColumn "t"."a": ${reason}`);
    });
  }

  test("a check or an index of which the schema does not say what it names is not known to name the column: nothing is refused for it", () => {
    const before = schema([table("t", COLUMNS(), { checks: [{ name: "k", expression: "b <> ''" }], indexes: [{ name: "i", columns: [], expressions: ["lower(b)"] }] })]);
    const after = schema([table("t", [keyColumn("id"), column("b", TEXT)], { checks: [{ name: "k", expression: "b <> ''" }], indexes: [{ name: "i", columns: [], expressions: ["lower(b)"] }] })]);
    assert.deepEqual(
      planMigration(before, diffSchemas(before, after)).steps.map((step) => step.op),
      ["dropColumn"],
    );
  });

  test("a text that names another column is not in the way", () => {
    const text: Partial<TableSchema> = { checks: [{ name: "k", expression: "b <> ''", names: [{ kind: "column", name: "b" }] }], indexes: [{ name: "i", columns: [], expressions: ["lower(b)"], names: [{ kind: "column", name: "b" }] }] };
    const before = schema([table("t", COLUMNS(), text)]);
    const after = schema([table("t", [keyColumn("id"), column("b", TEXT)], text)]);
    assert.deepEqual(
      planMigration(before, diffSchemas(before, after)).steps.map((step) => step.op),
      ["dropColumn"],
    );
  });
});
