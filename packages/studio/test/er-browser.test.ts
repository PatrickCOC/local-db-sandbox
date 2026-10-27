import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { ownDatabase } from "../../runtime-access/test/support/owner-process.ts";
import type { OwnerProcess } from "../../runtime-access/test/support/owner-process.ts";
import type { TableSchema } from "../../runtime/src/index.ts";
import { createDatabase } from "../../storage-json/src/index.ts";
import { databaseFiles } from "../../storage-json/test/support/database-files.ts";
import { startStudio } from "../src/index.ts";
import type { RunningStudio } from "../src/index.ts";
import { PAGE_HELPERS, openBrowser } from "./support/browser.ts";
import { ER_ROWS, ER_SCHEMA, MARKUP_NAME, UNICODE_TABLE, manyTables, tableName } from "./support/er-fixture.ts";

/*
 * The ER Diagram tab in a browser (D-053): what it draws of every kind of
 * key, names that would be markup, finding a table, zooming, panning,
 * fitting, moving a table and putting it back, with a real mouse; fifty
 * and a hundred tables; a Studio that is read-only, and one that is
 * attached. Nothing of it reads a row or changes the database, and the
 * other tabs go on as they were.
 */

const { browser, unavailable } = await openBrowser();

interface Box {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  transform: string;
}

