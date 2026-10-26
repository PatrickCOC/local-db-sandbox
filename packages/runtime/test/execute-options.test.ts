import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseState } from "../../core/src/index.ts";
import { SandboxReadOnlyError, SqliteRuntime, compileQuery } from "../src/index.ts";
import type { SnapshotStorage, SqlEvent, TableSchema } from "../src/index.ts";

/*
 * What one call can ask of a runtime that others use too (D-042): that the
 * statement changes nothing, that no more than so many rows come back, and
 * what the statement is said to run for. A runtime that an application has
 * open is not opened a second time for someone who only wants to look.
 */

class MemoryStorage implements SnapshotStorage {
  saved: DatabaseState[] = [];
  #state: DatabaseState;

  constructor(collections: DatabaseState["collections"] = {}) {
    this.#state = { meta: { version: 1 }, collections };
  }

  async load(): Promise<DatabaseState> {
    return structuredClone(this.#state);
  }

  saveSync(state: DatabaseState): void {
    this.#state = structuredClone(state);
    this.saved.push(this.#state);
  }
}

const SCHEMA: TableSchema[] = [
  {
    name: "items",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "name", type: "text", nullable: false, primary: false },
      { name: "qty", type: "integer", nullable: true, primary: false },
    ],
  },
];
const ITEMS = Array.from({ length: 10 }, (_unused, index) => ({ id: index + 1, name: `item ${String(index + 1).padStart(2, "0")}`, qty: index === 9 ? null : index * 10 }));

async function open(): Promise<{ runtime: SqliteRuntime; storage: MemoryStorage; events: SqlEvent[] }> {
  const storage = new MemoryStorage({ items: structuredClone(ITEMS) });
  const runtime = await SqliteRuntime.open({ schema: SCHEMA, storage, context: () => ({ requestId: "application" }) });
  const events: SqlEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  return { runtime, storage, events };
}

describe("one call on a shared runtime: read-only", () => {
  it("runs a statement that changes nothing", async () => {
    const { runtime } = await open();
    assert.deepEqual(runtime.execute("SELECT name FROM items WHERE id = ?", [3], { readOnly: true }).rows, [{ name: "item 03" }]);
    assert.deepEqual(runtime.run({ kind: "count", table: "items" }, { readOnly: true }).rows, [{ count: 10 }]);
  });

  it("refuses a statement that would change data or schema, whatever it looks like: SQLite decides, not its first word", async () => {
    const { runtime, storage, events } = await open();
    const refused = (error: unknown): boolean => error instanceof SandboxReadOnlyError && /would change data or schema/.test(error.message);
    for (const sql of [
      "INSERT INTO items (name) VALUES ('x')",
      "UPDATE items SET qty = 1",
      "DELETE FROM items",
      "WITH gone AS (SELECT id FROM items WHERE id < 3) DELETE FROM items WHERE id IN (SELECT id FROM gone)",
      "INSERT INTO items (name) VALUES ('x') RETURNING id",
      "CREATE TABLE other (id integer)",
      "DROP TABLE items",
    ]) {
      assert.throws(() => runtime.execute(sql, [], { readOnly: true }), refused, sql);
    }
    assert.throws(() => runtime.run({ kind: "delete", table: "items" }, { readOnly: true }), refused);
    assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM items").rows, [{ n: 10 }]);
    // Nothing was saved, and each refusal is an event that says why.
    assert.equal(storage.saved.length, 0);
    assert.deepEqual([...new Set(events.filter((event) => event.errorCode !== undefined).map((event) => event.errorCode))], ["SANDBOX_READ_ONLY"]);
  });

  it("is of that call alone: the next call writes as before, and is saved", async () => {
    const { runtime, storage } = await open();
    assert.throws(() => runtime.execute("DELETE FROM items", [], { readOnly: true }), SandboxReadOnlyError);
    assert.equal(runtime.execute("DELETE FROM items WHERE id = 1").affectedRows, 1);
    assert.equal(storage.saved.at(-1)?.collections.items?.length, 9);
    // Also after a read-only call that went well.
    runtime.execute("SELECT 1", [], { readOnly: true });
    assert.equal(runtime.execute("UPDATE items SET qty = 5 WHERE id = 2").affectedRows, 1);
  });

  it("holds inside a transaction that is open, and leaves that transaction as it is", async () => {
    const { runtime, storage } = await open();
    runtime.begin();
    runtime.execute("UPDATE items SET qty = 111 WHERE id = 1");
    assert.throws(() => runtime.execute("UPDATE items SET qty = 222 WHERE id = 1", [], { readOnly: true }), SandboxReadOnlyError);
    assert.deepEqual(runtime.execute("SELECT qty FROM items WHERE id = 1", [], { readOnly: true }).rows, [{ qty: 111 }]);
    assert.equal(runtime.inTransaction, true);
    runtime.commit();
    assert.equal(storage.saved.at(-1)?.collections.items?.find((item) => item.id === 1)?.qty, 111);
  });

  it("cannot be switched off from within the call", async () => {
    const { runtime } = await open();
    assert.throws(() => runtime.execute("PRAGMA query_only = OFF", [], { readOnly: true }), (error: unknown) => error instanceof SandboxReadOnlyError && /cannot be changed with PRAGMA query_only/.test(error.message));
    assert.throws(() => runtime.execute("DELETE FROM items", [], { readOnly: true }), SandboxReadOnlyError);
  });
});

