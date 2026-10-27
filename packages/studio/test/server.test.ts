import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Script } from "node:vm";
import { DEFAULT_ACCESS_LIMITS, SINGLE_FILE_READ_ONLY } from "../../runtime-access/src/index.ts";
import { DATA, SCHEMA } from "../../runtime-access/test/support/fixture.ts";
import { ownDatabase } from "../../runtime-access/test/support/owner-process.ts";
import type { OwnerProcess } from "../../runtime-access/test/support/owner-process.ts";
import { canonicalDatabasePath, createDatabase, ownerRecordPath } from "../../storage-json/src/index.ts";
import { allFiles, storedRows } from "../../storage-json/test/support/database-files.ts";
import { DEFAULT_STUDIO_PORT, startStudio } from "../src/index.ts";
import type { RunningStudio, StudioStatus } from "../src/index.ts";

/*
 * Studio's page and the API behind it (D-042). The page is served to this
 * machine, and what it asks for is answered only with the key of the
 * session. Behind the API is the access to the runtime, and nothing else:
 * what is asked through the page is what is asked through the control.
 */

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
}

/** One request, with the headers as they are given: a browser decides `Host` and `Origin`, and so does this. */
function raw(url: string, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${url}${options.path ?? "/"}`, { method: options.method ?? "GET", agent: false, headers: { connection: "close", ...options.headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
      });
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

function reaches(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port });
    const done = (reached: boolean): void => {
      socket.destroy();
      resolve(reached);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1500, () => done(false));
  });
}

describe("Studio's page and its API", { timeout: 180_000 }, () => {
  let root: string;
  let directory: string;
  let file: string;
  const running: RunningStudio[] = [];
  const owners: OwnerProcess[] = [];
  const start = async (options: { database?: string; readOnly?: boolean; port?: number } = {}): Promise<RunningStudio> => {
    const studio = await startStudio({ database: directory, port: 0, ...options });
    running.push(studio);
    return studio;
  };
  /** What the page asks: with the key of the session, as the page sends it. `as`: with another key, or with none (`{}`). */
  const api = (studio: RunningStudio, path: string, body?: unknown, as: { key?: string } = { key: studio.key }): Promise<Answer> =>
    raw(studio.url, {
      method: body === undefined ? "GET" : "POST",
      path,
      headers: { ...(as.key !== undefined && { authorization: `Bearer ${as.key}` }), ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const ask = (studio: RunningStudio, operation: string, request?: unknown, madeFor?: string): Promise<Answer> => api(studio, `/api/access/${operation}`, { ...(madeFor !== undefined && { for: madeFor }), ...(request !== undefined && { request }) });
  const status = async (studio: RunningStudio): Promise<StudioStatus> => (await api(studio, "/api/status")).json as StudioStatus;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-server-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    const home = join(root, `db-${Math.random().toString(16).slice(2)}`);
    directory = join(home, "sandbox.db");
    file = join(home, "sandbox.db.json");
    await createDatabase(directory, { collections: DATA(), schema: SCHEMA });
    await createDatabase(file, { collections: DATA() });
  });
  afterEach(async () => {
    for (const studio of running.splice(0)) {
      await studio.stop();
    }
    for (const owner of owners.splice(0)) {
      await owner.kill();
    }
  });

  describe("where it is served", () => {
    it("is this machine's own address and no other, with a key no one can guess behind a # in the address to open", async () => {
      const studio = await start();
      assert.match(studio.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(studio.key, /^[0-9a-f]{48}$/);
      assert.equal(studio.address, `${studio.url}/#key=${studio.key}`);
      assert.equal(studio.port, Number(new URL(studio.url).port));
      assert.equal(DEFAULT_STUDIO_PORT, 4583);
      assert.equal(await reaches("127.0.0.1", studio.port), true);
      const addresses = Object.values(networkInterfaces())
        .flat()
        .filter((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4")
        .map((entry) => entry?.address as string);
      for (const address of addresses) {
        assert.equal(await reaches(address, studio.port), false, `Studio answers at ${address}`);
      }
      // Another session has another key.
      const other = await start({ database: file });
      assert.notEqual(other.key, studio.key);
    });

    it("says that its port is taken, and has let go of the database then", async () => {
      const taken = createServer();
      await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
      try {
        await assert.rejects(start({ port: (taken.address() as { port: number }).port }), { code: "EADDRINUSE" });
      } finally {
        await new Promise((resolve) => taken.close(resolve));
      }
      assert.equal(await readFile(ownerRecordPath(directory), "utf8").catch(() => "none"), "none");
      await (await start()).stop();
    });

    it("stops when it is told to, lets go of a database it had to itself, and that can be said twice", async () => {
      const studio = await start();
      assert.equal(JSON.parse(readFileSync(ownerRecordPath(directory), "utf8")).kind, "studio");
      await studio.stop();
      await studio.stop();
      assert.equal(await reaches("127.0.0.1", studio.port), false);
      assert.equal(await readFile(ownerRecordPath(directory), "utf8").catch(() => "none"), "none");
    });
  });

  describe("the page", () => {
    it("is one document that brings its own style and script, loads nothing from anywhere, and holds nothing of the database and no key", async () => {
      const studio = await start();
      const page = await raw(studio.url);
      assert.equal(page.status, 200);
      assert.match(String(page.headers["content-type"]), /^text\/html; charset=utf-8$/);
      assert.equal(page.headers["cache-control"], "no-store");
      assert.equal(page.headers["x-content-type-options"], "nosniff");
      assert.equal(page.headers["x-frame-options"], "DENY");
      assert.equal(page.headers["referrer-policy"], "no-referrer");
      // The browser runs the one script the server wrote, and no other; the page asks its own server and no one else, and is in no frame.
      const policy = String(page.headers["content-security-policy"]);
      const nonce = /script-src 'nonce-([A-Za-z0-9+/=_-]+)'/.exec(policy)?.[1];
      assert.ok(nonce !== undefined && nonce.length >= 16, policy);
      // (`img-src`: the icon a browser asks its server for by itself, and nothing else: the page has no image.)
      assert.equal(policy, `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      assert.match(page.text, /^<!doctype html>/);
      assert.match(page.text, /<title>Local DB Studio<\/title>/);
      const scripts = [...page.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      assert.deepEqual(scripts.map((script) => script[1]), [` nonce="${nonce}"`]);
      assert.equal([...page.text.matchAll(/<style\b([^>]*)>/g)].map((style) => style[1]).join(), ` nonce="${nonce}"`);
      // It is JavaScript that a browser can read.
      assert.doesNotThrow(() => new Script(scripts[0]?.[2] as string, { filename: "studio-page.js" }));
      // Nothing is fetched from another place, and nothing runs but that script.
      // The addresses in it are the example in the API tab's empty URL field (D-046), which is text, and the name of SVG's
      // namespace, which the ER diagram's elements are made in (D-053): a name, which no browser loads.
      assert.deepEqual(page.text.match(/https?:\/\/[^\s"'<)]+/g) ?? [], ["http://127.0.0.1:3000/", "http://www.w3.org/2000/svg"]);
      assert.deepEqual(page.text.match(/\s(src|href|action)\s*=/g) ?? [], []);
      assert.deepEqual(page.text.match(/\son[a-z]+\s*=/g) ?? [], []);
      assert.equal(page.text.includes("javascript:"), false);
      // The page is the same for every database, and is given to whoever asks: no row, no path, no key.
      assert.equal(page.text.includes("user 01"), false);
      assert.equal(page.text.includes(studio.key), false);
      assert.equal(page.text.includes(canonicalDatabasePath(directory)), false);
      // A browser asks for an icon by itself.
      assert.deepEqual([(await raw(studio.url, { path: "/favicon.ico" })).status, (await raw(studio.url, { path: "/favicon.ico" })).text], [204, ""]);
      assert.equal((await raw(studio.url, { path: "/index.html" })).status, 404);
      assert.equal((await raw(studio.url, { method: "POST", body: "x" })).status, 405);
    });
  });

  describe("who is answered", () => {
    it("is whoever has the key of the session: without it nothing of the database is said, and nothing is done", async () => {
      const studio = await start();
      const before = await allFiles(directory);
      for (const key of [undefined, "", "0".repeat(48), studio.key.toUpperCase(), `${studio.key}0`, studio.key.slice(1)]) {
        for (const [path, body] of [["/api/status"], ["/api/access/info", {}], ["/api/access/browse", { request: { table: "users" } }], ["/api/access/delete", { request: { table: "users", key: { id: 25 } } }], ["/api/nowhere"]] as [string, unknown?][]) {
          const answer = await api(studio, path, body, key === undefined ? {} : { key });
          assert.deepEqual([answer.status, answer.json], [401, { error: { code: "UNAUTHORIZED", message: "The key of this Studio session is required: open the address that \"local-db-sandbox studio\" printed." } }], `${path} with ${String(key)}`);
          assert.equal(answer.text.includes(studio.key), false);
        }
      }
      // A key in the address is sent to servers, and is no key here.
      assert.equal((await raw(studio.url, { path: `/api/status?key=${studio.key}` })).status, 401);
      assert.deepEqual(await allFiles(directory), before);
      assert.equal((await api(studio, "/api/status")).status, 200);
    });

    it("is not a page of another site, and not whoever calls this machine by another name", async () => {
      const studio = await start();
      const authorized = { authorization: `Bearer ${studio.key}`, "content-type": "application/json" };
      const browse = JSON.stringify({ request: { table: "users", limit: 1 } });
      const here = `127.0.0.1:${studio.port}`;
      // The name a browser was told: only this machine's own, on this port.
      for (const host of ["evil.example", `evil.example:${studio.port}`, `127.0.0.1:${studio.port + 1}`, `127.0.0.1.evil.example:${studio.port}`, "127.0.0.1"]) {
        for (const [method, path, body] of [["GET", "/"], ["GET", "/api/status"], ["POST", "/api/access/browse", browse]] as [string, string, string?][]) {
          const answer = await raw(studio.url, { method, path, headers: { ...authorized, host }, ...(body !== undefined && { body }) });
          assert.deepEqual([answer.status, answer.json?.error?.code], [403, "UNAUTHORIZED"], `${method} ${path} as ${host}`);
        }
      }
      for (const host of [here, `localhost:${studio.port}`]) {
        assert.equal((await raw(studio.url, { path: "/api/status", headers: { ...authorized, host } })).status, 200, host);
        assert.equal((await raw(studio.url, { headers: { host } })).status, 200, host);
      }
      // The page a request comes from: only Studio's own.
      for (const origin of ["http://evil.example", `http://evil.example:${studio.port}`, `https://127.0.0.1:${studio.port}`, `http://127.0.0.1:${studio.port + 1}`, "null"]) {
        const answer = await raw(studio.url, { method: "POST", path: "/api/access/browse", headers: { ...authorized, host: here, origin }, body: browse });
        assert.deepEqual([answer.status, answer.json?.error?.code], [403, "UNAUTHORIZED"], origin);
      }
      for (const origin of [`http://127.0.0.1:${studio.port}`, `http://localhost:${studio.port}`]) {
        assert.equal((await raw(studio.url, { method: "POST", path: "/api/access/browse", headers: { ...authorized, host: here, origin }, body: browse })).status, 200, origin);
      }
      // No page of another site is told that it may ask, or read an answer.
      const preflight = await raw(studio.url, { method: "OPTIONS", path: "/api/access/sql", headers: { host: here, origin: "http://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
      assert.equal(preflight.status, 403);
      for (const answer of [preflight, await raw(studio.url), await api(studio, "/api/status"), await ask(studio, "info")]) {
        assert.deepEqual(Object.keys(answer.headers).filter((name) => name.startsWith("access-control-")), []);
      }
    });
  });

  describe("what it answers", () => {
    it("is how things are: the database, how Studio has it, and what the runtime says of itself", async () => {
      const studio = await start();
      const said = await api(studio, "/api/status");
      assert.equal(said.headers["cache-control"], "no-store");
      const { info, notices, ...rest } = said.json as StudioStatus;
      assert.deepEqual(rest, { database: canonicalDatabasePath(directory), format: "directory", mode: "standalone", connected: true });
      // A Studio that has a directory to itself says so, and how the database is handed over to a sandbox.
      assert.equal(notices.length, 1);
      assert.match(notices[0] as string, /^Studio has this database to itself\. .* stop Studio \(Ctrl\+C in its terminal\), start the sandbox, and start Studio again\./);
      assert.deepEqual([info?.kind, info?.pid, info?.format, info?.persistence, info?.readOnly, info?.tables, info?.limits], ["studio", process.pid, "directory", "json", undefined, 4, DEFAULT_ACCESS_LIMITS]);
      assert.deepEqual([studio.mode, studio.format, studio.database], ["standalone", "directory", canonicalDatabasePath(directory)]);
      assert.deepEqual(await studio.status(), said.json);
    });

    it("is the operations of the runtime's access, carried out by it: rows by page, one row, changes, and the console", async () => {
      const studio = await start();
      const { instance } = (await status(studio)).info ?? { instance: "" };
      const schema = await ask(studio, "schema");
      assert.deepEqual([schema.status, schema.json.result.tables.map((table: { name: string; rows: number }) => [table.name, table.rows])], [200, [["users", 25], ["orders", 2], ["memberships", 3], ["notes", 3]]]);
      assert.deepEqual(schema.json.result.tables[0].columns[1], { name: "name", type: "text", declaredType: "varchar(40)", canonicalType: "varchar(40)", nullable: false, primaryKey: false });
      // A page of rows, sorted and filtered as asked.
      const page = await ask(studio, "browse", { table: "users", limit: 3, offset: 1, orderBy: [{ column: "id", direction: "desc" }], filters: [{ column: "role", op: "eq", value: "reader" }] });
      assert.deepEqual([page.status, page.json.result.rows.map((row: unknown[]) => row[0]), page.json.result.total, page.json.result.limit, page.json.result.offset], [200, [24, 23, 22], 22, 3, 1]);
      assert.deepEqual((await ask(studio, "browse", { table: "users", filters: [{ column: "name", op: "contains", value: "r 2" }, { column: "score", op: "null" }] })).json.result.rows.map((row: unknown[]) => row[0]), [20, 25]);
      assert.equal((await ask(studio, "row", { table: "users", key: { id: 1 } })).json.result.row.name, "user 01");
      // Changes, each made for the owner the page has seen, and each in the database's files at once.
      assert.deepEqual((await ask(studio, "insert", { table: "users", values: { name: "Ada", settings: { theme: "light" } } }, instance)).json, { result: { affectedRows: 1, lastInsertId: 26 } });
      assert.deepEqual((await ask(studio, "update", { table: "users", key: { id: 26 }, values: { name: "Ada L.", active: false } }, instance)).json, { result: { affectedRows: 1 } });
      assert.deepEqual((await storedRows(directory, "users")).at(-1), { id: 26, name: "Ada L.", active: false, score: null, joined: null, settings: { theme: "light" }, role: "reader" });
      assert.deepEqual((await ask(studio, "delete", { table: "users", key: { id: 26 } }, instance)).json, { result: { affectedRows: 1 } });
      assert.equal((await storedRows(directory, "users")).length, 25);
      // The console: statements that read, and a request that changes, which is one transaction.
      const read = await ask(studio, "sql", { sql: "SELECT id, name FROM users WHERE id <= 2 ORDER BY id; SELECT COUNT(*) AS n FROM notes", mode: "read" });
      assert.deepEqual(read.json.result.results.map((each: { columns: string[]; rows: unknown[][] }) => [each.columns, each.rows]), [[["id", "name"], [[1, "user 01"], [2, "user 02"]]], [["n"], [[3]]]]);
      const written = await ask(studio, "sql", { sql: "UPDATE users SET score = 0 WHERE id > 20; DELETE FROM notes WHERE text IS NULL", mode: "write" }, instance);
      assert.deepEqual(written.json.result.results.map((each: { operation: string; affectedRows: number }) => [each.operation, each.affectedRows]), [["UPDATE", 5], ["DELETE", 1]]);
      assert.equal((await storedRows(directory, "notes")).length, 2);
      const failed = await ask(studio, "sql", { sql: "DELETE FROM notes; INSERT INTO users (name) VALUES ('user 01')", mode: "write" }, instance);
      assert.deepEqual([failed.status, failed.json.result.error.statement, failed.json.result.error.code, failed.json.result.rolledBack], [200, 2, "CONSTRAINT", true]);
      assert.equal((await storedRows(directory, "notes")).length, 2);
      assert.ok((await ask(studio, "events")).json.result.last > 0);
    });

    it("is a refusal as the access gives it, with a status for its kind, and the database as it was", async () => {
      const studio = await start();
      const before = await allFiles(directory);
      const refused = async (operation: string, request: unknown, expected: [number, string, RegExp]): Promise<void> => {
        const answer = await ask(studio, operation, request);
        assert.deepEqual([answer.status, answer.json?.error?.code], [expected[0], expected[1]], operation);
        assert.match(answer.json.error.message, expected[2]);
      };
      await refused("browse", { table: "nowhere" }, [404, "NOT_FOUND", /^There is no table "nowhere"\.$/]);
      await refused("insert", { table: "users", values: { name: "user 01" } }, [409, "CONSTRAINT", /UNIQUE constraint failed: users\.name/]);
      await refused("delete", { table: "users", key: { id: 1 } }, [409, "CONSTRAINT", /FOREIGN KEY constraint failed/]);
      await refused("update", { table: "users", key: { id: 99 }, values: { name: "x" } }, [404, "NOT_FOUND", /no row with id = 99/]);
      await refused("insert", { table: "users", values: { name: "Zed", joined: "soon" } }, [400, "INVALID_VALUE", /not a date-time/]);
      await refused("browse", { table: "users", limit: -1 }, [400, "INVALID_REQUEST", /"limit" must be a whole number/]);
      await refused("exec", { command: "whoami" }, [404, "NOT_FOUND", /^There is no operation "exec"\.$/]);
      await refused("close", {}, [404, "NOT_FOUND", /^There is no operation "close"\.$/]);
      assert.deepEqual([(await api(studio, "/api/access/insert", "{ not json")).status, (await api(studio, "/api/access/insert", "[1]")).status], [400, 400]);
      assert.equal((await raw(studio.url, { path: "/api/access/info", headers: { authorization: `Bearer ${studio.key}` } })).status, 405);
      assert.equal((await api(studio, "/api/elsewhere")).status, 404);
      const big = await ask(studio, "insert", { table: "notes", values: { text: "x".repeat(DEFAULT_ACCESS_LIMITS.maxRequestBytes) } });
      assert.deepEqual([big.status, big.json.error], [413, { code: "LIMIT_EXCEEDED", message: `A request may have ${DEFAULT_ACCESS_LIMITS.maxRequestBytes} bytes; this one has more.` }]);
      assert.deepEqual(await allFiles(directory), before);
    });

    it("is nothing of a change that was made for another owner than the one that is there", async () => {
      const studio = await start();
      const stale = await ask(studio, "delete", { table: "users", key: { id: 25 } }, "f".repeat(48));
      assert.deepEqual([stale.status, stale.json.error.code], [409, "OWNER_CHANGED"]);
      assert.match(stale.json.error.message, /^The database is open in another process than the one this was asked of\. Nothing was done\./);
      assert.equal((await ask(studio, "sql", { sql: "DELETE FROM notes", mode: "write" }, "f".repeat(48))).status, 409);
      assert.deepEqual([(await storedRows(directory, "users")).length, (await storedRows(directory, "notes")).length], [25, 3]);
    });
  });

  describe("on a single file", () => {
    it("shows the rows and runs statements that read, and refuses every change: the file is not touched", async () => {
      const bytes = await readFile(file);
      const studio = await start({ database: file });
      const said = await status(studio);
      assert.deepEqual([said.mode, said.format, said.connected, said.info?.readOnly], ["standalone", "file", true, SINGLE_FILE_READ_ONLY]);
      assert.equal((await ask(studio, "browse", { table: "users" })).json.result.total, 25);
      assert.deepEqual((await ask(studio, "sql", { sql: "SELECT COUNT(*) AS n FROM users", mode: "read" })).json.result.results[0].rows, [[25]]);
      for (const [operation, request] of [
        ["insert", { table: "notes", values: { text: "x" } }],
        ["update", { table: "users", key: { id: 1 }, values: { name: "x" } }],
        ["delete", { table: "users", key: { id: 25 } }],
        ["sql", { sql: "DELETE FROM notes", mode: "write" }],
      ] as [string, unknown][]) {
        const answer = await ask(studio, operation, request, said.info?.instance);
        assert.deepEqual([answer.status, answer.json.error], [403, { code: "READ_ONLY", message: SINGLE_FILE_READ_ONLY }], operation);
      }
      const sneaked = await ask(studio, "sql", { sql: "DELETE FROM notes", mode: "read" });
      assert.deepEqual([sneaked.status, sneaked.json.result.results, sneaked.json.result.error.code], [200, [], "READ_ONLY"]);
      await studio.stop();
      assert.deepEqual(await readFile(file), bytes);
    });
  });

  describe("attached to a process that has the database open", () => {
    it("shows what that process has, changes it there, and is told when the process is replaced by another", async () => {
      const first = await ownDatabase(directory, "nest");
      owners.push(first);
      const studio = await start();
      const said = await status(studio);
      assert.deepEqual([studio.mode, said.mode, said.connected, said.info?.kind, said.info?.pid, said.info?.instance], ["attached", "attached", true, "nest", first.pid, first.instance]);
      // Both ways: one runtime.
      assert.deepEqual((await ask(studio, "insert", { table: "notes", values: { text: "from Studio" } }, first.instance)).json, { result: { affectedRows: 1 } });
      assert.deepEqual(await first.sql("SELECT text FROM notes ORDER BY rowid DESC LIMIT 1"), [{ text: "from Studio" }]);
      await first.sql("UPDATE users SET name = 'from the application' WHERE id = 2");
      assert.equal((await ask(studio, "row", { table: "users", key: { id: 2 } })).json.result.row.name, "from the application");

      // The process is killed, as a watcher ends the sandbox it replaces.
      await first.kill();
      const away = await status(studio);
      assert.deepEqual([away.mode, away.connected, away.info], ["attached", false, undefined]);
      assert.match(away.disconnected ?? "", /^The process that had the database open is gone/);
      const unread = await ask(studio, "browse", { table: "users" });
      assert.deepEqual([unread.status, unread.json.error.code], [503, "OWNER_UNREACHABLE"]);
      const unsent = await ask(studio, "insert", { table: "notes", values: { text: "while it is away" } }, first.instance);
      assert.deepEqual([unsent.status, unsent.json.error.code], [503, "OWNER_UNREACHABLE"]);
      assert.match(unsent.json.error.message, /Nothing was sent, and nothing was done\.$/);

      // Another process has the database: Studio finds it, and shows what the first one saved.
      const second = await ownDatabase(directory, "nest");
      owners.push(second);
      const back = await status(studio);
      assert.deepEqual([back.connected, back.disconnected, back.info?.instance, back.info?.pid], [true, undefined, second.instance, second.pid]);
      assert.deepEqual((await ask(studio, "browse", { table: "notes" })).json.result.rows.at(-1), ["from Studio"]);
      // What the page asked for while it showed the first one's rows is not carried out by the second.
      const late = await ask(studio, "delete", { table: "users", key: { id: 25 } }, first.instance);
      assert.deepEqual([late.status, late.json.error.code], [409, "OWNER_CHANGED"]);
      assert.deepEqual(await second.sql("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM notes) AS notes"), [{ users: 25, notes: 4 }]);
      assert.deepEqual((await ask(studio, "delete", { table: "users", key: { id: 25 } }, second.instance)).json, { result: { affectedRows: 1 } });
      assert.deepEqual(await second.sql("SELECT COUNT(*) AS n FROM users"), [{ n: 24 }]);
    });
  });
});
