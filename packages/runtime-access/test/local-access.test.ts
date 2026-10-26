import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteRuntime } from "../../runtime/src/index.ts";
import type { TableSchema } from "../../runtime/src/index.ts";
import { AccessError, DEFAULT_ACCESS_LIMITS, INSERT_TIME, LocalRuntimeAccess } from "../src/index.ts";
import type { AccessErrorCode } from "../src/index.ts";
import { IDENTITY, MemoryStorage, USERS, open } from "./support/fixture.ts";

/*
 * Access to a runtime that an application has open (D-042): its schema, its
 * rows by page, one row changed at a time, and a console, all carried out
 * by the runtime that is there. Nothing here opens a database.
 */

/** Rejects with an `AccessError` of that code, whose message matches. */
async function refused(promise: Promise<unknown>, code: AccessErrorCode, message: RegExp = /./): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AccessError, `not an AccessError: ${String(error)}`);
    assert.equal(error.code, code, error.message);
    assert.match(error.message, message);
    return true;
  });
}

describe("access to a runtime: who answers, and its schema", () => {
  it("says whose runtime it is, how it keeps what is committed, and what a request may ask for", async () => {
    const { access } = await open();
    assert.deepEqual(await access.info(), { protocol: 1, ...IDENTITY, persistence: "json", tables: 4, limits: DEFAULT_ACCESS_LIMITS });
    assert.equal((await (await open({ persistence: "memory" })).access.info()).persistence, "memory");
    assert.equal((await (await open({ limits: { maxPageRows: 7 } })).access.info()).limits.maxPageRows, 7);
  });

  it("says that nothing can be changed, and why: when it is told so, and always of a single-file database", async () => {
    assert.equal((await (await open({ readOnly: "Studio was started with --read-only." })).access.info()).readOnly, "Studio was started with --read-only.");
    assert.equal((await (await open({ format: "file" })).access.info()).readOnly, "A single-file database is not changed through Studio: convert it into a database directory to change it.");
    assert.equal("readOnly" in (await (await open()).access.info()), false);
  });

  it("gives every table with its columns, what each is, its key, and how many rows it has", async () => {
    const { access } = await open();
    const { tables } = await access.schema();
    assert.deepEqual(
      tables.map((table) => [table.name, table.primaryKey, table.rows]),
      [
        ["users", ["id"], 25],
        ["orders", ["number"], 2],
        ["memberships", ["userId", "team"], 3],
        ["notes", [], 3],
      ],
    );
    assert.deepEqual(tables[0]?.columns, [
      { name: "id", type: "integer", nullable: false, primaryKey: true, generated: "increment" },
      { name: "name", type: "text", declaredType: "varchar(40)", canonicalType: "varchar(40)", nullable: false, primaryKey: false },
      { name: "active", type: "boolean", nullable: false, primaryKey: false, default: true },
      { name: "score", type: "real", nullable: true, primaryKey: false },
      { name: "joined", type: "datetime", nullable: true, primaryKey: false },
      { name: "settings", type: "json", nullable: true, primaryKey: false },
      { name: "role", type: "text", nullable: false, primaryKey: false, default: "reader", enum: ["admin", "reader"] },
    ]);
    assert.deepEqual(tables[1]?.columns[1], { name: "userId", type: "integer", nullable: true, primaryKey: false, references: { table: "users", column: "id" } });
  });
});

