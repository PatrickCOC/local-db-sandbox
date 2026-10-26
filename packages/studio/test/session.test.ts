import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SqliteRuntime } from "../../runtime/src/index.ts";
import type { TableSchema } from "../../runtime/src/index.ts";
import { AccessError, SINGLE_FILE_READ_ONLY, serveRuntime } from "../../runtime-access/src/index.ts";
import type { AccessErrorCode } from "../../runtime-access/src/index.ts";
import { DATA, SCHEMA } from "../../runtime-access/test/support/fixture.ts";
import { ownDatabase } from "../../runtime-access/test/support/owner-process.ts";
import type { OwnerProcess } from "../../runtime-access/test/support/owner-process.ts";
import { DatabaseOwnedError, canonicalDatabasePath, claimDatabase, createDatabase, inspectDatabase, openDatabaseStorage, ownerRecordPath } from "../../storage-json/src/index.ts";
import type { OwnerRecord } from "../../storage-json/src/index.ts";
import { allFiles, schemaFile, storedRows } from "../../storage-json/test/support/database-files.ts";
import { openStudioSession } from "../src/index.ts";
import type { StudioSession } from "../src/index.ts";

/*
 * How Studio has a database (D-042). A directory that no process has open,
 * it has to itself, and may change. One that a process has open, it looks
 * into through that process, and never opens. A single file it only reads.
 * It is never a second writer.
 */

const FORMATS = join(import.meta.dirname, "../../storage-json/test/fixtures/formats");
/** The definitions as a single file holds them: columns and keys. It has no place for constraints, canonical types, or enumerated types (D-033, D-036). */
const FILE_SCHEMA: TableSchema[] = SCHEMA.map((table) => ({ name: table.name, columns: table.columns.map(({ canonicalType: _canonical, enum: _values, ...column }) => column) }));

async function refused(promise: Promise<unknown>, code: AccessErrorCode, message: RegExp = /./): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AccessError, `not an AccessError: ${String(error)}`);
    assert.equal(error.code, code, error.message);
    assert.match(error.message, message);
    return true;
  });
}

