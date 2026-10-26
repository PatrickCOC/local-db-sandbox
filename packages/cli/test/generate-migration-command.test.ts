import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { collectPostgresMigrations } from "../../import-postgres/src/index.ts";
import { planMigration } from "../../migration/src/index.ts";
import { generatePostgresMigration, stringifyPostgresGeneration } from "../../migration/src/postgres/index.ts";
import { diffSchemas } from "../../schema-diff/src/index.ts";
import { runCli } from "../src/index.ts";

/*
 * `generate-migration` (D-039) reads two schemas as `diff-schema` reads
 * them, and prints the migration from the one to the other as SQL for
 * PostgreSQL. It carries nothing out: no database is connected to, and
 * neither side is changed. What it cannot write without knowing more, it
 * refuses, and says for which steps.
 */

const INIT = ["create type mood as enum ('sad', 'ok');", "create table notes (id integer primary key, body text, m mood default 'ok');", "create table gone (id integer);"].join("\n");
const CHANGE = ["drop table gone;", "alter table notes add column author text;", "create index notes_author_idx on notes (author);"].join("\n");

describe("CLI: generate-migration (the differences between two schemas as SQL for PostgreSQL)", () => {
  let dir: string;
  let first: string;
  let changed: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-generate-"));
    first = migrations("first", { "0001_init.sql": INIT });
    changed = migrations("changed", { "0001_init.sql": INIT, "0002_change.sql": CHANGE });
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

  const SCRIPT = [
    "-- PostgreSQL migration: 3 statements in one transaction.",
    "",
    "BEGIN;",
    "",
    "-- Step 1. The rows it holds are lost.",
    'DROP TABLE "gone";',
    'ALTER TABLE "notes" ADD COLUMN "author" text;',
    'CREATE INDEX "notes_author_idx" ON "notes" ("author");',
    "",
    "COMMIT;",
    "",
  ].join("\n");

  it("prints its help, and is listed in the general help", async () => {
    const { code, stdout } = await run("generate-migration", "--help");
    assert.equal(code, 0);
    assert.match(stdout, /^Usage: local-db-sandbox generate-migration <before> <after> --dialect postgres \[options\]\n/);
    assert.match(stdout, /Nothing is carried out/);
    for (const word of ["safe", "requiresDataMigration", "requiresExplicitCast", "unsupported", "--assume-valid-data", "--json", "--out <file>"]) {
      assert.ok(stdout.includes(word), word);
    }
    const general = (await run("--help")).stdout;
    assert.match(general, /local-db-sandbox generate-migration <before> <after> --dialect postgres \[options\]/);
    assert.match(general, /"generate-migration" writes those steps as SQL for PostgreSQL, without carrying them out/);
  });

  it("prints the migration as an SQL script, and nothing else", async () => {
    const { code, stdout, stderr } = await run("generate-migration", first, changed, "--dialect", "postgres");
    assert.deepEqual([code, stderr], [0, ""]);
    assert.equal(stdout, SCRIPT);
    // PostgreSQL's other name, and the option's other place.
    assert.equal((await run("generate-migration", "--dialect=postgresql", first, changed)).stdout, SCRIPT);
  });

  it("with --json prints what the generator gave: the same bytes every time, with every step and every statement", async () => {
    const { code, stdout, stderr } = await run("generate-migration", first, changed, "--dialect", "postgres", "--json");
    assert.deepEqual([code, stderr], [0, ""]);
    const [before, after] = [await collectPostgresMigrations(first), await collectPostgresMigrations(changed)];
    assert.equal(stdout, `${stringifyPostgresGeneration(generatePostgresMigration(before, planMigration(before, diffSchemas(before, after))))}\n`);
    const parsed = JSON.parse(stdout);
    assert.deepEqual([parsed.status, parsed.steps.length, parsed.migration.version, parsed.migration.segments.length], ["generated", 3, 1, 1]);
    assert.deepEqual(
      parsed.migration.segments[0].statements.map((statement: { step: number; kind: string; sql: string }) => [statement.step, statement.kind, statement.sql]),
      [
        [1, "dropTable", 'DROP TABLE "gone"'],
        [2, "addColumn", 'ALTER TABLE "notes" ADD COLUMN "author" text'],
        [3, "createIndex", 'CREATE INDEX "notes_author_idx" ON "notes" ("author")'],
      ],
    );
    assert.equal((await run("generate-migration", first, changed, "--dialect", "postgres", "--json")).stdout, stdout);
    // No path is in it: the same two schemas give the same migration wherever they are.
    assert.equal(stdout.includes(dir), false);
  });

  it("with --out writes the migration to a file, and never replaces one", async () => {
    const out = join(dir, "0003_generated.sql");
    const written = await run("generate-migration", first, changed, "--dialect", "postgres", "--out", out);
    assert.deepEqual(written, { code: 0, stdout: `Wrote ${out}: 3 statements in one transaction.\n`, stderr: "" });
    assert.equal(readFileSync(out, "utf8"), SCRIPT);
    const again = await run("generate-migration", changed, first, "--dialect", "postgres", "--out", out);
    assert.deepEqual([again.code, again.stdout], [1, ""]);
    assert.match(again.stderr, /^Error: .*0003_generated\.sql exists already\. A generated migration never replaces a file: give another name, or remove it\.\n/);
    assert.equal(readFileSync(out, "utf8"), SCRIPT);
    // As JSON too.
    const json = join(dir, "migration.json");
    assert.equal((await run("generate-migration", first, changed, "--dialect", "postgres", "--json", "--out", json)).stdout, `Wrote ${json}: 3 statements in one transaction.\n`);
    assert.equal(JSON.parse(readFileSync(json, "utf8")).status, "generated");
  });

  it("says so when there is nothing to do", async () => {
    const { code, stdout, stderr } = await run("generate-migration", changed, changed, "--dialect", "postgres");
    assert.deepEqual([code, stdout, stderr], [0, "-- PostgreSQL migration: no statements.\n", ""]);
  });

  it("a migration that no transaction holds together has its segments written out", async () => {
    const more = migrations("more", { "0001_init.sql": INIT, "0002_change.sql": "alter type mood add value 'happy';\nalter table notes alter column m set default 'happy';" });
    const { code, stdout } = await run("generate-migration", first, more, "--dialect", "postgres");
    assert.equal(code, 0);
    assert.match(stdout, /^-- PostgreSQL migration: 2 statements in 2 segments\.\n-- It is not one transaction/);
    assert.match(stdout, /\n-- Segment 1 of 2: outside a transaction, each statement on its own\.\n-- A value added to an enumerated type cannot be used before it is committed\.\nALTER TYPE "mood" ADD VALUE 'happy' AFTER 'ok';\n\n-- Segment 2 of 2: one transaction\.\nBEGIN;\n\nALTER TABLE "notes" ALTER COLUMN "m" SET DEFAULT 'happy';\n\nCOMMIT;\n$/);
    const written = await run("generate-migration", first, more, "--dialect", "postgres", "--out", join(dir, "segments.sql"));
    assert.equal(written.stdout, `Wrote ${join(dir, "segments.sql")}: 2 statements in 2 segments.\n`);
  });

  it("refuses what it cannot write without knowing more: every such step, with its class and reason, and no migration", async () => {
    const strict = migrations("strict", { "0001_init.sql": INIT, "0002_change.sql": "alter table notes alter column body set not null, alter column body type integer using length(body);\nalter table notes add column author text;" });
    const { code, stdout, stderr } = await run("generate-migration", first, strict, "--dialect", "postgres");
    assert.deepEqual([code, stdout], [1, ""]);
    assert.equal(
      stderr,
      [
        "Error: No migration was generated: 2 of 3 steps cannot be written as SQL without knowing more.",
        '  step 2, alterColumnType "notes"."body": requiresExplicitCast (no-safe-conversion)',
        "    PostgreSQL has no conversion from text to integer that it makes on its own and that is known to keep every value. How the values of text become values of integer has to be said (USING), and is not made up.",
        '  step 3, setNotNull "notes"."body": requiresDataMigration (rows-may-hold-null)',
        '    No row of "notes" may hold NULL in "body".',
        'Run "local-db-sandbox generate-migration --help" for what the classes mean.',
        "",
      ].join("\n"),
    );
    const out = join(dir, "refused.sql");
    assert.equal((await run("generate-migration", first, strict, "--dialect", "postgres", "--out", out)).code, 1);
    assert.equal(existsSync(out), false);
  });

  it("with --json a refusal is printed as data, and the command still fails", async () => {
    const strict = migrations("strict", { "0001_init.sql": INIT, "0002_change.sql": "alter table notes alter column body set not null;" });
    const { code, stdout, stderr } = await run("generate-migration", first, strict, "--dialect", "postgres", "--json");
    assert.deepEqual([code, stderr], [1, ""]);
    assert.deepEqual(JSON.parse(stdout), {
      status: "refused",
      refusals: [{ step: 1, operation: 'setNotNull "notes"."body"', safety: "requiresDataMigration", reason: "rows-may-hold-null", detail: 'No row of "notes" may hold NULL in "body".' }],
      steps: [{ step: 1, operation: 'setNotNull "notes"."body"', safety: "requiresDataMigration", reason: "rows-may-hold-null", detail: 'No row of "notes" may hold NULL in "body".' }],
    });
  });

  it("with --assume-valid-data writes what rests on the rows, and marks it; without it, says that this is the way", async () => {
    const strict = migrations("strict", { "0001_init.sql": INIT, "0002_change.sql": "alter table notes alter column body set not null;" });
    const refused = await run("generate-migration", first, strict, "--dialect", "postgres");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /\nWhat is refused rests on what the rows are: with --assume-valid-data it is written, on your word that the rows fit\.\n/);
    const { code, stdout, stderr } = await run("generate-migration", first, strict, "--dialect", "postgres", "--assume-valid-data");
    assert.deepEqual([code, stderr], [0, ""]);
    assert.match(stdout, /\n-- Step 1\. Assumes what the rows are: No row of "notes" may hold NULL in "body"\.\nALTER TABLE "notes" ALTER COLUMN "body" SET NOT NULL;\n/);
  });

  it("gives what it generates to PostgreSQL's parser first: an expression of a schema that is more than an expression is not printed", async () => {
    const column = (name: string): object => ({ column: name, type: "integer", canonicalType: { kind: "integer", bits: 32 } });
    const plain = join(dir, "plain.schema.json");
    const crafted = join(dir, "crafted.schema.json");
    writeFileSync(plain, JSON.stringify({ schemaVersion: 1, tables: [{ name: "t", columns: [column("a")] }] }));
    writeFileSync(crafted, JSON.stringify({ schemaVersion: 1, tables: [{ name: "t", columns: [column("a")], checks: [{ name: "c", expression: 'true), ADD COLUMN "x" integer, ADD CHECK (true' }] }] }));
    const { code, stdout, stderr } = await run("generate-migration", plain, crafted, "--dialect", "postgres");
    assert.deepEqual([code, stdout], [1, ""]);
    assert.match(stderr, /^Error: The migration was not printed: PostgreSQL's own parser does not take statement 1 of it as it was meant\.\n  ALTER TABLE "t" ADD CONSTRAINT "c" CHECK \(true\), ADD COLUMN "x" integer, ADD CHECK \(true\)\n  The expression "true\), ADD COLUMN \\"x\\" integer, ADD CHECK \(true" is not one expression to PostgreSQL/);
    // The same schema with an expression that is one is written.
    writeFileSync(crafted, JSON.stringify({ schemaVersion: 1, tables: [{ name: "t", columns: [column("a")], checks: [{ name: "c", expression: "(a > 0) or (a is null)" }] }] }));
    assert.match((await run("generate-migration", plain, crafted, "--dialect", "postgres")).stdout, /\nALTER TABLE "t" ADD CONSTRAINT "c" CHECK \(\(a > 0\) or \(a is null\)\);\n/);
  });

  it("changes neither side", async () => {
    const before = fingerprint(dir);
    assert.equal((await run("generate-migration", first, changed, "--dialect", "postgres")).code, 0);
    assert.equal((await run("generate-migration", changed, first, "--dialect", "postgres", "--json")).code, 0);
    assert.deepEqual(fingerprint(dir), before);
  });

  it("says what is wrong with its arguments, and with what it is given", async () => {
    const usage = '\nRun "local-db-sandbox generate-migration --help" for usage.\n';
    assert.deepEqual(await run("generate-migration"), { code: 1, stdout: "", stderr: `Error: Missing the two schemas to generate a migration between: <before> and <after>.${usage}` });
    assert.deepEqual(await run("generate-migration", first, "--dialect", "postgres"), { code: 1, stdout: "", stderr: `Error: Missing the schema to arrive at: <after>.${usage}` });
    assert.deepEqual(await run("generate-migration", first, changed, first, "--dialect", "postgres"), { code: 1, stdout: "", stderr: `Error: Expected exactly two schemas: <before> and <after>.${usage}` });
    assert.deepEqual(await run("generate-migration", first, changed), { code: 1, stdout: "", stderr: `Error: Missing --dialect: the database to write the migration for. There is one: postgres.${usage}` });
    assert.deepEqual(await run("generate-migration", first, changed, "--dialect", "mysql"), { code: 1, stdout: "", stderr: `Error: There is no generator for "mysql". There is one: postgres.${usage}` });
    assert.match((await run("generate-migration", first, changed, "--dialect", "postgres", "--apply")).stderr, /^Error: Unknown option '--apply'/);
    const missing = join(dir, "nowhere");
    assert.deepEqual(await run("generate-migration", first, missing, "--dialect", "postgres"), { code: 1, stdout: "", stderr: `Error: <after>: ${missing} does not exist.${usage}` });
  });

  it("says when the differences cannot be planned at all", async () => {
    const dangling = join(dir, "dangling.schema.json");
    writeFileSync(
      dangling,
      JSON.stringify({ schemaVersion: 1, tables: [{ name: "a", columns: [{ column: "id", type: "integer", primaryKey: true }, { column: "x", type: "integer", references: { table: "ghost", column: "id", name: "a_x_fkey" } }] }] }),
    );
    const empty = join(dir, "empty.schema.json");
    writeFileSync(empty, JSON.stringify({ schemaVersion: 1, tables: [] }));
    const { code, stdout, stderr } = await run("generate-migration", empty, dangling, "--dialect", "postgres");
    assert.deepEqual([code, stdout], [1, ""]);
    assert.match(stderr, /^Error: The differences cannot be planned: addForeignKey "a_x_fkey" of table "a" cannot be carried out, at any point of the plan: there is no table "ghost" for it to refer to\.\n/);
  });
});
