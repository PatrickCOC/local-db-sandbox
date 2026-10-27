import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { RuntimeAccess } from "../../runtime-access/src/index.ts";
import { ownDatabase } from "../../runtime-access/test/support/owner-process.ts";
import type { OwnerProcess } from "../../runtime-access/test/support/owner-process.ts";
import { createDatabase } from "../../storage-json/src/index.ts";
import { databaseFiles } from "../../storage-json/test/support/database-files.ts";
import { DIAGRAM_LIMITS, openStudioSession, startStudio, startStudioServer } from "../src/index.ts";
import type { ErDiagram, RunningStudio, StudioServer, StudioSession } from "../src/index.ts";
import { ER_ROWS, ER_SCHEMA, UNICODE_TABLE } from "./support/er-fixture.ts";

/*
 * What the ER Diagram tab asks of Studio's server (D-053): the tables'
 * definitions, laid out. It is made of a snapshot without rows: no row is
 * read for it, and nothing of the database is changed. Standalone,
 * read-only, and attached to the process that has the database open.
 */

const NAMES = ER_SCHEMA.map((table) => table.name);

describe("Studio's diagram of the tables", { timeout: 180_000 }, () => {
  let root: string;
  let directory: string;
  const running: { stop(): Promise<void> }[] = [];
  const owners: OwnerProcess[] = [];

  const diagram = async (studio: { url: string; key: string }, body: unknown, key: string | null = studio.key, method = "POST"): Promise<{ status: number; json: any; text: string }> => {
    const response = await fetch(`${studio.url}/api/diagram`, {
      method,
      headers: { ...(key !== null && { authorization: `Bearer ${key}` }), ...(method === "POST" && { "content-type": "application/json" }) },
      ...(method === "POST" && { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  };
  const start = async (options: { readOnly?: boolean } = {}): Promise<RunningStudio> => {
    const studio = await startStudio({ database: directory, port: 0, ...options });
    running.push(studio);
    return studio;
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-diagram-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    directory = join(root, `db-${Math.random().toString(16).slice(2)}`, "sandbox.db");
    await createDatabase(directory, { collections: ER_ROWS(), schema: ER_SCHEMA }, { format: "directory" });
  });
  afterEach(async () => {
    for (const each of running.splice(0).reverse()) {
      await each.stop();
    }
    for (const owner of owners.splice(0)) {
      await owner.kill();
    }
  });

  it("gives the tables, their keys, and their places; reads no row, and changes nothing of the database", async () => {
    const before = await databaseFiles(directory);
    // What the server asks of the access, seen from between the two.
    const calls: [string, unknown][] = [];
    const session: StudioSession = await openStudioSession({ database: directory });
    const access = new Proxy(session.access, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? (...given: unknown[]) => (calls.push([String(property), given[0]]), value.apply(target, given)) : value;
      },
    }) as RuntimeAccess;
    const server: StudioServer = await startStudioServer({ session: { ...session, access, status: () => session.status(), close: () => session.close() }, port: 0 });
    running.push({ stop: async () => (await server.stop(), await session.close()) });

    const answer = await diagram(server, { request: { tables: NAMES } });
    assert.equal(answer.status, 200);
    const result = answer.json.result as ErDiagram;
    assert.deepEqual(
      result.tables.map((table) => table.name),
      NAMES,
    );
    assert.equal(result.foreignKeys.length, 7);
    assert.ok(result.tables.every((table) => Number.isFinite(table.x) && Number.isFinite(table.y) && table.width > 0 && table.height > 0));
    assert.ok(result.tables.some((table) => table.name === UNICODE_TABLE));
    // Asked for once: the definitions alone.
    assert.deepEqual(calls, [["snapshot", { tables: NAMES, rows: false }]]);
    assert.ok(!answer.text.includes("row-value-that-is-never-in-a-diagram"));
    assert.deepEqual(await databaseFiles(directory), before);
  });

  it("gives an empty diagram for no tables, and asks the database nothing for it", async () => {
    const studio = await start();
    const answer = await diagram(studio, { request: { tables: [] } });
    assert.equal(answer.status, 200);
    assert.deepEqual([answer.json.result.tables, answer.json.result.foreignKeys, answer.json.result.width], [[], [], 0]);
  });

  it("answers the page alone, with POST, and a list of tables each once", async () => {
    const studio = await start();
    assert.equal((await diagram(studio, { request: { tables: NAMES } }, null)).status, 401);
    assert.equal((await diagram(studio, { request: { tables: NAMES } }, "0".repeat(48))).status, 401);
    assert.equal((await diagram(studio, undefined, studio.key, "GET")).status, 405);
    for (const body of ["{", {}, { request: { tables: "customers" } }, { request: { tables: [1] } }, { request: { tables: ["orders", "orders"] } }]) {
      const answer = await diagram(studio, body);
      assert.deepEqual([answer.status, answer.json.error.code], [400, "INVALID_REQUEST"], JSON.stringify(body));
    }
    const unknown = await diagram(studio, { request: { tables: ["customers", "nothing_like_it"] } });
    assert.deepEqual([unknown.status, unknown.json.error.code], [404, "NOT_FOUND"]);
  });

  it("refuses more tables than a diagram is made of, before reading anything", async () => {
    const studio = await start();
    const names = Array.from({ length: DIAGRAM_LIMITS.maxTables + 1 }, (_unused, at) => `t${at}`);
    const answer = await diagram(studio, { request: { tables: names } });
    assert.deepEqual([answer.status, answer.json.error.code], [413, "DIAGRAM_TOO_LARGE"]);
    assert.match(answer.json.error.message, /at most 400 tables/);
  });

  it("is made the same way by a read-only Studio, and by one attached to the process that has the database open", async () => {
    const standalone = await start();
    const expected = (await diagram(standalone, { request: { tables: NAMES } })).json.result;
    await standalone.stop();

    const readOnly = await start({ readOnly: true });
    assert.equal((await readOnly.status()).info?.readOnly, "Studio was started with --read-only.");
    assert.deepEqual((await diagram(readOnly, { request: { tables: NAMES } })).json.result, expected);
    await readOnly.stop();

    const before = await databaseFiles(directory);
    owners.push(await ownDatabase(directory));
    const attached = await start();
    assert.equal(attached.mode, "attached");
    const answer = await diagram(attached, { request: { tables: NAMES } });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json.result, expected);
    assert.ok(!answer.text.includes("row-value-that-is-never-in-a-diagram"));
    assert.deepEqual(await databaseFiles(directory), before);
  });
});
