import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { DATA, SCHEMA } from "../../runtime-access/test/support/fixture.ts";
import { ownDatabase } from "../../runtime-access/test/support/owner-process.ts";
import type { OwnerProcess } from "../../runtime-access/test/support/owner-process.ts";
import { createDatabase } from "../../storage-json/src/index.ts";
import { schemaFile, storedRows } from "../../storage-json/test/support/database-files.ts";
import { startStudio } from "../src/index.ts";
import type { RunningStudio } from "../src/index.ts";
import { PAGE_HELPERS, openBrowser } from "./support/browser.ts";

/*
 * The Clear data tab in a browser (D-051): choosing tables, the
 * acknowledgement and the dialog that a clear needs, a refusal when a table
 * that is not chosen refers to one that is, and the rows read again after.
 * Standalone, read-only, and attached to a process that has the database
 * open, through whose runtime the rows are deleted.
 */

const { browser, unavailable } = await openBrowser();

describe("Studio's Clear data tab in a browser", { timeout: 240_000, skip: browser === undefined ? unavailable : false }, () => {
  let root: string;
  let directory: string;
  let studio: RunningStudio | undefined;
  const owners: OwnerProcess[] = [];
  const page = browser as NonNullable<typeof browser>;
  const t = <T = unknown>(expression: string): Promise<T> => page.evaluate<T>(expression);

  const visit = async (options: { readOnly?: boolean } = {}): Promise<void> => {
    studio = await startStudio({ database: directory, port: 0, ...options });
    await page.open(studio.address);
    await page.until("document.readyState === 'complete' && document.querySelectorAll('#tables li button').length > 0", "the tables are listed");
    await t(PAGE_HELPERS);
    await page.until("__t.text('#connection') === 'connected'", "connected");
    await t("__t.press('Clear data')");
  };
  const choose = (...tables: string[]): Promise<unknown> => t(tables.map((name) => `document.querySelector('#clear-tables [data-table="${name}"]').click();`).join(" ") + " true");
  const state = (): Promise<{ summary: string; disabled: boolean }> => t("({ summary: __t.text('#clear-summary'), disabled: document.getElementById('clear-run').disabled })");

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-clear-page-"));
  });
  after(async () => {
    await browser?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    directory = join(root, `db-${Math.random().toString(16).slice(2)}`, "sandbox.db");
    await createDatabase(directory, { collections: DATA(), schema: SCHEMA }, { format: "directory" });
    page.problems.length = 0;
  });
  afterEach(async () => {
    await studio?.stop();
    studio = undefined;
    for (const owner of owners.splice(0)) {
      await owner.kill();
    }
  });

  it("asks for tables, an acknowledgement, and a confirmation; refuses what would leave rows of another table dangling; then clears and reads again", async () => {
    await visit();
    const schemaBefore = await readFile(schemaFile(directory), "utf8");
    assert.deepEqual(await t("__t.all('#clear-tables li')"), ["users (25 rows)", "orders (2 rows)", "memberships (3 rows)", "notes (3 rows)"]);
    assert.deepEqual(await state(), { summary: "0 tables · 0 rows to delete", disabled: true });
    await choose("users");
    // Chosen, and not yet acknowledged: the button stays off.
    assert.deepEqual(await state(), { summary: "1 table · 25 rows to delete", disabled: true });
    await t("document.getElementById('clear-understood').click()");
    assert.equal((await state()).disabled, false);

    // The dialog says what goes, what stays, and that it cannot be undone. Cancel does nothing.
    await t("__t.press('Clear data…')");
    await page.until("__t.shown('#dialog')", "the dialog");
    assert.equal(await t("__t.text('#dialog-title')"), "Delete 25 rows from 1 table?");
    assert.match(await t<string>("__t.text('#dialog-body')"), /Every row of this table is deleted, in one transaction: users \(25\)\.[\s\S]*The tables stay as they are[\s\S]*This cannot be undone\./);
    await t("__t.press('Cancel', '#dialog')");
    assert.equal((await storedRows(directory, "users")).length, 25);

    // users alone: orders, which is not chosen, refers to it. Refused, and nothing changed.
    await t("__t.press('Clear data…')");
    await page.until("__t.shown('#dialog')", "the dialog");
    await t("__t.press('Delete the rows', '#dialog')");
    await page.until("document.getElementById('clear-failure') !== null", "the refusal");
    assert.equal(await t("__t.text('#clear-failure strong')"), "CONSTRAINT");
    assert.match(await t<string>("__t.text('#clear-failure p')"), /^Nothing was cleared: 2 rows of "orders" \(userId\) refer to "users", which is not chosen\./);
    assert.equal((await storedRows(directory, "users")).length, 25);

    // With orders: cleared, and the tables read again.
    await choose("orders");
    assert.equal((await state()).summary, "2 tables · 27 rows to delete");
    await t("__t.press('Clear data…')");
    await page.until("__t.shown('#dialog')", "the dialog");
    assert.equal(await t("__t.text('#dialog-title')"), "Delete 27 rows from 2 tables?");
    await t("__t.press('Delete the rows', '#dialog')");
    await page.until("document.getElementById('clear-done') !== null", "the rows are deleted");
    assert.equal(await t("__t.text('#clear-done')"), "Deleted 27 rows from 2 tables: users (25), orders (2).");
    await page.until("__t.all('#tables li button')[0] === 'users 0'", "the tables are read again");
    assert.deepEqual(await t("__t.all('#clear-tables li')"), ["users (0 rows)", "orders (0 rows)", "memberships (3 rows)", "notes (3 rows)"]);
    // The acknowledgement is asked for again for the next clear.
    assert.equal(await t("document.getElementById('clear-understood').checked"), false);
    assert.deepEqual([(await storedRows(directory, "users")).length, (await storedRows(directory, "orders")).length, (await storedRows(directory, "notes")).length], [0, 0, 3]);
    assert.equal(await readFile(schemaFile(directory), "utf8"), schemaBefore);
    // The Rows tab shows the table as it is now.
    await t("__t.press('Rows')");
    await page.until("(__t.grid() === null || __t.grid().rows.length === 0)", "the empty table");
    assert.deepEqual(page.problems, []);
  });

  it("clears nothing in a Studio that is read-only, and says why", async () => {
    await visit({ readOnly: true });
    await choose("notes");
    await t("document.getElementById('clear-understood').click()");
    assert.equal((await state()).disabled, true);
    assert.match(await t<string>("__t.text('#clear-locked')"), /^Read-only: Studio was started with --read-only\.$/);
  });

  it("clears through the process that has the database open, attached to it", async () => {
    const owner = await ownDatabase(directory, "nest");
    owners.push(owner);
    await visit();
    await choose("notes", "memberships");
    await t("document.getElementById('clear-understood').click()");
    await t("__t.press('Clear data…')");
    await page.until("__t.shown('#dialog')", "the dialog");
    await t("__t.press('Delete the rows', '#dialog')");
    await page.until("document.getElementById('clear-done') !== null", "the rows are deleted");
    // The owner's runtime has no rows in those tables, and has saved that.
    assert.deepEqual(await owner.sql("SELECT (SELECT COUNT(*) FROM notes) AS notes, (SELECT COUNT(*) FROM memberships) AS memberships, (SELECT COUNT(*) FROM users) AS users"), [{ notes: 0, memberships: 0, users: 25 }]);
    assert.deepEqual([(await storedRows(directory, "notes")).length, (await storedRows(directory, "memberships")).length], [0, 0]);
    assert.deepEqual(page.problems, []);
  });
});
