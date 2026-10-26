import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { staleNamesOf } from "../../runtime/src/index.ts";
import type { ExpressionName } from "../../runtime/src/index.ts";
import { collect, column, table } from "./support.ts";

/*
 * What the text of an expression names (D-040).
 *
 * A schema holds an expression (a check, an index's expression or condition,
 * a default) as the text the migration wrote. PostgreSQL holds what the text
 * meant: after `RENAME COLUMN a TO c`, its check is of `c`, and the text
 * still says `a`. Written into a database again, that text would be refused,
 * or, where another column has taken the name, would be of that column.
 *
 * So the collector records what each name in an expression referred to when
 * it was written, and the schema says of each what it is called now
 * (`names`). A name that is called something else is stale; one that is its
 * thing's name again is not.
 *
 * What PostgreSQL makes of each of these was read from its catalog
 * (PostgreSQL 18).
 */

const collected = (sql: string) => collect({ "001.sql": sql });
const check = async (sql: string, name = "c"): Promise<ExpressionName[] | undefined> => {
  const result = await collected(sql);
  const found = result.tables.flatMap((entry) => entry.checks ?? []).find((entry) => entry.name === name);
  assert.ok(found, `check ${name}`);
  return found.names;
};
const index = async (sql: string, name = "i"): Promise<ExpressionName[] | undefined> => {
  const result = await collected(sql);
  const found = result.tables.flatMap((entry) => entry.indexes ?? []).find((entry) => entry.name === name);
  assert.ok(found, `index ${name}`);
  return found.names;
};
/** The names a check's text is stale by. */
const stale = async (sql: string, name = "c"): Promise<ExpressionName[]> => staleNamesOf(await check(sql, name));

describe("what the text of an expression names", () => {
  test("the columns of its table, each once, as the text has them", async () => {
    assert.deepEqual(await check("create table t (a int, b int, d int, constraint c check (b > 0 and a < b and abs(b) > 0));"), [
      { kind: "column", name: "b" },
      { kind: "column", name: "a" },
    ]);
  });

  test("nothing, and says so: a text that names nothing is one that no rename reaches", async () => {
    assert.deepEqual(await check("create table t (a int, constraint c check (1 > 0));"), []);
    assert.deepEqual(await index("create table t (a int);\ncreate index i on t (a) where (now() is not null);"), []);
  });

  test("the table, where the text says its name", async () => {
    assert.deepEqual(await check("create table t (a int, constraint c check (t.a > 0));"), [
      { kind: "column", name: "a" },
      { kind: "table", name: "t" },
    ]);
  });

  test("enumerated types it casts to, and values of the types it has to do with, each with its type", async () => {
    const sql = "create type mood as enum ('sad', 'ok');\ncreate type shade as enum ('dark', 'sad');\ncreate table t (m mood, x text, constraint c check (m <> 'sad' and x::mood <> 'ok'::mood and x <> 'dark'));";
    assert.deepEqual(await check(sql), [
      { kind: "column", name: "m" },
      { kind: "column", name: "x" },
      { kind: "type", name: "mood" },
      { kind: "value", name: "sad", type: "mood" },
      { kind: "value", name: "ok", type: "mood" },
    ]);
  });

  test("no function, and no type that is not enumerated: a schema keeps neither, and says of one only that it was renamed", async () => {
    assert.deepEqual(await check("create table t (a int, constraint c check (abs(a) > 0 and a::bigint > 0 and a::text <> ''));"), [{ kind: "column", name: "a" }]);
  });

  test("is said of the expressions and the condition of an index together, and not of an index over columns alone", async () => {
    const sql = "create table t (id int, name text, kind text);\ncreate index i on t (lower(name), id) where kind = 'x';\ncreate index plain on t (name);";
    assert.deepEqual(await index(sql), [
      { kind: "column", name: "name" },
      { kind: "column", name: "kind" },
    ]);
    const plain = table(await collected(sql), "t").indexes?.find((entry) => entry.name === "plain");
    assert.deepEqual([plain?.columns, plain?.names, plain?.mayBeStale], [["name"], undefined, undefined]);
  });

  test("is said of a default that is an expression: it names no column", async () => {
    const result = await collected("create type mood as enum ('sad', 'ok');\ncreate table t (a int default (1 + 2), m mood default lower('SAD')::mood, n int default 7, at timestamptz default now());");
    assert.deepEqual([column(result, "t", "a").defaultExpression, column(result, "t", "a").defaultNames], ["1 + 2", []]);
    assert.deepEqual(column(result, "t", "m").defaultNames, [{ kind: "type", name: "mood" }]);
    // A default that is a value has no text.
    assert.deepEqual([column(result, "t", "n").default, column(result, "t", "n").defaultNames], [7, undefined]);
    assert.deepEqual([column(result, "t", "at").defaultExpression, column(result, "t", "at").defaultNames], ["now()", []]);
  });
});

