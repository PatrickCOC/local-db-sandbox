import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteRuntime } from "../../runtime/src/index.ts";
import type { TableSchema } from "../../runtime/src/index.ts";
import { AccessError, LocalRuntimeAccess, ReadOnlyAccess } from "../src/index.ts";
import type { AccessErrorCode } from "../src/index.ts";
import { DATA, IDENTITY, MemoryStorage, open } from "./support/fixture.ts";

/*
 * `clear` (D-051): every row of the tables named, deleted in one
 * transaction; the tables, their definitions, and their numbering stay.
 * Nothing outside them is changed: a table that is not named and whose rows
 * refer to one that is refuses the request.
 */

async function refused(promise: Promise<unknown>, code: AccessErrorCode, message: RegExp = /./): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AccessError, String(error));
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
}

const count = (runtime: SqliteRuntime, table: string): number => Number(runtime.execute(`SELECT COUNT(*) AS n FROM "${table}"`).rows[0]?.n);

describe("access: clear", () => {
  it("clears one table, several, or all; keeps every definition; saves once", async () => {
    const { access, runtime, storage } = await open();
    try {
      const schema = structuredClone(runtime.schema);
      assert.deepEqual(await access.clear({ tables: ["notes"] }), { tables: [{ table: "notes", rows: 3 }], rows: 3 });
      assert.deepEqual([count(runtime, "notes"), count(runtime, "users"), count(runtime, "orders")], [0, 25, 2]);
      assert.deepEqual(storage.rows("notes"), []);
      assert.deepEqual(storage.rows("users"), DATA().users);
      // Several, a table and the one that refers to it, given in any order.
      assert.deepEqual(await access.clear({ tables: ["users", "orders"] }), { tables: [{ table: "users", rows: 25 }, { table: "orders", rows: 2 }], rows: 27 });
      assert.deepEqual(await access.clear({ tables: ["users", "orders", "memberships", "notes"] }), { tables: [{ table: "users", rows: 0 }, { table: "orders", rows: 0 }, { table: "memberships", rows: 3 }, { table: "notes", rows: 0 }], rows: 3 });
      assert.deepEqual(runtime.schema, schema);
      assert.deepEqual(runtime.snapshot().collections, { users: [], orders: [], memberships: [], notes: [] });
      // One save for each request that changed something; an empty table changes nothing worth a save.
      assert.equal(storage.saved.length, 3);
    } finally {
      runtime.close();
    }
  });

  it("goes on numbering after the last number it gave: an id is not given again", async () => {
    const { access, runtime } = await open();
    try {
      await access.clear({ tables: ["users", "orders"] });
      assert.deepEqual(await access.insert({ table: "users", values: { name: "after the clear" } }), { affectedRows: 1, lastInsertId: 26 });
    } finally {
      runtime.close();
    }
  });

  it("refuses a table whose rows another table that is not chosen refers to, and changes nothing", async () => {
    const { access, runtime, storage } = await open();
    try {
      await refused(
        access.clear({ tables: ["users"] }),
        "CONSTRAINT",
        /^Nothing was cleared: 2 rows of "orders" \(userId\) refer to "users", which is not chosen\. Clearing would delete or change those rows by their foreign key, or leave them referring to nothing\. Choose those tables too, or clear them first\.$/,
      );
      assert.deepEqual([count(runtime, "users"), count(runtime, "orders"), storage.saved.length], [25, 2, 0]);
      // Rows that refer to nothing (NULL) hold no foreign key: then nothing outside the tables chosen is touched.
      await access.update({ table: "orders", key: { number: "A-1" }, values: { userId: null } });
      await access.update({ table: "orders", key: { number: "A-2" }, values: { userId: null } });
      assert.deepEqual((await access.clear({ tables: ["users"] })).rows, 25);
      assert.deepEqual(storage.rows("orders"), [
        { number: "A-1", userId: null, total: 100 },
        { number: "A-2", userId: null, total: 250 },
      ]);
    } finally {
      runtime.close();
    }
  });

  it("clears tables that refer to one another in a circle, and to themselves; a part of the circle alone is refused", async () => {
    const schema: TableSchema[] = [
      { name: "a", columns: [{ name: "id", type: "integer", nullable: false, primary: true }, { name: "b_id", type: "integer", nullable: true, primary: false, references: { table: "b", column: "id" } }] },
      { name: "b", columns: [{ name: "id", type: "integer", nullable: false, primary: true }, { name: "a_id", type: "integer", nullable: true, primary: false, references: { table: "a", column: "id" } }] },
      { name: "nodes", columns: [{ name: "id", type: "integer", nullable: false, primary: true }, { name: "parent", type: "integer", nullable: true, primary: false, references: { table: "nodes", column: "id" } }] },
      { name: "pairs", columns: [{ name: "x", type: "integer", nullable: false, primary: true }, { name: "y", type: "integer", nullable: false, primary: true }] },
      {
        name: "pair_notes",
        columns: [{ name: "x", type: "integer", nullable: true, primary: false }, { name: "y", type: "integer", nullable: true, primary: false }, { name: "text", type: "text", nullable: true, primary: false }],
        foreignKeys: [{ columns: ["x", "y"], references: { table: "pairs", columns: ["x", "y"] } }],
      },
    ];
    const storage = new MemoryStorage({
      a: [{ id: 1, b_id: 10 }],
      b: [{ id: 10, a_id: 1 }],
      nodes: [{ id: 1, parent: null }, { id: 2, parent: 1 }, { id: 3, parent: 2 }],
      pairs: [{ x: 1, y: 2 }],
      pair_notes: [{ x: 1, y: 2, text: "refers" }, { x: 1, y: null, text: "refers to nothing" }],
    });
    const runtime = await SqliteRuntime.open({ schema, storage });
    const access = new LocalRuntimeAccess({ runtime, identity: IDENTITY });
    try {
      await refused(access.clear({ tables: ["a"] }), "CONSTRAINT", /1 row of "b" \(a_id\) refers to "a"/);
      assert.deepEqual((await access.clear({ tables: ["a", "b"] })).rows, 2);
      assert.deepEqual((await access.clear({ tables: ["nodes"] })).rows, 3);
      // A foreign key over two columns: one row refers (both set), one does not (one NULL).
      await refused(access.clear({ tables: ["pairs"] }), "CONSTRAINT", /^Nothing was cleared: 1 row of "pair_notes" \(x, y\) refers to "pairs"/);
      assert.deepEqual((await access.clear({ tables: ["pairs", "pair_notes"] })).rows, 3);
      assert.deepEqual(runtime.snapshot().collections, { a: [], b: [], nodes: [], pairs: [], pair_notes: [] });
    } finally {
      runtime.close();
    }
  });

  it("leaves everything as it was when what was cleared cannot be saved", async () => {
    const { access, runtime, storage } = await open();
    try {
      storage.failNextSave = new Error("disk full");
      await refused(access.clear({ tables: ["users", "orders", "notes"] }), "PERSISTENCE", /The change could not be written to the database, and was taken back: disk full/);
      assert.deepEqual([count(runtime, "users"), count(runtime, "orders"), count(runtime, "notes")], [25, 2, 3]);
      assert.equal(runtime.inTransaction, false);
      assert.deepEqual(storage.saved, []);
      // And it works afterwards.
      assert.equal((await access.clear({ tables: ["notes"] })).rows, 3);
    } finally {
      runtime.close();
    }
  });

  it("refuses what is not a request, a table that is not there, a read-only access, and a busy runtime", async () => {
    const { access, runtime } = await open();
    try {
      await refused(access.clear({ tables: [] }), "INVALID_REQUEST", /"tables" must name at least one table, each once/);
      await refused(access.clear({ tables: ["notes", "notes"] }), "INVALID_REQUEST");
      await refused(access.clear({} as { tables: string[] }), "INVALID_REQUEST");
      await refused(access.clear({ tables: ["notes", "nowhere"] }), "NOT_FOUND", /^There is no table "nowhere"\.$/);
      await refused(new ReadOnlyAccess(access, "only looking").clear({ tables: ["notes"] }), "READ_ONLY", /^only looking$/);
      runtime.begin();
      await refused(access.clear({ tables: ["notes"] }), "BUSY");
      runtime.rollback();
      assert.equal(count(runtime, "notes"), 3);
    } finally {
      runtime.close();
    }
    const file = await open({ format: "file" });
    try {
      await refused(file.access.clear({ tables: ["notes"] }), "READ_ONLY", /single-file database/);
    } finally {
      file.runtime.close();
    }
  });

  it("is said in the runtime's events, as Studio's", async () => {
    const { access, runtime, events } = await open();
    try {
      const before = events.length;
      await access.clear({ tables: ["notes"] });
      const said = events.slice(before).map((event) => [event.sql, event.requestId]);
      assert.ok(said.some(([sql, id]) => sql === 'DELETE FROM "notes"' && id === "studio"), JSON.stringify(said));
      assert.ok(said.some(([sql]) => sql === "COMMIT"));
    } finally {
      runtime.close();
    }
  });
});

