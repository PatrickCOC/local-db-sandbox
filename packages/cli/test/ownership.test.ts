import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseOwnedError, canonicalDatabasePath, createDatabase, inspectOwner, ownerRecordPath } from "../../storage-json/src/index.ts";
import type { OwnerRecord } from "../../storage-json/src/index.ts";
import { storedRows } from "../../storage-json/test/support/database-files.ts";
import { runCli, startSandbox } from "../src/index.ts";
import type { RunningSandbox } from "../src/index.ts";

/*
 * A database that a sandbox process has open to change is that process's
 * (D-042). The REST sandbox and the SQL console say so in the record next
 * to the database, as the processes do that execute on the relational
 * runtime, and each is refused a database that another process has.
 */

describe("a database that a sandbox process has open is that process's", () => {
  let dir: string;
  let file: string;
  let directory: string;
  const running: RunningSandbox[] = [];
  const start = async (path: string, options: { port?: number } = {}): Promise<RunningSandbox> => {
    const sandbox = await startSandbox({ file: path, port: 0, ...options });
    running.push(sandbox);
    return sandbox;
  };
  const record = (path: string): OwnerRecord => JSON.parse(readFileSync(ownerRecordPath(path), "utf8"));
  const run = async (...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-ownership-"));
    file = join(dir, "db.json");
    await writeFile(file, JSON.stringify({ data: { users: [{ id: 1, name: "Ada" }] } }));
    directory = join(dir, "sandbox.db");
    await createDatabase(directory, { collections: { users: [{ id: 1, name: "Ada" }] } });
  });
  afterEach(async () => {
    for (const sandbox of running.splice(0)) {
      await sandbox.stop();
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe("the REST sandbox", () => {
    it("claims its database, a file or a directory, and lets go of it when it stops", async () => {
      for (const path of [file, directory]) {
        const sandbox = await start(path);
        const { startedAt: _since, instance: _name, ...rest } = record(path);
        assert.deepEqual(rest, { version: 1, pid: process.pid, kind: "rest", database: canonicalDatabasePath(path) }, path);
        // It has no runtime to serve: whoever finds the record knows only that its process runs.
        assert.deepEqual((await inspectOwner(path)).state, "live");
        // It serves as before, and saves as before.
        assert.equal((await fetch(`${sandbox.url}/users`, { method: "POST", body: JSON.stringify({ name: "Bo" }) })).status, 201);
        await sandbox.stop();
        assert.equal(existsSync(ownerRecordPath(path)), false, path);
      }
      assert.deepEqual(readdirSync(dir).sort(), ["db.json", "sandbox.db"]);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")).data.users.map((user: { name: string }) => user.name), ["Ada", "Bo"]);
      assert.deepEqual((await storedRows(directory, "users")).map((user) => user.name), ["Ada", "Bo"]);
    });

    it("is refused a database that another sandbox has open, by its function and by its command, and is told who has it", async () => {
      const first = await start(file);
      await assert.rejects(start(file), (error: unknown) => {
        assert.ok(error instanceof DatabaseOwnedError, String(error));
        assert.match(error.message, new RegExp(`db\\.json is open in the REST sandbox \\(pid ${process.pid}, since .*\\)\\. One process has a database open to write at a time: stop that one first\\. If that process is gone, delete .*db\\.json\\.owner\\.json\\.$`));
        return true;
      });
      const refused = await run(file, "--port", "0");
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /^Error: .*db\.json is open in the REST sandbox \(pid \d+, since .*\)\. One process has a database open to write at a time: stop that one first\./);
      // The first has it as before.
      assert.equal((await fetch(`${first.url}/users`)).status, 200);
      await first.stop();
      await (await start(file)).stop();
    });

    it("that could not start has let go of the database again", async () => {
      // Its port is taken.
      const taken = createServer();
      await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
      try {
        await assert.rejects(start(file, { port: (taken.address() as { port: number }).port }), { code: "EADDRINUSE" });
        assert.equal(existsSync(ownerRecordPath(file)), false);
      } finally {
        await new Promise((resolve) => taken.close(resolve));
      }
      // Its database cannot be read.
      await writeFile(file, "{ not json");
      await assert.rejects(start(file), /not valid JSON/);
      assert.equal(existsSync(ownerRecordPath(file)), false);
      // A database that is not there is reported as before, and no record is made for it.
      await assert.rejects(start(join(dir, "missing.json")), /Cannot read database file/);
      await assert.rejects(start(join(dir, "missing.db")), /Database not found/);
      assert.deepEqual(readdirSync(dir).sort(), ["db.json", "sandbox.db"]);
    });

    it("that does not save claims nothing: it changes nothing that another process could write over", async () => {
      const discarding = join(dir, "discarding.db");
      await createDatabase(discarding, { collections: { users: [{ id: 1, name: "Ada" }] }, persistence: "memory" });
      const sandbox = await start(discarding);
      assert.equal(sandbox.saves, false);
      assert.equal(existsSync(ownerRecordPath(discarding)), false);
      assert.deepEqual(await inspectOwner(discarding), { state: "none" });
      await sandbox.stop();
      // So it is not refused a database that another process has, either: it reads what is stored, and leaves the record alone.
      const theirs: OwnerRecord = { version: 1, pid: process.pid, startedAt: "2026-01-02T03:04:05.000Z", instance: "0".repeat(48), kind: "nest", database: canonicalDatabasePath(discarding) };
      await writeFile(ownerRecordPath(discarding), JSON.stringify(theirs));
      const beside = await start(discarding);
      assert.equal((await fetch(`${beside.url}/users`)).status, 200);
      await beside.stop();
      assert.deepEqual(record(discarding), theirs);
    });
  });

  describe("the SQL console", () => {
    it("claims the database for as long as it may change it, and lets go when it ends", async () => {
      const stdin = new PassThrough();
      let output = "";
      const exit = runCli(["sql", directory], { stdout: { write: (text) => (output += text) }, stderr: { write: (text) => (output += text) }, signals: new EventEmitter(), stdin });
      try {
        // The console is open once it has claimed and loaded the database.
        for (let waited = 0; !existsSync(ownerRecordPath(directory)) && waited < 100; waited += 1) {
          await delay(50);
        }
        const { startedAt: _since, instance: _name, ...rest } = record(directory);
        assert.deepEqual(rest, { version: 1, pid: process.pid, kind: "sql", database: canonicalDatabasePath(directory) });
        // A sandbox is refused the database meanwhile.
        await assert.rejects(start(directory), (error: unknown) => error instanceof DatabaseOwnedError && /is open in the SQL console \(pid \d+/.test(error.message));
        stdin.write("INSERT INTO users (id, name) VALUES (2, 'Bo');\n");
        stdin.end(".exit\n");
        assert.equal(await exit, 0, output);
      } finally {
        stdin.end();
        await exit;
      }
      assert.equal(existsSync(ownerRecordPath(directory)), false);
      assert.deepEqual((await storedRows(directory, "users")).map((user) => user.name), ["Ada", "Bo"]);
      // One statement and out: claimed and let go of each time.
      assert.equal((await run("sql", file, "INSERT INTO users (id, name) VALUES (2, 'Bo')")).code, 0);
      assert.equal((await run("sql", file, "SELECT COUNT(*) AS n FROM users", "--json")).stdout.includes('"n":2'), true);
      assert.deepEqual(readdirSync(dir).sort(), ["db.json", "sandbox.db"]);
    });

    it("is refused a database that another process has open, and is told how to look into it all the same", async () => {
      await start(directory);
      const refused = await run("sql", directory, "UPDATE users SET name = 'x'");
      assert.equal(refused.code, 1);
      assert.match(
        refused.stderr,
        /^Error: .*sandbox\.db is open in the REST sandbox \(pid \d+, since .*\)\. One process has a database open to write at a time: stop that one first\. If that process is gone, delete .*sandbox\.db\.owner\.json\.\nTo look at the database as it is stored, without changing it, add --read-only\. To look into the database of a running sandbox, and change it there, use "local-db-sandbox studio <database>"\.\n/,
      );
      assert.equal(refused.stdout, "");
      assert.deepEqual((await storedRows(directory, "users")).map((user) => user.name), ["Ada"]);
    });

    it("that writes nothing to the database asks no one: with --read-only and with --no-save it reads what is stored", async () => {
      const sandbox = await start(directory);
      await fetch(`${sandbox.url}/users`, { method: "POST", body: JSON.stringify({ name: "Bo" }) });
      const before = record(directory);
      const readOnly = await run("sql", directory, "SELECT name FROM users ORDER BY id", "--read-only", "--json");
      assert.deepEqual([readOnly.code, readOnly.stderr], [0, ""]);
      assert.match(readOnly.stdout, /"rows":\[\{"name":"Ada"\},\{"name":"Bo"\}\]/);
      const discarded = await run("sql", directory, "DELETE FROM users", "--no-save");
      assert.equal(discarded.code, 0);
      // The sandbox has the database as before, and nothing of it was changed.
      assert.deepEqual(record(directory), before);
      assert.deepEqual((await storedRows(directory, "users")).map((user) => user.name), ["Ada", "Bo"]);
      assert.equal((await fetch(`${sandbox.url}/users`)).status, 200);
    });

    it("on a database that declares that it is never written to claims nothing either", async () => {
      const discarding = join(dir, "discarding.db");
      await createDatabase(discarding, { collections: { users: [{ id: 1, name: "Ada" }] }, persistence: "memory" });
      const stdin = new PassThrough();
      const exit = runCli(["sql", discarding], { stdout: { write: () => undefined }, stderr: { write: () => undefined }, signals: new EventEmitter(), stdin });
      try {
        stdin.write("SELECT 1;\n");
        await delay(400);
        assert.equal(existsSync(ownerRecordPath(discarding)), false);
      } finally {
        stdin.end(".exit\n");
        assert.equal(await exit, 0);
      }
    });
  });
});