describe("a column that is renamed after an expression was written", () => {
  const T = "create table t (a int, b int, constraint c check (a > 0));\n";

  test("leaves the expression with a name that is the column's no longer", async () => {
    assert.deepEqual(await stale(T), []);
    assert.deepEqual(await check(`${T}alter table t rename column a to amount;`), [{ kind: "column", name: "a", now: "amount" }]);
    // The text is kept as it was written.
    assert.equal(table(await collected(`${T}alter table t rename column a to amount;`), "t").checks?.[0]?.expression, "a > 0");
  });

  test("does not concern an expression that does not name it", async () => {
    assert.deepEqual(await check(`${T}alter table t rename column b to other;`), [{ kind: "column", name: "a" }]);
  });

  test("is found through several renames: the name the text has, and what the column is called at the end", async () => {
    assert.deepEqual(await stale(`${T}alter table t rename column a to x;\nalter table t rename column x to y;\nalter table t rename column y to z;`), [{ kind: "column", name: "a", now: "z" }]);
  });

  test("is found when another column has taken the old name: the text would be of that column", async () => {
    assert.deepEqual(await stale(`${T}alter table t rename column a to amount;\nalter table t add column a int;`), [{ kind: "column", name: "a", now: "amount" }]);
    // Two columns that exchange their names: each name in the text is the other column's now.
    assert.deepEqual(await stale("create table t (a int, b int, constraint c check (a > b));\nalter table t rename column a to x;\nalter table t rename column b to a;\nalter table t rename column x to b;"), [
      { kind: "column", name: "a", now: "b" },
      { kind: "column", name: "b", now: "a" },
    ]);
  });

  test("leaves nothing behind when the column has its old name again", async () => {
    assert.deepEqual(await check(`${T}alter table t rename column a to x;\nalter table t rename column x to a;`), [{ kind: "column", name: "a" }]);
  });

  test("does not concern an expression that was written afterwards, in the new names", async () => {
    assert.deepEqual(await check(`${T}alter table t rename column a to amount;\nalter table t add constraint later check (amount < 100);`, "later"), [{ kind: "column", name: "amount" }]);
  });

  test("is found in the expression of an index, in its condition, and in a check written with a column", async () => {
    const base = "create table t (id int, name text check (name <> ''), kind text);\ncreate index i on t (lower(name));\ncreate index partial on t (id) where kind = 'x';\ncreate index plain on t (name);\n";
    const renamed = `${base}alter table t rename column name to title;\nalter table t rename column kind to sort;`;
    assert.deepEqual(await index(renamed), [{ kind: "column", name: "name", now: "title" }]);
    assert.deepEqual(await index(renamed, "partial"), [{ kind: "column", name: "kind", now: "sort" }]);
    // An index over columns alone has no text: its columns are followed as columns.
    const plain = table(await collected(renamed), "t").indexes?.find((entry) => entry.name === "plain");
    assert.deepEqual([plain?.columns, plain?.names], [["title"], undefined]);
    assert.deepEqual(await check(renamed, "t_name_check"), [{ kind: "column", name: "name", now: "title" }]);
  });

  test("is found when the text names the column in other letters, or in quotes", async () => {
    assert.deepEqual(await check('create table t ("Amount" int, b int, constraint c check ("Amount" > 0 and B > 0));\nalter table t rename column "Amount" to total;\nalter table t rename column b to floor;'), [
      { kind: "column", name: "Amount", now: "total" },
      { kind: "column", name: "b", now: "floor" },
    ]);
  });
});

