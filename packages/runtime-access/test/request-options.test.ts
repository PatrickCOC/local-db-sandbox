import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_ACCESS_LIMITS } from "../src/index.ts";
import { refused } from "./support/assertions.ts";
import { IDENTITY, open } from "./support/fixture.ts";

/*
 * What a request says beside what it asks (D-042): the owner it was made
 * for. And how much an answer may hold, whatever was asked. Both are the
 * access's own, so that they hold whether it is asked in its process or
 * through the control.
 */

const OTHER = "f".repeat(48);

describe("access to a runtime: the owner a request was made for", () => {
  it("carries out a request that was made for this owner, and one that names none", async () => {
    const { access, storage } = await open();
    const mine = { owner: IDENTITY.instance };
    assert.equal((await access.info(mine)).instance, IDENTITY.instance);
    assert.equal((await access.schema(mine)).tables.length, 4);
    assert.equal((await access.browse({ table: "users" }, mine)).total, 25);
    assert.equal((await access.row({ table: "users", key: { id: 1 } }, mine)).row.name, "user 01");
    assert.deepEqual(await access.insert({ table: "notes", values: { text: "a" } }, mine), { affectedRows: 1 });
    assert.deepEqual(await access.update({ table: "users", key: { id: 1 }, values: { name: "b" } }, mine), { affectedRows: 1 });
    assert.deepEqual(await access.delete({ table: "users", key: { id: 25 } }, mine), { affectedRows: 1 });
    assert.equal((await access.sql({ sql: "DELETE FROM notes WHERE text = 'a'", mode: "write" }, mine)).results[0]?.affectedRows, 1);
    assert.ok((await access.events({}, mine)).last > 0);
    assert.equal(storage.saved.length, 4);
    assert.deepEqual(await access.insert({ table: "notes", values: { text: "c" } }, {}), { affectedRows: 1 });
    assert.deepEqual(await access.insert({ table: "notes", values: { text: "d" } }), { affectedRows: 1 });
  });

  it("carries out nothing of a request that was made for another owner, whatever it asks", async () => {
    const { access, storage, events } = await open();
    const theirs = { owner: OTHER };
    const said = /^The database is open in another process than the one this was asked of\. Nothing was done\. Look at the data as it is now before doing it again\.$/;
    await refused(access.info(theirs), "OWNER_CHANGED", said);
    await refused(access.schema(theirs), "OWNER_CHANGED", said);
    await refused(access.browse({ table: "users" }, theirs), "OWNER_CHANGED", said);
    await refused(access.row({ table: "users", key: { id: 1 } }, theirs), "OWNER_CHANGED", said);
    await refused(access.insert({ table: "notes", values: { text: "a" } }, theirs), "OWNER_CHANGED", said);
    await refused(access.update({ table: "users", key: { id: 1 }, values: { name: "b" } }, theirs), "OWNER_CHANGED", said);
    await refused(access.delete({ table: "users", key: { id: 25 } }, theirs), "OWNER_CHANGED", said);
    await refused(access.sql({ sql: "DELETE FROM notes", mode: "write" }, theirs), "OWNER_CHANGED", said);
    await refused(access.sql({ sql: "SELECT 1", mode: "read" }, theirs), "OWNER_CHANGED", said);
    await refused(access.events({}, theirs), "OWNER_CHANGED", said);
    // Before anything else is looked at: a request that could not be carried out anyway is told the same.
    await refused(access.browse({ table: "nowhere" }, theirs), "OWNER_CHANGED");
    await refused(access.insert({ table: "notes", values: { text: "a" } }, { owner: 7 as never }), "OWNER_CHANGED");
    assert.equal(storage.saved.length, 0);
    assert.equal(events.length, 0);
  });
});

