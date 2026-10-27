import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { DATA, SCHEMA } from "../../runtime-access/test/support/fixture.ts";
import { createDatabase } from "../../storage-json/src/index.ts";
import { startStudio } from "../src/index.ts";
import type { RunningStudio, StudioExporter } from "../src/index.ts";
import { PAGE_HELPERS, openBrowser } from "./support/browser.ts";

/*
 * The Export tab in a browser (D-050): choosing tables and what to export,
 * the confirmation that an export with data asks for, and the file the page
 * makes of the script, with its name. The exporter is one of the test's own
 * (Studio knows no dialect); a refusal of it leaves no file. The browser is
 * the one the machine has, headless, as for the rest of the page's tests.
 */

const { browser, unavailable } = await openBrowser();

describe("Studio's Export tab in a browser", { timeout: 240_000, skip: browser === undefined ? unavailable : false }, () => {
  let root: string;
  let directory: string;
  let studio: RunningStudio | undefined;
  const page = browser as NonNullable<typeof browser>;
  const t = <T = unknown>(expression: string): Promise<T> => page.evaluate<T>(expression);
  const exporter: StudioExporter = async (snapshot, request) => {
    if (request.tables.includes("notes")) {
      return { status: "refused", refusals: [{ table: "notes", column: "text", message: "Row 2: cannot be written." }] };
    }
    const rows = Object.values(snapshot.rows ?? {}).reduce((sum, list) => sum + list.length, 0);
    return { status: "exported", sql: `-- ${request.mode}\n-- ${snapshot.schema.tables.map((table) => table.name).join(", ")}\nSELECT 'ünïcødé ''quoted''';\n`, tables: snapshot.schema.tables.map((table) => table.name), rows, statements: 1, warnings: ["Something is left out."] };
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-export-page-"));
  });
  after(async () => {
    await browser?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    directory = join(root, `db-${Math.random().toString(16).slice(2)}`, "sandbox.db");
    await createDatabase(directory, { collections: DATA(), schema: SCHEMA }, { format: "directory" });
    page.problems.length = 0;
    studio = await startStudio({ database: directory, port: 0, exporter });
    await page.open(studio.address);
    await page.until("document.readyState === 'complete' && document.querySelectorAll('#tables li button').length > 0", "the tables are listed");
    await t(PAGE_HELPERS);
    // What the page offers as a file is kept, to be read: the page's own policy lets it fetch nothing but its server.
    await t("window.__files = []; const made = URL.createObjectURL; URL.createObjectURL = (blob) => { window.__files.push(blob); return made(blob); }; true");
  });
  afterEach(async () => {
    await studio?.stop();
    studio = undefined;
  });

  const state = (): Promise<{ summary: string; disabled: boolean; confirmShown: boolean }> =>
    t("({ summary: __t.text('#export-summary'), disabled: document.getElementById('export-run').disabled, confirmShown: !document.getElementById('export-confirm-line').hidden })");

  it("chooses tables and what to export, asks to confirm an export with data, and makes the file with its name", async () => {
    await t("__t.press('Export')");
    assert.equal(await t("document.getElementById('view-export').hidden"), false);
    assert.equal(await t("document.getElementById('view-table').hidden"), true);
    assert.deepEqual(await t("__t.all('#export-tables li')"), ["users (25 rows)", "orders (2 rows)", "memberships (3 rows)", "notes (3 rows)"]);
    assert.deepEqual(await t("__t.all('#export-modes label')"), [
      "Schema only — CREATE TABLE, keys, foreign keys, unique constraints, defaults, indexes, enumerated types",
      "Data only — INSERT statements for the rows, for tables that are there already",
      "Schema + data — the definitions, the rows, and the foreign keys after them",
    ]);
    // Nothing chosen: nothing to export. Schema only is the default, and asks for no confirmation.
    assert.deepEqual(await state(), { summary: "0 tables · Schema only", disabled: true, confirmShown: false });
    await t("document.querySelector('[data-table=\"users\"]').click(); document.querySelector('[data-table=\"orders\"]').click(); true");
    assert.deepEqual(await state(), { summary: "2 tables · Schema only", disabled: false, confirmShown: false });
    // With data: the rows may be what a person entered, so it is asked for in so many words.
    await t("document.getElementById('export-mode-schema-and-data').click()");
    assert.deepEqual(await state(), { summary: "2 tables · Schema + data", disabled: true, confirmShown: true });
    assert.equal(await t("__t.text('#export-confirm-line')"), "The file will hold the rows of these tables, which may be data you entered: I want them in it.");
    await t("document.getElementById('export-confirm').click()");
    assert.deepEqual(await state(), { summary: "2 tables · Schema + data", disabled: false, confirmShown: true });

    await t("__t.press('Export .sql')");
    await page.until("document.getElementById('export-done') !== null", "the export is done");
    assert.equal(await t("__t.text('#export-done h3')"), "Exported 2 tables · Schema + data · 27 rows");
    assert.equal(await t("__t.all('#export-warnings li')[0]"), "Something is left out.");
    const name = await t<string>("document.getElementById('export-download').getAttribute('download')");
    assert.match(name, /^local-db-export-schema-and-data-\d{8}T\d{6}Z\.sql$/);
    assert.match(await t<string>("document.getElementById('export-download').href"), /^blob:http:\/\/127\.0\.0\.1:\d+\//);
    assert.deepEqual(await t("Promise.all(window.__files.map(async (file) => [file.type, await file.text()]))"), [["application/sql;charset=utf-8", "-- schema-and-data\n-- users, orders\nSELECT 'ünïcødé ''quoted''';\n"]]);
    // All, and none.
    await t("__t.press('All')");
    assert.equal((await state()).summary, "4 tables · Schema + data");
    await t("__t.press('None')");
    assert.deepEqual(await state(), { summary: "0 tables · Schema + data", disabled: true, confirmShown: true });
    assert.deepEqual(page.problems, []);
  });

  it("makes no file when the export is refused, and says every reason; the other tabs go on as they were", async () => {
    await t("__t.press('Export')");
    await t("__t.press('All')");
    await t("__t.press('Export .sql')");
    await page.until("document.getElementById('export-failure') !== null", "the refusal is shown");
    assert.deepEqual(await t("[__t.text('#export-failure strong'), __t.text('#export-failure p'), __t.all('#export-failure li')]"), ["EXPORT_REFUSED", "The export was not made: one reason. No file was made.", ["notes.text: Row 2: cannot be written."]]);
    assert.equal(await t("window.__files.length"), 0);
    assert.equal(await t("document.getElementById('export-download')"), null);
    // The Rows and SQL tabs are as they were.
    await t("__t.press('Rows')");
    await page.until("__t.grid() !== null && __t.grid().rows.length === 25", "the rows of the first table");
    await t("__t.press('SQL')");
    await t("__t.fill('#sql-text', 'SELECT COUNT(*) AS n FROM orders')");
    await t("__t.press('Run', '#view-sql')");
    await page.until("document.querySelectorAll('#sql-results .result').length === 1", "the result");
    assert.equal(await t("document.querySelector('#sql-results td').textContent"), "2");
    assert.deepEqual(page.problems, []);
  });
});
