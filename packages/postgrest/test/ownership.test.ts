import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { DatabaseOwnedError, canonicalDatabasePath, createDatabase, inspectOwner, ownerRecordPath } from "../../storage-json/src/index.ts";
import type { OwnerRecord } from "../../storage-json/src/index.ts";
import { startPostgrestSandbox } from "../src/index.ts";
import type { RunningPostgrestSandbox } from "../src/index.ts";
import { SCHEMA, fixture } from "./support.ts";

/*
 * An endpoint has its database to itself while it runs (D-042): it claims
 * the database before it reads it, and lets go of it when it stops. Whoever
 * else wants the database open meanwhile is told who has it.
 */

describe("the endpoint's database is its own while it runs", () => {
  let directory: string;
  let database: string;
  const running: RunningPostgrestSandbox[] = [];
  const start = async (options: { database?: string; save?: boolean; port?: number } = {}): Promise<RunningPostgrestSandbox> => {
    const sandbox = await startPostgrestSandbox({ database, port: 0, ...options });
    running.push(sandbox);
    return sandbox;
  };
  const record = (of: string = database): OwnerRecord => JSON.parse(readFileSync(ownerRecordPath(of), "utf8"));

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "postgrest-owner-"));
    database = join(directory, "sandbox.db");
    await createDatabase(database, { collections: fixture(), schema: SCHEMA }, { format: "directory" });
  });
  afterEach(async () => {
    for (const sandbox of running.splice(0)) {
      await sandbox.stop();
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test("it says so in a record next to the database, and takes the record away when it stops", async () => {
    const sandbox = await start();
    assert.deepEqual(readdirSync(dirname(database)).sort(), ["sandbox.db", "sandbox.db.owner.json"]);
    const { startedAt, instance, ...rest } = record();
    assert.deepEqual(rest, { version: 1, pid: process.pid, kind: "postgrest", database: canonicalDatabasePath(database) });
    assert.ok(typeof startedAt === "string" && /^[0-9a-f]{48}$/.test(instance));
    // The claim is the endpoint's own: whoever composes it with something that serves the runtime says where in it.
    assert.deepEqual(sandbox.claim.record, record());
    await sandbox.stop();
    assert.deepEqual(readdirSync(dirname(database)), ["sandbox.db"]);
    assert.deepEqual(await inspectOwner(database), { state: "none" });
  });

  test("a second endpoint on the same database is refused, and is told who has it", async () => {
    const first = await start();
    await assert.rejects(start({ database, port: 0 }), (error: unknown) => {
      assert.ok(error instanceof DatabaseOwnedError, String(error));
      assert.match(error.message, new RegExp(`sandbox\\.db is open in the PostgREST endpoint \\(pid ${process.pid}, since .*\\)\\. One process has a database open to write at a time: stop that one first\\.`));
      return true;
    });
    // The first has it as before, and serves.
    assert.equal(record().instance, first.claim.record.instance);
    assert.equal((await fetch(`${first.url}/rest/v1/teams?select=id&id=eq.1`)).status, 200);
    // Once the first has stopped, the database is free.
    await first.stop();
    const second = await start();
    assert.notEqual(second.claim.record.instance, first.claim.record.instance);
  });

  test("an endpoint that does not save claims its database too: the rows it serves are in its runtime, not in the files", async () => {
    await start({ save: false });
    // What it was told about saving, it says: a record is written before the database is read, and says no more than is known then.
    assert.deepEqual([record().kind, record().persistence], ["postgrest", "memory"]);
    await assert.rejects(start({ database, port: 0 }), DatabaseOwnedError);
  });

  test("an endpoint that could not start leaves no record behind", async () => {
    const plain = join(directory, "plain.db");
    await createDatabase(plain, { collections: { users: [{ id: 1 }] } }, { format: "directory" });
    await assert.rejects(start({ database: plain, port: 0 }), /stores no table definitions/);
    assert.equal(existsSync(ownerRecordPath(plain)), false);
    // Its port is taken: by the first endpoint.
    const first = await start();
    const other = join(directory, "other.db");
    await createDatabase(other, { collections: fixture(), schema: SCHEMA }, { format: "directory" });
    await assert.rejects(start({ database: other, port: first.port }), { code: "EADDRINUSE" });
    assert.equal(existsSync(ownerRecordPath(other)), false);
    // A database that is not there is reported as before, and nothing is written where it would be.
    await assert.rejects(start({ database: join(directory, "nowhere.db"), port: 0 }), /Database not found/);
    assert.deepEqual(readdirSync(directory).sort(), ["other.db", "plain.db", "sandbox.db", "sandbox.db.owner.json"]);
  });
});
