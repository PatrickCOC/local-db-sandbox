import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SCHEMA, clientFor, fixture } from "../../postgrest/test/support.ts";
import { SINGLE_FILE_READ_ONLY } from "../../runtime-access/src/index.ts";
import { canonicalDatabasePath, createDatabase, ownerRecordPath } from "../../storage-json/src/index.ts";
import type { OwnerRecord } from "../../storage-json/src/index.ts";
import { storedRows } from "../../storage-json/test/support/database-files.ts";
import { runCli, startSandbox } from "../src/index.ts";

/*
 * `local-db-sandbox studio <database>`: Local DB Studio, started from the
 * command line (D-042). What it prints says how the database is open, and
 * the address it prints leads to a page that shows what is in the database.
 */

interface Session {
  /** The address the command printed: the page, with the key behind a #. */
  address: string;
  url: string;
  key: string;
  out: () => string;
  /** Asks what the page asks, with the key. */
  ask: (operation: string, request?: unknown, madeFor?: string) => Promise<{ status: number; body: any }>;
  status: () => Promise<any>;
  stop: (signal?: "SIGINT" | "SIGTERM") => Promise<number>;
}

describe("CLI: studio", { timeout: 120_000 }, () => {
  let dir: string;
  let database: string;
  let file: string;
  let sessions: { stop: () => Promise<unknown> }[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-cli-"));
    database = join(dir, "sandbox.db");
    file = join(dir, "sandbox.db.json");
    await createDatabase(database, { collections: fixture(), schema: SCHEMA }, { format: "directory" });
    await createDatabase(file, { collections: fixture() });
    sessions = [];
  });
  afterEach(async () => {
    for (const session of sessions.splice(0).reverse()) {
      await session.stop();
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  }

  /** Starts a command that serves until a signal, and resolves once it has printed what `announced` finds. */
  async function serve(argv: string[], announced: RegExp): Promise<{ found: string; out: () => string; stop: (signal?: "SIGINT" | "SIGTERM") => Promise<number> }> {
    let output = "";
    let announce: (found: string) => void = () => {};
    const ready = new Promise<string>((resolve) => (announce = resolve));
    const signals = new EventEmitter();
    const write = (text: string): void => {
      output += text;
      const match = announced.exec(output);
      // Once all of what is printed at the start is there.
      if (match && /Press Ctrl\+C to stop\./.test(output)) {
        announce(match[1] as string);
      }
    };
    const exit = runCli(argv, { stdout: { write }, stderr: { write }, signals });
    const found = await Promise.race([ready, exit.then((code) => Promise.reject(new Error(`exited with ${code}: ${output}`)))]);
    let stopped: Promise<number> | undefined;
    const session = {
      found,
      out: () => output,
      stop: (signal: "SIGINT" | "SIGTERM" = "SIGINT") => {
        stopped ??= (signals.emit(signal), exit);
        return stopped;
      },
    };
    sessions.push(session);
    return session;
  }

  async function studio(...argv: string[]): Promise<Session> {
    const started = await serve(["studio", ...argv], /Local DB Studio at (http:\/\/127\.0\.0\.1:\d+\/#key=[0-9a-f]{48})\n/);
    const [url, key] = started.found.split("/#key=") as [string, string];
    const call = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const response = await fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${key}`, ...(body !== undefined && { "content-type": "application/json" }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    return {
      address: started.found,
      url,
      key,
      out: started.out,
      ask: (operation, request, madeFor) => call(`/api/access/${operation}`, { ...(madeFor !== undefined && { for: madeFor }), ...(request !== undefined && { request }) }),
      status: async () => (await call("/api/status")).body,
      stop: started.stop,
    };
  }

  describe("usage", () => {
    it("prints its help, which says how a database is opened and that the page is this machine's own", async () => {
      const { code, stdout, stderr } = await run("studio", "--help");
      assert.deepEqual([code, stderr], [0, ""]);
      assert.match(stdout, /^Usage: local-db-sandbox studio \[database\] \[options\]\n/);
      assert.match(stdout, /Without it, Studio opens the project's database: the one\s+\.local-db-sandbox\/sandbox\.config\.json names \(init-nest\), or\s+\.local-db-sandbox\/sandbox\.db \(init, init-pg\)/);
      assert.match(stdout, /A directory that no process has open/);
      assert.match(stdout, /A database that a sandbox has open/);
      assert.match(stdout, /A single file\s+Read-only, always\./);
      assert.match(stdout, /One process has a database open to write at a time\. Studio is never a second\s+one/);
      // And the other way round: what a Studio that has a directory to itself means for a sandbox, and how the database is handed over.
      assert.match(stdout, /While Studio has a directory to itself, a sandbox that is started on it is\s+refused\. To use the database with an application: stop Studio \(Ctrl\+C\), start\s+the sandbox, and start Studio again\. It then attaches to the sandbox\./);
      assert.match(stdout, /served on this machine only \(127\.0\.0\.1\)/);
      assert.match(stdout, /-p, --port <number>\s+Port of the page \(default: 4583; 0 = any free port\)/);
      assert.match(stdout, /--read-only\s+Change nothing/);
      // The page is served nowhere else: there is no option for it.
      assert.doesNotMatch(stdout, /--host/);
      const main = (await run("--help")).stdout;
      assert.match(main, /local-db-sandbox studio \[database\] \[options\]/);
      assert.match(main, /"studio" opens Local DB Studio, a page that shows and changes what is in a database; see "local-db-sandbox studio --help"\./);
    });

    it("refuses what it cannot make sense of, and a database that is not there", async () => {
      const fails = async (argv: string[], message: RegExp): Promise<void> => {
        const { code, stdout, stderr } = await run("studio", ...argv);
        assert.deepEqual([code, stdout], [1, ""], argv.join(" "));
        assert.match(stderr, message, argv.join(" "));
        assert.match(stderr, /\nRun "local-db-sandbox studio --help" for usage\.\n$/);
      };
      await fails([database, file], /^Error: Expected one database at most\./);
      await fails([database, "--port", "x"], /^Error: --port must be an integer from 0 to 65535\./);
      await fails([database, "--port", "70000"], /^Error: --port must be an integer from 0 to 65535\./);
      await fails([database, "--host", "0.0.0.0"], /^Error: Unknown option '--host'/);
      await fails([database, "--max-file-size", "0"], /^Error: --max-file-size/);
      await fails([join(dir, "missing.db")], /^Error: Database not found: .*missing\.db\n/);
      assert.equal(existsSync(ownerRecordPath(database)), false);
    });

    it("says that its port is taken", async () => {
      const taken = createServer();
      await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
      const { port } = taken.address() as { port: number };
      try {
        const { code, stderr } = await run("studio", database, "--port", String(port));
        assert.equal(code, 1);
        assert.match(stderr, new RegExp(`^Error: Port ${port} is already in use\\. Choose another with --port\\.\\n`));
      } finally {
        await new Promise((resolve) => taken.close(resolve));
      }
      assert.equal(existsSync(ownerRecordPath(database)), false);
    });
  });

  describe("on a directory that no process has open", () => {
    it("says how the database is open, serves a page that shows its tables and rows, and stops on a signal", async () => {
      const session = await studio(database, "--port", "0");
      assert.match(
        session.out(),
        new RegExp(
          // First what a Studio that has a directory to itself has to say: a sandbox is refused the database meanwhile, and how it is handed over.
          "^Note: Studio has this database to itself\\. While it runs, a sandbox that is started on the database is refused: one process has a database open to write at a time\\. " +
            "To use the database with an application, stop Studio \\(Ctrl\\+C in its terminal\\), start the sandbox, and start Studio again\\. It then attaches to the sandbox, and both show the same rows\\.\\n" +
            "Local DB Studio at http://127\\.0\\.0\\.1:\\d+/#key=[0-9a-f]{48}\\n" +
            "  database:  .*sandbox\\.db \\(database directory\\)\\n" +
            "  mode:      standalone: Studio has the database to itself\\n" +
            "  access:    read/write\\n" +
            "  tables:    2\\n" +
            "  The address holds the key of this session\\. The page is served to this machine only\\.\\n" +
            "  Press Ctrl\\+C to stop\\.\\n$",
        ),
      );
      // The page is there, and what it asks for is what is in the database.
      const page = await fetch(session.url);
      assert.deepEqual([page.status, /<title>Local DB Studio<\/title>/.test(await page.text())], [200, true]);
      const status = await session.status();
      assert.deepEqual([status.mode, status.connected, status.database, status.format, status.info.kind, status.info.tables], ["standalone", true, canonicalDatabasePath(database), "directory", "studio", 2]);
      const schema = (await session.ask("schema")).body.result;
      assert.deepEqual(schema.tables.map((table: { name: string; rows: number; primaryKey: string[] }) => [table.name, table.rows, table.primaryKey]), [["teams", 5, ["id"]], ["readings", 4, ["taken_at", "sensor"]]]);
      assert.deepEqual(schema.tables[0].columns.slice(0, 3).map((column: { name: string; type: string; declaredType?: string; nullable: boolean; primaryKey: boolean }) => [column.name, column.type, column.declaredType, column.nullable, column.primaryKey]), [
        ["id", "integer", "int4", false, true],
        ["name", "text", undefined, false, false],
        ["active", "boolean", undefined, false, false],
      ]);
      assert.deepEqual((await session.ask("browse", { table: "teams", limit: 2 })).body.result.rows.map((row: unknown[]) => [row[0], row[1], row[2]]), [[1, "Alpha", true], [2, "Beta", false]]);
      // While it runs, the database is Studio's.
      const record: OwnerRecord = JSON.parse(readFileSync(ownerRecordPath(database), "utf8"));
      assert.deepEqual([record.kind, record.pid], ["studio", process.pid]);

      assert.equal(await session.stop("SIGINT"), 0);
      assert.match(session.out(), /\nStopped\.\n$/);
      assert.equal(existsSync(ownerRecordPath(database)), false);
      await assert.rejects(fetch(session.url));
      // The key was printed once, in the address, and the owner's token never.
      assert.equal(session.out().split(session.key).length, 2);
      assert.equal(session.out().includes(record.control?.token as string), false);
    });

    it("adds, changes, and removes rows, which are there when Studio is started again", async () => {
      const first = await studio(database, "--port", "0");
      const { instance } = (await first.status()).info;
      assert.deepEqual((await first.ask("insert", { table: "teams", values: { id: 6, name: "Zeta", meta: { tags: ["new"] } } }, instance)).body, { result: { affectedRows: 1 } });
      assert.deepEqual((await first.ask("update", { table: "teams", key: { id: 2 }, values: { name: "Beta 2", active: true } }, instance)).body, { result: { affectedRows: 1 } });
      assert.deepEqual((await first.ask("delete", { table: "teams", key: { id: 5 } }, instance)).body, { result: { affectedRows: 1 } });
      const sql = (await first.ask("sql", { sql: "UPDATE readings SET value = value * 10 WHERE sensor = 's2'; SELECT sensor, value FROM readings ORDER BY taken_at DESC LIMIT 1", mode: "write" }, instance)).body.result;
      assert.deepEqual([sql.error, sql.results.map((each: { operation: string; affectedRows: number; rows: unknown[][] }) => [each.operation, each.affectedRows, each.rows])], [undefined, [["UPDATE", 1, []], ["SELECT", 0, [["s2", 40]]]]]);
      assert.equal(await first.stop("SIGTERM"), 0);

      assert.deepEqual((await storedRows(database, "teams")).map((team) => [team.id, team.name]), [[1, "Alpha"], [2, "Beta 2"], [3, "Gamma"], [4, "Delta"], [6, "Zeta"]]);
      const again = await studio(database, "--port", "0");
      const rows = (await again.ask("browse", { table: "teams", orderBy: [{ column: "id", direction: "desc" }], limit: 2 })).body.result;
      assert.deepEqual([rows.total, rows.rows.map((row: unknown[]) => [row[0], row[1], row[2], row[4]])], [5, [[6, "Zeta", true, { tags: ["new"] }], [4, "Delta", true, null]]]);
      assert.deepEqual((await again.ask("row", { table: "teams", key: { id: 2 } })).body.result.row.name, "Beta 2");
      assert.deepEqual((await again.ask("sql", { sql: "SELECT value FROM readings WHERE sensor = 's2'", mode: "read" })).body.result.results[0].rows, [[40]]);
    });

    it("changes nothing when it is started with --read-only, and says so", async () => {
      const session = await studio(database, "--port", "0", "--read-only");
      assert.match(session.out(), /\n {2}mode: {6}standalone: Studio reads the database as it is stored\n {2}access: {4}read-only: Studio was started with --read-only\.\n/);
      assert.equal(existsSync(ownerRecordPath(database)), false);
      const refused = await session.ask("delete", { table: "teams", key: { id: 5 } });
      assert.deepEqual([refused.status, refused.body.error], [403, { code: "READ_ONLY", message: "Studio was started with --read-only." }]);
      assert.equal((await session.ask("browse", { table: "teams" })).body.result.total, 5);
    });
  });

  describe("on a single file", () => {
    it("shows the rows, runs statements that read, and changes nothing: it says why, and the file stays as it is", async () => {
      const bytes = await readFile(file);
      const session = await studio(file, "--port", "0");
      assert.match(session.out(), /\n {2}database: {2}.*sandbox\.db\.json \(single file\)\n {2}mode: {6}standalone: Studio reads the database as it is stored\n {2}access: {4}read-only: A single-file database is not changed through Studio: convert it into a database directory to change it\.\n {2}tables: {4}2\n/);
      assert.equal((await session.ask("browse", { table: "teams" })).body.result.total, 5);
      assert.deepEqual((await session.ask("sql", { sql: "SELECT COUNT(*) AS n FROM readings", mode: "read" })).body.result.results[0].rows, [[4]]);
      const { instance } = (await session.status()).info;
      for (const [operation, request] of [
        ["insert", { table: "teams", values: { id: 9, name: "x" } }],
        ["update", { table: "teams", key: { id: 1 }, values: { name: "x" } }],
        ["delete", { table: "teams", key: { id: 1 } }],
        ["sql", { sql: "DELETE FROM teams", mode: "write" }],
      ] as [string, unknown][]) {
        const refused = await session.ask(operation, request, instance);
        assert.deepEqual([refused.status, refused.body.error], [403, { code: "READ_ONLY", message: SINGLE_FILE_READ_ONLY }], operation);
      }
      assert.equal((await session.ask("sql", { sql: "DELETE FROM teams", mode: "read" })).body.result.error.code, "READ_ONLY");
      assert.equal(await session.stop(), 0);
      assert.deepEqual(await readFile(file), bytes);
      assert.equal(existsSync(ownerRecordPath(file)), false);
    });
  });

  describe("on a database that a sandbox has open", () => {
    it("attaches to the PostgREST endpoint: one runtime and one owner, and each sees what the other changes", async () => {
      const endpoint = await serve(["postgrest", database, "--port", "0", "--quiet", "--sql-log", "off"], /Supabase URL for clients: (http:\S+)/);
      const client = clientFor(endpoint.found);
      const owner: OwnerRecord = JSON.parse(readFileSync(ownerRecordPath(database), "utf8"));

      const session = await studio(database, "--port", "0");
      assert.match(session.out(), new RegExp(`\\n  mode:      attached to the PostgREST endpoint \\(pid ${process.pid}\\): Studio looks into its runtime, and does not open the database\\n  access:    read/write\\n  tables:    2\\n`));
      const status = await session.status();
      assert.deepEqual([status.mode, status.connected, status.info.kind, status.info.instance], ["attached", true, "postgrest", owner.instance]);
      // The database has the one owner it had.
      assert.deepEqual(JSON.parse(readFileSync(ownerRecordPath(database), "utf8")), owner);

      // What the application writes through the endpoint, Studio shows...
      assert.equal((await client.from("teams").upsert({ id: 7, name: "From the API" })).error, null);
      assert.deepEqual((await session.ask("browse", { table: "teams", filters: [{ column: "id", op: "eq", value: 7 }] })).body.result.rows.map((row: unknown[]) => row[1]), ["From the API"]);
      // ...and what is changed in Studio, the endpoint serves, and saves.
      assert.deepEqual((await session.ask("update", { table: "teams", key: { id: 7 }, values: { name: "From Studio" } }, owner.instance)).body, { result: { affectedRows: 1 } });
      assert.deepEqual((await client.from("teams").select("name").eq("id", 7).single()).data, { name: "From Studio" });
      assert.deepEqual((await session.ask("sql", { sql: "DELETE FROM teams WHERE id = 5", mode: "write" }, owner.instance)).body.result.results[0].affectedRows, 1);
      assert.deepEqual((await client.from("teams").select("id").gte("id", 4)).data, [{ id: 4 }, { id: 7 }]);
      assert.deepEqual((await storedRows(database, "teams")).map((team) => team.id), [1, 2, 3, 4, 7]);

      // Studio leaves; the endpoint has its database and serves as before.
      assert.equal(await session.stop(), 0);
      assert.deepEqual(JSON.parse(readFileSync(ownerRecordPath(database), "utf8")), owner);
      assert.deepEqual((await client.from("teams").select("name").eq("id", 7).single()).data, { name: "From Studio" });
      assert.equal(session.out().includes(owner.control?.token as string), false);
    });

    it("is refused a directory that a sandbox without a runtime has open, and reads what is stored when it is asked to look only", async () => {
      const rest = await startSandbox({ file: database, port: 0 });
      sessions.push(rest);
      const refused = await run("studio", database, "--port", "0");
      assert.equal(refused.code, 1);
      assert.match(
        refused.stderr,
        /^Error: .*sandbox\.db is open in the REST sandbox \(pid \d+, since .*\)\. One process has a database open to write at a time: stop that one first\. If that process is gone, delete .*sandbox\.db\.owner\.json\.\nThat process does not serve its runtime, so Studio cannot look into the database through it\. With --read-only, Studio shows the database as it is stored\.\n/,
      );
      const looking = await studio(database, "--port", "0", "--read-only");
      assert.match(looking.out(), /Note: The REST sandbox \(pid \d+, since .*\) has the database open\. What is shown is the database as it was stored when Studio opened it\.\n/);
      assert.match(looking.out(), /\n {2}mode: {6}standalone: Studio reads the database as it is stored\n {2}access: {4}read-only: Studio was started with --read-only\.\n/);
      assert.equal((await looking.ask("browse", { table: "teams" })).body.result.total, 5);
      assert.equal((await looking.ask("insert", { table: "teams", values: { id: 9, name: "x" } })).status, 403);
      assert.equal(JSON.parse(readFileSync(ownerRecordPath(database), "utf8")).kind, "rest");
    });
  });

  describe("handing a database over from Studio to a sandbox", () => {
    it("a sandbox that is started while Studio has the database is refused, is told the three steps, and those steps work", async () => {
      const alone = await studio(database, "--port", "0");
      const owner: OwnerRecord = JSON.parse(readFileSync(ownerRecordPath(database), "utf8"));
      assert.equal(owner.kind, "studio");

      // 1. The sandbox is refused, and is told who has the database and what to do.
      const refused = await run("postgrest", database, "--port", "0");
      assert.deepEqual([refused.code, refused.stdout], [1, ""]);
      assert.match(
        refused.stderr,
        new RegExp(
          `^Error: .*sandbox\\.db is open in Local DB Studio \\(pid ${process.pid}, since .*\\)\\. One process has a database open to write at a time: stop that one first\\. ` +
            "That Studio has the database to itself\\. To run the sandbox on it: stop that Studio \\(Ctrl\\+C in its terminal\\), start the sandbox, and start Studio again\\. " +
            "It then attaches to the sandbox, and both show the same rows\\.\\n",
        ),
      );
      // Nothing was let go of for it, and nothing was started: Studio has the database as before, and changes it.
      assert.deepEqual(JSON.parse(readFileSync(ownerRecordPath(database), "utf8")), owner);
      assert.deepEqual((await alone.ask("insert", { table: "teams", values: { id: 8, name: "Before the handover" } }, owner.instance)).body, { result: { affectedRows: 1 } });

      // 2. Studio is stopped by whoever runs it, and the sandbox starts.
      assert.equal(await alone.stop(), 0);
      assert.equal(existsSync(ownerRecordPath(database)), false);
      const endpoint = await serve(["postgrest", database, "--port", "0", "--quiet", "--sql-log", "off"], /Supabase URL for clients: (http:\S+)/);
      const client = clientFor(endpoint.found);

      // 3. Studio is started again: it is attached now, has nothing to hand over, and says nothing of it.
      const attached = await studio(database, "--port", "0");
      assert.match(attached.out(), new RegExp(`^Local DB Studio at .*\\n  database:  .*\\n  mode:      attached to the PostgREST endpoint \\(pid ${process.pid}\\): Studio looks into its runtime, and does not open the database\\n`));
      assert.doesNotMatch(attached.out(), /Note:/);
      assert.deepEqual((await attached.status()).notices, []);
      // Both show the same rows, the one Studio wrote before the handover among them.
      assert.deepEqual((await client.from("teams").select("name").eq("id", 8).single()).data, { name: "Before the handover" });
      assert.deepEqual((await attached.ask("browse", { table: "teams", filters: [{ column: "id", op: "eq", value: 8 }] })).body.result.rows.map((row: unknown[]) => row[1]), ["Before the handover"]);
    });
  });
});