describe("access to a runtime: rows by page", () => {
  it("gives a page of a table in the order of its key, with how many rows there are in all", async () => {
    const { access } = await open();
    const page = await access.browse({ table: "users" });
    assert.deepEqual([page.table, page.total, page.limit, page.offset, page.rows.length, page.cut], ["users", 25, 50, 0, 25, []]);
    assert.deepEqual(page.columns, ["id", "name", "active", "score", "joined", "settings", "role"]);
    // Values as the application has them, not as SQLite stores them: a truth value, a moment, a JSON value.
    assert.deepEqual(page.rows[0], [1, "user 01", true, 1.5, "2026-01-01T08:00:00.000Z", { theme: "dark", tags: ["a", "b"] }, "admin"]);
    assert.deepEqual(page.rows[4], [5, "user 05", true, null, "2026-01-05T08:00:00.000Z", null, "reader"]);
    const second = await access.browse({ table: "users", limit: 10, offset: 20 });
    assert.deepEqual([second.total, second.limit, second.offset, second.rows.map((row) => row[0])], [25, 10, 20, [21, 22, 23, 24, 25]]);
    assert.deepEqual((await access.browse({ table: "users", limit: 10, offset: 40 })).rows, []);
    // A table without a key comes in the order SQLite has it.
    assert.deepEqual((await access.browse({ table: "notes" })).rows, [["first"], ["50% off_all"], [null]]);
  });

  it("sorts by the columns that are asked for, up or down", async () => {
    const { access } = await open();
    const ids = async (orderBy: { column: string; direction: "asc" | "desc" }[]): Promise<unknown[]> => (await access.browse({ table: "users", orderBy, limit: 4 })).rows.map((row) => row[0]);
    assert.deepEqual(await ids([{ column: "id", direction: "desc" }]), [25, 24, 23, 22]);
    assert.deepEqual(await ids([{ column: "active", direction: "asc" }, { column: "name", direction: "desc" }]), [24, 22, 20, 18]);
    assert.deepEqual(await ids([{ column: "role", direction: "asc" }, { column: "id", direction: "desc" }]), [3, 2, 1, 25]);
  });

  it("filters by a column: equal, not equal, greater, less, contains, and whether it has a value", async () => {
    const { access } = await open();
    const ids = async (...filters: { column: string; op: string; value?: unknown }[]): Promise<unknown[]> => (await access.browse({ table: "users", filters: filters as never })).rows.map((row) => row[0]);
    assert.deepEqual(await ids({ column: "role", op: "eq", value: "admin" }), [1, 2, 3]);
    assert.deepEqual(await ids({ column: "id", op: "gt", value: 23 }), [24, 25]);
    assert.deepEqual(await ids({ column: "id", op: "gte", value: 24 }), [24, 25]);
    assert.deepEqual(await ids({ column: "id", op: "lt", value: 3 }), [1, 2]);
    assert.deepEqual(await ids({ column: "id", op: "lte", value: 3 }, { column: "role", op: "neq", value: "admin" }), []);
    assert.deepEqual(await ids({ column: "score", op: "null" }), [5, 10, 15, 20, 25]);
    assert.deepEqual((await ids({ column: "score", op: "notnull" })).length, 20);
    assert.deepEqual(await ids({ column: "name", op: "contains", value: "r 2" }, { column: "id", op: "lte", value: 21 }), [20, 21]);
    // Values are given as the application has them: a truth value, a moment.
    assert.deepEqual((await ids({ column: "active", op: "eq", value: false })).slice(0, 3), [2, 4, 6]);
    assert.deepEqual(await ids({ column: "joined", op: "gte", value: "2026-01-24T08:00:00.000Z" }), [24, 25]);
    // The count is of what matches.
    assert.equal((await access.browse({ table: "users", filters: [{ column: "role", op: "eq", value: "admin" }], limit: 1 })).total, 3);
  });

  it("takes what is to be contained as text: a percent sign and an underscore are themselves", async () => {
    const { access } = await open();
    const texts = async (value: string): Promise<unknown[]> => (await access.browse({ table: "notes", filters: [{ column: "text", op: "contains", value }] })).rows.map((row) => row[0]);
    assert.deepEqual(await texts("%"), ["50% off_all"]);
    assert.deepEqual(await texts("_"), ["50% off_all"]);
    assert.deepEqual(await texts("f"), ["first", "50% off_all"]);
    assert.deepEqual(await texts("\\"), []);
  });

  it("gives no more rows than a page may have, and cuts a value that is too long, saying where", async () => {
    const { access, runtime } = await open({ limits: { maxPageRows: 10, defaultPageRows: 5, maxCellLength: 12 } });
    assert.equal((await access.browse({ table: "users" })).rows.length, 5);
    const most = await access.browse({ table: "users", limit: 500 });
    assert.deepEqual([most.rows.length, most.limit, most.total], [10, 10, 25]);
    runtime.execute("UPDATE notes SET text = ? WHERE text = 'first'", ["x".repeat(40)]);
    const cut = await access.browse({ table: "notes" });
    assert.deepEqual(cut.rows, [["x".repeat(12)], ["50% off_all"], [null]]);
    assert.deepEqual(cut.cut, [[0, 0]]);
    // A JSON value is cut as its text.
    const users = await access.browse({ table: "users", limit: 1 });
    assert.deepEqual([users.rows[0]?.[5], users.cut], ['{"theme":"da', [[0, 4], [0, 5]]]);
  });

  it("refuses a table or a column that is not there, an operator that is none, and a page that cannot be", async () => {
    const { access } = await open();
    await refused(access.browse({ table: "nowhere" }), "NOT_FOUND", /^There is no table "nowhere"\.$/);
    await refused(access.browse({ table: "users", orderBy: [{ column: "nope", direction: "asc" }] }), "NOT_FOUND", /^Table "users" has no column "nope"\.$/);
    await refused(access.browse({ table: "users", filters: [{ column: "nope", op: "eq", value: 1 }] }), "NOT_FOUND", /no column "nope"/);
    await refused(access.browse({ table: "users", filters: [{ column: "id", op: "between" as "eq", value: 1 }] }), "INVALID_REQUEST", /"between" is no comparison/);
    await refused(access.browse({ table: "users", filters: [{ column: "id", op: "gt" }] }), "INVALID_REQUEST", /"gt" needs a value to compare "id" with/);
    await refused(access.browse({ table: "users", filters: [{ column: "id", op: "gt", value: null }] }), "INVALID_REQUEST", /needs a value/);
    await refused(access.browse({ table: "users", limit: -1 }), "INVALID_REQUEST", /"limit" must be a whole number, 0 or more/);
    await refused(access.browse({ table: "users", offset: 1.5 }), "INVALID_REQUEST", /"offset" must be a whole number/);
    await refused(access.browse({ table: "users", orderBy: [{ column: "id", direction: "sideways" as "asc" }] }), "INVALID_REQUEST", /"asc" or "desc"/);
    await refused(access.browse({ table: "users", filters: [{ column: "joined", op: "eq", value: "tomorrow" }] }), "INVALID_VALUE", /not a date-time/);
  });
});

