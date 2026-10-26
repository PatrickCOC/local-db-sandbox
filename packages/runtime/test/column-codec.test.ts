import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SqliteRuntime, compileQuery, fromStoredValue, parseDatetime, toStoredValue } from "../src/index.ts";
import type { ColumnSchema, TableSchema } from "../src/index.ts";

const column = (type: ColumnSchema["type"]): ColumnSchema => ({ name: "c", type, nullable: true, primary: false });

describe("column codec", () => {
  test("every spelling of a moment is stored as the same text", () => {
    const datetime = column("datetime");
    for (const spelling of [
      "2026-10-06T12:00:00Z",
      "2026-10-06T12:00:00.000Z",
      "2026-10-06T12:00:00+00:00",
      "2026-10-06 12:00:00+00",
      "2026-10-06 12:00:00",
      "2026-10-06T12:00:00",
      "2026-10-06 12:00:00.000",
      "2026-10-06T20:00:00+08:00",
      "2026-10-06T07:30:00-0430",
      "2026-10-06T12:00:00.000999Z",
      Date.UTC(2026, 9, 6, 12),
    ]) {
      assert.equal(toStoredValue(datetime, spelling), "2026-10-06 12:00:00.000", String(spelling));
    }
    assert.equal(toStoredValue(datetime, "2026-10-06"), "2026-10-06 00:00:00.000");
  });

  test("date-time text without an offset is UTC, whatever the process's time zone", () => {
    assert.equal(parseDatetime("2026-01-02 03:04:05")?.toISOString(), "2026-01-02T03:04:05.000Z");
    assert.equal(parseDatetime("2026-01-02T03:04")?.toISOString(), "2026-01-02T03:04:00.000Z");
  });

  test("text that is not a date-time is refused", () => {
    for (const text of ["yesterday", "2026-02-30 00:00:00", "2026-13-01", ""]) {
      assert.equal(parseDatetime(text), undefined, text);
      assert.throws(() => toStoredValue(column("datetime"), text), /not a date-time/);
    }
  });

  test("stored values come back as their logical values", () => {
    assert.equal(fromStoredValue(column("datetime"), "2026-10-06 12:00:00.000"), "2026-10-06T12:00:00.000Z");
    assert.equal(fromStoredValue(column("datetime"), "2026-10-06 12:00:00"), "2026-10-06T12:00:00.000Z");
    assert.equal(fromStoredValue(column("boolean"), 0), false);
    assert.equal(fromStoredValue(column("boolean"), 1), true);
    assert.deepEqual(fromStoredValue(column("json"), '{"a":[1]}'), { a: [1] });
    assert.equal(fromStoredValue(column("binary"), new Uint8Array([0, 255])), "AP8=");
    assert.equal(fromStoredValue(column("integer"), 9007199254740993n), "9007199254740993");
    assert.equal(fromStoredValue(column("integer"), 7n), 7);
    assert.equal(fromStoredValue(column("numeric"), 12.5), 12.5);
    assert.equal(fromStoredValue(column("text"), null), null);
  });

  test("logical values go in as the runtime stores them", () => {
    assert.equal(toStoredValue(column("boolean"), true), 1);
    assert.equal(toStoredValue(column("json"), { a: 1 }), '{"a":1}');
    assert.equal(toStoredValue(column("json"), "text"), '"text"');
    assert.deepEqual(toStoredValue(column("binary"), "AP8="), Buffer.from([0, 255]));
    assert.equal(toStoredValue(column("date"), "2026-10-06T23:00:00Z"), "2026-10-06");
    assert.equal(toStoredValue(column("numeric"), "12.50"), "12.50");
    assert.throws(() => toStoredValue(column("binary"), "not base64!"), /Base64/);
    assert.throws(() => toStoredValue(column("integer"), {}), /object, but its column type is integer/);
  });

  test("the runtime loads and saves a fixture with the same rules", async () => {
    const schema: TableSchema[] = [{ name: "events", columns: [{ name: "id", type: "integer", nullable: false, primary: true }, { name: "at", type: "datetime", nullable: true, primary: false }] }];
    const runtime = await SqliteRuntime.open({
      schema,
      state: { meta: { version: 1 }, collections: { events: [{ id: 1, at: "2026-10-06T12:00:00Z" }, { id: 2, at: "2026-10-06 12:00:00" }, { id: 3, at: "2026-10-06T20:00:00+08:00" }] } },
    });
    try {
      assert.deepEqual(runtime.execute("SELECT DISTINCT at FROM events").rows, [{ at: "2026-10-06 12:00:00.000" }]);
      assert.deepEqual(runtime.snapshot().collections.events?.map((row) => row.at), ["2026-10-06T12:00:00.000Z", "2026-10-06T12:00:00.000Z", "2026-10-06T12:00:00.000Z"]);
    } finally {
      runtime.close();
    }
  });
});

