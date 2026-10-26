import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { collectPostgresMigrations } from "../../import-postgres/src/index.ts";
import { planMigration, stringifyMigrationPlan } from "../../migration/src/index.ts";
import { diffSchemas } from "../../schema-diff/src/index.ts";
import { runCli } from "../src/index.ts";

/*
 * `plan-migration` is a diagnostic of the planner (D-038): it reads two
 * schemas as `diff-schema` reads them and prints the plan of their diff. It
 * carries nothing out and generates no SQL.
 */

const INIT = ["create table a (id int primary key, x int);", "create table b (id int primary key, y int);"].join("\n");
const EXCHANGE = ["alter table a rename to on_the_way;", "alter table b rename to a;", "alter table on_the_way rename to b;"].join("\n");

describe("CLI: plan-migration (how the differences between two schemas would be carried out)", () => {
  let dir: string;
  let first: string;
  let exchanged: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-plan-"));
    first = migrations("first", { "0001_init.sql": INIT });
    exchanged = migrations("exchanged", { "0001_init.sql": INIT, "0002_exchange.sql": EXCHANGE });
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

  function migrations(name: string, files: Record<string, string>): string {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    for (const [file, sql] of Object.entries(files)) {
      writeFileSync(join(root, file), sql);
    }
    return root;
  }

  function fingerprint(path: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
      const full = join(entry.parentPath, entry.name);
      const stats = statSync(full);
      found[full.slice(path.length + 1).replaceAll("\\", "/")] = entry.isDirectory() ? "directory" : `${stats.size} bytes, written ${stats.mtimeMs}`;
    }
    return found;
  }

  it("prints its help, and is listed in the general help", async () => {
    const { code, stdout } = await run("plan-migration", "--help");
    assert.equal(code, 0);
    assert.match(stdout, /^Usage: local-db-sandbox plan-migration <before> <after> \[options\]\n/);
    assert.match(stdout, /Nothing is carried out, and no SQL is generated/);
    assert.match(stdout, /rename-cycle/);
    assert.match(stdout, /tables-dropped-together/);
    const general = (await run("--help")).stdout;
    assert.match(general, /local-db-sandbox plan-migration <before> <after> \[options\]/);
    assert.match(general, /"plan-migration" says in which steps those differences would be carried out/);
  });

  it("tables that exchange their names: one of them goes by way of a temporary name, and the steps are numbered", async () => {
    const { code, stdout, stderr } = await run("plan-migration", first, exchanged);
    assert.deepEqual([code, stderr], [0, ""]);
    assert.equal(
      stdout,
      [
        `Before: ${first} (PostgreSQL migrations, 1 file)`,
        `After:  ${exchanged} (PostgreSQL migrations, 2 files)`,
        "3 steps:",
        "  1. ~ table a renamed to migration_tmp_1 [planner: rename-cycle]",
        "  2. ~ table b renamed to a (0002_exchange.sql:2)",
        "  3. ~ table migration_tmp_1 renamed to b (0002_exchange.sql:3)",
        "",
      ].join("\n"),
    );
  });

  it("tables that are dropped together and refer to each other: the foreign key between them is a step of its own", async () => {
    const referring = migrations("referring", {
      "0001_init.sql": "create table kept (id int primary key);\ncreate table m (id int primary key, n_id int);\ncreate table n (id int primary key, m_id int references m (id));\nalter table m add foreign key (n_id) references n (id);",
    });
    const dropped = migrations("dropped", { "0001_init.sql": "create table kept (id int primary key);" });
    const { code, stdout } = await run("plan-migration", referring, dropped);
    assert.equal(code, 0);
    assert.equal(stdout.split("\n").slice(2).join("\n"), ["3 steps:", "  1. - foreign key n (m_id) -> m (id) [n_m_id_fkey] [planner: tables-dropped-together]", "  2. - table m", "  3. - table n", ""].join("\n"));
  });

  it("with --json prints the plan alone: the same bytes every time, and the plan the library makes", async () => {
    const { code, stdout, stderr } = await run("plan-migration", first, exchanged, "--json");
    assert.deepEqual([code, stderr], [0, ""]);
    const [before, after] = [await collectPostgresMigrations(first), await collectPostgresMigrations(exchanged)];
    assert.equal(stdout, `${stringifyMigrationPlan(planMigration(before, diffSchemas(before, after)))}\n`);
    assert.deepEqual([JSON.parse(stdout).version, JSON.parse(stdout).steps.length], [1, 3]);
    assert.equal((await run("plan-migration", first, exchanged, "--json")).stdout, stdout);
    // No path is in it: the same two schemas give the same plan wherever they are.
    assert.equal(stdout.includes(dir), false);
  });

  it("says so when there is nothing to do", async () => {
    const { code, stdout } = await run("plan-migration", exchanged, exchanged);
    assert.equal(code, 0);
    assert.equal(stdout.split("\n").slice(2).join("\n"), "No steps: the two schemas do not differ.\n");
    assert.equal((await run("plan-migration", exchanged, exchanged, "--json")).stdout, '{\n  "version": 1,\n  "steps": []\n}\n');
  });

  it("changes neither side", async () => {
    const before = fingerprint(dir);
    assert.equal((await run("plan-migration", first, exchanged)).code, 0);
    assert.equal((await run("plan-migration", exchanged, first, "--json")).code, 0);
    assert.deepEqual(fingerprint(dir), before);
  });

  it("says what is wrong with its arguments, and with what it is given", async () => {
    const usage = '\nRun "local-db-sandbox plan-migration --help" for usage.\n';
    assert.deepEqual(await run("plan-migration"), { code: 1, stdout: "", stderr: `Error: Missing the two schemas to plan between: <before> and <after>.${usage}` });
    assert.deepEqual(await run("plan-migration", first), { code: 1, stdout: "", stderr: `Error: Missing the schema to plan toward: <after>.${usage}` });
    assert.deepEqual(await run("plan-migration", first, exchanged, first), { code: 1, stdout: "", stderr: `Error: Expected exactly two schemas: <before> and <after>.${usage}` });
    assert.match((await run("plan-migration", first, exchanged, "--sql")).stderr, /^Error: Unknown option '--sql'/);
    const missing = join(dir, "nowhere");
    assert.deepEqual(await run("plan-migration", first, missing), { code: 1, stdout: "", stderr: `Error: <after>: ${missing} does not exist.${usage}` });
  });

  it("refuses a schema that no database would take, and says which step cannot be taken", async () => {
    const dangling = join(dir, "dangling.schema.json");
    writeFileSync(
      dangling,
      JSON.stringify({
        schemaVersion: 1,
        tables: [
          { name: "a", columns: [{ column: "id", type: "integer", primaryKey: true }, { column: "x", type: "integer", references: { table: "ghost", column: "id", name: "a_x_fkey" } }] },
          { name: "b", columns: [{ column: "id", type: "integer", primaryKey: true }, { column: "y", type: "integer" }] },
        ],
      }),
    );
    const { code, stdout, stderr } = await run("plan-migration", first, dangling);
    assert.deepEqual([code, stdout], [1, ""]);
    assert.match(stderr, /^Error: The differences cannot be planned: addForeignKey "a_x_fkey" of table "a" cannot be carried out, at any point of the plan: there is no table "ghost" for it to refer to\.\n/);
  });
});