describe("access to a runtime: one row", () => {
  it("is read whole by its key, however long its values are, up to what can be edited", async () => {
    // What a page cuts (5 characters here) is whole in a row that is read by itself.
    const { access, runtime } = await open({ limits: { maxCellLength: 5, maxEditLength: 40 } });
    assert.deepEqual(await access.row({ table: "users", key: { id: 1 } }), {
      table: "users",
      row: { id: 1, name: "user 01", active: true, score: 1.5, joined: "2026-01-01T08:00:00.000Z", settings: { theme: "dark", tags: ["a", "b"] }, role: "admin" },
      tooLong: [],
    });
    assert.deepEqual((await access.row({ table: "memberships", key: { userId: 1, team: "blue" } })).row, { userId: 1, team: "blue", since: null });
    runtime.execute("UPDATE users SET name = ? WHERE id = 2", ["n".repeat(41)]);
    assert.deepEqual(await access.row({ table: "users", key: { id: 2 } }), { table: "users", row: { id: 2, active: false, score: 3, joined: "2026-01-02T08:00:00.000Z", settings: null, role: "admin" }, tooLong: ["name"] });
  });

  it("is refused when it is not there, when the key is not the table's, and of a table without a key", async () => {
    const { access } = await open();
    await refused(access.row({ table: "users", key: { id: 99 } }), "NOT_FOUND", /^Table "users" has no row with id = 99\.$/);
    await refused(access.row({ table: "memberships", key: { userId: 1 } }), "INVALID_REQUEST", /^A row of "memberships" is found by userId, team; the request gives userId\.$/);
    await refused(access.row({ table: "users", key: { id: 1, name: "x" } }), "INVALID_REQUEST", /is found by id; the request gives id, name/);
    await refused(access.row({ table: "notes", key: {} }), "INVALID_REQUEST", /^Table "notes" has no primary key, so a row of it cannot be told from another: change it with SQL\.$/);
  });
});

