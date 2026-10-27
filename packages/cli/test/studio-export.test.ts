import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createDatabase } from "../../storage-json/src/index.ts";
import { schemaFile, storedRows } from "../../storage-json/test/support/database-files.ts";
import { runCli } from "../src/index.ts";

/*
 * Local DB Studio's Export tab through the command (D-050): the database
 * made by `init` from synthetic migrations, rows added in Studio, the
 * script asked for as the page asks for it, and then loaded into a new,
 * empty PostgreSQL (PGlite, in this process), where its tables and rows are
 * compared with the sandbox's. The sandbox is the same, byte for byte,
 * before and after.
 */

const SHOP = readFileSync(join(import.meta.dirname, "../../import-postgres/test/fixtures/catalog/shop.sql"), "utf8");

const TABLES = ["customers", "order_lines", "orders", "products", "stock_levels", "tags", "warehouses"];

/**
 * The database as it is: its manifest, its schema, and the rows of every table. (Files of an earlier generation, which a
 * directory removes a while after a save, are not part of it.) A save would change the manifest.
 */
async function content(database: string): Promise<unknown> {
  return {
    manifest: readFileSync(join(database, "manifest.json"), "utf8"),
    schema: readFileSync(schemaFile(database), "utf8"),
    rows: Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, await storedRows(database, table)]))),
  };
}

interface Served {
  out: () => string;
  stop: () => Promise<number>;
}

