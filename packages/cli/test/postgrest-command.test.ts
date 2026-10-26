import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SCHEMA, clientFor, fixture } from "../../postgrest/test/support.ts";
import { AttachedRuntimeAccess } from "../../runtime-access/src/index.ts";
import { createDatabase, ownerRecordPath } from "../../storage-json/src/index.ts";
import type { OwnerRecord } from "../../storage-json/src/index.ts";
import { storedRows } from "../../storage-json/test/support/database-files.ts";
import { runCli } from "../src/index.ts";

describe("CLI: postgrest", () => {
  let dir: string;
  let database: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-postgrest-"));
    database = join(dir, "sandbox.db");
    await createDatabase(database, { collections: fixture(), schema: SCHEMA }, { format: "directory" });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  }

  it("prints its help, which states what is not provided", async () => {
    const { code, stdout } = await run("postgrest", "--help");
    assert.equal(code, 0);
    assert.match(stdout, /Usage: local-db-sandbox postgrest <database>/);
    assert.match(stdout, /Not provided: Row Level Security, Auth, Storage, Realtime, RPC/);
    assert.match((await run("--help")).stdout, /postgrest <database>/);
  });

  it("refuses bad options and a database without table definitions", async () => {
    assert.match((await run("postgrest")).stderr, /Missing the database/);
    assert.match((await run("postgrest", database, "--max-rows", "x")).stderr, /--max-rows must be/);
    assert.match((await run("postgrest", database, "--sql-log", "loud")).stderr, /--sql-log must be/);
    const plain = join(dir, "plain.db");
    await createDatabase(plain, { collections: { users: [{ id: 1 }] } }, { format: "directory" });
    const result = await run("postgrest", plain, "--port", "0");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /stores no table definitions/);
  });

  it("serves the database until a signal, logs requests and SQL without keys, and saves", async () => {
    let stdout = "";
    let announce: (url: string) => void = () => {};
    const ready = new Promise<string>((resolve) => (announce = resolve));
    const signals = new EventEmitter();
    const exit = runCli(["postgrest", database, "--port", "0"], {
      stdout: {
        write: (text) => {
          stdout += text;
          const match = /Supabase URL for clients: (http:\S+)/.exec(stdout);
          if (match) {
            announce(match[1] as string);
          }
        },
      },
      stderr: { write: (text) => (stdout += text) },
      signals,
    });
    const url = await Promise.race([ready, exit.then((code) => Promise.reject(new Error(`exited with ${code}: ${stdout}`)))]);
    assert.match(stdout, /tables: {6}teams, readings/);
    assert.match(stdout, /every client can read and write every table/);

    const client = clientFor(url);
    assert.equal((await client.from("teams").upsert({ id: 1, name: "From CLI" })).error, null);
    assert.deepEqual((await client.from("teams").select("name").eq("id", 1).single()).data, { name: "From CLI" });

    signals.emit("SIGINT");
    assert.equal(await exit, 0);
    assert.match(stdout, /\[req-1\] POST \/rest\/v1\/teams -> 201 \(sql 3,/);
    assert.match(stdout, /\[req-2\] GET \/rest\/v1\/teams\?select=name&id=eq\.1 -> 200 \(sql 1,/);
    assert.match(stdout, /Stopped\./);
    assert.doesNotMatch(stdout, /local-anon-key/);
    assert.equal((await storedRows(database, "teams")).find((row) => row.id === 1)?.name, "From CLI");
  });

  it("serves its runtime to this machine while it runs: whoever asks through the owner's record sees what the endpoint's clients see, and they see what it changes", async () => {
    let stdout = "";
    let announce: (url: string) => void = () => {};
    const ready = new Promise<string>((resolve) => (announce = resolve));
    const signals = new EventEmitter();
    const exit = runCli(["postgrest", database, "--port", "0"], {
      stdout: {
        write: (text) => {
          stdout += text;
          const match = /Supabase URL for clients: (http:\S+)/.exec(stdout);
          if (match) {
            announce(match[1] as string);
          }
        },
      },
      stderr: { write: (text) => (stdout += text) },
      signals,
    });
    const url = await Promise.race([ready, exit.then((code) => Promise.reject(new Error(`exited with ${code}: ${stdout}`)))]);
    const client = clientFor(url);
    const attached = new AttachedRuntimeAccess({ database });
    try {
      // The endpoint is the database's owner, and says where it serves its runtime.
      const record: OwnerRecord = JSON.parse(readFileSync(ownerRecordPath(database), "utf8"));
      assert.deepEqual([record.kind, record.pid, /^http:\/\/127\.0\.0\.1:\d+$/.test(record.control?.url ?? ""), record.control?.url === url], ["postgrest", process.pid, true, false]);
      assert.equal(await attached.check(), true);
      assert.deepEqual([attached.owner?.kind, attached.owner?.instance], ["postgrest", record.instance]);
      const info = await attached.info();
      assert.deepEqual([info.kind, info.format, info.persistence, info.tables, info.readOnly], ["postgrest", "directory", "json", 2, undefined]);

      // What a client of the endpoint writes is there for whoever asks the runtime...
      assert.equal((await client.from("teams").upsert({ id: 9, name: "From the API" })).error, null);
      assert.deepEqual((await attached.browse({ table: "teams", filters: [{ column: "id", op: "eq", value: 9 }] })).rows.map((row) => row[1]), ["From the API"]);
      // ...and what is changed in the runtime is what the endpoint serves, and what it saves.
      assert.deepEqual(await attached.update({ table: "teams", key: { id: 9 }, values: { name: "From Studio" } }), { affectedRows: 1 });
      assert.deepEqual((await client.from("teams").select("name").eq("id", 9).single()).data, { name: "From Studio" });
      assert.deepEqual(await attached.insert({ table: "teams", values: { id: 10, name: "Added in Studio" } }), { affectedRows: 1 });
      assert.deepEqual((await client.from("teams").select("id").gte("id", 9)).data, [{ id: 9 }, { id: 10 }]);
      assert.equal((await storedRows(database, "teams")).find((row) => row.id === 10)?.name, "Added in Studio");

      signals.emit("SIGINT");
      assert.equal(await exit, 0);
      // What was asked through the access is in the endpoint's log as Studio's, apart from its own requests.
      assert.match(stdout, /^\[studio #1\] .*UPDATE teams/m);
      // The owner's token was printed nowhere, and its record is gone with it.
      assert.equal(stdout.includes(record.control?.token as string), false);
      assert.equal(existsSync(ownerRecordPath(database)), false);
      assert.equal(await attached.check(), false);
      assert.equal(attached.disconnected, "No process has the database open.");
    } finally {
      signals.emit("SIGINT");
      await exit;
    }
  });
});