describe("access to a runtime: a row is added, changed, removed", () => {
  it("adds a row, with what the schema gives a column that is not given, and it is saved", async () => {
    const { access, storage, events } = await open();
    assert.deepEqual(await access.insert({ table: "users", values: { name: "Ada", joined: "2026-05-06T07:08:09.000Z", settings: { a: [1, 2] } } }), { affectedRows: 1, lastInsertId: 26 });
    assert.deepEqual(storage.rows("users").at(-1), { id: 26, name: "Ada", active: true, score: null, joined: "2026-05-06T07:08:09.000Z", settings: { a: [1, 2] }, role: "reader" });
    assert.deepEqual(await access.insert({ table: "memberships", values: { userId: 3, team: "red" } }), { affectedRows: 1 });
    assert.deepEqual(await access.insert({ table: "notes", values: {} }), { affectedRows: 1 });
    assert.equal(storage.rows("notes").length, 4);
    // What Studio does is told apart from what the application does.
    assert.deepEqual([...new Set(events.filter((event) => event.operation === "INSERT").map((event) => event.requestId))], ["studio"]);
  });

  it("changes the columns that are given of the row with that key, and nothing else", async () => {
    const { access, storage } = await open();
    assert.deepEqual(await access.update({ table: "users", key: { id: 2 }, values: { active: true, score: null, settings: [1, { b: 2 }] } }), { affectedRows: 1 });
    assert.deepEqual(storage.rows("users")[1], { ...USERS[1], active: true, score: null, settings: [1, { b: 2 }] });
    assert.deepEqual(storage.rows("users")[0], USERS[0]);
    assert.deepEqual(await access.update({ table: "memberships", key: { userId: 1, team: "blue" }, values: { since: "2026-04-05" } }), { affectedRows: 1 });
    assert.deepEqual(storage.rows("memberships"), [
      { userId: 1, team: "red", since: "2026-02-01" },
      { userId: 1, team: "blue", since: "2026-04-05" },
      { userId: 2, team: "red", since: "2026-03-01" },
    ]);
    // The key itself can be changed, too.
    assert.deepEqual(await access.update({ table: "orders", key: { number: "A-2" }, values: { number: "B-2" } }), { affectedRows: 1 });
    assert.deepEqual(storage.rows("orders").map((order) => order.number), ["A-1", "B-2"]);
  });

  it("removes the row with that key", async () => {
    const { access, storage } = await open();
    assert.deepEqual(await access.delete({ table: "memberships", key: { userId: 1, team: "red" } }), { affectedRows: 1 });
    assert.deepEqual(storage.rows("memberships").map((row) => `${row.userId} ${row.team}`), ["1 blue", "2 red"]);
    assert.deepEqual(await access.delete({ table: "users", key: { id: 25 } }), { affectedRows: 1 });
    assert.equal(storage.rows("users").length, 24);
  });

  it("refuses a row that is not there, a column that is not there, and a change of nothing", async () => {
    const { access, storage } = await open();
    await refused(access.update({ table: "users", key: { id: 99 }, values: { name: "x" } }), "NOT_FOUND", /^Table "users" has no row with id = 99\.$/);
    await refused(access.delete({ table: "users", key: { id: 99 } }), "NOT_FOUND", /no row with id = 99/);
    await refused(access.insert({ table: "users", values: { name: "x", nope: 1 } }), "NOT_FOUND", /^Table "users" has no column "nope"\.$/);
    await refused(access.update({ table: "users", key: { id: 1 }, values: {} }), "INVALID_REQUEST", /^The change names no column to set\.$/);
    await refused(access.update({ table: "notes", key: {}, values: { text: "x" } }), "INVALID_REQUEST", /has no primary key/);
    await refused(access.insert({ table: "nowhere", values: {} }), "NOT_FOUND", /no table "nowhere"/);
    await refused(access.insert({ table: "users", values: [] as never }), "INVALID_REQUEST", /"values" must be an object of columns and their values/);
    assert.equal(storage.saved.length, 0);
  });

  it("refuses what a constraint of the schema does not allow, and leaves the database as it was", async () => {
    const { access, runtime, storage } = await open();
    await refused(access.insert({ table: "users", values: { active: false } }), "CONSTRAINT", /NOT NULL constraint failed: users\.name/);
    await refused(access.insert({ table: "users", values: { name: "user 01" } }), "CONSTRAINT", /UNIQUE constraint failed: users\.name/);
    await refused(access.insert({ table: "users", values: { name: "Zed", role: "owner" } }), "CONSTRAINT", /CHECK constraint failed/);
    await refused(access.insert({ table: "orders", values: { number: "A-9", userId: 999 } }), "CONSTRAINT", /FOREIGN KEY constraint failed/);
    await refused(access.insert({ table: "orders", values: { number: "A-1" } }), "CONSTRAINT", /UNIQUE constraint failed: orders\.number/);
    await refused(access.update({ table: "users", key: { id: 2 }, values: { name: "user 01" } }), "CONSTRAINT", /UNIQUE constraint failed/);
    await refused(access.delete({ table: "users", key: { id: 1 } }), "CONSTRAINT", /FOREIGN KEY constraint failed/);
    await refused(access.insert({ table: "users", values: { name: "Zed", joined: "soon" } }), "INVALID_VALUE", /"joined" holds "soon", which is not a date-time/);
    assert.equal(storage.saved.length, 0);
    assert.equal(runtime.inTransaction, false);
    assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM users").rows, [{ n: 25 }]);
  });

  it("says so when what was changed could not be written, and takes the change back", async () => {
    const { access, runtime, storage } = await open();
    storage.failNextSave = new Error("the disk is full");
    await refused(access.insert({ table: "users", values: { name: "Ada" } }), "PERSISTENCE", /^The change could not be written to the database, and was taken back: the disk is full$/);
    assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM users").rows, [{ n: 25 }]);
    assert.equal(runtime.inTransaction, false);
    // The next change is written, with nothing of the one that failed.
    await access.insert({ table: "users", values: { name: "Bo" } });
    assert.deepEqual([storage.rows("users").length, storage.rows("users").at(-1)?.name], [26, "Bo"]);
  });
});

