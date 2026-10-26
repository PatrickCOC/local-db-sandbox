import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Database } from "../src/index.ts";
import type { DatabaseState, OperationEvent, StorageAdapter } from "../src/index.ts";

const STEP_MS = 5;

describe("operation events", () => {
  let db: Database;
  let events: OperationEvent[];
  let failSave: boolean;

  beforeEach(async () => {
    failSave = false;
    const state: DatabaseState = {
      meta: { version: 1 },
      collections: {
        users: [
          { id: 1, name: "Patrick", active: true },
          { id: 2, name: "Alex", active: false },
          { id: 3, name: "Sam", active: true },
        ],
        "odd name": [],
      },
    };
    const storage: StorageAdapter = {
      load: async () => structuredClone(state),
      save: async () => {
        if (failSave) {
          throw new Error("disk full");
        }
      },
    };
    // Each reading advances the clock, so every operation measures exactly one step.
    let time = 0;
    db = await Database.open(storage, { now: () => (time += STEP_MS) });
    events = [];
    db.subscribe((event) => events.push(event));
  });

  const only = (): OperationEvent => {
    assert.equal(events.length, 1);
    return events[0] as OperationEvent;
  };

  describe("reads", () => {
    it("findAll emits a SELECT with rows returned", () => {
      db.findAll("users");
      assert.deepEqual(only(), {
        operation: "SELECT",
        collection: "users",
        statement: "SELECT * FROM users",
        rows: 3,
        localExecutionMs: STEP_MS,
      });
    });

    it("findById emits a SELECT for one row using the stored id", () => {
      db.findById("users", "2");
      assert.deepEqual(only(), {
        operation: "SELECT",
        collection: "users",
        statement: "SELECT * FROM users WHERE id = 2",
        rows: 1,
        localExecutionMs: STEP_MS,
      });
    });

    it("query describes filters, sort, limit, and offset and counts returned rows", () => {
      db.query({
        collection: "users",
        filters: [
          { field: "active", op: "eq", value: "true" },
          { field: "name", op: "eq", value: "O'Neil" },
        ],
        sort: [
          { field: "name", direction: "asc" },
          { field: "id", direction: "desc" },
        ],
        limit: 1,
        offset: 0,
      });
      const event = only();
      assert.equal(
        event.statement,
        "SELECT * FROM users WHERE active = 'true' AND name = 'O''Neil' ORDER BY name ASC, id DESC LIMIT 1 OFFSET 0",
      );
      assert.equal(event.rows, 0);
    });

    it("counts rows after pagination", () => {
      db.query({ collection: "users", filters: [{ field: "active", op: "eq", value: true }], limit: 1 });
      const event = only();
      assert.equal(event.rows, 1);
      assert.equal(event.statement, "SELECT * FROM users WHERE active = true LIMIT 1");
    });

    it("does not emit for listCollections", () => {
      db.listCollections();
      assert.equal(events.length, 0);
    });
  });

  describe("writes", () => {
    it("insert emits an INSERT with the assigned id", async () => {
      await db.insert("users", { name: "Kim", active: false, tags: ["a"], note: null });
      assert.deepEqual(only(), {
        operation: "INSERT",
        collection: "users",
        statement: "INSERT INTO users (id, name, active, tags, note) VALUES (4, 'Kim', false, '[\"a\"]', NULL)",
        rows: 1,
        localExecutionMs: STEP_MS,
      });
    });

    it("replace and patch emit UPDATE with the changed fields", async () => {
      await db.replace("users", 1, { id: 1, name: "Pat" });
      await db.patch("users", "2", { active: true });
      await db.replace("users", 3, {});
      assert.deepEqual(
        events.map((event) => [event.operation, event.rows, event.statement]),
        [
          ["UPDATE", 1, "UPDATE users SET name = 'Pat' WHERE id = 1"],
          ["UPDATE", 1, "UPDATE users SET active = true WHERE id = 2"],
          ["UPDATE", 1, "UPDATE users SET /* no fields */ WHERE id = 3"],
        ],
      );
    });

    it("remove emits a DELETE", async () => {
      await db.remove("users", 3);
      assert.deepEqual(only(), {
        operation: "DELETE",
        collection: "users",
        statement: "DELETE FROM users WHERE id = 3",
        rows: 1,
        localExecutionMs: STEP_MS,
      });
    });

    it("quotes unusual names and shortens long values", async () => {
      await db.insert("odd name", { "first name": "x".repeat(200) });
      const { statement } = only();
      assert.equal(statement, `INSERT INTO "odd name" (id, "first name") VALUES (1, '${"x".repeat(60)}...')`);
    });
  });

  describe("failures", () => {
    it("emit zero rows and the error code", async () => {
      assert.throws(() => db.findAll("nope"));
      assert.throws(() => db.findById("users", 99));
      assert.throws(() => db.query({ collection: "users", limit: -1 }));
      await assert.rejects(db.insert("users", { id: 1 }));
      await assert.rejects(db.patch("users", 99, { name: "x" }));
      await assert.rejects(db.remove("nope", 1));
      await assert.rejects(db.insert("users", null as never));

      assert.deepEqual(
        events.map((event) => [event.operation, event.collection, event.rows, event.errorCode, event.statement]),
        [
          ["SELECT", "nope", 0, "COLLECTION_NOT_FOUND", "SELECT * FROM nope"],
          ["SELECT", "users", 0, "ROW_NOT_FOUND", "SELECT * FROM users WHERE id = 99"],
          ["SELECT", "users", 0, "INVALID_QUERY", "SELECT * FROM users LIMIT -1"],
          ["INSERT", "users", 0, "DUPLICATE_ID", "INSERT INTO users (id) VALUES (1)"],
          ["UPDATE", "users", 0, "ROW_NOT_FOUND", "UPDATE users SET name = 'x' WHERE id = 99"],
          ["DELETE", "nope", 0, "COLLECTION_NOT_FOUND", "DELETE FROM nope WHERE id = 1"],
          ["INSERT", "users", 0, "INVALID_ROW", "INSERT INTO users DEFAULT VALUES"],
        ],
      );
      assert.ok(events.every((event) => event.localExecutionMs === STEP_MS));
    });

    it("report a failed save as a storage error", async () => {
      failSave = true;
      await assert.rejects(db.insert("users", { name: "Kim" }), /disk full/);
      const event = only();
      assert.equal(event.errorCode, "STORAGE_ERROR");
      assert.equal(event.rows, 0);
      assert.equal(event.statement, "INSERT INTO users (id, name) VALUES (4, 'Kim')");
    });
  });

  describe("subscriptions", () => {
    it("emits one event per operation, in order, to every listener", async () => {
      const second: OperationEvent[] = [];
      db.subscribe((event) => second.push(event));

      await Promise.all([db.insert("users", { name: "a" }), db.insert("users", { name: "b" })]);
      db.findAll("users");

      assert.deepEqual(events.map((event) => event.operation), ["INSERT", "INSERT", "SELECT"]);
      assert.deepEqual(second, events);
      assert.equal(events[2]?.rows, 5);
    });

    it("stops after unsubscribe", () => {
      const seen: OperationEvent[] = [];
      const unsubscribe = db.subscribe((event) => seen.push(event));
      db.findAll("users");
      unsubscribe();
      db.findAll("users");
      assert.equal(seen.length, 1);
      assert.equal(events.length, 2);
    });

    it("gives each listener its own copy and survives a throwing listener", async () => {
      db.subscribe((event) => {
        event.rows = -1;
        throw new Error("listener failed");
      });
      const later: OperationEvent[] = [];
      db.subscribe((event) => later.push(event));

      assert.equal((await db.insert("users", { name: "Kim" })).id, 4);
      assert.equal(db.findAll("users").length, 4);
      assert.deepEqual(later.map((event) => event.rows), [1, 4]);
    });

    it("measures real time with the default clock", async () => {
      const real = await Database.open({
        load: async () => ({ meta: { version: 1 }, collections: { users: [] } }),
        save: () => new Promise((resolve) => setTimeout(resolve, 30)),
      });
      const seen: OperationEvent[] = [];
      real.subscribe((event) => seen.push(event));

      real.findAll("users");
      await real.insert("users", { name: "Kim" });

      const [read, write] = seen as [OperationEvent, OperationEvent];
      assert.ok(read.localExecutionMs >= 0 && read.localExecutionMs < 20);
      assert.ok(write.localExecutionMs >= 20, `save time is included, got ${write.localExecutionMs}`);
    });
  });
});
