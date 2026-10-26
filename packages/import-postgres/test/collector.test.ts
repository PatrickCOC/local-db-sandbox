import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { MigrationError, MigrationSourceError, MigrationSyntaxError, collectPostgresMigrations, findMigrationsDirectory, readMigrationFiles, summarizeReport } from "../src/index.ts";
import type { CollectedSchema, ReportEntry } from "../src/index.ts";
import { NOW, collect, column, migrations, table } from "./support.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

/** A value without its provenance (`origin`, `renames`, `valueRenames`), for tests of structure. */
function strip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, inner) => (key === "origin" || key === "renames" || key === "valueRenames" || key === "sourceDialectType" ? undefined : inner))) as T;
}

function entries(result: CollectedSchema, outcome: ReportEntry["outcome"]): ReportEntry[] {
  return result.report.filter((entry) => entry.outcome === outcome);
}

describe("collecting a schema from PostgreSQL migrations", () => {
  test("CREATE TABLE: columns in order, PostgreSQL's types as the runtime stores them, nullability, keys", async () => {
    const result = await collect({
      "001_init.sql": `
        create table public.items (
          id bigserial primary key,
          code varchar(20) not null unique,
          price numeric(12,2),
          ratio double precision not null,
          active boolean not null default true,
          tags text[],
          meta jsonb default '{}'::jsonb,
          blob bytea,
          seen timestamp,
          seen_tz timestamp with time zone,
          day date,
          external uuid,
          at_time time
        );`,
    });
    const items = table(result, "items");
    assert.deepEqual(
      items.columns.map((entry) => [entry.name, entry.type, entry.declaredType, entry.nullable, entry.primary]),
      [
        ["id", "integer", "bigserial", false, true],
        ["code", "text", "varchar(20)", false, false],
        ["price", "numeric", "numeric(12,2)", true, false],
        ["ratio", "real", "double precision", false, false],
        ["active", "boolean", "boolean", false, false],
        ["tags", "json", "text[]", true, false],
        ["meta", "json", "jsonb", true, false],
        ["blob", "binary", "bytea", true, false],
        ["seen", "datetime", "timestamp", true, false],
        ["seen_tz", "datetime", "timestamp with time zone", true, false],
        ["day", "date", "date", true, false],
        ["external", "text", "uuid", true, false],
        ["at_time", "text", "time", true, false],
      ],
    );
    // A single integer key numbered by a sequence is numbered by the runtime.
    assert.deepEqual([column(result, "items", "id").autoIncrement, column(result, "items", "id").generated], [true, "increment"]);
    assert.deepEqual(strip(items.uniques), [{ name: "items_code_key", columns: ["code"] }]);
    assert.equal(column(result, "items", "active").default, true);
    assert.deepEqual(column(result, "items", "meta").default, {});
    assert.deepEqual(entries(result, "unsupported"), []);
  });

  test("defaults: constants are applied, the time of the write is computed, others are kept as information", async () => {
    const result = await collect({
      "001.sql": `
        create table t (
          id int primary key,
          a int default -5,
          b text default 'it''s',
          c timestamptz not null default now(),
          d timestamptz default timezone('utc'::text, now()),
          e timestamp default CURRENT_TIMESTAMP,
          f date default current_date,
          g uuid default gen_random_uuid(),
          h text default upper('x'),
          i text default now()
        );`,
    });
    assert.equal(column(result, "t", "a").default, -5);
    assert.equal(column(result, "t", "b").default, "it's");
    for (const name of ["c", "d", "e"]) {
      assert.equal(column(result, "t", name).defaultFunction, "current_timestamp", name);
    }
    assert.equal(column(result, "t", "c").defaultExpression, "now()");
    assert.equal(column(result, "t", "d").defaultExpression, "timezone('utc'::text, now())");
    assert.equal(column(result, "t", "f").defaultFunction, "current_date");
    assert.deepEqual([column(result, "t", "g").generated, column(result, "t", "g").defaultExpression, column(result, "t", "g").defaultFunction], ["uuid", "gen_random_uuid()", undefined]);
    assert.deepEqual([column(result, "t", "h").defaultExpression, column(result, "t", "h").defaultFunction], ["upper('x')", undefined]);
    // now() for a text column is not the runtime's date-time; kept as information.
    assert.deepEqual([column(result, "t", "i").defaultExpression, column(result, "t", "i").defaultFunction], ["now()", undefined]);
    assert.deepEqual(
      entries(result, "retained").map((entry) => entry.object),
      ["t.g", "t.h", "t.i"],
    );
  });

  test("ALTER TABLE: add, drop, and rename columns; set and drop defaults and NOT NULL; change a type", async () => {
    const result = await collect({
      "0001_create.sql": "create table accounts (id int primary key, name text, legacy text, score int);",
      "0002_alter.sql": `
        alter table accounts add column email text not null default 'none', add column if not exists name text;
        alter table accounts rename column name to display_name;
        alter table accounts drop column legacy;
        alter table accounts drop column if exists missing;
        alter table accounts alter column score type bigint, alter column score set default 0, alter column score set not null;
        alter table accounts alter column email drop default, alter column email drop not null;`,
    });
    const accounts = table(result, "accounts");
    assert.deepEqual(accounts.columns.map((entry) => entry.name), ["id", "display_name", "score", "email"]);
    assert.deepEqual([column(result, "accounts", "score").declaredType, column(result, "accounts", "score").default, column(result, "accounts", "score").nullable], ["bigint", 0, false]);
    assert.deepEqual([column(result, "accounts", "email").default, column(result, "accounts", "email").nullable], [undefined, true]);
    assert.deepEqual(
      entries(result, "no-effect").map((entry) => entry.message),
      ['Column "accounts"."name" exists already (IF NOT EXISTS).', 'Column "accounts"."missing" does not exist (IF EXISTS); nothing done.'],
    );
    assert.deepEqual(result.provenance.tables.accounts?.columns.display_name, { file: "0001_create.sql", line: 1 });
    assert.deepEqual(result.provenance.tables.accounts?.columns.email, { file: "0002_alter.sql", line: 2 });
  });

  test("ALTER TABLE ... RENAME TO: foreign keys, indexes, and rows follow the table", async () => {
    const result = await collect({
      "01.sql": `
        create table parents (id int primary key);
        create table children (id int primary key, parent_id int references parents (id) on delete set null on update cascade);
        create index children_parent_idx on children (parent_id);
        insert into parents (id) values (1), (2);
        alter table parents rename to families;
        alter table children rename column parent_id to family_id;`,
    });
    assert.deepEqual(result.tables.map((entry) => entry.name), ["families", "children"]);
    assert.deepEqual(strip(column(result, "children", "family_id").references), { table: "families", column: "id", onDelete: "SET NULL", onUpdate: "CASCADE", name: "children_parent_id_fkey" });
    assert.deepEqual(strip(table(result, "children").indexes), [{ name: "children_parent_idx", columns: ["family_id"] }]);
    assert.deepEqual(result.seeds, { families: [{ id: 1 }, { id: 2 }] });
  });

  test("keys: primary keys of one or several columns, foreign keys of one or several columns, unique constraints, by name", async () => {
    const result = await collect({
      "1.sql": `
        create table regions (code text, country text, constraint regions_pk primary key (country, code));
        create table stores (
          id serial,
          country text not null,
          region text not null,
          manager_email text,
          primary key (id),
          constraint stores_region_fk foreign key (country, region) references regions (country, code) on delete cascade,
          unique (manager_email),
          constraint stores_region_unique unique (country, region, id)
        );
        create table staff (id int primary key, store_id int references stores);
        alter table staff add constraint staff_store_unique unique (store_id);
        alter table staff drop constraint staff_store_unique;
        alter table stores rename constraint stores_region_unique to stores_place_unique;`,
    });
    assert.deepEqual(table(result, "regions").columns.filter((entry) => entry.primary).map((entry) => entry.name), ["code", "country"]);
    const stores = table(result, "stores");
    assert.deepEqual(strip(stores.foreignKeys), [{ name: "stores_region_fk", columns: ["country", "region"], references: { table: "regions", columns: ["country", "code"] }, onDelete: "CASCADE" }]);
    assert.deepEqual(strip(stores.uniques), [
      { name: "stores_manager_email_key", columns: ["manager_email"] },
      { name: "stores_place_unique", columns: ["country", "region", "id"] },
    ]);
    // A reference without columns is to the primary key.
    assert.deepEqual(strip(column(result, "staff", "store_id").references), { table: "stores", column: "id", name: "staff_store_id_fkey" });
    assert.equal(table(result, "staff").uniques, undefined);
  });

  test("indexes: over columns they are created; over expressions or with a condition they are kept as information", async () => {
    const result = await collect({
      "1.sql": `
        create table people (id int primary key, email text, nick text, deleted_at timestamptz);
        create index on people (nick);
        create unique index people_email_lower on people (lower(email));
        create index people_live on people (email) where deleted_at is null;
        create unique index if not exists people_nick_unique on people using btree (nick);
        create index people_gin on people using gin (email);
        drop index people_gin;
        alter index people_nick_unique rename to people_nick_key2;`,
    });
    assert.deepEqual(strip(table(result, "people").indexes), [
      { name: "people_nick_idx", columns: ["nick"] },
      { name: "people_email_lower", columns: [], unique: true, expressions: ["lower(email)"], names: [{ kind: "column", name: "email" }] },
      { name: "people_live", columns: ["email"], where: "deleted_at is null", names: [{ kind: "column", name: "deleted_at" }] },
      { name: "people_nick_key2", columns: ["nick"], unique: true },
    ]);
    assert.deepEqual(
      entries(result, "retained").map((entry) => entry.object),
      ["people_email_lower", "people_live"],
    );
  });

  test("enumerated types: values, values added and renamed, the type renamed, and columns that use them", async () => {
    const result = await collect({
      "1.sql": `
        create type status as enum ('draft', 'live');
        create table posts (id int primary key, state status not null default 'draft');
        insert into posts values (1, 'live');`,
      "2.sql": `
        alter type status add value 'archived';
        alter type status add value if not exists 'review' before 'live';
        alter type status add value if not exists 'draft';
        alter type status rename value 'live' to 'published';
        alter type status rename to post_status;`,
    });
    assert.deepEqual(strip(result.types.enums), [{ name: "post_status", values: ["draft", "review", "published", "archived"] }]);
    const state = column(result, "posts", "state");
    assert.deepEqual([state.type, state.declaredType, state.default, state.enum], ["text", "post_status", "draft", { name: "post_status", values: ["draft", "review", "published", "archived"] }]);
    assert.deepEqual(result.seeds.posts, [{ id: 1, state: "published" }]);
    await assert.rejects(collect({ "1.sql": "create type s as enum ('a'); create table t (x s); drop type s;" }), (error: unknown) => error instanceof MigrationError && /cannot drop type "s" because other objects depend on it/.test(error.message));
  });

  test("rows that migrations insert are kept, follow later changes, and are refused when PostgreSQL would refuse them", async () => {
    const result = await collect({
      "1.sql": `
        create table settings (key text primary key, value text, enabled boolean default false, changed_at timestamptz not null default now());
        insert into settings (key, value) values ('a', 'x');
        insert into settings (key, value, enabled) values ('a', 'other', true), ('b', 'y', 't') on conflict do nothing;
        insert into settings values ('c', default, true, now());
        alter table settings rename column value to setting;`,
    });
    assert.deepEqual(result.seeds.settings, [
      { key: "a", setting: "x" },
      { key: "b", setting: "y", enabled: true },
      { key: "c", enabled: true, changed_at: "2026-10-07T08:00:00.000Z" },
    ]);
    assert.match(entries(result, "seeded")[1]?.message ?? "", /1 row for "settings" \(1 skipped: ON CONFLICT DO NOTHING\)/);
    await assert.rejects(collect({ "1.sql": "create table t (id int primary key); insert into t values (1); insert into t values (1);" }), /duplicate key value violates unique constraint on "t" \(id\)/);
    await assert.rejects(collect({ "1.sql": "create table t (id int primary key); insert into t values (1); alter table t add column n int not null;" }), /contains null values/);
    const fromQuery = await collect({ "1.sql": "create table t (id int primary key); insert into t select 1;" });
    assert.deepEqual([fromQuery.seeds, entries(fromQuery, "unsupported").map((entry) => entry.category)], [{}, ["data"]]);
  });

  test("statements that are not part of a local database are reported, each with its file, line, and category", async () => {
    const result = await collect({
      "0001_everything.sql": [
        "create table t (id int primary key, owner uuid references auth.users (id));",
        "alter table t enable row level security;",
        'create policy "own rows" on t for select using (true);',
        "grant select on t to anon;",
        "create extension if not exists pgcrypto;",
        "create or replace function touch() returns trigger language plpgsql as $$ begin new.id = new.id; return new; end $$;",
        "create trigger t_touch before update on t for each row execute function touch();",
        "do $$ begin perform 1; end $$;",
        "select cron.schedule('nightly', '0 0 * * *', 'select 1');",
        "create schema reporting;",
        "create table reporting.totals (n int);",
        "create publication everything for all tables;",
        "comment on table t is 'rows';",
        "begin;",
        "set search_path = public;",
        "commit;",
        "create view t_view as select * from t;",
        "update t set id = 2;",
        "create domain positive as int check (value > 0);",
      ].join("\n"),
    });
    const kinds = result.report.map((entry) => [entry.line, entry.outcome, entry.category]);
    assert.deepEqual(kinds, [
      [1, "not-reproduced", "other-schemas"],
      [1, "applied", "table"],
      [2, "not-reproduced", "row-level-security"],
      [3, "not-reproduced", "row-level-security"],
      [4, "not-reproduced", "permissions"],
      [5, "not-reproduced", "extensions"],
      [6, "not-reproduced", "functions"],
      [7, "not-reproduced", "triggers"],
      [8, "not-reproduced", "functions"],
      [9, "not-reproduced", "scheduling"],
      [10, "not-reproduced", "other-schemas"],
      [11, "not-reproduced", "other-schemas"],
      [12, "not-reproduced", "replication"],
      [13, "no-effect", "comments"],
      [14, "no-effect", "transactions"],
      [15, "no-effect", "session"],
      [16, "no-effect", "transactions"],
      [17, "unsupported", "views"],
      [18, "unsupported", "data"],
      [19, "unsupported", "type"],
    ]);
    // The key into another schema is not kept: the local column takes any value.
    assert.equal(column(result, "t", "owner").references, undefined);
    assert.equal(result.tables.length, 1);
    assert.deepEqual(summarizeReport(result.report).outcomes, { applied: 1, seeded: 0, retained: 0, "not-reproduced": 12, "no-effect": 4, unsupported: 3 });
    assert.ok(result.report.every((entry) => entry.file === "0001_everything.sql" && entry.sql !== ""));
  });

  test("migrations are applied in the order of their versions, compared as numbers", async () => {
    const result = await collect({
      "V10__third.sql": "alter table t rename column b to c;",
      "V2__second.sql": "alter table t rename column a to b;",
      "V1__first.sql": "create table t (a int);",
    });
    assert.deepEqual(result.migrations.map((migration) => migration.file), ["V1__first.sql", "V2__second.sql", "V10__third.sql"]);
    assert.deepEqual(table(result, "t").columns.map((entry) => entry.name), ["c"]);
    assert.match(result.migrations[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);

    const timestamps = await collect({ "20240102000000_b.sql": "alter table t add column b int;", "20240101000000_a.sql": "create table t (a int);" });
    assert.deepEqual(table(timestamps, "t").columns.map((entry) => entry.name), ["a", "b"]);

    // Without versions on every file, by name.
    assert.deepEqual(readMigrationFiles(migrations({ "b.sql": "", "a.sql": "", "c.txt": "" })).map((file) => file.file), ["a.sql", "b.sql"]);
    assert.throws(() => readMigrationFiles(migrations({ "1_a.sql": "", "001_b.sql": "" })), (error: unknown) => error instanceof MigrationSourceError && /same version \(1\)/.test(error.message));
  });

  test("the migrations directory is found in a project by convention", () => {
    const project = migrations({});
    mkdirSync(join(project, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(project, "supabase", "migrations", "1.sql"), "select 1;");
    assert.equal(findMigrationsDirectory(project), join(project, "supabase", "migrations"));
    assert.throws(() => findMigrationsDirectory(migrations({ "readme.md": "" })), (error: unknown) => error instanceof MigrationSourceError && /No PostgreSQL migrations found/.test(error.message));
  });

  test("a migration PostgreSQL cannot parse is an error at its file, line, and column, and nothing is collected", async () => {
    await assert.rejects(
      collect({ "1_ok.sql": "create table t (id int);", "2_broken.sql": "-- ünïcode comment\ncreate table u (\n  id int,,\n  name text\n);" }),
      (error: unknown) => error instanceof MigrationSyntaxError && error.file === "2_broken.sql" && error.line === 3 && error.column === 10 && /syntax error at or near ","/.test(error.message),
    );
  });

  test("a chain that PostgreSQL would refuse is an error at the statement it would refuse", async () => {
    const refused = async (sql: string, message: RegExp): Promise<void> =>
      assert.rejects(collect({ "1.sql": "create table t (id int primary key, n int unique);", "2.sql": sql }), (error: unknown) => error instanceof MigrationError && error.file === "2.sql" && message.test(error.message));
    await refused("\n\nalter table missing add column x int;", /^2\.sql:3: relation "missing" does not exist\.$/);
    await refused("create table t (id int);", /relation "t" already exists/);
    await refused("alter table t rename column nope to x;", /column "nope" of relation "t" does not exist/);
    await refused("alter table t drop constraint nope;", /constraint "nope" of relation "t" does not exist/);
    await refused("create table u (t_id int references t (n)); alter table t drop column n;", /cannot drop column "n" of table "t" because other objects depend on it/);
    await refused("create table u (t_id int references t); drop table t;", /cannot drop table "t" because other objects depend on it/);
    await refused("create table u (x int references nowhere (id));", /relation "nowhere" does not exist/);
    await refused("alter table t add primary key (n);", /multiple primary keys/);
  });

  test("CASCADE removes what depends on what is dropped", async () => {
    const result = await collect({
      "1.sql": "create table t (id int primary key, n int unique); create table u (id int primary key, t_n int references t (n), t_id int references t);",
      "2.sql": "alter table t drop column n cascade; drop table t cascade;",
    });
    assert.deepEqual(result.tables.map((entry) => entry.name), ["u"]);
    assert.deepEqual(table(result, "u").columns.map((entry) => entry.references), [undefined, undefined, undefined]);
  });

  test("positions are right after comments in other scripts, and expressions are read as written", async () => {
    const result = await collect({
      "1.sql": "-- 中文註解 ünïcode ✓\n/* block\n comment */\ncreate table t (id int primary key, note text default 'ä,ö' || 'ü', check (note <> 'x,)'));",
    });
    assert.equal(result.report[0]?.line, 4);
    assert.equal(column(result, "t", "note").defaultExpression, "'ä,ö' || 'ü'");
    // PostgreSQL names a check after the one column it uses: t_note_check.
    assert.deepEqual(strip(table(result, "t").checks), [{ name: "t_note_check", expression: "note <> 'x,)'", names: [{ kind: "column", name: "note" }] }]);
  });
});

describe("values of array columns: PostgreSQL's array literals are arrays", () => {
  const defaultOf = async (type: string, expression: string): Promise<{ default: unknown; expression: string | undefined }> => {
    const result = await collect({ "1.sql": `create table t (id int primary key, c ${type} default ${expression});` });
    return { default: column(result, "t", "c").default, expression: column(result, "t", "c").defaultExpression };
  };

  test("'{}' is an array without elements, not an object", async () => {
    assert.deepEqual(await defaultOf("text[]", "'{}'"), { default: [], expression: undefined });
    assert.deepEqual(await defaultOf("text[]", "'{}'::text[]"), { default: [], expression: undefined });
    assert.deepEqual(await defaultOf("integer[]", "'{ }'"), { default: [], expression: undefined });
    // A json column is another matter: there '{}' is the object it says.
    assert.deepEqual(await defaultOf("jsonb", "'{}'"), { default: {}, expression: undefined });
  });

  test("the elements are values of the element's type: text as written, numbers, booleans, NULL, and arrays within arrays", async () => {
    assert.deepEqual((await defaultOf("text[]", "'{a,b c, d }'")).default, ["a", "b c", "d"]);
    assert.deepEqual((await defaultOf("text[]", `'{"a b","c,d","say \\"hi\\"","back\\\\slash","{x}",NULL,"NULL",null,""}'`)).default, ["a b", "c,d", 'say "hi"', "back\\slash", "{x}", null, "NULL", null, ""]);
    assert.deepEqual((await defaultOf("integer[]", "'{1,-2, 30}'")).default, [1, -2, 30]);
    assert.deepEqual((await defaultOf("numeric(6,2)[]", "'{1.5,2}'")).default, [1.5, 2]);
    assert.deepEqual((await defaultOf("double precision[]", "'{1e3,-0.5}'")).default, [1000, -0.5]);
    assert.deepEqual((await defaultOf("boolean[]", "'{t,false,TRUE,f}'")).default, [true, false, true, false]);
    assert.deepEqual((await defaultOf("integer[][]", "'{{1,2},{3,4}}'")).default, [[1, 2], [3, 4]]);
    assert.deepEqual((await defaultOf("text[]", "'{{a,b},{c,d}}'")).default, [["a", "b"], ["c", "d"]]);
    assert.deepEqual((await defaultOf("uuid[]", "'{00000000-0000-0000-0000-000000000001}'")).default, ["00000000-0000-0000-0000-000000000001"]);
    // Outside quotes too a backslash makes the next character itself: a space at the end stays, a comma is no end, and NULL is the text.
    assert.deepEqual((await defaultOf("text[]", "'{a\\ ,\\NULL,nu\\ll, b\\,c ,\\ }'")).default, ["a ", "NULL", "null", "b,c", " "]);
    // An integer that a number does not hold exactly is kept as the digits it was written with.
    assert.deepEqual((await defaultOf("bigint[]", "'{9007199254740993,1}'")).default, ["9007199254740993", 1]);
  });

  test("ARRAY[...] of constants is the same array", async () => {
    assert.deepEqual(await defaultOf("text[]", "ARRAY[]::text[]"), { default: [], expression: undefined });
    assert.deepEqual(await defaultOf("text[]", "array['a', 'b c']"), { default: ["a", "b c"], expression: undefined });
    assert.deepEqual(await defaultOf("integer[]", "ARRAY[1, 2, 3]::int[]"), { default: [1, 2, 3], expression: undefined });
    assert.deepEqual(await defaultOf("integer[]", "ARRAY[[1, 2], [3, 4]]"), { default: [[1, 2], [3, 4]], expression: undefined });
    assert.deepEqual(await defaultOf("text[]", "ARRAY['a', NULL]"), { default: ["a", null], expression: undefined });
  });

  test("what is not an array of constants of the element's type is kept as the expression it is, and reported", async () => {
    for (const [type, expression] of [
      ["text[]", "'{a'"],
      ["text[]", "'a,b'"],
      ["text[]", `'{"a}'`],
      ["text[]", "'[1:2]={a,b}'"],
      ["integer[]", "'{1,x}'"],
      ["boolean[]", "'{maybe}'"],
      ["text[]", "array[lower('A')]"],
      // An array is no value of a column that is not one.
      ["jsonb", "array['a']"],
      ["integer[]", "'{{1,2},{3,4}}x'"],
      // Arrays within an array are of one length; PostgreSQL refuses the others.
      ["integer[]", "'{{1,2},{3}}'"],
      ["text[]", "'{{a,b},{}}'"],
      ["integer[]", "'{1,{2}}'"],
      ["text[]", "'{a,,b}'"],
    ] as const) {
      const result = await collect({ "1.sql": `create table t (id int primary key, c ${type} default ${expression});` });
      assert.deepEqual([column(result, "t", "c").default, column(result, "t", "c").defaultExpression], [undefined, expression], expression);
      assert.deepEqual(entries(result, "retained").map((entry) => entry.object), ["t.c"], expression);
    }
  });

  test("rows that migrations insert take array literals the same way", async () => {
    const result = await collect({
      "1.sql": "create table t (id int primary key, tags text[] not null default '{}', scores int[]);\ninsert into t (id, tags, scores) values (1, '{x,\"y z\"}', '{1,2}'), (2, array['q'], null);\ninsert into t (id) values (3);",
    });
    assert.deepEqual(result.seeds.t, [{ id: 1, tags: ["x", "y z"], scores: [1, 2] }, { id: 2, tags: ["q"], scores: null }, { id: 3 }]);
  });
});

describe("temporary tables", () => {
  test("a temporary table is not a table of the schema: it, and what is done to it, is reported as not reproduced", async () => {
    const result = await collect({
      "1.sql": [
        "create table kept (id int primary key);",
        "create temporary table staging (id int, name text);",
        "create temp table scratch (id int) on commit drop;",
        "create table pg_temp.side (id int);",
        "create unlogged table fast (id int primary key);",
        "insert into staging (id, name) values (1, 'a');",
        "create index on staging (name);",
        "alter table staging add column note text;",
        "alter table staging rename column note to remark;",
        "alter table staging rename to staged;",
        "insert into kept (id) values (1);",
        "drop table staged, scratch;",
        "drop table pg_temp.side;",
      ].join("\n"),
    });
    // The unlogged table is a table like any other: it stays when the session ends.
    assert.deepEqual(result.tables.map((entry) => entry.name), ["kept", "fast"]);
    assert.deepEqual(Object.keys(result.seeds), ["kept"]);
    assert.deepEqual(
      result.report.filter((entry) => entry.category === "temporary-tables").map((entry) => [entry.line, entry.outcome, entry.object]),
      [
        [2, "not-reproduced", "staging"],
        [3, "not-reproduced", "scratch"],
        [4, "not-reproduced", "side"],
        [6, "not-reproduced", "staging"],
        [7, "not-reproduced", "staging"],
        [8, "not-reproduced", "staging"],
        [9, "not-reproduced", "staging"],
        [10, "not-reproduced", "staging"],
        [12, "not-reproduced", "staged"],
        [12, "not-reproduced", "scratch"],
        [13, "not-reproduced", "side"],
      ],
    );
    assert.equal(result.report.find((entry) => entry.line === 2)?.message, 'The temporary table "staging" lasts for one session of PostgreSQL and is not created locally.');
    assert.equal(result.report.find((entry) => entry.line === 6)?.message, '"staging" is a temporary table, which is not created locally; the statement is not applied.');
    assert.deepEqual(entries(result, "unsupported"), []);
  });

  test("a temporary table hides a table of the same name for as long as it is there, as in PostgreSQL", async () => {
    const result = await collect({
      "1.sql": [
        "create table items (id int primary key);",
        "create temp table items (id int, extra text);",
        "alter table items add column hidden int;",
        "alter table public.items add column seen int;",
        "drop table items;",
        "alter table items add column after_all int;",
      ].join("\n"),
    });
    assert.deepEqual(table(result, "items").columns.map((entry) => entry.name), ["id", "seen", "after_all"]);
  });

  test("once it is dropped its name is a table's like any other, and a table that never was is still an error", async () => {
    const result = await collect({ "1.sql": "create temp table t (id int);\ndrop table t;\ncreate table t (id int primary key);\ninsert into t values (1);" });
    assert.deepEqual([result.tables.map((entry) => entry.name), result.seeds.t], [["t"], [{ id: 1 }]]);
    await assert.rejects(collect({ "1.sql": "create temp table t (id int);\ndrop table t;\nalter table t add column x int;" }), /^MigrationError: 1\.sql:3: relation "t" does not exist\.$/);
    await assert.rejects(collect({ "1.sql": "create temp table t (id int);\ncreate temp table t (id int);" }), /^MigrationError: 1\.sql:2: relation "t" already exists\.$/);
    const again = await collect({ "1.sql": "create table kept (id int);\ncreate temp table t (id int);\ncreate temp table if not exists t (id int);\ndrop table if exists pg_temp.nope;" });
    assert.deepEqual(again.report.filter((entry) => entry.outcome === "no-effect").map((entry) => entry.line), [3, 4]);
  });

  test("a table made from a query as a temporary one is not reproduced either", async () => {
    const temporary = [["not-reproduced", "temporary-tables"], ["not-reproduced", "temporary-tables"], ["not-reproduced", "temporary-tables"]];
    const result = await collect({ "1.sql": "create table kept (id int primary key);\ncreate temp table snapshot as select * from kept;\ninsert into snapshot values (1);\ndrop table snapshot;" });
    assert.deepEqual(result.tables.map((entry) => entry.name), ["kept"]);
    assert.deepEqual(result.report.slice(1).map((entry) => [entry.outcome, entry.category]), temporary);
    // SELECT ... INTO TEMP is the same statement written the older way.
    const into = await collect({ "1.sql": "create table kept (id int primary key);\nselect id into temp snapshot from kept;\ninsert into snapshot values (1);\ndrop table snapshot;" });
    assert.deepEqual(into.tables.map((entry) => entry.name), ["kept"]);
    assert.deepEqual(into.report.slice(1).map((entry) => [entry.outcome, entry.category]), temporary);
  });

  test("a temporary table that is dropped when its transaction is committed ends there; any other ends with its migration", async () => {
    // Two migrations that each use a table of one name for the time of their transaction: a common way to move rows.
    const twice = await collect({
      "1.sql": "create table kept (id int primary key);\ncreate temp table tmp_ids (id int) on commit drop;\ninsert into tmp_ids values (1);",
      "2.sql": "create temp table tmp_ids (id int) on commit drop;\ninsert into tmp_ids values (2);",
    });
    assert.deepEqual(twice.tables.map((entry) => entry.name), ["kept"]);
    assert.equal(twice.report.find((entry) => entry.file === "2.sql" && entry.line === 1)?.message, 'The temporary table "tmp_ids" lasts until its transaction is committed and is not created locally.');
    // The same in one migration, in two transactions; END is COMMIT, and a transaction that is rolled back ends as well.
    for (const end of ["commit", "end", "rollback", "abort"]) {
      const inOne = await collect({ "1.sql": `create table kept (id int primary key);\nbegin;\ncreate temp table tmp_ids (id int) on commit drop;\n${end};\nbegin;\ncreate temp table tmp_ids as select 1 as id;\ncommit;` });
      assert.deepEqual(inOne.tables.map((entry) => entry.name), ["kept"], end);
    }
    const fromAQuery = await collect({ "1.sql": "create temp table tmp_ids on commit drop as select 1 as id;\ncommit;\ncreate temp table tmp_ids (id int);" });
    assert.deepEqual(fromAQuery.tables, []);
    // A savepoint ends nothing, and neither does going back to one.
    await assert.rejects(
      collect({ "1.sql": "begin;\ncreate temp table t (id int) on commit drop;\nsavepoint s;\nrollback to savepoint s;\nrelease savepoint s;\ncreate temp table t (id int);" }),
      /^MigrationError: 1\.sql:6: relation "t" already exists\.$/,
    );
    // Without ON COMMIT DROP the table lasts for its session: a COMMIT does not end it. The end of the migration does: no migration can count on the session of another.
    await assert.rejects(collect({ "1.sql": "begin;\ncreate temp table t (id int);\ncommit;\ncreate temp table t (id int);" }), /^MigrationError: 1\.sql:4: relation "t" already exists\.$/);
    const nextFile = await collect({ "1.sql": "create table kept (id int primary key);\ncreate temp table t (id int);", "2.sql": "create temp table t (id int);" });
    assert.deepEqual(nextFile.tables.map((entry) => entry.name), ["kept"]);
    await assert.rejects(collect({ "1.sql": "create temp table t (id int);", "2.sql": "insert into t values (1);" }), /^MigrationError: 2\.sql:1: relation "t" does not exist\.$/);
  });

  test("when a temporary table has ended, its name is that of a table of the schema again", async () => {
    const rest = "create table items (id int primary key);\nalter table items add column name text;\ninsert into items (id, name) values (1, 'a');\ncreate index items_name_idx on items (name);";
    for (const [title, files] of [
      ["dropped at commit", { "1.sql": `begin;\ncreate temp table items (id int) on commit drop;\ncommit;\n${rest}` }],
      ["of an earlier migration", { "1.sql": "create temp table items (id int);", "2.sql": rest }],
    ] as const) {
      const result = await collect(files);
      assert.deepEqual(table(result, "items").columns.map((entry) => entry.name), ["id", "name"], title);
      assert.deepEqual(result.seeds.items, [{ id: 1, name: "a" }], title);
      assert.deepEqual(table(result, "items").indexes?.map((entry) => entry.name), ["items_name_idx"], title);
    }
  });

  test("an index of a temporary table is not an index of the schema; it is renamed and dropped by its name, and goes with its table", async () => {
    const result = await collect({
      "1.sql": [
        "create table kept (id int primary key, name text);",
        "create temp table tmp (id int, name text);",
        "create index tmp_id_idx on tmp (id);",
        // PostgreSQL names this one tmp_name_idx.
        "create index on tmp (name);",
        "alter index tmp_id_idx rename to tmp_by_id;",
        "drop index tmp_by_id;",
        "drop index tmp_name_idx;",
        // The name of a temporary table's index is not taken in the schema.
        "create index tmp_other_idx on tmp (id);",
        "create index tmp_other_idx on kept (name);",
      ].join("\n"),
    });
    assert.deepEqual(table(result, "kept").indexes?.map((entry) => entry.name), ["tmp_other_idx"]);
    assert.deepEqual(
      result.report.filter((entry) => entry.category === "temporary-tables").map((entry) => [entry.line, entry.outcome, entry.object]),
      [
        [2, "not-reproduced", "tmp"],
        [3, "not-reproduced", "tmp"],
        [4, "not-reproduced", "tmp"],
        [5, "not-reproduced", "tmp_by_id"],
        [6, "not-reproduced", "tmp_by_id"],
        [7, "not-reproduced", "tmp_name_idx"],
        [8, "not-reproduced", "tmp"],
      ],
    );
    assert.equal(result.report.find((entry) => entry.line === 5)?.message, 'Renamed the index "tmp_id_idx" of the temporary table "tmp" to "tmp_by_id"; it was not created locally.');
    assert.equal(result.report.find((entry) => entry.line === 6)?.message, 'Dropped the index "tmp_by_id" of the temporary table "tmp", which was not created locally.');
    // The index goes with its table: by a DROP TABLE, at commit, and at the end of the migration.
    await assert.rejects(collect({ "1.sql": "create temp table tmp (id int);\ncreate index tmp_idx on tmp (id);\ndrop table tmp;\ndrop index tmp_idx;" }), /^MigrationError: 1\.sql:4: index "tmp_idx" does not exist\.$/);
    await assert.rejects(collect({ "1.sql": "create temp table tmp (id int) on commit drop;\ncreate index tmp_idx on tmp (id);\ncommit;\ndrop index tmp_idx;" }), /^MigrationError: 1\.sql:4: index "tmp_idx" does not exist\.$/);
    await assert.rejects(collect({ "1.sql": "create temp table tmp (id int);\ncreate index tmp_idx on tmp (id);", "2.sql": "drop index tmp_idx;" }), /^MigrationError: 2\.sql:1: index "tmp_idx" does not exist\.$/);
    // It follows a table that is renamed, and hides an index of the schema of its name while it is there.
    const hidden = await collect({
      "1.sql": "create table kept (id int primary key);\ncreate index same_idx on kept (id);\ncreate temp table tmp (id int);\ncreate index same_idx on tmp (id);\nalter table tmp rename to tmp2;\ndrop index same_idx;\ndrop table tmp2;",
    });
    assert.deepEqual(table(hidden, "kept").indexes?.map((entry) => entry.name), ["same_idx"]);
    // Named in the schema, it is the schema's index that is meant.
    const named = await collect({ "1.sql": "create table kept (id int primary key);\ncreate index same_idx on kept (id);\ncreate temp table tmp (id int);\ncreate index same_idx on tmp (id);\ndrop index public.same_idx;\ndrop index pg_temp.same_idx;" });
    assert.deepEqual([table(named, "kept").indexes, named.report.slice(-2).map((entry) => entry.category)], [undefined, ["index", "temporary-tables"]]);
    // A renamed index has its new name only, and one whose table was renamed goes with that table.
    await assert.rejects(collect({ "1.sql": "create temp table tmp (id int);\ncreate index tmp_idx on tmp (id);\nalter index tmp_idx rename to tmp_by_id;\ndrop index tmp_idx;" }), /^MigrationError: 1\.sql:4: index "tmp_idx" does not exist\.$/);
    await assert.rejects(
      collect({ "1.sql": "create temp table tmp (id int);\ncreate index tmp_idx on tmp (id);\nalter table tmp rename to tmp2;\ndrop table tmp2;\ndrop index tmp_idx;" }),
      /^MigrationError: 1\.sql:5: index "tmp_idx" does not exist\.$/,
    );
  });
});

describe("numbering and keys that migrations make in steps", () => {
  const numbered = (result: CollectedSchema, name: string): unknown[] => [column(result, "t", name).generated, column(result, "t", name).default];

  test("a serial column is numbered by its default: dropping or replacing the default ends the numbering", async () => {
    const result = await collect({
      "1.sql": "create table t (id serial primary key, n serial, m serial, name text);",
      "2.sql": "alter table t alter column n drop default;\nalter table t alter column m set default 7;",
    });
    assert.deepEqual([numbered(result, "id"), numbered(result, "n"), numbered(result, "m")], [["increment", undefined], [undefined, undefined], [undefined, 7]]);
    // The column a serial made is still NOT NULL.
    assert.deepEqual([column(result, "t", "n").nullable, column(result, "t", "m").nullable], [false, false]);
  });

  test("a dropped default takes what it generated with it: a UUID default that is dropped generates nothing", async () => {
    const result = await collect({ "1.sql": "create table t (id uuid primary key default gen_random_uuid(), other uuid default gen_random_uuid());", "2.sql": "alter table t alter column other drop default;" });
    assert.deepEqual([column(result, "t", "id").generated, column(result, "t", "other").generated, column(result, "t", "other").defaultExpression], ["uuid", undefined, undefined]);
  });

  test("the usual way from serial to identity: drop the default, add the identity", async () => {
    const result = await collect({ "1.sql": "create table t (id serial primary key);", "2.sql": "alter table t alter column id drop default;\nalter table t alter column id add generated by default as identity;" });
    assert.deepEqual([column(result, "t", "id").generated, column(result, "t", "id").autoIncrement], ["increment", true]);
  });

  test("an identity cannot be added to a column that has a default, is one already, or takes NULL, as in PostgreSQL", async () => {
    const refused = (sql: string, message: string): Promise<void> =>
      assert.rejects(collect({ "1.sql": "create table t (id serial primary key, n int not null default 3, i int generated by default as identity, free int);", "2.sql": sql }), (error: Error) => error.message === `2.sql:1: ${message}`, `${sql}: ${message}`);
    await refused("alter table t alter column id add generated always as identity;", 'column "id" of relation "t" already has a default value.');
    await refused("alter table t alter column n add generated always as identity;", 'column "n" of relation "t" already has a default value.');
    await refused("alter table t alter column i add generated always as identity;", 'column "i" of relation "t" is already an identity column.');
    await refused("alter table t alter column free add generated always as identity;", 'column "free" of relation "t" must be declared NOT NULL before identity can be added.');
    await assert.rejects(collect({ "1.sql": "create table t (id serial default 5);" }), /^MigrationError: 1\.sql:1: multiple default values specified for column "id" of table "t"\.$/);
    await assert.rejects(collect({ "1.sql": "create table t (id int default 5 default 6);" }), /^MigrationError: 1\.sql:1: multiple default values specified for column "id" of table "t"\.$/);
    await assert.rejects(collect({ "1.sql": "create table t (id serial generated always as identity);" }), /^MigrationError: 1\.sql:1: both default and identity specified for column "id" of table "t"\.$/);
    await assert.rejects(collect({ "1.sql": "create table t (id int default 5 generated always as identity);" }), /^MigrationError: 1\.sql:1: both default and identity specified for column "id" of table "t"\.$/);
  });

  test("the sequences of a column keep their names for as long as PostgreSQL keeps them", async () => {
    // A serial's sequence stays with the column when the default goes, so an identity added later gets the next name.
    const result = await collect({
      "1.sql": "create table t (id serial primary key, other int);",
      "2.sql": "alter table t alter column id drop default;\nalter table t alter column id add generated by default as identity;\ncreate index t_id_seq1 on t (other);",
    }).then(
      () => "collected",
      (error: Error) => error.message,
    );
    assert.equal(result, '2.sql:3: relation "t_id_seq1" already exists.');
    // The identity's sequence goes with the identity; the serial's goes with the column.
    const freed = await collect({
      "1.sql": "create table t (id int generated always as identity primary key, n serial, other int);",
      "2.sql": "alter table t alter column id drop identity;\ncreate index t_id_seq on t (other);\nalter table t drop column n;\ncreate index t_n_seq on t (other);",
    });
    assert.deepEqual(table(freed, "t").indexes?.map((entry) => entry.name), ["t_id_seq", "t_n_seq"]);
    // A default that calls nextval() uses a sequence that is not the column's: no name is taken for it.
    const borrowed = await collect({ "1.sql": "create sequence counter;\ncreate table t (id int primary key default nextval('counter'), other int);\ncreate index t_id_seq on t (other);" });
    assert.deepEqual([column(borrowed, "t", "id").generated, table(borrowed, "t").indexes?.map((entry) => entry.name)], ["increment", ["t_id_seq"]]);
  });

  test("an identity column has no default to drop or set, and a serial column no identity to drop, as in PostgreSQL", async () => {
    const identity = "create table t (id int generated always as identity primary key, n serial);";
    await assert.rejects(collect({ "1.sql": identity, "2.sql": "alter table t alter column id drop default;" }), /^MigrationError: 2\.sql:1: column "id" of relation "t" is an identity column\.$/);
    await assert.rejects(collect({ "1.sql": identity, "2.sql": "alter table t alter column id set default 1;" }), /^MigrationError: 2\.sql:1: column "id" of relation "t" is an identity column\.$/);
    await assert.rejects(collect({ "1.sql": identity, "2.sql": "alter table t alter column n drop identity;" }), /^MigrationError: 2\.sql:1: column "n" of relation "t" is not an identity column\.$/);
    const skipped = await collect({ "1.sql": identity, "2.sql": "alter table t alter column n drop identity if exists;\nalter table t alter column id drop identity;" });
    assert.deepEqual([numbered(skipped, "n"), numbered(skipped, "id")], [["increment", undefined], [undefined, undefined]]);
    assert.deepEqual(entries(skipped, "no-effect").map((entry) => entry.message), ['"t"."n" is not an identity column (IF EXISTS); nothing done.']);
  });

  test("a key made from an index (USING INDEX) is over the index's columns, and the index becomes the key's own", async () => {
    const result = await collect({
      "1.sql": [
        "create table t (id int, a int, b int);",
        "create unique index t_id_idx on t (id);",
        "create unique index t_a_idx on t (a);",
        "create unique index on t (b);",
        "create index t_plain_idx on t (a, b);",
        "alter table t add constraint t_pk primary key using index t_id_idx;",
        "alter table t add constraint t_a_once unique using index t_a_idx;",
        "alter table t add unique using index t_b_idx;",
      ].join("\n"),
    });
    const found = table(result, "t");
    assert.deepEqual([found.primaryKey?.name, found.primaryKey?.columns, column(result, "t", "id").primary, column(result, "t", "id").nullable], ["t_pk", ["id"], true, false]);
    // Without a name of its own, the constraint has the index's.
    assert.deepEqual(found.uniques?.map((entry) => [entry.name, entry.columns]), [
      ["t_a_once", ["a"]],
      ["t_b_idx", ["b"]],
    ]);
    // The indexes are the constraints' now: they are no longer indexes of their own.
    assert.deepEqual(found.indexes?.map((entry) => entry.name), ["t_plain_idx"]);
    // A name the migration wrote, for the index or for the constraint, is not one PostgreSQL chose.
    assert.deepEqual([found.primaryKey?.origin?.generatedName, found.uniques?.[0]?.origin?.generatedName, found.uniques?.[1]?.origin?.generatedName], [undefined, undefined, true]);
    assert.deepEqual([found.primaryKey?.origin?.line, found.uniques?.[1]?.origin?.line], [6, 8]);
    // The index's old name is free again, and the key's name is taken.
    const made = "create table t (id int, a int);\ncreate unique index t_id_idx on t (id);\nalter table t add constraint t_pk primary key using index t_id_idx;\n";
    const again = await collect({ "1.sql": `${made}create index t_id_idx on t (a);` });
    assert.deepEqual(table(again, "t").indexes?.map((entry) => entry.name), ["t_id_idx"]);
    await assert.rejects(collect({ "1.sql": `${made}create index t_pk on t (a);` }), /^MigrationError: 1\.sql:4: relation "t_pk" already exists\.$/);
  });

  test("a key cannot be made from an index that is not there, another table's, a constraint's already, not unique, partial, or over expressions, as in PostgreSQL", async () => {
    const setup = ["create table t (id int, a int);", "create table u (id int);", "create unique index u_id_idx on u (id);", "create index t_plain_idx on t (id);", "create unique index t_part_idx on t (id) where a > 0;", "create unique index t_expr_idx on t ((id + 1));", "create unique index t_a_idx on t (a);", "alter table t add unique using index t_a_idx;"];
    const refused = (sql: string, message: string): Promise<void> => assert.rejects(collect({ "1.sql": `${setup.join("\n")}\n${sql}` }), (error: Error) => error.message === `1.sql:${setup.length + 1}: ${message}`, `${sql}: ${message}`);
    await refused("alter table t add primary key using index nope;", 'index "nope" does not exist.');
    await refused("alter table t add primary key using index u_id_idx;", 'index "u_id_idx" does not belong to table "t".');
    await refused("alter table t add primary key using index t_a_idx;", 'index "t_a_idx" is already associated with a constraint.');
    await refused("alter table t add unique using index t_plain_idx;", '"t_plain_idx" is not a unique index.');
    await refused("alter table t add unique using index t_part_idx;", '"t_part_idx" is a partial index.');
    await refused("alter table t add unique using index t_expr_idx;", 'index "t_expr_idx" contains expressions.');
    await refused("create table v (id int, primary key using index t_a_idx);", "cannot use an existing index in CREATE TABLE.");
  });
});

describe("a chain with the structure of a Supabase project's migrations (synthetic)", () => {
  test("gives the tables its application uses, and reports what Supabase does that the sandbox does not", async () => {
    const result = await collectPostgresMigrations(join(FIXTURES, "market-chain"), { now: NOW });
    assert.deepEqual(result.migrations.map((migration) => migration.file), [
      "0001_init.sql",
      "0002_schedule.sql",
      "0003_snapshots_and_state.sql",
      "0004_liquidity.sql",
      "0005_directional.sql",
      "0006_state_label.sql",
      "0007_state_discovery.sql",
    ]);
    const shape = Object.fromEntries(
      result.tables.map((entry) => [
        entry.name,
        entry.columns.map((item) => `${item.name} ${item.type}${item.primary ? " pk" : ""}${item.nullable ? "" : " not null"}${item.default !== undefined ? ` =${JSON.stringify(item.default)}` : ""}${item.defaultFunction !== undefined ? ` =${item.defaultFunction}` : ""}${item.references !== undefined ? ` -> ${item.references.table}.${item.references.column} ${item.references.onDelete}` : ""}`),
      ]),
    );
    assert.deepEqual(shape, {
      assets: ["id text pk not null", "label text not null", "image_url text"],
      asset_rates: [
        "from_asset text pk not null -> assets.id CASCADE",
        "to_asset text pk not null -> assets.id CASCADE",
        "reference_rate numeric not null",
        "updated_at datetime not null =current_timestamp",
        "low_ratio numeric",
        "high_ratio numeric",
        "input_volume numeric not null =0",
        "output_volume numeric not null =0",
      ],
      pair_snapshots: ["hour_ts datetime pk not null", "item_a text pk not null", "item_b text pk not null", "volume_a numeric not null", "volume_b numeric not null", "stock_a numeric not null =0", "stock_b numeric not null =0"],
      job_state: ["id integer pk not null =1", "cursor_id integer", "updated_at datetime not null =current_timestamp", "label text", "label_found_at datetime", "label_source text"],
    });
    assert.deepEqual([column(result, "job_state", "cursor_id").declaredType, column(result, "job_state", "cursor_id").sourceDialectType], ["bigint", { dialect: "postgresql", type: "int8" }]);
    assert.deepEqual(strip(table(result, "job_state").checks), [{ name: "job_state_singleton", expression: "id = 1", names: [{ kind: "column", name: "id" }] }]);
    assert.deepEqual(result.seeds, { job_state: [{ id: 1, cursor_id: null }] });
    const summary = summarizeReport(result.report);
    assert.deepEqual(summary.notReproduced, { "row-level-security": 6, extensions: 2, scheduling: 1 });
    assert.equal(summary.outcomes.unsupported, 0);
    // The statement after a long comment with Umlauts is found at its line.
    assert.ok(result.report.some((entry) => entry.file === "0004_liquidity.sql" && entry.line === 2 && entry.kind === "AlterTableStmt/AT_AddColumn"));
  });
});
