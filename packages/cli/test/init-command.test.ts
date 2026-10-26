import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startPostgrestSandbox } from "../../postgrest/src/index.ts";
import { clientFor } from "../../postgrest/test/support.ts";
import { inspectDatabase, openDatabaseStorage } from "../../storage-json/src/index.ts";
import { storedRows } from "../../storage-json/test/support/database-files.ts";
import { bootstrapDatabase, runCli } from "../src/index.ts";

const MARKET_CHAIN = join(import.meta.dirname, "../../import-postgres/test/fixtures/market-chain");

describe("CLI: init (PostgreSQL migrations to a sandbox database)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-init-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  }

  /** A project that keeps its migrations where Supabase does. */
  function project(files: Record<string, string>): string {
    const root = join(dir, "project");
    mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
    for (const [name, sql] of Object.entries(files)) {
      writeFileSync(join(root, "supabase", "migrations", name), sql);
    }
    return root;
  }

  it("prints its help, and is listed in the general help", async () => {
    const { code, stdout } = await run("init", "--help");
    assert.equal(code, 0);
    assert.match(stdout, /Usage: local-db-sandbox init <project-or-migrations>/);
    assert.match(stdout, /row level security,\s+roles and grants, extensions, functions, triggers, scheduled jobs/);
    assert.match((await run("--help")).stdout, /init <project-or-migrations>/);
  });

  it("creates a database from a project's migrations, with their rows, and writes the report", async () => {
    const root = project({
      "0001_init.sql": "create type mood as enum ('ok', 'meh');\ncreate table notes (id serial primary key, body text not null, mood mood default 'ok', created_at timestamptz not null default now());",
      "0002_seed.sql": "insert into notes (body) values ('hello');\nalter table notes enable row level security;",
    });
    const { code, stdout, stderr } = await run("init", root);
    assert.equal(stderr, "");
    assert.equal(code, 0);
    const database = join(root, ".local-db-sandbox", "sandbox.db");
    assert.match(stdout, /Read 2 migrations \(4 statements\) from .*supabase[\\/]migrations/);
    assert.match(stdout, /notes: 4 columns, 1 row/);
    assert.match(stdout, /enumerated types: mood/);
    assert.match(stdout, /row level security and policies: 1 statement/);
    assert.match(stdout, /Next: local-db-sandbox postgrest /);

    // The database is a directory of the current format, made by the runtime: the computed default is filled in.
    assert.deepEqual([inspectDatabase(database).formatVersion, inspectDatabase(database).compatibility], [5, "current"]);
    const [row] = (await storedRows(database, "notes")) as { id: number; body: string; mood: string; created_at: string }[];
    assert.deepEqual([row?.id, row?.body, row?.mood], [1, "hello", "ok"]);
    assert.match(row?.created_at ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    const report = JSON.parse(readFileSync(join(root, ".local-db-sandbox", "sandbox.db.report.json"), "utf8"));
    assert.equal(report.source.kind, "postgresql-migrations");
    assert.deepEqual(report.source.migrations.map((migration: { file: string }) => migration.file), ["0001_init.sql", "0002_seed.sql"]);
    assert.deepEqual(report.summary.notReproduced, { "row-level-security": 1 });
    assert.deepEqual(report.provenance.tables.notes.created, { file: "0001_init.sql", line: 2 });
    assert.equal(report.entries.length, 4);
  });

  it("does not replace a database unless told to, and --force replaces it", async () => {
    const root = project({ "1.sql": "create table t (id int primary key);" });
    const out = join(dir, "out.db");
    assert.equal((await run("init", root, "--out", out)).code, 0);
    const again = await run("init", root, "--out", out);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /out\.db exists\. Use --force to replace it; the rows it holds are lost\./);
    writeFileSync(join(root, "supabase", "migrations", "2.sql"), "alter table t add column n int;");
    assert.equal((await run("init", root, "--out", out, "--force")).code, 0);
    assert.deepEqual(openDatabaseStorage(out).schema, undefined);
    const storage = openDatabaseStorage(out);
    await storage.load();
    assert.deepEqual(storage.schema?.[0]?.columns.map((column) => column.name), ["id", "n"]);
  });

  it("with --strict, an unsupported statement fails and nothing is written; without it, the statement is listed", async () => {
    const root = project({ "1.sql": "create table t (id int primary key);\ncreate view v as select * from t;" });
    const out = join(dir, "strict.db");
    const strict = await run("init", root, "--out", out, "--strict");
    assert.equal(strict.code, 1);
    assert.match(strict.stderr, /1\.sql:2: The view v is not created locally/);
    assert.match(strict.stderr, /1 statement of the migrations is unsupported \(--strict\)\. Nothing was written\./);
    assert.equal(existsSync(out), false);
    const lenient = await run("init", root, "--out", out);
    assert.equal(lenient.code, 0);
    assert.match(lenient.stdout, /Unsupported \(the local schema may differ from PostgreSQL's here\):\n  1\.sql:2: The view v is not created locally/);
  });

  it("refuses a migration PostgreSQL cannot parse, and a chain it would refuse, and writes nothing", async () => {
    const out = join(dir, "never.db");
    const broken = await run("init", project({ "1.sql": "create table t (id int);", "2.sql": "\ncreate tabel u (id int);" }), "--out", out);
    assert.equal(broken.code, 1);
    assert.match(broken.stderr, /2\.sql:2:8: PostgreSQL cannot parse this migration: syntax error at or near "tabel"\. Nothing was written\./);
    await rm(join(dir, "project"), { recursive: true });
    const refused = await run("init", project({ "1.sql": "alter table t add column n int;" }), "--out", out);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /1\.sql:1: relation "t" does not exist\. Nothing was written\./);
    assert.equal(existsSync(out), false);
    assert.match((await run("init", dir)).stderr, /No PostgreSQL migrations found/);
  });

  it("a database it creates can be read again, whatever the migrations use: a negative scale, a key made from an index, a serial that stops numbering", async () => {
    const root = project({
      "0001_init.sql": [
        "create table accounts (id int, code text not null, balance numeric(5, -2), ratio numeric(3, 5), n serial, extra int);",
        "create unique index accounts_id_idx on accounts (id);",
        "create unique index on accounts (code) include (extra);",
      ].join("\n"),
      "0002_keys.sql": ["alter table accounts add constraint accounts_pk primary key using index accounts_id_idx;", "alter table accounts add unique using index accounts_code_extra_idx;", "alter table accounts alter column n drop default;"].join("\n"),
    });
    const out = join(dir, "readable.db");
    const created = await run("init", root, "--out", out);
    assert.equal(created.code, 0, created.stderr);

    const storage = openDatabaseStorage(out);
    await storage.load();
    const [accounts] = storage.schema ?? [];
    assert.deepEqual([accounts?.primaryKey, accounts?.uniques?.map((unique) => [unique.name, unique.columns]), accounts?.indexes], [{ name: "accounts_pk", columns: ["id"], origin: accounts?.primaryKey?.origin }, [["accounts_code_extra_idx", ["code"]]], undefined]);
    const columns = Object.fromEntries((accounts?.columns ?? []).map((column) => [column.name, column]));
    assert.deepEqual([columns.balance?.canonicalType, columns.ratio?.canonicalType], [{ kind: "decimal", precision: 5, scale: -2 }, { kind: "decimal", precision: 3, scale: 5 }]);
    assert.deepEqual([columns.id?.primary, columns.id?.nullable, columns.n?.generated, columns.n?.nullable], [true, false, undefined, false]);

    // What it stores is what the migrations say: nothing differs, in either direction.
    for (const [before, after] of [
      [out, root],
      [root, out],
    ] as const) {
      const diff = await run("diff-schema", before, after);
      assert.equal(diff.code, 0, diff.stderr);
      assert.match(diff.stdout, /\nNo differences\.\n$/);
    }
    assert.equal((await run("inspect", out)).code, 0);
  });

  it("defaults that are bytes or arrays are applied to the rows it loads, and a temporary table is no table of the database", async () => {
    const root = project({
      "0001_init.sql": [
        "create table files (id int primary key, body bytea not null default '\\x0102ff', empty bytea default '\\x', tags text[] not null default '{}', scores int[] default '{1,2}');",
        "create temporary table staging (id int, body bytea);",
        "insert into staging (id) values (1);",
        "insert into files (id) values (1);",
        "insert into files (id, tags) values (2, '{a,\"b c\"}');",
        "drop table staging;",
      ].join("\n"),
    });
    const out = join(dir, "defaults.db");
    const created = await run("init", root, "--out", out);
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /\n {2}files: 5 columns, 2 rows\n/);
    assert.match(created.stdout, /temporary tables: 3 statements/);
    assert.doesNotMatch(created.stdout, /staging:/);

    const storage = openDatabaseStorage(out);
    await storage.load();
    assert.deepEqual(storage.schema?.map((table) => table.name), ["files"]);
    const columns = Object.fromEntries((storage.schema?.[0]?.columns ?? []).map((column) => [column.name, column.default]));
    // A default of bytes is the Base64 text of the bytes, as every binary value of a fixture is; an array is an array.
    assert.deepEqual(columns, { id: undefined, body: "AQL/", empty: "", tags: [], scores: [1, 2] });
    assert.deepEqual(await storedRows(out, "files"), [
      { id: 1, body: "AQL/", empty: "", tags: [], scores: [1, 2] },
      { id: 2, body: "AQL/", empty: "", tags: ["a", "b c"], scores: [1, 2] },
    ]);
    // With --strict as well: nothing here is unsupported.
    assert.equal((await run("init", root, "--out", join(dir, "strict.db"), "--strict")).code, 0);
  });

  it("the database it creates is served by the PostgREST endpoint, and keeps what is written across a restart", async () => {
    const out = join(dir, "market.db");
    const result = await run("init", MARKET_CHAIN, "--out", out);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /scheduled jobs: 1 statement/);

    let sandbox = await startPostgrestSandbox({ database: out, port: 0 });
    let client = clientFor(sandbox.url);
    const state = await client.from("job_state").select("id, cursor_id, updated_at").eq("id", 1).single();
    assert.equal(state.error, null);
    assert.match(String(state.data?.updated_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?\+00:00$/);
    assert.equal((await client.from("assets").upsert([{ id: "a", label: "A", image_url: null }, { id: "b", label: "B", image_url: null }])).error, null);
    // updated_at is left out: the database computes it, as PostgreSQL's now() would.
    assert.equal((await client.from("asset_rates").upsert({ from_asset: "a", to_asset: "b", reference_rate: 2 })).error, null);
    await sandbox.stop();

    sandbox = await startPostgrestSandbox({ database: out, port: 0 });
    client = clientFor(sandbox.url);
    const rates = await client.from("asset_rates").select("from_asset, to_asset, reference_rate, updated_at, input_volume");
    assert.equal(rates.error, null);
    assert.deepEqual(rates.data?.map((rate) => [rate.from_asset, rate.to_asset, rate.reference_rate, rate.input_volume]), [["a", "b", 2, 0]]);
    assert.match(String(rates.data?.[0]?.updated_at), /\+00:00$/);
    // The foreign key with its CASCADE came from the migrations.
    assert.equal((await client.from("assets").delete().eq("id", "a")).error, null);
    assert.deepEqual((await client.from("asset_rates").select("from_asset")).data, []);
    await sandbox.stop();
  });

  it("bootstrapDatabase refuses rows the definitions refuse, and writes nothing", async () => {
    const out = join(dir, "bad.db");
    await assert.rejects(
      bootstrapDatabase({
        database: out,
        tables: [{ name: "t", columns: [{ name: "id", type: "integer", nullable: false, primary: true }], uniques: [] }],
        rows: { t: [{ id: 1 }, { id: 1 }] },
      }),
      /Cannot load row 2 of "t": UNIQUE constraint failed/,
    );
    assert.equal(existsSync(out), false);
  });
});