describe("one call on a shared runtime: no more than so many rows", () => {
  it("gives the first rows and says that there are more", async () => {
    const { runtime } = await open();
    const some = runtime.execute("SELECT id FROM items ORDER BY id", [], { maxRows: 3 });
    assert.deepEqual(some.rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.equal(some.truncated, true);
    assert.deepEqual(runtime.run({ kind: "select", table: "items", columns: ["id"], orderBy: [{ column: "id", direction: "desc" }] }, { maxRows: 2 }), { rows: [{ id: 10 }, { id: 9 }], affectedRows: 0, truncated: true });
  });

  it("says nothing of more when there are no more, and gives every row when none are asked for", async () => {
    const { runtime } = await open();
    const all = runtime.execute("SELECT id FROM items", [], { maxRows: 10 });
    assert.equal(all.rows.length, 10);
    assert.equal(all.truncated, undefined);
    assert.equal(runtime.execute("SELECT id FROM items", [], { maxRows: 50 }).truncated, undefined);
    assert.deepEqual(runtime.execute("SELECT id FROM items", [], { maxRows: 0 }), { rows: [], affectedRows: 0, truncated: true });
    assert.equal(runtime.execute("SELECT id FROM items").rows.length, 10);
  });

  it("does not stop a statement that writes halfway: it changes every row it changes, and returns the first of them", async () => {
    const { runtime } = await open();
    const changed = runtime.execute("UPDATE items SET qty = 0 RETURNING id", [], { maxRows: 4 });
    assert.equal(changed.rows.length, 4);
    assert.equal(changed.affectedRows, 10);
    assert.equal(changed.truncated, true);
    assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM items WHERE qty = 0").rows, [{ n: 10 }]);
  });

  it("can be asked again after it stopped early, and keeps an integer that a number cannot hold exact", async () => {
    const { runtime } = await open();
    const first = runtime.prepare("SELECT id FROM items ORDER BY id");
    assert.equal(first.execute([], { maxRows: 1 }).rows.length, 1);
    assert.equal(first.execute([], { maxRows: 2 }).rows.length, 2);
    assert.equal(first.execute().rows.length, 10);
    const big = runtime.execute("SELECT 9007199254740993 AS n UNION ALL SELECT 2 UNION ALL SELECT 3", [], { maxRows: 2 });
    // As when every row is read: the integer a number cannot hold is the text of its digits, the others are numbers.
    assert.deepEqual(big, { rows: [{ n: "9007199254740993" }, { n: 2 }], affectedRows: 0, truncated: true });
    assert.deepEqual(runtime.execute("SELECT 9007199254740993 AS n UNION ALL SELECT 2").rows, [{ n: "9007199254740993" }, { n: 2 }]);
  });

  it("refuses a number of rows that is none", async () => {
    const { runtime } = await open();
    assert.throws(() => runtime.execute("SELECT 1", [], { maxRows: -1 }), /maxRows must be a whole number, 0 or more/);
    assert.throws(() => runtime.execute("SELECT 1", [], { maxRows: 1.5 }), /maxRows must be a whole number, 0 or more/);
  });
});

describe("one call on a shared runtime: what it runs for", () => {
  it("is said by the call, in place of what the runtime would say", async () => {
    const { runtime, events } = await open();
    runtime.execute("SELECT 1");
    runtime.execute("SELECT 2", [], { context: { requestId: "studio", sequence: 7 } });
    runtime.run({ kind: "count", table: "items" }, { context: { requestId: "studio" } });
    assert.throws(() => runtime.execute("SELECT * FROM nowhere", [], { context: { requestId: "studio", sequence: 9 } }));
    assert.deepEqual(
      events.map((event) => [event.sql.slice(0, 22), event.requestId, event.sequence, event.errorCode]),
      [
        ["SELECT 1", "application", undefined, undefined],
        ["SELECT 2", "studio", 7, undefined],
        ['SELECT COUNT(*) AS "co', "studio", undefined, undefined],
        ["SELECT * FROM nowhere", "studio", 9, "SANDBOX_DIALECT_UNSUPPORTED"],
      ],
    );
  });
});

describe("the query model: comparisons a browser of rows needs", () => {
  it("compiles not equal, greater than, at most, and like, with null as the absence it is", () => {
    const where = (conditions: Parameters<typeof compileQuery>[0] extends infer Q ? (Q extends { kind: "count"; where?: infer W } ? W : never) : never) => compileQuery({ kind: "count", table: "items", where: conditions });
    assert.deepEqual(where([{ column: "qty", op: "neq", value: 5 }]), { sql: 'SELECT COUNT(*) AS "count" FROM "items" WHERE "qty" <> ?', parameters: [5] });
    assert.deepEqual(where([{ column: "qty", op: "neq", value: null }]), { sql: 'SELECT COUNT(*) AS "count" FROM "items" WHERE "qty" IS NOT NULL', parameters: [] });
    assert.deepEqual(where([{ column: "qty", op: "gt", value: 5 }, { column: "qty", op: "lte", value: 9 }]), { sql: 'SELECT COUNT(*) AS "count" FROM "items" WHERE "qty" > ? AND "qty" <= ?', parameters: [5, 9] });
    assert.deepEqual(where([{ column: "name", op: "like", value: "%a\\_b%" }]), { sql: `SELECT COUNT(*) AS "count" FROM "items" WHERE "name" LIKE ? ESCAPE '\\'`, parameters: ["%a\\_b%"] });
    for (const op of ["gt", "lte", "like", "gte", "lt"] as const) {
      assert.throws(() => where([{ column: "qty", op, value: null }]), new RegExp(`"${op}" cannot compare "qty" with null; only "eq" and "neq" can\\.`));
    }
  });

  it("runs them", async () => {
    const { runtime } = await open();
    const ids = (where: NonNullable<Extract<Parameters<typeof compileQuery>[0], { kind: "select" }>["where"]>): unknown[] =>
      runtime.run({ kind: "select", table: "items", columns: ["id"], where, orderBy: [{ column: "id", direction: "asc" }] }).rows.map((row) => row.id);
    assert.deepEqual(ids([{ column: "qty", op: "gt", value: 60 }]), [8, 9]);
    assert.deepEqual(ids([{ column: "qty", op: "lte", value: 10 }]), [1, 2]);
    assert.deepEqual(ids([{ column: "qty", op: "neq", value: null }, { column: "qty", op: "neq", value: 0 }, { column: "qty", op: "lt", value: 30 }]), [2, 3]);
    assert.deepEqual(ids([{ column: "qty", op: "eq", value: null }]), [10]);
    assert.deepEqual(ids([{ column: "name", op: "like", value: "%m 1%" }]), [10]);
    // A row whose column is null is neither equal nor unequal to a value, as in SQL.
    assert.deepEqual(ids([{ column: "qty", op: "neq", value: 0 }]).includes(10), false);
  });
});
