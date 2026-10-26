import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Database, SandboxError } from "../src/index.ts";
import type { DatabaseState, QuerySpec, SandboxErrorCode, StorageAdapter } from "../src/index.ts";

const state: DatabaseState = {
  meta: { version: 1 },
  collections: {
    users: [
      { id: 1, name: "Patrick", age: 30, active: true, team: "a" },
      { id: 2, name: "alex", age: 4, active: false, team: "b" },
      { id: 3, name: "Sam", age: 25, active: true, team: "a" },
      { id: 4, name: "Kim", active: true, team: null },
      { id: 5, name: "Bo", age: 25, active: false, team: "b" },
    ],
    empty: [],
  },
};

const storage: StorageAdapter = {
  load: async () => structuredClone(state),
  save: async () => {},
};

function hasCode(code: SandboxErrorCode) {
  return (error: unknown) => error instanceof SandboxError && error.code === code;
}

describe("Database.query", () => {
  let db: Database;
  const ids = (spec: Omit<QuerySpec, "collection">) =>
    db.query({ collection: "users", ...spec }).rows.map((row) => row.id);

  beforeEach(async () => {
    db = await Database.open(storage);
  });

  it("returns every row and the total when no options are given", () => {
    const result = db.query({ collection: "users" });
    assert.deepEqual(result.rows, db.findAll("users"));
    assert.equal(result.total, 5);
    assert.deepEqual(db.query({ collection: "empty" }), { rows: [], total: 0 });
  });

  it("returns copies that cannot change stored state", () => {
    (db.query({ collection: "users" }).rows[0] as { name: string }).name = "changed";
    assert.equal(db.findById("users", 1).name, "Patrick");
  });

  describe("filters", () => {
    it("matches by equality", () => {
      assert.deepEqual(ids({ filters: [{ field: "team", op: "eq", value: "a" }] }), [1, 3]);
      assert.deepEqual(ids({ filters: [{ field: "active", op: "eq", value: false }] }), [2, 5]);
    });

    it("matches scalars by string form", () => {
      assert.deepEqual(ids({ filters: [{ field: "active", op: "eq", value: "true" }] }), [1, 3, 4]);
      assert.deepEqual(ids({ filters: [{ field: "age", op: "eq", value: "25" }] }), [3, 5]);
    });

    it("requires every filter to match", () => {
      assert.deepEqual(
        ids({
          filters: [
            { field: "active", op: "eq", value: true },
            { field: "team", op: "eq", value: "a" },
            { field: "age", op: "eq", value: 25 },
          ],
        }),
        [3],
      );
    });

    it("matches nothing for unknown fields or absent values", () => {
      assert.deepEqual(ids({ filters: [{ field: "nope", op: "eq", value: "x" }] }), []);
      assert.deepEqual(ids({ filters: [{ field: "constructor", op: "eq", value: "x" }] }), []);
      assert.deepEqual(ids({ filters: [{ field: "team", op: "eq", value: "null" }] }), []);
    });
  });

  describe("sort", () => {
    it("sorts numbers numerically in either direction", () => {
      assert.deepEqual(ids({ sort: [{ field: "id", direction: "desc" }] }), [5, 4, 3, 2, 1]);
      assert.deepEqual(ids({ sort: [{ field: "age", direction: "asc" }] }), [2, 3, 5, 1, 4]);
    });

    it("sorts strings by code unit order", () => {
      assert.deepEqual(ids({ sort: [{ field: "name", direction: "asc" }] }), [5, 4, 1, 3, 2]);
    });

    it("places rows without a value last in either direction", () => {
      assert.deepEqual(ids({ sort: [{ field: "age", direction: "desc" }] }), [1, 3, 5, 2, 4]);
      assert.deepEqual(ids({ sort: [{ field: "team", direction: "desc" }] }), [2, 5, 1, 3, 4]);
    });

    it("uses later sort entries to break ties", () => {
      assert.deepEqual(
        ids({
          sort: [
            { field: "team", direction: "asc" },
            { field: "id", direction: "desc" },
          ],
        }),
        [3, 1, 5, 2, 4],
      );
    });

    it("does not reorder stored rows", () => {
      db.query({ collection: "users", sort: [{ field: "id", direction: "desc" }] });
      assert.deepEqual(ids({}), [1, 2, 3, 4, 5]);
    });
  });

  describe("pagination", () => {
    it("applies offset and limit after filtering and sorting", () => {
      const result = db.query({
        collection: "users",
        filters: [{ field: "active", op: "eq", value: true }],
        sort: [{ field: "id", direction: "desc" }],
        offset: 1,
        limit: 1,
      });
      assert.deepEqual(result.rows.map((row) => row.id), [3]);
      assert.equal(result.total, 3);
    });

    it("handles limit zero, offset only, and ranges past the end", () => {
      assert.deepEqual(ids({ limit: 0 }), []);
      assert.deepEqual(ids({ offset: 3 }), [4, 5]);
      assert.deepEqual(ids({ offset: 4, limit: 10 }), [5]);
      assert.deepEqual(ids({ offset: 99 }), []);
    });
  });

  describe("invalid input", () => {
    it("rejects an unknown collection", () => {
      assert.throws(() => db.query({ collection: "nope" }), hasCode("COLLECTION_NOT_FOUND"));
    });

    it("rejects invalid offset and limit", () => {
      for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => ids({ limit: value }), hasCode("INVALID_QUERY"));
        assert.throws(() => ids({ offset: value }), hasCode("INVALID_QUERY"));
      }
    });

    it("rejects malformed filters and sort entries", () => {
      assert.throws(() => ids({ filters: [{ field: "", op: "eq", value: 1 }] }), hasCode("INVALID_QUERY"));
      assert.throws(() => ids({ filters: [{ field: "a", op: "gt" as never, value: 1 }] }), hasCode("INVALID_QUERY"));
      assert.throws(() => ids({ sort: [{ field: "", direction: "asc" }] }), hasCode("INVALID_QUERY"));
      assert.throws(() => ids({ sort: [{ field: "a", direction: "up" as never }] }), hasCode("INVALID_QUERY"));
    });
  });
});