describe("CLI: studio, the Export tab", { timeout: 180_000 }, () => {
  let dir: string;
  let database: string;
  let sessions: Served[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-export-"));
    mkdirSync(join(dir, "migrations"));
    writeFileSync(join(dir, "migrations", "0001_shop.sql"), SHOP);
    database = join(dir, "sandbox.db");
    const quiet = { stdout: { write: () => undefined }, stderr: { write: () => undefined }, signals: new EventEmitter() };
    assert.equal(await runCli(["init", join(dir, "migrations"), "--out", database], quiet), 0);
    sessions = [];
  });
  afterEach(async () => {
    for (const session of sessions.splice(0).reverse()) {
      await session.stop();
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** Starts a command that serves until a signal, and resolves once it has printed what `announced` finds. */
  async function serve(argv: string[], announced: RegExp): Promise<{ found: string } & Served> {
    let output = "";
    let announce: (found: string) => void = () => {};
    const ready = new Promise<string>((resolve) => (announce = resolve));
    const signals = new EventEmitter();
    const write = (text: string): void => {
      output += text;
      const match = announced.exec(output);
      if (match && /Press Ctrl\+C to stop\./.test(output)) {
        announce(match[1] as string);
      }
    };
    const exit = runCli(argv, { stdout: { write }, stderr: { write }, signals });
    const found = await Promise.race([ready, exit.then((code) => Promise.reject(new Error(`exited with ${code}: ${output}`)))]);
    let stopped: Promise<number> | undefined;
    const session = { found, out: () => output, stop: () => (stopped ??= (signals.emit("SIGINT"), exit)) };
    sessions.push(session);
    return session;
  }

  async function studio(...argv: string[]): Promise<{ ask: (path: string, body: unknown) => Promise<{ status: number; json: any }>; instance: () => Promise<string> }> {
    const started = await serve(["studio", ...argv], /Local DB Studio at (http:\/\/127\.0\.0\.1:\d+\/#key=[0-9a-f]{48})\n/);
    const [url, key] = started.found.split("/#key=") as [string, string];
    const ask = async (path: string, body: unknown): Promise<{ status: number; json: any }> => {
      const response = await fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
      return { status: response.status, json: await response.json() };
    };
    return { ask, instance: async () => (await ask("/api/status", undefined)).json.info.instance };
  }

  /** Rows added as the page adds them: values a person types, with quotes, Unicode, and nothing at all. */
  async function addRows(page: Awaited<ReturnType<typeof studio>>): Promise<void> {
    const instance = await page.instance();
    const insert = async (table: string, values: Record<string, unknown>): Promise<void> => {
      const answer = await page.ask("/api/access/insert", { for: instance, request: { table, values } });
      assert.equal(answer.status, 200, JSON.stringify(answer.json));
    };
    await insert("customers", { email: "o'brien@example.com", name: 'Zoë "Q" \\ 日本語 🎉', vip: true, birthday: "1990-02-03", external_id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", preferences: { theme: "dark", list: [1, null, "it's"] } });
    await insert("customers", { email: "plain@example.com" });
    await insert("products", { sku: "A-1", title: "Kettle", price: 19.5, stock: 3, views: 12345678901 });
    await insert("orders", { customer_id: 1, state: "paid", total: 19.5 });
    await insert("order_lines", { order_id: 1, line: 1, sku: "A-1", quantity: 2 });
    await insert("warehouses", { region: "eu", code: "1", label: "Europe" });
    await insert("stock_levels", { region: "eu", code: "1", sku: "A-1", quantity: 5 });
  }

  /** A new, empty PostgreSQL that has run the script. */
  async function load(sql: string): Promise<PGlite> {
    const db = await PGlite.create();
    await db.exec(sql);
    return db;
  }

  it("exports the schema and rows that Studio shows, which PostgreSQL loads as the sandbox has them, and the sandbox stays as it was", async () => {
    const page = await studio(database, "--port", "0");
    await addRows(page);
    const before = await content(database);
    const answer = await page.ask("/api/export", { request: { tables: TABLES, mode: "schema-and-data", confirmData: true } });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    const result = answer.json.result;
    assert.match(result.fileName, /^local-db-export-schema-and-data-\d{8}T\d{6}Z\.sql$/);
    assert.deepEqual([result.tables.length, result.rows, result.mode, result.warnings], [7, 7, "schema-and-data", []]);
    // Nothing of where the database is.
    assert.equal(result.sql.includes(dir), false);
    assert.equal(result.sql.includes("sandbox.db"), false);
    assert.deepEqual(await content(database), before);

    const db = await load(result.sql);
    try {
      const customers = (await db.query("SELECT id, email, name, vip, birthday::text, external_id::text, preferences FROM customers ORDER BY id")).rows;
      assert.deepEqual(customers, [
        { id: 1, email: "o'brien@example.com", name: 'Zoë "Q" \\ 日本語 🎉', vip: true, birthday: "1990-02-03", external_id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", preferences: { theme: "dark", list: [1, null, "it's"] } },
        { id: 2, email: "plain@example.com", name: null, vip: false, birthday: null, external_id: null, preferences: {} },
      ]);
      // As the sandbox has the rows: the defaults it filled in when they were added, and nothing else.
      const sandbox = await storedRows(database, "customers");
      assert.deepEqual(
        (await db.query("SELECT created_at FROM customers ORDER BY id")).rows.map((row) => (row as { created_at: Date }).created_at.toISOString()),
        sandbox.map((row) => row.created_at),
      );
      assert.deepEqual((await db.query("SELECT state::text, total::text, placed_on::text FROM orders")).rows, [{ state: "paid", total: "19.5", placed_on: (await storedRows(database, "orders"))[0]?.placed_on }]);
      assert.deepEqual((await db.query("SELECT views::text FROM products")).rows, [{ views: "12345678901" }]);
      assert.deepEqual((await db.query("SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f'")).rows, [{ count: 5 }]);
      // Numbering goes on after the rows (asked first: a refused INSERT takes a number too); the foreign keys hold, and the unique constraint.
      assert.deepEqual((await db.query("INSERT INTO customers (email) VALUES ('new@example.com') RETURNING id")).rows, [{ id: 3 }]);
      await assert.rejects(db.query("INSERT INTO orders (customer_id) VALUES (99)"), /violates foreign key constraint/);
      await assert.rejects(db.query("INSERT INTO customers (email) VALUES ('plain@example.com')"), /duplicate key value violates unique constraint "customers_email_key"/);
    } finally {
      await db.close();
    }

    // One table, schema only: no rows asked for, none written.
    const one = await page.ask("/api/export", { request: { tables: ["products"], mode: "schema" } });
    assert.equal(one.status, 200);
    assert.match(one.json.result.fileName, /^local-db-export-schema-\d{8}T\d{6}Z\.sql$/);
    assert.doesNotMatch(one.json.result.sql, /INSERT|Kettle/);
    const empty = await load(one.json.result.sql);
    await empty.close();
    // Data, unconfirmed: refused.
    assert.equal((await page.ask("/api/export", { request: { tables: ["customers"], mode: "data" } })).status, 400);
    assert.deepEqual(await content(database), before);
  });

  it("exports through a sandbox that has the database open, whose runtime is asked, and not the files", async () => {
    await serve(["postgrest", database, "--port", "0", "--quiet", "--sql-log", "off"], /Supabase URL for clients: (http:\S+)/);
    const page = await studio(database, "--port", "0");
    assert.equal((await page.ask("/api/status", undefined)).json.mode, "attached");
    await addRows(page);
    const answer = await page.ask("/api/export", { request: { tables: ["customers", "orders"], mode: "data", confirmData: true } });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.deepEqual([answer.json.result.tables, answer.json.result.rows], [["customers", "orders"], 3]);
    assert.match(answer.json.result.sql, /INSERT INTO "customers" .* OVERRIDING SYSTEM VALUE VALUES\n {2}\(1, 'o''brien@example\.com'/);
  });

  it("has nothing to export in a database without tables", async () => {
    const bare = join(dir, "bare.db");
    await createDatabase(bare, { collections: {}, schema: [] }, { format: "directory" });
    const page = await studio(bare, "--port", "0");
    const answer = await page.ask("/api/export", { request: { tables: [], mode: "schema" } });
    assert.equal(answer.status, 400);
    assert.equal((await page.ask("/api/export", { request: { tables: ["customers"], mode: "schema" } })).status, 404);
  });
});
