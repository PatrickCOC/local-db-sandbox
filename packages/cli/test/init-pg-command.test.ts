import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { closedPort, startDisposablePostgres, startProxy, startRefusingServer } from "../../import-postgres/test/support/disposable-postgres.ts";
import type { DisposablePostgres } from "../../import-postgres/test/support/disposable-postgres.ts";
import type { DatabaseSchema } from "../../runtime/src/index.ts";
import { ownerRecordPath, readSchemaDocument } from "../../storage-json/src/index.ts";
import { schemaFile } from "../../storage-json/test/support/database-files.ts";
import { runCli } from "../src/index.ts";
import { runInitPg } from "../src/init-pg-command.ts";

/*
 * `init-pg`: a sandbox database from the schema of a running PostgreSQL
 * database (D-049), and Local DB Studio on it. The servers are PGlite
 * (PostgreSQL 18) on a port of 127.0.0.1, with the synthetic schemas of
 * packages/import-postgres/test/fixtures/catalog, and small servers of the
 * tests' own that refuse a login or stop answering.
 */

const FIXTURES = join(import.meta.dirname, "../../import-postgres/test/fixtures/catalog");
const SHOP = readFileSync(join(FIXTURES, "shop.sql"), "utf8");
const EDGES = readFileSync(join(FIXTURES, "edges.sql"), "utf8");
const PASSWORD = "Init-pg_s3cret";
const ROWS = "insert into customers (email, name) values ('ada@example.com', 'Ada');";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** The schema a database directory stores. */
const schemaOf = (database: string): DatabaseSchema => readSchemaDocument(JSON.parse(readFileSync(schemaFile(database), "utf8")), "schema.json");

/** Every file under a directory, with its bytes. */
function filesOf(directory: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const name of readdirSync(directory, { recursive: true }).map(String)) {
    const path = join(directory, name);
    if (statSync(path).isFile()) {
      files.set(name, readFileSync(path));
    }
  }
  return files;
}

