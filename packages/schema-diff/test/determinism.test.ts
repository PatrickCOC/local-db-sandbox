import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHANGE_ORDER, diffSchemas, stableStringify, stringifySchemaDiff } from "../src/index.ts";
import type { SchemaChange } from "../src/index.ts";
import type { DatabaseSchema, TableSchema } from "../../runtime/src/index.ts";
import { exampleAfter, exampleBefore } from "./example.ts";
import { INTEGER, TEXT, TIMESTAMPTZ, changes, column, keyColumn, origin, renamed, schema, table } from "./support.ts";

/** A change as one line: its kind, and what it is a change of. */
function summary(change: SchemaChange): string {
  const target = "enum" in change ? change.enum : change.table;
  let item = "";
  if (change.op === "renameEnumValue") {
    item = `${change.from}->${change.to}`;
  } else if (change.op === "dropCheck" || change.op === "addCheck") {
    item = change.constraint ?? `(${(change.op === "dropCheck" ? change.before : change.after).expression})`;
  } else if ("column" in change) {
    item = change.column;
  } else if ("constraint" in change && change.constraint !== undefined) {
    item = change.constraint;
  } else if ("index" in change) {
    item = change.index;
  } else if ("value" in change) {
    item = change.value;
  }
  return `${change.op} ${target}${item === "" ? "" : ` ${item}`}`;
}

describe("schema diff: the order of the changes", () => {
  test("changes are listed by kind in a fixed order, and within a kind by table or type and then by name", () => {
    assert.deepEqual(changes(exampleBefore(), exampleAfter()).map(summary), [
      // What goes, under the names the before side has: the table is still called users.
      "dropForeignKey posts posts_author_id_fkey",
      // A constraint without a name is ordered by its definition.
      "dropCheck users (name <> '')",
      "dropCheck users users_age_check",
      "dropIndex users users_age_idx",
      "dropColumn posts title",
      "dropTable old_logs",
      // The renames.
      "renameEnumType post_status",
      "renameEnumValue post_status live->public",
      "renameTable accounts",
      "renameColumn accounts full_name",
      "renameConstraint posts posts_key",
      // What comes and what changes, under the names the after side has.
      "addEnumType kind",
      "addEnumValue mood great",
      "addEnumValue post_status review",
      "addTable audit",
      "addTable comments",
      "addColumn accounts created_at",
      "addColumn accounts kind",
      "addColumn posts slug",
      "alterColumnType accounts age",
      "setNotNull accounts age",
      "dropEnumType legacy",
      "addUnique accounts accounts_full_name_key",
      "addCheck accounts (full_name <> '')",
      "addCheck accounts users_age_check",
      "addIndex accounts accounts_created_idx",
      "addIndex comments comments_post_idx",
      "addForeignKey comments comments_post_id_fkey",
      "addForeignKey posts posts_author_id_fkey",
    ]);
  });

  test("the kinds come in the order of CHANGE_ORDER, which names every kind once", () => {
    const kinds = changes(exampleBefore(), exampleAfter()).map((change) => CHANGE_ORDER.indexOf(change.op));
    assert.ok(kinds.every((rank) => rank >= 0));
    assert.deepEqual(kinds, [...kinds].sort((a, b) => a - b));
    assert.equal(new Set(CHANGE_ORDER).size, CHANGE_ORDER.length);
  });

  test("names are ordered by their code points, not by a locale", () => {
    const names = ["b", "B", "a", "_a", "Z", "ä", "a1", "a_"];
    const before = schema([table("t", [keyColumn("id")])]);
    const after = schema([table("t", [keyColumn("id"), ...names.map((name) => column(name))])]);
    assert.deepEqual(
      changes(before, after).map((change) => ("column" in change ? change.column : "")),
      ["B", "Z", "_a", "a", "a1", "a_", "b", "ä"],
    );
  });

  test("code points, not the units a JavaScript string is made of: a character beyond U+FFFF comes after one below it", () => {
    // U+FF5E is one unit; U+1F600 is two units, and both compare below it.
    const names = ["\u{1F600}", "～", "a"];
    const before = schema([table("t", [keyColumn("id")])]);
    const after = schema([table("t", [keyColumn("id"), ...names.map((name) => column(name))])]);
    assert.deepEqual(
      changes(before, after).map((change) => ("column" in change ? change.column : "")),
      ["a", "～", "\u{1F600}"],
    );
  });

  test("the values added to one type keep the order in which they can be added, whatever their names", () => {
    const before = schema([], [{ name: "e", values: ["m"] }]);
    const after = schema([], [{ name: "e", values: ["z", "m", "b", "a"] }]);
    assert.deepEqual(changes(before, after), [
      { op: "addEnumValue", enum: "e", value: "z", beforeValue: "m" },
      { op: "addEnumValue", enum: "e", value: "b", afterValue: "m" },
      { op: "addEnumValue", enum: "e", value: "a", afterValue: "b" },
    ]);
  });
});

