import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Database } from "../../core/src/index.ts";
import type { StorageAdapter } from "../../core/src/index.ts";
import { JsonStorageAdapter } from "../../storage-json/src/index.ts";
import { DEFAULT_HOST, DEFAULT_PORT, SandboxServer } from "../src/index.ts";

const fixturePath = join(import.meta.dirname, "../../../examples/basic/db.json");

describe("SandboxServer", () => {
  let dir: string;
  let dbPath: string;
  let server: SandboxServer;
  let baseUrl: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-"));
    dbPath = join(dir, "db.json");
    await copyFile(fixturePath, dbPath);

    const database = await Database.open(new JsonStorageAdapter(dbPath));
    server = new SandboxServer({ database, port: 0 });
    baseUrl = (await server.start()).url;
  });

  afterEach(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function call(method: string, path: string, body?: unknown): Promise<{ response: Response; json: any }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
          }),
    });
    const text = await response.text();
    return { response, json: text === "" ? undefined : JSON.parse(text) };
  }

  async function storedData(): Promise<any> {
    return JSON.parse(await readFile(dbPath, "utf8")).data;
  }

  async function expectError(result: Promise<{ response: Response; json: any }>, status: number, code: string) {
    const { response, json } = await result;
    assert.equal(response.status, status);
    assert.equal(json.error.code, code);
    assert.equal(typeof json.error.message, "string");
  }

  describe("routes", () => {
    it("lists collections at the root", async () => {
      const { response, json } = await call("GET", "/");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(json, { collections: ["users", "orders"] });
    });

    it("GET /:collection returns all rows with a total count", async () => {
      const { response, json } = await call("GET", "/users");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-total-count"), "2");
      assert.deepEqual(json, [
        { id: 1, name: "Patrick", active: true },
        { id: 2, name: "Alex", active: false },
      ]);
    });

    it("GET /:collection/:id returns one row", async () => {
      const { response, json } = await call("GET", "/users/2");
      assert.equal(response.status, 200);
      assert.deepEqual(json, { id: 2, name: "Alex", active: false });
    });

    it("POST /:collection inserts and persists", async () => {
      const { response, json } = await call("POST", "/users", { name: "Sam", active: true });
      assert.equal(response.status, 201);
      assert.deepEqual(json, { id: 3, name: "Sam", active: true });
      assert.deepEqual((await storedData()).users[2], json);
      assert.deepEqual((await call("GET", "/users/3")).json, json);
    });

    it("PUT /:collection/:id replaces and persists", async () => {
      const { response, json } = await call("PUT", "/users/1", { name: "Pat" });
      assert.equal(response.status, 200);
      assert.deepEqual(json, { id: 1, name: "Pat" });
      assert.deepEqual((await storedData()).users[0], json);
    });

    it("PATCH /:collection/:id merges and persists", async () => {
      const { response, json } = await call("PATCH", "/users/2", { active: true });
      assert.equal(response.status, 200);
      assert.deepEqual(json, { id: 2, name: "Alex", active: true });
      assert.deepEqual((await storedData()).users[1], json);
    });

    it("DELETE /:collection/:id removes and persists", async () => {
      const { response, json } = await call("DELETE", "/users/1");
      assert.equal(response.status, 200);
      assert.deepEqual(json, { id: 1, name: "Patrick", active: true });
      assert.deepEqual(await storedData().then((data) => data.users), [{ id: 2, name: "Alex", active: false }]);
      await expectError(call("GET", "/users/1"), 404, "ROW_NOT_FOUND");
    });

    it("decodes encoded path segments", async () => {
      await call("POST", "/users", { id: "a b", name: "Spaced" });
      assert.equal((await call("GET", "/users/a%20b")).json.name, "Spaced");
    });
  });

  describe("queries", () => {
    beforeEach(async () => {
      await call("POST", "/users", { name: "Sam", active: true, age: 25 });
      await call("POST", "/users", { name: "Bo", active: true, age: 4 });
      await call("POST", "/users", { name: "Kim", active: false, age: 25 });
    });

    const names = async (query: string) => {
      const { response, json } = await call("GET", `/users?${query}`);
      assert.equal(response.status, 200);
      return { names: json.map((row: { name: string }) => row.name), total: response.headers.get("x-total-count") };
    };

    it("filters by equality", async () => {
      assert.deepEqual((await names("active=true")).names, ["Patrick", "Sam", "Bo"]);
      assert.deepEqual((await names("age=25&active=false")).names, ["Kim"]);
      assert.deepEqual((await names("name=Nobody")).names, []);
    });

    it("sorts ascending, descending, and by several fields", async () => {
      assert.deepEqual((await names("_sort=name")).names, ["Alex", "Bo", "Kim", "Patrick", "Sam"]);
      assert.deepEqual((await names("_sort=-id")).names, ["Kim", "Bo", "Sam", "Alex", "Patrick"]);
      assert.deepEqual((await names("_sort=-age,name")).names, ["Kim", "Sam", "Bo", "Alex", "Patrick"]);
    });

    it("paginates with _limit and _offset and reports the unpaginated total", async () => {
      assert.deepEqual(await names("_sort=id&_limit=2"), { names: ["Patrick", "Alex"], total: "5" });
      assert.deepEqual(await names("_sort=id&_limit=2&_offset=4"), { names: ["Kim"], total: "5" });
      assert.deepEqual(await names("active=true&_sort=-id&_offset=1&_limit=1"), { names: ["Sam"], total: "3" });
    });

    it("rejects invalid pagination and sort values", async () => {
      await expectError(call("GET", "/users?_limit=abc"), 400, "INVALID_QUERY");
      await expectError(call("GET", "/users?_limit=-1"), 400, "INVALID_QUERY");
      await expectError(call("GET", "/users?_offset=1.5"), 400, "INVALID_QUERY");
      await expectError(call("GET", "/users?_sort="), 400, "INVALID_QUERY");
    });
  });

  describe("errors", () => {
    it("maps core errors to status codes", async () => {
      await expectError(call("GET", "/nope"), 404, "COLLECTION_NOT_FOUND");
      await expectError(call("POST", "/nope", { id: 1 }), 404, "COLLECTION_NOT_FOUND");
      await expectError(call("GET", "/users/99"), 404, "ROW_NOT_FOUND");
      await expectError(call("PUT", "/users/99", { name: "x" }), 404, "ROW_NOT_FOUND");
      await expectError(call("PATCH", "/users/99", { name: "x" }), 404, "ROW_NOT_FOUND");
      await expectError(call("DELETE", "/users/99"), 404, "ROW_NOT_FOUND");
      await expectError(call("POST", "/users", { id: 1, name: "Dup" }), 409, "DUPLICATE_ID");
      await expectError(call("PATCH", "/users/1", { id: 2 }), 400, "INVALID_ROW");
      await expectError(call("POST", "/users", [1, 2]), 400, "INVALID_ROW");
      await expectError(call("POST", "/users"), 400, "INVALID_ROW");
    });

    it("rejects malformed JSON bodies", async () => {
      await expectError(call("POST", "/users", "{ not json"), 400, "INVALID_JSON");
    });

    it("rejects oversized bodies", async () => {
      await expectError(call("POST", "/users", { blob: "x".repeat(1024 * 1024) }), 413, "BODY_TOO_LARGE");
      assert.equal((await call("GET", "/users")).json.length, 2);
    });

    it("rejects unsupported methods and unknown routes", async () => {
      const { response, json } = await call("DELETE", "/users");
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, POST");
      assert.equal(json.error.code, "METHOD_NOT_ALLOWED");

      await expectError(call("POST", "/users/1", {}), 405, "METHOD_NOT_ALLOWED");
      await expectError(call("POST", "/", {}), 405, "METHOD_NOT_ALLOWED");
      await expectError(call("GET", "/users/1/extra"), 404, "NOT_FOUND");
      await expectError(call("GET", "/users/%E0%A4%A"), 400, "INVALID_PATH");
    });

    it("leaves the file untouched when a request is rejected", async () => {
      const before = await readFile(dbPath, "utf8");
      await call("POST", "/users", { id: 1 });
      await call("DELETE", "/users/99");
      assert.equal(await readFile(dbPath, "utf8"), before);
    });

    it("answers 500 without internal details when storage fails", async () => {
      const failing: StorageAdapter = {
        load: async () => ({ meta: { version: 1 }, collections: { users: [] } }),
        save: async () => {
          throw new Error("secret path /x/y");
        },
      };
      const other = new SandboxServer({ database: await Database.open(failing), port: 0 });
      const { url } = await other.start();
      try {
        const response = await fetch(`${url}/users`, { method: "POST", body: "{}" });
        const text = await response.text();
        assert.equal(response.status, 500);
        assert.equal(JSON.parse(text).error.code, "INTERNAL_ERROR");
        assert.doesNotMatch(text, /secret/);
      } finally {
        await other.stop();
      }
    });
  });

  describe("CORS", () => {
    it("allows any origin and exposes the total count header", async () => {
      const { response } = await call("GET", "/users");
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.match(response.headers.get("access-control-expose-headers") ?? "", /x-total-count/i);
    });

    it("answers preflight requests", async () => {
      const response = await fetch(`${baseUrl}/users/1`, {
        method: "OPTIONS",
        headers: { "access-control-request-method": "PATCH", "access-control-request-headers": "content-type,x-custom" },
      });
      assert.equal(response.status, 204);
      assert.match(response.headers.get("access-control-allow-methods") ?? "", /PATCH/);
      assert.equal(response.headers.get("access-control-allow-headers"), "content-type,x-custom");
    });
  });

  describe("lifecycle", () => {
    const emptyDatabase = () =>
      Database.open({
        load: async () => ({ meta: { version: 1 }, collections: {} }),
        save: async () => {},
      });

    it("defaults to 127.0.0.1:4783", () => {
      assert.equal(DEFAULT_HOST, "127.0.0.1");
      assert.equal(DEFAULT_PORT, 4783);
    });

    it("listens on the configured host and port", async () => {
      const probe = new SandboxServer({ database: await emptyDatabase(), port: 0 });
      const { port } = await probe.start();
      await probe.stop();

      const other = new SandboxServer({ database: await emptyDatabase(), host: "localhost", port });
      const address = await other.start();
      try {
        assert.equal(address.port, port);
        assert.equal(new URL(address.url).port, String(port));
        assert.equal((await fetch(`http://localhost:${port}/`)).status, 200);
      } finally {
        await other.stop();
      }
    });

    it("refuses connections after stop and frees the port", async () => {
      const other = new SandboxServer({ database: await emptyDatabase(), port: 0 });
      const { url, port } = await other.start();
      assert.equal((await fetch(`${url}/`)).status, 200);

      await other.stop();
      await assert.rejects(fetch(`${url}/`));

      const reuse = new SandboxServer({ database: await emptyDatabase(), port });
      assert.equal((await reuse.start()).port, port);
      await reuse.stop();
    });

    it("can be stopped twice and restarted", async () => {
      const other = new SandboxServer({ database: await emptyDatabase(), port: 0 });
      await other.stop();
      await other.start();
      await other.stop();
      await other.stop();

      const { url } = await other.start();
      assert.equal((await fetch(`${url}/`)).status, 200);
      await other.stop();
    });

    it("rejects a second start and a port that is already in use", async () => {
      await assert.rejects(server.start(), /already started/);

      const port = Number(new URL(baseUrl).port);
      const clash = new SandboxServer({ database: await emptyDatabase(), port });
      await assert.rejects(clash.start(), { code: "EADDRINUSE" });
      await clash.stop();
    });
  });
});
