import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MigrationError } from "../src/index.ts";
import { collect, column, table } from "./support.ts";

/*
 * What PostgreSQL refuses because of what rests on what, beyond the rules
 * that databases share (D-039): a foreign key rests on a key or unique index
 * over the columns it refers to, so there has to be one, and it is not
 * dropped while the foreign key is there; and a table has a type of its own
 * name, so a table and an enumerated type do not share one.
 *
 * The collector refuses these as PostgreSQL does, when it has seen all that
 * the migrations did. After a statement whose effect on the schema it cannot
 * know (a DO block, a function called for its effect, anything it reports as
 * unsupported), PostgreSQL may have a key or lack a type that the collector
 * does not know of, and it refuses nothing on these grounds.
 */

const refused = (files: Record<string, string>, message: RegExp): Promise<void> => assert.rejects(collect(files), (error) => error instanceof MigrationError && message.test(error.message));

describe("a foreign key rests on a key over the columns it refers to", () => {
  test("columns that no primary key, unique constraint, or unique index is over are not referred to", async () => {
    await refused({ "001.sql": "create table p (id int, x int);\ncreate table c (p_id int references p (x));" }, /^001\.sql:2: there is no unique constraint matching given keys for referenced table "p"\.$/);
    await refused({ "001.sql": "create table p (id int primary key, x int);\ncreate table c (p_id int);\nalter table c add foreign key (p_id) references p (x);" }, /^001\.sql:3: there is no unique constraint matching given keys/);
    // An index that is not unique, one over an expression, and one with a condition are no key.
    await refused({ "001.sql": "create table p (id int, x int);\ncreate index p_x on p (x);\ncreate table c (p_id int references p (x));" }, /no unique constraint matching given keys/);
    await refused({ "001.sql": "create table p (id int, x int);\ncreate unique index p_x on p (x) where id > 0;\ncreate table c (p_id int references p (x));" }, /no unique constraint matching given keys/);
    await refused({ "001.sql": "create table p (id int, x int);\ncreate unique index p_x on p (x, (id + 1));\ncreate table c (p_id int references p (x));" }, /no unique constraint matching given keys/);
    // A key over more columns, or fewer, is another key.
    await refused({ "001.sql": "create table p (a int, b int, unique (a, b));\ncreate table c (x int references p (a));" }, /no unique constraint matching given keys/);
  });

  test("a primary key, a unique constraint, and a unique index each do, in whatever order their columns are", async () => {
    const result = await collect({
      "001.sql": `
        create table p (id int primary key, code text unique, a int, b int, x int);
        create unique index p_x on p (x);
        alter table p add constraint p_a_b unique (a, b);
        create table c (
          p_id int references p (id),
          p_code text references p (code),
          p_x int references p (x),
          a int,
          b int,
          foreign key (b, a) references p (b, a),
          self int references c (p_x_own),
          p_x_own int unique
        );`,
    });
    assert.deepEqual(
      ["p_id", "p_code", "p_x", "self"].map((name) => `${name} -> ${column(result, "c", name).references?.table}.${column(result, "c", name).references?.column}`),
      ["p_id -> p.id", "p_code -> p.code", "p_x -> p.x", "self -> c.p_x_own"],
    );
    assert.deepEqual(table(result, "c").foreignKeys?.map((key) => [key.columns, key.references]), [[["b", "a"], { table: "p", columns: ["b", "a"] }]]);
  });

  test("a key is not dropped while a foreign key rests on it", async () => {
    const base = "create table p (id int primary key, code text unique, x int);\ncreate unique index p_x on p (x);\ncreate table c (p_id int references p (id), p_code text references p (code), p_x int references p (x));\n";
    await refused({ "001.sql": `${base}alter table p drop constraint p_pkey;` }, /^001\.sql:4: cannot drop constraint "p_pkey" on table "p" because other objects depend on it \(foreign key "c_p_id_fkey" of "c"\)\. Use CASCADE\.$/);
    await refused({ "001.sql": `${base}alter table p drop constraint p_code_key;` }, /cannot drop constraint "p_code_key" on table "p" because other objects depend on it \(foreign key "c_p_code_fkey" of "c"\)/);
    await refused({ "001.sql": `${base}drop index p_x;` }, /^001\.sql:4: cannot drop index "p_x" because other objects depend on it \(foreign key "c_p_x_fkey" of "c"\)\. Use CASCADE\.$/);
    // The foreign key gone first, the key goes.
    const result = await collect({ "001.sql": `${base}alter table c drop constraint c_p_id_fkey;\nalter table p drop constraint p_pkey;\nalter table c drop constraint c_p_x_fkey;\ndrop index p_x;` });
    assert.equal(table(result, "p").primaryKey, undefined);
    assert.equal(table(result, "p").indexes, undefined);
    assert.deepEqual(table(result, "c").columns.map((entry) => entry.references?.name), [undefined, "c_p_code_fkey", undefined]);
  });

  test("with CASCADE the foreign keys that rest on it go with it, as in PostgreSQL", async () => {
    const result = await collect({
      "001.sql": `
        create table p (id int primary key, x int);
        create unique index p_x on p (x);
        create table c (p_id int references p (id), p_x int references p (x), other int references p (id) on delete cascade);
        alter table p drop constraint p_pkey cascade;
        drop index p_x cascade;`,
    });
    assert.equal(table(result, "p").primaryKey, undefined);
    assert.deepEqual(table(result, "c").columns.map((entry) => entry.references), [undefined, undefined, undefined]);
    assert.deepEqual(
      result.report.filter((entry) => entry.message.includes("with it")).map((entry) => entry.message),
      ['Dropped constraint "p_pkey" of "p", and with it the foreign keys that rest on it: "c_p_id_fkey" of "c", "c_other_fkey" of "c".', 'Dropped index "p_x", and with it the foreign keys that rest on it: "c_p_x_fkey" of "c".'],
    );
  });

  test("a key that is one of several over the same columns goes: the foreign key has another to rest on", async () => {
    // Which of them PostgreSQL made the foreign key with is not known here, so this is not refused, and with CASCADE the foreign key is kept and said to be.
    const base = "create table p (id int primary key);\nalter table p add constraint p_id_key unique (id);\ncreate table c (p_id int references p (id));\n";
    const dropped = await collect({ "001.sql": `${base}alter table p drop constraint p_id_key;` });
    assert.deepEqual([table(dropped, "p").uniques, column(dropped, "c", "p_id").references?.name], [undefined, "c_p_id_fkey"]);
    const cascaded = await collect({ "001.sql": `${base}alter table p drop constraint p_pkey cascade;` });
    assert.deepEqual([table(cascaded, "p").primaryKey, column(cascaded, "c", "p_id").references?.name], [undefined, "c_p_id_fkey"]);
    assert.deepEqual(
      cascaded.report.filter((entry) => entry.outcome === "unsupported").map((entry) => entry.message),
      ['Dropped constraint "p_pkey" of "p" with CASCADE. The foreign key "c_p_id_fkey" of "c" has another key over the same columns to rest on, and which of them PostgreSQL made it with is not known here: it is kept, and PostgreSQL may have dropped it.'],
    );
  });

  test("a column of a key is dropped with CASCADE: the foreign keys to it go, as before", async () => {
    const result = await collect({ "001.sql": "create table p (id int primary key);\ncreate table c (p_id int references p (id));\nalter table p drop column id cascade;" });
    assert.deepEqual([table(result, "p").columns.length, column(result, "c", "p_id").references], [0, undefined]);
  });
});

