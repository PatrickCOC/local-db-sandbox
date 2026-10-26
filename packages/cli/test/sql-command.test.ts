import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import { createDatabase } from "../../storage-json/src/index.ts";
import { databaseFiles } from "../../storage-json/test/support/database-files.ts";
import { runCli } from "../src/index.ts";

const DOCUMENT = {
  $meta: { version: 1 },
  $config: { server: { port: 4999 } },
  data: {
    users: [
      { id: 1, name: "Ada", active: true, score: 1.5, tags: ["a"], note: null },
      { id: 2, name: "Bo", active: false, score: 2, tags: [], note: "x" },
    ],
    orders: [{ id: 10, userId: 1, total: 30 }],
    empty: [],
  },
};

describe("sql command", () => {
  let dir: string;
  let file: string;

  const runOn = async (database: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> => {
    let stdout = "";
    let stderr = "";
    const stdin = new PassThrough();
    stdin.end(input ?? "");
    const code = await runCli(["sql", database, ...args], {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      signals: new EventEmitter(),
      stdin,
    });
    return { code, stdout: stdout.replace(/\d+\.\d ms/g, "T ms"), stderr: stderr.replace(/\d+\.\dms/g, "Tms") };
  };
  const run = (args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> => runOn(file, args, input);
  const text = (): Promise<string> => readFile(file, "utf8");
  const data = async (): Promise<Record<string, Record<string, unknown>[]>> => JSON.parse(await text()).data;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-sql-"));
    file = join(dir, "db.json");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await writeFile(file, JSON.stringify(DOCUMENT));
  });

  describe("one-shot SQL", () => {
    it("prints the columns and rows of a SELECT, the row count, and the time", async () => {
      const { code, stdout, stderr } = await run(["SELECT id, name, active, note FROM users ORDER BY id"]);
      assert.equal(code, 0);
      assert.equal(stderr, "");
      assert.equal(stdout, ["id  name  active  note", "--  ----  ------  ----", "1   Ada   1       NULL", "2   Bo    0       x", "(2 rows, T ms)", ""].join("\n"));
    });

    it("prints an empty result with its columns", async () => {
      assert.equal((await run(["SELECT id, total FROM orders WHERE total > 100"])).stdout, "id  total\n--  -----\n(0 rows, T ms)\n");
    });

    it("runs joins and aggregates in SQLite", async () => {
      const { stdout } = await run(["SELECT u.name, SUM(o.total) AS spent FROM users u JOIN orders o ON o.userId = u.id GROUP BY u.id"]);
      assert.equal(stdout, "name  spent\n----  -----\nAda   30\n(1 row, T ms)\n");
    });

    it("saves INSERT, UPDATE, and DELETE to the file and reports the rows affected", async () => {
      assert.equal((await run(["INSERT INTO users (name, active) VALUES ('Cy', 1), ('Di', 0)"])).stdout, "2 rows affected (T ms)\n");
      assert.deepEqual((await data()).users?.slice(2), [
        { id: 3, name: "Cy", active: true, score: null, tags: null, note: null },
        { id: 4, name: "Di", active: false, score: null, tags: null, note: null },
      ]);

      assert.equal((await run(["UPDATE users SET score = 9 WHERE id = 2"])).stdout, "1 row affected (T ms)\n");
      assert.equal((await data()).users?.[1]?.score, 9);

      assert.equal((await run(["DELETE FROM users WHERE id > 2"])).stdout, "2 rows affected (T ms)\n");
      assert.deepEqual((await data()).users?.map((row) => row.id), [1, 2]);
      // Values keep their JSON form, and everything outside "data" is preserved.
      assert.deepEqual((await data()).users?.[0], DOCUMENT.data.users[0]);
      assert.deepEqual(JSON.parse(await text()).$config, DOCUMENT.$config);
    });

    it("runs several statements in order and stops at the first error", async () => {
      const { code, stdout, stderr } = await run(["UPDATE orders SET total = 31; SELECT nope FROM orders; DELETE FROM orders"]);
      assert.equal(code, 1);
      assert.equal(stdout, "1 row affected (T ms)\n");
      assert.match(stderr, /^Error: SQLite cannot run this statement: no such column: nope/);
      // The statement before the error was committed; the one after it never ran.
      assert.deepEqual((await data()).orders, [{ id: 10, userId: 1, total: 31 }]);
    });

    it("does not change the file when a statement fails", async () => {
      const before = await text();
      for (const sql of ["INSERT INTO users (id, name) VALUES (1, 'Again')", "SELECT * FROM users WHERE name ILIKE 'a%'", "UPDATE missing SET x = 1"]) {
        const { code, stderr } = await run([sql]);
        assert.equal(code, 1);
        assert.match(stderr, /^Error: /);
      }
      assert.equal(await text(), before);
    });

    it("runs console commands as well", async () => {
      assert.match((await run([".tables"])).stdout, /^table {3}rows {2}columns from\n/);
    });
  });

  describe("--file", () => {
    it("runs the statements of a file, across lines and around comments", async () => {
      const script = join(dir, "script.sql");
      await writeFile(
        script,
        ["-- add an order; note the semicolon inside the string", "INSERT INTO orders", "  (id, userId, total)", "VALUES", "  (11, 2, 5);", "/* then read", "   them back; */", "SELECT id, total", "FROM orders", "WHERE total < 10"].join("\n"),
      );
      const { code, stdout, stderr } = await run(["--file", script]);
      assert.deepEqual([code, stderr], [0, ""]);
      assert.equal(stdout, "1 row affected (T ms)\nid  total\n--  -----\n11  5\n(1 row, T ms)\n");
      assert.deepEqual((await data()).orders?.at(-1), { id: 11, userId: 2, total: 5 });
    });

    it("fails clearly for a missing file and for SQL given twice", async () => {
      assert.match((await run(["--file", join(dir, "none.sql")])).stderr, /^Error: ENOENT/);
      assert.match((await run(["SELECT 1", "--file", "x.sql"])).stderr, /^Error: Give SQL as an argument or with --file, not both\./);
    });
  });

  describe("transactions", () => {
    it("saves nothing until COMMIT, then everything together", async () => {
      const before = await text();
      const stdin = new PassThrough();
      let stdout = "";
      const done = runCli(["sql", file], { stdout: { write: (chunk) => (stdout += chunk) }, stderr: { write: () => undefined }, signals: new EventEmitter(), stdin });
      const answered = async (lines: number): Promise<void> => {
        while (stdout.split("\n").length - 1 < lines) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };

      stdin.write("BEGIN;\nINSERT INTO users (name) VALUES ('Cy');\nUPDATE orders SET total = 99;\n");
      await answered(3);
      assert.equal(await text(), before);

      stdin.end("COMMIT;\n");
      assert.equal(await done, 0);
      assert.equal(stdout.replace(/\d+\.\d ms/g, "T ms"), "BEGIN (T ms)\n1 row affected (T ms)\n1 row affected (T ms)\nCOMMIT (T ms)\n");
      assert.deepEqual([(await data()).users?.length, (await data()).orders?.[0]?.total], [3, 99]);
    });

    it("leaves the file byte-identical after ROLLBACK", async () => {
      const before = await text();
      const { code, stdout } = await run([], "BEGIN;\nDELETE FROM users;\nINSERT INTO orders (userId, total) VALUES (2, 1);\nSELECT COUNT(*) AS n FROM users;\nROLLBACK;\nSELECT COUNT(*) AS n FROM users;\n");
      assert.equal(code, 0);
      assert.equal(stdout, "BEGIN (T ms)\n2 rows affected (T ms)\n1 row affected (T ms)\nn\n-\n0\n(1 row, T ms)\nROLLBACK (T ms)\nn\n-\n2\n(1 row, T ms)\n");
      assert.equal(await text(), before);
    });

    it("rolls back a transaction that is still open at the end", async () => {
      const before = await text();
      const interactive = await run([], "BEGIN;\nDELETE FROM users;\n");
      assert.match(interactive.stderr, /A transaction was still open and was rolled back\./);
      const oneShot = await run(["BEGIN; DELETE FROM users"]);
      assert.equal(oneShot.code, 1);
      assert.equal(await text(), before);
    });
  });

  describe("size limit", () => {
    it("refuses a change that would take the file above the limit, and keeps the file and the session consistent", async () => {
      const before = await text();
      const big = "x".repeat(4000);
      const { code, stdout, stderr } = await run(
        ["--max-file-size", "0.002"],
        [`INSERT INTO users (name) VALUES ('${big}');`, "SELECT COUNT(*) AS n FROM users;", "BEGIN;", `UPDATE users SET name = '${big}';`, "COMMIT;", "SELECT name FROM users WHERE id = 1;", "UPDATE users SET name = 'Adah' WHERE id = 1;"].join("\n"),
      );
      assert.equal(code, 0);
      assert.equal(stderr.match(/Error: .*too large|Error: .*limit/gi)?.length, 2, stderr);
      assert.match(stderr, /The transaction was rolled back\./);
      // After each refusal the runtime holds what the file holds.
      assert.equal(stdout, "n\n-\n2\n(1 row, T ms)\nBEGIN (T ms)\n2 rows affected (T ms)\nname\n----\nAda\n(1 row, T ms)\n1 row affected (T ms)\n");
      assert.deepEqual((await data()).users?.map((row) => row.name), ["Adah", "Bo"]);
      assert.notEqual(await text(), before);
    });

    it("refuses to open a file above the limit", async () => {
      await writeFile(file, JSON.stringify({ data: { users: [{ id: 1, name: "x".repeat(4000) }] } }));
      const { code, stderr } = await run(["--max-file-size", "0.002", "SELECT 1"]);
      assert.equal(code, 1);
      assert.match(stderr, /^Error: /);
    });
  });

  describe("interactive console", () => {
    it("reads a statement over several lines, up to its semicolon", async () => {
      const { stdout } = await run([], "SELECT name\n  FROM users -- not finished; still going\n WHERE id = 1\n;\n");
      assert.equal(stdout, "name\n----\nAda\n(1 row, T ms)\n");
    });

    it("keeps running after a statement fails", async () => {
      const { code, stdout, stderr } = await run([], "SELECT * FROM nowhere;\nSELEC 1;\nINSERT INTO users (id, name) VALUES (1, 'dup');\nSELECT COUNT(*) AS n FROM users;\n");
      assert.equal(code, 0);
      assert.equal(stderr.match(/^Error: /gm)?.length, 3);
      assert.match(stderr, /no such table: nowhere/);
      assert.match(stderr, /UNIQUE constraint failed: users\.id/);
      assert.equal(stdout, "n\n-\n2\n(1 row, T ms)\n");
    });

    it("lists tables with .tables", async () => {
      const { stdout } = await run([], ".tables\n");
      assert.equal(stdout, ["table   rows  columns from", "------  ----  ------------", "users   2     the data", "orders  1     the data", "empty   0     the data", ""].join("\n"));
    });

    it("shows a table's definition with .schema", async () => {
      const { stdout, stderr } = await run([], ".schema users\n.schema nothing\n");
      assert.equal(
        stdout,
        'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT, "active" BOOLEAN, "score" REAL, "tags" TEXT, "note" TEXT);\n' +
          "-- columns and types were worked out from the table's rows\n",
      );
      assert.match(stderr, /Error: There is no table "nothing"\. Use \.tables to list them\./);
      assert.equal((await run([], ".schema\n")).stdout.match(/CREATE TABLE/g)?.length, 3);
    });

    it("prints help, stops at .exit or .quit, and reports unknown commands", async () => {
      const help = await run([], ".help\n.exit\nSELECT 1;\n");
      assert.match(help.stdout, /^Enter SQL ending with a semicolon/);
      assert.match(help.stdout, /\.schema \[table\]/);
      assert.doesNotMatch(help.stdout, /\(1 row/);
      assert.equal((await run([], ".quit\nSELECT 1;\n")).stdout, "");
      assert.match((await run([], ".nope\n")).stderr, /Error: Unknown command \.nope\. Use \.help/);
    });

    it("does not execute a statement that was never finished", async () => {
      const before = await text();
      const { stderr } = await run([], "DELETE FROM users\n");
      assert.match(stderr, /was not finished with a semicolon and was not executed/);
      assert.equal(await text(), before);
    });

    it("says that schema changes are not saved", async () => {
      const { stdout } = await run([], "CREATE TABLE scratch (n);\nINSERT INTO scratch VALUES (1);\n");
      assert.match(stdout, /^OK \(T ms\)\nNote: Schema changes last until the console closes\./);
      assert.equal("scratch" in (await data()), false);
    });
  });

  describe("options", () => {
    it("--read-only answers queries and refuses every write", async () => {
      const before = await text();
      const { code, stdout, stderr } = await run(["--read-only"], "SELECT COUNT(*) AS n FROM users;\nDELETE FROM users;\nUPDATE users SET name = 'x';\nINSERT INTO users (name) VALUES ('y');\nDROP TABLE users;\nSELECT COUNT(*) AS n FROM users;\n");
      assert.equal(code, 0);
      assert.equal(stdout, "n\n-\n2\n(1 row, T ms)\nn\n-\n2\n(1 row, T ms)\n");
      assert.equal(stderr.match(/^Error: The runtime is read-only: the statement would change data or schema\.$/gm)?.length, 4);
      assert.equal(await text(), before);
      assert.equal((await run(["--read-only", "DELETE FROM users"])).code, 1);
    });

    it("--no-save lets statements change the session and discards the changes", async () => {
      const before = await text();
      const { stdout } = await run(["--no-save"], "DELETE FROM users WHERE id = 1;\nSELECT COUNT(*) AS n FROM users;\n");
      assert.equal(stdout, "1 row affected (T ms)\nn\n-\n1\n(1 row, T ms)\n");
      assert.equal(await text(), before);
    });

    it("--json prints one JSON object per statement", async () => {
      const { stdout, stderr, code } = await run(["--json", "SELECT id, active, tags FROM users ORDER BY id; UPDATE users SET score = 1; BEGIN; ROLLBACK; SELECT nope"]);
      const lines = stdout.trim().split("\n").map((line) => JSON.parse(line.replace(/"localExecutionMs":[\d.]+/, '"localExecutionMs":0')));
      assert.deepEqual(lines, [
        { operation: "SELECT", columns: ["id", "active", "tags"], localExecutionMs: 0, rowCount: 2, rows: [{ id: 1, active: 1, tags: '["a"]' }, { id: 2, active: 0, tags: "[]" }] },
        { operation: "UPDATE", affectedRows: 2, localExecutionMs: 0 },
        { operation: "TRANSACTION", transaction: "BEGIN", localExecutionMs: 0 },
        { operation: "TRANSACTION", transaction: "ROLLBACK", localExecutionMs: 0 },
        { error: { code: "SANDBOX_DIALECT_UNSUPPORTED", message: lines[4].error.message } },
      ]);
      assert.deepEqual([code, stderr], [1, ""]);
      assert.deepEqual(JSON.parse((await run(["--json", ".tables"])).stdout), {
        tables: [
          { name: "users", rows: 2, source: "data" },
          { name: "orders", rows: 1, source: "data" },
          { name: "empty", rows: 0, source: "data" },
        ],
      });
    });

    it("--sql-log writes the executed statements to stderr and leaves stdout as it is", async () => {
      const quiet = await run(["UPDATE orders SET total = 1"]);
      const summary = await run(["--sql-log", "summary", "UPDATE orders SET total = 2"]);
      const verbose = await run(["--sql-log=verbose", "UPDATE orders SET total = 3"]);
      assert.equal(quiet.stderr, "");
      assert.equal(summary.stderr, "Tms UPDATE orders rows=1\n");
      assert.equal(verbose.stderr, "UPDATE orders\nsql: UPDATE orders SET total = 3\nparams: []\naffected: 1\ntime: Tms\n");
      assert.deepEqual([summary.stdout, verbose.stdout], [quiet.stdout, quiet.stdout]);
      assert.match((await run(["--sql-log", "loud", "SELECT 1"])).stderr, /--sql-log must be "off", "summary", or "verbose"/);
    });

    it("--entities takes table definitions from TypeORM entities, so that empty collections are usable", async () => {
      const entities = join(import.meta.dirname, "../../import-typeorm/test/fixtures/blog");
      await writeFile(file, JSON.stringify({ data: { post_categories: [], users: [], post: [] } }));

      const tables = await run(["--entities", entities, ".tables"]);
      assert.equal(tables.stderr, "");
      assert.match(tables.stdout, /^post_categories {2}0 {5}entities$/m);
      assert.equal((await run(["--entities", entities, ".schema post_categories"])).stdout, 'CREATE TABLE "post_categories" ("code" TEXT PRIMARY KEY NOT NULL, "label" TEXT NOT NULL);\n');

      assert.equal((await run(["--entities", entities, "INSERT INTO post_categories (code, label) VALUES ('news', 'News')"])).stdout, "1 row affected (T ms)\n");
      assert.deepEqual((await data()).post_categories, [{ code: "news", label: "News" }]);
      // Without the entities the same collection has no known columns.
      assert.match((await run(["--no-entities", "INSERT INTO users (name) VALUES ('x')"])).stderr, /no column named name/);
      assert.match((await run(["--entities", entities, "--no-entities", "SELECT 1"])).stderr, /cannot be used together/);
    });

    it("prints usage, and fails clearly for a missing or broken database file", async () => {
      let stdout = "";
      let stderr = "";
      const io = { stdout: { write: (chunk: string) => (stdout += chunk) }, stderr: { write: (chunk: string) => (stderr += chunk) }, signals: new EventEmitter() };
      assert.equal(await runCli(["sql", "--help"], io), 0);
      assert.match(stdout, /^Usage: local-db-sandbox sql <database> \[options\]/);
      assert.match(stdout, /<database> is a JSON database: a single file \(sandbox\.db\.json\) or a\s+database directory \(sandbox\.db\)/);
      assert.equal(await runCli(["sql"], io), 1);
      assert.equal(await runCli(["sql", join(dir, "none.json"), "SELECT 1"], io), 1);
      assert.match(stderr, /Missing the database\.[\s\S]*Cannot read database file/);
    });
  });

  describe("a directory database", () => {
    let directory: string;
    /** The files the directory consists of now, under the names they have in a new database. */
    const files = (): Promise<Record<string, string>> => databaseFiles(directory);
    const table = async (name: string): Promise<Record<string, unknown>[]> => JSON.parse((await files())[`tables/${name}.json`] as string);

    beforeEach(async () => {
      directory = join(dir, "sandbox.db");
      await rm(directory, { recursive: true, force: true });
      await createDatabase(directory, { collections: structuredClone(DOCUMENT.data), config: DOCUMENT.$config });
    });

    it("answers queries from the directory as it does from a single file", async () => {
      const sql = "SELECT u.name, SUM(o.total) AS spent FROM users u JOIN orders o ON o.userId = u.id GROUP BY u.id";
      const fromDirectory = await runOn(directory, [sql]);
      assert.deepEqual([fromDirectory.code, fromDirectory.stderr], [0, ""]);
      assert.equal(fromDirectory.stdout, "name  spent\n----  -----\nAda   30\n(1 row, T ms)\n");
      assert.equal(fromDirectory.stdout, (await run([sql])).stdout);
      assert.equal((await runOn(directory, [".tables"])).stdout, (await run([".tables"])).stdout);
    });

    it("saves INSERT, UPDATE, and DELETE to the files of the tables", async () => {
      const untouched = await files();
      assert.equal((await runOn(directory, ["INSERT INTO users (name, active) VALUES ('Cy', 1)"])).stdout, "1 row affected (T ms)\n");
      assert.deepEqual((await table("users")).at(-1), { id: 3, name: "Cy", active: true, score: null, tags: null, note: null });

      assert.equal((await runOn(directory, ["UPDATE orders SET total = 31; DELETE FROM users WHERE id = 3"])).stdout, "1 row affected (T ms)\n1 row affected (T ms)\n");
      assert.deepEqual(await table("orders"), [{ id: 10, userId: 1, total: 31 }]);
      // Values keep their JSON form, and every other table and the definitions are as they were. The manifest names the new files.
      assert.deepEqual(await table("users"), DOCUMENT.data.users);
      assert.deepEqual({ ...(await files()), "tables/orders.json": "", "manifest.json": "" }, { ...untouched, "tables/orders.json": "", "manifest.json": "" });
    });

    it("saves the tables of a transaction together at COMMIT, and nothing after ROLLBACK", async () => {
      const before = await files();
      const stdin = new PassThrough();
      let stdout = "";
      const done = runCli(["sql", directory], { stdout: { write: (chunk) => (stdout += chunk) }, stderr: { write: () => undefined }, signals: new EventEmitter(), stdin });
      const answered = async (lines: number): Promise<void> => {
        while (stdout.split("\n").length - 1 < lines) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      stdin.write("BEGIN;\nINSERT INTO users (name) VALUES ('Cy');\nUPDATE orders SET total = 99;\n");
      await answered(3);
      assert.deepEqual(await files(), before);

      stdin.end("COMMIT;\n");
      assert.equal(await done, 0);
      assert.deepEqual([(await table("users")).length, (await table("orders"))[0]?.total], [3, 99]);

      const committed = await files();
      const rolledBack = await runOn(directory, [], "BEGIN;\nDELETE FROM users;\nINSERT INTO orders (userId, total) VALUES (2, 1);\nROLLBACK;\nSELECT COUNT(*) AS n FROM users;\n");
      assert.equal(rolledBack.stdout, "BEGIN (T ms)\n3 rows affected (T ms)\n1 row affected (T ms)\nROLLBACK (T ms)\nn\n-\n3\n(1 row, T ms)\n");
      assert.deepEqual(await files(), committed);
    });

    it("refuses a change that would take the directory above the limit, and leaves every file as it was", async () => {
      const before = await files();
      const big = "x".repeat(4000);
      const { code, stderr } = await runOn(directory, ["--max-file-size", "0.003", `INSERT INTO users (name) VALUES ('${big}')`]);
      assert.equal(code, 1);
      assert.match(stderr, /^Error: This change would make the database directory [\d.]+ MB, above the limit of [\d.]+ MB, and was not saved\./);
      assert.deepEqual(await files(), before);

      const tooBig = await runOn(directory, ["--max-file-size", "0.0005", "SELECT 1"]);
      assert.match(tooBig.stderr, /^Error: The database directory is [\d.]+ MB, above the limit of [\d.]+ MB, and was not loaded\./);
    });

    it("uses the table definitions stored in the directory, without the entities they came from", async () => {
      const entities = join(import.meta.dirname, "../../import-typeorm/test/fixtures/blog");
      await writeFile(file, JSON.stringify({ data: { post_categories: [], users: [], post: [] } }));
      await rm(directory, { recursive: true, force: true });
      const io = { stdout: { write: () => undefined }, stderr: { write: () => undefined }, signals: new EventEmitter() };
      assert.equal(await runCli(["convert", file, "--out", directory, "--entities", entities], io), 0);

      // From here on nothing names the entities.
      const tables = await runOn(directory, [".tables"]);
      assert.equal(tables.stderr, "");
      assert.match(tables.stdout, /^post_categories {2}0 {5}stored schema$/m);
      assert.equal((await runOn(directory, [".schema post_categories"])).stdout, 'CREATE TABLE "post_categories" ("code" TEXT PRIMARY KEY NOT NULL, "label" TEXT NOT NULL);\n');
      assert.equal((await runOn(directory, ["--no-entities", "INSERT INTO post_categories (code, label) VALUES ('news', 'News')"])).stdout, "1 row affected (T ms)\n");
      assert.deepEqual(await table("post_categories"), [{ code: "news", label: "News" }]);
    });

    it("says so when the entities it is given differ from the stored definitions", async () => {
      const entities = join(import.meta.dirname, "../../import-typeorm/test/fixtures/blog");
      await writeFile(file, JSON.stringify({ data: { post_categories: [], users: [], post: [] } }));
      await rm(directory, { recursive: true, force: true });
      const io = { stdout: { write: () => undefined }, stderr: { write: () => undefined }, signals: new EventEmitter() };
      assert.equal(await runCli(["convert", file, "--out", directory, "--entities", entities], io), 0);
      assert.equal((await runOn(directory, ["--entities", entities, ".tables"])).stderr, "");

      // The stored definitions fall behind the entities: here, a column is missing from them.
      const schemaFile = join(directory, "schema.json");
      const schema = JSON.parse(await readFile(schemaFile, "utf8"));
      schema.tables.find((entry: { name: string }) => entry.name === "post_categories").columns.pop();
      await writeFile(schemaFile, JSON.stringify(schema));
      assert.match((await runOn(directory, ["INSERT INTO post_categories (code, label) VALUES ('a', 'A')"])).stderr, /no column named label/);

      const refreshed = await runOn(directory, ["--entities", entities, "INSERT INTO post_categories (code, label) VALUES ('news', 'News')"]);
      assert.equal(refreshed.stdout, "1 row affected (T ms)\n");
      assert.match(refreshed.stderr, /^Note: the table definitions of the entities differ from the ones stored in .*sandbox\.db; the stored ones are replaced when a change is saved\.\n$/);
      // The save brought the stored definitions up to date.
      assert.deepEqual([(await runOn(directory, ["SELECT label FROM post_categories"])).stdout, (await runOn(directory, ["--entities", entities, "SELECT 1 AS n"])).stderr], ["label\n-----\nNews\n(1 row, T ms)\n", ""]);
    });

    it("does not read the project's entities when the directory stores its definitions, and falls back to them when it does not", async () => {
      // A project set up with init-nest, whose entities cannot be loaded.
      const project = join(dir, "project");
      const database = join(project, "sandbox.db");
      const users = { name: "users", columns: [{ name: "id", type: "integer" as const, nullable: false, primary: true, autoIncrement: true }] };
      await rm(project, { recursive: true, force: true });
      await mkdir(join(project, ".local-db-sandbox"), { recursive: true });
      await writeFile(
        join(project, ".local-db-sandbox", "sandbox.config.json"),
        JSON.stringify({ entry: join(import.meta.dirname, "../../import-typeorm/test/fixtures/broken/main.ts"), database: "../sandbox.db", port: 3001 }),
      );

      await createDatabase(database, { collections: { users: [] }, schema: [users] });
      const described = await runOn(database, [".tables"]);
      assert.deepEqual([described.code, described.stderr], [0, ""]);
      assert.match(described.stdout, /^users {2}0 {5}stored schema$/m);

      await createDatabase(database, { collections: { users: [] } }, { overwrite: true });
      const undescribed = await runOn(database, [".tables"]);
      assert.equal(undescribed.code, 1);
      assert.match(undescribed.stderr, /Failed to load .*broken\.entity\.cjs: boom/);
      assert.match((await runOn(database, ["--no-entities", ".tables"])).stdout, /^users {2}0 {5}the data$/m);
    });

    it("says that changes are not saved when the directory declares memory persistence", async () => {
      await createDatabase(directory, { collections: { users: [{ id: 1, name: "Ada" }] }, persistence: "memory" }, { overwrite: true });
      const before = await files();
      const { code, stdout, stderr } = await runOn(directory, ["DELETE FROM users"]);
      assert.deepEqual([code, stdout], [0, "1 row affected (T ms)\n"]);
      assert.match(stderr, /^Note: .*sandbox\.db declares "persistence": "memory"; changes are not saved\.\n$/);
      assert.deepEqual(await files(), before);
      // Nothing to say when saving was not asked for anyway.
      assert.equal((await runOn(directory, ["--read-only", "SELECT 1 AS n"])).stderr, "");
      assert.equal((await runOn(directory, ["--no-save", "DELETE FROM users"])).stderr, "");
    });

    it("fails clearly for a directory that is missing or is not a database", async () => {
      const missing = await runOn(join(dir, "missing.db"), ["SELECT 1"]);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /^Error: Database not found: .*missing\.db\n/);

      await mkdir(join(dir, "empty.db"), { recursive: true });
      assert.match((await runOn(join(dir, "empty.db"), ["SELECT 1"])).stderr, /^Error: .*empty\.db is not a database directory: it has no manifest\.json\./);
    });
  });
});
