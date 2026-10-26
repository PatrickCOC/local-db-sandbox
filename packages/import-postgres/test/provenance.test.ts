import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type { ObjectProvenance, SchemaRename } from "../../runtime/src/index.ts";
import { collect, column, table } from "./support.ts";

/*
 * What the collected schema says about where its objects come from (D-036):
 * the statement that created each (`origin`), the explicit renames since
 * (`renames`), the schema's enumerated types with their history, and the
 * primary key as a constraint.
 */

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** An origin as `[file, statement, line, name created with, name was generated]`. */
function originOf(entry: ObjectProvenance | undefined): [string, number, number, string, boolean] | undefined {
  const origin = entry?.origin;
  return origin === undefined ? undefined : [origin.file, origin.statement, origin.line, origin.name, origin.generatedName === true];
}

/** Renames as `[from, to, file, statement, line]`. */
function renamesOf(renames: SchemaRename[] | undefined): [string, string, string, number, number][] | undefined {
  return renames?.map((entry) => [entry.from, entry.to, entry.at.file, entry.at.statement, entry.at.line]);
}

describe("provenance of the collected schema", () => {
  const INIT = [
    "create type mood as enum ('ok', 'meh');", // statement 1, line 1
    "",
    "create table pairs (x int, y int, primary key (x, y));", // statement 2, line 3
    "create table t (", // statement 3, line 4
    "  id int primary key,",
    "  pair_x int,",
    "  pair_y int,",
    "  owner int references t,",
    "  code text unique,",
    "  constraint t_code_filled check (code <> ''),",
    "  foreign key (pair_x, pair_y) references pairs",
    ");",
    "create index t_code_lower on t (lower(code));", // statement 4, line 13
  ].join("\n");
  const MORE = [
    "-- a comment before the first statement",
    "alter table t add column note text, add constraint t_note_once unique (note);", // statement 1, line 2
    "alter table t add check (id > 0);", // statement 2, line 3
  ].join("\n");

  test("every object carries the statement that created it: file, statement number, line, and the name it was created with", async () => {
    const result = await collect({ "0001_init.sql": INIT, "0002_more.sql": MORE });
    const found = table(result, "t");

    assert.deepEqual(originOf(result.types.enums[0]), ["0001_init.sql", 1, 1, "mood", false]);
    assert.deepEqual(originOf(table(result, "pairs")), ["0001_init.sql", 2, 3, "pairs", false]);
    assert.deepEqual(originOf(table(result, "pairs").primaryKey), ["0001_init.sql", 2, 3, "pairs_pkey", true]);
    assert.deepEqual(originOf(found), ["0001_init.sql", 3, 4, "t", false]);
    // A column of CREATE TABLE has the statement's position, not the line it is written on.
    assert.deepEqual(
      found.columns.map(originOf),
      [
        ["0001_init.sql", 3, 4, "id", false],
        ["0001_init.sql", 3, 4, "pair_x", false],
        ["0001_init.sql", 3, 4, "pair_y", false],
        ["0001_init.sql", 3, 4, "owner", false],
        ["0001_init.sql", 3, 4, "code", false],
        ["0002_more.sql", 1, 2, "note", false],
      ],
    );
    assert.deepEqual(originOf(found.primaryKey), ["0001_init.sql", 3, 4, "t_pkey", true]);
    assert.deepEqual(originOf(column(result, "t", "owner").references), ["0001_init.sql", 3, 4, "t_owner_fkey", true]);
    assert.deepEqual(found.foreignKeys?.map(originOf), [["0001_init.sql", 3, 4, "t_pair_x_pair_y_fkey", true]]);
    assert.deepEqual(found.uniques?.map(originOf), [
      ["0001_init.sql", 3, 4, "t_code_key", true],
      ["0002_more.sql", 1, 2, "t_note_once", false],
    ]);
    assert.deepEqual(found.checks?.map(originOf), [
      ["0001_init.sql", 3, 4, "t_code_filled", false],
      ["0002_more.sql", 2, 3, "t_id_check", true],
    ]);
    assert.deepEqual(found.indexes?.map(originOf), [["0001_init.sql", 4, 13, "t_code_lower", false]]);
  });

  test("an origin names its collector and carries the SHA-256 of the file it is in", async () => {
    const result = await collect({ "0001_init.sql": INIT, "0002_more.sql": MORE });
    const created = table(result, "t").origin;
    const added = column(result, "t", "note").origin;
    assert.deepEqual([created?.source, created?.sha256], ["postgresql-migrations", sha256(INIT)]);
    assert.deepEqual([added?.source, added?.sha256], ["postgresql-migrations", sha256(MORE)]);
    assert.deepEqual(
      result.migrations.map((migration) => [migration.file, migration.sha256]),
      [
        ["0001_init.sql", sha256(INIT)],
        ["0002_more.sql", sha256(MORE)],
      ],
    );
  });

  test("the same migrations give the same schema, with the same provenance, every time", async () => {
    const first = await collect({ "0001_init.sql": INIT, "0002_more.sql": MORE });
    const second = await collect({ "0001_init.sql": INIT, "0002_more.sql": MORE });
    assert.deepEqual({ tables: second.tables, types: second.types }, { tables: first.tables, types: first.types });
  });

  test("a migration whose text changed gives its objects another origin, though they are the same otherwise", async () => {
    const first = await collect({ "0001_init.sql": INIT });
    const second = await collect({ "0001_init.sql": `${INIT}\n-- reviewed` });
    assert.notEqual(table(second, "t").origin?.sha256, table(first, "t").origin?.sha256);
    assert.deepEqual(table(second, "t").columns.map((entry) => entry.name), table(first, "t").columns.map((entry) => entry.name));
  });
});