describe("a Studio session", { timeout: 180_000 }, () => {
  let root: string;
  let directory: string;
  let file: string;
  const sessions: StudioSession[] = [];
  const owners: OwnerProcess[] = [];
  const open = async (...args: Parameters<typeof openStudioSession>): Promise<StudioSession> => {
    const session = await openStudioSession(...args);
    sessions.push(session);
    return session;
  };
  const record = (path: string = directory): OwnerRecord => JSON.parse(readFileSync(ownerRecordPath(path), "utf8"));
  const beside = (): string[] => readdirSync(dirname(directory)).sort();

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-session-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    const home = join(root, `db-${Math.random().toString(16).slice(2)}`);
    directory = join(home, "sandbox.db");
    file = join(home, "sandbox.db.json");
    await createDatabase(directory, { collections: DATA(), schema: SCHEMA });
    // A single file as an application's sandbox leaves it: rows, and the definitions of its tables.
    await createDatabase(file, { collections: DATA(), schema: FILE_SCHEMA });
  });
  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.close();
    }
    for (const owner of owners.splice(0)) {
      await owner.kill();
    }
  });

  describe("on a directory that no process has open", () => {
    it("has the database to itself: it claims it, opens it on the runtime, and says so", async () => {
      const session = await open({ database: directory });
      assert.deepEqual([session.mode, session.format, session.database], ["standalone", "directory", canonicalDatabasePath(directory)]);
      const status = await session.status();
      assert.deepEqual([status.mode, status.connected, status.disconnected, status.database, status.format], ["standalone", true, undefined, canonicalDatabasePath(directory), "directory"]);
      assert.deepEqual([status.info?.kind, status.info?.pid, status.info?.format, status.info?.persistence, status.info?.readOnly, status.info?.tables], ["studio", process.pid, "directory", "json", undefined, 4]);
      // The record next to the database says that Studio has it, and where its runtime is served.
      assert.deepEqual([record().kind, record().pid, record().instance, /^http:\/\/127\.0\.0\.1:\d+$/.test(record().control?.url ?? "")], ["studio", process.pid, status.info?.instance, true]);
      assert.deepEqual(beside(), ["sandbox.db", "sandbox.db.json", "sandbox.db.owner.json"]);
      // It shows what is there: the tables, as they are defined, and their rows.
      assert.deepEqual((await session.access.schema()).tables.map((table) => [table.name, table.rows]), [["users", 25], ["orders", 2], ["memberships", 3], ["notes", 3]]);
      assert.deepEqual((await session.access.browse({ table: "users", limit: 2 })).rows.map((row) => row[1]), ["user 01", "user 02"]);
    });

    it("adds, changes, and removes rows, which are in the database's files, and there when it is opened again", async () => {
      const [format, definitions] = [inspectDatabase(directory), await readFile(schemaFile(directory), "utf8")];
      const session = await open({ database: directory });
      assert.deepEqual(await session.access.insert({ table: "users", values: { name: "Ada" } }), { affectedRows: 1, lastInsertId: 26 });
      assert.deepEqual(await session.access.update({ table: "users", key: { id: 2 }, values: { name: "Bo" } }), { affectedRows: 1 });
      assert.deepEqual(await session.access.delete({ table: "users", key: { id: 25 } }), { affectedRows: 1 });
      const written = await session.access.sql({ sql: "UPDATE notes SET text = 'by the console' WHERE text = 'first'; SELECT COUNT(*) AS n FROM notes", mode: "write" });
      assert.deepEqual([written.error, written.results.map((each) => [each.operation, each.affectedRows])], [undefined, [["UPDATE", 1], ["SELECT", 0]]]);
      const stored = await storedRows(directory, "users");
      assert.deepEqual([stored.length, stored[1]?.name, stored.at(-1)?.name, stored.some((user) => user.id === 25)], [25, "Bo", "Ada", false]);
      assert.equal((await storedRows(directory, "notes"))[0]?.text, "by the console");

      // Closed, it has let go of the database; opened again, the rows are what was left.
      await session.close();
      assert.deepEqual(beside(), ["sandbox.db", "sandbox.db.json"]);
      // The database is stored as it was stored: the same format, and the same definitions, to the byte. Only rows changed.
      const afterwards = inspectDatabase(directory);
      assert.deepEqual([afterwards.formatVersion, afterwards.compatibility, afterwards.tables], [format.formatVersion, "current", format.tables]);
      assert.equal(await readFile(schemaFile(directory), "utf8"), definitions);
      const again = await open({ database: directory });
      assert.equal(again.mode, "standalone");
      assert.deepEqual((await again.access.browse({ table: "users", filters: [{ column: "id", op: "gte", value: 24 }] })).rows.map((row) => [row[0], row[1]]), [[24, "user 24"], [26, "Ada"]]);
      assert.equal((await again.access.row({ table: "users", key: { id: 2 } })).row.name, "Bo");
      assert.deepEqual((await again.access.browse({ table: "notes" })).rows[0], ["by the console"]);
    });

    it("leaves the database as it was when a change is refused: a constraint, or a request that fails halfway", async () => {
      const session = await open({ database: directory });
      const before = await allFiles(directory);
      await refused(session.access.insert({ table: "users", values: { name: "user 01" } }), "CONSTRAINT", /UNIQUE constraint failed: users\.name/);
      await refused(session.access.delete({ table: "users", key: { id: 1 } }), "CONSTRAINT", /FOREIGN KEY constraint failed/);
      const halfway = await session.access.sql({ sql: "DELETE FROM notes; INSERT INTO users (name) VALUES ('user 01'); DELETE FROM memberships", mode: "write" });
      assert.deepEqual([halfway.results.map((each) => each.operation), halfway.error?.statement, halfway.error?.code, halfway.rolledBack], [["DELETE"], 2, "CONSTRAINT", true]);
      assert.equal((await session.access.browse({ table: "notes" })).total, 3);
      assert.deepEqual(await allFiles(directory), before);
    });

    it("keeps the changes in its memory when the database declares that it is never written to, and says that", async () => {
      const discarding = join(dirname(directory), "discarding.db");
      await createDatabase(discarding, { collections: DATA(), schema: SCHEMA, persistence: "memory" });
      const before = await allFiles(discarding);
      const session = await open({ database: discarding });
      assert.deepEqual([(await session.status()).info?.persistence, (await session.status()).info?.readOnly], ["memory", undefined]);
      await session.access.insert({ table: "notes", values: { text: "kept in memory" } });
      assert.equal((await session.access.browse({ table: "notes" })).total, 4);
      assert.deepEqual(await allFiles(discarding), before);
    });

    it("says that a sandbox is refused the database meanwhile, and how the database is handed over to one", async () => {
      // A Studio that only looks holds nothing that a sandbox would be refused, and says nothing of it.
      const looking = await open({ database: directory, readOnly: true });
      assert.deepEqual([looking.mode, looking.notices], ["standalone", []]);
      await looking.close();

      const session = await open({ database: directory });
      assert.deepEqual(session.notices, [
        "Studio has this database to itself. While it runs, a sandbox that is started on the database is refused: one process has a database open to write at a time. " +
          "To use the database with an application, stop Studio (Ctrl+C in its terminal), start the sandbox, and start Studio again. It then attaches to the sandbox, and both show the same rows.",
      ]);
      // It is part of how things are, so the page shows it as it shows every notice.
      assert.deepEqual((await session.status()).notices, session.notices);
      // A Studio that is attached has no database to hand over.
      const attached = await open({ database: directory });
      assert.deepEqual([attached.mode, attached.notices, (await attached.status()).notices], ["attached", [], []]);
      // Saying it lets go of nothing: the database is Studio's as before.
      assert.deepEqual([record().kind, record().instance], ["studio", (await session.status()).info?.instance]);
    });
  });

  describe("on a directory that another process has open", () => {
    it("looks into it through that process, and never opens it: there is one runtime, and one owner", async () => {
      const owner = await ownDatabase(directory, "postgrest");
      owners.push(owner);
      const session = await open({ database: directory });
      assert.deepEqual([session.mode, session.format], ["attached", "directory"]);
      const status = await session.status();
      assert.deepEqual([status.mode, status.connected, status.info?.kind, status.info?.pid, status.info?.instance, status.info?.readOnly], ["attached", true, "postgrest", owner.pid, owner.instance, undefined]);
      // What Studio changes, the application sees, and what the application changes, Studio sees.
      assert.deepEqual(await session.access.insert({ table: "notes", values: { text: "from Studio" } }), { affectedRows: 1 });
      assert.deepEqual(await owner.sql("SELECT text FROM notes ORDER BY rowid DESC LIMIT 1"), [{ text: "from Studio" }]);
      await owner.sql("UPDATE users SET name = 'from the application' WHERE id = 3");
      assert.equal((await session.access.row({ table: "users", key: { id: 3 } })).row.name, "from the application");
      // The database has the owner it had: Studio made no record, and is in none.
      assert.deepEqual([record().instance, record().kind, record().pid], [owner.instance, "postgrest", owner.pid]);
      await session.close();
      assert.equal(record().instance, owner.instance);
      assert.deepEqual(await owner.sql("SELECT COUNT(*) AS n FROM notes"), [{ n: 4 }]);
    });

    it("attaches to another Studio that has the directory to itself", async () => {
      const first = await open({ database: directory });
      const second = await open({ database: directory });
      assert.deepEqual([first.mode, second.mode], ["standalone", "attached"]);
      assert.equal((await second.status()).info?.instance, (await first.status()).info?.instance);
      await second.access.insert({ table: "notes", values: { text: "from the second" } });
      assert.equal((await first.access.browse({ table: "notes" })).total, 4);
      assert.equal((await storedRows(directory, "notes")).at(-1)?.text, "from the second");
      // The second leaves; the first has the database as before.
      await second.close();
      assert.equal(record().instance, (await first.status()).info?.instance);
      assert.equal((await first.access.browse({ table: "notes" })).total, 4);
    });

    it("is not connected while that process is gone, says why, and is connected again once another has the database", async () => {
      const first = await ownDatabase(directory, "nest");
      owners.push(first);
      const session = await open({ database: directory });
      await first.kill();
      const gone = await session.status();
      assert.deepEqual([gone.mode, gone.connected, gone.info], ["attached", false, undefined]);
      assert.match(gone.disconnected ?? "", /^The process that had the database open is gone/);
      await refused(session.access.insert({ table: "notes", values: { text: "x" } }), "OWNER_UNREACHABLE", /Nothing was sent, and nothing was done\.$/);
      // Attached, it stays attached: it does not take the database for itself while the sandbox is away.
      assert.equal(record().instance, first.instance);

      const second = await ownDatabase(directory, "nest");
      owners.push(second);
      const back = await session.status();
      assert.deepEqual([back.mode, back.connected, back.disconnected, back.info?.instance, back.info?.pid], ["attached", true, undefined, second.instance, second.pid]);
      assert.equal((await session.access.browse({ table: "users" })).total, 25);
    });

    it("waits for a sandbox that is still starting to say where it serves, and attaches to it then", async () => {
      // As a sandbox has its database between claiming it and serving its runtime: the record says who, and not yet where.
      const claim = await claimDatabase(directory, { kind: "nest" });
      let served: Awaited<ReturnType<typeof serveRuntime>> | undefined;
      let runtime: SqliteRuntime | undefined;
      try {
        // Not waited for long enough, Studio is told that the sandbox has not said where it serves.
        await assert.rejects(open({ database: directory, attachWaitMs: 100 }), (error: unknown) => error instanceof DatabaseOwnedError && /\nThat process has not said where it serves its runtime: it may still be starting\. Try again in a moment\.$/.test(error.message));
        const opening = open({ database: directory, attachWaitMs: 30_000 });
        await delay(400);
        const storage = openDatabaseStorage(directory);
        runtime = await SqliteRuntime.open({ schema: storage.schema ?? SCHEMA, storage, state: await storage.load(), persistence: "json" });
        served = await serveRuntime({ claim, runtime, format: "directory" });
        const session = await opening;
        assert.deepEqual([session.mode, (await session.status()).info?.instance, (await session.status()).info?.kind], ["attached", claim.record.instance, "nest"]);
        assert.equal((await session.access.browse({ table: "users" })).total, 25);
        await session.close();
      } finally {
        await served?.close();
        runtime?.close();
        claim.release();
      }
    });

    it("is refused the directory when that process serves no runtime to look into: it would be a second writer", async () => {
      // A REST sandbox, which runs on the JSON engine and has no runtime: its record says only that its process is there.
      const theirs: OwnerRecord = { version: 1, pid: process.pid, startedAt: "2026-01-02T03:04:05.000Z", instance: "0".repeat(48), kind: "rest", database: canonicalDatabasePath(directory) };
      writeFileSync(ownerRecordPath(directory), JSON.stringify(theirs));
      const before = await allFiles(directory);
      await assert.rejects(open({ database: directory, attachWaitMs: 200 }), (error: unknown) => {
        assert.ok(error instanceof DatabaseOwnedError, String(error));
        assert.match(
          error.message,
          new RegExp(
            `sandbox\\.db is open in the REST sandbox \\(pid ${process.pid}, since 2026-01-02T03:04:05\\.000Z\\)\\. One process has a database open to write at a time: stop that one first\\. If that process is gone, delete .*sandbox\\.db\\.owner\\.json\\.\\n` +
              "That process does not serve its runtime, so Studio cannot look into the database through it\\. With --read-only, Studio shows the database as it is stored\\.$",
          ),
        );
        return true;
      });
      assert.deepEqual(record(), theirs);
      assert.deepEqual(await allFiles(directory), before);
      // To look only, Studio opens what is stored, claims nothing, and says whose the database is.
      const looking = await open({ database: directory, readOnly: true, attachWaitMs: 200 });
      assert.equal(looking.mode, "standalone");
      assert.deepEqual(looking.notices, [`The REST sandbox (pid ${process.pid}, since 2026-01-02T03:04:05.000Z) has the database open. What is shown is the database as it was stored when Studio opened it.`]);
      assert.equal((await looking.access.browse({ table: "users" })).total, 25);
      await refused(looking.access.insert({ table: "notes", values: { text: "x" } }), "READ_ONLY", /^Studio was started with --read-only\.$/);
      assert.deepEqual(record(), theirs);
      assert.deepEqual(await allFiles(directory), before);
    });
  });

  describe("on a single file", () => {
    it("reads, and changes nothing: rows by page, one row, and statements that read", async () => {
      const [bytes, modified] = [await readFile(file), statSync(file).mtimeMs];
      const session = await open({ database: file });
      assert.deepEqual([session.mode, session.format], ["standalone", "file"]);
      const status = await session.status();
      assert.deepEqual([status.connected, status.format, status.info?.format, status.info?.kind, status.info?.readOnly, status.info?.tables], [true, "file", "file", "studio", SINGLE_FILE_READ_ONLY, 4]);
      assert.equal((await session.access.browse({ table: "users" })).total, 25);
      assert.deepEqual((await session.access.browse({ table: "users", orderBy: [{ column: "id", direction: "desc" }], filters: [{ column: "role", op: "eq", value: "admin" }], limit: 2 })).rows.map((row) => row[0]), [3, 2]);
      assert.equal((await session.access.row({ table: "users", key: { id: 1 } })).row.name, "user 01");
      assert.deepEqual((await session.access.sql({ sql: "SELECT COUNT(*) AS n FROM users WHERE active = 1", mode: "read" })).results[0]?.rows, [[13]]);

      const said = new RegExp(`^${SINGLE_FILE_READ_ONLY.replace(/[.:]/g, "\\$&")}$`);
      await refused(session.access.insert({ table: "notes", values: { text: "x" } }), "READ_ONLY", said);
      await refused(session.access.update({ table: "users", key: { id: 1 }, values: { name: "x" } }), "READ_ONLY", said);
      await refused(session.access.delete({ table: "users", key: { id: 25 } }), "READ_ONLY", said);
      await refused(session.access.sql({ sql: "DELETE FROM notes", mode: "write" }), "READ_ONLY", said);
      for (const statement of ["DELETE FROM notes", "INSERT INTO notes (text) VALUES ('x')", "UPDATE users SET name = 'x'", "WITH gone AS (SELECT 1) DELETE FROM notes"]) {
        const tried = await session.access.sql({ sql: statement, mode: "read" });
        assert.deepEqual([tried.results, tried.error?.code], [[], "READ_ONLY"], statement);
      }
      assert.equal((await session.access.browse({ table: "notes" })).total, 3);
      await session.close();

      // The file is the file it was: not converted, not written again, and no one's.
      assert.deepEqual([await readFile(file), statSync(file).mtimeMs], [bytes, modified]);
      assert.deepEqual(beside(), ["sandbox.db", "sandbox.db.json"]);
    });

    it("looks into the file's rows through the process that has it open, when one has, and still changes nothing", async () => {
      const owner = await ownDatabase(file, "nest");
      owners.push(owner);
      const session = await open({ database: file });
      assert.equal(session.mode, "attached");
      const status = await session.status();
      assert.deepEqual([status.connected, status.info?.kind, status.info?.format, status.info?.readOnly], [true, "nest", "file", SINGLE_FILE_READ_ONLY]);
      // What the application has now, not what the file had when it was read.
      await owner.sql("UPDATE users SET name = 'by the application' WHERE id = 1");
      assert.equal((await session.access.row({ table: "users", key: { id: 1 } })).row.name, "by the application");
      await refused(session.access.insert({ table: "notes", values: { text: "x" } }), "READ_ONLY");
      await refused(session.access.sql({ sql: "DELETE FROM notes", mode: "write" }), "READ_ONLY");
      assert.deepEqual(await owner.sql("SELECT COUNT(*) AS n FROM notes"), [{ n: 3 }]);
    });
  });

  describe("started to look only", () => {
    it("opens a directory without claiming it, and changes nothing of it", async () => {
      const before = await allFiles(directory);
      const session = await open({ database: directory, readOnly: true });
      assert.deepEqual([session.mode, (await session.status()).info?.readOnly], ["standalone", "Studio was started with --read-only."]);
      assert.equal((await session.access.browse({ table: "users" })).total, 25);
      await refused(session.access.delete({ table: "users", key: { id: 25 } }), "READ_ONLY", /^Studio was started with --read-only\.$/);
      await refused(session.access.sql({ sql: "DELETE FROM notes", mode: "write" }), "READ_ONLY");
      assert.equal((await session.access.sql({ sql: "DELETE FROM notes", mode: "read" })).error?.code, "READ_ONLY");
      assert.deepEqual(beside(), ["sandbox.db", "sandbox.db.json"]);
      assert.deepEqual(await allFiles(directory), before);
    });

    it("changes nothing through the process that has the directory open, which goes on changing it itself", async () => {
      const owner = await ownDatabase(directory);
      owners.push(owner);
      const session = await open({ database: directory, readOnly: true });
      assert.equal(session.mode, "attached");
      assert.equal((await session.status()).info?.readOnly, "Studio was started with --read-only.");
      await refused(session.access.insert({ table: "notes", values: { text: "x" } }), "READ_ONLY", /^Studio was started with --read-only\.$/);
      await refused(session.access.sql({ sql: "DELETE FROM notes", mode: "write" }), "READ_ONLY");
      await owner.sql("INSERT INTO notes (text) VALUES ('the application''s')");
      assert.equal((await session.access.browse({ table: "notes" })).total, 4);
    });
  });

  describe("what it does not open", () => {
    it("is a database that is not there", async () => {
      await assert.rejects(open({ database: join(root, "nowhere.db") }), /Database not found: .*nowhere\.db$/);
      await assert.rejects(open({ database: join(root, "nowhere.db.json") }), /Database not found: .*nowhere\.db\.json$/);
      assert.equal(existsSync(join(root, "nowhere.db.owner.json")), false);
    });

    it("is, to change it, a directory of a format this build does not write: it is read as it is, and Studio says what to do", async () => {
      const old = join(dirname(directory), "format-4.db");
      await cp(join(FORMATS, "directory-format-4"), old, { recursive: true });
      const before = await allFiles(old);
      const session = await open({ database: old });
      assert.equal(session.mode, "standalone");
      const { readOnly } = (await session.status()).info ?? {};
      assert.match(readOnly ?? "", /format-4\.db has database format 4; this build writes format 5\. It is read as it is and not changed\. To bring it up to date: local-db-sandbox migrate .*format-4\.db$/);
      assert.deepEqual(session.notices, [readOnly]);
      assert.ok((await session.access.schema()).tables.length > 0);
      await refused(session.access.sql({ sql: "DELETE FROM users", mode: "write" }), "READ_ONLY", /has database format 4/);
      await session.close();
      // Not migrated, not claimed, not touched.
      assert.deepEqual(await allFiles(old), before);
      assert.equal(existsSync(ownerRecordPath(old)), false);
    });
  });
});