describe("a table and an enumerated type do not share a name", () => {
  test("a table is not created with, or renamed to, the name of an enumerated type", async () => {
    await refused({ "001.sql": "create type foo as enum ('a');\ncreate table foo (id int);" }, /^001\.sql:2: type "foo" already exists\.$/);
    await refused({ "001.sql": "create type foo as enum ('a');\ncreate table bar (id int);\nalter table bar rename to foo;" }, /^001\.sql:3: type "foo" already exists\.$/);
    // IF NOT EXISTS is about a table of the name, not about a type of it.
    await refused({ "001.sql": "create type foo as enum ('a');\ncreate table if not exists foo (id int);" }, /type "foo" already exists/);
  });

  test("an enumerated type is not created with, or renamed to, the name of a table", async () => {
    await refused({ "001.sql": "create table foo (id int);\ncreate type foo as enum ('a');" }, /^001\.sql:2: type "foo" already exists\.$/);
    await refused({ "001.sql": "create table foo (id int);\ncreate type bar as enum ('a');\nalter type bar rename to foo;" }, /^001\.sql:3: type "foo" already exists\.$/);
  });

  test("once the one is out of the way, the other takes the name; and an index or a constraint may be called like a type", async () => {
    const result = await collect({
      "001.sql": `
        create type foo as enum ('a');
        create table bar (id int, kind foo, constraint status check (id > 0));
        alter type foo rename to foo_old;
        alter table bar rename to foo;
        create type status as enum ('on', 'off');
        create type bar_idx as enum ('x');
        create index bar_idx on foo (id);
        drop table foo;
        alter type foo_old rename to foo;`,
    });
    assert.deepEqual(result.tables.map((entry) => entry.name), []);
    assert.deepEqual(result.types.enums.map((type) => type.name), ["foo", "status", "bar_idx"]);
  });
});