describe("access to a runtime: when nothing may be changed", () => {
  it("reads as always, and refuses every change with the reason", async () => {
    for (const options of [{ readOnly: "Studio was started with --read-only." }, { format: "file" as const }]) {
      const { access, storage } = await open(options);
      const why = options.readOnly ?? "A single-file database is not changed through Studio: convert it into a database directory to change it.";
      const said = new RegExp(`^${why.replace(/[.()]/g, "\\$&")}$`);
      assert.equal((await access.browse({ table: "users" })).total, 25);
      assert.equal((await access.schema()).tables.length, 4);
      await refused(access.insert({ table: "notes", values: { text: "x" } }), "READ_ONLY", said);
      await refused(access.update({ table: "users", key: { id: 1 }, values: { name: "x" } }), "READ_ONLY", said);
      await refused(access.delete({ table: "users", key: { id: 25 } }), "READ_ONLY", said);
      await refused(access.sql({ sql: "DELETE FROM notes", mode: "write" }), "READ_ONLY", said);
      const result = await access.sql({ sql: "SELECT COUNT(*) AS n FROM notes; DELETE FROM notes; SELECT 1", mode: "read" });
      assert.deepEqual([result.results.map((each) => each.rows), result.error?.statement, result.error?.code], [[[[3]]], 2, "READ_ONLY"]);
      assert.equal(storage.saved.length, 0);
    }
  });
});

describe("access to a runtime: while the application has a transaction open", () => {
  it("does nothing, and says that the runtime is busy: nothing of Studio's goes into another's transaction", async () => {
    const { access, runtime, storage } = await open();
    runtime.begin();
    runtime.execute("UPDATE users SET name = 'in flight' WHERE id = 1");
    const busy = /^The application has a transaction open on the runtime\. Nothing was done; try again\.$/;
    await refused(access.schema(), "BUSY", busy);
    await refused(access.browse({ table: "users" }), "BUSY", busy);
    await refused(access.row({ table: "users", key: { id: 1 } }), "BUSY", busy);
    await refused(access.insert({ table: "notes", values: { text: "x" } }), "BUSY", busy);
    await refused(access.update({ table: "users", key: { id: 2 }, values: { name: "x" } }), "BUSY", busy);
    await refused(access.delete({ table: "users", key: { id: 25 } }), "BUSY", busy);
    await refused(access.sql({ sql: "SELECT 1", mode: "read" }), "BUSY", busy);
    await refused(access.sql({ sql: "DELETE FROM notes", mode: "write" }), "BUSY", busy);
    // Who answers, and what was done lately, can be said at any time.
    assert.equal((await access.info()).tables, 4);
    assert.ok((await access.events()).events.length > 0);
    assert.equal(runtime.inTransaction, true);
    runtime.commit();
    assert.equal(storage.rows("users")[0]?.name, "in flight");
    assert.equal((await access.browse({ table: "notes" })).total, 3);
  });
});

