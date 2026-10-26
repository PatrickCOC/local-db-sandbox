import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { SINGLE_FILE_READ_ONLY } from "../../runtime-access/src/index.ts";
import { DATA, SCHEMA } from "../../runtime-access/test/support/fixture.ts";
import { ownDatabase } from "../../runtime-access/test/support/owner-process.ts";
import type { OwnerProcess } from "../../runtime-access/test/support/owner-process.ts";
import { createDatabase } from "../../storage-json/src/index.ts";
import { storedRows } from "../../storage-json/test/support/database-files.ts";
import { startStudio } from "../src/index.ts";
import type { RunningStudio } from "../src/index.ts";
import { PAGE_HELPERS, openBrowser } from "./support/browser.ts";

/*
 * Studio's page as a browser shows it (D-042): opened with the address the
 * command prints, in a Chromium-based browser of this machine, and used as
 * a person uses it, by what is on it. The other tests of Studio ask its API;
 * these are about what the page makes of the answers.
 *
 * On a machine without such a browser they are skipped, and say so.
 */

const { browser, unavailable } = await openBrowser();

describe("Studio's page in a browser", { timeout: 240_000, skip: browser === undefined ? unavailable : false }, () => {
  let root: string;
  let directory: string;
  let file: string;
  let studio: RunningStudio | undefined;
  const owners: OwnerProcess[] = [];
  const page = browser as NonNullable<typeof browser>;
  const t = <T = unknown>(expression: string): Promise<T> => page.evaluate<T>(expression);
  /** Opens the page of a Studio on that database, and waits until it shows the tables. */
  const visit = async (options: { database: string; readOnly?: boolean; api?: string }): Promise<RunningStudio> => {
    studio = await startStudio({ port: 0, ...options });
    await page.open(studio.address);
    await page.until("document.readyState === 'complete' && document.querySelectorAll('#tables li button').length > 0", "the tables are listed");
    await t(PAGE_HELPERS);
    await page.until("__t.grid() !== null && __t.text('#connection') === 'connected'", "the rows of the first table are shown");
    return studio;
  };
  const facts = (): Promise<string[]> => t("[...document.querySelectorAll('#facts .fact')].map((fact) => fact.querySelector('.label').innerText + ': ' + fact.querySelector('.value').innerText).filter((fact) => !/^(Database|Path)/.test(fact))");

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-page-"));
  });
  after(async () => {
    await browser?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    const home = join(root, `db-${Math.random().toString(16).slice(2)}`);
    directory = join(home, "sandbox.db");
    file = join(home, "sandbox.db.json");
    await createDatabase(directory, { collections: DATA(), schema: SCHEMA });
    await createDatabase(file, { collections: DATA() });
    page.problems.length = 0;
  });
  afterEach(async () => {
    await studio?.stop();
    studio = undefined;
    for (const owner of owners.splice(0)) {
      await owner.kill();
    }
  });

  it("shows how the database is open, its tables, what a table is, and its rows; and keeps the key out of the address", async () => {
    const running = await visit({ database: directory });
    // The key came with the address, and is in it no more.
    assert.equal(await t("location.href"), `${running.url}/`);
    assert.equal(await t("document.title"), "Local DB Studio");
    assert.deepEqual(await facts(), ["Format: database directory", "Mode: standalone: Studio has the database to itself", "Access: read/write", "Tables: 4"]);
    // The page says what that means for a sandbox, and how the database is handed over to one.
    assert.deepEqual(await t("__t.all('#notices li')"), [
      "Studio has this database to itself. While it runs, a sandbox that is started on the database is refused: one process has a database open to write at a time. " +
        "To use the database with an application, stop Studio (Ctrl+C in its terminal), start the sandbox, and start Studio again. It then attaches to the sandbox, and both show the same rows.",
    ]);
    assert.deepEqual(await t("__t.all('#tables li button')"), ["users 25", "orders 2", "memberships 3", "notes 3"]);
    const users = await t<{ heads: string[]; rows: string[][]; actions: string[][] }>("__t.grid()");
    assert.deepEqual(users.heads.slice(0, 7), ["id integer, key, not null", "name varchar(40), not null", "active boolean, not null", "score real", "joined datetime", "settings json", "role text, not null"]);
    assert.deepEqual(users.rows[0], ["1", "user 01", "true", "1.5", "2026-01-01T08:00:00.000Z", '{"theme":"dark","tags":["a","b"]}', "admin"]);
    assert.deepEqual([users.rows.length, users.rows[4]?.[3], users.actions[0]], [25, "NULL", ["Edit", "Delete"]]);
    assert.equal(await t("__t.text('#page-range')"), "Rows 1 to 25 of 25");
    assert.deepEqual(await t("[...document.querySelectorAll('table.definition tbody tr')].slice(0, 3).map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent))"), [
      ["id", "integer", "integer", "NOT NULL", "primary key", "generated: increment"],
      ["name", "varchar(40)", "text", "NOT NULL", "", ""],
      ["active", "boolean", "boolean", "NOT NULL", "", "true"],
    ]);
    // A value of the database is text on the page, whatever it looks like.
    await t("__t.press('SQL')");
    await t(`__t.fill('#sql-text', "SELECT '<img src=x onerror=window.__hit=1><b>bold</b>' AS markup")`);
    await t("__t.press('Run', '#view-sql')");
    await page.until("document.querySelectorAll('#sql-results .result').length === 1", "the result");
    assert.deepEqual(await t("[document.querySelector('#sql-results td').textContent, document.querySelectorAll('#sql-results img, #sql-results b').length, window.__hit === undefined]"), ["<img src=x onerror=window.__hit=1><b>bold</b>", 0, true]);
    assert.deepEqual(page.problems, []);
  });

  it("sorts by the column that is pressed, filters by what is asked, and goes from page to page", async () => {
    await visit({ database: directory });
    await t("__t.press('id', '#view-table .scroll thead')");
    await page.until("__t.grid().heads[0].startsWith('id (ascending)')", "sorted by id");
    await t("__t.press('id', '#view-table .scroll thead')");
    await page.until("__t.grid().rows[0][0] === '25'", "sorted by id, descending");
    await t("__t.press('id', '#view-table .scroll thead')");
    await page.until("__t.grid().rows[0][0] === '1' && __t.grid().heads[0].startsWith('id integer')", "in the table's own order again");

    await t("__t.fill('#view-table .bar select', 'role')");
    await t("__t.fill('#view-table .bar input[type=text]', 'admin')");
    await t("__t.press('Add filter')");
    await page.until("__t.grid().rows.length === 3", "the three admins");
    assert.deepEqual([await t("__t.text('#page-range')"), await t("__t.all('#view-table .chip')")], ["Rows 1 to 3 of 3", ["role = admin x"]]);
    // What is no value of the column is said on the page, and asked of no one.
    await t("__t.fill('#view-table .bar select', 'id')");
    await t("__t.fill('#view-table .bar select', 'gt', 1)");
    await t("__t.fill('#view-table .bar input[type=text]', 'two')");
    await t("__t.press('Add filter')");
    await page.until("document.querySelectorAll('#messages .message.error').length === 1", "the refusal");
    assert.equal(await t("__t.text('#messages .message.error span')"), '"id" is a whole number.');
    await t("__t.fill('#view-table .bar input[type=text]', '1')");
    await t("__t.press('Add filter')");
    await page.until("__t.grid().rows.length === 2", "the admins after the first");
    await t("__t.press('x', '#view-table .chip')");
    await page.until("__t.all('#view-table .chip').length === 1", "one filter less");
    await t("__t.press('x', '#view-table .chip')");
    await page.until("__t.grid().rows.length === 25", "every row again");

    // Pages: 25 to a page, of 25 users and of the 3 that follow when there are 28.
    await t("__t.fill('#view-table select[aria-label=\"Rows on a page\"]', '25')");
    await page.until("__t.text('#page-range') === 'Rows 1 to 25 of 25'", "one page of users");
    assert.equal(await t("[...document.querySelectorAll('#view-table button')].find((each) => each.innerText === 'Next').disabled"), true);
    await studio?.status();
    const { instance } = (await studio?.status())?.info ?? { instance: "" };
    await fetch(`${studio?.url}/api/access/sql`, { method: "POST", headers: { authorization: `Bearer ${studio?.key}`, "content-type": "application/json" }, body: JSON.stringify({ for: instance, request: { sql: "INSERT INTO users (name) VALUES ('user 26'), ('user 27'), ('user 28')", mode: "write" } }) });
    await t("__t.press('Refresh')");
    await page.until("__t.text('#page-range') === 'Rows 1 to 25 of 28'", "the first page of 28");
    await t("__t.press('Next')");
    await page.until("__t.text('#page-range') === 'Rows 26 to 28 of 28'", "the second page");
    assert.deepEqual((await t<{ rows: string[][] }>("__t.grid()")).rows.map((row) => row[1]), ["user 26", "user 27", "user 28"]);
    await t("__t.press('Previous')");
    await page.until("__t.text('#page-range') === 'Rows 1 to 25 of 28'", "the first page again");
    assert.deepEqual(page.problems, []);
  });

  it("adds a row, changes it, and removes it after asking; what the database refuses is said in the form, and nothing is changed for it", async () => {
    await visit({ database: directory });
    // Add: the name is given, the rest is left to the database.
    await t("__t.press('Add a row')");
    await page.until("__t.shown('#dialog')", "the form");
    assert.equal(await t("__t.text('#dialog-title')"), "Add a row to users");
    assert.deepEqual(await t("[...document.querySelectorAll('#dialog .field')].slice(0, 3).map((field) => [field.querySelector('.name').innerText, field.querySelector('.hint').innerText, field.querySelector('input[type=checkbox]').checked])"), [
      ["id", "integer, not NULL, primary key, generated: increment", false],
      ["name", "varchar(40), not NULL", true],
      ["active", "boolean, not NULL, default true", false],
    ]);
    await t("__t.fill('#dialog [aria-label=name]', 'Ada')");
    await t("__t.press('Add the row', '#dialog')");
    await page.until("!__t.shown('#dialog') && __t.text('#page-range') === 'Rows 1 to 26 of 26'", "the row is there, and the page was read again");
    assert.equal(await t("__t.text('#messages .message span')"), "Added a row to users (id = 26).");
    assert.deepEqual((await t<{ rows: string[][] }>("__t.grid()")).rows[25], ["26", "Ada", "true", "NULL", "NULL", "NULL", "reader"]);
    assert.deepEqual((await storedRows(directory, "users")).at(-1), { id: 26, name: "Ada", active: true, score: null, joined: null, settings: null, role: "reader" });
    assert.equal((await t<string[]>("__t.all('#tables li button')"))[0], "users 26");

    // A second Ada is refused by the database: the form says so, and stays.
    await t("__t.press('Add a row')");
    await page.until("__t.shown('#dialog')", "the form again");
    await t("__t.fill('#dialog [aria-label=name]', 'Ada')");
    await t("__t.press('Add the row', '#dialog')");
    await page.until("__t.shown('#dialog-error')", "the refusal, in the form");
    assert.match(await t<string>("__t.text('#dialog-error')"), /^UNIQUE constraint failed: users\.name/);
    await t("__t.press('Cancel', '#dialog')");
    assert.equal((await storedRows(directory, "users")).length, 26);

    // Change: two columns, one of them from NULL to a value.
    await t("__t.rowButton(25, 'Edit')");
    await page.until("__t.shown('#dialog') && __t.text('#dialog-title') === 'Change the row of users with id = 26'", "the form with the row");
    assert.equal(await t("document.querySelector('#dialog [aria-label=name]').value"), "Ada");
    await t("__t.fill('#dialog [aria-label=name]', 'Ada Lovelace')");
    await t("(() => { const field = [...document.querySelectorAll('#dialog .field')].find((each) => each.querySelector('.name').innerText === 'settings'); field.querySelector('input[type=checkbox]').click(); return true; })()");
    await t(`__t.fill('#dialog [aria-label=settings]', '{"theme":"light"}')`);
    await t("__t.press('Save the changes', '#dialog')");
    await page.until("!__t.shown('#dialog') && __t.grid().rows[25][1] === 'Ada Lovelace'", "the row as it was changed");
    assert.deepEqual((await storedRows(directory, "users")).at(-1), { id: 26, name: "Ada Lovelace", active: true, score: null, joined: null, settings: { theme: "light" }, role: "reader" });

    // Remove: asked first. Not removed when the answer is no.
    await t("__t.rowButton(25, 'Delete')");
    await page.until("__t.shown('#dialog')", "the question");
    assert.deepEqual([await t("__t.text('#dialog-title')"), await t("__t.text('#dialog-body')")], ["Delete this row of users?", "The row with id = 26 is removed from the database. That cannot be taken back."]);
    await t("__t.press('Cancel', '#dialog')");
    await page.until("!__t.shown('#dialog')", "the question is gone");
    assert.equal((await storedRows(directory, "users")).length, 26);
    await t("__t.rowButton(25, 'Delete')");
    await page.until("__t.shown('#dialog')", "the question again");
    await t("__t.press('Delete the row', '#dialog')");
    await page.until("__t.text('#page-range') === 'Rows 1 to 25 of 25'", "the row is gone");
    assert.equal((await storedRows(directory, "users")).some((user) => user.id === 26), false);
    // The one thing the browser reports is the request that the database refused.
    assert.deepEqual(page.problems, []);
  });

  it("runs statements that read; refuses one that would change data until changes are allowed, asks before it runs them, and takes back a request that fails halfway", async () => {
    await visit({ database: directory });
    await t("__t.press('SQL')");
    const heads = (): Promise<string[]> => t("[...document.querySelectorAll('#sql-results .result h3')].map((head) => head.innerText.replace(/ \\(.*$/, ''))");
    await t("__t.fill('#sql-text', 'SELECT id, name FROM users WHERE id <= 2 ORDER BY id; SELECT COUNT(*) AS n FROM notes')");
    await t("__t.press('Run', '#view-sql')");
    await page.until("document.querySelectorAll('#sql-results .result').length === 2", "two results");
    assert.deepEqual(await heads(), ["1. SELECT: 2 rows", "2. SELECT: 1 row"]);
    assert.deepEqual((await t<{ heads: string[]; rows: string[][] }>("__t.grid('#sql-results .result')")), { heads: ["id", "name"], rows: [["1", "user 01"], ["2", "user 02"]], actions: [[], []] });

    await t("__t.fill('#sql-text', 'DELETE FROM notes')");
    await t("__t.press('Run', '#view-sql')");
    await page.until("__t.shown('#sql-results .failure')", "the refusal");
    assert.match(await t<string>("__t.text('#sql-results .failure')"), /^Statement 1 failed \(READ_ONLY\)\s+The call is read-only: the statement would change data or schema\./);
    assert.equal((await storedRows(directory, "notes")).length, 3);

    // Allowed: asked first, and not run when the answer is no.
    await t("__t.tick('#sql-write', true)");
    await t(`__t.fill('#sql-text', "INSERT INTO notes (text) VALUES ('a'), ('b'); SELECT COUNT(*) AS n FROM notes")`);
    await t("__t.press('Run', '#view-sql')");
    await page.until("__t.shown('#dialog')", "the question");
    assert.equal(await t("__t.text('#dialog-title')"), "Run statements that may change the database?");
    await t("__t.press('Cancel', '#dialog')");
    await page.until("!__t.shown('#dialog')", "the question is gone");
    assert.equal((await storedRows(directory, "notes")).length, 3);
    await t("__t.press('Run', '#view-sql')");
    await page.until("__t.shown('#dialog')", "the question again");
    await t("__t.press('Run and commit', '#dialog')");
    await page.until("/Committed/.test(__t.text('#sql-results'))", "committed");
    assert.deepEqual(await heads(), ["1. INSERT: 2 rows affected", "2. SELECT: 1 row"]);
    assert.equal((await storedRows(directory, "notes")).length, 5);
    await page.until("__t.all('#tables li button')[3] === 'notes 5'", "the tables were read again");

    await t(`__t.fill('#sql-text', "DELETE FROM notes; INSERT INTO users (name) VALUES ('user 01')")`);
    await t("__t.press('Run', '#view-sql')");
    await page.until("__t.shown('#dialog')", "the question");
    await t("__t.press('Run and commit', '#dialog')");
    await page.until("__t.shown('#sql-results .failure')", "the failure");
    assert.match(await t<string>("__t.text('#sql-results .failure')"), /^Statement 2 failed \(CONSTRAINT\)[\s\S]*Everything this request changed was taken back: the database is as it was\.$/);
    assert.equal((await storedRows(directory, "notes")).length, 5);
    assert.deepEqual(page.problems, []);
  });

  it("sends a request of the API tab to an API on this machine, shows its answer and what went wrong, and leaves Rows as they were", async () => {
    // A small API on this machine, as an application's would be.
    const api = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(request.method === "POST" ? 201 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify({ method: request.method, path: request.url, test: request.headers["x-test"] ?? null, body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null }));
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    try {
      await visit({ database: directory, api: `${base}/items` });
      await t("__t.press('API')");
      await page.until("__t.shown('#api-url')", "the API tab");
      // Where Studio was started to send to, in the field, and among the facts.
      assert.equal(await t("document.getElementById('api-url').value"), `${base}/items`);
      assert.ok((await facts()).includes(`API: ${base}/items`));

      await t("__t.press('Send', '#view-api')");
      await page.until("__t.shown('#api-status')", "the answer");
      assert.match(await t<string>("__t.text('#api-status')"), /^200 OK \(\d+\.\d ms, on this machine\)$/);
      assert.deepEqual(JSON.parse(await t<string>("__t.text('#api-answer')")), { method: "GET", path: "/items", test: null, body: null });

      await t("document.getElementById('api-method').value = 'POST'");
      await t("__t.fill('#api-headers', 'X-Test: from the page')");
      await t(`__t.fill('#api-body', '{"name":"two"}')`);
      await t("__t.press('Send', '#view-api')");
      await page.until("/^201/.test(__t.text('#api-status') || '')", "the answer to POST");
      assert.match(await t<string>("__t.text('#api-status')"), /^201 Created /);
      // JSON is shown laid out.
      assert.equal(await t("__t.text('#api-answer')"), JSON.stringify({ method: "POST", path: "/items", test: "from the page", body: { name: "two" } }, null, 2));

      await t(`__t.fill('#api-body', '{ name: two }')`);
      await t("__t.press('Send', '#view-api')");
      await page.until("__t.shown('#api-failure')", "the refusal");
      assert.match(await t<string>("__t.text('#api-failure')"), /^INVALID_REQUEST\s+The body is not JSON \(.+\)\. Nothing was sent\.$/);
      await t("__t.fill('#api-url', 'http://example.com/')");
      await t("__t.fill('#api-body', '')");
      await t("__t.press('Send', '#view-api')");
      await page.until("/DESTINATION_REFUSED/.test(__t.text('#api-failure') || '')", "the refused destination");

      // Back to Rows: as they were.
      await t("__t.press('Rows')");
      await page.until("__t.shown('#view-table') && !__t.shown('#view-api')", "Rows again");
      assert.equal((await t<{ rows: string[][] }>("__t.grid()")).rows.length, 25);
      // Nothing of a request is kept in the page's store.
      assert.equal(await t("Object.keys(window.sessionStorage).join(',')"), "local-db-studio-key");
      assert.deepEqual(page.problems, []);
    } finally {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  });

  it("shows a single file to be read only: no way to change a row is offered, and the console may not change anything", async () => {
    const bytes = await readFile(file);
    await visit({ database: file });
    assert.deepEqual(await facts(), ["Format: single file", "Mode: standalone: reads what is stored", "Access: read-only", "Tables: 4"]);
    assert.deepEqual(await t("__t.all('#notices li')"), [`Read-only: ${SINGLE_FILE_READ_ONLY}`]);
    const users = await t<{ rows: string[][]; actions: string[][] }>("__t.grid()");
    assert.deepEqual([users.rows.length, users.actions.flat(), await t("[...document.querySelectorAll('#view-table button')].some((each) => each.innerText === 'Add a row')")], [25, [], false]);
    await t("__t.press('SQL')");
    assert.deepEqual(await t("[document.querySelector('#sql-write').disabled, document.querySelector('#sql-write').checked]"), [true, false]);
    await t("__t.fill('#sql-text', 'SELECT COUNT(*) AS n FROM users; DELETE FROM users')");
    await t("__t.press('Run', '#view-sql')");
    await page.until("__t.shown('#sql-results .failure')", "the refusal");
    assert.match(await t<string>("__t.text('#sql-results .failure')"), /^Statement 2 failed \(READ_ONLY\)/);
    await studio?.stop();
    assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(page.problems, []);
  });

  it("says that the sandbox is away while its process is gone, reads everything again when another has the database, and does nothing with a form that was filled in for the first", async () => {
    const first = await ownDatabase(directory, "nest");
    owners.push(first);
    await visit({ database: directory });
    assert.deepEqual(await facts(), ["Format: database directory", `Mode: attached to the NestJS sandbox (pid ${first.pid})`, "Access: read/write", "Tables: 4"]);
    // A row of the first process's is opened to be changed.
    await t("__t.rowButton(1, 'Edit')");
    await page.until("__t.shown('#dialog')", "the form");
    await t("__t.fill('#dialog [aria-label=name]', 'changed for the first')");

    // The process is killed, as a watcher ends the sandbox it replaces.
    await first.kill();
    await page.until("__t.text('#connection') === 'not connected' && __t.shown('#banner')", "the page says that the sandbox is away");
    assert.match(await t<string>("__t.text('#banner')"), /^Not connected\. The process that had the database open is gone .* Studio waits for a process to have the database open again, and reads everything again then\. Nothing is changed meanwhile\.$/);
    assert.equal(await t("document.body.classList.contains('disconnected')"), true);

    // Another process has the database, with one row more. The page finds it, says so, and shows what it has.
    const second = await ownDatabase(directory, "nest");
    owners.push(second);
    await second.sql("INSERT INTO notes (text) VALUES ('by the second process')");
    await page.until("__t.text('#connection') === 'connected' && !__t.shown('#banner')", "the page is connected again");
    await page.until("__t.all('#tables li button')[3] === 'notes 4'", "the tables were read again");
    assert.deepEqual(await facts(), ["Format: database directory", `Mode: attached to the NestJS sandbox (pid ${second.pid})`, "Access: read/write", "Tables: 4"]);
    assert.match((await t<string[]>("__t.all('#messages .message span')")).join("\n"), /Another process has the database open than before: the sandbox was restarted\. Everything shown was read again\./);

    // The form was filled in for the first process: the second carries nothing of it out.
    await t("__t.press('Save the changes', '#dialog')");
    await page.until("__t.shown('#dialog-error')", "the refusal, in the form");
    assert.match(await t<string>("__t.text('#dialog-error')"), /^The database is open in another process than the one this was asked of\. Nothing was done\./);
    assert.deepEqual(await second.sql("SELECT name FROM users WHERE id = 2"), [{ name: "user 02" }]);
    // Opened again, on what the page shows now, the same change is carried out by the second.
    await t("__t.press('Cancel', '#dialog')");
    await t("__t.rowButton(1, 'Edit')");
    await page.until("__t.shown('#dialog')", "the form, for the second");
    await t("__t.fill('#dialog [aria-label=name]', 'changed for the second')");
    await t("__t.press('Save the changes', '#dialog')");
    await page.until("!__t.shown('#dialog')", "saved");
    assert.deepEqual(await second.sql("SELECT name FROM users WHERE id = 2"), [{ name: "changed for the second" }]);
    assert.deepEqual(page.problems, []);
  });
});