describe("explicit renames in the collected schema", () => {
  test("a renamed table and a renamed column keep their origin and record each rename, oldest first", async () => {
    const result = await collect({
      "0001.sql": "create table a (id int primary key, x int, y int);",
      "0002.sql": ["alter table a rename to b;", "alter table b rename column x to x2;", "alter table b rename column x2 to x3;", "", "alter table b rename to c;"].join("\n"),
    });
    const found = table(result, "c");
    assert.deepEqual(result.tables.map((entry) => entry.name), ["c"]);
    assert.deepEqual(originOf(found), ["0001.sql", 1, 1, "a", false]);
    assert.deepEqual(renamesOf(found.renames), [
      ["a", "b", "0002.sql", 1, 1],
      ["b", "c", "0002.sql", 4, 5],
    ]);
    assert.deepEqual(found.columns.map((entry) => entry.name), ["id", "x3", "y"]);
    assert.deepEqual(originOf(column(result, "c", "x3")), ["0001.sql", 1, 1, "x", false]);
    assert.deepEqual(renamesOf(column(result, "c", "x3").renames), [
      ["x", "x2", "0002.sql", 2, 2],
      ["x2", "x3", "0002.sql", 3, 3],
    ]);
    // What was not renamed records no renames at all.
    assert.deepEqual([column(result, "c", "id").renames, column(result, "c", "y").renames], [undefined, undefined]);
  });

  test("a rename carries the position and the SHA-256 of the statement that renamed", async () => {
    const second = "alter table a rename column x to z;";
    const result = await collect({ "0001.sql": "create table a (x int);", "0002.sql": second });
    assert.deepEqual(column(result, "a", "z").renames, [{ from: "x", to: "z", at: { source: "postgresql-migrations", file: "0002.sql", sha256: sha256(second), statement: 1, line: 1 } }]);
  });

  test("renamed constraints and indexes record their renames; the index of a key renames the key", async () => {
    const result = await collect({
      "0001.sql": "create table a (id int primary key, x int, y int unique, z int references a, constraint a_x_positive check (x > 0));\ncreate index a_x on a (x);",
      "0002.sql": [
        "alter table a rename constraint a_x_positive to x_positive;",
        "alter index a_x rename to x_index;",
        "alter index a_y_key rename to y_once;",
        "alter table a rename constraint a_pkey to a_key;",
        "alter table a rename constraint a_z_fkey to z_parent;",
      ].join("\n"),
    });
    const found = table(result, "a");
    const history = (entry: (ObjectProvenance & { name?: string }) | undefined): unknown[] => [entry?.name, originOf(entry)?.[3], renamesOf(entry?.renames)];
    assert.deepEqual(history(found.checks?.[0]), ["x_positive", "a_x_positive", [["a_x_positive", "x_positive", "0002.sql", 1, 1]]]);
    assert.deepEqual(history(found.indexes?.[0]), ["x_index", "a_x", [["a_x", "x_index", "0002.sql", 2, 2]]]);
    assert.deepEqual(history(found.uniques?.[0]), ["y_once", "a_y_key", [["a_y_key", "y_once", "0002.sql", 3, 3]]]);
    assert.deepEqual(history(found.primaryKey), ["a_key", "a_pkey", [["a_pkey", "a_key", "0002.sql", 4, 4]]]);
    assert.deepEqual(history(column(result, "a", "z").references), ["z_parent", "a_z_fkey", [["a_z_fkey", "z_parent", "0002.sql", 5, 5]]]);
  });

  test("renaming a table does not rename its constraints and indexes, and renaming a column keeps them on it", async () => {
    const result = await collect({
      "0001.sql": "create table a (id int primary key, x int unique, check (x > 0));\ncreate index on a (x);",
      "0002.sql": "alter table a rename to b;\nalter table b rename column x to x2;",
    });
    const found = table(result, "b");
    assert.deepEqual(
      [found.primaryKey?.name, found.uniques?.map((entry) => [entry.name, entry.columns]), found.checks?.map((entry) => entry.name), found.indexes?.map((entry) => [entry.name, entry.columns])],
      ["a_pkey", [["a_x_key", ["x2"]]], ["a_x_check"], [["a_x_idx", ["x2"]]]],
    );
    assert.deepEqual([found.primaryKey?.renames, found.uniques?.[0]?.renames, found.checks?.[0]?.renames, found.indexes?.[0]?.renames], [undefined, undefined, undefined, undefined]);
  });

  test("a column that is dropped and created again is another object: a new origin, and no renames", async () => {
    const result = await collect({
      "0001.sql": "create table a (id int primary key, x int);",
      "0002.sql": "alter table a rename column x to y;\nalter table a drop column y;\nalter table a add column y text;",
    });
    assert.deepEqual([originOf(column(result, "a", "y")), column(result, "a", "y").renames], [["0002.sql", 3, 3, "y", false], undefined]);
  });
});

