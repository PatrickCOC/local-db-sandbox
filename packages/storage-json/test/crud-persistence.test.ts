import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Database } from "../../core/src/index.ts";
import { JsonStorageAdapter } from "../src/index.ts";

const fixturePath = join(import.meta.dirname, "../../../examples/basic/db.json");

describe("CRUD persisted through the JSON storage adapter", () => {
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

  it("writes insert, replace, patch, and delete back to the file", async () => {
    const db = await Database.open(new JsonStorageAdapter(dbPath));

    await db.insert("users", { name: "Sam", active: true });
    await db.replace("users", 1, { name: "Pat" });
    await db.patch("orders", 1, { status: "refunded" });
    await db.remove("users", 2);

    const reopened = await Database.open(new JsonStorageAdapter(dbPath));
    assert.deepEqual(reopened.findAll("users"), [
      { id: 1, name: "Pat" },
      { id: 3, name: "Sam", active: true },
    ]);
    assert.deepEqual(reopened.findById("orders", 1), { id: 1, userId: 1, total: 42.5, status: "refunded" });

    const document = JSON.parse(await readFile(dbPath, "utf8"));
    assert.deepEqual(document.$config, { routes: {} });
  });

  it("does not touch the file when an operation is rejected", async () => {
    const before = await readFile(dbPath, "utf8");
    const db = await Database.open(new JsonStorageAdapter(dbPath));

    await assert.rejects(db.insert("users", { id: 1, name: "Dup" }));
    await assert.rejects(db.remove("users", 99));
    await assert.rejects(db.insert("missing", { id: 1 }));

    assert.equal(await readFile(dbPath, "utf8"), before);
  });
});
