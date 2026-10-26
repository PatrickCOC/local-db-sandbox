import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createDatabase } from "../../storage-json/src/index.ts";
import { DEFAULT_POSTGREST_HOST, UNSUPPORTED, startPostgrestSandbox } from "../src/index.ts";
import { SCHEMA, fixture, startHarness } from "./support.ts";
import type { Harness } from "./support.ts";

/* The endpoint at the level of HTTP: what a browser or a client other than supabase-js sees. */

describe("HTTP", () => {
  let harness: Harness;
  let base: string;
  before(async () => {
    harness = await startHarness();
    base = harness.sandbox.url;
  });
  after(async () => {
    await harness.close();
  });

  test("binds to loopback unless told otherwise", () => {
    assert.equal(DEFAULT_POSTGREST_HOST, "127.0.0.1");
    assert.equal(harness.sandbox.host, "127.0.0.1");
  });

  test("answers a CORS preflight for the headers supabase-js sends, from any origin", async () => {
    const response = await fetch(`${base}/rest/v1/teams`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "apikey,authorization,content-type,prefer,x-client-info" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-allow-headers"), "apikey,authorization,content-type,prefer,x-client-info");
    assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/);
  });

  test("a read has PostgREST's headers and body", async () => {
    const response = await fetch(`${base}/rest/v1/teams?select=id,name&offset=1&limit=2`, { headers: { apikey: "k", authorization: "Bearer k" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("content-range"), "1-2/*");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), [{ id: 2, name: "Beta" }, { id: 3, name: "Gamma" }]);
    const empty = await fetch(`${base}/rest/v1/teams?select=id&id=eq.99`);
    assert.equal(empty.headers.get("content-range"), "*/*");
    assert.deepEqual(await empty.json(), []);
  });

  test("the object media type gives one object", async () => {
    const response = await fetch(`${base}/rest/v1/teams?select=name&id=eq.1`, { headers: { accept: "application/vnd.pgrst.object+json" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/vnd.pgrst.object+json; charset=utf-8");
    assert.deepEqual(await response.json(), { name: "Alpha" });
  });

  const errorOf = async (response: Response): Promise<{ status: number; code: string; message: string }> => {
    const body = (await response.json()) as { code: string; message: string; details: unknown; hint: unknown };
    assert.deepEqual(Object.keys(body).sort(), ["code", "details", "hint", "message"]);
    return { status: response.status, code: body.code, message: body.message };
  };

  test("other Supabase services are answered with 501 and their name", async () => {
    for (const [path, name] of [
      ["/auth/v1/token?grant_type=password", /Supabase Auth/],
      ["/storage/v1/object/list/bucket", /Supabase Storage/],
      ["/realtime/v1/websocket", /Supabase Realtime/],
      ["/functions/v1/sync", /Edge Functions/],
      ["/graphql/v1", /GraphQL/],
      ["/rest/v1/rpc/anything", /Calling database functions/],
      ["/rest/v1/", /OpenAPI/],
    ] as const) {
      const error = await errorOf(await fetch(`${base}${path}`, { method: "POST", body: "{}" }));
      assert.equal(error.status, 501, path);
      assert.equal(error.code, UNSUPPORTED, path);
      assert.match(error.message, name, path);
    }
  });

  test("a path that is no table of /rest/v1 is not found", async () => {
    assert.deepEqual(await errorOf(await fetch(`${base}/teams`)), { status: 404, code: "PGRST125", message: "Invalid path: /teams" });
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams/1`))).status, 404);
  });

  test("headers outside the subset are refused", async () => {
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams`, { headers: { range: "0-1" } }))).code, UNSUPPORTED);
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams`, { headers: { accept: "text/csv" } }))).code, UNSUPPORTED);
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams`, { headers: { accept: "application/vnd.pgrst.object+json;nulls=stripped" } }))).code, UNSUPPORTED);
    assert.deepEqual(await errorOf(await fetch(`${base}/rest/v1/teams`, { headers: { "accept-profile": "private" } })), {
      status: 406,
      code: "PGRST106",
      message: "The schema must be one of the following: public",
    });
    assert.equal((await fetch(`${base}/rest/v1/teams?select=id`, { headers: { "accept-profile": "public" } })).status, 200);
  });

  test("query parameters outside the subset, and malformed ones, are refused", async () => {
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams?readings.limit=1`))).code, UNSUPPORTED);
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams?meta->>a=eq.1`))).code, UNSUPPORTED);
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams?limit=-1`))).code, "PGRST100");
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams?id=eq`))).code, "PGRST100");
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams?select=id&select=name`))).code, "PGRST100");
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams?select=id,`))).code, "PGRST100");
  });

  test("a body that is not JSON objects is PostgREST's PGRST102", async () => {
    const post = (body: string): Promise<Response> =>
      fetch(`${base}/rest/v1/teams`, { method: "POST", headers: { prefer: "resolution=merge-duplicates", "content-type": "application/json" }, body });
    assert.equal((await errorOf(await post("{"))).code, "PGRST102");
    assert.equal((await errorOf(await post("[1, 2]"))).code, "PGRST102");
    assert.deepEqual(await errorOf(await post('[{"id": 1, "name": "a"}, {"id": 2}]')), { status: 400, code: "PGRST102", message: "All object keys must match" });
  });

  test("an upsert answers 201 with an empty body and the preferences it applied", async () => {
    const response = await fetch(`${base}/rest/v1/teams`, {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates, return=minimal", "content-type": "application/json" },
      body: JSON.stringify({ id: 1, name: "Alpha" }),
    });
    assert.equal(response.status, 201);
    assert.equal(await response.text(), "");
    assert.equal(response.headers.get("preference-applied"), "resolution=merge-duplicates, return=minimal");
  });

  test("other methods", async () => {
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams`, { method: "PUT", body: "{}" }))).code, UNSUPPORTED);
    assert.equal((await errorOf(await fetch(`${base}/rest/v1/teams`, { method: "PATCH", body: "{}" }))).code, UNSUPPORTED);
    assert.equal((await fetch(`${base}/rest/v1/teams`, { method: "HEAD" })).status, 501);
  });
});

describe("opening a database", () => {
  test("a database without stored table definitions is not served", async () => {
    const directory = mkdtempSync(join(tmpdir(), "postgrest-"));
    try {
      const database = join(directory, "plain.db");
      await createDatabase(database, { collections: { users: [{ id: 1 }] } }, { format: "directory" });
      await assert.rejects(startPostgrestSandbox({ database, port: 0 }), /stores no table definitions/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("collections without a definition are listed as not served", async () => {
    const directory = mkdtempSync(join(tmpdir(), "postgrest-"));
    try {
      const database = join(directory, "mixed.db");
      await createDatabase(database, { collections: { ...fixture(), notes: [{ id: 1 }] }, schema: SCHEMA }, { format: "directory" });
      const sandbox = await startPostgrestSandbox({ database, port: 0 });
      try {
        assert.deepEqual(sandbox.tables, ["teams", "readings"]);
        assert.deepEqual(sandbox.unservedTables, ["notes"]);
        assert.equal((await fetch(`${sandbox.url}/rest/v1/notes`)).status, 404);
      } finally {
        await sandbox.stop();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
