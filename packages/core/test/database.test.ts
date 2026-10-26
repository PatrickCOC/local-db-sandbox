import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Database, SandboxError } from "../src/index.ts";
import type { DatabaseState, SandboxErrorCode, StorageAdapter } from "../src/index.ts";

class MemoryStorage implements StorageAdapter {
  saved: DatabaseState[] = [];
  failNextSave = false;
  #state: DatabaseState;

  constructor(state: DatabaseState) {
    this.#state = state;
  }

  async load(): Promise<DatabaseState> {
    return structuredClone(this.#state);
  }

  async save(state: DatabaseState): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("disk full");
    }
    this.#state = structuredClone(state);
    this.saved.push(this.#state);
  }
}

function hasCode(code: SandboxErrorCode) {
  return (error: unknown) => error instanceof SandboxError && error.code === code;
}

describe("Database", () => {
  let storage: MemoryStorage;
  let db: Database;

  beforeEach(async () => {
    storage = new MemoryStorage({
      meta: { version: 1 },
      collections: {
        users: [
          { id: 1, name: "Patrick", active: true },
          { id: 2, name: "Alex", active: false },
        ],
        orders: [],
        tags: [{ id: "red", label: "Red" }],
      },
    });
    db = await Database.open(storage);
  });

  describe("reads", () => {
    it("lists collections", () => {
      assert.deepEqual(db.listCollections(), ["users", "orders", "tags"]);
    });

    it("reads all rows in a collection", () => {
      assert.deepEqual(db.findAll("users"), [
        { id: 1, name: "Patrick", active: true },
        { id: 2, name: "Alex", active: false },
      ]);
      assert.deepEqual(db.findAll("orders"), []);
    });

    it("reads a row by id", () => {
      assert.deepEqual(db.findById("users", 2), { id: 2, name: "Alex", active: false });
      assert.deepEqual(db.findById("tags", "red"), { id: "red", label: "Red" });
    });

    it("matches numeric and string forms of the same id", () => {
      assert.deepEqual(db.findById("users", "2"), db.findById("users", 2));
    });

    it("returns copies that cannot change stored state", () => {
      const rows = db.findAll("users");
      rows.pop();
      (rows[0] as { name: string }).name = "changed";
      db.findById("users", 2).name = "changed";

      assert.equal(db.findAll("users").length, 2);
      assert.equal(db.findById("users", 1).name, "Patrick");
      assert.equal(db.findById("users", 2).name, "Alex");
    });
  });

  describe("insert", () => {
    it("inserts a row and persists it", async () => {
      const row = await db.insert("users", { id: 10, name: "Sam" });

      assert.deepEqual(row, { id: 10, name: "Sam" });
      assert.deepEqual(db.findById("users", 10), row);
      assert.deepEqual(storage.saved.at(-1)?.collections.users?.at(-1), row);
    });

    it("assigns the next integer id when none is given", async () => {
      assert.deepEqual(await db.insert("users", { name: "Sam" }), { id: 3, name: "Sam" });
      assert.deepEqual(await db.insert("orders", { total: 5 }), { id: 1, total: 5 });
      assert.deepEqual(await db.insert("tags", { label: "Blue" }), { id: 1, label: "Blue" });
    });

    it("does not keep a reference to the caller's object", async () => {
      const input = { id: 10, name: "Sam" };
      await db.insert("users", input);
      input.name = "changed";
      assert.equal(db.findById("users", 10).name, "Sam");
    });

    it("rejects a duplicate id", async () => {
      await assert.rejects(db.insert("users", { id: 1, name: "Dup" }), hasCode("DUPLICATE_ID"));
      await assert.rejects(db.insert("users", { id: "1", name: "Dup" }), hasCode("DUPLICATE_ID"));
      assert.equal(db.findAll("users").length, 2);
      assert.equal(storage.saved.length, 0);
    });

    it("rejects an invalid id", async () => {
      for (const id of [null, "", true, {}, Number.NaN]) {
        await assert.rejects(db.insert("users", { id }), hasCode("INVALID_ROW"));
      }
    });

    it("rejects a row that is not an object", async () => {
      for (const row of [null, [], "x", 1]) {
        await assert.rejects(db.insert("users", row as never), hasCode("INVALID_ROW"));
      }
    });
  });

  describe("replace", () => {
    it("replaces all fields, keeps the id, and persists", async () => {
      const row = await db.replace("users", 1, { name: "Pat" });

      assert.deepEqual(row, { id: 1, name: "Pat" });
      assert.deepEqual(db.findById("users", 1), row);
      assert.deepEqual(storage.saved.at(-1)?.collections.users?.[0], row);
    });

    it("keeps the stored id type when addressed by its other form", async () => {
      assert.deepEqual(await db.replace("users", "1", { id: "1", name: "Pat" }), { id: 1, name: "Pat" });
    });

    it("rejects an attempt to change the id", async () => {
      await assert.rejects(db.replace("users", 1, { id: 9, name: "Pat" }), hasCode("INVALID_ROW"));
      assert.equal(db.findById("users", 1).name, "Patrick");
    });
  });

  describe("patch", () => {
    it("merges fields, keeps the rest, and persists", async () => {
      const row = await db.patch("users", 2, { active: true, role: "admin" });

      assert.deepEqual(row, { id: 2, name: "Alex", active: true, role: "admin" });
      assert.deepEqual(db.findById("users", 2), row);
      assert.deepEqual(storage.saved.at(-1)?.collections.users?.[1], row);
    });

    it("rejects an attempt to change the id", async () => {
      await assert.rejects(db.patch("users", 2, { id: 1 }), hasCode("INVALID_ROW"));
    });

    it("rejects changes that are not an object", async () => {
      await assert.rejects(db.patch("users", 2, [] as never), hasCode("INVALID_ROW"));
    });
  });

  describe("remove", () => {
    it("deletes the row, returns it, and persists", async () => {
      const row = await db.remove("users", 1);

      assert.deepEqual(row, { id: 1, name: "Patrick", active: true });
      assert.deepEqual(db.findAll("users"), [{ id: 2, name: "Alex", active: false }]);
      assert.deepEqual(storage.saved.at(-1)?.collections.users, db.findAll("users"));
    });
  });

  describe("unknown collection", () => {
    it("is rejected by every operation without creating it", async () => {
      const expected = hasCode("COLLECTION_NOT_FOUND");
      for (const name of ["nope", "constructor", "__proto__"]) {
        assert.throws(() => db.findAll(name), expected);
        assert.throws(() => db.findById(name, 1), expected);
        await assert.rejects(db.insert(name, { id: 1 }), expected);
        await assert.rejects(db.replace(name, 1, {}), expected);
        await assert.rejects(db.patch(name, 1, {}), expected);
        await assert.rejects(db.remove(name, 1), expected);
      }
      assert.deepEqual(db.listCollections(), ["users", "orders", "tags"]);
      assert.equal(storage.saved.length, 0);
    });
  });

  describe("missing id", () => {
    it("is rejected by read, replace, patch, and delete", async () => {
      const expected = hasCode("ROW_NOT_FOUND");
      assert.throws(() => db.findById("users", 99), expected);
      await assert.rejects(db.replace("users", 99, { name: "x" }), expected);
      await assert.rejects(db.patch("users", 99, { name: "x" }), expected);
      await assert.rejects(db.remove("users", 99), expected);
      assert.equal(storage.saved.length, 0);
    });
  });

  describe("persistence", () => {
    it("leaves state unchanged when the save fails", async () => {
      storage.failNextSave = true;
      await assert.rejects(db.insert("users", { id: 10 }), /disk full/);
      assert.equal(db.findAll("users").length, 2);

      await db.insert("users", { id: 10 });
      assert.equal(db.findAll("users").length, 3);
    });

    it("applies overlapping mutations in order without losing any", async () => {
      const inserted = await Promise.all([
        db.insert("orders", { n: "a" }),
        db.insert("orders", { n: "b" }),
        db.insert("orders", { n: "c" }),
      ]);

      assert.deepEqual(inserted.map((row) => row.id), [1, 2, 3]);
      assert.deepEqual(db.findAll("orders"), inserted);
      assert.deepEqual((await Database.open(storage)).findAll("orders"), inserted);
    });
  });

  describe("idFields", () => {
    beforeEach(async () => {
      storage = new MemoryStorage({
        meta: { version: 1 },
        collections: { categories: [{ code: "a", label: "A" }], tickets: [{ number: 7 }], users: [{ id: 1 }] },
      });
      db = await Database.open(storage, { idFields: { categories: "code", tickets: "number" } });
    });

    it("identifies rows by the configured field and other collections by id", async () => {
      assert.equal(db.idField("categories"), "code");
      assert.equal(db.idField("users"), "id");
      assert.deepEqual(db.findById("categories", "a"), { code: "a", label: "A" });
      assert.deepEqual(db.findById("users", 1), { id: 1 });

      assert.deepEqual(await db.patch("categories", "a", { label: "B" }), { code: "a", label: "B" });
      assert.deepEqual(await db.replace("categories", "a", { label: "C" }), { label: "C", code: "a" });
      assert.deepEqual(await db.remove("categories", "a"), { label: "C", code: "a" });
      assert.deepEqual(db.findAll("categories"), []);
    });

    it("assigns, validates, and protects the configured field instead of id", async () => {
      assert.deepEqual(await db.insert("tickets", { title: "x" }), { title: "x", number: 8 });
      // `id` is an ordinary field in such a collection.
      assert.deepEqual(await db.insert("categories", { code: "b", id: 1 }), { code: "b", id: 1 });
      assert.deepEqual(await db.insert("categories", { code: "c", id: 1 }), { code: "c", id: 1 });

      await assert.rejects(db.insert("categories", { code: "b" }), hasCode("DUPLICATE_ID"));
      await assert.rejects(db.insert("categories", { code: "" }), /Row "code" must be/);
      await assert.rejects(db.patch("categories", "b", { code: "z" }), /Row "code" cannot be changed/);
      assert.throws(() => db.findById("categories", "nope"), /Row with code nope does not exist/);
    });

    it("names the configured field in operation statements", async () => {
      const statements: (string | undefined)[] = [];
      db.subscribe((event) => statements.push(event.statement));
      db.findById("categories", "a");
      await db.insert("tickets", { title: "x" });
      await db.patch("tickets", 8, { title: "y" });
      await db.remove("tickets", 8);
      assert.deepEqual(statements, [
        "SELECT * FROM categories WHERE code = 'a'",
        "INSERT INTO tickets (number, title) VALUES (8, 'x')",
        "UPDATE tickets SET title = 'y' WHERE number = 8",
        "DELETE FROM tickets WHERE number = 8",
      ]);
    });
  });
});