describe("a table that is renamed after an expression was written", () => {
  test("leaves an expression that names the table with a name that is the table's no longer", async () => {
    assert.deepEqual(await stale("create table t (a int, constraint c check (t.a > 0));\nalter table t rename to u;"), [{ kind: "table", name: "t", now: "u" }]);
    assert.deepEqual(await stale("create table t (a int, constraint c check (public.t.a > 0));\nalter table t rename to u;"), [{ kind: "table", name: "t", now: "u" }]);
    // The table as a whole row.
    assert.deepEqual(await check("create table t (a int, constraint c check (t is not null));\nalter table t rename to u;"), [{ kind: "table", name: "t", now: "u" }]);
    assert.deepEqual(staleNamesOf(await index("create table t (a int);\ncreate index i on t ((t.a + 1));\nalter table t rename to u;")), [{ kind: "table", name: "t", now: "u" }]);
  });

  test("does not concern an expression that names its columns alone", async () => {
    assert.deepEqual(await check("create table t (a int, constraint c check (a > 0));\nalter table t rename to u;"), [{ kind: "column", name: "a" }]);
  });

  test("is found with a renamed column: both names are another thing's now", async () => {
    assert.deepEqual(await check("create table t (a int, constraint c check (t.a > 0));\nalter table t rename to u;\nalter table u rename column a to b;"), [
      { kind: "column", name: "a", now: "b" },
      { kind: "table", name: "t", now: "u" },
    ]);
  });
});

describe("an enumerated type, or a value of one, that is renamed after an expression was written", () => {
  const T = "create type mood as enum ('sad', 'ok');\ncreate table t (m mood, x text, constraint c check (m <> 'sad' and x::mood <> 'ok'::mood));\n";

  test("leaves a cast to the type with a name that is the type's no longer, and its values are the renamed type's", async () => {
    assert.deepEqual(await check(`${T}alter type mood rename to feeling;`), [
      { kind: "column", name: "m" },
      { kind: "column", name: "x" },
      { kind: "type", name: "mood", now: "feeling" },
      { kind: "value", name: "sad", type: "feeling" },
      { kind: "value", name: "ok", type: "feeling" },
    ]);
    assert.deepEqual(await stale("create type mood as enum ('a');\ncreate table t (x text, constraint c check (x::public.mood = 'a'));\nalter type mood rename to feeling;"), [{ kind: "type", name: "mood", now: "feeling" }]);
  });

  test("leaves a value in the text with a name that is the value's no longer", async () => {
    assert.deepEqual(await stale(`${T}alter type mood rename value 'sad' to 'blue';`), [{ kind: "value", name: "sad", now: "blue", type: "mood" }]);
    // Through several renames, and with another value taking the name.
    assert.deepEqual(await stale(`${T}alter type mood rename value 'sad' to 'blue';\nalter type mood rename value 'blue' to 'low';\nalter type mood add value 'sad';`), [{ kind: "value", name: "sad", now: "low", type: "mood" }]);
    // The name again: nothing is left behind.
    assert.deepEqual(await stale(`${T}alter type mood rename value 'sad' to 'blue';\nalter type mood rename value 'blue' to 'sad';`), []);
  });

  test("a value is found by the type of the column it is compared with, in a condition of an index too", async () => {
    const sql = "create type state as enum ('on', 'off');\ncreate table t (id int, s state);\ncreate index i on t (id) where s = 'on';\nalter type state rename value 'on' to 'active';";
    assert.deepEqual(await index(sql), [
      { kind: "column", name: "s" },
      { kind: "value", name: "on", now: "active", type: "state" },
    ]);
  });

  test("does not concern a text that is no value of a type the expression has to do with", async () => {
    const sql = "create type state as enum ('on', 'off');\ncreate table t (id int, s state, note text, constraint c check (note <> 'on'));\nalter type state rename value 'on' to 'active';";
    assert.deepEqual(await check(sql), [{ kind: "column", name: "note" }]);
  });
});

