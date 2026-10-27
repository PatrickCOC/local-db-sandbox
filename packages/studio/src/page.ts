/*
 * Studio's page (D-042): one document, with its style and its script in it.
 * It is the same for every database and holds nothing of any: what it shows
 * it asks of the server that served it (`server.ts`), with the key of the
 * session, which it takes from behind the `#` of the address it was opened
 * with and keeps for as long as its tab lives.
 *
 * No framework and no build step: the script is what a browser reads. It is
 * written without template literals, so that it can stand in one here.
 *
 * What the script holds to:
 *
 * - Every value of the database is put on the page as text, never as markup.
 * - A change is asked for once, and names the owner whose rows the page
 *   showed when it was asked for. Nothing is asked a second time by the
 *   page itself; what the person sees decides.
 * - Removing a row, and running statements that may change the database,
 *   are asked about first, in the page.
 * - It asks how things are every second and a half. When the process that
 *   has the database open is away, it says so; when another one is there,
 *   it reads everything again.
 */

const STYLE = String.raw`
:root { color-scheme: light dark; --ink: #1c2330; --soft: #5d6878; --line: #d5dae2; --paper: #ffffff; --shade: #f3f5f8; --mark: #1f5fbf; --bad: #b3261e; --good: #1d6b3a; --warn: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6e9ee; --soft: #9aa5b5; --line: #353c48; --paper: #171b22; --shade: #1f252e; --mark: #7fb0ff; --bad: #ff8a80; --good: #7bd89a; --warn: #f0c060; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; font: 14px/1.45 system-ui, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper); }
h1 { font-size: 17px; margin: 0; }
h2 { font-size: 15px; margin: 0 0 8px; }
button, select, input, textarea { font: inherit; color: inherit; }
button { border: 1px solid var(--line); background: var(--shade); border-radius: 4px; padding: 3px 10px; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--mark); }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--mark); border-color: var(--mark); color: var(--paper); }
button.danger { background: var(--bad); border-color: var(--bad); color: var(--paper); }
button.quiet { background: transparent; }
input[type="text"], select, textarea { border: 1px solid var(--line); background: var(--paper); border-radius: 4px; padding: 3px 6px; }
textarea { width: 100%; font-family: ui-monospace, Consolas, monospace; resize: vertical; }
header { padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--shade); }
.title { display: flex; align-items: center; gap: 12px; }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--line); color: var(--soft); }
.badge.good { color: var(--good); border-color: var(--good); }
.badge.bad { color: var(--bad); border-color: var(--bad); }
#refresh { margin-left: auto; }
#facts { display: flex; flex-wrap: wrap; gap: 4px 24px; margin-top: 8px; }
.fact .label { color: var(--soft); margin-right: 6px; }
.fact .value { font-weight: 600; }
#notices { margin: 6px 0 0; padding: 0; list-style: none; color: var(--warn); }
#banner { padding: 8px 16px; background: var(--bad); color: var(--paper); }
#messages { padding: 0 16px; }
.message { display: flex; gap: 12px; align-items: flex-start; margin-top: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--shade); }
.message span { flex: 1; white-space: pre-wrap; }
.message.error { border-color: var(--bad); color: var(--bad); }
main { display: flex; align-items: flex-start; gap: 16px; padding: 12px 16px; }
nav { flex: 0 0 210px; }
nav ul { list-style: none; margin: 0; padding: 0; }
nav li { margin-bottom: 2px; }
button.table { width: 100%; display: flex; justify-content: space-between; gap: 8px; text-align: left; background: transparent; border-color: transparent; }
button.table.current { background: var(--shade); border-color: var(--line); font-weight: 600; }
.count { color: var(--soft); font-weight: 400; }
section { flex: 1; min-width: 0; }
.tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid var(--line); }
.tab { border-bottom: 0; border-radius: 4px 4px 0 0; background: transparent; }
.tab.current { background: var(--shade); font-weight: 600; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0; }
.bar .space { flex: 1; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 1px 4px 1px 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--shade); }
.chip button { border: 0; background: transparent; padding: 0 4px; }
.scroll { overflow: auto; max-height: 62vh; border: 1px solid var(--line); border-radius: 4px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { position: sticky; top: 0; background: var(--shade); white-space: nowrap; }
th .kind { display: block; font-weight: 400; font-size: 11px; color: var(--soft); }
th button { border: 0; background: transparent; padding: 0; font-weight: 600; }
td { font-family: ui-monospace, Consolas, monospace; font-size: 13px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td.null { color: var(--soft); font-style: italic; }
td.cut { color: var(--warn); }
td.actions { white-space: nowrap; font-family: inherit; }
td.actions button { margin-right: 4px; padding: 0 6px; }
details.columns { margin-bottom: 8px; }
details.columns summary { cursor: pointer; color: var(--soft); }
table.definition { width: auto; margin-top: 6px; }
table.definition th { position: static; }
.empty { color: var(--soft); }
.result { margin-top: 12px; }
.result h3 { font-size: 13px; margin: 0 0 4px; }
.result pre { margin: 0 0 4px; white-space: pre-wrap; color: var(--soft); font-size: 12px; }
.failure { border: 1px solid var(--bad); color: var(--bad); border-radius: 4px; padding: 6px 10px; margin-top: 12px; white-space: pre-wrap; }
.check { display: inline-flex; align-items: center; gap: 4px; }
.choices { list-style: none; padding: 0; margin: 4px 0; columns: 2; }
.stacked-mode { display: flex; margin: 4px 0; }
#dialog { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px; overflow: auto; }
.panel { background: var(--paper); border: 1px solid var(--line); border-radius: 6px; padding: 16px; width: min(640px, 100%); }
.field { display: grid; grid-template-columns: 170px 1fr; gap: 4px 12px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.field .name { font-weight: 600; word-break: break-all; }
.field .hint { color: var(--soft); font-size: 12px; }
.field .choices { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; margin-top: 2px; }
.field input[type="text"] { width: 100%; }
#dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
#locked { padding: 40px 16px; max-width: 640px; margin: 0 auto; }
body.locked #app { display: none; }
body.disconnected main { opacity: 0.55; }
#api-url { flex: 1; min-width: 240px; }
.stacked { display: block; margin-top: 8px; color: var(--soft); }
.stacked textarea { margin-top: 2px; color: var(--ink); }
.result pre.body { color: var(--ink); font-size: 13px; max-height: 60vh; overflow: auto; border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; }
#er-search { min-width: 220px; }
#er-results { list-style: none; margin: 4px 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
#er-results button { border-color: var(--line); }
#er-canvas { display: block; width: 100%; height: 68vh; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); touch-action: none; cursor: grab; user-select: none; }
#er-canvas.panning { cursor: grabbing; }
.er-table { cursor: move; }
.er-table rect.box { fill: var(--paper); stroke: var(--line); stroke-width: 1.2; }
.er-table rect.head { fill: var(--shade); }
.er-table line.rule { stroke: var(--line); }
.er-table text { font: 12px ui-monospace, Consolas, monospace; fill: var(--ink); white-space: pre; }
.er-table text.title { font-size: 13px; font-weight: 700; }
.er-table text.soft { fill: var(--soft); }
.er-table text.key { fill: var(--mark); font-size: 10px; font-weight: 700; }
.er-table.chosen rect.box { stroke: var(--mark); stroke-width: 2.5; }
.er-table.found rect.box { stroke: var(--warn); stroke-width: 3.5; }
.er-edge { fill: none; stroke: var(--soft); stroke-width: 1.3; opacity: 0.7; }
.er-edge.related { stroke: var(--mark); stroke-width: 2.4; opacity: 1; }
.er-arrow { fill: var(--soft); }
`;

const MARKUP = String.raw`
<div id="locked" hidden><h1>Local DB Studio</h1><p id="locked-why"></p></div>
<div id="app">
<header>
<div class="title"><h1>Local DB Studio</h1><span id="connection" class="badge">connecting</span><button type="button" id="refresh">Refresh</button></div>
<div id="facts"></div>
<ul id="notices"></ul>
</header>
<div id="banner" role="alert" hidden></div>
<div id="messages"></div>
<main>
<nav><h2>Tables</h2><ul id="tables"></ul></nav>
<section>
<div class="tabs"><button type="button" id="tab-table" class="tab current">Rows</button><button type="button" id="tab-sql" class="tab">SQL</button><button type="button" id="tab-api" class="tab">API</button><button type="button" id="tab-export" class="tab">Export</button><button type="button" id="tab-clear" class="tab">Clear data</button><button type="button" id="tab-er" class="tab">ER Diagram</button></div>
<div id="view-table"></div>
<div id="view-sql" hidden></div>
<div id="view-api" hidden></div>
<div id="view-export" hidden></div>
<div id="view-clear" hidden></div>
<div id="view-er" hidden></div>
</section>
</main>
</div>
<div id="dialog" hidden><div class="panel" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><h2 id="dialog-title"></h2><div id="dialog-body"></div><p id="dialog-error" class="failure" hidden></p><div id="dialog-actions"></div></div></div>
`;