describe("enumerated types of the collected schema", () => {
  const TYPES = [
    "create type status as enum ('draft', 'live');",
    "create type unused as enum ('x');",
    "create type empty as enum ();",
    "create table posts (id int primary key, state status not null default 'draft', previous status default 'live', history status[]);",
    "create table comments (id int primary key, state status);",
  ].join("\n");

  test("are the schema's own: each defined once, in the order they were created, whether a column uses it or not", async () => {
    const result = await collect({ "0001.sql": TYPES });
    assert.deepEqual(
      result.types.enums.map((type) => [type.name, type.values, type.sourceDialectType]),
      [
        ["status", ["draft", "live"], { dialect: "postgresql", type: "status" }],
        ["unused", ["x"], { dialect: "postgresql", type: "unused" }],
        ["empty", [], { dialect: "postgresql", type: "empty" }],
      ],
    );
    // Three columns of two tables take the one type, and name it.
    for (const [tableName, columnName] of [["posts", "state"], ["posts", "previous"], ["comments", "state"]] as const) {
      const found = column(result, tableName, columnName);
      assert.deepEqual([found.canonicalType, found.enum], [{ kind: "enum", name: "status" }, { name: "status", values: ["draft", "live"] }], `${tableName}.${columnName}`);
    }
    assert.deepEqual(column(result, "posts", "history").canonicalType, { kind: "array", element: { kind: "enum", name: "status" } });
  });

  test("values are added where the statement says, and renamed values and a renamed type record their history", async () => {
    const result = await collect({
      "0001.sql": TYPES,
      "0002.sql": [
        "alter type status add value 'archived';", // draft, live, archived
        "alter type status add value 'review' before 'live';", // draft, review, live, archived
        "alter type status add value 'checked' after 'review';", // draft, review, checked, live, archived
        "alter type status add value if not exists 'draft';",
        "alter type status rename value 'live' to 'published';",
        "alter type status rename value 'published' to 'public';",
        "alter type status rename to post_status;",
        "alter type post_status add value 'gone' after 'public';", // draft, review, checked, public, gone, archived
        "drop type unused;",
      ].join("\n"),
    });
    assert.deepEqual(result.types.enums.map((type) => type.name), ["post_status", "empty"]);
    const [status] = result.types.enums;
    assert.deepEqual(status?.values, ["draft", "review", "checked", "public", "gone", "archived"]);
    assert.deepEqual(originOf(status), ["0001.sql", 1, 1, "status", false]);
    assert.deepEqual(renamesOf(status?.renames), [["status", "post_status", "0002.sql", 7, 7]]);
    assert.deepEqual(renamesOf(status?.valueRenames), [
      ["live", "published", "0002.sql", 5, 5],
      ["published", "public", "0002.sql", 6, 6],
    ]);
    assert.equal(status?.sourceDialectType?.type, "post_status");

    // The columns follow the type: its new name, its values, and a default that was a renamed value.
    const state = column(result, "posts", "state");
    assert.deepEqual([state.canonicalType, state.enum, state.default], [{ kind: "enum", name: "post_status" }, { name: "post_status", values: ["draft", "review", "checked", "public", "gone", "archived"] }, "draft"]);
    assert.equal(column(result, "posts", "previous").default, "public");
    assert.deepEqual(column(result, "posts", "history").canonicalType, { kind: "array", element: { kind: "enum", name: "post_status" } });
    assert.equal(column(result, "comments", "state").enum?.name, "post_status");
  });

  test("renaming or dropping a type leaves the columns of other types as they were, arrays included", async () => {
    const result = await collect({
      "1.sql": [
        // One-letter names: they occur within the spellings of other types.
        "create type e as enum ('a');",
        "create type t as enum ('b');",
        "create type unused as enum ('c');",
        "create table x (tags text[], others t[], other t, one e, many e[], qualified public.e);",
        "alter type e rename to kind;",
        "drop type unused;",
      ].join("\n"),
    });
    assert.deepEqual(
      table(result, "x").columns.map((entry) => [entry.name, entry.declaredType, entry.sourceDialectType?.type, entry.canonicalType]),
      [
        ["tags", "text[]", "text[]", { kind: "array", element: { kind: "text" } }],
        ["others", "t[]", "t[]", { kind: "array", element: { kind: "enum", name: "t" } }],
        ["other", "t", "t", { kind: "enum", name: "t" }],
        ["one", "kind", "kind", { kind: "enum", name: "kind" }],
        ["many", "kind[]", "kind[]", { kind: "array", element: { kind: "enum", name: "kind" } }],
        ["qualified", "kind", "kind", { kind: "enum", name: "kind" }],
      ],
    );
    assert.deepEqual(result.types.enums.map((type) => type.name), ["kind", "t"]);
    // A type that an array column uses cannot be dropped, as in PostgreSQL.
    await assert.rejects(collect({ "1.sql": "create type e as enum ('a');\ncreate table x (many e[]);\ndrop type e;" }), /cannot drop type "e" because other objects depend on it \(column x\.many\)/);
  });

  test("a statement about a type of another schema leaves the public type of that name alone", async () => {
    const result = await collect({
      "0001.sql": ["create type status as enum ('draft', 'live');", "create table posts (id int primary key, state status not null default 'draft');", "create schema app;", "create type app.status as enum ('x', 'y');"].join("\n"),
      "0002.sql": ["alter type app.status add value 'w';", "alter type app.status rename value 'x' to 'z';", "alter type app.status rename to state;", "drop type app.state;"].join("\n"),
    });
    const [status] = result.types.enums;
    assert.deepEqual([result.types.enums.length, status?.name, status?.values, status?.renames, status?.valueRenames], [1, "status", ["draft", "live"], undefined, undefined]);
    assert.deepEqual(
      result.report.filter((entry) => entry.file === "0002.sql").map((entry) => [entry.line, entry.outcome, entry.category]),
      [
        [1, "not-reproduced", "other-schemas"],
        [2, "not-reproduced", "other-schemas"],
        [3, "not-reproduced", "other-schemas"],
        [4, "not-reproduced", "other-schemas"],
      ],
    );
    // Written with its schema, the public type is meant.
    const qualified = await collect({ "0001.sql": "create type status as enum ('draft');\nalter type public.status add value 'live';\nalter type public.status rename value 'draft' to 'new';\nalter type public.status rename to state;" });
    assert.deepEqual(qualified.types.enums.map((type) => [type.name, type.values]), [["state", ["new", "live"]]]);
  });

  test("a type or a value cannot be renamed to a name that is taken, as in PostgreSQL", async () => {
    await assert.rejects(collect({ "1.sql": "create type a as enum ('x');\ncreate type b as enum ('y');\nalter type a rename to b;" }), /^MigrationError: 1\.sql:3: type "b" already exists\.$/);
    await assert.rejects(collect({ "1.sql": "create type e as enum ('a', 'b');\nalter type e rename value 'a' to 'b';" }), /^MigrationError: 1\.sql:2: enum label "b" already exists in "e"\.$/);
  });

  test("DROP TYPE ... CASCADE of a type in use is reported as unsupported, and the type and its columns are kept", async () => {
    const result = await collect({ "1.sql": "create type s as enum ('a');\ncreate table t (id int primary key, x s);\ndrop type s cascade;" });
    assert.deepEqual(result.types.enums.map((type) => type.name), ["s"]);
    assert.deepEqual(column(result, "t", "x").canonicalType, { kind: "enum", name: "s" });
    assert.deepEqual(result.report.filter((entry) => entry.outcome === "unsupported").map((entry) => [entry.line, entry.category, entry.object]), [[3, "type", "s"]]);
  });

  test("a type without renames records none, and a type that is dropped and created again is another type", async () => {
    const result = await collect({ "0001.sql": "create type mood as enum ('ok');", "0002.sql": "alter type mood add value 'meh';\ndrop type mood;\ncreate type mood as enum ('fine');" });
    const [mood] = result.types.enums;
    assert.deepEqual([mood?.values, originOf(mood), mood?.renames, mood?.valueRenames], [["fine"], ["0002.sql", 3, 3, "mood", false], undefined, undefined]);
  });
});

