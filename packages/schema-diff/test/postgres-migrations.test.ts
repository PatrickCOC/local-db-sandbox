import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { diffSchemas, stringifySchemaDiff } from "../src/index.ts";
import type { SchemaChange } from "../src/index.ts";
import { collect } from "../../import-postgres/test/support.ts";
import type { DatabaseSchema } from "../../runtime/src/index.ts";

/*
 * The diff of schemas that the PostgreSQL migration collector made. The diff
 * itself knows nothing of PostgreSQL; these tests are where the two meet:
 * what PostgreSQL treats as one thing must not show as a difference, and what
 * a migration states explicitly must be found.
 */

async function schemaOf(files: Record<string, string>): Promise<DatabaseSchema> {
  const { tables, types } = await collect(files);
  return { tables, types };
}

async function changesBetween(before: Record<string, string>, after: Record<string, string>): Promise<SchemaChange[]> {
  return diffSchemas(await schemaOf(before), await schemaOf(after)).changes;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("schema diff of collected PostgreSQL migrations", () => {
  test("two ways of writing the same schema are not different: type aliases, where a constraint is written, how a default is spelled", async () => {
    const written = `
      create type mood as enum ('ok', 'meh');
      create table parents (id integer primary key);
      create table t (
        id integer primary key,
        small smallint,
        big bigint not null,
        ratio real,
        precise double precision,
        amount numeric(10),
        price decimal(12,2) default 0,
        flag boolean not null default true,
        code varchar(20) unique,
        letter char(3),
        day date,
        at timestamp with time zone not null default now(),
        local_at timestamp without time zone,
        clock time with time zone,
        tags integer[],
        doc jsonb default '{}'::jsonb,
        feeling mood default 'ok',
        parent_id integer references parents (id) on delete no action,
        check (small > 0)
      );
      create index on t (day);`;
    const otherwise = `
      CREATE TYPE mood AS ENUM ('ok', 'meh');
      CREATE TABLE parents (id int4, PRIMARY KEY (id));
      CREATE TABLE t (
        id int NOT NULL,
        small int2 CHECK (small > 0),
        big int8 NOT NULL,
        ratio float4,
        precise float8,
        amount numeric(10, 0),
        price numeric(12,2) DEFAULT '0',
        flag bool DEFAULT 't' NOT NULL,
        code character varying(20),
        letter character(3),
        day date,
        at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
        local_at timestamp,
        clock timetz,
        tags int4 ARRAY,
        doc jsonb DEFAULT '{}',
        feeling public.mood DEFAULT 'ok'::mood,
        parent_id int4,
        PRIMARY KEY (id),
        UNIQUE (code),
        FOREIGN KEY (parent_id) REFERENCES parents
      );
      CREATE INDEX t_day_idx ON t USING btree (day);`;
    assert.deepEqual(await changesBetween({ "1.sql": written }, { "1.sql": otherwise }), []);
    assert.deepEqual(await changesBetween({ "1.sql": otherwise }, { "1.sql": written }), []);
  });

  const INIT = ["create type status as enum ('draft', 'live');", "create table rates (id serial primary key, rate numeric not null, state status not null default 'draft');", "create index rates_rate_idx on rates (rate);"].join("\n");
  const CHANGE = [
    "alter table rates rename column rate to reference_rate;",
    "alter table rates add column low numeric, add column high numeric;",
    "alter type status rename value 'live' to 'published';",
    "alter type status add value 'archived';",
    "alter table rates rename to asset_rates;",
    "alter index rates_rate_idx rename to asset_rates_rate_idx;",
    "alter table asset_rates rename constraint rates_pkey to asset_rates_pkey;",
  ].join("\n");

  test("what later migrations rename is renamed, with the statement that renamed it; what they add is added", async () => {
    const created = (statement: number, name: string, generatedName = false): object => ({
      source: "postgresql-migrations",
      file: "0001_init.sql",
      sha256: sha256(INIT),
      statement,
      line: statement,
      name,
      ...(generatedName && { generatedName: true }),
    });
    const renamedAt = (statement: number, from: string, to: string): object => ({ from, to, at: { source: "postgresql-migrations", file: "0002_change.sql", sha256: sha256(CHANGE), statement, line: statement } });
    const numeric = { storage: "numeric", canonical: { kind: "decimal" }, declared: "numeric" };
    const added = (name: string): object => ({ source: "postgresql-migrations", file: "0002_change.sql", sha256: sha256(CHANGE), statement: 2, line: 2, name });

    assert.deepEqual(await changesBetween({ "0001_init.sql": INIT }, { "0001_init.sql": INIT, "0002_change.sql": CHANGE }), [
      { op: "renameEnumValue", enum: "status", from: "live", to: "published", evidence: { origin: created(1, "status"), renames: [renamedAt(3, "live", "published")] } },
      { op: "renameTable", table: "asset_rates", from: "rates", evidence: { origin: created(2, "rates"), renames: [renamedAt(5, "rates", "asset_rates")] } },
      { op: "renameColumn", table: "asset_rates", column: "reference_rate", from: "rate", evidence: { origin: created(2, "rate"), renames: [renamedAt(1, "rate", "reference_rate")] } },
      { op: "renameConstraint", table: "asset_rates", kind: "primaryKey", constraint: "asset_rates_pkey", from: "rates_pkey", evidence: { origin: created(2, "rates_pkey", true), renames: [renamedAt(7, "rates_pkey", "asset_rates_pkey")] } },
      { op: "renameIndex", table: "asset_rates", index: "asset_rates_rate_idx", from: "rates_rate_idx", evidence: { origin: created(3, "rates_rate_idx"), renames: [renamedAt(6, "rates_rate_idx", "asset_rates_rate_idx")] } },
      { op: "addEnumValue", enum: "status", value: "archived", afterValue: "published" },
      { op: "addColumn", table: "asset_rates", column: "high", after: { name: "high", type: numeric, nullable: true, origin: added("high") } },
      { op: "addColumn", table: "asset_rates", column: "low", after: { name: "low", type: numeric, nullable: true, origin: added("low") } },
    ]);
  });

  test("the schema that renames led to is the schema that was written that way from the start", async () => {
    const squashed = [
      "create type status as enum ('draft', 'published', 'archived');",
      "create table asset_rates (id serial constraint asset_rates_pkey primary key, reference_rate numeric not null, state status not null default 'draft', low numeric, high numeric);",
      "create index asset_rates_rate_idx on asset_rates (reference_rate);",
    ].join("\n");
    assert.deepEqual(await changesBetween({ "0001_init.sql": INIT, "0002_change.sql": CHANGE }, { "0001_squashed.sql": squashed }), []);
    assert.deepEqual(await changesBetween({ "0001_squashed.sql": squashed }, { "0001_init.sql": INIT, "0002_change.sql": CHANGE }), []);
  });

  test("a renamed column whose old name is taken by a new column stays a rename", async () => {
    const ops = (await changesBetween({ "0001_init.sql": INIT }, { "0001_init.sql": INIT, "0002_change.sql": "alter table rates rename column rate to reference_rate;\nalter table rates add column rate text;" })).map(
      (change) => `${change.op} ${"column" in change ? change.column : ""}`,
    );
    assert.deepEqual(ops, ["renameColumn reference_rate", "addColumn rate"]);
  });

  test("when the file that created an object has changed since, a rename of it cannot be told: the old name is dropped and the new one added", async () => {
    const rename = "alter table rates rename column rate to reference_rate;";
    const ops = async (first: string): Promise<string[]> => (await changesBetween({ "0001_init.sql": INIT }, { "0001_init.sql": first, "0002_change.sql": rename })).map((change) => change.op);
    assert.deepEqual(await ops(INIT), ["renameColumn"]);
    // The index on the column goes and comes with it.
    assert.deepEqual(await ops(`${INIT}\n-- reviewed`), ["dropIndex", "dropColumn", "addColumn", "addIndex"]);
  });

  test("the same migrations give the same diff, byte for byte, in whatever order the schemas list their tables and types", async () => {
    const before = await schemaOf({ "0001_init.sql": INIT });
    const after = await schemaOf({ "0001_init.sql": INIT, "0002_change.sql": `${CHANGE}\ncreate table extra (id int primary key);\ncreate type extra_kind as enum ('a');` });
    const text = stringifySchemaDiff(diffSchemas(before, after));
    assert.equal(stringifySchemaDiff(diffSchemas(await schemaOf({ "0001_init.sql": INIT }), after)), text);
    const reversed = (schema: DatabaseSchema): DatabaseSchema => ({ tables: [...schema.tables].reverse(), types: { enums: [...schema.types.enums].reverse() } });
    assert.equal(stringifySchemaDiff(diffSchemas(reversed(before), reversed(after))), text);
  });
});