describe("access to a runtime: how much an answer may hold", () => {
  it("is eight megabytes unless it is said otherwise, and is said with the other limits", async () => {
    assert.equal(DEFAULT_ACCESS_LIMITS.maxResponseBytes, 8 * 1024 * 1024);
    const { access } = await open({ limits: { maxResponseBytes: 5_000 } });
    assert.equal((await access.info()).limits.maxResponseBytes, 5_000);
  });

  it("refuses a page that holds more, and says how many rows it was asked for", async () => {
    const sized = await open();
    const whole = Buffer.byteLength(JSON.stringify(await sized.access.browse({ table: "users" })));
    const { access } = await open({ limits: { maxResponseBytes: whole - 1 } });
    const error = await refused(access.browse({ table: "users" }), "LIMIT_EXCEEDED");
    assert.equal(error.message, `A page of 25 rows of "users" has ${whole} bytes, and an answer may have ${whole - 1}. Ask for fewer rows.`);
    assert.equal(error.status, 413);
    assert.equal((await access.browse({ table: "users", limit: 24 })).rows.length, 24);
    // What a page may hold exactly, it holds.
    assert.equal((await (await open({ limits: { maxResponseBytes: whole } })).access.browse({ table: "users" })).rows.length, 25);
  });

  it("leaves the values out of a row that is read to be edited which do not fit, and names them", async () => {
    const { access, runtime } = await open({ limits: { maxResponseBytes: 800 } });
    runtime.execute("UPDATE users SET name = ?, settings = ? WHERE id = 2", ["n".repeat(400), JSON.stringify({ text: "s".repeat(500) })]);
    const read = await access.row({ table: "users", key: { id: 2 } });
    // In the order of the columns: the name fits, and what comes after it and does not is left out.
    assert.deepEqual(read, { table: "users", row: { id: 2, name: "n".repeat(400), active: false, score: 3, joined: "2026-01-02T08:00:00.000Z", role: "admin" }, tooLong: ["settings"] });
    assert.ok(Buffer.byteLength(JSON.stringify(read)) <= 800);
    // A row that fits is whole.
    assert.deepEqual((await access.row({ table: "users", key: { id: 1 } })).tooLong, []);
  });

  it("takes back a request to the console whose results hold more, before anything of it is committed", async () => {
    const sized = await open();
    const [all] = (await sized.access.sql({ sql: "SELECT * FROM users", mode: "read" })).results;
    const whole = Buffer.byteLength(JSON.stringify(all));
    const { access, runtime, storage } = await open({ limits: { maxResponseBytes: whole - 1 } });
    const written = await access.sql({ sql: "DELETE FROM notes; SELECT * FROM users; DELETE FROM memberships", mode: "write" });
    assert.deepEqual([written.results.map((each) => each.operation), written.rolledBack], [["DELETE"], true]);
    assert.deepEqual(written.error, {
      statement: 2,
      sql: "SELECT * FROM users",
      code: "LIMIT_EXCEEDED",
      message: `The results of this request have more than ${whole - 1} bytes, which is what an answer may have. Ask for fewer rows.`,
    });
    assert.equal(storage.saved.length, 0);
    assert.equal(runtime.inTransaction, false);
    assert.deepEqual(runtime.execute("SELECT (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM memberships) AS memberships").rows, [{ notes: 3, memberships: 3 }]);
    // Reading: what was returned before stays, and nothing after it is carried out.
    const read = await access.sql({ sql: "SELECT 1 AS one; SELECT * FROM users; SELECT 2 AS two", mode: "read" });
    assert.deepEqual([read.results.map((each) => each.rows), read.error?.statement, read.error?.code, read.rolledBack], [[[[1]]], 2, "LIMIT_EXCEEDED", undefined]);
    // Asked for fewer rows, the same request is carried out.
    const fewer = await access.sql({ sql: "DELETE FROM notes; SELECT * FROM users; DELETE FROM memberships", mode: "write", maxRows: 5 });
    assert.deepEqual([fewer.error, fewer.results.map((each) => [each.operation, each.rows.length, each.truncated])], [undefined, [["DELETE", 0, false], ["SELECT", 5, true], ["DELETE", 0, false]]]);
    assert.equal(storage.saved.length, 1);
  });
});
