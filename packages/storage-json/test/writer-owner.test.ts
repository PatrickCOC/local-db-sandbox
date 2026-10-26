import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { inspect } from "node:util";
import { DatabaseOwnedError, JsonStorageError, canonicalDatabasePath, claimDatabase, claimDatabaseIfThere, createDatabase, inspectOwner, ownerRecordPath } from "../src/index.ts";
import type { DatabaseClaim, OwnerProbe, OwnerRecord } from "../src/index.ts";
import { allFiles } from "./support/database-files.ts";

/*
 * One process has a database open to write at a time (D-042). It says so in
 * a record next to the database, which whoever wants to write looks at
 * first. These tests are about that record: who gets it, who does not, when
 * one that was left behind is taken over, and that a live owner's is never
 * taken.
 */

const HOLDER = join(import.meta.dirname, "support", "hold-owner.ts");

interface Held {
  child: ChildProcess;
  /** What the process said: whether it got the database. */
  said: Promise<{ claimed: boolean; owned?: boolean; message?: string; instance?: string; pid?: number }>;
  exited: Promise<void>;
}

/** Another process that claims the database, and holds it if it gets it. */
function hold(database: string, kind = "studio", startAt?: number): Held {
  const child = spawn(process.execPath, [HOLDER, database, kind, ...(startAt === undefined ? [] : [String(startAt)])], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const said = new Promise<Awaited<Held["said"]>>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (line !== undefined) {
        resolve(JSON.parse(line));
      }
    });
    void exited.then(() => reject(new Error(`the process ended without saying anything:\n${output}${errors}`)));
  });
  // Not a failure of a test when the process has ended and nobody waits for what it said.
  said.catch(() => undefined);
  return { child, said, exited };
}