describe("a default rests on the enumerated type it was a value of", () => {
  const base = "create type mood as enum ('sad', 'ok');\ncreate type other as enum ('ok', 'sad');\ncreate table t (m mood default 'ok', ms mood[] default '{sad}', plain mood);\n";

  test("a column that leaves its enumerated type keeps its default as a value of that type: the type is not dropped while it does", async () => {
    // PostgreSQL converts the default with the column, as ('ok'::mood)::text, which is still of the type.
    await refused({ "001.sql": `${base}alter table t alter column m type text, alter column ms type text[], alter column plain type text;\ndrop type mood;` }, /^001\.sql:5: cannot drop type "mood" because other objects depend on it \(the default of column t\.m\)\.$/);
    // Set again, or dropped, the default is of the column's type alone.
    const result = await collect({ "001.sql": `${base}alter table t alter column m type text, alter column ms type text[], alter column plain type text;\nalter table t alter column m set default 'ok', alter column ms drop default;\ndrop type mood;` });
    assert.deepEqual(result.types.enums.map((type) => type.name), ["other"]);
    assert.deepEqual([column(result, "t", "m").default, column(result, "t", "ms").default], ["ok", undefined]);
  });

  test("the type's new name, and a value's, reach such a default", async () => {
    await refused({ "001.sql": `${base}alter table t alter column m type text, alter column ms drop default, alter column ms type text[], alter column plain type text;\nalter type mood rename to feeling;\ndrop type feeling;` }, /cannot drop type "feeling" because other objects depend on it \(the default of column t\.m\)/);
    // The default is the type's value, whatever it is called: renamed, it is the new name as a text.
    const result = await collect({ "001.sql": `${base}alter table t alter column m type text;\nalter type mood rename value 'ok' to 'fine';` });
    assert.equal(column(result, "t", "m").default, "fine");
  });

  test("with CASCADE the default goes with the type, as in PostgreSQL", async () => {
    const result = await collect({ "001.sql": `${base}alter table t alter column m type text, alter column ms type text[], alter column plain type text;\ndrop type mood cascade;` });
    assert.deepEqual(result.types.enums.map((type) => type.name), ["other"]);
    assert.deepEqual([column(result, "t", "m").default, column(result, "t", "ms").default], [undefined, undefined]);
    assert.deepEqual(
      result.report.filter((entry) => entry.message.includes("with it")).map((entry) => entry.message),
      ['Dropped type "mood", and with it the defaults that were values of it: t.m, t.ms.'],
    );
  });

  test("a default that is an array stays when its column's type changes", async () => {
    const result = await collect({ "001.sql": "create table t (tags varchar(10)[] default '{a,b}', counts integer[] default '{1,2}');\nalter table t alter column tags type text[], alter column counts type bigint[];" });
    assert.deepEqual([column(result, "t", "tags").default, column(result, "t", "counts").default], [["a", "b"], [1, 2]]);
  });

  test("a default is not converted from one enumerated type to another: it has to be dropped first", async () => {
    await refused({ "001.sql": `${base}alter table t alter column m type other using m::text::other;` }, /^001\.sql:4: default for column "m" cannot be cast automatically to type other\.$/);
    await refused({ "001.sql": `${base}alter table t alter column ms type other[] using ms::text[]::other[];` }, /^001\.sql:4: default for column "ms" cannot be cast automatically to type other\[\]\.$/);
    const result = await collect({ "001.sql": `${base}alter table t alter column m drop default;\nalter table t alter column m type other using m::text::other, alter column plain type other using plain::text::other;\nalter table t alter column m set default 'sad';` });
    assert.deepEqual([column(result, "t", "m").enum?.name, column(result, "t", "m").default, column(result, "t", "plain").enum?.name], ["other", "sad", "other"]);
  });
});