describe("access to a runtime: the console", () => {
  it("runs statements that read, one after the other, and gives what each returned", async () => {
    const { access } = await open();
    const { results, error, rolledBack } = await access.sql({ sql: "SELECT id, name FROM users WHERE id <= 2 ORDER BY id; -- a comment\nSELECT COUNT(*) AS n FROM notes;", mode: "read" });
    assert.deepEqual([error, rolledBack], [undefined, undefined]);
    assert.deepEqual(
      results.map(({ localExecutionMs: _ms, ...rest }) => rest),
      [
        { sql: "SELECT id, name FROM users WHERE id <= 2 ORDER BY id", operation: "SELECT", columns: ["id", "name"], rows: [[1, "user 01"], [2, "user 02"]], cut: [], truncated: false, affectedRows: 0 },
        { sql: "-- a comment\nSELECT COUNT(*) AS n FROM notes", operation: "SELECT", columns: ["n"], rows: [[3]], cut: [], truncated: false, affectedRows: 0 },
      ],
    );
    assert.ok(results.every((each) => typeof each.localExecutionMs === "number" && each.localExecutionMs >= 0));
    // Values are SQLite's own here: a truth value is 1, a moment is its text, bytes are shown as hexadecimal digits.
    assert.deepEqual((await access.sql({ sql: "SELECT active, joined, settings, x'00ff10' AS bytes FROM users WHERE id = 1", mode: "read" })).results[0]?.rows, [[1, "2026-01-01 08:00:00.000", '{"theme":"dark","tags":["a","b"]}', "\\x00ff10"]]);
  });

  it("changes data when it is asked to write, says how many rows, and what it changed is saved", async () => {
    const { access, storage, events } = await open();
    const { results, error } = await access.sql({ sql: "UPDATE users SET score = 0 WHERE id > 20; INSERT INTO notes (text) VALUES ('a'), ('b'); DELETE FROM notes WHERE text IS NULL; SELECT COUNT(*) AS n FROM notes", mode: "write" });
    assert.equal(error, undefined);
    assert.deepEqual(results.map((each) => [each.operation, each.affectedRows, each.rows]), [["UPDATE", 5, []], ["INSERT", 2, []], ["DELETE", 1, []], ["SELECT", 0, [[4]]]]);
    assert.deepEqual(storage.rows("notes").map((note) => note.text), ["first", "50% off_all", "a", "b"]);
    assert.equal(storage.rows("users").filter((user) => user.score === 0).length, 5);
    // One request is one transaction, saved once.
    assert.equal(storage.saved.length, 1);
    assert.deepEqual(events.filter((event) => event.requestId === "studio").map((event) => event.operation), ["TRANSACTION", "UPDATE", "INSERT", "DELETE", "SELECT", "TRANSACTION"]);
  });

  it("takes back everything of a request when one of its statements fails, and says which", async () => {
    const { access, runtime, storage } = await open();
    const outcome = await access.sql({ sql: "DELETE FROM notes; INSERT INTO users (name) VALUES ('user 01'); DELETE FROM memberships", mode: "write" });
    assert.deepEqual(outcome.results.map((each) => [each.operation, each.affectedRows]), [["DELETE", 3]]);
    assert.deepEqual(outcome.error && { ...outcome.error, message: outcome.error.message.split("\n")[0] }, { statement: 2, sql: "INSERT INTO users (name) VALUES ('user 01')", code: "CONSTRAINT", message: "UNIQUE constraint failed: users.name" });
    assert.equal(outcome.rolledBack, true);
    assert.equal(storage.saved.length, 0);
    assert.equal(runtime.inTransaction, false);
    assert.deepEqual(runtime.execute("SELECT (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM memberships) AS memberships").rows, [{ notes: 3, memberships: 3 }]);
    // A statement that SQLite cannot carry out is the same: nothing before it stays.
    const second = await access.sql({ sql: "DELETE FROM notes; SELECT * FROM nowhere", mode: "write" });
    assert.deepEqual([second.error?.statement, second.error?.code, second.rolledBack], [2, "SQL_ERROR", true]);
    assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM notes").rows, [{ n: 3 }]);
  });

  it("refuses to change anything when it is asked to read: SQLite decides, whatever the statement looks like", async () => {
    const { access, storage } = await open();
    for (const sql of ["DELETE FROM notes", "WITH gone AS (SELECT 1) DELETE FROM notes", "INSERT INTO notes (text) VALUES ('x') RETURNING text", "UPDATE users SET score = 1"]) {
      const { results, error, rolledBack } = await access.sql({ sql, mode: "read" });
      assert.deepEqual([results, error?.statement, error?.code, rolledBack], [[], 1, "READ_ONLY", undefined], sql);
    }
    assert.equal(storage.saved.length, 0);
  });

  it("carries out SELECT, INSERT, UPDATE, and DELETE, and nothing that would change the runtime under the application", async () => {
    const { access, runtime, storage } = await open();
    const unsupported = async (sql: string, why: RegExp, mode: "read" | "write" = "write"): Promise<void> => {
      const { results, error } = await access.sql({ sql: `SELECT 1; ${sql}`, mode });
      assert.deepEqual([results.length, error?.statement, error?.code], [0, 2, "UNSUPPORTED_STATEMENT"], sql);
      assert.match(error?.message ?? "", why, sql);
    };
    const transaction = /A request is one transaction already: it is committed when every statement went well, and taken back when one did not\./;
    await unsupported("BEGIN", transaction);
    await unsupported("COMMIT", transaction);
    await unsupported("ROLLBACK", transaction);
    await unsupported("SAVEPOINT a", transaction);
    await unsupported("BEGIN", transaction, "read");
    const kind = /The console carries out SELECT, INSERT, UPDATE, and DELETE\. The tables are the application's: they are changed where it defines them\./;
    await unsupported("CREATE TABLE more (id integer)", kind);
    await unsupported("DROP TABLE notes", kind);
    await unsupported("ALTER TABLE notes ADD COLUMN more text", kind);
    await unsupported("PRAGMA foreign_keys = OFF", kind);
    await unsupported("PRAGMA foreign_keys = OFF", kind, "read");
    await unsupported("ATTACH DATABASE 'other.db' AS other", kind);
    await unsupported("VACUUM", kind);
    // Nothing was done: not the statement before it either, in whichever mode.
    assert.equal(storage.saved.length, 0);
    assert.equal(runtime.inTransaction, false);
    assert.deepEqual(runtime.execute("PRAGMA foreign_keys").rows, [{ foreign_keys: 1 }]);
  });

  it("returns no more rows than a result may have, and no more statements or characters than a request may", async () => {
    const { access } = await open({ limits: { defaultResultRows: 5, maxResultRows: 8, maxStatements: 3, maxSqlLength: 80, maxCellLength: 6 } });
    const [first] = (await access.sql({ sql: "SELECT id, name FROM users ORDER BY id", mode: "read" })).results;
    assert.deepEqual([first?.rows.length, first?.truncated, first?.rows[0], first?.cut.length], [5, true, [1, "user 0"], 5]);
    assert.deepEqual((await access.sql({ sql: "SELECT id FROM users", mode: "read", maxRows: 100 })).results.map((each) => [each.rows.length, each.truncated]), [[8, true]]);
    assert.deepEqual((await access.sql({ sql: "SELECT id FROM users", mode: "read", maxRows: 2 })).results.map((each) => [each.rows.length, each.truncated]), [[2, true]]);
    assert.deepEqual((await access.sql({ sql: "SELECT id FROM users WHERE id < 3", mode: "read" })).results.map((each) => [each.rows.length, each.truncated]), [[2, false]]);
    await refused(access.sql({ sql: "SELECT 1; SELECT 2; SELECT 3; SELECT 4", mode: "read" }), "LIMIT_EXCEEDED", /^A request may have 3 statements; this one has 4\.$/);
    await refused(access.sql({ sql: `SELECT '${"x".repeat(80)}'`, mode: "read" }), "LIMIT_EXCEEDED", /^A request may have 80 characters of SQL; this one has 89\.$/);
    await refused(access.sql({ sql: "  -- nothing\n", mode: "read" }), "INVALID_REQUEST", /^The request has no statement\.$/);
    await refused(access.sql({ sql: "SELECT 1", mode: "both" as "read" }), "INVALID_REQUEST", /"mode" must be "read" or "write"/);
    await refused(access.sql({ sql: 7 as never, mode: "read" }), "INVALID_REQUEST", /"sql" must be text/);
    await refused(access.sql({ sql: "SELECT 1", mode: "read", maxRows: -2 }), "INVALID_REQUEST", /"maxRows" must be a whole number, 0 or more/);
  });

  it("says so when what a request changed could not be written, and takes it back", async () => {
    const { access, runtime, storage } = await open();
    storage.failNextSave = new Error("the disk is full");
    const outcome = await access.sql({ sql: "DELETE FROM notes", mode: "write" });
    assert.deepEqual([outcome.error?.code, outcome.error?.statement, outcome.rolledBack], ["PERSISTENCE", 1, true]);
    assert.match(outcome.error?.message ?? "", /could not be written to the database, and was taken back: the disk is full/);
    assert.equal(runtime.inTransaction, false);
    assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM notes").rows, [{ n: 3 }]);
  });
});