/** A pid that no process has: of a process that has ended. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

const never: OwnerProbe = async () => assert.fail("the owner was asked whether it answers, though its process is gone");

describe("the owner of a database: one process has it open to write", () => {
  let root: string;
  let database: string;
  const claims: DatabaseClaim[] = [];
  const held: Held[] = [];
  const record = (): OwnerRecord => JSON.parse(readFileSync(ownerRecordPath(database), "utf8"));
  const claim = async (...args: Parameters<typeof claimDatabase>): Promise<DatabaseClaim> => {
    const made = await claimDatabase(...args);
    claims.push(made);
    return made;
  };
  /** A record as another process would have left it. */
  const leave = (fields: Partial<OwnerRecord>, at: string = database): OwnerRecord => {
    const left: OwnerRecord = { version: 1, pid: process.pid, startedAt: "2026-01-02T03:04:05.000Z", instance: "0".repeat(48), kind: "postgrest", database: canonicalDatabasePath(at), ...fields };
    writeFileSync(ownerRecordPath(at), `${JSON.stringify(left, null, 2)}\n`);
    return left;
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-owner-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    database = join(root, `db-${Math.random().toString(16).slice(2)}`, "sandbox.db");
    await createDatabase(database, { collections: { users: [{ id: 1, name: "Ada" }] } });
  });
  afterEach(async () => {
    claims.splice(0).forEach((made) => made.release());
    for (const other of held.splice(0)) {
      other.child.kill();
      await other.exited;
    }
  });

  describe("the record", () => {
    it("is a file next to the database, named after it, and nothing inside the database", async () => {
      const before = await allFiles(database);
      const made = await claim(database, { kind: "studio" });
      assert.equal(ownerRecordPath(database), `${canonicalDatabasePath(database)}.owner.json`);
      assert.equal(dirname(ownerRecordPath(database)), dirname(canonicalDatabasePath(database)));
      assert.deepEqual(readdirSync(dirname(database)).sort(), ["sandbox.db", "sandbox.db.owner.json"]);
      // The database is as it was: its format has no part in this.
      assert.deepEqual(await allFiles(database), before);
      made.release();
      assert.deepEqual(readdirSync(dirname(database)), ["sandbox.db"]);
    });

    it("says who has the database: the process, since when, what it is, and a name for this one time it was claimed", async () => {
      const started = Date.now();
      const made = await claim(database, { kind: "postgrest", persistence: "json" });
      const { startedAt, instance, ...rest } = record();
      assert.deepEqual(rest, { version: 1, pid: process.pid, kind: "postgrest", database: canonicalDatabasePath(database), persistence: "json" });
      assert.ok(Date.parse(startedAt) >= started - 1000 && Date.parse(startedAt) <= Date.now() + 1000, startedAt);
      assert.match(instance, /^[0-9a-f]{48}$/);
      assert.deepEqual(made.record, record());
      // Another claim, later, is another one.
      made.release();
      assert.notEqual((await claim(database, { kind: "postgrest" })).record.instance, instance);
    });

    it("is of the database whatever path leads to it: through a link, with dots, in other letters where the file system takes those for the same", async () => {
      const link = join(dirname(database), "linked.db");
      symlinkSync(database, link, "junction");
      const dotted = join(dirname(database), "..", basename(dirname(database)), "sandbox.db");
      assert.equal(canonicalDatabasePath(link), canonicalDatabasePath(database));
      assert.equal(ownerRecordPath(dotted), ownerRecordPath(database));
      await claim(database, { kind: "studio" });
      await assert.rejects(claimDatabase(link, { kind: "rest" }), DatabaseOwnedError);
      await assert.rejects(claimDatabase(dotted, { kind: "rest" }), DatabaseOwnedError);
      if (process.platform === "win32") {
        assert.equal(canonicalDatabasePath(database.toUpperCase()), canonicalDatabasePath(database));
        await assert.rejects(claimDatabase(database.toUpperCase(), { kind: "rest" }), DatabaseOwnedError);
      }
    });

    it("is next to a single-file database too", async () => {
      const file = join(dirname(database), "sandbox.db.json");
      await createDatabase(file, { collections: { users: [] } });
      await claim(file, { kind: "rest" });
      assert.ok(existsSync(`${canonicalDatabasePath(file)}.owner.json`));
      // And is the file's own: the directory beside it is another database.
      (await claim(database, { kind: "rest" })).release();
    });

    it("is not made for a database that is not there", async () => {
      await assert.rejects(claimDatabase(join(root, "nowhere", "sandbox.db"), { kind: "studio" }), (error: unknown) => error instanceof JsonStorageError && /Database not found/.test(error.message));
      // Whoever is about to open a database, and says in its own words when one is missing, claims it only when it is there.
      assert.equal(await claimDatabaseIfThere(join(root, "nowhere", "sandbox.db"), { kind: "studio" }), undefined);
      assert.equal(await claimDatabaseIfThere(join(dirname(database), "missing.json"), { kind: "rest" }), undefined);
      assert.deepEqual(readdirSync(dirname(database)), ["sandbox.db"]);
      const made = await claimDatabaseIfThere(database, { kind: "rest" });
      claims.push(made as DatabaseClaim);
      assert.equal(record().instance, made?.record.instance);
    });
  });

  describe("a second writer", () => {
    it("is refused while the first has the database, and is told who has it", async () => {
      const first = await claim(database, { kind: "postgrest" });
      await assert.rejects(claimDatabase(database, { kind: "studio" }), (error: unknown) => {
        assert.ok(error instanceof DatabaseOwnedError, String(error));
        assert.deepEqual(error.owner, first.record);
        assert.equal(error.recordPath, ownerRecordPath(database));
        assert.match(error.message, new RegExp(`sandbox\\.db is open in the PostgREST endpoint \\(pid ${process.pid}, since ${first.record.startedAt.replaceAll(".", "\\.")}\\)\\. One process has a database open to write at a time: stop that one first\\.`));
        return true;
      });
      // The first has it as before.
      assert.deepEqual(record(), first.record);
    });

    it("gets the database once the first has let go of it", async () => {
      const first = await claim(database, { kind: "postgrest" });
      first.release();
      assert.equal(existsSync(ownerRecordPath(database)), false);
      const second = await claim(database, { kind: "studio" });
      assert.equal(record().kind, "studio");
      // Letting go a second time takes nothing from whoever has it now.
      first.release();
      assert.deepEqual(record(), second.record);
    });

    it("of another process is refused, and the owner keeps the database", async () => {
      const other = hold(database, "nest");
      held.push(other);
      const owner = await other.said;
      assert.equal(owner.claimed, true);
      await assert.rejects(claimDatabase(database, { kind: "studio" }), (error: unknown) => error instanceof DatabaseOwnedError && error.owner?.pid === owner.pid && /is open in the NestJS sandbox/.test(error.message));
      assert.equal(record().instance, owner.instance);
      // When the owner lets go, the database is free.
      other.child.stdin?.write("release\n");
      await other.exited;
      assert.equal(existsSync(ownerRecordPath(database)), false);
      await claim(database, { kind: "studio" });
    });

    it("is one of several that ask at the same moment: one of them gets the database, and no more", async () => {
      const startAt = Date.now() + 1500;
      const all = Array.from({ length: 6 }, () => hold(database, "studio", startAt));
      held.push(...all);
      const said = await Promise.all(all.map((each) => each.said));
      assert.equal(said.filter((each) => each.claimed).length, 1, JSON.stringify(said));
      assert.ok(said.filter((each) => !each.claimed).every((each) => each.owned === true), JSON.stringify(said));
      assert.equal(record().instance, said.find((each) => each.claimed)?.instance);
    });
  });

  describe("a record that was left behind", () => {
    it("by a process that is gone is taken over: a crash does not lock a database", async () => {
      const other = hold(database, "nest");
      held.push(other);
      const owner = await other.said;
      other.child.kill("SIGKILL");
      await other.exited;
      // Nothing took the record away: the process had no chance to.
      assert.equal(record().instance, owner.instance);
      assert.deepEqual(await inspectOwner(database), { state: "stale", record: record(), reason: `its process (pid ${owner.pid}) is gone` });
      const mine = await claim(database, { kind: "studio" }, { probe: never });
      assert.equal(record().instance, mine.record.instance);
      assert.equal(record().pid, process.pid);
    });

    it("by a process whose number another process has by now is taken over when nothing answers where the owner served", async () => {
      // The process is running (it is this one), and says where it serves: nothing listens there.
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      await new Promise((resolve) => server.close(resolve));
      const left = leave({ control: { url: `http://127.0.0.1:${port}`, token: "t".repeat(48) } });
      assert.deepEqual(await inspectOwner(database), { state: "stale", record: left, reason: `its process number (${process.pid}) is another process's by now: nothing listens where the owner served` });
      await claim(database, { kind: "studio" });
      assert.equal(record().kind, "studio");
    });

    it("is not taken over while its owner answers, and not while its owner is only slow to answer", async () => {
      const asked: string[] = [];
      for (const answer of ["alive", "unresponsive"] as const) {
        const left = leave({ control: { url: "http://127.0.0.1:1", token: "t".repeat(48) } });
        const probe: OwnerProbe = async (owner) => {
          asked.push(owner.instance);
          return answer;
        };
        assert.deepEqual(await inspectOwner(database, { probe }), { state: "live", record: left, responsive: answer === "alive" });
        await assert.rejects(claimDatabase(database, { kind: "studio" }, { probe }), DatabaseOwnedError);
        assert.deepEqual(record(), left);
      }
      assert.equal(asked.length, 4);
    });

    it("of an owner that does not serve is the owner's for as long as its process runs", async () => {
      // A plain REST sandbox, or one that is still starting: there is nowhere to ask, and its process is there.
      const left = leave({ kind: "rest" });
      assert.deepEqual(await inspectOwner(database, { probe: never }), { state: "live", record: left, responsive: true });
      await assert.rejects(claimDatabase(database, { kind: "studio" }, { probe: never }), (error: unknown) => {
        assert.ok(error instanceof DatabaseOwnedError);
        // Nothing can tell such a process from another that got its number: the way out is said.
        assert.match(error.message, new RegExp(`is open in the REST sandbox \\(pid ${process.pid}, since 2026-01-02T03:04:05\\.000Z\\)\\. One process has a database open to write at a time: stop that one first\\. If that process is gone, delete .*sandbox\\.db\\.owner\\.json\\.$`));
        return true;
      });
    });

    it("that the default way of asking finds answered by its owner is live, by another owner or by nothing is stale", async () => {
      let answer: { status: number; body: unknown } = { status: 200, body: {} };
      const seen: (string | undefined)[] = [];
      const server = createServer((request, response) => {
        seen.push(`${request.method} ${request.url} ${request.headers.authorization}`);
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const left = leave({ control: { url, token: "secret-token" } });
        answer = { status: 200, body: { instance: left.instance } };
        assert.deepEqual(await inspectOwner(database), { state: "live", record: left, responsive: true });
        assert.deepEqual(seen, ["GET /health Bearer secret-token"]);
        // Whoever answers there is not the owner of the record: another run, or something that does not know the token.
        answer = { status: 200, body: { instance: "f".repeat(48) } };
        assert.equal((await inspectOwner(database)).state, "stale");
        answer = { status: 401, body: { error: "no" } };
        assert.deepEqual(await inspectOwner(database), { state: "stale", record: left, reason: `its process number (${process.pid}) is another process's by now: what answers where the owner served is not the owner` });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("of an owner that has just stopped serving is stale at once, also to whoever asked that owner before", async () => {
      // Whoever asks an owner again and again (Studio does) must not be told that it is only slow when it is gone:
      // a connection that was kept from the last time it was asked ends otherwise than one that is refused.
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ instance: "0".repeat(48) }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const left = leave({ control: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "secret-token" } });
      for (let asked = 0; asked < 3; asked += 1) {
        assert.equal((await inspectOwner(database)).state, "live");
      }
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      assert.deepEqual(await inspectOwner(database), { state: "stale", record: left, reason: `its process number (${process.pid}) is another process's by now: nothing listens where the owner served` });
    });

    it("that names an address which is not this machine's own is asked nothing there: no owner serves anywhere else", async () => {
      // A record is a file that anyone who can write beside the database can write. Where it points is not asked
      // unless it is where an owner serves: this machine's own address.
      const asked: string[] = [];
      const server = createServer((request, response) => {
        asked.push(`${request.method} ${request.url}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ instance: "0".repeat(48) }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = server.address() as AddressInfo;
        for (const url of [`http://localhost:${port}`, `http://127.0.0.1:${port}/elsewhere`, `http://127.0.0.1.example.com:${port}`, `https://127.0.0.1:${port}`, "http://192.168.1.20:4000", "file:///etc/passwd"]) {
          const left = leave({ control: { url, token: "secret-token" } });
          assert.deepEqual(await inspectOwner(database), { state: "stale", record: left, reason: `its process number (${process.pid}) is another process's by now: what answers where the owner served is not the owner` }, url);
        }
        assert.deepEqual(asked, []);
        // Where an owner does serve, it is asked.
        leave({ control: { url: `http://127.0.0.1:${port}`, token: "secret-token" } });
        assert.equal((await inspectOwner(database)).state, "live");
        assert.deepEqual(asked, ["GET /health"]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("that cannot be read is taken over once it is old, and is someone's who is writing it while it is new", async () => {
      writeFileSync(ownerRecordPath(database), "{ not json");
      assert.equal((await inspectOwner(database)).state, "live");
      await assert.rejects(claimDatabase(database, { kind: "studio" }), DatabaseOwnedError);
      const old = new Date(Date.now() - 60_000);
      utimesSync(ownerRecordPath(database), old, old);
      assert.deepEqual(await inspectOwner(database), { state: "stale", reason: "it cannot be read, and has not been touched for a while" });
      await claim(database, { kind: "studio" });
      assert.equal(record().pid, process.pid);
    });
  });

  describe("what a claim leaves alone", () => {
    it("the record of another database, and whatever else is beside the database", async () => {
      const other = join(dirname(database), "other.db");
      await createDatabase(other, { collections: { t: [] } });
      const theirs = leave({ kind: "rest" }, other);
      writeFileSync(join(dirname(database), "notes.owner.json"), "mine");
      const made = await claim(database, { kind: "studio" });
      made.release();
      assert.deepEqual(JSON.parse(readFileSync(ownerRecordPath(other), "utf8")), theirs);
      assert.deepEqual(readdirSync(dirname(database)).sort(), ["notes.owner.json", "other.db", "other.db.owner.json", "sandbox.db"]);
    });

    it("a record that is another owner's by the time it lets go", async () => {
      const made = await claim(database, { kind: "studio" });
      // Should not happen while this process runs; if it has, the record is not this claim's to remove.
      const theirs = leave({ kind: "nest", instance: "a".repeat(48) });
      made.release();
      assert.deepEqual(record(), theirs);
      await assert.rejects(async () => made.publish({ url: "http://127.0.0.1:1", token: "t" }), (error: unknown) => error instanceof JsonStorageError && /is not this process's any more/.test(error.message));
    });
  });

  describe("where an owner serves", () => {
    it("is said in the record once the owner serves, and is read from there", async () => {
      const made = await claim(database, { kind: "postgrest" });
      assert.equal(record().control, undefined);
      made.publish({ url: "http://127.0.0.1:54399", token: "0123456789abcdef" });
      assert.deepEqual(record(), { ...made.record, control: { url: "http://127.0.0.1:54399", token: "0123456789abcdef" } });
      assert.deepEqual(made.record.control, { url: "http://127.0.0.1:54399", token: "0123456789abcdef" });
      const found = await inspectOwner(database, { probe: async () => "alive" });
      assert.deepEqual(found, { state: "live", record: record(), responsive: true });
    });

    it("is taken out of the record again when the owner stops serving, and the database stays the owner's", async () => {
      const made = await claim(database, { kind: "postgrest" });
      made.publish({ url: "http://127.0.0.1:54399", token: "0123456789abcdef" });
      made.publish(undefined);
      assert.equal(record().control, undefined);
      assert.equal("control" in made.record, false);
      assert.deepEqual(record(), made.record);
      // As before it served: its process runs, so the database is its own, and there is nowhere to ask.
      assert.deepEqual(await inspectOwner(database, { probe: never }), { state: "live", record: record(), responsive: true });
      await assert.rejects(claimDatabase(database, { kind: "studio" }, { probe: never }), DatabaseOwnedError);
    });

    it("is not said of a database nobody has", async () => {
      assert.deepEqual(await inspectOwner(database), { state: "none" });
    });
  });

  describe("the moment of claiming", () => {
    it("is one process's at a time: a mark left by a process that is gone is no obstacle, one of a running process is, for a while", async () => {
      const mark = `${canonicalDatabasePath(database)}.owner.lock`;
      writeFileSync(mark, String(await deadPid()));
      (await claim(database, { kind: "studio" })).release();
      assert.equal(existsSync(mark), false);
      // A running process is at it: wait for it, and say so when it does not end.
      writeFileSync(mark, String(process.pid));
      await assert.rejects(claimDatabase(database, { kind: "studio" }, { waitMs: 200 }), (error: unknown) => error instanceof JsonStorageError && /is being claimed by another process \(pid \d+\)/.test(error.message));
      assert.equal(existsSync(ownerRecordPath(database)), false);
    });
  });

  describe("a command that replaces a database (init --force)", () => {
    it("has the database for as long as it replaces it, and is named in what another process is told", async () => {
      const made = await claim(database, { kind: "init" });
      assert.equal(record().kind, "init");
      await assert.rejects(claimDatabase(database, { kind: "postgrest" }), (error: unknown) => {
        assert.ok(error instanceof DatabaseOwnedError);
        assert.match(error.message, new RegExp(`is open in the init command, which is replacing it \\(pid ${process.pid}, since .*\\)\\. One process has a database open to write at a time: stop that one first\\. If that process is gone, delete .*sandbox\\.db\\.owner\\.json\\.$`));
        return true;
      });
      made.release();
      assert.equal(existsSync(ownerRecordPath(database)), false);
    });
  });

  describe("a sandbox that is refused a database which a Studio has to itself", () => {
    const HANDOVER = / That Studio has the database to itself\. To run the sandbox on it: stop that Studio \(Ctrl\+C in its terminal\), start the sandbox, and start Studio again\. It then attaches to the sandbox, and both show the same rows\.$/;
    const alive: OwnerProbe = async () => "alive";

    it("is told who has it, and the three steps that hand it over", async () => {
      // A standalone Studio serves its runtime, as every owner with a runtime does.
      const left = leave({ kind: "studio", control: { url: "http://127.0.0.1:1", token: "t".repeat(48) } });
      for (const kind of ["postgrest", "nest"] as const) {
        await assert.rejects(claimDatabase(database, { kind }, { probe: alive }), (error: unknown) => {
          assert.ok(error instanceof DatabaseOwnedError, String(error));
          assert.match(error.message, new RegExp(`sandbox\\.db is open in Local DB Studio \\(pid ${process.pid}, since 2026-01-02T03:04:05\\.000Z\\)\\. One process has a database open to write at a time: stop that one first\\.`));
          assert.match(error.message, HANDOVER, kind);
          return true;
        });
      }
      // Nothing was taken, and nothing was let go of for it.
      assert.deepEqual(record(), left);
    });

    it("is not told to start Studio again when it is no sandbox that Studio attaches to", async () => {
      leave({ kind: "studio", control: { url: "http://127.0.0.1:1", token: "t".repeat(48) } });
      for (const kind of ["rest", "sql", "init"] as const) {
        await assert.rejects(claimDatabase(database, { kind }, { probe: alive }), (error: unknown) => {
          assert.ok(error instanceof DatabaseOwnedError, String(error));
          assert.match(error.message, /is open in Local DB Studio \(pid \d+, since .*\)\. One process has a database open to write at a time: stop that one first\.$/, kind);
          return true;
        });
      }
    });

    it("is told nothing of Studio when another kind of process has the database", async () => {
      leave({ kind: "postgrest", control: { url: "http://127.0.0.1:1", token: "t".repeat(48) } });
      await assert.rejects(claimDatabase(database, { kind: "nest" }, { probe: alive }), (error: unknown) => error instanceof DatabaseOwnedError && !/Studio/.test(error.message) && /stop that one first\.$/.test(error.message));
    });
  });

  describe("the token of an owner that serves", () => {
    const TOKEN = "70c3e9a1".repeat(6);

    it("is in the owner's record alone: a writer that is refused is told who has the database, and not the token, however the refusal is printed", async () => {
      // Whoever has the token is served the owner's runtime. An error is printed by whoever catches it last, and with
      // all it holds, not its message alone: NestJS's exception handler does, and so does Node with one nobody caught.
      const made = await claim(database, { kind: "studio", persistence: "json" });
      made.publish({ url: "http://127.0.0.1:54399", token: TOKEN });
      const { control, ...who } = record();
      assert.deepEqual(control, { url: "http://127.0.0.1:54399", token: TOKEN });
      for (const kind of ["nest", "postgrest", "rest", "sql", "studio"] as const) {
        await assert.rejects(claimDatabase(database, { kind }, { probe: async () => "alive" }), (error: unknown) => {
          assert.ok(error instanceof DatabaseOwnedError, String(error));
          const printed = { message: error.message, stack: String(error.stack), text: String(error), json: JSON.stringify(error), inspected: inspect(error, { depth: null, showHidden: true, getters: true }) };
          for (const [how, text] of Object.entries(printed)) {
            assert.equal(text.includes(TOKEN), false, `refused to "${kind}", ${how}: ${text}`);
          }
          // Who has the database is said as before: what it is, its process, since when, and which database.
          assert.deepEqual(error.owner, who);
          assert.deepEqual(who, { version: 1, pid: process.pid, startedAt: made.record.startedAt, instance: made.record.instance, kind: "studio", database: canonicalDatabasePath(database), persistence: "json" });
          assert.equal(error.recordPath, ownerRecordPath(database));
          assert.match(error.message, new RegExp(`sandbox\\.db is open in Local DB Studio \\(pid ${process.pid}, since ${made.record.startedAt.replaceAll(".", "\\.")}\\)\\. One process has a database open to write at a time: stop that one first\\.`));
          return true;
        });
      }
      // The owner serves as before: its record has the token, for whoever attaches to it.
      assert.deepEqual(record(), { ...who, control: { url: "http://127.0.0.1:54399", token: TOKEN } });
    });
  });
});
