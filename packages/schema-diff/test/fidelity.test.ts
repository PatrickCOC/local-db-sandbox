import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ColumnSchema, EnumType, ExpressionName, IndexDefinition, SchemaOrigin, TableSchema } from "../../runtime/src/index.ts";
import { formatSchemaDiff, stableStringify, stringifySchemaDiff } from "../src/index.ts";
import { diffSchemas } from "../src/index.ts";
import { INTEGER, TEXT, changes, column, enumType, keyColumn, ops, origin, renamed, schema, table } from "./support.ts";

/*
 * What an index and a constraint are beyond their columns, and what a rename
 * leaves of an expression's text (D-040): the diff tells two indexes apart by
 * how they are built and by their keys, two constraints by whether they are
 * deferrable, and does not take a text with stale names for what it reads as.
 */

/** A table `t` (id, a, b, c) with one index. */
const indexed = (index: Partial<IndexDefinition> & { columns: string[] }, more: Partial<TableSchema> = {}) =>
  schema([table("t", [keyColumn("id"), column("a"), column("b", TEXT), column("c", TEXT)], { indexes: [{ name: "i", ...index }], ...more })]);
/** The same index dropped and added: what a difference between two definitions of one index is. */
const replaced = (before: Partial<IndexDefinition> & { columns: string[] }, after: Partial<IndexDefinition> & { columns: string[] }): void => {
  assert.deepEqual(ops(indexed(before), indexed(after)), ["dropIndex", "addIndex"], `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  assert.deepEqual(ops(indexed(after), indexed(before)), ["dropIndex", "addIndex"]);
};
const same = (before: Partial<IndexDefinition> & { columns: string[] }, after: Partial<IndexDefinition> & { columns: string[] }): void => {
  assert.deepEqual(changes(indexed(before), indexed(after)), [], `${JSON.stringify(before)} = ${JSON.stringify(after)}`);
};

describe("schema diff: how an index is built, and its keys", () => {
  test("an index of another method is another index", () => {
    replaced({ columns: ["a"] }, { columns: ["a"], method: "gin" });
    replaced({ columns: ["a"], method: "gin" }, { columns: ["a"], method: "gist" });
    replaced({ columns: ["a"], method: "hash" }, { columns: ["a"] });
    same({ columns: ["a"], method: "gin" }, { columns: ["a"], method: "gin" });
  });

  test("the same keys in another order are another index", () => {
    replaced({ columns: ["a", "b"], keys: [{ column: "a" }, { column: "b", order: "desc" }] }, { columns: ["b", "a"], keys: [{ column: "b", order: "desc" }, { column: "a" }] });
    replaced({ columns: ["a", "b"] }, { columns: ["b", "a"] });
  });

  test("a key in another order, with its NULLs elsewhere, with another operator class or collation, is another index", () => {
    replaced({ columns: ["a"] }, { columns: ["a"], keys: [{ column: "a", order: "desc" }] });
    replaced({ columns: ["a"], keys: [{ column: "a", order: "desc" }] }, { columns: ["a"], keys: [{ column: "a", order: "desc", nulls: "last" }] });
    replaced({ columns: ["a"] }, { columns: ["a"], keys: [{ column: "a", nulls: "first" }] });
    replaced({ columns: ["b"] }, { columns: ["b"], keys: [{ column: "b", operatorClass: "text_pattern_ops" }] });
    replaced({ columns: ["b"], keys: [{ column: "b", collation: "C" }] }, { columns: ["b"], keys: [{ column: "b", collation: "de_DE" }] });
    same({ columns: ["b"], keys: [{ column: "b", collation: "C", order: "desc" }] }, { columns: ["b"], keys: [{ order: "desc", collation: "C", column: "b" }] });
  });

  test("an expression has its place among the columns: the same keys in another place are another index", () => {
    const first = { columns: ["a"], expressions: ["lower(b)"], keys: [{ expression: "lower(b)" }, { column: "a" }] };
    const last = { columns: ["a"], expressions: ["lower(b)"], keys: [{ column: "a" }, { expression: "lower(b)" }] };
    replaced(first, last);
    same(first, { ...first, keys: [{ expression: "lower(b)" }, { column: "a" }] });
    // An index that lists its columns and expressions apart does not say where they stand: it is not known to be either.
    replaced({ columns: ["a"], expressions: ["lower(b)"] }, first);
    same({ columns: ["a"], expressions: ["lower(b)"] }, { columns: ["a"], expressions: ["lower(b)"] });
    // The text of an expression is compared as text, apart from its layout.
    same({ columns: [], expressions: ["lower( b )"] }, { columns: [], expressions: ["lower( b  )"] });
    replaced({ columns: [], expressions: ["lower(b)"] }, { columns: [], expressions: ["upper(b)"] });
  });

  test("an index that carries other columns along, or takes two NULLs for the same, is another index", () => {
    replaced({ columns: ["a"] }, { columns: ["a"], include: ["b"] });
    replaced({ columns: ["a"], include: ["b"] }, { columns: ["a"], include: ["b", "c"] });
    // What is carried along is not ordered.
    same({ columns: ["a"], include: ["b", "c"] }, { columns: ["a"], include: ["c", "b"] });
    replaced({ columns: ["a"], unique: true }, { columns: ["a"], unique: true, nullsNotDistinct: true });
  });

  test("an index that says something the schema has no place for is another index than one that does not, or says something else", () => {
    replaced({ columns: ["a"] }, { columns: ["a"], sourceClauses: ["WITH (fillfactor=70)"] });
    replaced({ columns: ["a"], sourceClauses: ["WITH (fillfactor=70)"] }, { columns: ["a"], sourceClauses: ["WITH (fillfactor=90)"] });
    same({ columns: ["a"], sourceClauses: ["WITH (fillfactor=70)"] }, { columns: ["a"], sourceClauses: ["WITH (fillfactor=70)"] });
  });

  test("the changes say all of it", () => {
    const before = { columns: ["a"] };
    const after = { columns: ["a", "b"], unique: true, method: "btree_gist", keys: [{ column: "a" }, { column: "b", order: "desc" as const, nulls: "last" as const, operatorClass: "text_ops", collation: "C" }], include: ["c"], nullsNotDistinct: true, where: "a > 0", sourceClauses: ["TABLESPACE fast"] };
    assert.deepEqual(changes(indexed(before), indexed(after)), [
      { op: "dropIndex", table: "t", index: "i", before: { name: "i", columns: ["a"], unique: false } },
      {
        op: "addIndex",
        table: "t",
        index: "i",
        after: {
          name: "i",
          columns: ["a", "b"],
          unique: true,
          where: "a > 0",
          method: "btree_gist",
          keys: [{ column: "a" }, { column: "b", order: "desc", nulls: "last", operatorClass: "text_ops", collation: "C" }],
          include: ["c"],
          nullsNotDistinct: true,
          sourceClauses: ["TABLESPACE fast"],
        },
      },
    ]);
  });

  test("a renamed column is the same column in a key and among what is carried along", () => {
    const columns = (name: string): ColumnSchema[] => [keyColumn("id"), column(name, INTEGER, name === "a" ? { origin: origin("a") } : { origin: origin("a"), renames: [renamed("a", name)] }), column("b", TEXT), column("c", TEXT)];
    const before = schema([table("t", columns("a"), { indexes: [{ name: "i", columns: ["b", "a"], keys: [{ column: "b" }, { column: "a", order: "desc" }] }, { name: "j", columns: ["b"], include: ["a"] }] })]);
    const after = schema([table("t", columns("amount"), { indexes: [{ name: "i", columns: ["b", "amount"], keys: [{ column: "b" }, { column: "amount", order: "desc" }] }, { name: "j", columns: ["b"], include: ["amount"] }] })]);
    assert.deepEqual(ops(before, after), ["renameColumn"]);
  });
});

describe("schema diff: whether a constraint is deferrable, and what else a constraint says", () => {
  const parent = table("p", [keyColumn("id"), column("a"), column("b")], { primaryKey: { name: "p_pkey", columns: ["id"] }, uniques: [{ name: "p_ab", columns: ["a", "b"] }] });
  const withTable = (extra: Partial<TableSchema>, columns: ColumnSchema[] = [keyColumn("id"), column("x"), column("a"), column("b")]) => schema([parent, table("c", columns, extra)]);

  test("a unique constraint that is deferrable, carries columns along, or takes two NULLs for the same, is another constraint", () => {
    const unique = (more: object) => withTable({ uniques: [{ name: "u", columns: ["x"], ...more }] });
    for (const more of [{ deferrable: "immediate" }, { deferrable: "deferred" }, { include: ["a"] }, { nullsNotDistinct: true }, { sourceClauses: ["WITH (fillfactor=70)"] }]) {
      assert.deepEqual(ops(unique({}), unique(more)), ["dropUnique", "addUnique"], JSON.stringify(more));
      assert.deepEqual(changes(unique(more), unique(more)), []);
    }
    assert.deepEqual(ops(unique({ deferrable: "immediate" }), unique({ deferrable: "deferred" })), ["dropUnique", "addUnique"]);
    assert.deepEqual(changes(unique({ include: ["a", "b"] }), unique({ include: ["b", "a"] })), []);
    assert.deepEqual(changes(unique({}), unique({ deferrable: "deferred", include: ["a"], nullsNotDistinct: true }))[1], {
      op: "addUnique",
      table: "c",
      constraint: "u",
      after: { name: "u", columns: ["x"], include: ["a"], deferrable: "deferred", nullsNotDistinct: true },
    });
  });

  test("a primary key that is deferrable, or carries columns along, is another key", () => {
    const keyed = (more: object) => withTable({ primaryKey: { name: "c_pkey", columns: ["id"], ...more } });
    assert.deepEqual(ops(keyed({}), keyed({ deferrable: "deferred" })), ["dropPrimaryKey", "addPrimaryKey"]);
    assert.deepEqual(ops(keyed({ include: ["x"] }), keyed({})), ["dropPrimaryKey", "addPrimaryKey"]);
    assert.deepEqual(changes(keyed({ deferrable: "immediate", include: ["x"] }), keyed({ deferrable: "immediate", include: ["x"] })), []);
    assert.deepEqual(changes(keyed({}), keyed({ deferrable: "deferred", include: ["x"], sourceClauses: ["USING INDEX TABLESPACE fast"] }))[1], {
      op: "addPrimaryKey",
      table: "c",
      constraint: "c_pkey",
      after: { name: "c_pkey", columns: ["id"], include: ["x"], deferrable: "deferred", sourceClauses: ["USING INDEX TABLESPACE fast"] },
    });
  });

  test("a foreign key that is deferrable is another foreign key, over one column or several", () => {
    const one = (more: object) => withTable({}, [keyColumn("id"), column("x", INTEGER, { references: { table: "p", column: "id", name: "c_x_fkey", ...more } }), column("a"), column("b")]);
    const several = (more: object) => withTable({ foreignKeys: [{ name: "c_pair", columns: ["a", "b"], references: { table: "p", columns: ["a", "b"] }, ...more }] });
    for (const keyed of [one, several]) {
      assert.deepEqual(ops(keyed({}), keyed({ deferrable: "deferred" })), ["dropForeignKey", "addForeignKey"]);
      assert.deepEqual(ops(keyed({ deferrable: "deferred" }), keyed({ deferrable: "immediate" })), ["dropForeignKey", "addForeignKey"]);
      assert.deepEqual(ops(keyed({}), keyed({ sourceClauses: ["MATCH FULL"] })), ["dropForeignKey", "addForeignKey"]);
      assert.deepEqual(changes(keyed({ deferrable: "deferred", sourceClauses: ["MATCH FULL"] }), keyed({ deferrable: "deferred", sourceClauses: ["MATCH FULL"] })), []);
    }
    assert.deepEqual(changes(one({}), one({ deferrable: "deferred", sourceClauses: ["MATCH FULL"] }))[1], {
      op: "addForeignKey",
      table: "c",
      constraint: "c_x_fkey",
      after: { name: "c_x_fkey", columns: ["x"], references: { table: "p", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION", deferrable: "deferred", sourceClauses: ["MATCH FULL"] },
    });
  });

  test("a check that says something the schema has no place for is another check than one that does not", () => {
    const checked = (more: object) => withTable({ checks: [{ name: "k", expression: "x > 0", ...more }] });
    assert.deepEqual(ops(checked({}), checked({ sourceClauses: ["NO INHERIT"] })), ["dropCheck", "addCheck"]);
    assert.deepEqual(changes(checked({ sourceClauses: ["NOT VALID"] }), checked({ sourceClauses: ["NOT VALID"] })), []);
  });
});

/*
 * An expression is text, and a rename leaves the text as it was. Two texts
 * that read alike say the same when every name in them is the same thing's
 * on both sides (D-040). The schemas here say what a collector says: what a
 * text names, and what each of those things is called now.
 */
describe("schema diff: two expressions that read alike, and what their texts name", () => {
  const A: ExpressionName = { kind: "column", name: "a" };
  const STALE: ExpressionName = { kind: "column", name: "a", now: "amount" };
  /** A table with a check written as `a > 0` when its column was `a`; `renamed`: the column has been renamed since. */
  const checked = (renamedSince: boolean, more: { origin?: boolean; second?: boolean; names?: ExpressionName[] | null; provenance?: boolean; mayBeStale?: boolean } = {}) =>
    schema([
      table(
        "t",
        [
          keyColumn("id"),
          column(renamedSince ? "amount" : "a", INTEGER, more.provenance === false ? {} : renamedSince ? { origin: origin("a", "0001_init.sql", 2), renames: [renamed("a", "amount")] } : { origin: origin("a", "0001_init.sql", 2) }),
          ...(more.second === true ? [column("a", TEXT, { origin: origin("a", "0003_more.sql") })] : []),
        ],
        {
          checks: [
            {
              name: "k",
              expression: "a > 0",
              ...(more.names !== null && more.mayBeStale !== true && { names: more.names ?? [renamedSince ? STALE : A] }),
              ...(more.mayBeStale === true && { mayBeStale: true }),
              ...(more.origin !== false && { origin: origin("k", "0001_init.sql", 3) }),
            },
          ],
        },
      ),
    ]);
  const ofChecks = (list: string[]): string[] => list.filter((op) => /Check/.test(op));

  test("are one expression when the renames lead from what the one side calls its names to what the other does", () => {
    for (const origin of [true, false]) {
      // The usual case: a column that a check names is renamed. PostgreSQL has the check under the new name by itself.
      assert.deepEqual(ops(checked(false, { origin }), checked(true, { origin })), ["renameColumn"]);
      // And when another column takes the old name afterwards, the check is still the one it was.
      assert.deepEqual(ops(checked(false, { origin }), checked(true, { origin, second: true })), ["renameColumn", "addColumn"]);
      assert.deepEqual(changes(checked(true, { origin }), checked(true, { origin })), []);
    }
  });

  test("are two when they do not lead there, also for one object", () => {
    for (const origin of [true, false]) {
      // A later state before an earlier one: nothing says that `amount` is the column that is `a` afterwards.
      assert.deepEqual(ofChecks(ops(checked(true, { origin }), checked(false, { origin }))), ["dropCheck", "addCheck"]);
      // Nothing says that the two columns are one: the before side's `a` goes, and the after side's text names what is `amount` there.
      assert.deepEqual(ops(checked(false, { origin, provenance: false }), checked(true, { origin, provenance: false })), ["dropCheck", "dropColumn", "addColumn", "addCheck"]);
      // The after side's text names something else than the column.
      assert.deepEqual(ofChecks(ops(checked(false, { origin }), checked(true, { origin, names: [{ kind: "column", name: "a", now: "id" }] }))), ["dropCheck", "addCheck"]);
    }
  });

  test("say in the change what the text names, so that whoever carries the diff out knows", () => {
    const added = changes(schema([table("t", [keyColumn("id"), column("amount")])]), checked(true, { origin: false })).find((change) => change.op === "addCheck");
    assert.deepEqual(added, { op: "addCheck", table: "t", constraint: "k", after: { name: "k", expression: "a > 0", names: [STALE] } });
    const flagged = changes(schema([table("t", [keyColumn("id"), column("amount")])]), checked(true, { origin: false, mayBeStale: true })).find((change) => change.op === "addCheck");
    assert.deepEqual(flagged, { op: "addCheck", table: "t", constraint: "k", after: { name: "k", expression: "a > 0", mayBeStale: true } });
  });

  /*
   * The hazard: `price` is renamed, another column takes the name, and a
   * check that reads `price > 0` is written again. Neither text is stale, and
   * they read alike; the one is over the renamed column, the other over the
   * new one.
   */
  const FIRST = origin("positive", "0001_init.sql", 3);
  const AGAIN = origin("positive", "0003_more.sql", 3);
  const priced = (after: boolean, more: { taken?: boolean; names?: string[] | null; origin?: SchemaOrigin } = {}) => {
    const named = more.names === undefined ? ["price"] : more.names;
    return schema([
      table(
        "products",
        [
          keyColumn("id"),
          column(after ? "price_cents" : "price", INTEGER, { origin: origin("price", "0001_init.sql", 2), ...(after && { renames: [renamed("price", "price_cents")] }) }),
          column("qty"),
          ...(after && more.taken !== false ? [column("price", INTEGER, { origin: origin("price", "0003_more.sql", 2) })] : []),
        ],
        { checks: [{ name: "positive", expression: `${(named ?? ["qty"])[0]} > 0`, ...(named !== null && { names: named.map((name): ExpressionName => ({ kind: "column", name })) }), origin: more.origin ?? (after ? AGAIN : FIRST) }] },
      ),
    ]);
  };

  test("are two when a name of the one side is another thing's on the other: a column is renamed, and another takes its name", () => {
    const list = changes(priced(false), priced(true));
    assert.deepEqual(
      list.map((change) => change.op),
      ["dropCheck", "renameColumn", "addColumn", "addCheck"],
    );
    assert.deepEqual(list.at(-1), { op: "addCheck", table: "products", constraint: "positive", after: { name: "positive", expression: "price > 0", names: [{ kind: "column", name: "price" }], origin: AGAIN } });
    // Also when the two are said to be one object: the names of the one are not the names of the other.
    assert.deepEqual(ops(priced(false), priced(true, { origin: FIRST })), ["dropCheck", "renameColumn", "addColumn", "addCheck"]);
  });

  test("are one when the text names none of what is renamed, whatever takes the name", () => {
    assert.deepEqual(ops(priced(false, { names: ["qty"] }), priced(true, { names: ["qty"] })), ["renameColumn", "addColumn"]);
    assert.deepEqual(ops(priced(false, { names: ["qty"] }), priced(true, { names: ["qty"], taken: false })), ["renameColumn"]);
  });

  test("are two when a column goes and another is renamed to its name", () => {
    const names: ExpressionName[] = [{ kind: "column", name: "n" }];
    const dropped = schema([table("t", [keyColumn("id"), column("n", INTEGER, { origin: origin("n", "0001_init.sql", 2) }), column("x", INTEGER, { origin: origin("x", "0001_init.sql", 3) })], { checks: [{ name: "k", expression: "n > 0", names, origin: FIRST }] })]);
    const taken = schema([table("t", [keyColumn("id"), column("n", INTEGER, { origin: origin("x", "0001_init.sql", 3), renames: [renamed("x", "n")] })], { checks: [{ name: "k", expression: "n > 0", names, origin: AGAIN }] })]);
    assert.deepEqual(ops(dropped, taken), ["dropCheck", "dropColumn", "renameColumn", "addCheck"]);
  });

  /*
   * A schema that does not say what its texts name: one written by hand, by
   * an ORM, or by an earlier format. Its texts are taken to be written in
   * the names it has.
   */
  test("of a schema that does not say what its texts name, are one where no rename of the diff can reach them", () => {
    const plain = (name: string) => schema([table("t", [keyColumn("id"), column(name)], { checks: [{ expression: "id > 0" }] })]);
    assert.deepEqual(ops(plain("a"), plain("b")), ["dropColumn", "addColumn"]);
    assert.deepEqual(changes(plain("a"), plain("a")), []);
  });

  test("of a schema that does not say what its texts name, are one object's across a rename, and two otherwise", () => {
    // One object: the check that was there is there.
    assert.deepEqual(ops(priced(false, { names: null }), priced(true, { names: null, origin: FIRST })), ["renameColumn", "addColumn"]);
    // Two: a rename of a column of the table may have reached the one, and nothing says whether it did.
    assert.deepEqual(ops(priced(false, { names: null }), priced(true, { names: null })), ["dropCheck", "renameColumn", "addColumn", "addCheck"]);
    assert.deepEqual(ops(priced(false, { names: null }), priced(true, { names: null, taken: false })), ["dropCheck", "renameColumn", "addCheck"]);
  });

  test("of which one side says what its text names, are compared by that: the other side's text is taken as it is written", () => {
    // The after side's text names `price`, which is another column there than the before side's.
    assert.deepEqual(ops(priced(false, { names: null }), priced(true, { names: ["price"], origin: FIRST })), ["dropCheck", "renameColumn", "addColumn", "addCheck"]);
    // And it names `qty`, which is the column it was: of one object.
    assert.deepEqual(ops(priced(false, { names: null }), priced(true, { names: ["qty"], origin: FIRST })), ["renameColumn", "addColumn"]);
    // Of two, a rename may have reached the text whose names are not known.
    assert.deepEqual(ops(priced(false, { names: null }), priced(true, { names: ["qty"] })), ["dropCheck", "renameColumn", "addColumn", "addCheck"]);
  });

  test("of which a text may be stale, are one object's, and two otherwise: unless both may be and nothing is renamed between them", () => {
    assert.deepEqual(ops(checked(false, { names: null }), checked(true, { mayBeStale: true })), ["renameColumn"]);
    assert.deepEqual(changes(checked(true, { mayBeStale: true }), checked(true, { mayBeStale: true })), []);
    assert.deepEqual(changes(checked(true, { mayBeStale: true, origin: false }), checked(true, { mayBeStale: true, origin: false })), []);
    assert.deepEqual(ofChecks(ops(checked(true, { mayBeStale: true, origin: false }), checked(true, { origin: false }))), ["dropCheck", "addCheck"]);
    assert.deepEqual(ofChecks(ops(checked(true, { origin: false }), checked(true, { mayBeStale: true, origin: false }))), ["dropCheck", "addCheck"]);
    assert.deepEqual(ofChecks(ops(checked(false, { mayBeStale: true, origin: false }), checked(true, { mayBeStale: true, origin: false }))), ["dropCheck", "addCheck"]);
  });

  test("hold for the expressions and the condition of an index, and not for an index over columns alone", () => {
    const indexed = (renamedSince: boolean, more: { origin?: SchemaOrigin; second?: boolean; plain?: boolean } = {}) =>
      schema([
        table(
          "t",
          [keyColumn("id"), column(renamedSince ? "amount" : "a", INTEGER, renamedSince ? { origin: origin("a"), renames: [renamed("a", "amount")] } : { origin: origin("a") }), ...(more.second === true ? [column("a", INTEGER, { origin: origin("a", "0003_more.sql") })] : [])],
          {
            indexes: [
              more.plain === true
                ? { name: "i", columns: ["id"], ...(more.origin !== undefined && { origin: more.origin }) }
                : { name: "i", columns: [], expressions: ["a + 1"], where: "a > 0", names: [renamedSince && more.second !== true ? STALE : A], ...(more.origin !== undefined && { origin: more.origin }) },
            ],
          },
        ),
      ]);
    assert.deepEqual(ops(indexed(false, { origin: FIRST }), indexed(true, { origin: FIRST })), ["renameColumn"]);
    assert.deepEqual(ops(indexed(false), indexed(true)), ["renameColumn"]);
    // Written again over the column that took the name: neither text is stale.
    assert.deepEqual(ops(indexed(false, { origin: FIRST }), indexed(true, { origin: AGAIN, second: true })), ["dropIndex", "renameColumn", "addColumn", "addIndex"]);
    // An index over columns alone has no text: it is the index it was, whatever is renamed around it.
    assert.deepEqual(ops(indexed(false, { origin: FIRST, plain: true }), indexed(true, { origin: AGAIN, second: true, plain: true })), ["renameColumn", "addColumn"]);
    // One that is stale says so where it is added.
    const added = changes(schema([table("t", [keyColumn("id"), column("amount")])]), indexed(true)).find((change) => change.op === "addIndex");
    assert.deepEqual(added?.op === "addIndex" && added.after.names, [STALE]);
  });

  /** A column whose default is an expression that names an enumerated type, and the schema's types. */
  const TEXT_OF = "('sad'::feeling)::text";
  const named = (type: string, was = type, value = "sad"): ExpressionName[] => [
    { kind: "type", name: was, ...(type !== was && { now: type }) },
    { kind: "value", name: "sad", ...(value !== "sad" && { now: value }), type },
  ];
  const defaulted = (types: EnumType[], names: ExpressionName[] | null, expression = TEXT_OF, more: Partial<ColumnSchema> = {}) =>
    schema([table("t", [keyColumn("id"), column("code", TEXT, { defaultExpression: expression, ...(names !== null && { defaultNames: names }), origin: origin("code", "0001_init.sql", 2), ...more })])], types);
  const FEELING = origin("feeling", "0001_init.sql", 1);
  const feeling = (name = "feeling", history: [string, string][] = [], more: Partial<EnumType> = {}): EnumType => ({
    name,
    values: ["sad", "glad"],
    origin: FEELING,
    ...(history.length > 0 && { renames: history.map(([from, to], index) => renamed(from, to, "0002_rename.sql", index + 1)) }),
    ...more,
  });
  const MOOD = feeling("mood", [["feeling", "mood"]]);

  test("hold for a default that is an expression, which has no object of its own", () => {
    // The type was renamed between the two, and the after side's text is stale by just that.
    assert.deepEqual(ops(defaulted([feeling()], named("feeling")), defaulted([MOOD], named("mood", "feeling"))), ["renameEnumType"]);
    // Renamed twice.
    const twice = feeling("emotion", [
      ["feeling", "mood"],
      ["mood", "emotion"],
    ]);
    assert.deepEqual(ops(defaulted([feeling()], named("feeling")), defaulted([twice], named("emotion", "feeling"))), ["renameEnumType"]);
    // Stale on both sides in the same way.
    assert.deepEqual(changes(defaulted([MOOD], named("mood", "feeling")), defaulted([MOOD], named("mood", "feeling"))), []);
    // Stale before, and current afterwards: it was written again, and names what has the name now.
    const again = { name: "feeling", values: ["sad"] };
    assert.deepEqual(ops(defaulted([MOOD], named("mood", "feeling")), defaulted([MOOD, again], named("feeling"))), ["addEnumType", "setDefault"]);
    // The after side's text names a type that is not the one the before side's names.
    assert.deepEqual(ops(defaulted([feeling()], named("feeling")), defaulted([MOOD, { name: "other", values: ["sad"] }], named("other", "feeling"))), ["renameEnumType", "addEnumType", "setDefault"]);
  });

  test("hold for a default when another type takes the name that a renamed type gives up", () => {
    const taken = { name: "feeling", values: ["sad"], origin: origin("feeling", "0003_more.sql") };
    const list = changes(defaulted([feeling()], named("feeling")), defaulted([MOOD, taken], named("feeling")));
    assert.deepEqual(
      list.map((change) => change.op),
      ["renameEnumType", "addEnumType", "setDefault"],
    );
    assert.deepEqual(list.at(-1), {
      op: "setDefault",
      table: "t",
      column: "code",
      // What it was, in the names the after side has: its text named the type that is `mood` there.
      before: { kind: "expression", expression: TEXT_OF, names: named("mood", "feeling") },
      after: { kind: "expression", expression: TEXT_OF, names: named("feeling") },
    });
    // A default that names none of it is the default it was.
    assert.deepEqual(ops(defaulted([feeling()], [], "upper('x')"), defaulted([MOOD, taken], [], "upper('x')")), ["renameEnumType", "addEnumType"]);
    // One of which it is not known what it names is not followed through a rename of a type: it has no object to be known by.
    assert.deepEqual(ops(defaulted([feeling()], null, "upper('x')"), defaulted([MOOD], null, "upper('x')")), ["renameEnumType", "setDefault"]);
    assert.deepEqual(changes(defaulted([feeling()], null, "upper('x')"), defaulted([feeling()], null, "upper('x')")), []);
  });

  test("what a default was is said in the names the after side has: a renamed type and value have their new names in what its text named", () => {
    const blue = feeling("mood", [["feeling", "mood"]], { values: ["blue", "glad"], valueRenames: [renamed("sad", "blue", "0002_rename.sql", 2)] });
    const list = changes(defaulted([feeling()], named("feeling")), defaulted([blue], [], "upper('x')"));
    assert.deepEqual(
      list.map((change) => change.op),
      ["renameEnumType", "renameEnumValue", "setDefault"],
    );
    assert.deepEqual(list.at(-1), {
      op: "setDefault",
      table: "t",
      column: "code",
      before: { kind: "expression", expression: TEXT_OF, names: named("mood", "feeling", "blue") },
      after: { kind: "expression", expression: "upper('x')", names: [] },
    });
    // A default that is dropped is said the same way.
    const dropped = changes(defaulted([feeling()], named("feeling")), schema([table("t", [keyColumn("id"), column("code", TEXT, { origin: origin("code", "0001_init.sql", 2) })])], [blue])).at(-1);
    assert.deepEqual(dropped, { op: "dropDefault", table: "t", column: "code", before: { kind: "expression", expression: TEXT_OF, names: named("mood", "feeling", "blue") } });
  });

  test("hold for a default that may be stale", () => {
    const flagged = { defaultMayBeStale: true };
    assert.deepEqual(changes(defaulted([feeling()], null, TEXT_OF, flagged), defaulted([feeling()], null, TEXT_OF, flagged)), []);
    const [set] = changes(defaulted([feeling()], named("feeling")), defaulted([feeling()], null, TEXT_OF, flagged));
    assert.deepEqual(set, { op: "setDefault", table: "t", column: "code", before: { kind: "expression", expression: TEXT_OF, names: named("feeling") }, after: { kind: "expression", expression: TEXT_OF, mayBeStale: true } });
  });

  test("of a schema that does not say what its texts name, are two across a rename of their table, and across a rename of a value of an enumerated type", () => {
    // Two objects, and nothing says what either text names: the table's name, or the value's, may be in the one and not in the other.
    const moved = (after: boolean) => schema([table(after ? "u" : "t", [keyColumn("id")], { checks: [{ name: "k", expression: "id > 0" }], origin: origin("t"), ...(after && { renames: [renamed("t", "u")] }) })]);
    assert.deepEqual(ops(moved(false), moved(true)), ["dropCheck", "renameTable", "addCheck"]);
    const valued = (after: boolean) =>
      schema(
        [table("t", [keyColumn("id"), column("note", TEXT)], { checks: [{ name: "k", expression: "note <> 'sad'" }] })],
        [feeling("feeling", [], { values: after ? ["blue", "glad"] : ["sad", "glad"], ...(after && { valueRenames: [renamed("sad", "blue")] }) })],
      );
    assert.deepEqual(ops(valued(false), valued(true)), ["dropCheck", "renameEnumValue", "addCheck"]);
    // With nothing renamed between them, they are compared as text, as they always were.
    assert.deepEqual(changes(moved(true), moved(true)), []);
    assert.deepEqual(changes(valued(true), valued(true)), []);
  });

  test("hold for a value of an enumerated type that a text names", () => {
    const valued = (values: string[], more: { now?: string; origin?: SchemaOrigin; history?: boolean } = {}) =>
      schema(
        [
          table("t", [keyColumn("id"), column("state", enumType("feeling"))], {
            checks: [
              {
                name: "k",
                expression: "state <> 'sad'",
                names: [
                  { kind: "column", name: "state" },
                  { kind: "value", name: "sad", ...(more.now !== undefined && { now: more.now }), type: "feeling" },
                ],
                origin: more.origin ?? FIRST,
              },
            ],
          }),
        ],
        [feeling("feeling", [], { values, ...(more.history !== false && values.includes("blue") && { valueRenames: [renamed("sad", "blue")] }) })],
      );
    assert.deepEqual(ops(valued(["sad", "glad"]), valued(["blue", "glad"], { now: "blue" })), ["renameEnumValue"]);
    assert.deepEqual(ops(valued(["sad", "glad"]), valued(["blue", "glad"], { now: "blue", origin: AGAIN })), ["renameEnumValue"]);
    // Nothing says that `sad` is the value that is `blue` afterwards: the one goes and the other comes.
    assert.deepEqual(ofChecks(ops(valued(["sad", "glad"]), valued(["blue", "glad"], { now: "blue", history: false }))), ["dropCheck", "addCheck"]);
    // Another value takes the name, and the check is written again: it reads the same, and is over the new value.
    assert.deepEqual(ops(valued(["sad", "glad"]), valued(["blue", "glad", "sad"], { origin: AGAIN })), ["dropCheck", "renameEnumValue", "addEnumValue", "addCheck"]);
    // The check that was there is over the value that was renamed.
    assert.deepEqual(ops(valued(["sad", "glad"]), valued(["blue", "glad", "sad"], { now: "blue" })), ["renameEnumValue", "addEnumValue"]);
  });

  test("hold for a value of a type that is renamed, by the type the value is of", () => {
    const valued = (type: EnumType, names: ExpressionName[]) => schema([table("t", [keyColumn("id"), column("note", TEXT)], { checks: [{ name: "k", expression: "note <> ('sad'::feeling)::text", names: [{ kind: "column", name: "note" }, ...names] }] })], [type, { name: "weather", values: ["sad", "sunny"] }]);
    assert.deepEqual(ops(valued(feeling(), named("feeling")), valued(MOOD, named("mood", "feeling"))), ["renameEnumType"]);
    // The value is said to be another type's than the one that was renamed.
    assert.deepEqual(ops(valued(feeling(), named("feeling")), valued(MOOD, [{ kind: "type", name: "feeling", now: "mood" }, { kind: "value", name: "sad", type: "weather" }])), ["dropCheck", "renameEnumType", "addCheck"]);
  });

  test("are two when both sides say what the text names, and one names what the other does not", () => {
    const naming = (names: ExpressionName[]) => schema([table("t", [keyColumn("id"), column("a"), column("b")], { checks: [{ name: "k", expression: "a > 0", names }] })]);
    const a: ExpressionName = { kind: "column", name: "a" };
    assert.deepEqual(ops(naming([a]), naming([a, { kind: "column", name: "b" }])), ["dropCheck", "addCheck"]);
    assert.deepEqual(ops(naming([a, { kind: "column", name: "b" }]), naming([a])), ["dropCheck", "addCheck"]);
    assert.deepEqual(ops(naming([a]), naming([])), ["dropCheck", "addCheck"]);
    // The order they are listed in says nothing.
    assert.deepEqual(changes(naming([a, { kind: "column", name: "b" }]), naming([{ kind: "column", name: "b" }, a])), []);
  });

  test("hold for the name of the table in a text", () => {
    const qualified = (after: boolean, now?: string) =>
      schema([
        table(after ? "u" : "t", [keyColumn("id"), column("a")], {
          checks: [
            {
              name: "k",
              expression: "t.a > 0",
              names: [
                { kind: "column", name: "a" },
                { kind: "table", name: "t", ...(now !== undefined && { now }) },
              ],
            },
          ],
          origin: origin("t"),
          ...(after && { renames: [renamed("t", "u")] }),
        }),
      ]);
    assert.deepEqual(ops(qualified(false), qualified(true, "u")), ["renameTable"]);
    assert.deepEqual(changes(qualified(true, "u"), qualified(true, "u")), []);
    // The text says that its table is called something that the table is not called.
    assert.deepEqual(ofChecks(ops(qualified(false), qualified(true, "v"))), ["dropCheck", "addCheck"]);
    // Written again after the rename, in the old name: that is no name of the table any more.
    assert.deepEqual(ofChecks(ops(qualified(false), qualified(true))), ["dropCheck", "addCheck"]);
  });

  test("take a function, and a type that is not enumerated, for the one it was in one object, and for the same in two when both sides call it the same", () => {
    for (const kind of ["function", "type"] as const) {
      const stale: ExpressionName[] = [{ kind, name: "slug", now: "make_slug" }];
      const called = (names: ExpressionName[], origin: SchemaOrigin | undefined) =>
        schema([table("t", [keyColumn("id"), column("a", TEXT)], { checks: [{ name: "k", expression: "slug(a) <> ''", names: [{ kind: "column", name: "a" }, ...names], ...(origin !== undefined && { origin }) }] })]);
      // The diff knows no functions. Of one object, a function that was renamed is the one it was.
      assert.deepEqual(changes(called([], FIRST), called(stale, FIRST)), []);
      // Of two objects, nothing says so.
      assert.deepEqual(ops(called([], FIRST), called(stale, AGAIN)), ["dropCheck", "addCheck"]);
      assert.deepEqual(ops(called([], undefined), called(stale, undefined)), ["dropCheck", "addCheck"]);
      assert.deepEqual(changes(called(stale, undefined), called(stale, undefined)), []);
    }
    // A default has no object of its own.
    const stale: ExpressionName[] = [{ kind: "function", name: "slug", now: "make_slug" }];
    const defaultOf = (names: ExpressionName[]) => schema([table("t", [keyColumn("id"), column("code", TEXT, { defaultExpression: "slug('x')", defaultNames: names, origin: origin("code") })])]);
    const [set] = changes(defaultOf([]), defaultOf(stale));
    assert.deepEqual(set, { op: "setDefault", table: "t", column: "code", before: { kind: "expression", expression: "slug('x')", names: [] }, after: { kind: "expression", expression: "slug('x')", names: stale } });
    assert.deepEqual(changes(defaultOf(stale), defaultOf(stale)), []);
  });

  test("leave a default that the runtime computes to what it computes, whatever its text names", () => {
    const now = (names: ExpressionName[]) => schema([table("t", [keyColumn("id"), column("at", TEXT, { defaultFunction: "current_timestamp", defaultExpression: "now()", defaultNames: names })])]);
    assert.deepEqual(changes(now([]), now([{ kind: "function", name: "now", now: "then" }])), []);
  });

  test("what a text names is no difference by itself, and does not change a diff's bytes when there is none", () => {
    const plain = stringifySchemaDiff(diffSchemas(checked(false, { names: null }), checked(false, { names: null })));
    assert.equal(stringifySchemaDiff(diffSchemas(checked(true), checked(true))), plain);
    assert.equal(stringifySchemaDiff(diffSchemas(checked(false, { names: null }), checked(false))), plain);
  });
});

describe("schema diff: the bytes of a diff that has all of it", () => {
  /** The same value with the keys of every object in the reverse of the order they were given in. */
  const keysReversed = <T>(value: T): T => {
    if (Array.isArray(value)) {
      return value.map(keysReversed) as T;
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, inner]) => [key, keysReversed(inner)]),
      ) as T;
    }
    return value;
  };
  const columns = (reference: Partial<ColumnSchema> = {}): ColumnSchema[] => [column("id", INTEGER, { nullable: false }), column("a"), column("b", TEXT), column("c", TEXT), column("p_id", INTEGER, reference)];
  const before = () => schema([table("p", [keyColumn("id")]), table("t", columns())]);
  const after = () =>
    schema([
      table("p", [keyColumn("id")]),
      table("t", columns({ references: { table: "p", column: "id", name: "t_p", onDelete: "CASCADE", deferrable: "deferred", sourceClauses: ["MATCH FULL"] } }), {
        primaryKey: { name: "t_pkey", columns: ["id"], include: ["a"], deferrable: "immediate", sourceClauses: ["USING INDEX TABLESPACE fast"] },
        uniques: [{ name: "t_b", columns: ["b"], include: ["c"], deferrable: "deferred", nullsNotDistinct: true, sourceClauses: ["WITH (fillfactor=70)"] }],
        checks: [
          {
            name: "k",
            expression: "a > 0 and b <> 'sad'",
            names: [
              { kind: "column", name: "a", now: "amount" },
              { kind: "value", name: "sad", now: "blue", type: "mood" },
            ],
            sourceClauses: ["NO INHERIT"],
            origin: origin("k", "0001_init.sql", 3),
          },
          { name: "old", expression: "c <> ''", mayBeStale: true },
        ],
        indexes: [
          {
            name: "i",
            columns: ["a", "b"],
            unique: true,
            method: "gist",
            keys: [{ column: "a" }, { column: "b", order: "desc", nulls: "last", operatorClass: "text_ops", collation: "C" }],
            include: ["c"],
            nullsNotDistinct: true,
            where: "a > 0",
            names: [{ kind: "column", name: "a" }],
            sourceClauses: ["TABLESPACE fast"],
          },
          { name: "m", columns: ["a"], expressions: ["lower(b)"], keys: [{ expression: "lower(b)" }, { column: "a", order: "desc" }], mayBeStale: true },
        ],
      }),
    ]);

  test("every member has its place in the text of a change, in one fixed order", () => {
    assert.deepEqual(
      diffSchemas(before(), after()).changes.map((change) => stableStringify(change)),
      [
        `{"op":"addPrimaryKey","table":"t","constraint":"t_pkey","after":{"name":"t_pkey","columns":["id"],"include":["a"],"deferrable":"immediate","sourceClauses":["USING INDEX TABLESPACE fast"]}}`,
        `{"op":"addUnique","table":"t","constraint":"t_b","after":{"name":"t_b","columns":["b"],"include":["c"],"deferrable":"deferred","nullsNotDistinct":true,"sourceClauses":["WITH (fillfactor=70)"]}}`,
        `{"op":"addCheck","table":"t","constraint":"k","after":{"name":"k","expression":"a > 0 and b <> 'sad'","names":[{"kind":"column","name":"a","now":"amount"},{"kind":"value","name":"sad","now":"blue","type":"mood"}],"sourceClauses":["NO INHERIT"],"origin":{"name":"k","file":"0001_init.sql","line":3,"sha256":"sha256-of-0001_init.sql","source":"test","statement":3}}}`,
        `{"op":"addCheck","table":"t","constraint":"old","after":{"name":"old","expression":"c <> ''","mayBeStale":true}}`,
        `{"op":"addIndex","table":"t","index":"i","after":{"name":"i","columns":["a","b"],"unique":true,"where":"a > 0","method":"gist","keys":[{"column":"a"},{"column":"b","order":"desc","nulls":"last","operatorClass":"text_ops","collation":"C"}],"include":["c"],"nullsNotDistinct":true,"names":[{"kind":"column","name":"a"}],"sourceClauses":["TABLESPACE fast"]}}`,
        `{"op":"addIndex","table":"t","index":"m","after":{"name":"m","columns":["a"],"expressions":["lower(b)"],"unique":false,"keys":[{"expression":"lower(b)"},{"column":"a","order":"desc"}],"mayBeStale":true}}`,
        `{"op":"addForeignKey","table":"t","constraint":"t_p","after":{"name":"t_p","columns":["p_id"],"references":{"table":"p","columns":["id"]},"onDelete":"CASCADE","onUpdate":"NO ACTION","deferrable":"deferred","sourceClauses":["MATCH FULL"]}}`,
      ],
    );
  });

  test("the same two schemas give the same bytes, whatever order their objects got their keys in", () => {
    const text = stringifySchemaDiff(diffSchemas(before(), after()));
    assert.equal(stringifySchemaDiff(diffSchemas(before(), after())), text);
    assert.equal(stringifySchemaDiff(diffSchemas(keysReversed(before()), keysReversed(after()))), text);
    // And backwards: what goes is said with all it was.
    const back = stringifySchemaDiff(diffSchemas(after(), before()));
    assert.equal(stringifySchemaDiff(diffSchemas(keysReversed(after()), keysReversed(before()))), back);
    assert.notEqual(back, text);
  });
});

describe("schema diff: lines for people", () => {
  test("say how an index is built, its keys with what each says, and what it carries along", () => {
    const before = schema([table("t", [keyColumn("id"), column("a"), column("b", TEXT)])]);
    const after = schema([
      table("t", [keyColumn("id"), column("a"), column("b", TEXT)], {
        indexes: [
          { name: "by_tags", columns: ["b"], method: "gin", keys: [{ column: "b", operatorClass: "gin_trgm_ops" }] },
          { name: "ordered", columns: ["a", "b"], unique: true, keys: [{ column: "a", order: "desc", nulls: "last" }, { column: "b", collation: "C" }], include: ["id"], nullsNotDistinct: true, where: "a > 0" },
          { name: "mixed", columns: ["a"], expressions: ["lower(b)"], keys: [{ expression: "lower(b)" }, { column: "a" }], sourceClauses: ["WITH (fillfactor=70)"] },
        ],
        uniques: [{ name: "u", columns: ["a"], deferrable: "deferred", include: ["b"], nullsNotDistinct: true }],
      }),
    ]);
    assert.deepEqual(formatSchemaDiff(diffSchemas(before, after)), [
      "4 changes:",
      "  + unique t (a) include (b) nulls not distinct deferrable initially deferred [u]",
      "  + index by_tags on t using gin (b gin_trgm_ops)",
      "  + index mixed on t (lower(b), a); not held by the schema: WITH (fillfactor=70)",
      "  + unique index ordered on t (a desc nulls last, b collate C) include (id) nulls not distinct where a > 0",
    ]);
  });

  test("say of a foreign key and a primary key what they are beyond their columns, and of an expression which of its names are stale", () => {
    const before = schema([table("p", [keyColumn("id")], { primaryKey: { name: "p_pkey", columns: ["id"] } }), table("t", [column("id", INTEGER, { nullable: false }), column("amount"), column("p")])]);
    const after = schema([
      table("p", [keyColumn("id")], { primaryKey: { name: "p_pkey", columns: ["id"] } }),
      table("t", [keyColumn("id"), column("amount"), column("p", INTEGER, { references: { table: "p", column: "id", name: "t_p", onDelete: "CASCADE", deferrable: "deferred", sourceClauses: ["MATCH FULL"] } })], {
        primaryKey: { name: "t_pkey", columns: ["id"], deferrable: "immediate", include: ["amount"] },
        checks: [
          {
            name: "k",
            expression: "old_t.a > 0 and id > 0 and kind <> 'x'",
            names: [
              { kind: "column", name: "a", now: "amount" },
              { kind: "column", name: "id" },
              { kind: "table", name: "old_t", now: "t" },
              { kind: "value", name: "x", now: "y", type: "state" },
            ],
          },
          { name: "m", expression: "amount > 1", mayBeStale: true },
          { name: "n", expression: "amount > 2", names: [{ kind: "column", name: "amount" }] },
        ],
      }),
    ]);
    assert.deepEqual(formatSchemaDiff(diffSchemas(before, after)), [
      "5 changes:",
      "  + primary key t (id) include (amount) deferrable [t_pkey]",
      '  + check t (old_t.a > 0 and id > 0 and kind <> \'x\') [k]; its text has names that are stale: column "a" is "amount" now, table "old_t" is "t" now, value "x" of "state" is "y" now',
      "  + check t (amount > 1) [m]; its text may be stale: what it names is not known, and a rename may have reached it",
      "  + check t (amount > 2) [n]",
      "  + foreign key t (p) -> p (id) on delete cascade deferrable initially deferred [t_p]; not held by the schema: MATCH FULL",
    ]);
  });

  test("say of a default that is set to a text it had what the matter is", () => {
    const defaulted = (more: Partial<ColumnSchema>) => schema([table("t", [keyColumn("id"), column("code", TEXT, { defaultExpression: "slug('x')", ...more })])]);
    const line = (before: Partial<ColumnSchema>, after: Partial<ColumnSchema>): string | undefined => formatSchemaDiff(diffSchemas(defaulted(before), defaulted(after)))[1];
    assert.equal(line({ defaultNames: [] }, { defaultNames: [{ kind: "function", name: "slug", now: "make_slug" }] }), "  ~ column t.code: default slug('x') -> slug('x'); its text has names that are stale: function \"slug\" is \"make_slug\" now");
    assert.equal(line({ defaultNames: [] }, { defaultMayBeStale: true }), "  ~ column t.code: default slug('x') -> slug('x'); its text may be stale: what it names is not known, and a rename may have reached it");
    assert.equal(line({ defaultNames: [{ kind: "function", name: "slug", now: "make_slug" }] }, { defaultNames: [] }), "  ~ column t.code: default slug('x') -> slug('x'); it reads as it did, and does not name what it named");
  });
});
