import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccessError, DEFAULT_ACCESS_LIMITS, ReadOnlyAccess } from "../src/index.ts";
import type { AccessErrorCode } from "../src/index.ts";
import { DATA, SCHEMA, open } from "./support/fixture.ts";

/*
 * `snapshot` (D-050): tables asked for whole, at one moment, for an export.
 * Definitions as the runtime has them, the enumerated types their columns
 * take, and every row, whole, as fixture values; nothing changed by it.
 */

async function refused(promise: Promise<unknown>, code: AccessErrorCode, message: RegExp = /./): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AccessError, String(error));
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
}

describe("access: snapshot", () => {
  it("gives the definitions of the tables asked for, in the runtime's order, with the enumerated types they use", async () => {
    const { access, runtime } = await open();
    try {
      const snapshot = await access.snapshot({ tables: ["orders", "users"], rows: false });
      assert.deepEqual(snapshot.schema.tables.map((table) => table.name), ["users", "orders"]);
      assert.deepEqual(snapshot.schema.tables[0], SCHEMA[0]);
      assert.deepEqual(snapshot.schema.types, { enums: [{ name: "role", values: ["admin", "reader"] }] });
      assert.equal(snapshot.rows, undefined);
      // A copy: what the caller does with it is not the runtime's schema.
      snapshot.schema.tables[0]?.columns.pop();
      assert.equal(runtime.schema[0]?.columns.length, 7);
    } finally {
      runtime.close();
    }
  });

  it("gives every row whole, as fixture values: no value is cut, however long", async () => {
    const { access, runtime } = await open();
    try {
      const long = "x".repeat(DEFAULT_ACCESS_LIMITS.maxCellLength * 3);
      await access.insert({ table: "notes", values: { text: long } });
      const snapshot = await access.snapshot({ tables: ["users", "notes", "memberships"], rows: true });
      assert.deepEqual(snapshot.rows?.users, DATA().users);
      assert.deepEqual(snapshot.rows?.memberships, DATA().memberships);
      assert.equal(snapshot.rows?.notes?.at(-1)?.text, long);
      assert.deepEqual(Object.keys(snapshot.rows ?? {}), ["users", "memberships", "notes"]);
    } finally {
      runtime.close();
    }
  });

  it("changes nothing, and runs no statement that the runtime's events show", async () => {
    const { access, runtime, storage, events } = await open();
    try {
      const before = events.length;
      await access.snapshot({ tables: ["users", "orders", "memberships", "notes"], rows: true });
      assert.equal(events.length, before);
      assert.deepEqual(storage.saved, []);
      assert.deepEqual(runtime.snapshot().collections, DATA());
    } finally {
      runtime.close();
    }
  });

  it("refuses what is not a request for tables, and a table that is not there", async () => {
    const { access, runtime } = await open();
    try {
      await refused(access.snapshot({ tables: [], rows: true }), "INVALID_REQUEST", /"tables" must name at least one table, each once/);
      await refused(access.snapshot({ tables: ["users", "users"], rows: true }), "INVALID_REQUEST", /each once/);
      await refused(access.snapshot({ tables: "users" as unknown as string[], rows: true }), "INVALID_REQUEST");
      await refused(access.snapshot({ tables: ["users"], rows: "yes" as unknown as boolean }), "INVALID_REQUEST", /"rows" must say/);
      await refused(access.snapshot({ tables: ["users", "nowhere"], rows: false }), "NOT_FOUND", /^There is no table "nowhere"\.$/);
    } finally {
      runtime.close();
    }
  });

  it("gives nothing when the tables, with their rows, are more than a snapshot may hold", async () => {
    const { access, runtime } = await open({ limits: { maxSnapshotBytes: 2_000 } });
    try {
      // The definitions alone are within the limit; with the rows of the users they are not.
      assert.ok((await access.snapshot({ tables: ["users"], rows: false })).schema.tables.length === 1);
      await refused(access.snapshot({ tables: ["users"], rows: true }), "LIMIT_EXCEEDED", /more than 2000 bytes, which is what one snapshot may hold\. Nothing was given: ask for fewer tables, or for their definitions alone\./);
    } finally {
      runtime.close();
    }
  });

  it("waits for no transaction of the application: while one is open, it is refused as busy", async () => {
    const { access, runtime } = await open();
    try {
      runtime.begin();
      await refused(access.snapshot({ tables: ["users"], rows: true }), "BUSY");
      runtime.rollback();
      assert.equal((await access.snapshot({ tables: ["users"], rows: true })).rows?.users?.length, 25);
    } finally {
      runtime.close();
    }
  });

  it("is given by an access that changes nothing, and by one of a single file", async () => {
    const { access, runtime } = await open({ format: "file" });
    try {
      const looking = new ReadOnlyAccess(access, "only looking");
      assert.deepEqual(await looking.snapshot({ tables: ["notes"], rows: true }), await access.snapshot({ tables: ["notes"], rows: true }));
    } finally {
      runtime.close();
    }
  });
});