describe("access to a runtime: what was carried out lately", () => {
  it("is kept, numbered and with its time, whoever asked for it: the application's statements and Studio's", async () => {
    const { access, runtime } = await open({ limits: { maxEvents: 4, maxCellLength: 30 } });
    assert.deepEqual(await access.events(), { events: [], last: 0 });
    runtime.execute("SELECT name FROM users WHERE id = ?", [1]);
    await access.browse({ table: "notes" });
    assert.throws(() => runtime.execute("SELECT * FROM nowhere"));
    const { events, last } = await access.events();
    assert.equal(last, 4);
    assert.deepEqual(
      events.map(({ localExecutionMs: _ms, errorMessage: _message, ...rest }) => rest),
      [
        { seq: 1, at: "2026-10-08T10:00:01.000Z", sql: "SELECT name FROM users WHERE i", operation: "SELECT", tables: ["users"], rows: 1, requestId: "application" },
        { seq: 2, at: "2026-10-08T10:00:02.000Z", sql: 'SELECT COUNT(*) AS "count" FRO', operation: "SELECT", tables: ["notes"], rows: 1, requestId: "studio" },
        { seq: 3, at: "2026-10-08T10:00:03.000Z", sql: 'SELECT * FROM "notes" LIMIT 50', operation: "SELECT", tables: ["notes"], rows: 3, requestId: "studio" },
        { seq: 4, at: "2026-10-08T10:00:04.000Z", sql: "SELECT * FROM nowhere", operation: "SELECT", rows: 0, requestId: "application", errorCode: "SANDBOX_DIALECT_UNSUPPORTED" },
      ],
    );
    // No value of a statement is in an event: not its parameters, not what it returned.
    assert.equal(JSON.stringify(events).includes("user 01"), false);
    // Only so many are kept, and only what is newer is given to whoever has the rest.
    runtime.execute("SELECT 5");
    runtime.execute("SELECT 6");
    assert.deepEqual((await access.events()).events.map((event) => event.seq), [3, 4, 5, 6]);
    assert.deepEqual((await access.events({ after: 5 })).events.map((event) => event.sql), ["SELECT 6"]);
    assert.deepEqual(await access.events({ after: 6 }), { events: [], last: 6 });
    // An access that is closed no longer listens.
    access.close();
    runtime.execute("SELECT 7");
    assert.equal((await access.events()).last, 6);
  });
});

/*
 * A column that the application's ORM fills with the time a row is written,
 * and the database does not (D-047): the TypeORM integration marks it with
 * its decorator. A row added through the access gets the time of the insert
 * there, when no value is given; nothing else is filled.
 */