const SCRIPT = String.raw`
(() => {
  "use strict";

  const STORE = "local-db-studio-key";
  const KINDS = { nest: "the NestJS sandbox", postgrest: "the PostgREST endpoint", rest: "the REST sandbox", sql: "the SQL console", studio: "another Local DB Studio" };
  const OPERATORS = [["eq", "="], ["neq", "!="], ["gt", ">"], ["gte", ">="], ["lt", "<"], ["lte", "<="], ["contains", "contains"], ["null", "is NULL"], ["notnull", "is not NULL"]];
  const POLL_MS = 1500;

  const state = {
    key: null,
    /** How things are, as the server last said. */
    status: null,
    /** Why the server itself does not answer, while it does not. */
    gone: null,
    /** The owner whose data the page shows: every change names it. */
    owner: null,
    schema: null,
    table: null,
    limit: 50,
    offset: 0,
    sort: null,
    filters: [],
    page: null,
    /** The owner the rows of the page were read from. */
    pageOwner: null,
    polling: false,
    dismiss: null,
    /** Whether the API Studio was started with was put in the API tab's field. */
    apiGiven: false,
    /** The tables chosen in the Export tab, by name. */
    exportTables: new Set(),
    /** The address of the last export's file, while it is offered again. */
    exportUrl: null,
    /** The tables chosen in the Clear data tab, by name. */
    clearTables: new Set(),
    /** The ER Diagram tab: the diagram as the server laid it out, where each table stands now, and how it is looked at. */
    er: { diagram: null, signature: null, stale: true, loading: false, fitLater: false, at: new Map(), view: { x: 0, y: 0, k: 1 }, boxes: new Map(), lines: [], linesOf: new Map(), found: null, chosen: null },
  };

  // --- the page's own tools ---------------------------------------------------------------------------

  const byId = (id) => document.getElementById(id);

  /** An element. A value of the database only ever gets here as text. */
  const node = (tag, properties, children) => {
    const made = document.createElement(tag);
    for (const [name, value] of Object.entries(properties || {})) {
      if (name === "text") {
        made.textContent = value;
      } else if (name === "class") {
        made.className = value;
      } else if (typeof value === "boolean" || name === "value") {
        made[name] = value;
      } else {
        made.setAttribute(name, value);
      }
    }
    for (const child of children || []) {
      if (child !== null && child !== undefined && child !== false) {
        made.append(child);
      }
    }
    return made;
  };
  const clear = (target) => target.replaceChildren();
  const press = (label, handler, properties) => {
    const made = node("button", Object.assign({ type: "button", text: label }, properties || {}));
    made.addEventListener("click", handler);
    return made;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const say = (kind, text) => {
    const line = node("div", { class: "message " + kind, role: kind === "error" ? "alert" : "status" }, [node("span", { text: text })]);
    line.append(press("Dismiss", () => line.remove(), { class: "quiet" }));
    byId("messages").prepend(line);
    if (kind !== "error") {
      setTimeout(() => line.remove(), 8000);
    }
  };

  // --- asking the server ------------------------------------------------------------------------------

  const call = async (method, path, body) => {
    let response;
    try {
      response = await fetch(path, {
        method: method,
        cache: "no-store",
        headers: Object.assign({ authorization: "Bearer " + state.key }, body === undefined ? {} : { "content-type": "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (unreachable) {
      const failure = new Error("Local DB Studio does not answer: the command that started it has ended. Start it again, and open the address it prints.");
      failure.code = "STUDIO_GONE";
      throw failure;
    }
    let answer = null;
    try {
      answer = JSON.parse(await response.text());
    } catch (unreadable) {
      answer = null;
    }
    if (response.ok && answer !== null) {
      return answer;
    }
    const failure = new Error(answer && answer.error && answer.error.message ? answer.error.message : "Local DB Studio answered " + response.status + ".");
    failure.code = answer && answer.error && answer.error.code ? answer.error.code : "INTERNAL";
    failure.status = response.status;
    if (answer && answer.error && Array.isArray(answer.error.refusals)) {
      failure.refusals = answer.error.refusals;
    }
    throw failure;
  };

  /** Asks for something that changes nothing. While the application has a transaction open, it is asked again a few times. */
  const read = async (operation, request) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return (await call("POST", "/api/access/" + operation, { request: request })).result;
      } catch (failure) {
        if (failure.code !== "BUSY" || attempt >= 3) {
          throw failure;
        }
        await wait(250);
      }
    }
  };

  /** Asks for a change: once, and for the owner whose rows were on the page when it was asked for. */
  const change = async (operation, request, madeFor) => (await call("POST", "/api/access/" + operation, { for: madeFor, request: request })).result;

  /** Says what went wrong. What says that the owner is not the one it was is a reason to look how things are. */
  const fail = (failure) => {
    say("error", failure && failure.message ? failure.message : String(failure));
    if (failure && (failure.code === "OWNER_CHANGED" || failure.code === "OWNER_UNREACHABLE" || failure.code === "OUTCOME_UNKNOWN" || failure.code === "STUDIO_GONE")) {
      poll();
    }
  };

  // --- how things are ---------------------------------------------------------------------------------

  const connected = () => Boolean(state.gone === null && state.status && state.status.connected);
  const writable = () => connected() && !state.status.info.readOnly;

  const locked = (why) => {
    document.body.classList.add("locked");
    byId("locked").hidden = false;
    byId("locked-why").textContent = why;
  };

  const poll = async () => {
    if (state.polling) {
      return;
    }
    state.polling = true;
    try {
      const status = await call("GET", "/api/status");
      const was = state.status;
      const wasGone = state.gone !== null;
      state.gone = null;
      state.status = status;
      // The API that Studio was started with (--api) is where the API tab starts from, once; the field stays the person's.
      if (status.api && !state.apiGiven) {
        state.apiGiven = true;
        if (byId("api-url").value === "") {
          byId("api-url").value = status.api;
        }
      }
      renderOverview();
      if (status.connected) {
        const instance = status.info.instance;
        if (state.owner !== instance) {
          const first = state.owner === null;
          state.owner = instance;
          if (!first) {
            say("info", "Another process has the database open than before: the sandbox was restarted. Everything shown was read again.");
          }
          await refresh();
        } else if (wasGone || (was && !was.connected)) {
          await refresh();
        }
      }
    } catch (failure) {
      if (failure.status === 401) {
        locked("The key of this page is not the key of the Studio session that runs now. Open the address that the command printed when it was started.");
      } else {
        state.gone = failure.message;
        renderOverview();
      }
    } finally {
      state.polling = false;
    }
  };

  const renderOverview = () => {
    const status = state.status;
    const badge = byId("connection");
    const banner = byId("banner");
    const facts = byId("facts");
    const notices = byId("notices");
    clear(facts);
    clear(notices);
    const fact = (label, value, title) => {
      facts.append(node("div", { class: "fact" }, [node("span", { class: "label", text: label }), node("span", Object.assign({ class: "value", text: value }, title ? { title: title } : {}))]));
    };

    if (status !== null) {
      const info = status.info;
      fact("Database", status.database.split(/[\\/]/).pop(), status.database);
      fact("Path", status.database);
      fact("Format", status.format === "directory" ? "database directory" : "single file");
      if (status.mode === "attached") {
        fact("Mode", info ? "attached to " + (KINDS[info.kind] || info.kind) + " (pid " + info.pid + ")" : "attached to the process that has the database open");
      } else {
        fact("Mode", info && info.readOnly ? "standalone: reads what is stored" : "standalone: Studio has the database to itself");
      }
      if (status.api) {
        fact("API", status.api);
      }
      if (info) {
        fact("Access", info.readOnly ? "read-only" : info.persistence === "memory" ? "read/write, kept in memory and not saved" : "read/write");
        fact("Tables", String(info.tables));
        if (info.readOnly) {
          notices.append(node("li", { text: "Read-only: " + info.readOnly }));
        }
      }
      for (const notice of status.notices || []) {
        notices.append(node("li", { text: notice }));
      }
    }

    if (state.gone !== null) {
      badge.textContent = "Studio stopped";
      badge.className = "badge bad";
      banner.textContent = state.gone;
      banner.hidden = false;
    } else if (status === null) {
      badge.textContent = "connecting";
      badge.className = "badge";
      banner.hidden = true;
    } else if (!status.connected) {
      badge.textContent = "not connected";
      badge.className = "badge bad";
      banner.textContent = "Not connected. " + (status.disconnected || "") + " Studio waits for a process to have the database open again, and reads everything again then. Nothing is changed meanwhile.";
      banner.hidden = false;
    } else {
      badge.textContent = "connected";
      badge.className = "badge good";
      banner.hidden = true;
    }
    document.body.classList.toggle("disconnected", !connected());

    const allow = byId("sql-write");
    if (allow) {
      allow.disabled = !writable();
      if (allow.disabled) {
        allow.checked = false;
      }
    }
    if (byId("clear-run")) {
      updateClear();
    }
  };

  /** Reads everything that is shown again: the tables, and the page of the table that is open. */
  const refresh = async () => {
    try {
      state.schema = await read("schema");
    } catch (failure) {
      fail(failure);
      return;
    }
    if (state.table === null || !state.schema.tables.some((table) => table.name === state.table)) {
      state.table = state.schema.tables.length > 0 ? state.schema.tables[0].name : null;
      state.offset = 0;
      state.sort = null;
      state.filters = [];
    }
    renderTables();
    renderExportTables();
    renderClearTables();
    schemaRead();
    await loadTable();
  };

  // --- the tables, and the rows of one ----------------------------------------------------------------

  const tableNow = () => (state.schema ? state.schema.tables.find((table) => table.name === state.table) : undefined);
  const typeOf = (column) => column.declaredType || column.canonicalType || column.type;
  const shown = (value) => (value === null || value === undefined ? null : typeof value === "object" ? JSON.stringify(value) : String(value));
  const defaultOf = (column) => (column.generated ? "generated: " + column.generated : column.default !== undefined ? JSON.stringify(column.default) : column.defaultExpression ? column.defaultExpression : "");

  const renderTables = () => {
    const list = byId("tables");
    clear(list);
    if (state.schema.tables.length === 0) {
      list.append(node("li", { class: "empty", text: "The database has no tables." }));
    }
    for (const table of state.schema.tables) {
      const item = press(
        table.name,
        () => {
          state.table = table.name;
          state.offset = 0;
          state.sort = null;
          state.filters = [];
          renderTables();
          loadTable();
        },
        { class: table.name === state.table ? "table current" : "table", title: table.rows + (table.rows === 1 ? " row" : " rows") },
      );
      item.append(node("span", { class: "count", text: String(table.rows) }));
      list.append(node("li", {}, [item]));
    }
  };

  const loadTable = async () => {
    const table = tableNow();
    if (!table) {
      state.page = null;
      renderTable();
      return;
    }
    const request = { table: table.name, limit: state.limit, offset: state.offset };
    if (state.sort) {
      request.orderBy = [state.sort];
    }
    if (state.filters.length > 0) {
      request.filters = state.filters.map((filter) => (filter.op === "null" || filter.op === "notnull" ? { column: filter.column, op: filter.op } : { column: filter.column, op: filter.op, value: filter.value }));
    }
    const readFrom = state.owner;
    try {
      state.page = await read("browse", request);
      state.pageOwner = readFrom;
    } catch (failure) {
      state.page = null;
      fail(failure);
    }
    renderTable();
  };

  /** What was typed, as a value of that column. Throws with what is wrong with it. */
  const typed = (column, text) => {
    const type = column.type;
    if (type === "boolean") {
      if (text === "true" || text === "false") {
        return text === "true";
      }
      throw new Error('"' + column.name + '" is true or false.');
    }
    if (type === "integer") {
      if (!/^\s*-?\d+\s*$/.test(text)) {
        throw new Error('"' + column.name + '" is a whole number.');
      }
      // One that a number of JavaScript cannot hold goes as its digits.
      return Number.isSafeInteger(Number(text)) ? Number(text) : text.trim();
    }
    if (type === "real" || type === "numeric") {
      if (text.trim() === "" || !Number.isFinite(Number(text))) {
        throw new Error('"' + column.name + '" is a number.');
      }
      return Number(text);
    }
    if (type === "json") {
      try {
        return JSON.parse(text);
      } catch (invalid) {
        throw new Error('"' + column.name + '" is JSON, and this is not: ' + invalid.message);
      }
    }
    return text;
  };

  /** The key of a row of the page, or null when a value of it was too long to be given whole. */
  const keyOf = (table, page, index) => {
    const key = {};
    for (const name of table.primaryKey) {
      const at = page.columns.indexOf(name);
      if (at < 0 || page.cut.some((where) => where[0] === index && where[1] === at)) {
        return null;
      }
      key[name] = page.rows[index][at];
    }
    return key;
  };
  const keyText = (key) => Object.keys(key).map((name) => name + " = " + shown(key[name])).join(", ");

  const cell = (value, cut) => {
    const text = shown(value);
    if (text === null) {
      return node("td", { class: "null", text: "NULL" });
    }
    return cut ? node("td", { class: "cut", text: text + "...", title: "Longer than a page shows: this is the beginning." }) : node("td", { text: text, title: text.length > 60 ? text : "" });
  };

  /** A grid of rows. heads: what stands over each column; actions: what can be done with a row, if anything. */
  const grid = (heads, rows, cut, actions) => {
    const head = node("tr", {}, heads);
    if (actions) {
      head.append(node("th", { text: "" }));
    }
    const body = node("tbody");
    rows.forEach((row, index) => {
      const line = node("tr", {}, row.map((value, at) => cell(value, cut.some((where) => where[0] === index && where[1] === at))));
      if (actions) {
        line.append(node("td", { class: "actions" }, actions(index)));
      }
      body.append(line);
    });
    return node("div", { class: "scroll" }, [node("table", {}, [node("thead", {}, [head]), body])]);
  };

  const renderTable = () => {
    const view = byId("view-table");
    clear(view);
    const table = tableNow();
    if (!table) {
      view.append(node("p", { class: "empty", text: state.schema ? "The database has no tables." : "" }));
      return;
    }
    const canChange = writable();
    const hasKey = table.primaryKey.length > 0;
    view.append(node("h2", { text: table.name }));

    // What the table is.
    const definition = node("tbody");
    for (const column of table.columns) {
      definition.append(
        node("tr", {}, [
          node("td", { text: column.name }),
          node("td", { text: typeOf(column) + (column.enum ? " (" + column.enum.join(", ") + ")" : "") }),
          node("td", { text: column.type }),
          node("td", { text: column.nullable ? "NULL" : "NOT NULL" }),
          node("td", { text: column.primaryKey ? "primary key" : column.references ? "refers to " + column.references.table + "." + column.references.column : "" }),
          node("td", { text: defaultOf(column) }),
        ]),
      );
    }
    view.append(
      node("details", { class: "columns" }, [
        node("summary", { text: "Columns (" + table.columns.length + ")" + (hasKey ? "" : ": no primary key, so its rows are changed with SQL") }),
        node("table", { class: "definition" }, [node("thead", {}, [node("tr", {}, ["Column", "Type", "Stored as", "NULL", "Key", "Default"].map((title) => node("th", { text: title })))]), definition]),
      ]),
    );

    // Which rows.
    const columnChoice = node("select", { "aria-label": "Column to filter by" }, table.columns.map((column) => node("option", { value: column.name, text: column.name })));
    const operatorChoice = node("select", { "aria-label": "Comparison" }, OPERATORS.map((operator) => node("option", { value: operator[0], text: operator[1] })));
    const valueBox = node("input", { type: "text", placeholder: "value", "aria-label": "Value to compare with" });
    const addFilter = () => {
      const column = table.columns.find((each) => each.name === columnChoice.value);
      const filter = { column: column.name, op: operatorChoice.value };
      if (filter.op !== "null" && filter.op !== "notnull") {
        try {
          filter.value = filter.op === "contains" ? valueBox.value : typed(column, valueBox.value);
        } catch (invalid) {
          say("error", invalid.message);
          return;
        }
      }
      state.filters.push(filter);
      state.offset = 0;
      loadTable();
    };
    valueBox.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        addFilter();
      }
    });
    const bar = node("div", { class: "bar" }, [node("span", { class: "empty", text: "Filter" }), columnChoice, operatorChoice, valueBox, press("Add filter", addFilter)]);
    state.filters.forEach((filter, index) => {
      const label = OPERATORS.find((operator) => operator[0] === filter.op)[1];
      const chip = node("span", { class: "chip", text: filter.column + " " + label + (filter.value === undefined ? "" : " " + shown(filter.value)) });
      chip.append(
        press(
          "x",
          () => {
            state.filters.splice(index, 1);
            state.offset = 0;
            loadTable();
          },
          { "aria-label": "Remove this filter" },
        ),
      );
      bar.append(chip);
    });
    bar.append(node("span", { class: "space" }));
    if (canChange) {
      bar.append(press("Add a row", () => openForm(table, null), { class: "primary" }));
    }
    view.append(bar);

    const page = state.page;
    if (!page) {
      view.append(node("p", { class: "empty", text: "The rows could not be read." }));
      return;
    }

    // The rows, sorted by the column whose name is pressed.
    const heads = table.columns.map((column) => {
      const sorted = state.sort && state.sort.column === column.name ? state.sort.direction : null;
      const title = press(column.name + (sorted === "asc" ? " (ascending)" : sorted === "desc" ? " (descending)" : ""), () => {
        state.sort = sorted === null ? { column: column.name, direction: "asc" } : sorted === "asc" ? { column: column.name, direction: "desc" } : null;
        state.offset = 0;
        loadTable();
      }, { title: "Sort by this column" });
      return node("th", {}, [title, node("span", { class: "kind", text: typeOf(column) + (column.primaryKey ? ", key" : "") + (column.nullable ? "" : ", not null") })]);
    });
    const actions =
      canChange && hasKey
        ? (index) => {
            const key = keyOf(table, page, index);
            return key === null
              ? [node("span", { class: "empty", text: "key too long" })]
              : [press("Edit", () => openForm(table, key)), press("Delete", () => removeRow(table, key), { class: "quiet" })];
          }
        : null;
    view.append(grid(heads, page.rows, page.cut, actions));

    // Which page of them.
    const first = page.rows.length === 0 ? 0 : page.offset + 1;
    const last = page.offset + page.rows.length;
    const size = node("select", { "aria-label": "Rows on a page" }, [25, 50, 100, 500].map((count) => node("option", { value: String(count), text: count + " rows", selected: count === state.limit })));
    size.addEventListener("change", () => {
      state.limit = Number(size.value);
      state.offset = 0;
      loadTable();
    });
    view.append(
      node("div", { class: "bar" }, [
        node("span", { id: "page-range", text: page.total === 0 ? "No rows" + (state.filters.length > 0 ? " match" : "") : "Rows " + first + " to " + last + " of " + page.total }),
        node("span", { class: "space" }),
        size,
        press("Previous", () => {
          state.offset = Math.max(0, state.offset - state.limit);
          loadTable();
        }, { disabled: page.offset === 0 }),
        press("Next", () => {
          state.offset = page.offset + page.limit;
          loadTable();
        }, { disabled: last >= page.total }),
      ]),
    );
  };

  // --- the dialog: a row to fill in, or a question ----------------------------------------------------

  const closeDialog = () => {
    byId("dialog").hidden = true;
    clear(byId("dialog-body"));
    clear(byId("dialog-actions"));
    byId("dialog-error").hidden = true;
    state.dismiss = null;
  };
  const openDialog = (title, content, actions, dismiss) => {
    byId("dialog-title").textContent = title;
    const body = byId("dialog-body");
    clear(body);
    for (const part of content) {
      body.append(part);
    }
    const buttons = byId("dialog-actions");
    clear(buttons);
    for (const each of actions) {
      buttons.append(each);
    }
    byId("dialog-error").hidden = true;
    byId("dialog").hidden = false;
    state.dismiss = dismiss;
    const focus = body.querySelector("input:not([type=checkbox]):not(:disabled), textarea:not(:disabled), select:not(:disabled)") || buttons.querySelector("button");
    if (focus) {
      focus.focus();
    }
  };
  const dialogError = (failure) => {
    const line = byId("dialog-error");
    line.textContent = failure && failure.message ? failure.message : String(failure);
    line.hidden = false;
  };

  /** Asks, in the page, whether something that cannot be taken back is to be done. */
  const confirmThat = (title, lines, label) =>
    new Promise((resolve) => {
      const answer = (agreed) => () => {
        closeDialog();
        resolve(agreed);
      };
      openDialog(title, lines.map((line) => node("p", { text: line })), [press("Cancel", answer(false), { class: "quiet" }), press(label, answer(true), { class: "danger" })], answer(false));
    });

  /** One column of a row that is filled in. */
  const fieldFor = (column, adding, value, tooLong) => {
    const isNull = value === null || value === undefined;
    const text = isNull ? "" : column.type === "json" ? JSON.stringify(value, null, 2) : typeof value === "object" ? JSON.stringify(value) : String(value);
    let control;
    if (column.type === "boolean") {
      control = node("select", {}, ["true", "false"].map((each) => node("option", { value: each, text: each })));
    } else if (column.enum) {
      const values = column.enum.indexOf(text) >= 0 || text === "" ? column.enum : column.enum.concat([text]);
      control = node("select", {}, values.map((each) => node("option", { value: each, text: each })));
    } else if (column.type === "json" || column.type === "text" || column.type === "any") {
      control = node("textarea", { rows: column.type === "json" ? "4" : "2", spellcheck: false });
    } else {
      control = node("input", { type: "text", placeholder: column.type === "datetime" ? "2026-01-31T12:00:00Z" : column.type === "date" ? "2026-01-31" : column.type === "binary" ? "Base64" : "" });
    }
    if (!isNull) {
      control.value = text;
    } else if (adding && column.default !== undefined && column.default !== null) {
      // What the database would fill in is what is shown, so that giving a value starts from it.
      control.value = typeof column.default === "object" ? JSON.stringify(column.default) : String(column.default);
    }
    control.setAttribute("aria-label", column.name);

    // Adding: a column is given a value, or left to the database. Changing: a column is left as it is unless it is touched.
    const supplied = Boolean(column.generated) || column.default !== undefined || Boolean(column.defaultExpression);
    const give = adding ? node("input", { type: "checkbox", checked: !supplied && !column.nullable }) : null;
    const none = column.nullable ? node("input", { type: "checkbox", checked: !adding && isNull }) : null;
    const settle = () => {
      control.disabled = tooLong || (give !== null && !give.checked) || (none !== null && none.checked);
      if (none !== null) {
        none.disabled = tooLong || (give !== null && !give.checked);
      }
    };
    control.addEventListener("input", () => {
      if (give !== null) {
        give.checked = true;
      }
    });
    for (const box of [give, none]) {
      if (box !== null) {
        box.addEventListener("change", settle);
      }
    }
    settle();

    const hints = [typeOf(column), column.nullable ? "may be NULL" : "not NULL"];
    if (column.primaryKey) {
      hints.push("primary key");
    }
    if (defaultOf(column) !== "") {
      hints.push((column.generated ? "" : "default ") + defaultOf(column));
    }
    const choices = node("div", { class: "choices" }, [
      give !== null ? node("label", { class: "check" }, [give, "give a value" + (column.generated === "insert time" ? " (else the time of the insert, as the application's ORM gives it)" : supplied ? " (else the database fills it)" : column.nullable ? " (else NULL)" : "")]) : null,
      none !== null ? node("label", { class: "check" }, [none, "NULL"]) : null,
      tooLong ? node("span", { text: "Too long to be changed here: change it with SQL." }) : null,
    ]);
    return {
      element: node("div", { class: "field" }, [node("div", {}, [node("div", { class: "name", text: column.name }), node("div", { class: "hint", text: hints.join(", ") })]), node("div", {}, [control, choices])]),
      /** undefined: the column is not part of the request. */
      read: () => {
        if (tooLong) {
          return undefined;
        }
        if (adding) {
          return !give.checked ? undefined : none !== null && none.checked ? null : typed(column, control.value);
        }
        const nowNull = none !== null && none.checked;
        if (nowNull === isNull && (nowNull || control.value === text)) {
          return undefined;
        }
        return nowNull ? null : typed(column, control.value);
      },
    };
  };

  /** A row to add (key is null), or the row with that key to change. */
  const openForm = async (table, key) => {
    const madeFor = state.pageOwner;
    let row = {};
    let tooLong = [];
    if (key !== null) {
      try {
        const found = await read("row", { table: table.name, key: key });
        row = found.row;
        tooLong = found.tooLong;
      } catch (failure) {
        fail(failure);
        return;
      }
    }
    const fields = table.columns.map((column) => ({ column: column, field: fieldFor(column, key === null, row[column.name], tooLong.indexOf(column.name) >= 0) }));
    const save = press(key === null ? "Add the row" : "Save the changes", async () => {
      const values = {};
      try {
        for (const each of fields) {
          const value = each.field.read();
          if (value !== undefined) {
            values[each.column.name] = value;
          }
        }
      } catch (invalid) {
        dialogError(invalid);
        return;
      }
      if (key !== null && Object.keys(values).length === 0) {
        dialogError(new Error("Nothing was changed."));
        return;
      }
      save.disabled = true;
      try {
        const done = key === null ? await change("insert", { table: table.name, values: values }, madeFor) : await change("update", { table: table.name, key: key, values: values }, madeFor);
        closeDialog();
        say("info", key === null ? "Added a row to " + table.name + (done.lastInsertId !== undefined ? " (" + table.primaryKey[0] + " = " + done.lastInsertId + ")" : "") + "." : "Changed the row of " + table.name + " with " + keyText(key) + ".");
        await refresh();
      } catch (failure) {
        save.disabled = false;
        dialogError(failure);
        if (failure.code === "OWNER_CHANGED" || failure.code === "OWNER_UNREACHABLE" || failure.code === "OUTCOME_UNKNOWN" || failure.code === "STUDIO_GONE") {
          poll();
        }
      }
    }, { class: "primary" });
    openDialog(key === null ? "Add a row to " + table.name : "Change the row of " + table.name + " with " + keyText(key), fields.map((each) => each.field.element), [press("Cancel", closeDialog, { class: "quiet" }), save], closeDialog);
  };

  const removeRow = async (table, key) => {
    const madeFor = state.pageOwner;
    if (!(await confirmThat("Delete this row of " + table.name + "?", ["The row with " + keyText(key) + " is removed from the database. That cannot be taken back."], "Delete the row"))) {
      return;
    }
    try {
      await change("delete", { table: table.name, key: key }, madeFor);
      say("info", "Deleted the row of " + table.name + " with " + keyText(key) + ".");
      await refresh();
    } catch (failure) {
      fail(failure);
    }
  };

  // --- the console ------------------------------------------------------------------------------------

  const renderResults = (outcome, wrote) => {
    const out = byId("sql-results");
    clear(out);
    outcome.results.forEach((result, index) => {
      const returned = result.columns.length > 0;
      const counted = returned ? result.rows.length + (result.rows.length === 1 ? " row" : " rows") + (result.truncated ? " shown, and there are more" : "") : "";
      const affected = result.operation === "INSERT" || result.operation === "UPDATE" || result.operation === "DELETE" ? result.affectedRows + (result.affectedRows === 1 ? " row affected" : " rows affected") : "";
      const block = node("div", { class: "result" }, [
        node("h3", { text: index + 1 + ". " + result.operation + ": " + [affected, counted].filter((part) => part !== "").join(", ") + " (" + result.localExecutionMs.toFixed(1) + " ms, local)" }),
        node("pre", { text: result.sql }),
      ]);
      if (returned) {
        block.append(grid(result.columns.map((name) => node("th", { text: name })), result.rows, result.cut, null));
      }
      out.append(block);
    });
    if (outcome.error) {
      out.append(
        node("div", { class: "failure" }, [
          node("strong", { text: "Statement " + outcome.error.statement + " failed (" + outcome.error.code + ")" }),
          node("p", { text: outcome.error.message }),
          node("pre", { text: outcome.error.sql }),
          node("p", { text: outcome.rolledBack ? "Everything this request changed was taken back: the database is as it was." : wrote ? "" : "Nothing after it was carried out." }),
        ]),
      );
    } else if (wrote) {
      out.append(node("p", { class: "empty", text: "Committed." }));
    }
  };

  const runSql = async () => {
    const sql = byId("sql-text").value;
    if (sql.trim() === "") {
      say("error", "There is no statement to run.");
      return;
    }
    const wrote = byId("sql-write").checked;
    const madeFor = state.owner;
    const request = { sql: sql, mode: wrote ? "write" : "read", maxRows: Number(byId("sql-rows").value) };
    if (wrote && !(await confirmThat("Run statements that may change the database?", ["They run as one transaction: it is committed when every statement went well, and taken back when one did not.", "What is committed cannot be taken back."], "Run and commit"))) {
      return;
    }
    const out = byId("sql-results");
    clear(out);
    out.append(node("p", { class: "empty", text: "Running..." }));
    byId("sql-run").disabled = true;
    try {
      const outcome = wrote ? await change("sql", request, madeFor) : await read("sql", request);
      renderResults(outcome, wrote);
      if (wrote && !outcome.error) {
        await refresh();
      }
    } catch (failure) {
      clear(out);
      out.append(node("div", { class: "failure" }, [node("strong", { text: failure.code || "Error" }), node("p", { text: failure.message })]));
      if (failure.code === "OWNER_CHANGED" || failure.code === "OWNER_UNREACHABLE" || failure.code === "OUTCOME_UNKNOWN" || failure.code === "STUDIO_GONE") {
        poll();
      }
    } finally {
      byId("sql-run").disabled = false;
    }
  };

  const buildConsole = () => {
    const editor = node("textarea", { id: "sql-text", rows: "8", spellcheck: false, placeholder: "SELECT * FROM a_table WHERE ...;", "aria-label": "SQL" });
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        runSql();
      }
    });
    const allow = node("input", { type: "checkbox", id: "sql-write" });
    const most = node("select", { id: "sql-rows", "aria-label": "Most rows a statement returns" }, [50, 200, 1000].map((count) => node("option", { value: String(count), text: "up to " + count + " rows", selected: count === 200 })));
    byId("view-sql").append(
      node("p", { class: "empty", text: "SELECT, INSERT, UPDATE, and DELETE, carried out by SQLite on the sandbox's runtime. Several statements are separated by semicolons. Ctrl+Enter runs them." }),
      editor,
      node("div", { class: "bar" }, [
        press("Run", runSql, { class: "primary", id: "sql-run" }),
        node("label", { class: "check" }, [allow, "Allow changes (INSERT, UPDATE, DELETE), as one transaction"]),
        node("span", { class: "space" }),
        most,
      ]),
      node("div", { id: "sql-results" }),
    );
  };

  // --- the API tab ------------------------------------------------------------------------------------

  /** What the API answered, as text. The page says what came; whether it is right is for the person to say. */
  const renderAnswer = (answer) => {
    const out = byId("api-result");
    clear(out);
    let text = answer.body;
    if (!answer.truncated && text.trim() !== "") {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch (notJson) {
        text = answer.body;
      }
    }
    out.append(
      node("div", { class: "result" }, [
        node("h3", { id: "api-status", text: answer.status + (answer.statusText ? " " + answer.statusText : "") + " (" + answer.durationMs.toFixed(1) + " ms, on this machine)" }),
        node("details", { class: "columns" }, [node("summary", { text: "Headers (" + answer.headers.length + ")" }), node("pre", { text: answer.headers.map((pair) => pair[0] + ": " + pair[1]).join("\n") })]),
        answer.truncated ? node("p", { class: "failure", text: "The body is longer than " + answer.bodyBytes + " bytes: what is shown is its beginning, and the rest was not read." }) : null,
        node("pre", { id: "api-answer", class: "body", text: text === "" ? "(no body)" : text }),
      ]),
      node("p", { class: "empty", text: "What the request changed in the database is in Rows and SQL." }),
    );
  };

  const sendRequest = async () => {
    const out = byId("api-result");
    clear(out);
    out.append(node("p", { class: "empty", text: "Sending..." }));
    byId("api-send").disabled = true;
    // Read from the fields now, sent once, and kept nowhere.
    const request = { method: byId("api-method").value, url: byId("api-url").value, headers: byId("api-headers").value, body: byId("api-body").value };
    try {
      renderAnswer((await call("POST", "/api/request", { request: request })).result);
    } catch (failure) {
      clear(out);
      out.append(node("div", { class: "failure", id: "api-failure" }, [node("strong", { text: failure.code || "Error" }), node("p", { text: failure.message })]));
      if (failure.code === "STUDIO_GONE") {
        poll();
      }
    } finally {
      byId("api-send").disabled = false;
    }
  };

  const buildApi = () => {
    const method = node("select", { id: "api-method", "aria-label": "Method" }, ["GET", "POST", "PUT", "PATCH", "DELETE"].map((name) => node("option", { value: name, text: name })));
    const url = node("input", { type: "text", id: "api-url", placeholder: "http://127.0.0.1:3000/", "aria-label": "URL", spellcheck: false, autocomplete: "off" });
    url.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendRequest();
      }
    });
    const headers = node("textarea", { id: "api-headers", rows: "3", spellcheck: false, autocomplete: "off", placeholder: "Authorization: Bearer ...", "aria-label": "Headers" });
    const body = node("textarea", { id: "api-body", rows: "6", spellcheck: false, placeholder: "{ \"name\": \"...\" }", "aria-label": "JSON body" });
    byId("view-api").append(
      node("p", { class: "empty", text: "Sends one request to an API on this machine (127.0.0.1, localhost, or [::1]), from Studio's server. Nothing is kept: not the request, its headers, or the answer." }),
      node("div", { class: "bar" }, [method, url, press("Send", sendRequest, { class: "primary", id: "api-send" })]),
      node("label", { class: "stacked" }, ["Headers, one per line (Name: value)", headers]),
      node("label", { class: "stacked" }, ["Body (JSON; not for GET)", body]),
      node("div", { id: "api-result" }),
    );
  };

  // --- the Export tab ---------------------------------------------------------------------------------

  const EXPORT_MODES = [
    ["schema", "Schema only", "CREATE TABLE, keys, foreign keys, unique constraints, defaults, indexes, enumerated types"],
    ["data", "Data only", "INSERT statements for the rows, for tables that are there already"],
    ["schema-and-data", "Schema + data", "the definitions, the rows, and the foreign keys after them"],
  ];

  const exportMode = () => {
    const chosen = document.querySelector('input[name="export-mode"]:checked');
    return chosen ? chosen.value : "schema";
  };

  /** What the chosen tables and mode are, in words, and whether an export can be asked for. */
  const updateExport = () => {
    const mode = exportMode();
    const withData = mode !== "schema";
    const count = state.exportTables.size;
    byId("export-confirm-line").hidden = !withData;
    const label = EXPORT_MODES.find((entry) => entry[0] === mode)[1];
    byId("export-summary").textContent = count + " table" + (count === 1 ? "" : "s") + " · " + label;
    byId("export-run").disabled = count === 0 || (withData && !byId("export-confirm").checked) || !connected();
  };

  /** The tables to choose from: those the database has now. A choice is kept for the tables that are still there. */
  const renderExportTables = () => {
    const list = byId("export-tables");
    if (!list) {
      return;
    }
    clear(list);
    const tables = state.schema ? state.schema.tables : [];
    for (const name of [...state.exportTables]) {
      if (!tables.some((table) => table.name === name)) {
        state.exportTables.delete(name);
      }
    }
    if (tables.length === 0) {
      list.append(node("li", { class: "empty", text: "The database has no tables." }));
    }
    tables.forEach((table, index) => {
      const box = node("input", { type: "checkbox", id: "export-table-" + index, "data-table": table.name, checked: state.exportTables.has(table.name) });
      box.addEventListener("change", () => {
        if (box.checked) {
          state.exportTables.add(table.name);
        } else {
          state.exportTables.delete(table.name);
        }
        updateExport();
      });
      list.append(node("li", {}, [node("label", { class: "check" }, [box, table.name + " (" + table.rows + " row" + (table.rows === 1 ? "" : "s") + ")"])]));
    });
    updateExport();
  };

  const chooseAll = (all) => () => {
    state.exportTables = new Set(all && state.schema ? state.schema.tables.map((table) => table.name) : []);
    renderExportTables();
  };

  /** Offers the script as a file: made in the page, from what the server gave, and sent nowhere. */
  const offerFile = (result) => {
    if (state.exportUrl) {
      URL.revokeObjectURL(state.exportUrl);
    }
    state.exportUrl = URL.createObjectURL(new Blob([result.sql], { type: "application/sql;charset=utf-8" }));
    const link = node("a", { id: "export-download", href: state.exportUrl, download: result.fileName, text: "Download " + result.fileName + " again" });
    link.click();
    return link;
  };

  const runExport = async () => {
    const out = byId("export-result");
    clear(out);
    const mode = exportMode();
    const tables = state.schema ? state.schema.tables.map((table) => table.name).filter((name) => state.exportTables.has(name)) : [];
    out.append(node("p", { class: "empty", text: "Exporting..." }));
    byId("export-run").disabled = true;
    try {
      const result = (await call("POST", "/api/export", { request: { tables: tables, mode: mode, confirmData: mode !== "schema" && byId("export-confirm").checked } })).result;
      clear(out);
      const link = offerFile(result);
      const label = EXPORT_MODES.find((entry) => entry[0] === result.mode)[1];
      out.append(
        node("div", { class: "result", id: "export-done" }, [
          node("h3", { text: "Exported " + result.tables.length + " table" + (result.tables.length === 1 ? "" : "s") + " · " + label + (result.mode === "schema" ? "" : " · " + result.rows + " row" + (result.rows === 1 ? "" : "s")) }),
          node("p", { text: result.statements + " statements, " + result.bytes + " bytes, as one transaction. Load it with psql -v ON_ERROR_STOP=1 -f " + result.fileName + "." }),
          result.warnings.length > 0 ? node("div", { class: "failure", id: "export-warnings" }, [node("strong", { text: "Warnings (also in the file)" }), node("ul", {}, result.warnings.map((warning) => node("li", { text: warning })))]) : null,
          node("p", {}, [link]),
        ]),
      );
    } catch (failure) {
      clear(out);
      out.append(node("div", { class: "failure", id: "export-failure" }, [node("strong", { text: failure.code || "Error" }), node("p", { text: failure.message + " No file was made." })]));
      if (failure.refusals) {
        out.lastChild.append(node("ul", {}, failure.refusals.map((refusal) => node("li", { text: (refusal.table ? refusal.table + (refusal.column ? "." + refusal.column : "") + ": " : "") + refusal.message }))));
      }
      if (failure.code === "STUDIO_GONE") {
        poll();
      }
    } finally {
      updateExport();
    }
  };

  const buildExport = () => {
    const modes = EXPORT_MODES.map((entry, index) => {
      const radio = node("input", { type: "radio", name: "export-mode", id: "export-mode-" + entry[0], value: entry[0], checked: index === 0 });
      radio.addEventListener("change", updateExport);
      return node("label", { class: "check stacked-mode" }, [radio, node("strong", { text: entry[1] }), node("span", { class: "empty", text: " — " + entry[2] })]);
    });
    const confirm = node("input", { type: "checkbox", id: "export-confirm" });
    confirm.addEventListener("change", updateExport);
    byId("view-export").append(
      node("p", { class: "empty", text: "Writes the chosen tables as an SQL script for PostgreSQL, to load into an empty database with psql. It reads the sandbox and changes nothing; it connects to no database." }),
      node("h3", { text: "Tables" }),
      node("div", { class: "bar" }, [press("All", chooseAll(true), { id: "export-all" }), press("None", chooseAll(false), { id: "export-none" })]),
      node("ul", { id: "export-tables", class: "choices" }),
      node("h3", { text: "What to export" }),
      node("div", { id: "export-modes" }, modes),
      node("p", { id: "export-confirm-line", hidden: true }, [
        node("label", { class: "check" }, [confirm, "The file will hold the rows of these tables, which may be data you entered: I want them in it."]),
      ]),
      node("div", { class: "bar" }, [press("Export .sql", runExport, { class: "primary", id: "export-run" }), node("span", { id: "export-summary", class: "empty" })]),
      node("div", { id: "export-result" }),
    );
    updateExport();
  };

  // --- the Clear data tab -----------------------------------------------------------------------------

  /** The tables chosen to clear, as the page last read them, with their rows. */
  const clearChoice = () => (state.schema ? state.schema.tables.filter((table) => state.clearTables.has(table.name)) : []);

  /** What the chosen tables hold, and whether the rows can be cleared: tables chosen, the loss acknowledged, the database writable. */
  const updateClear = () => {
    const chosen = clearChoice();
    const rows = chosen.reduce((sum, table) => sum + table.rows, 0);
    byId("clear-summary").textContent = chosen.length + " table" + (chosen.length === 1 ? "" : "s") + " · " + rows + " row" + (rows === 1 ? "" : "s") + " to delete";
    const why = byId("clear-locked");
    why.hidden = writable();
    why.textContent = !connected() ? "Not connected: nothing can be cleared now." : state.status && state.status.info && state.status.info.readOnly ? "Read-only: " + state.status.info.readOnly : "";
    byId("clear-run").disabled = chosen.length === 0 || !byId("clear-understood").checked || !writable();
  };

  const renderClearTables = () => {
    const list = byId("clear-tables");
    if (!list) {
      return;
    }
    clear(list);
    const tables = state.schema ? state.schema.tables : [];
    for (const name of [...state.clearTables]) {
      if (!tables.some((table) => table.name === name)) {
        state.clearTables.delete(name);
      }
    }
    if (tables.length === 0) {
      list.append(node("li", { class: "empty", text: "The database has no tables." }));
    }
    tables.forEach((table, index) => {
      const box = node("input", { type: "checkbox", id: "clear-table-" + index, "data-table": table.name, checked: state.clearTables.has(table.name) });
      box.addEventListener("change", () => {
        if (box.checked) {
          state.clearTables.add(table.name);
        } else {
          state.clearTables.delete(table.name);
        }
        updateClear();
      });
      list.append(node("li", {}, [node("label", { class: "check" }, [box, table.name + " (" + table.rows + " row" + (table.rows === 1 ? "" : "s") + ")"])]));
    });
    updateClear();
  };

  const chooseToClear = (all) => () => {
    state.clearTables = new Set(all && state.schema ? state.schema.tables.map((table) => table.name) : []);
    renderClearTables();
  };

  const runClear = async () => {
    const chosen = clearChoice();
    const rows = chosen.reduce((sum, table) => sum + table.rows, 0);
    // The rows are those of the runtime the page shows now: a request made for it is carried out by no other.
    const madeFor = state.owner;
    const lines = [
      "Every row of " + (chosen.length === 1 ? "this table" : "these " + chosen.length + " tables") + " is deleted, in one transaction: " + chosen.map((table) => table.name + " (" + table.rows + ")").join(", ") + ".",
      "The tables stay as they are: columns, keys, constraints, indexes. Numbering goes on after the last number given: an id is not given again while the database stays open.",
      "This cannot be undone. To keep the rows, export them first (Export, with data), or copy the database directory while nothing has it open.",
    ];
    if (!(await confirmThat("Delete " + rows + " row" + (rows === 1 ? "" : "s") + " from " + chosen.length + " table" + (chosen.length === 1 ? "" : "s") + "?", lines, "Delete the rows"))) {
      return;
    }
    const out = byId("clear-result");
    clear(out);
    byId("clear-run").disabled = true;
    try {
      const done = await change("clear", { tables: chosen.map((table) => table.name) }, madeFor);
      out.append(node("p", { id: "clear-done", text: "Deleted " + done.rows + " row" + (done.rows === 1 ? "" : "s") + " from " + done.tables.length + " table" + (done.tables.length === 1 ? "" : "s") + ": " + done.tables.map((entry) => entry.table + " (" + entry.rows + ")").join(", ") + "." }));
      say("info", "Deleted " + done.rows + " row" + (done.rows === 1 ? "" : "s") + ".");
      byId("clear-understood").checked = false;
      await refresh();
    } catch (failure) {
      out.append(node("div", { class: "failure", id: "clear-failure" }, [node("strong", { text: failure.code || "Error" }), node("p", { text: failure.message })]));
      if (failure.code === "OWNER_CHANGED" || failure.code === "OWNER_UNREACHABLE" || failure.code === "OUTCOME_UNKNOWN" || failure.code === "STUDIO_GONE") {
        poll();
      }
    } finally {
      updateClear();
    }
  };

  const buildClear = () => {
    const understood = node("input", { type: "checkbox", id: "clear-understood" });
    understood.addEventListener("change", updateClear);
    byId("view-clear").append(
      node("p", { class: "empty", text: "Deletes every row of the tables you choose, in one transaction. The tables, their columns, keys, constraints, and indexes stay. A table whose rows another table that is not chosen refers to is not cleared: choose that table too." }),
      node("h3", { text: "Tables" }),
      node("div", { class: "bar" }, [press("All", chooseToClear(true), { id: "clear-all" }), press("None", chooseToClear(false), { id: "clear-none" })]),
      node("ul", { id: "clear-tables", class: "choices" }),
      node("p", {}, [node("label", { class: "check" }, [understood, "I understand that the rows deleted cannot be restored."])]),
      node("div", { class: "bar" }, [press("Clear data…", runClear, { class: "danger", id: "clear-run" }), node("span", { id: "clear-summary", class: "empty" })]),
      node("p", { id: "clear-locked", class: "failure", hidden: true }),
      node("div", { id: "clear-result" }),
    );
    updateClear();
  };

  // --- the ER diagram ---------------------------------------------------------------------------------

  const SVG = "http://www.w3.org/2000/svg";
  /** An element of the drawing. Names of the database only ever get here as text. */
  const shape = (tag, attributes, children) => {
    const made = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes || {})) {
      if (name === "text") {
        made.textContent = value;
      } else {
        made.setAttribute(name, String(value));
      }
    }
    for (const child of children || []) {
      if (child) {
        made.append(child);
      }
    }
    return made;
  };
  const tip = (text) => shape("title", { text: text });
  const plural = (count, one, many) => count + " " + (count === 1 ? one : many);

  /** What the diagram was made from: the tables and their columns, without their numbers of rows. */
  const erSignature = () => (state.schema ? JSON.stringify(state.schema.tables.map((table) => [table.name, table.columns])) : "");

  /** The schema was read again: the diagram is made again when it shows, if what it is made from changed. */
  const schemaRead = () => {
    if (state.er.signature !== erSignature()) {
      state.er.stale = true;
      if (!byId("view-er").hidden) {
        loadEr();
      }
    }
  };

  const erNote = (kind, text) => {
    const note = byId("er-note");
    clear(note);
    note.className = kind === "error" ? "failure" : "empty";
    note.hidden = text === "";
    note.textContent = text;
  };

  const loadEr = async () => {
    if (!state.schema || state.er.loading) {
      return;
    }
    state.er.loading = true;
    state.er.stale = false;
    const signature = erSignature();
    byId("er-summary").textContent = "Laying out the tables…";
    try {
      let diagram;
      for (let attempt = 0; ; attempt += 1) {
        try {
          diagram = (await call("POST", "/api/diagram", { request: { tables: state.schema.tables.map((table) => table.name) } })).result;
          break;
        } catch (failure) {
          if (failure.code !== "BUSY" || attempt >= 3) {
            throw failure;
          }
          await wait(250);
        }
      }
      state.er.signature = signature;
      state.er.diagram = diagram;
      state.er.found = null;
      state.er.chosen = null;
      arrangeEr();
      erNote("info", "");
      const unresolved = diagram.unresolved.length;
      if (diagram.tables.length === 0) {
        erNote("info", "The database has no tables.");
      } else if (unresolved > 0) {
        erNote("info", plural(unresolved, "foreign key refers", "foreign keys refer") + " to a table that is not in the database, and " + (unresolved === 1 ? "is" : "are") + " not drawn: " + diagram.unresolved.map((key) => key.from.table + " (" + key.from.columns.join(", ") + ") → " + key.to.table).join("; ") + ".");
      }
    } catch (failure) {
      state.er.diagram = null;
      state.er.signature = null;
      drawEr();
      erNote("error", (failure.code ? failure.code + ": " : "") + failure.message);
      if (failure.code === "OWNER_CHANGED" || failure.code === "OWNER_UNREACHABLE" || failure.code === "STUDIO_GONE") {
        poll();
      }
    } finally {
      state.er.loading = false;
      renderErSummary();
      searchEr();
    }
    if (state.er.stale) {
      loadEr();
    }
  };

  const renderErSummary = () => {
    const diagram = state.er.diagram;
    byId("er-summary").textContent = diagram ? plural(diagram.tables.length, "table", "tables") + " · " + plural(diagram.foreignKeys.length + diagram.unresolved.length, "foreign key", "foreign keys") : "";
  };

  /** Every table where the layout put it, and all of them in view. */
  const arrangeEr = () => {
    state.er.at = new Map();
    for (const table of state.er.diagram ? state.er.diagram.tables : []) {
      state.er.at.set(table.name, { x: table.x, y: table.y });
    }
    drawEr();
    fitEr();
  };

  /** The rows of a column's line, as the page shows them: where a line to it starts or ends. */
  const anchor = (table, column, right) => {
    const at = state.er.at.get(table.name);
    const g = state.er.diagram.geometry;
    const index = table.columns.findIndex((each) => each.name === column);
    return { x: at.x + (right ? table.width : 0), y: at.y + (index < 0 ? g.header / 2 : g.header + index * g.row + g.row / 2) };
  };

  /** The line of one pair of columns of a foreign key, from the column that refers to the one referred to. */
  const linePath = (line) => {
    const from = line.from;
    const to = line.to;
    const a = state.er.at.get(from.name);
    const b = state.er.at.get(to.name);
    if (line.key.self) {
      const start = anchor(from, line.fromColumn, true);
      const end = anchor(to, line.toColumn, true);
      const out = 28 + 10 * line.pair;
      return "M" + start.x + " " + start.y + " C" + (start.x + out) + " " + start.y + " " + (end.x + out) + " " + end.y + " " + (end.x + 6) + " " + end.y;
    }
    let start;
    let end;
    let bend;
    if (b.x >= a.x + from.width) {
      start = anchor(from, line.fromColumn, true);
      end = anchor(to, line.toColumn, false);
      bend = Math.max(40, (end.x - start.x) / 2);
      return "M" + start.x + " " + start.y + " C" + (start.x + bend) + " " + start.y + " " + (end.x - bend) + " " + end.y + " " + (end.x - 6) + " " + end.y;
    }
    if (b.x + to.width <= a.x) {
      start = anchor(from, line.fromColumn, false);
      end = anchor(to, line.toColumn, true);
      bend = Math.max(40, (start.x - end.x) / 2);
      return "M" + start.x + " " + start.y + " C" + (start.x - bend) + " " + start.y + " " + (end.x + bend) + " " + end.y + " " + (end.x + 6) + " " + end.y;
    }
    // One above the other: out of the right sides, and round.
    start = anchor(from, line.fromColumn, true);
    end = anchor(to, line.toColumn, true);
    const edge = Math.max(start.x, end.x) + 40 + 10 * line.pair;
    return "M" + start.x + " " + start.y + " C" + edge + " " + start.y + " " + edge + " " + end.y + " " + (end.x + 6) + " " + end.y;
  };

  const placeTable = (name) => {
    const at = state.er.at.get(name);
    state.er.boxes.get(name).setAttribute("transform", "translate(" + at.x + " " + at.y + ")");
    for (const line of state.er.linesOf.get(name) || []) {
      line.path.setAttribute("d", linePath(line));
    }
  };

  const markEr = () => {
    for (const [name, box] of state.er.boxes) {
      box.classList.toggle("found", name === state.er.found);
      box.classList.toggle("chosen", name === state.er.chosen);
    }
    for (const line of state.er.lines) {
      line.path.classList.toggle("related", state.er.chosen !== null && (line.from.name === state.er.chosen || line.to.name === state.er.chosen));
    }
  };

  const drawEr = () => {
    const edges = byId("er-edges");
    const boxes = byId("er-boxes");
    clear(edges);
    clear(boxes);
    state.er.boxes = new Map();
    state.er.lines = [];
    state.er.linesOf = new Map();
    const diagram = state.er.diagram;
    if (!diagram) {
      return;
    }
    const g = diagram.geometry;
    const tables = new Map(diagram.tables.map((table) => [table.name, table]));
    for (const table of diagram.tables) {
      const parts = [
        tip(table.name + (table.primaryKey.length > 0 ? "\nPrimary key: " + table.primaryKey.join(", ") : "\nNo primary key")),
        shape("rect", { class: "box", width: table.width, height: table.height, rx: 4 }),
        shape("rect", { class: "head", width: table.width, height: g.header, rx: 4 }),
        shape("line", { class: "rule", x1: 0, x2: table.width, y1: g.header, y2: g.header }),
        shape("text", { class: "title", x: g.padding, y: 19, text: table.label || table.name }),
      ];
      if (table.columns.length === 0) {
        parts.push(shape("text", { class: "soft", x: g.padding, y: g.header + 14, text: "(no columns)" }));
      }
      table.columns.forEach((column, index) => {
        const y = g.header + index * g.row + 14;
        const keys = (column.primaryKey ? "PK" : "") + (column.primaryKey && column.foreignKey ? " " : "") + (column.foreignKey ? "FK" : "");
        const line = shape("g", { class: "column", "data-column": column.name }, [
          tip(column.name + ": " + column.type + (column.nullable ? ", NULL" : ", NOT NULL") + (column.primaryKey ? ", primary key" : "") + (column.foreignKey ? ", foreign key" : "")),
          keys ? shape("text", { class: "key", x: table.slots[0], y: y, text: keys }) : null,
          shape("text", { class: "name", x: table.slots[1], y: y, text: column.label || column.name }),
          shape("text", { class: "soft type", x: table.slots[2], y: y, text: column.typeLabel || column.type }),
          shape("text", { class: "soft nulls", x: table.slots[3], y: y, text: column.nullable ? "null" : "not null" }),
        ]);
        parts.push(line);
      });
      const box = shape("g", { class: "er-table", "data-table": table.name }, parts);
      box.addEventListener("pointerdown", (event) => dragTable(event, table.name));
      state.er.boxes.set(table.name, box);
      boxes.append(box);
    }
    for (const key of diagram.foreignKeys) {
      const from = tables.get(key.from.table);
      const to = tables.get(key.to.table);
      const says = (key.name ? key.name + ": " : "") + key.from.table + " (" + key.from.columns.join(", ") + ") → " + key.to.table + " (" + key.to.columns.join(", ") + ")" + (key.onDelete ? "\nON DELETE " + key.onDelete : "") + (key.onUpdate ? "\nON UPDATE " + key.onUpdate : "");
      key.from.columns.forEach((column, pair) => {
        const path = shape("path", { class: "er-edge", "data-fk": key.id, "marker-end": "url(#er-arrow)" }, [tip(says)]);
        const line = { key: key, from: from, to: to, fromColumn: column, toColumn: key.to.columns[pair], pair: pair, path: path };
        state.er.lines.push(line);
        for (const name of new Set([from.name, to.name])) {
          state.er.linesOf.set(name, (state.er.linesOf.get(name) || []).concat([line]));
        }
        edges.append(path);
      });
    }
    for (const table of diagram.tables) {
      placeTable(table.name);
    }
    // Text that is wider than its place (a font the page does not have, wide characters) is drawn narrower to fit.
    for (const table of diagram.tables) {
      const box = state.er.boxes.get(table.name);
      const room = [table.slots[2] - table.slots[1] - g.gap / 2, table.slots[3] - table.slots[2] - g.gap / 2];
      box.querySelectorAll("text.name, text.type").forEach((text) => {
        const space = text.classList.contains("name") ? room[0] : room[1];
        if (text.getComputedTextLength() > space) {
          text.setAttribute("textLength", String(space));
          text.setAttribute("lengthAdjust", "spacingAndGlyphs");
        }
      });
      const title = box.querySelector("text.title");
      if (title.getComputedTextLength() > table.width - 2 * g.padding) {
        title.setAttribute("textLength", String(table.width - 2 * g.padding));
        title.setAttribute("lengthAdjust", "spacingAndGlyphs");
      }
    }
    markEr();
  };

  const ER_MIN_ZOOM = 0.02;
  const ER_MAX_ZOOM = 4;

  // Where the drawing is looked at from: moved by x and y, and made k times as large.
  const viewEr = () => {
    const view = state.er.view;
    byId("er-viewport").setAttribute("transform", "translate(" + view.x + " " + view.y + ") scale(" + view.k + ")");
    byId("er-zoom").textContent = Math.round(view.k * 100) + "%";
  };

  const canvasSize = () => {
    const box = byId("er-canvas").getBoundingClientRect();
    return { width: box.width, height: box.height, left: box.left, top: box.top };
  };

  /** Everything in view. While the tab is not shown, when it is shown next. */
  const fitEr = () => {
    const size = canvasSize();
    if (size.width === 0 || size.height === 0) {
      state.er.fitLater = true;
      return;
    }
    state.er.fitLater = false;
    const diagram = state.er.diagram;
    if (!diagram || diagram.tables.length === 0) {
      state.er.view = { x: 0, y: 0, k: 1 };
      viewEr();
      return;
    }
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const table of diagram.tables) {
      const at = state.er.at.get(table.name);
      left = Math.min(left, at.x);
      top = Math.min(top, at.y);
      right = Math.max(right, at.x + table.width + 60);
      bottom = Math.max(bottom, at.y + table.height);
    }
    const margin = 24;
    const k = Math.max(ER_MIN_ZOOM, Math.min(1.25, (size.width - 2 * margin) / (right - left), (size.height - 2 * margin) / (bottom - top)));
    state.er.view = { k: k, x: (size.width - (right - left) * k) / 2 - left * k, y: (size.height - (bottom - top) * k) / 2 - top * k };
    viewEr();
  };

  /** Zooms by a factor, keeping the point at (px, py) of the canvas where it is. */
  const zoomEr = (factor, px, py) => {
    const view = state.er.view;
    const size = canvasSize();
    const x = px === undefined ? size.width / 2 : px;
    const y = py === undefined ? size.height / 2 : py;
    const k = Math.min(ER_MAX_ZOOM, Math.max(ER_MIN_ZOOM, view.k * factor));
    state.er.view = { k: k, x: x - ((x - view.x) * k) / view.k, y: y - ((y - view.y) * k) / view.k };
    viewEr();
  };

  /** A table in the middle of the view, large enough to read, and shown as the one found. */
  const focusEr = (name) => {
    const table = state.er.diagram ? state.er.diagram.tables.find((each) => each.name === name) : undefined;
    if (!table) {
      return;
    }
    const size = canvasSize();
    const at = state.er.at.get(name);
    const k = Math.min(ER_MAX_ZOOM, Math.max(state.er.view.k, 1));
    state.er.view = { k: k, x: size.width / 2 - (at.x + table.width / 2) * k, y: size.height / 2 - (at.y + table.height / 2) * k };
    state.er.found = name;
    state.er.chosen = name;
    // In front of the others.
    byId("er-boxes").append(state.er.boxes.get(name));
    viewEr();
    markEr();
  };

  const dragTable = (event, name) => {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    const box = state.er.boxes.get(name);
    const start = { x: event.clientX, y: event.clientY };
    const from = Object.assign({}, state.er.at.get(name));
    let moved = false;
    box.setPointerCapture(event.pointerId);
    byId("er-boxes").append(box);
    const move = (next) => {
      const dx = (next.clientX - start.x) / state.er.view.k;
      const dy = (next.clientY - start.y) / state.er.view.k;
      if (!moved && Math.abs(next.clientX - start.x) + Math.abs(next.clientY - start.y) < 4) {
        return;
      }
      moved = true;
      // Only where it stands on this page: nothing of it is kept, and the schema is not changed.
      state.er.at.set(name, { x: Math.round(from.x + dx), y: Math.round(from.y + dy) });
      placeTable(name);
    };
    const done = () => {
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", done);
      box.removeEventListener("pointercancel", done);
      if (!moved) {
        state.er.chosen = state.er.chosen === name ? null : name;
        markEr();
      }
    };
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerup", done);
    box.addEventListener("pointercancel", done);
  };

  const panEr = (event) => {
    if (event.button !== 0) {
      return;
    }
    const canvas = byId("er-canvas");
    const start = { x: event.clientX, y: event.clientY, view: Object.assign({}, state.er.view) };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("panning");
    const move = (next) => {
      state.er.view = { k: start.view.k, x: start.view.x + next.clientX - start.x, y: start.view.y + next.clientY - start.y };
      viewEr();
    };
    const done = () => {
      canvas.classList.remove("panning");
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", done);
      canvas.removeEventListener("pointercancel", done);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", done);
    canvas.addEventListener("pointercancel", done);
  };

  const ER_RESULTS = 30;

  const searchEr = () => {
    const list = byId("er-results");
    clear(list);
    const asked = byId("er-search").value.trim().toLowerCase();
    if (asked === "" || !state.er.diagram) {
      return;
    }
    const found = state.er.diagram.tables.filter((table) => table.name.toLowerCase().includes(asked));
    if (found.length === 0) {
      list.append(node("li", { class: "empty", text: "No table is called that." }));
    }
    for (const table of found.slice(0, ER_RESULTS)) {
      list.append(node("li", {}, [press(table.name, () => focusEr(table.name), { class: "quiet", "data-table": table.name })]));
    }
    if (found.length > ER_RESULTS) {
      list.append(node("li", { class: "empty", text: "and " + (found.length - ER_RESULTS) + " more: type more of the name." }));
    }
  };

  const buildEr = () => {
    const search = node("input", { type: "search", id: "er-search", placeholder: "Find a table", "aria-label": "Find a table", autocomplete: "off" });
    search.addEventListener("input", searchEr);
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const first = byId("er-results").querySelector("button");
        if (first) {
          first.click();
        }
      }
    });
    const canvas = shape("svg", { id: "er-canvas", role: "img", "aria-label": "ER diagram of the tables and their foreign keys" }, [
      shape("defs", {}, [shape("marker", { id: "er-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, [shape("path", { class: "er-arrow", d: "M0 0 L10 5 L0 10 z" })])]),
      shape("g", { id: "er-viewport" }, [shape("g", { id: "er-edges" }), shape("g", { id: "er-boxes" })]),
    ]);
    canvas.addEventListener("pointerdown", panEr);
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const size = canvasSize();
        zoomEr(Math.exp(-event.deltaY * 0.0015), event.clientX - size.left, event.clientY - size.top);
      },
      { passive: false },
    );
    byId("view-er").append(
      node("div", { class: "bar" }, [
        search,
        press("Zoom in", () => zoomEr(1.25), { id: "er-zoom-in", title: "Zoom in (or the mouse wheel)" }),
        press("Zoom out", () => zoomEr(0.8), { id: "er-zoom-out", title: "Zoom out (or the mouse wheel)" }),
        node("span", { id: "er-zoom", class: "empty", text: "100%" }),
        press("Fit to view", fitEr, { id: "er-fit" }),
        press("Auto arrange", arrangeEr, { id: "er-arrange", title: "Every table back where the layout puts it. Moved tables are not kept." }),
        node("span", { class: "space" }),
        node("span", { id: "er-summary", class: "empty" }),
      ]),
      node("ul", { id: "er-results" }),
      node("p", { id: "er-note", class: "empty", hidden: true }),
      canvas,
      node("p", { class: "empty", text: "Drag the background to pan, the wheel to zoom, a table to move it; click a table to show its foreign keys. What is moved is not kept, and the schema is not changed. The diagram is made of the tables' definitions: no row is read." }),
    );
    viewEr();
  };

  const showEr = () => {
    if (state.er.stale || !state.er.diagram) {
      loadEr();
    } else if (state.er.fitLater) {
      fitEr();
    }
  };

  // --- starting ---------------------------------------------------------------------------------------

  /** The key of the session: from behind the # of the address, once, and from then on from the tab's own store. */
  const takeKey = () => {
    const given = /[#&]key=([0-9a-f]{16,})/.exec(window.location.hash);
    let kept = null;
    try {
      kept = window.sessionStorage.getItem(STORE);
    } catch (unavailable) {
      kept = null;
    }
    if (!given) {
      return kept;
    }
    try {
      window.sessionStorage.setItem(STORE, given[1]);
    } catch (unavailable) {
      // Kept in this page alone, then.
    }
    // Out of the address bar, and out of what the browser remembers of it.
    window.history.replaceState(null, "", window.location.pathname);
    return given[1];
  };

  const show = (view) => {
    for (const name of ["table", "sql", "api", "export", "clear", "er"]) {
      byId("view-" + name).hidden = name !== view;
      byId("tab-" + name).classList.toggle("current", name === view);
    }
    if (view === "er") {
      showEr();
    }
  };

  state.key = takeKey();
  if (!state.key) {
    locked('This page needs the key of its Studio session. Open the address that "local-db-sandbox studio" printed: it ends in #key= and the key.');
    return;
  }
  buildConsole();
  buildApi();
  buildExport();
  buildClear();
  buildEr();
  byId("tab-table").addEventListener("click", () => show("table"));
  byId("tab-sql").addEventListener("click", () => show("sql"));
  byId("tab-api").addEventListener("click", () => show("api"));
  byId("tab-export").addEventListener("click", () => show("export"));
  byId("tab-clear").addEventListener("click", () => show("clear"));
  byId("tab-er").addEventListener("click", () => show("er"));
  byId("refresh").addEventListener("click", async () => {
    await poll();
    if (connected()) {
      await refresh();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.dismiss) {
      state.dismiss();
    }
  });
  poll();
  setInterval(poll, POLL_MS);
})();
`;

/** The page. `nonce`: what the browser is told the page's one style and one script carry (`Content-Security-Policy`). */
export function studioPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local DB Studio</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>${MARKUP}<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
