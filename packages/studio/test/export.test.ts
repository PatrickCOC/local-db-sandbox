import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SnapshotResult } from "../../runtime-access/src/index.ts";
import { DATA, SCHEMA, open } from "../../runtime-access/test/support/fixture.ts";
import { createDatabase } from "../../storage-json/src/index.ts";
import { allFiles } from "../../storage-json/test/support/database-files.ts";
import { EXPORT_DATA_UNCONFIRMED, startStudio, startStudioServer } from "../src/index.ts";
import type { RunningStudio, StudioExporter, StudioSession } from "../src/index.ts";

/*
 * The Export tab's request (D-050): Studio reads the tables it is asked for,
 * whole and at one moment (`snapshot` of the access), and hands them to the
 * exporter whoever started it gave it. Here the exporter is one of the
 * test's own, which says what it was given: what Studio does around it is
 * what is tested, not a dialect.
 */

describe("Studio: the Export tab's request", { timeout: 120_000 }, () => {
  let root: string;
  let directory: string;
  const running: { stop: () => Promise<void> }[] = [];
  /** What the exporter was given, each time. */
  let given: { snapshot: SnapshotResult; request: { tables: string[]; mode: string } }[];
  const exporter: StudioExporter = async (snapshot, request) => {
    given.push({ snapshot, request });
    return { status: "exported", sql: `-- ${request.mode}: ${snapshot.schema.tables.map((table) => table.name).join(", ")}\nSELECT 'ünï''code';\n`, tables: snapshot.schema.tables.map((table) => table.name), rows: Object.values(snapshot.rows ?? {}).reduce((sum, rows) => sum + rows.length, 0), statements: 1, warnings: ["a warning"] };
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-export-"));
    directory = join(root, "sandbox.db");
    await createDatabase(directory, { collections: DATA(), schema: SCHEMA }, { format: "directory" });
    given = [];
  });
  afterEach(async () => {
    for (const studio of running.splice(0)) {
      await studio.stop();
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const start = async (options: { readOnly?: boolean; exporter?: StudioExporter | null } = {}): Promise<RunningStudio> => {
    const studio = await startStudio({ database: directory, port: 0, ...(options.readOnly === true && { readOnly: true }), ...(options.exporter !== null && { exporter: options.exporter ?? exporter }) });
    running.push(studio);
    return studio;
  };
  const ask = async (studio: { url: string; key: string }, body: unknown, key: string | undefined = studio.key): Promise<{ status: number; json: any }> => {
    const response = await fetch(`${studio.url}/api/export`, { method: "POST", headers: { ...(key !== undefined && { authorization: `Bearer ${key}` }), "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };

  it("gives the script, with a name for its file and what is in it; the exporter is given the tables whole, and rows only with data", async () => {
    const studio = await start();
    const schemaOnly = await ask(studio, { request: { tables: ["orders", "users"], mode: "schema" } });
    assert.equal(schemaOnly.status, 200);
    const result = schemaOnly.json.result;
    assert.match(result.fileName, /^local-db-export-schema-\d{8}T\d{6}Z\.sql$/);
    assert.deepEqual([result.sql, result.tables, result.mode, result.rows, result.statements, result.warnings, result.bytes], ["-- schema: users, orders\nSELECT 'ünï''code';\n", ["users", "orders"], "schema", 0, 1, ["a warning"], Buffer.byteLength(result.sql)]);
    assert.deepEqual(given[0]?.request, { tables: ["orders", "users"], mode: "schema" });
    assert.equal(given[0]?.snapshot.rows, undefined);
    // The file's name holds nothing of the database or of where it is.
    assert.equal(result.fileName.includes("sandbox"), false);

    const both = await ask(studio, { request: { tables: ["users", "orders", "memberships", "notes"], mode: "schema-and-data", confirmData: true } });
    assert.equal(both.status, 200);
    assert.match(both.json.result.fileName, /^local-db-export-schema-and-data-\d{8}T\d{6}Z\.sql$/);
    assert.equal(both.json.result.rows, 25 + 2 + 3 + 3);
    assert.deepEqual(given[1]?.snapshot.rows?.users, DATA().users);
  });

  it("makes an export with data only when that is confirmed, and refuses what is not a request for one", async () => {
    const studio = await start();
    for (const mode of ["data", "schema-and-data"]) {
      for (const confirmData of [undefined, false, "true"]) {
        const answer = await ask(studio, { request: { tables: ["users"], mode, ...(confirmData !== undefined && { confirmData }) } });
        assert.deepEqual([answer.status, answer.json.error], [400, { code: "INVALID_REQUEST", message: EXPORT_DATA_UNCONFIRMED }]);
      }
    }
    const wrong = [{}, { request: {} }, { request: { tables: [], mode: "schema" } }, { request: { tables: ["users"], mode: "everything" } }, { request: { tables: [1], mode: "schema" } }, { request: { tables: "users", mode: "schema" } }];
    for (const body of wrong) {
      const answer = await ask(studio, body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.match(answer.json.error.message, /^An export is asked for with \{ "request": \{ "tables": \[at least one table\], "mode": one of schema, data, schema-and-data \} \}\.$/);
    }
    const missing = await ask(studio, { request: { tables: ["users", "nowhere"], mode: "schema" } });
    assert.deepEqual([missing.status, missing.json.error], [404, { code: "NOT_FOUND", message: 'There is no table "nowhere".' }]);
    const stranger = await ask(studio, { request: { tables: ["users"], mode: "schema" } }, "0".repeat(48));
    assert.equal(stranger.status, 401);
    const get = await fetch(`${studio.url}/api/export`, { headers: { authorization: `Bearer ${studio.key}` } });
    assert.equal(get.status, 405);
    assert.deepEqual(given, []);
  });

  it("changes nothing of the database, standalone or read-only", async () => {
    const before = await allFiles(directory);
    const studio = await start();
    assert.equal((await ask(studio, { request: { tables: ["users", "orders", "memberships", "notes"], mode: "schema-and-data", confirmData: true } })).status, 200);
    await studio.stop();
    assert.deepEqual(await allFiles(directory), before);
    const looking = await start({ readOnly: true });
    assert.equal((await ask(looking, { request: { tables: ["users"], mode: "data", confirmData: true } })).status, 200);
    await looking.stop();
    assert.deepEqual(await allFiles(directory), before);
  });

  it("gives no script at all when the exporter refuses, and says every reason", async () => {
    const refusing: StudioExporter = async () => ({ status: "refused", refusals: [{ table: "users", column: "score", message: "Row 3: not a number." }, { message: "Another reason." }] });
    const studio = await start({ exporter: refusing });
    const answer = await ask(studio, { request: { tables: ["users"], mode: "data", confirmData: true } });
    assert.deepEqual([answer.status, answer.json], [
      422,
      { error: { code: "EXPORT_REFUSED", message: "The export was not made: 2 reasons.", refusals: [{ table: "users", column: "score", message: "Row 3: not a number." }, { message: "Another reason." }] } },
    ]);
    const without = await start({ exporter: null });
    assert.deepEqual((await ask(without, { request: { tables: ["users"], mode: "schema" } })).json, { error: { code: "NOT_AVAILABLE", message: "This Studio was started without a way to write SQL." } });
  });

  it("gives nothing when the tables are more than one snapshot may hold", async () => {
    // An access whose snapshots may be small, as Studio's page has it.
    const { access, runtime } = await open({ limits: { maxSnapshotBytes: 2_000 } });
    const session = { access, mode: "standalone", status: async () => ({}) } as unknown as StudioSession;
    const server = await startStudioServer({ session, port: 0, exporter });
    running.push({ stop: () => server.stop() });
    try {
      const answer = await ask(server, { request: { tables: ["users"], mode: "data", confirmData: true } });
      assert.equal(answer.status, 413);
      assert.equal(answer.json.error.code, "LIMIT_EXCEEDED");
      assert.match(answer.json.error.message, /Nothing was given: ask for fewer tables, or for their definitions alone\./);
      assert.equal((await ask(server, { request: { tables: ["users"], mode: "schema" } })).status, 200);
      assert.equal(given.length, 1);
    } finally {
      runtime.close();
    }
  });
});