describe("access to a runtime: a row added where the application's ORM fills the time", () => {
  const SCHEMA_WITH_TIMES: TableSchema[] = [
    {
      name: "posts",
      columns: [
        { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
        { name: "title", type: "text", nullable: false, primary: false },
        { name: "createdAt", type: "datetime", declaredType: "@CreateDateColumn", nullable: false, primary: false },
        { name: "updatedAt", type: "datetime", declaredType: "@UpdateDateColumn", nullable: false, primary: false },
        { name: "day", type: "date", declaredType: "@CreateDateColumn", nullable: false, primary: false },
        // A time the schema says nothing more of, and one the ORM leaves NULL until a row is removed: both are given, or not filled.
        { name: "publishAt", type: "datetime", declaredType: "timestamp", nullable: false, primary: false },
        { name: "deletedAt", type: "datetime", declaredType: "@DeleteDateColumn", nullable: true, primary: false },
        // Marked, but not a time as the runtime stores it: not filled.
        { name: "stamp", type: "text", declaredType: "@CreateDateColumn", nullable: true, primary: false },
      ],
    },
  ];
  const openTimes = async () => {
    const runtime = await SqliteRuntime.open({ schema: SCHEMA_WITH_TIMES, storage: new MemoryStorage({ posts: [] }) });
    const access = new LocalRuntimeAccess({ runtime, identity: IDENTITY, now: () => new Date("2026-10-12T08:30:15.123Z") });
    return { runtime, access };
  };

  it("fills the time of the insert in the ORM's columns that are left out, and keeps what was given", async () => {
    const { runtime, access } = await openTimes();
    assert.deepEqual(await access.insert({ table: "posts", values: { title: "first", publishAt: "2026-11-01T09:00:00.000Z" } }), { affectedRows: 1, lastInsertId: 1 });
    assert.deepEqual(await access.insert({ table: "posts", values: { title: "given", publishAt: "2026-11-01T09:00:00.000Z", createdAt: "2020-01-02T03:04:05.000Z", day: "2020-01-02", deletedAt: null } }), { affectedRows: 1, lastInsertId: 2 });
    const rows = runtime.snapshot().collections.posts;
    assert.deepEqual(rows, [
      { id: 1, title: "first", createdAt: "2026-10-12T08:30:15.123Z", updatedAt: "2026-10-12T08:30:15.123Z", day: "2026-10-12", publishAt: "2026-11-01T09:00:00.000Z", deletedAt: null, stamp: null },
      { id: 2, title: "given", createdAt: "2020-01-02T03:04:05.000Z", updatedAt: "2026-10-12T08:30:15.123Z", day: "2020-01-02", publishAt: "2026-11-01T09:00:00.000Z", deletedAt: null, stamp: null },
    ]);
    // An update leaves them as they are.
    assert.deepEqual(await access.update({ table: "posts", key: { id: 2 }, values: { title: "changed" } }), { affectedRows: 1 });
    assert.equal(runtime.snapshot().collections.posts?.[1]?.updatedAt, "2026-10-12T08:30:15.123Z");
    assert.equal(runtime.snapshot().collections.posts?.[1]?.createdAt, "2020-01-02T03:04:05.000Z");
  });

  it("checks every other column as before: a required time the schema says nothing of, NULL given for the ORM's, and other required columns", async () => {
    const { access } = await openTimes();
    await refused(access.insert({ table: "posts", values: { title: "no publish time" } }), "CONSTRAINT", /NOT NULL constraint failed: posts\.publishAt/);
    await refused(access.insert({ table: "posts", values: { title: "null given", publishAt: "2026-11-01T09:00:00.000Z", createdAt: null } }), "CONSTRAINT", /NOT NULL constraint failed: posts\.createdAt/);
    await refused(access.insert({ table: "posts", values: { publishAt: "2026-11-01T09:00:00.000Z" } }), "CONSTRAINT", /NOT NULL constraint failed: posts\.title/);
    await refused(access.insert({ table: "posts", values: { title: "bad", publishAt: "2026-11-01T09:00:00.000Z", createdAt: "not a time" } }), "INVALID_VALUE");
  });

  it("says in the schema which columns it fills with the time of the insert", async () => {
    const { access } = await openTimes();
    const columns = (await access.schema()).tables[0]?.columns ?? [];
    assert.deepEqual(
      columns.map((column) => [column.name, column.generated ?? null]),
      [["id", "increment"], ["title", null], ["createdAt", INSERT_TIME], ["updatedAt", INSERT_TIME], ["day", INSERT_TIME], ["publishAt", null], ["deletedAt", null], ["stamp", null]],
    );
    assert.equal(INSERT_TIME, "insert time");
  });
});