describe("the primary key of a collected table", () => {
  test("is a constraint with its name and the order of its columns, which need not be the table's", async () => {
    const result = await collect({
      "1.sql": [
        "create table regions (code text, country text, note text, constraint regions_pk primary key (country, code));",
        "create table pairs (b int, a int, primary key (a, b));",
        "create table later (x int, y int);",
        "alter table later add primary key (y, x);",
        "create table single (id int primary key, n int);",
      ].join("\n"),
    });
    const key = (name: string): unknown[] => {
      const found = table(result, name);
      return [found.primaryKey?.name, found.primaryKey?.columns, found.primaryKey?.origin?.generatedName === true, found.columns.map((entry) => `${entry.name}${entry.primary ? " pk" : ""}${entry.nullable ? "" : " not null"}`)];
    };
    assert.deepEqual(key("regions"), ["regions_pk", ["country", "code"], false, ["code pk not null", "country pk not null", "note"]]);
    assert.deepEqual(key("pairs"), ["pairs_pkey", ["a", "b"], true, ["b pk not null", "a pk not null"]]);
    assert.deepEqual(key("later"), ["later_pkey", ["y", "x"], true, ["x pk not null", "y pk not null"]]);
    assert.deepEqual(key("single"), ["single_pkey", ["id"], true, ["id pk not null", "n"]]);
    assert.deepEqual(originOf(table(result, "later").primaryKey), ["1.sql", 4, 4, "later_pkey", true]);
  });

  test("a foreign key that names no columns refers to the key's columns in the key's order", async () => {
    const result = await collect({ "1.sql": "create table pairs (b int, a int, primary key (a, b));\ncreate table uses (p int, q int, foreign key (p, q) references pairs);" });
    assert.deepEqual(table(result, "uses").foreignKeys?.map((entry) => [entry.columns, entry.references]), [[["p", "q"], { table: "pairs", columns: ["a", "b"] }]]);
  });

  test("follows a renamed column, and is gone with its constraint", async () => {
    const renamed = await collect({ "1.sql": "create table t (a int, b int, primary key (b, a));\nalter table t rename column b to c;" });
    assert.deepEqual(table(renamed, "t").primaryKey?.columns, ["c", "a"]);
    const dropped = await collect({ "1.sql": "create table t (a int, b int, primary key (b, a));\nalter table t drop constraint t_pkey;" });
    assert.deepEqual([table(dropped, "t").primaryKey, table(dropped, "t").columns.map((entry) => entry.primary)], [undefined, [false, false]]);
  });
});