describe("Query IR comparisons and upsert", () => {
  test("gte and lt compile to >= and <", () => {
    assert.deepEqual(
      compileQuery({ kind: "select", table: "t", where: [{ column: "a", op: "gte", value: 1 }, { column: "b", op: "lt", value: "x" }, { column: "c", op: "eq", value: null }] }),
      { sql: 'SELECT * FROM "t" WHERE "a" >= ? AND "b" < ? AND "c" IS NULL', parameters: [1, "x"] },
    );
    assert.deepEqual(compileQuery({ kind: "delete", table: "t", where: [{ column: "a", op: "lt", value: 3 }] }), { sql: 'DELETE FROM "t" WHERE "a" < ?', parameters: [3] });
  });

  test("only eq and neq compare with null; an unknown operator is refused", () => {
    assert.throws(() => compileQuery({ kind: "select", table: "t", where: [{ column: "a", op: "gte", value: null }] }), /only "eq" and "neq" can/);
    assert.throws(() => compileQuery({ kind: "select", table: "t", where: [{ column: "a", op: "between" as "eq", value: 1 }] }), /Unknown comparison "between"; expected one of eq, neq, gt, gte, lt, lte, like\./);
  });

  test("upsert compiles to INSERT ... ON CONFLICT", () => {
    assert.deepEqual(
      compileQuery({ kind: "upsert", table: "t", rows: [{ k: 1, v: "a" }, { v: "b", k: 2 }], conflict: ["k"] }),
      { sql: 'INSERT INTO "t" ("k", "v") VALUES (?, ?), (?, ?) ON CONFLICT ("k") DO UPDATE SET "v" = excluded."v"', parameters: [1, "a", 2, "b"] },
    );
    assert.equal(compileQuery({ kind: "upsert", table: "t", rows: [{ k: 1, v: "a" }], conflict: ["k"], action: "ignore" }).sql, 'INSERT INTO "t" ("k", "v") VALUES (?, ?) ON CONFLICT ("k") DO NOTHING');
    assert.equal(compileQuery({ kind: "upsert", table: "t", rows: [{ k: 1 }], conflict: ["k"] }).sql, 'INSERT INTO "t" ("k") VALUES (?) ON CONFLICT ("k") DO NOTHING');
    assert.throws(() => compileQuery({ kind: "upsert", table: "t", rows: [], conflict: ["k"] }), /at least one row/);
    assert.throws(() => compileQuery({ kind: "upsert", table: "t", rows: [{ k: 1 }, { k: 2, v: 1 }], conflict: ["k"] }), /every row gives k/);
    assert.throws(() => compileQuery({ kind: "upsert", table: "t", rows: [{ k: 1 }], conflict: [] }), /columns of the key/);
  });

  test("an upsert runs on the runtime: new keys are inserted, existing keys updated, a conflict column left out takes its default", async () => {
    const schema: TableSchema[] = [
      {
        name: "state",
        columns: [
          { name: "id", type: "text", nullable: false, primary: true, default: "main" },
          { name: "label", type: "text", nullable: true, primary: false },
          { name: "n", type: "integer", nullable: true, primary: false },
        ],
      },
    ];
    const runtime = await SqliteRuntime.open({ schema, state: { meta: { version: 1 }, collections: { state: [{ id: "main", label: "a", n: 1 }] } } });
    try {
      assert.equal(runtime.run({ kind: "upsert", table: "state", rows: [{ id: "main", label: "b" }, { id: "other", label: "c" }], conflict: ["id"] }).affectedRows, 2);
      runtime.run({ kind: "upsert", table: "state", rows: [{ label: "d" }], conflict: ["id"] });
      assert.deepEqual(runtime.run({ kind: "select", table: "state" }).rows, [{ id: "main", label: "d", n: 1 }, { id: "other", label: "c", n: null }]);
      assert.deepEqual(runtime.run({ kind: "select", table: "state", columns: ["id"], where: [{ column: "id", op: "gte", value: "n" }] }).rows, [{ id: "other" }]);
      assert.deepEqual(runtime.run({ kind: "select", table: "state", columns: ["id"], where: [{ column: "id", op: "lt", value: "n" }] }).rows, [{ id: "main" }]);
    } finally {
      runtime.close();
    }
  });

  test("a single integer primary key is SQLite's row id: its default does not apply to an upsert that leaves it out", async () => {
    // A known difference from PostgreSQL, where `id int primary key default 1` would collide on 1.
    const schema: TableSchema[] = [{ name: "state", columns: [{ name: "id", type: "integer", nullable: false, primary: true, default: 1 }, { name: "label", type: "text", nullable: true, primary: false }] }];
    const runtime = await SqliteRuntime.open({ schema, state: { meta: { version: 1 }, collections: { state: [{ id: 1, label: "a" }] } } });
    try {
      runtime.run({ kind: "upsert", table: "state", rows: [{ label: "b" }], conflict: ["id"] });
      assert.deepEqual(runtime.run({ kind: "select", table: "state" }).rows, [{ id: 1, label: "a" }, { id: 2, label: "b" }]);
    } finally {
      runtime.close();
    }
  });
});
