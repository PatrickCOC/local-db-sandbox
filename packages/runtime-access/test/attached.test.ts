import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { canonicalDatabasePath, createDatabase, ownerRecordPath } from "../../storage-json/src/index.ts";
import type { OwnerRecord } from "../../storage-json/src/index.ts";
import { allFiles, storedRows } from "../../storage-json/test/support/database-files.ts";
import { AttachedRuntimeAccess, DEFAULT_ACCESS_LIMITS } from "../src/index.ts";
import { refused } from "./support/assertions.ts";
import { DATA, SCHEMA } from "./support/fixture.ts";
import { ownDatabase } from "./support/owner-process.ts";
import type { OwnerProcess } from "./support/owner-process.ts";

/*
 * Access to a database that another process has open (D-042). Whoever has
 * it does not open the database: it finds the process by the record next to
 * the database, asks that process, and finds the process that takes its
 * place after a restart. The owners here are real processes
 * (support/own-database.ts), ended the way a sandbox ends: stopped, or
 * killed.
 */

interface FakeOwner {
  url: string;
  record: OwnerRecord;
  close(): Promise<void>;
}

describe("access to a database that another process has open", { timeout: 180_000 }, () => {
  let root: string;
  let database: string;
  const owners: OwnerProcess[] = [];
  const closing: { close(): Promise<void> }[] = [];
  const own = async (kind?: string): Promise<OwnerProcess> => {
    const owner = await ownDatabase(database, kind);
    owners.push(owner);
    return owner;
  };
  const record = (): OwnerRecord => JSON.parse(readFileSync(ownerRecordPath(database), "utf8"));
  const beside = (): string[] => readdirSync(dirname(database)).sort();
  /** A record as a process would have left it. This process is its owner, so the owner's process runs. */
  const leave = (fields: Partial<OwnerRecord>): OwnerRecord => {
    const left: OwnerRecord = { version: 1, pid: process.pid, startedAt: "2026-01-02T03:04:05.000Z", instance: "a".repeat(48), kind: "nest", database: canonicalDatabasePath(database), ...fields };
    writeFileSync(ownerRecordPath(database), `${JSON.stringify(left, null, 2)}\n`);
    return left;
  };
  /**
   * Something that answers where an owner would, and says of itself what it is told to. `onAccess` may answer an
   * operation itself (and returns true); what it leaves is answered as an owner that has nothing would.
   */
  const fakeOwner = async (says: { instance?: string; database?: string }, onAccess: (operation: string, response: ServerResponse) => boolean = () => false): Promise<FakeOwner> => {
    const instance = says.instance ?? "a".repeat(48);
    const server = createServer((request, response) => {
      const send = (body: unknown): void => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      request.resume();
      request.on("end", () => {
        if (request.url === "/health") {
          send({ protocol: 1, instance });
          return;
        }
        const operation = (request.url ?? "").replace("/access/", "");
        if (onAccess(operation, response)) {
          return;
        }
        send({ result: operation === "info" ? { protocol: 1, instance, pid: process.pid, kind: "nest", database: says.database ?? canonicalDatabasePath(database), format: "directory", persistence: "json", tables: 0, limits: DEFAULT_ACCESS_LIMITS } : {} });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fake: FakeOwner = {
      url,
      record: leave({ instance: "a".repeat(48), control: { url, token: "t".repeat(48) } }),
      close: () =>
        new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
    closing.push(fake);
    return fake;
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-attached-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    database = join(root, `db-${Math.random().toString(16).slice(2)}`, "sandbox.db");
    await createDatabase(database, { collections: DATA(), schema: SCHEMA });
  });
  afterEach(async () => {
    for (const owner of owners.splice(0)) {
      await owner.kill();
    }
    for (const each of closing.splice(0)) {
      await each.close();
    }
  });

  describe("the owner", () => {
    it("is found by the record next to the database, whatever path leads to the database, and is asked", async () => {
      const owner = await own("postgrest");
      const attached = new AttachedRuntimeAccess({ database });
      assert.equal(attached.database, canonicalDatabasePath(database));
      // Not looked for yet.
      assert.equal(attached.owner, undefined);
      assert.equal(await attached.check(), true);
      assert.deepEqual(attached.owner, { instance: owner.instance, pid: owner.pid, kind: "postgrest", startedAt: owner.startedAt });
      assert.equal(attached.disconnected, undefined);
      const info = await attached.info();
      assert.deepEqual([info.instance, info.pid, info.kind, info.database, info.format, info.persistence, info.tables], [owner.instance, owner.pid, "postgrest", canonicalDatabasePath(database), "directory", "json", 4]);
      assert.equal((await attached.browse({ table: "users" })).total, 25);
      assert.equal((await attached.schema()).tables.length, 4);

      const dotted = new AttachedRuntimeAccess({ database: join(dirname(database), "..", dirname(database).split(/[\\/]/).at(-1) as string, "sandbox.db") });
      assert.equal(await dotted.check(), true);
      assert.equal(dotted.owner?.instance, owner.instance);
    });

    it("has the one runtime there is: what is changed through the access the owner sees, and what the owner changes the access sees", async () => {
      const owner = await own();
      const attached = new AttachedRuntimeAccess({ database });
      await attached.check();
      assert.deepEqual(await attached.insert({ table: "notes", values: { text: "through the access" } }), { affectedRows: 1 });
      assert.deepEqual(await owner.sql("SELECT text FROM notes ORDER BY rowid DESC LIMIT 1"), [{ text: "through the access" }]);
      await owner.sql("UPDATE users SET name = 'by the owner' WHERE id = 1");
      assert.equal((await attached.row({ table: "users", key: { id: 1 } })).row.name, "by the owner");
      const result = await attached.sql({ sql: "UPDATE users SET score = 0 WHERE id = 2; SELECT name, score FROM users WHERE id <= 2 ORDER BY id", mode: "write" });
      assert.deepEqual(result.results.at(-1)?.rows, [["by the owner", 1.5], ["user 02", 0]]);
      assert.deepEqual(await owner.sql("SELECT score FROM users WHERE id = 2"), [{ score: 0 }]);
      assert.deepEqual(await attached.delete({ table: "users", key: { id: 25 } }), { affectedRows: 1 });
      assert.deepEqual(await owner.sql("SELECT COUNT(*) AS n FROM users"), [{ n: 24 }]);
      // It is the owner that wrote all of it to the database, and no one else has the database.
      assert.equal((await storedRows(database, "users")).length, 24);
      assert.equal((await storedRows(database, "notes")).at(-1)?.text, "through the access");
      assert.equal(record().instance, owner.instance);
      // What both did is in the one list of what the runtime carried out.
      const said = (await attached.events()).events.map((event) => event.requestId);
      assert.ok(said.includes("application") && said.includes("studio"), JSON.stringify(said));
    });

    it("is told that the runtime is busy while the owner has a transaction open, and stays attached", async () => {
      const owner = await own();
      const attached = new AttachedRuntimeAccess({ database });
      await attached.check();
      await owner.begin();
      await refused(attached.browse({ table: "users" }), "BUSY", /^The application has a transaction open on the runtime\. Nothing was done; try again\.$/);
      await refused(attached.insert({ table: "notes", values: { text: "x" } }), "BUSY");
      assert.equal(attached.owner?.instance, owner.instance);
      await owner.rollback();
      assert.equal((await attached.browse({ table: "notes" })).total, 3);
    });
  });

  describe("while no process has the database open", () => {
    it("is not attached, says why, and does nothing; it never opens the database itself", async () => {
      const before = await allFiles(database);
      const attached = new AttachedRuntimeAccess({ database });
      assert.equal(await attached.check(), false);
      assert.equal(attached.owner, undefined);
      assert.equal(attached.disconnected, "No process has the database open.");
      for (const read of [() => attached.info(), () => attached.schema(), () => attached.browse({ table: "users" }), () => attached.row({ table: "users", key: { id: 1 } }), () => attached.sql({ sql: "SELECT 1", mode: "read" }), () => attached.events()]) {
        await refused(read(), "OWNER_UNREACHABLE", /^No process has the database open\.$/);
      }
      for (const write of [
        () => attached.insert({ table: "notes", values: { text: "x" } }),
        () => attached.update({ table: "users", key: { id: 1 }, values: { name: "x" } }),
        () => attached.delete({ table: "users", key: { id: 25 } }),
        () => attached.sql({ sql: "DELETE FROM notes", mode: "write" }),
      ]) {
        await refused(write(), "OWNER_UNREACHABLE", /^No process has the database open\. Nothing was sent, and nothing was done\.$/);
      }
      // No record was made, and the database is as it was: this is never a writer.
      assert.deepEqual(beside(), ["sandbox.db"]);
      assert.deepEqual(await allFiles(database), before);
    });

    it("says what is in the way when there is a record and no owner to ask", async () => {
      const attached = new AttachedRuntimeAccess({ database });
      // A process that has the database and serves no runtime: a REST sandbox, or one that is still starting.
      leave({ kind: "rest" });
      assert.equal(await attached.check(), false);
      assert.equal(attached.disconnected, `The REST sandbox (pid ${process.pid}, since 2026-01-02T03:04:05.000Z) has the database open, and does not serve its runtime.`);
      // A record that was left behind by a process that is gone.
      rmSync(ownerRecordPath(database));
      const gone = await own();
      await gone.kill();
      assert.equal(await attached.check(), false);
      assert.match(attached.disconnected ?? "", new RegExp(`^The process that had the database open is gone \\(its process \\(pid ${gone.pid}\\) is gone\\)\\.$`));
      await refused(attached.browse({ table: "users" }), "OWNER_UNREACHABLE", /is gone/);
    });
  });

  describe("after the owner was replaced by another", () => {
    it("finds the one that has the database now, and what the first one saved is there", async () => {
      const first = await own("nest");
      const attached = new AttachedRuntimeAccess({ database });
      await attached.check();
      await attached.insert({ table: "notes", values: { text: "before the restart" } });
      // Killed, as a watcher ends the sandbox it replaces: nothing takes its record away.
      await first.kill();
      assert.equal(record().instance, first.instance);
      assert.equal(await attached.check(), false);
      assert.equal(attached.owner, undefined);
      assert.match(attached.disconnected ?? "", /is gone/);
      await refused(attached.browse({ table: "notes" }), "OWNER_UNREACHABLE");

      const second = await own("nest");
      assert.notEqual(second.instance, first.instance);
      assert.equal(await attached.check(), true);
      assert.deepEqual(attached.owner, { instance: second.instance, pid: second.pid, kind: "nest", startedAt: second.startedAt });
      assert.equal((await attached.info()).instance, second.instance);
      assert.deepEqual((await attached.browse({ table: "notes" })).rows.at(-1), ["before the restart"]);
      // And it is that one that carries out what is asked now.
      await attached.insert({ table: "notes", values: { text: "after the restart" } });
      assert.deepEqual(await second.sql("SELECT COUNT(*) AS n FROM notes"), [{ n: 5 }]);
    });

    it("asks a request that changes nothing of the new owner by itself, when it finds the old one gone", async () => {
      const first = await own();
      const attached = new AttachedRuntimeAccess({ database });
      await attached.check();
      await first.stop();
      assert.deepEqual(beside(), ["sandbox.db"]);
      const second = await own();
      // Not told to look: the request finds the first one gone, and is asked again where the database is open now.
      assert.equal((await attached.browse({ table: "users" })).total, 25);
      assert.equal(attached.owner?.instance, second.instance);
      assert.equal((await attached.sql({ sql: "SELECT COUNT(*) AS n FROM notes", mode: "read" })).results[0]?.rows[0]?.[0], 3);
    });

    it("does not look for another owner in order to send a change: nothing of it reaches the one that came next", async () => {
      const first = await own();
      const attached = new AttachedRuntimeAccess({ database });
      await attached.check();
      await first.kill();
      const second = await own();
      // The change was for the first, which is gone. Another process has the database by now.
      await refused(attached.insert({ table: "notes", values: { text: "for the first" } }), "OWNER_UNREACHABLE", /Nothing was sent, and nothing was done\.$/);
      await refused(attached.sql({ sql: "DELETE FROM notes", mode: "write" }), "OWNER_UNREACHABLE", /Nothing was sent, and nothing was done\.$/);
      await refused(attached.delete({ table: "users", key: { id: 25 } }), "OWNER_UNREACHABLE", /Nothing was sent, and nothing was done\.$/);
      assert.deepEqual(await second.sql("SELECT (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM users) AS users"), [{ notes: 3, users: 25 }]);
      // Once the new owner is found, a change that was made for the old one is refused by name...
      assert.equal(await attached.check(), true);
      await refused(attached.delete({ table: "users", key: { id: 25 } }, { owner: first.instance }), "OWNER_CHANGED", /^The database is open in another process than the one this was asked of\. Nothing was done\./);
      await refused(attached.sql({ sql: "DELETE FROM notes", mode: "write" }, { owner: first.instance }), "OWNER_CHANGED");
      assert.deepEqual(await second.sql("SELECT (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM users) AS users"), [{ notes: 3, users: 25 }]);
      assert.equal(attached.owner?.instance, second.instance);
      // ...and one that is made for the new one is carried out there.
      assert.deepEqual(await attached.delete({ table: "users", key: { id: 25 } }, { owner: second.instance }), { affectedRows: 1 });
      assert.deepEqual(await second.sql("SELECT COUNT(*) AS n FROM users"), [{ n: 24 }]);
    });

    it("sends a change once: when no answer came, it says that the outcome is not known, and no owner is sent it again", async () => {
      const asked: string[] = [];
      // An owner that takes a change and ends the connection without a word, as one that is killed at that moment.
      const fake = await fakeOwner({}, (operation, response) => {
        asked.push(operation);
        if (operation === "insert") {
          response.destroy();
          return true;
        }
        return false;
      });
      const attached = new AttachedRuntimeAccess({ database });
      assert.equal(await attached.check(), true);
      await refused(attached.insert({ table: "notes", values: { text: "once" } }), "OUTCOME_UNKNOWN", /whether it was carried out is not known\. Look at the data before doing it again\.$/);
      assert.deepEqual(asked.filter((operation) => operation === "insert"), ["insert"]);
      // What became of that owner is not known either: the access is attached to no one.
      const attachedTo = (): string | undefined => attached.owner?.instance;
      assert.equal(attachedTo(), undefined);
      assert.match(attached.disconnected ?? "", /whether it was carried out is not known/);

      await fake.close();
      const real = await own();
      assert.equal(await attached.check(), true);
      assert.equal(attachedTo(), real.instance);
      // The owner that came next was sent nothing of it, and the one before was not asked a second time.
      assert.deepEqual(await real.sql("SELECT COUNT(*) AS n FROM notes"), [{ n: 3 }]);
      assert.deepEqual(asked.filter((operation) => operation === "insert"), ["insert"]);
    });
  });

  describe("what answers in an owner's place", () => {
    it("is not attached to when its record is of another database", async () => {
      const elsewhere = join(root, "elsewhere", "sandbox.db");
      const fake = await fakeOwner({ database: canonicalDatabasePath(elsewhere) });
      leave({ ...fake.record, database: canonicalDatabasePath(elsewhere) });
      const attached = new AttachedRuntimeAccess({ database });
      assert.equal(await attached.check(), false);
      assert.match(attached.disconnected ?? "", /^The record next to the database is of another database \(.*elsewhere.*sandbox\.db\)\.$/);
    });

    it("is not attached to when it says that it has another database open, or is another owner than the record's", async () => {
      const attached = new AttachedRuntimeAccess({ database });
      const other = await fakeOwner({ database: canonicalDatabasePath(join(root, "elsewhere", "sandbox.db")) });
      assert.equal(await attached.check(), false);
      assert.equal(attached.disconnected, `What answers at ${other.url} is not the owner of this database.`);
      await other.close();
      // The record's owner answers the question whether it is there, and then says that it is someone else.
      let asked = 0;
      const twoFaced = await fakeOwner({}, (operation, response) => {
        asked += 1;
        if (operation !== "info") {
          return false;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ result: { protocol: 1, instance: "b".repeat(48), pid: 1, kind: "nest", database: canonicalDatabasePath(database), format: "directory", persistence: "json", tables: 0, limits: DEFAULT_ACCESS_LIMITS } }));
        return true;
      });
      assert.equal(await attached.check(), false);
      assert.equal(attached.disconnected, `What answers at ${twoFaced.url} is not the owner of this database.`);
      // Nothing was asked of it but who it is.
      await refused(attached.insert({ table: "notes", values: { text: "x" } }), "OWNER_UNREACHABLE");
      await refused(attached.browse({ table: "notes" }), "OWNER_UNREACHABLE");
      assert.ok(asked > 0);
    });

    it("is sent nothing when the record names an address that is not this machine's own", async () => {
      let reached = 0;
      const elsewhere = await fakeOwner({}, () => ((reached += 1), false));
      // The storage takes such a record for one that was left behind, and asks nothing where it points (see its own tests).
      // Told that the owner is there all the same, the access still sends nothing.
      const left = leave({ ...elsewhere.record, control: { url: elsewhere.url.replace("127.0.0.1", "localhost"), token: "t".repeat(48) } });
      const attached = new AttachedRuntimeAccess({ database, inspect: async () => ({ state: "live", record: left, responsive: true }) });
      assert.equal(await attached.check(), false);
      assert.match(attached.disconnected ?? "", /^The owner's record names an address that is not this machine's own \(http:\/\/localhost:\d+\): nothing is sent there\.$/);
      await refused(attached.browse({ table: "users" }), "OWNER_UNREACHABLE", /nothing is sent there/);
      assert.equal(reached, 0);
    });
  });
});