describe("a function, or a type that is not enumerated, that is renamed after an expression was written", () => {
  const F = "create function is_ok(x int) returns boolean language sql immutable as 'select x > 0';\n";

  test("leaves a call of the function with a name that is the function's no longer", async () => {
    assert.deepEqual(await check(`${F}create table t (a int, constraint c check (is_ok(a)));\nalter function is_ok(int) rename to is_fine;`), [
      { kind: "column", name: "a" },
      { kind: "function", name: "is_ok", now: "is_fine" },
    ]);
    assert.deepEqual(await stale(`${F}create table t (a int, constraint c check (public.is_ok(a)));\nalter routine is_ok rename to is_fine;\nalter function public.is_fine(int) rename to passes;`), [{ kind: "function", name: "is_ok", now: "passes" }]);
    // Under its own name again, it is not listed: a function is, only when the text is stale by it.
    assert.deepEqual(await check(`${F}create table t (a int, constraint c check (is_ok(a)));\nalter function is_ok(int) rename to is_fine;\nalter function is_fine(int) rename to is_ok;`), [{ kind: "column", name: "a" }]);
  });

  test("does not concern an expression that calls another function", async () => {
    assert.deepEqual(await stale(`${F}create table t (a int, constraint c check (abs(a) > 0));\nalter function is_ok(int) rename to is_fine;`), []);
  });

  test("leaves a cast to the type with a name that is the type's no longer: a domain, and a type of another kind", async () => {
    const domain = "create domain positive as int check (value > 0);\ncreate table t (a int, constraint c check (a::positive > 0));\n";
    assert.deepEqual(await check(domain), [{ kind: "column", name: "a" }]);
    assert.deepEqual(await check(`${domain}alter domain positive rename to pos;\nalter domain public.pos rename to above_zero;`), [
      { kind: "column", name: "a" },
      { kind: "type", name: "positive", now: "above_zero" },
    ]);
    const composite = "create type pair as (x int, y int);\ncreate table t (a int, constraint c check ((row(a, a)::pair).x > 0));\n";
    assert.deepEqual(await stale(`${composite}alter type pair rename to couple;`), [{ kind: "type", name: "pair", now: "couple" }]);
    // A type of another schema is another type.
    assert.deepEqual(await stale(`${domain}alter domain other.positive rename to pos;`), []);
  });
});