describe("Studio's ER Diagram tab in a browser", { timeout: 300_000, skip: browser === undefined ? unavailable : false }, () => {
  let root: string;
  let directory: string;
  let studio: RunningStudio | undefined;
  const owners: OwnerProcess[] = [];
  const page = browser as NonNullable<typeof browser>;
  const t = <T = unknown>(expression: string): Promise<T> => page.evaluate<T>(expression);

  const database = async (schema: TableSchema[], rows: Record<string, Record<string, unknown>[]> = {}): Promise<void> => {
    directory = join(root, `db-${Math.random().toString(16).slice(2)}`, "sandbox.db");
    await createDatabase(directory, { collections: rows, schema }, { format: "directory" });
  };
  /** Opens Studio's page, notes from then on every request the page sends, and opens the ER Diagram tab. */
  const visit = async (tables: number, options: { readOnly?: boolean } = {}): Promise<void> => {
    studio = await startStudio({ database: directory, port: 0, ...options });
    await page.open(studio.address);
    await page.until("document.readyState === 'complete' && document.getElementById('tables').children.length > 0", "the tables are listed");
    await t(PAGE_HELPERS);
    await page.until("__t.text('#connection') === 'connected'", "connected");
    await t("window.__asked = []; const sent = window.fetch; window.fetch = (url, options) => { window.__asked.push(String(url)); return sent(url, options); }; true");
    await t("__t.press('ER Diagram')");
    await page.until(`document.querySelectorAll('#er-boxes .er-table').length === ${tables} && !/Laying/.test(__t.text('#er-summary'))`, `the diagram of ${tables} tables`, 60_000);
  };
  const view = (): Promise<{ x: number; y: number; k: number }> =>
    t("(() => { const m = /translate\\(([-\\d.e]+) ([-\\d.e]+)\\) scale\\(([-\\d.e]+)\\)/.exec(document.getElementById('er-viewport').getAttribute('transform')); return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) }; })()");
  const canvas = (): Promise<{ left: number; top: number; right: number; bottom: number; width: number; height: number }> => t("(() => { const r = document.getElementById('er-canvas').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()");
  const boxes = (): Promise<Box[]> =>
    t("[...document.querySelectorAll('#er-boxes .er-table')].map((box) => { const r = box.querySelector('rect.box').getBoundingClientRect(); return { name: box.getAttribute('data-table'), left: r.left, top: r.top, right: r.right, bottom: r.bottom, transform: box.getAttribute('transform') }; })");
  const box = async (name: string): Promise<Box> => {
    const found = (await boxes()).find((each) => each.name === name);
    assert.ok(found, `a box for ${name}`);
    return found;
  };
  /** Every box within the canvas. */
  const allInView = async (): Promise<void> => {
    const area = await canvas();
    for (const each of await boxes()) {
      assert.ok(each.left >= area.left - 1 && each.right <= area.right + 1 && each.top >= area.top - 1 && each.bottom <= area.bottom + 1, `${each.name} is in view: ${JSON.stringify(each)} in ${JSON.stringify(area)}`);
    }
  };
  /** Presses the mouse at a point, moves it by (dx, dy) in steps, and lets go. */
  const drag = async (x: number, y: number, dx: number, dy: number): Promise<void> => {
    await page.mouse("mouseMoved", x, y);
    await page.mouse("mousePressed", x, y);
    for (let step = 1; step <= 4; step += 1) {
      await page.mouse("mouseMoved", x + (dx * step) / 4, y + (dy * step) / 4);
    }
    await page.mouse("mouseReleased", x + dx, y + dy);
  };
  /** What the page asked its server since the tab was opened, but for how things are. */
  const asked = (): Promise<string[]> => t("window.__asked.filter((url) => url !== '/api/status')");

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-er-page-"));
  });
  after(async () => {
    await browser?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(() => {
    page.problems.length = 0;
  });
  afterEach(async () => {
    await studio?.stop();
    studio = undefined;
    for (const owner of owners.splice(0)) {
      await owner.kill();
    }
  });

  it("draws every table with its columns, keys, and NULL, and every foreign key from column to column", async () => {
    await database(ER_SCHEMA, ER_ROWS());
    const files = await databaseFiles(directory);
    await visit(9);
    assert.equal(await t("document.getElementById('view-er').hidden"), false);
    assert.equal(await t("document.getElementById('view-table').hidden"), true);
    assert.equal(await t("__t.text('#er-summary')"), "9 tables · 7 foreign keys");
    assert.equal(await t("document.getElementById('er-note').hidden"), true);
    // Every table, also the one no key touches.
    assert.deepEqual((await boxes()).map((each) => each.name).sort(), ER_SCHEMA.map((table) => table.name).sort());
    const lines = (name: string): Promise<string[]> =>
      t(`[...document.querySelectorAll('#er-boxes .er-table')].find((box) => box.getAttribute('data-table') === ${JSON.stringify(name)}).querySelectorAll('g.column').length === 0 ? [] : [...[...document.querySelectorAll('#er-boxes .er-table')].find((box) => box.getAttribute('data-table') === ${JSON.stringify(name)}).querySelectorAll('g.column')].map((line) => [...line.querySelectorAll('text')].map((text) => text.textContent).join(' '))`);
    // A primary key over two columns, one of them a foreign key too; NULL and NOT NULL.
    assert.deepEqual(await lines("order_lines"), ["PK FK order_id integer not null", "PK line_no integer not null", "quantity integer not null"]);
    assert.deepEqual(await lines("customers"), ["PK id integer not null", "email varchar(120) not null"]);
    assert.deepEqual(await lines("employees"), ["PK id integer not null", "FK manager_id integer null", "FK department_id integer null"]);
    assert.deepEqual(await lines("audit_log"), ["message text null"]);
    // One line per pair of columns: a key over two columns has two, one for each pair.
    assert.equal(await t("document.querySelectorAll('#er-edges path.er-edge').length"), 8);
    const titles = await t<Record<string, string[]>>("(() => { const found = {}; for (const path of document.querySelectorAll('#er-edges path.er-edge')) { (found[path.getAttribute('data-fk')] = found[path.getAttribute('data-fk')] || []).push(path.querySelector('title').textContent); } return found; })()");
    assert.deepEqual(Object.values(titles).map((list) => [list.length, list[0]]), [
      [1, "orders_customer_fk: orders (customer_id) → customers (id)\nON DELETE SET NULL"],
      [1, "order_lines (order_id) → orders (id)"],
      [2, "shipments_line_fk: shipments (line_order, line_number) → order_lines (order_id, line_no)"],
      [1, "employees_manager_fk: employees (manager_id) → employees (id)"],
      [1, "employees (department_id) → departments (id)"],
      [1, "departments (head_id) → employees (id)"],
      [1, `${UNICODE_TABLE} (customer_id) → customers (id)`],
    ]);
    // Every line is drawn, also the one of a table to itself, which loops out of the table's side and back.
    assert.equal(await t("[...document.querySelectorAll('#er-edges path.er-edge')].every((path) => /^M[-\\d.]+ [-\\d.]+ C/.test(path.getAttribute('d')) && path.getTotalLength() > 0)"), true);
    // The first view shows every table.
    await allInView();
    assert.deepEqual(await asked(), ["/api/diagram"]);
    assert.deepEqual(await databaseFiles(directory), files);
    assert.deepEqual(page.problems, []);
  });

  it("puts names on the page as text, never as markup, also in Chinese, with quotes, and with emoji", async () => {
    await database(ER_SCHEMA);
    await visit(9);
    assert.equal(await t("window.__xss"), undefined);
    assert.equal(await t("document.querySelectorAll('#view-er img, #view-er b').length"), 0);
    const title = (name: string): Promise<string> => t(`[...document.querySelectorAll('#er-boxes .er-table')].find((box) => box.getAttribute('data-table') === ${JSON.stringify(name)}).querySelector('text.title').textContent`);
    assert.equal(await title(MARKUP_NAME), MARKUP_NAME);
    assert.equal(await title(UNICODE_TABLE), UNICODE_TABLE);
    assert.equal(await t(`[...document.querySelectorAll('#er-boxes .er-table')].find((box) => box.getAttribute('data-table') === ${JSON.stringify(UNICODE_TABLE)}).querySelectorAll('text.name')[1].textContent`), "名稱 😀");
    // Found by a part of its name, and the list of what is found holds the name as text too.
    await t("__t.fill('#er-search', '<img')");
    assert.deepEqual(await t("__t.all('#er-results li')"), [MARKUP_NAME]);
    await t("__t.fill('#er-search', '資料')");
    assert.deepEqual(await t("__t.all('#er-results li')"), [UNICODE_TABLE]);
    assert.equal(await t("window.__xss"), undefined);
    assert.deepEqual(page.problems, []);
  });

  it("finds a table and shows it in the middle; zooms with the buttons and the wheel; pans; fits; moves a table and puts it back", async () => {
    await database(ER_SCHEMA, ER_ROWS());
    const files = await databaseFiles(directory);
    await visit(9);
    const fitted = await view();
    const area = await canvas();

    // Zoom in and out, about the middle of the canvas.
    await t("__t.press('Zoom in')");
    assert.ok(Math.abs((await view()).k - fitted.k * 1.25) < 1e-9);
    assert.equal(await t("__t.text('#er-zoom')"), `${Math.round(fitted.k * 125)}%`);
    await t("__t.press('Zoom out')");
    assert.ok(Math.abs((await view()).k - fitted.k) < 1e-9);
    // The wheel zooms about the point under the mouse, which stays where it is.
    const middle = { x: area.left + area.width / 2 + 40, y: area.top + area.height / 2 - 30 };
    const before = await view();
    await page.mouse("mouseWheel", middle.x, middle.y, -300);
    await page.until(`/scale\\((?!${before.k.toString().replace(".", "\\\\.")}\\))/.test(document.getElementById('er-viewport').getAttribute('transform'))`, "the wheel zoomed");
    const wheeled = await view();
    assert.ok(wheeled.k > before.k);
    const world = (at: { x: number; y: number; k: number }): { x: number; y: number } => ({ x: (middle.x - area.left - at.x) / at.k, y: (middle.y - area.top - at.y) / at.k });
    assert.ok(Math.abs(world(wheeled).x - world(before).x) < 0.5 && Math.abs(world(wheeled).y - world(before).y) < 0.5);

    // Panning: the background is dragged, and the drawing moves with it.
    await t("__t.press('Fit to view')");
    assert.deepEqual(await view(), fitted);
    // A corner of the canvas where no table is.
    const empty = { x: area.left + 6, y: area.bottom - 6 };
    assert.equal(await t(`document.elementFromPoint(${empty.x}, ${empty.y}).id`), "er-canvas");
    await drag(empty.x, empty.y, 120, -70);
    const panned = await view();
    assert.ok(Math.abs(panned.x - fitted.x - 120) < 0.5 && Math.abs(panned.y - fitted.y + 70) < 0.5, JSON.stringify(panned));
    assert.equal(panned.k, fitted.k);
    await t("__t.press('Fit to view')");
    assert.deepEqual(await view(), fitted);
    await allInView();

    // Search: what is typed finds tables by part of their name; one of them is shown in the middle, and marked.
    await t("__t.fill('#er-search', 'ORDER')");
    assert.deepEqual(await t("__t.all('#er-results li')"), ["orders", "order_lines"]);
    await t("__t.fill('#er-search', 'nothing like it')");
    assert.deepEqual(await t("__t.all('#er-results li')"), ["No table is called that."]);
    await t("__t.fill('#er-search', 'shipments')");
    await t("__t.press('shipments', '#er-results')");
    const found = await box("shipments");
    // Where the canvas is now: the list of what was found stands above it.
    const now = await canvas();
    assert.ok(Math.abs((found.left + found.right) / 2 - (now.left + now.width / 2)) < 2 && Math.abs((found.top + found.bottom) / 2 - (now.top + now.height / 2)) < 2, JSON.stringify([found, now]));
    assert.ok((await view()).k >= 1);
    assert.deepEqual(await t("[...document.querySelectorAll('#er-boxes .er-table.found')].map((each) => each.getAttribute('data-table'))"), ["shipments"]);
    // Its foreign keys are marked with it: both lines of the key over two columns.
    assert.deepEqual(await t("[...document.querySelectorAll('#er-edges path.related')].map((path) => path.getAttribute('data-fk'))"), ["fk2", "fk2"]);
    // Enter takes the first of what is found.
    await t("__t.fill('#er-search', 'customers'); document.getElementById('er-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); true");
    assert.deepEqual(await t("[...document.querySelectorAll('#er-boxes .er-table.found')].map((each) => each.getAttribute('data-table'))"), ["customers"]);

    // Moving a table: its box goes where it is dragged, and the lines to it follow. Nothing of it is kept.
    await t("__t.press('Fit to view')");
    const customers = await box("customers");
    const lineBefore = await t<string>("document.querySelector('#er-edges path[data-fk=\"fk0\"]').getAttribute('d')");
    await drag(customers.left + 30, customers.top + 8, 90, 140);
    const moved = await box("customers");
    assert.ok(Math.abs(moved.left - customers.left - 90) < 1 && Math.abs(moved.top - customers.top - 140) < 1, JSON.stringify([customers, moved]));
    assert.notEqual(await t("document.querySelector('#er-edges path[data-fk=\"fk0\"]').getAttribute('d')"), lineBefore);
    assert.deepEqual(await view(), fitted, "dragging a table does not pan");
    // A click on a table, without moving it, marks it and its foreign keys.
    const audit = await box("employees");
    await drag(audit.left + 20, audit.top + 8, 0, 0);
    assert.deepEqual(await t("[...document.querySelectorAll('#er-boxes .er-table.chosen')].map((each) => each.getAttribute('data-table'))"), ["employees"]);
    assert.deepEqual(await t("[...new Set([...document.querySelectorAll('#er-edges path.related')].map((path) => path.getAttribute('data-fk')))]"), ["fk3", "fk4", "fk5"]);
    // Auto arrange: every table back where the layout puts it, and all in view.
    await t("__t.press('Auto arrange')");
    assert.equal((await box("customers")).transform, customers.transform);
    assert.equal(await t("document.querySelector('#er-edges path[data-fk=\"fk0\"]').getAttribute('d')"), lineBefore);
    assert.deepEqual(await view(), fitted);
    await allInView();

    assert.deepEqual(await asked(), ["/api/diagram"]);
    assert.deepEqual(await databaseFiles(directory), files);
    assert.deepEqual(page.problems, []);
  });

  it("says that a database without tables has none", async () => {
    await database([]);
    studio = await startStudio({ database: directory, port: 0 });
    await page.open(studio.address);
    await page.until("document.getElementById('tables') && document.getElementById('tables').innerText.includes('no tables')", "the page says there are no tables");
    await t(PAGE_HELPERS);
    await t("__t.press('ER Diagram')");
    await page.until("__t.text('#er-summary') === '0 tables · 0 foreign keys'", "the empty diagram");
    assert.equal(await t("__t.text('#er-note')"), "The database has no tables.");
    assert.equal(await t("document.querySelectorAll('#er-boxes .er-table').length"), 0);
    await t("__t.press('Fit to view'); __t.press('Zoom in'); __t.press('Auto arrange')");
    assert.deepEqual(page.problems, []);
  });

  for (const count of [50, 100]) {
    it(`shows ${count} tables: all of them in the first view, and each one found, zoomed to, and moved`, async () => {
      await database(manyTables(count));
      const started = Date.now();
      await visit(count);
      const took = Date.now() - started;
      assert.match(await t<string>("__t.text('#er-summary')"), new RegExp(`^${count} tables · \\d+ foreign keys$`));
      await allInView();
      const last = tableName(count - 1);
      await t(`__t.fill('#er-search', '${last}')`);
      await t(`__t.press('${last}', '#er-results')`);
      const area = await canvas();
      const found = await box(last);
      assert.ok(Math.abs((found.left + found.right) / 2 - (area.left + area.width / 2)) < 2);
      // Readable where it was found: the title is at least as large as the page's own text.
      assert.ok(await t<number>(`[...document.querySelectorAll('#er-boxes .er-table')].find((box) => box.getAttribute('data-table') === '${last}').querySelector('text.title').getBoundingClientRect().height`) >= 13);
      await drag(found.left + 30, found.top + 8, -60, 40);
      const moved = await box(last);
      assert.ok(Math.abs(moved.left - found.left + 60) < 1 && Math.abs(moved.top - found.top - 40) < 1);
      // Many results are cut short, and say so.
      await t("__t.fill('#er-search', 'table_')");
      assert.equal(await t("document.querySelectorAll('#er-results button').length"), 30);
      assert.equal(await t("__t.all('#er-results li').pop()"), `and ${count - 30} more: type more of the name.`);
      await t("__t.press('Auto arrange')");
      await allInView();
      // A page that keeps up: opening the tab took seconds at most (generous; well under one on this machine).
      assert.ok(took < 30_000, `${took} ms`);
      assert.deepEqual(await asked(), ["/api/diagram"]);
      assert.deepEqual(page.problems, []);
    });
  }

  it("is the same in a read-only Studio, and in one attached to the process that has the database open", async () => {
    await database(ER_SCHEMA, ER_ROWS());
    const files = await databaseFiles(directory);
    await visit(9, { readOnly: true });
    assert.match(await t<string>("__t.text('#notices')"), /Read-only/);
    assert.equal(await t("__t.text('#er-summary')"), "9 tables · 7 foreign keys");
    assert.equal(await t("document.querySelectorAll('#er-edges path.er-edge').length"), 8);
    await studio!.stop();
    studio = undefined;

    owners.push(await ownDatabase(directory));
    await visit(9);
    assert.equal(await t("document.querySelector('#facts').textContent.includes('attached to the PostgREST endpoint (pid ' + " + owners[0]!.pid + " + ')')"), true);
    assert.equal(await t("__t.text('#er-summary')"), "9 tables · 7 foreign keys");
    await allInView();
    assert.deepEqual(await asked(), ["/api/diagram"]);
    assert.deepEqual(await databaseFiles(directory), files);
    assert.deepEqual(page.problems, []);
  });

  it("leaves the other tabs as they were: rows, SQL, API, Export, and Clear data", async () => {
    await database(ER_SCHEMA, ER_ROWS());
    await visit(9);
    await t("__t.press('Rows')");
    assert.equal(await t("document.getElementById('view-er').hidden"), true);
    await page.until("__t.grid() !== null && __t.grid().rows.length === 1", "the rows of the first table");
    assert.deepEqual((await t<{ rows: string[][] }>("__t.grid()")).rows, [["1", "row-value-that-is-never-in-a-diagram@example.test"]]);
    await t("__t.press('SQL')");
    await t("__t.fill('#sql-text', 'SELECT COUNT(*) AS n FROM orders')");
    await t("__t.press('Run', '#view-sql')");
    await page.until("document.querySelectorAll('#sql-results .result').length === 1", "the result");
    assert.equal(await t("document.querySelector('#sql-results td').textContent"), "1");
    await t("__t.press('API')");
    assert.equal(await t("document.getElementById('view-api').hidden"), false);
    await t("__t.press('Export')");
    assert.equal(await t("document.querySelectorAll('#export-tables li').length"), 9);
    await t("__t.press('Clear data')");
    assert.equal(await t("document.querySelectorAll('#clear-tables li').length"), 9);
    // And back: the diagram is as it was left, and is not asked for again.
    await t("__t.press('ER Diagram')");
    assert.equal(await t("document.querySelectorAll('#er-boxes .er-table').length"), 9);
    assert.equal((await asked()).filter((url) => url === "/api/diagram").length, 1);
    assert.deepEqual(page.problems, []);
  });
});