describe("CLI: init-pg", { timeout: 180_000 }, () => {
  let dir: string;
  let shop: DisposablePostgres;
  let edges: DisposablePostgres;
  const stops: (() => Promise<unknown>)[] = [];

  before(async () => {
    shop = await startDisposablePostgres(SHOP + ROWS);
    edges = await startDisposablePostgres(EDGES);
  });
  after(async () => {
    await shop.stop();
    await edges.stop();
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-init-pg-"));
  });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) {
      await stop();
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const io = (output: { stdout: string; stderr: string }) => ({
    stdout: { write: (text: string) => (output.stdout += text) },
    stderr: { write: (text: string) => (output.stderr += text) },
    signals: new EventEmitter(),
  });

  async function run(...argv: string[]): Promise<Run> {
    const output = { stdout: "", stderr: "" };
    const code = await runCli(argv, io(output));
    return { code, ...output };
  }

  const urlOf = (port: number, password?: string): string => `postgresql://postgres${password === undefined ? "" : `:${password}`}@127.0.0.1:${port}/postgres?sslmode=disable`;

  /** Asserts that a command failed with `message`, wrote nothing at `database`, and printed no password. */
  function failed(result: Run, message: RegExp, database?: string): void {
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
    assert.match(result.stderr, /\nRun "local-db-sandbox init-pg --help" for usage\.\n$/);
    assert.equal(result.stderr.includes(PASSWORD), false);
    if (database !== undefined) {
      assert.equal(existsSync(database), false);
    }
  }

  describe("usage", () => {
    it("prints its help, which says that the catalog is read and nothing written, and how to give the password", async () => {
      const { code, stdout, stderr } = await run("init-pg", "--help");
      assert.deepEqual([code, stderr], [0, ""]);
      assert.match(stdout, /^Usage: local-db-sandbox init-pg <connection-url> \[options\]\n/);
      assert.match(stdout, /Give the password in the PGPASSWORD environment variable/);
      assert.match(stdout, /no row of any\s+table is read, and nothing is written to PostgreSQL/);
      assert.match(stdout, /use a read-only role/);
      assert.match(stdout, /-s, --schema <name>\s+Schema to read; repeat for more \(default: public\)/);
      assert.match(stdout, /--connect-timeout <seconds>\s+How long connecting may take \(default: 10\)/);
      assert.match(stdout, /--query-timeout <seconds>\s+How long each catalog query may take \(default: 30\)/);
      const main = (await run("--help")).stdout;
      assert.match(main, /local-db-sandbox init-pg <connection-url> \[options\]/);
      assert.match(main, /"init-pg" creates a database from the schema of a running PostgreSQL database, reading its catalog only; see "local-db-sandbox init-pg --help"\./);
    });

    it("refuses what it cannot make sense of, before it connects, without repeating the connection string", async () => {
      const database = join(dir, "sandbox.db");
      const url = urlOf(shop.port, PASSWORD);
      failed(await run("init-pg", "--out", database), /^Error: Missing the connection URL \(postgresql:\/\/<user>@<host>:<port>\/<database>\)\.\n/, database);
      failed(await run("init-pg", url, url, "--out", database), /^Error: Expected exactly one connection URL\.\n/, database);
      failed(await run("init-pg", `mysql://root:${PASSWORD}@127.0.0.1/app`, "--out", database), /^Error: The connection string is not a postgresql:\/\/ URL\. It must look like postgresql:\/\/reader@127\.0\.0\.1:5432\/app\.\n/, database);
      failed(await run("init-pg", url, "--connect-timeout", "0", "--out", database), /^Error: --connect-timeout must be a number of seconds, more than 0 and at most 3600\.\n/, database);
      failed(await run("init-pg", url, "--query-timeout", "soon", "--out", database), /^Error: --query-timeout must be a number of seconds, more than 0 and at most 3600\.\n/, database);
      failed(await run("init-pg", url, "--max-file-size", "999", "--out", database), /^Error: --max-file-size/, database);
      failed(await run("init-pg", urlOf(shop.port), "--schema", "pg_catalog", "--out", database), /^Error: "pg_catalog" is a system schema of PostgreSQL; the scan reads the schemas of an application\. Nothing was written\.\n/, database);
    });
  });

  it("creates the database from the schema, without rows or secrets, and Studio shows and changes it", async () => {
    const database = join(dir, "sandbox.db");
    const result = await run("init-pg", urlOf(shop.port, PASSWORD), "--out", database);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stderr,
      "Note: the password is in the URL. It is not written anywhere by this command, but your shell may keep it in its history; PGPASSWORD keeps it out.\n",
    );
    const reportPath = `${database}.report.json`;
    const lines = result.stdout.split("\n");
    // The end: .gitignore is left alone, since the database is not in the Git repository this runs in; then the next steps,
    // with the database as a command line takes it (outside the current directory: whole, with `/` between its parts).
    const shown = database.split("\\").join("/");
    assert.match(lines.at(-5) ?? "", /^\.gitignore was not changed: the database is not in the project's Git repository \(.*\)\.$/);
    assert.deepEqual(lines.slice(-4), [
      "Next steps:",
      `  local-db-sandbox studio ${shown}      look into the tables, and add rows`,
      `  local-db-sandbox postgrest ${shown}   serve the database to supabase-js clients`,
      "",
    ]);
    assert.deepEqual(
      lines.slice(0, -5),
      [
        `Read schema "public" of PostgreSQL ${result.stdout.match(/of PostgreSQL (\S+) at/)?.[1]} at 127.0.0.1:${shop.port} (database "postgres", user "postgres"): 7 tables, 1 enumerated type`,
        `Created ${database}`,
        "  customers: 8 columns, 1 unique constraint, 0 rows",
        "  order_lines: 4 columns, 1 unique constraint, 0 rows",
        "  orders: 5 columns, 2 indexes, 0 rows",
        "  products: 6 columns, 1 index, 0 rows",
        "  stock_levels: 4 columns, 0 rows",
        "  tags: 2 columns, 0 rows",
        "  warehouses: 3 columns, 1 unique constraint, 0 rows",
        "  enumerated types: order_state",
        "No rows were read from PostgreSQL: the tables are empty.",
        "Kept as information, not enforced:",
        '  customers.external_id: The default of "customers"."external_id" (gen_random_uuid()) is kept as information: the sandbox does not generate UUIDs, so a row written without one gets none.',
        '  products.products_stock_check: Check constraint "products_stock_check" (stock >= 0) is kept as information and not enforced locally.',
        `  orders_open_idx: Index "orders_open_idx" on "orders" where state <> 'shipped'::order_state is kept as information and not created locally.`,
        '  products_title_lower_idx: Unique index "products_title_lower_idx" on "products" over expressions (lower(title)) is kept as information and not created locally; its uniqueness is not enforced.',
        `Report: ${reportPath}`,
      ],
    );

    // The database: the scanned schema, the canonical one, stored as init stores it; no rows; no owner left.
    const document = schemaOf(database);
    assert.deepEqual(document.tables.map((table) => table.name), ["customers", "order_lines", "orders", "products", "stock_levels", "tags", "warehouses"]);
    assert.deepEqual(document.tables.find((table) => table.name === "stock_levels")?.foreignKeys?.map((key) => [key.columns, key.references]), [[["region", "code"], { table: "warehouses", columns: ["region", "code"] }]]);
    assert.equal(document.tables[0]?.columns[0]?.origin?.source, "postgresql-catalog");
    assert.equal(existsSync(ownerRecordPath(database)), false);

    // Nothing written holds the password or the connection string; the report says where the schema came from, and no more.
    for (const [name, bytes] of filesOf(dir)) {
      const text = bytes.toString("utf8");
      assert.equal(text.includes(PASSWORD), false, name);
      assert.equal(text.includes("postgresql://"), false, name);
      assert.equal(text.includes("ada@example.com"), false, name);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(report.source, { kind: "postgresql-database", server: { host: "127.0.0.1", port: shop.port, database: "postgres", user: "postgres", version: report.source.server.version }, schemas: ["public"] });
    assert.deepEqual([report.summary.tables, report.summary.rows.customers, report.notes], [7, 0, []]);
    assert.match(report.script, /^CREATE TYPE "order_state"/);

    // Local DB Studio on it: the tables, rows added, keys and foreign keys enforced.
    const studio = await startStudio(database);
    const { instance } = (await studio.status()).info;
    const schema = (await studio.ask("schema")).body.result;
    assert.deepEqual(
      schema.tables.map((table: { name: string; rows: number; primaryKey: string[] }) => [table.name, table.rows, table.primaryKey]),
      [
        ["customers", 0, ["id"]],
        ["order_lines", 0, ["order_id", "line"]],
        ["orders", 0, ["id"]],
        ["products", 0, ["sku"]],
        ["stock_levels", 0, ["region", "code", "sku"]],
        ["tags", 0, ["id"]],
        ["warehouses", 0, ["region", "code"]],
      ],
    );
    assert.deepEqual((await studio.ask("insert", { table: "customers", values: { email: "grace@example.com", name: "Grace" } }, instance)).body, { result: { affectedRows: 1, lastInsertId: 1 } });
    assert.deepEqual((await studio.ask("insert", { table: "orders", values: { customer_id: 1, total: 12.5 } }, instance)).body, { result: { affectedRows: 1, lastInsertId: 1 } });
    const refused = await studio.ask("insert", { table: "orders", values: { customer_id: 99, total: 1 } }, instance);
    assert.equal(refused.status >= 400, true);
    assert.match(JSON.stringify(refused.body), /FOREIGN KEY/i);
    const rows = (await studio.ask("sql", { sql: "SELECT c.id, c.email, c.vip, o.state FROM customers c JOIN orders o ON o.customer_id = c.id", mode: "read" })).body.result;
    // The defaults read from PostgreSQL were applied: vip false (SQLite stores it as 0, which the SQL tab shows), state 'new'.
    assert.deepEqual(rows.results[0].rows, [[1, "grace@example.com", 0, "new"]]);
    const browsed = (await studio.ask("browse", { table: "customers" })).body.result;
    assert.deepEqual(browsed.rows.map((row: unknown[]) => [row[0], row[1], row[3]]), [[1, "grace@example.com", false]]);
  });

  it("reads the schemas it is given, and says what it left out and what is unsupported", async () => {
    const database = join(dir, "archive.db");
    const archive = await run("init-pg", urlOf(edges.port), "--schema", "archive", "-s", "lookup", "--out", database);
    assert.equal(archive.code, 0, archive.stderr);
    assert.equal(archive.stderr, "");
    assert.match(archive.stdout, /^Read schemas "archive", "lookup" of PostgreSQL \S+ at 127\.0\.0\.1:\d+ \(database "postgres", user "postgres"\): 2 tables, 1 enumerated type\n/);
    assert.match(archive.stdout, /\nNot reproduced locally:\n {2}archive\.orders\.orders_account_id_fkey: The foreign key "orders_account_id_fkey" of archive\.orders refers to public\.accounts, which is not read/);

    const publicDatabase = join(dir, "public.db");
    const all = await run("init-pg", urlOf(edges.port), "--out", publicDatabase);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /\nNot reproduced locally:\n {2}public\.account_handles: The view public\.account_handles is not created locally\.\n {2}public\.bookings_2026: /);
    assert.match(all.stdout, /\n {2}public\.extension_settings: The table public\.extension_settings belongs to the extension "plpgsql" and is left out\.\n/);
    assert.match(all.stdout, /\nUnsupported \(the local schema may differ from PostgreSQL's here\):\n {2}oddities\.oddities_no_overlap: EXCLUDE constraint "oddities_no_overlap" is not reproduced locally\.\n/);
    assert.equal(JSON.parse(readFileSync(`${publicDatabase}.report.json`, "utf8")).notes.length, 7);
  });

  it("writes nothing when the schema is unsupported in part (--strict), empty, or not one namespace", async () => {
    const database = join(dir, "sandbox.db");
    failed(await run("init-pg", urlOf(edges.port), "--strict", "--out", database), /^ {2}oddities\.oddities_no_overlap: EXCLUDE constraint "oddities_no_overlap" is not reproduced locally\.\nError: 1 part of the schema is unsupported \(--strict\)\. Nothing was written\.\n/, database);
    failed(await run("init-pg", urlOf(edges.port), "--schema", "empty_one", "--out", database), /^Error: The schema "empty_one" has no tables to create\. Nothing was written\.\n/, database);
    failed(await run("init-pg", urlOf(edges.port), "--schema", "public", "--schema", "archive", "--out", database), /^Error: The schemas that are read have objects of the same name, and the sandbox has one namespace, so one would replace the other:\n {2}"orders": table archive\.orders, table public\.orders\n/, database);
    failed(await run("init-pg", urlOf(edges.port), "--schema", "nowhere", "--out", database), /^Error: The database has no schema "nowhere"\. Nothing was written\.\n/, database);
    assert.deepEqual(readdirSync(dir), []);
  });

  it("says why it could not connect or read, and writes nothing: refused, login refused, no answer", async () => {
    const database = join(dir, "sandbox.db");
    const port = await closedPort();
    failed(await run("init-pg", urlOf(port, PASSWORD), "--out", database), new RegExp(`^Note: the password is in the URL\\..*\\nError: Could not connect to PostgreSQL at 127\\.0\\.0\\.1:${port} \\(database "postgres", user "postgres"\\): the connection was refused \\(is PostgreSQL running there, on that port\\?\\)\\. Nothing was written\\.\\n`), database);

    // The password from PGPASSWORD goes to the server, and nowhere else.
    const refusing = await startRefusingServer({ code: "28P01", message: 'password authentication failed for user "postgres"' }, { askPassword: true });
    stops.push(refusing.stop);
    const output = { stdout: "", stderr: "" };
    const code = await runInitPg([urlOf(refusing.port), "--out", database], io(output), { PGPASSWORD: PASSWORD });
    failed({ code, ...output }, /^Error: PostgreSQL at 127\.0\.0\.1:\d+ \(database "postgres", user "postgres"\) refused the login: password authentication failed for user "postgres"\. Nothing was written\.\n/, database);
    assert.deepEqual(refusing.passwords, [PASSWORD]);

    // A server that stops answering in the middle of the scan.
    const stalling = await startProxy(shop.port, { answered: 4 });
    stops.push(stalling.stop);
    const started = Date.now();
    failed(await run("init-pg", urlOf(stalling.port), "--query-timeout", "0.5", "--out", database), /^Error: A query to PostgreSQL at 127\.0\.0\.1:\d+ \(database "postgres", user "postgres"\) did not finish within 0\.5 s; the connection was closed\. Nothing was written\.\n/, database);
    assert.ok(Date.now() - started < 10_000);
  });

  it("leaves a database that is there as it was: without --force, and when the scan fails with --force", async () => {
    const database = join(dir, "sandbox.db");
    assert.equal((await run("init-pg", urlOf(shop.port), "--out", database)).code, 0);
    const before = filesOf(dir);

    // Without --force: refused before anything is connected to (a port where nothing listens would say so otherwise).
    const nowhere = urlOf(await closedPort());
    const kept = await run("init-pg", nowhere, "--out", database);
    assert.equal(kept.code, 1);
    assert.match(kept.stderr, /^Error: .*sandbox\.db exists\. Use --force to replace it; the rows it holds are lost\.\n/);

    // With --force, a scan that fails replaces nothing.
    for (const argv of [[nowhere], [urlOf(edges.port), "--schema", "empty_one"], [urlOf(edges.port), "--strict"]]) {
      const result = await run("init-pg", ...argv, "--out", database, "--force");
      assert.equal(result.code, 1, argv.join(" "));
      assert.match(result.stderr, /Nothing was written\.\n/);
      assert.deepEqual(filesOf(dir), before, argv.join(" "));
      assert.equal(existsSync(ownerRecordPath(database)), false);
    }

    // And with --force, one that succeeds replaces it.
    const replaced = await run("init-pg", urlOf(edges.port), "--schema", "archive", "--out", database, "--force");
    assert.equal(replaced.code, 0, replaced.stderr);
    assert.deepEqual(schemaOf(database).tables.map((table) => table.name), ["labels", "orders"]);
  });

  /** Starts Studio on a database, and resolves once it serves. */
  async function startStudio(database: string): Promise<{ ask: (operation: string, request?: unknown, madeFor?: string) => Promise<{ status: number; body: any }>; status: () => Promise<any> }> {
    let output = "";
    let announce: (found: string) => void = () => {};
    const ready = new Promise<string>((resolve) => (announce = resolve));
    const signals = new EventEmitter();
    const write = (text: string): void => {
      output += text;
      const match = /Local DB Studio at (http:\/\/127\.0\.0\.1:\d+\/#key=[0-9a-f]{48})\n/.exec(output);
      if (match && /Press Ctrl\+C to stop\./.test(output)) {
        announce(match[1] as string);
      }
    };
    const exit = runCli(["studio", database, "--port", "0"], { stdout: { write }, stderr: { write }, signals });
    stops.push(() => (signals.emit("SIGINT"), exit));
    const found = await Promise.race([ready, exit.then((code) => Promise.reject(new Error(`exited with ${code}: ${output}`)))]);
    const [url, key] = found.split("/#key=") as [string, string];
    const call = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    return {
      ask: (operation, request, madeFor) => call(`/api/access/${operation}`, { ...(madeFor !== undefined && { for: madeFor }), ...(request !== undefined && { request }) }),
      status: async () => (await call("/api/status")).body,
    };
  }
});