describe("a default that is an expression", () => {
  test("says which of its names are another thing's now, as a check does", async () => {
    const sql = "create function slug(x text) returns text language sql immutable as 'select lower(x)';\ncreate table t (id int, code text default slug('New'), at timestamptz default now());\nalter function slug(text) rename to make_slug;";
    const result = await collected(sql);
    assert.deepEqual([column(result, "t", "code").defaultExpression, column(result, "t", "code").defaultNames], ["slug('New')", [{ kind: "function", name: "slug", now: "make_slug" }]]);
    assert.deepEqual(column(result, "t", "at").defaultNames, []);
  });

  test("follows the renames of an enumerated type and of its values", async () => {
    const sql = "create type mood as enum ('sad', 'ok');\ncreate table t (m mood default lower('SAD')::mood, note text default ('sad'::mood)::text || 'x');\nalter type mood rename value 'sad' to 'blue';\nalter type mood rename to feeling;";
    const result = await collected(sql);
    assert.deepEqual(column(result, "t", "m").defaultNames, [{ kind: "type", name: "mood", now: "feeling" }]);
    assert.deepEqual(column(result, "t", "note").defaultNames, [
      { kind: "type", name: "mood", now: "feeling" },
      { kind: "value", name: "sad", now: "blue", type: "feeling" },
    ]);
  });

  test("that is a constant written as a value of an enumerated type, on a column of another type, is that value under the names it gets", async () => {
    // PostgreSQL keeps such a default as the value of the type, and reads it as the column's type at each write.
    const sql = "create type mood as enum ('sad', 'ok');\ncreate table t (id int, note text default ('sad'::mood)::text, other text default 'sad'::mood, plain text default 'sad');\n";
    const renamed = await collected(`${sql}alter type mood rename value 'sad' to 'blue';\nalter type mood rename to feeling;`);
    assert.deepEqual([column(renamed, "t", "note").default, column(renamed, "t", "other").default, column(renamed, "t", "plain").default], ["blue", "blue", "sad"]);
    // The type is not dropped while such a default rests on it.
    await assert.rejects(collected(`${sql}drop type mood;`), /cannot drop type "mood" because other objects depend on it \(the default of column t\.note\)/);
  });

  test("is not touched by the renames of columns: a default names none", async () => {
    const result = await collected("create table t (a int default (1 + 2), b int);\nalter table t rename column b to c;\nalter table t rename column a to n;\nalter table t rename to u;");
    assert.deepEqual([column(result, "u", "n").defaultExpression, column(result, "u", "n").defaultNames], ["1 + 2", []]);
  });

  test("forgets what it named when it is replaced or dropped", async () => {
    const base = "create function slug(x text) returns text language sql immutable as 'select lower(x)';\ncreate table t (code text default slug('New'));\nalter function slug(text) rename to make_slug;\n";
    const replaced = await collected(`${base}alter table t alter column code set default make_slug('New');`);
    assert.deepEqual([column(replaced, "t", "code").defaultExpression, column(replaced, "t", "code").defaultNames], ["make_slug('New')", []]);
    assert.equal(column(await collected(`${base}alter table t alter column code drop default;`), "t", "code").defaultNames, undefined);
  });
});

describe("a text whose names the collector cannot say any more", () => {
  test("may be stale: a check that casts to an enumerated type that is dropped", async () => {
    // PostgreSQL refuses the DROP, or with CASCADE drops the check. The collector keeps it, and says that it knows no more what the text names.
    const result = await collected("create type mood as enum ('sad');\ncreate table t (x text, constraint c check (x::mood = 'sad'));\ndrop type mood cascade;");
    const [found] = table(result, "t").checks ?? [];
    assert.deepEqual([found?.expression, found?.names, found?.mayBeStale], ["x::mood = 'sad'", undefined, true]);
    assert.match(result.report.find((entry) => /"c"/.test(entry.message) && /mood/.test(entry.message) && entry.outcome === "unsupported")?.message ?? "", /The check "c" of "t" casts to the type "mood", which is dropped: PostgreSQL refuses that, or drops the check with it \(CASCADE\)\. It is kept, and what its text names is not known from here on\./);
  });
});

describe("the names of expressions over several migrations", () => {
  test("are the same whether the rename is in the migration of the expression or in a later one", async () => {
    const result = await collect({
      "001_init.sql": "create table t (a int, b int, constraint c check (a > 0));\ncreate index i on t ((a + b));",
      "002_rename.sql": "alter table t rename column a to amount;",
      "003_more.sql": "alter table t add column a text;\nalter table t add constraint later check (a <> '');",
    });
    const t = table(result, "t");
    assert.deepEqual(t.checks?.map((entry) => [entry.name, entry.names]), [
      ["c", [{ kind: "column", name: "a", now: "amount" }]],
      ["later", [{ kind: "column", name: "a" }]],
    ]);
    assert.deepEqual(t.indexes?.[0]?.names, [
      { kind: "column", name: "a", now: "amount" },
      { kind: "column", name: "b" },
    ]);
  });

  test("are said when the migrations are collected, at the rename that leaves a name behind", async () => {
    const result = await collected("create table t (a int, constraint c check (a > 0));\nalter table t rename column a to amount;");
    const note = result.report.find((entry) => entry.outcome === "retained" && /"c"/.test(entry.message) && /amount/.test(entry.message));
    assert.match(note?.message ?? "", /The check "c" of "t" was written with "a", which is "amount" from here on: its text \(a > 0\) is kept as it was written, and is no longer what PostgreSQL has\./);
  });
});