/** A copy of a value in which every object's keys were added in the opposite order. */
function withKeysReversed<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(withKeysReversed) as T;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, inner]) => [key, withKeysReversed(inner)]),
    ) as T;
  }
  return value;
}

type Reorder = <T>(list: T[]) => T[];

const REORDERINGS: Record<string, Reorder> = {
  reversed: (list) => [...list].reverse(),
  "rotated by one": (list) => [...list.slice(1), ...list.slice(0, 1)],
  "odd places first": (list) => [...list.filter((_item, index) => index % 2 === 1), ...list.filter((_item, index) => index % 2 === 0)],
};

/** The same schema with its tables, types, constraints, and indexes listed in another order. Columns keep theirs. */
function reordered(source: DatabaseSchema, reorder: Reorder): DatabaseSchema {
  const tables = source.tables.map(
    (entry): TableSchema => ({
      ...entry,
      ...(entry.uniques !== undefined && { uniques: reorder(entry.uniques) }),
      ...(entry.foreignKeys !== undefined && { foreignKeys: reorder(entry.foreignKeys) }),
      ...(entry.indexes !== undefined && { indexes: reorder(entry.indexes) }),
      ...(entry.checks !== undefined && { checks: reorder(entry.checks) }),
    }),
  );
  return { tables: reorder(tables), types: { enums: reorder(source.types.enums) } };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("schema diff: determinism", () => {
  const text = (before: DatabaseSchema, after: DatabaseSchema): string => stringifySchemaDiff(diffSchemas(before, after));
  const forward = text(exampleBefore(), exampleAfter());
  const backward = text(exampleAfter(), exampleBefore());

  test("the same two schemas give the same bytes every time", () => {
    assert.equal(text(exampleBefore(), exampleAfter()), forward);
    assert.equal(text(structuredClone(exampleBefore()), structuredClone(exampleAfter())), forward);
    assert.notEqual(forward, backward);
    assert.equal(JSON.parse(forward).changes.length, 29);
  });

  test("the order in which a schema lists its tables, types, constraints, and indexes does not show in the diff", () => {
    for (const [first, reorderFirst] of Object.entries(REORDERINGS)) {
      for (const [second, reorderSecond] of Object.entries(REORDERINGS)) {
        assert.equal(text(reordered(exampleBefore(), reorderFirst), reordered(exampleAfter(), reorderSecond)), forward, `before ${first}, after ${second}`);
        assert.equal(text(reordered(exampleAfter(), reorderFirst), reordered(exampleBefore(), reorderSecond)), backward, `backward: before ${first}, after ${second}`);
      }
    }
  });

  test("the order in which objects got their keys does not show in the diff", () => {
    assert.equal(text(withKeysReversed(exampleBefore()), withKeysReversed(exampleAfter())), forward);
    assert.equal(text(withKeysReversed(reordered(exampleBefore(), REORDERINGS.reversed!)), exampleAfter()), forward);
  });

  test("two schemas that list the same things in different orders have no differences", () => {
    for (const reorder of Object.values(REORDERINGS)) {
      assert.deepEqual(changes(exampleAfter(), withKeysReversed(reordered(exampleAfter(), reorder))), []);
      assert.deepEqual(changes(reordered(exampleBefore(), reorder), exampleBefore()), []);
    }
  });

  test("a schema that makes no sense is still compared the same way in whatever order it lists things", () => {
    // Two columns that both claim to be the renamed x: the first by name is taken to be it, the other is new.
    const before = schema([table("t", [keyColumn("id"), column("x", INTEGER, { origin: origin("x") })])]);
    const claimants = [column("z", INTEGER, { origin: origin("x"), renames: [renamed("x", "z")] }), column("y", INTEGER, { origin: origin("x"), renames: [renamed("x", "y")] })];
    const oneWay = schema([table("t", [keyColumn("id"), ...claimants])]);
    const otherWay = schema([table("t", [keyColumn("id"), ...[...claimants].reverse()])]);
    assert.deepEqual(changes(before, oneWay).map(summary), ["renameColumn t y", "addColumn t z"]);
    assert.equal(text(before, otherWay), text(before, oneWay));
  });

  test("the schemas that are compared are not changed, and the diff shares nothing with them", () => {
    const before = deepFreeze(exampleBefore());
    const after = deepFreeze(exampleAfter());
    const diff = diffSchemas(before, after);
    assert.equal(stringifySchemaDiff(diff), forward);
    // Every part of the diff can be changed without reaching a schema: nothing in it is one of their (frozen) objects.
    const visit = (value: unknown): void => {
      if (typeof value === "object" && value !== null) {
        assert.equal(Object.isFrozen(value), false);
        Object.values(value).forEach(visit);
      }
    };
    visit(diff);
  });

  test("two constraints that are alike but for where they come from are listed in one order", () => {
    const duplicated = (first: string, second: string): DatabaseSchema =>
      schema([
        table("t", [keyColumn("id"), column("a")], {
          checks: [
            { expression: "a > 0", origin: origin("c", first, 1) },
            { expression: "a > 0", origin: origin("c", second, 1) },
          ],
        }),
      ]);
    const none = schema([table("t", [keyColumn("id"), column("a")])]);
    assert.equal(text(duplicated("0001.sql", "0002.sql"), none), text(duplicated("0002.sql", "0001.sql"), none));
    assert.equal(text(none, duplicated("0001.sql", "0002.sql")), text(none, duplicated("0002.sql", "0001.sql")));
    // And inside a table that is dropped.
    assert.equal(text(duplicated("0001.sql", "0002.sql"), schema([])), text(duplicated("0002.sql", "0001.sql"), schema([])));
  });

  test("of two constraints that are alike, which one stays does not depend on the order they are listed in", () => {
    const withChecks = (checks: { expression: string; origin?: ReturnType<typeof origin> }[]): DatabaseSchema => schema([table("t", [keyColumn("id"), column("a")], { checks })]);
    // Alike but for where they come from: one of them is the after side's, the other is dropped.
    const [first, second] = [{ expression: "a > 0", origin: origin("c", "0001.sql", 1) }, { expression: "a > 0", origin: origin("c", "0002.sql", 1) }] as const;
    const one = withChecks([{ expression: "a > 0" }]);
    assert.equal(text(withChecks([first, second]), one), text(withChecks([second, first]), one));
    assert.equal(text(one, withChecks([first, second])), text(one, withChecks([second, first])));
    // Alike but for their layout, and nothing else to tell them apart.
    const [tight, loose] = [{ expression: "a > 0" }, { expression: "a  >  0" }] as const;
    assert.equal(text(withChecks([tight, loose]), one), text(withChecks([loose, tight]), one));
    assert.equal(text(one, withChecks([tight, loose])), text(one, withChecks([loose, tight])));
    const none = withChecks([]);
    assert.equal(text(withChecks([tight, loose]), none), text(withChecks([loose, tight]), none));
    assert.equal(text(none, withChecks([tight, loose])), text(none, withChecks([loose, tight])));
    assert.match(text(withChecks([tight, loose]), none), /"expression": "a {2}> {2}0"[^]*"expression": "a > 0"/);
  });

  test("the keys of a constant default are written by code point, like every other key, and none is lost", () => {
    const before = schema([table("t", [keyColumn("id")])]);
    const after = schema([table("t", [keyColumn("id"), column("c", INTEGER, { default: JSON.parse('{"b": 1, "a": 1, "2": 1, "10": 1, "__proto__": 1}') as unknown })])]);
    assert.match(text(before, after), /"value": \{\n\s+"10": 1,\n\s+"2": 1,\n\s+"__proto__": 1,\n\s+"a": 1,\n\s+"b": 1\n\s+\}/);
  });

  test("stable JSON is the JSON of the same value with its keys in order: the same layout, and what JSON leaves out is left out", () => {
    // Keys that are in the fixed order already, so that the two texts can be compared as they are.
    const values: unknown[] = [
      { a: 1, b: undefined, c: [1, undefined, { d: null, e: undefined }], f: {}, g: [], h: "text \" \\ \n  ", i: -0.5, j: true },
      [[], [[]], {}, [{}], null, "x"],
      { when: new Date("2026-10-07T08:00:00.000Z") },
      "text",
      12,
      null,
      {},
      [],
    ];
    for (const value of values) {
      assert.equal(stableStringify(value), JSON.stringify(value));
      assert.equal(stableStringify(value, 2), JSON.stringify(value, null, 2));
    }
    // A member that is undefined is no member, wherever it would have been written.
    assert.equal(stableStringify({ op: undefined, z: 1, a: undefined }), '{"z":1}');
  });

  test("a default that is an object is copied into the diff, not shared with the schema", () => {
    const before = deepFreeze(schema([table("t", [keyColumn("id"), column("c", INTEGER, { default: { a: [1, { b: 2 }] } })])]));
    const after = deepFreeze(schema([table("t", [keyColumn("id"), column("c", INTEGER, { default: { a: [1, { b: 3 }] } }), column("d", INTEGER, { default: { x: { y: 1 } } })])]));
    const visit = (value: unknown): void => {
      if (typeof value === "object" && value !== null) {
        assert.equal(Object.isFrozen(value), false);
        Object.values(value).forEach(visit);
      }
    };
    visit(diffSchemas(before, after));
    visit(diffSchemas(after, before));
  });

  test("the text of a diff: two spaces of indentation, and every object's keys in one fixed order", () => {
    const before = schema([table("t", [keyColumn("id"), column("x", INTEGER, { origin: origin("x") })])]);
    const after = schema([table("t", [keyColumn("id"), column("y", INTEGER, { origin: origin("x"), renames: [renamed("x", "y")] }), column("note", TEXT, { nullable: false, default: "" })])]);
    assert.equal(
      text(before, after),
      `{
  "diffVersion": 1,
  "changes": [
    {
      "op": "renameColumn",
      "table": "t",
      "column": "y",
      "from": "x",
      "evidence": {
        "origin": {
          "name": "x",
          "file": "0001_init.sql",
          "line": 1,
          "sha256": "sha256-of-0001_init.sql",
          "source": "test",
          "statement": 1
        },
        "renames": [
          {
            "from": "x",
            "to": "y",
            "at": {
              "file": "0002_rename.sql",
              "line": 1,
              "sha256": "sha256-of-0002_rename.sql",
              "source": "test",
              "statement": 1
            }
          }
        ]
      }
    },
    {
      "op": "addColumn",
      "table": "t",
      "column": "note",
      "after": {
        "name": "note",
        "type": {
          "storage": "text",
          "canonical": {
            "kind": "text"
          },
          "declared": "text"
        },
        "nullable": false,
        "default": {
          "kind": "value",
          "value": ""
        }
      }
    }
  ]
}`,
    );
    assert.equal(stringifySchemaDiff(diffSchemas(before, before)), '{\n  "diffVersion": 1,\n  "changes": []\n}');
    assert.equal(stringifySchemaDiff(diffSchemas(before, before), 0), '{"diffVersion":1,"changes":[]}');
  });
});

describe("schema diff: what is not a difference", () => {
  /** One table with a key, a constraint of each kind, and an index; `provenance` is put on everything. */
  function described(provenance: (name: string) => object, spelling: { integer: string; now: string } = { integer: "integer", now: "now()" }): DatabaseSchema {
    const integer = { ...INTEGER, declaredType: spelling.integer };
    return schema(
      [
        table(
          "t",
          [
            keyColumn("id", integer, { ...provenance("id"), sourceDialectType: { dialect: "any", type: spelling.integer } }),
            column("owner", integer, { ...provenance("owner"), references: { table: "t", column: "id", name: "t_owner_fkey", ...provenance("t_owner_fkey") } }),
            column("at", TIMESTAMPTZ, { ...provenance("at"), defaultFunction: "current_timestamp", defaultExpression: spelling.now }),
          ],
          {
            ...provenance("t"),
            primaryKey: { name: "t_pkey", columns: ["id"], ...provenance("t_pkey") },
            uniques: [{ name: "t_owner_key", columns: ["owner"], ...provenance("t_owner_key") }],
            foreignKeys: [{ name: "t_pair_fkey", columns: ["id", "owner"], references: { table: "t", columns: ["owner", "id"] }, ...provenance("t_pair_fkey") }],
            indexes: [{ name: "t_at_idx", columns: ["at"], ...provenance("t_at_idx") }],
            checks: [{ name: "t_owner_check", expression: "owner > 0", ...provenance("t_owner_check") }],
          },
        ),
      ],
      [{ name: "mood", values: ["ok"], ...provenance("mood"), sourceDialectType: { dialect: "any", type: spelling.integer } }],
    );
  }
  const none = (): object => ({});
  const from = (file: string, generatedName = false) => (name: string): object => ({ origin: { ...origin(name, file, 7), ...(generatedName && { generatedName: true }) } });

  test("provenance alone: the same schema from another source, another file, or with no provenance at all", () => {
    const variants = [described(none), described(from("0001_init.sql")), described(from("9999_squashed.sql")), described(from("0001_init.sql", true))];
    for (const before of variants) {
      for (const after of variants) {
        assert.deepEqual(changes(before, after), []);
      }
    }
  });

  test("a history of renames that led to the same names", () => {
    const plain = described(from("0001_init.sql"));
    const renamedOnce = described((name) => ({ origin: origin(`old_${name}`, "0001_init.sql", 7), renames: [renamed(`old_${name}`, name)] }));
    assert.deepEqual(changes(plain, renamedOnce), []);
    assert.deepEqual(changes(renamedOnce, plain), []);
    assert.deepEqual(changes(renamedOnce, renamedOnce), []);
  });

  test("spellings: how a type or a computed default was written, and how the source's dialect names a type", () => {
    assert.deepEqual(changes(described(none, { integer: "integer", now: "now()" }), described(none, { integer: "int4", now: "CURRENT_TIMESTAMP" })), []);
  });
});
