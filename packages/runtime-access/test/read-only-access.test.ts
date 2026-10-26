import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReadOnlyAccess } from "../src/index.ts";
import { refused } from "./support/assertions.ts";
import { IDENTITY, open } from "./support/fixture.ts";

/*
 * An access through which nothing is changed, whatever the access behind it
 * would allow (D-042): what Studio has of a runtime when it was started to
 * look only. The runtime may be an application's, which goes on changing
 * its database as before.
 */

const WHY = "Studio was started with --read-only.";

describe("an access through which nothing is changed", () => {
  it("reads as the access behind it reads, and says that nothing can be changed through it, and why", async () => {
    const { access } = await open();
    const looking = new ReadOnlyAccess(access, WHY);
    assert.deepEqual(await looking.info(), { ...(await access.info()), readOnly: WHY });
    assert.deepEqual(await looking.schema(), await access.schema());
    assert.deepEqual(await looking.browse({ table: "users", limit: 3 }), await access.browse({ table: "users", limit: 3 }));
    assert.deepEqual(await looking.row({ table: "users", key: { id: 1 } }), await access.row({ table: "users", key: { id: 1 } }));
    assert.deepEqual((await looking.sql({ sql: "SELECT COUNT(*) AS n FROM users", mode: "read" })).results[0]?.rows, [[25]]);
    assert.equal((await looking.events()).last, (await access.events()).last);
    // Its reason stands before the one the access behind it has: it is the nearer one.
    const file = await open({ format: "file" });
    assert.equal((await new ReadOnlyAccess(file.access, WHY).info()).readOnly, WHY);
  });

  it("refuses every change with the reason, and asks nothing of the access behind it", async () => {
    const { access, storage, events } = await open();
    const looking = new ReadOnlyAccess(access, WHY);
    const said = /^Studio was started with --read-only\.$/;
    await refused(looking.insert({ table: "notes", values: { text: "x" } }), "READ_ONLY", said);
    await refused(looking.update({ table: "users", key: { id: 1 }, values: { name: "x" } }), "READ_ONLY", said);
    await refused(looking.delete({ table: "users", key: { id: 25 } }), "READ_ONLY", said);
    await refused(looking.sql({ sql: "DELETE FROM notes", mode: "write" }), "READ_ONLY", said);
    // Also a request that could not be carried out anyway: it is not looked at.
    await refused(looking.insert({ table: "nowhere", values: {} }), "READ_ONLY", said);
    await refused(looking.sql({ sql: "SELECT 1", mode: "write" }), "READ_ONLY", said);
    assert.equal(storage.saved.length, 0);
    assert.equal(events.length, 0);
    // The access behind it changes its database as before: it is not this one's to forbid.
    assert.deepEqual(await access.insert({ table: "notes", values: { text: "the application's" } }), { affectedRows: 1 });
    assert.equal((await looking.browse({ table: "notes" })).total, 4);
  });

  it("lets the console read, and a statement that would write is refused where it always is: by SQLite", async () => {
    const { access, storage } = await open();
    const looking = new ReadOnlyAccess(access, WHY);
    const result = await looking.sql({ sql: "SELECT 1 AS one; DELETE FROM notes", mode: "read" });
    assert.deepEqual([result.results.map((each) => each.rows), result.error?.statement, result.error?.code], [[[[1]]], 2, "READ_ONLY"]);
    assert.equal(storage.saved.length, 0);
    await refused(looking.sql({ sql: "SELECT 1", mode: "both" as "read" }), "INVALID_REQUEST", /"mode" must be "read" or "write"/);
  });

  it("passes on which owner a request was made for", async () => {
    const { access } = await open();
    const looking = new ReadOnlyAccess(access, WHY);
    await refused(looking.browse({ table: "users" }, { owner: "f".repeat(48) }), "OWNER_CHANGED");
    await refused(looking.info({ owner: "f".repeat(48) }), "OWNER_CHANGED");
    assert.equal((await looking.browse({ table: "users" }, { owner: IDENTITY.instance })).total, 25);
  });
});