describe("an identity column is a whole number", () => {
  test("its type does not become another kind of type while it is one", async () => {
    await refused({ "001.sql": "create table t (id integer generated by default as identity);\nalter table t alter column id type text;" }, /^001\.sql:2: identity column type must be smallint, integer, or bigint\.$/);
    await refused({ "001.sql": "create table t (id integer generated always as identity);\nalter table t alter column id type numeric(10,0);" }, /identity column type must be smallint, integer, or bigint/);
    // A whole number of another size it may become; and anything, once it is no identity column.
    const result = await collect({
      "001.sql": "create table t (id integer generated by default as identity, other integer generated by default as identity, plain serial);\nalter table t alter column id type bigint;\nalter table t alter column other drop identity;\nalter table t alter column other type text;\nalter table t alter column plain type text;",
    });
    assert.deepEqual(table(result, "t").columns.map((entry) => [entry.name, entry.canonicalType?.kind, entry.generated]), [
      ["id", "integer", "increment"],
      ["other", "text", undefined],
      ["plain", "text", "increment"],
    ]);
  });
});

describe("after a statement whose effect on the schema is not known, nothing is refused on these grounds", () => {
  test("a DO block may have made the key that a foreign key rests on", async () => {
    const result = await collect({
      "001.sql": "create table p (id int, code text);\ndo $$ begin alter table p add constraint p_code_key unique (code); end $$;\ncreate table c (p_code text references p (code));",
    });
    assert.equal(column(result, "c", "p_code").references?.name, "c_p_code_fkey");
  });

  test("a function called for its effect, and a statement the collector does not handle, are such statements too", async () => {
    const afterCall = await collect({ "001.sql": "create type foo as enum ('a');\nselect drop_my_types();\ncreate table foo (id int);" });
    assert.deepEqual(afterCall.tables.map((entry) => entry.name), ["foo"]);
    const afterUnsupported = await collect({ "001.sql": "create table p (id int primary key);\ncreate table c (p_id int references p (id));\nalter table c set schema archive;\nalter table p drop constraint p_pkey;" });
    assert.equal(table(afterUnsupported, "p").primaryKey, undefined);
  });

  test("what the collector reports and does not reproduce on purpose leaves it sure of the schema", async () => {
    await refused(
      {
        "001.sql": "create table p (id int, x int);\nalter table p enable row level security;\ncreate policy p_read on p for select using (true);\ngrant select on p to anon;\nselect cron.schedule('job', '* * * * *', 'select 1');\ncomment on table p is 'x';\ncreate table c (p_id int references p (x));",
      },
      /^001\.sql:7: there is no unique constraint matching given keys for referenced table "p"\.$/,
    );
  });
});
