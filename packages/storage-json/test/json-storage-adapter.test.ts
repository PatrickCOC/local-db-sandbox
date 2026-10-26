import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { StorageAdapter } from "../../core/src/index.ts";
import { JsonStorageAdapter, JsonStorageError } from "../src/index.ts";

const fixturePath = join(import.meta.dirname, "../../../examples/basic/db.json");

describe("JsonStorageAdapter", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-"));
    dbPath = join(dir, "db.json");
    await copyFile(fixturePath, dbPath);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeDb(content: string): Promise<void> {
    await writeFile(dbPath, content, "utf8");
  }

  describe("load", () => {
    it("loads the example fixture into core state", async () => {
      const storage: StorageAdapter = new JsonStorageAdapter(dbPath);
      const state = await storage.load();

      assert.deepEqual(state.meta, { version: 1 });
      assert.deepEqual(Object.keys(state.collections), ["users", "orders"]);
      assert.deepEqual(state.collections.users, [
        { id: 1, name: "Patrick", active: true },
        { id: 2, name: "Alex", active: false },
      ]);
      assert.equal(state.collections.orders?.length, 1);
    });

    it("defaults the version to 1 when $meta is absent", async () => {
      await writeDb('{ "data": { "users": [] } }');
      const state = await new JsonStorageAdapter(dbPath).load();
      assert.deepEqual(state, { meta: { version: 1 }, collections: { users: [] } });
    });

    it("rejects a missing file", async () => {
      const storage = new JsonStorageAdapter(join(dir, "missing.json"));
      await assert.rejects(storage.load(), JsonStorageError);
    });

    it("rejects malformed JSON", async () => {
      await writeDb("{ not json");
      await assert.rejects(new JsonStorageAdapter(dbPath).load(), JsonStorageError);
    });

    const invalidDocuments: Record<string, string> = {
      "a non-object document": "[]",
      "a missing data key": '{ "$meta": { "version": 1 } }',
      "a non-object data key": '{ "data": [] }',
      "a non-array collection": '{ "data": { "users": {} } }',
      "a non-object row": '{ "data": { "users": [1] } }',
      "a null row": '{ "data": { "users": [null] } }',
      "a non-numeric version": '{ "$meta": { "version": "1" }, "data": {} }',
      "a version that is not a whole number": '{ "$meta": { "version": 1.5 }, "data": {} }',
      "a version below 1": '{ "$meta": { "version": 0 }, "data": {} }',
      "a $meta without a version": '{ "$meta": {}, "data": {} }',
    };
    for (const [label, content] of Object.entries(invalidDocuments)) {
      it(`rejects ${label}`, async () => {
        await writeDb(content);
        await assert.rejects(new JsonStorageAdapter(dbPath).load(), JsonStorageError);
      });
    }
  });

  describe("save", () => {
    it("persists changes that a fresh adapter can load", async () => {
      const storage = new JsonStorageAdapter(dbPath);
      const state = await storage.load();

      state.collections.users?.push({ id: 3, name: "Sam", active: true });
      state.collections.products = [{ id: 1, title: "Widget" }];
      await storage.save(state);

      const reloaded = await new JsonStorageAdapter(dbPath).load();
      assert.deepEqual(reloaded, state);
    });

    it("writes the documented JSON document shape", async () => {
      const storage = new JsonStorageAdapter(dbPath);
      await storage.save({ meta: { version: 1 }, collections: { users: [{ id: 1 }] } });

      const document = JSON.parse(await readFile(dbPath, "utf8"));
      assert.deepEqual(document, { $meta: { version: 1 }, data: { users: [{ id: 1 }] } });
    });

    it("states the format it writes, whatever version the state carries", async () => {
      const storage = new JsonStorageAdapter(dbPath);
      await storage.save({ meta: { version: 7 }, collections: {} });
      assert.deepEqual(JSON.parse(await readFile(dbPath, "utf8")).$meta, { version: 1 });
    });

    it("preserves other top-level keys such as $config from the loaded file", async () => {
      const storage = new JsonStorageAdapter(dbPath);
      const state = await storage.load();
      state.collections.orders = [];
      await storage.save(state);

      const document = JSON.parse(await readFile(dbPath, "utf8"));
      assert.deepEqual(document.$config, { routes: {} });
      assert.deepEqual(document.data.orders, []);
    });

    it("creates the file when it does not exist yet", async () => {
      const newPath = join(dir, "new.json");
      const state = { meta: { version: 1 }, collections: { users: [] } };
      await new JsonStorageAdapter(newPath).save(state);

      assert.deepEqual(await new JsonStorageAdapter(newPath).load(), state);
    });

    it("leaves no temporary file behind", async () => {
      const storage = new JsonStorageAdapter(dbPath);
      await storage.save(await storage.load());
      assert.deepEqual(await readdir(dir), ["db.json"]);
    });

    it("rejects when the target directory does not exist", async () => {
      const storage = new JsonStorageAdapter(join(dir, "nope", "db.json"));
      await assert.rejects(
        storage.save({ meta: { version: 1 }, collections: {} }),
        JsonStorageError,
      );
    });
  });
});
