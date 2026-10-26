import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { probeOwnerControl } from "../../storage-json/src/index.ts";
import type { OwnerRecord } from "../../storage-json/src/index.ts";
import { ACCESS_OPERATIONS, ControlClient, WRITE_OPERATIONS, startControlServer } from "../src/index.ts";
import type { AccessLimits, ControlServer, RuntimeAccess } from "../src/index.ts";
import { refused } from "./support/assertions.ts";
import { IDENTITY, open } from "./support/fixture.ts";

/*
 * The control of a runtime (D-042): the process that has a database open
 * serves the access to its runtime on this machine, to whoever has its
 * token, and whoever else wants to look into the database, or change it,
 * asks there. These tests are about that door: who gets through it, what
 * goes through it, and what a client makes of an answer that does not come.
 */

const OTHER_INSTANCE = "f".repeat(48);

interface Listening {
  url: string;
  close(): Promise<void>;
}

/** Something that listens where an owner would, and does with a connection what it is told. */
async function listener(onConnection: (socket: Socket) => void): Promise<Listening> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        sockets.forEach((socket) => socket.destroy());
        server.close(() => resolve());
      }),
  };
}

/** An HTTP server that is no owner: it answers everything with the same thing. */
async function stranger(status: number, body: string): Promise<Listening> {
  const server = createHttpServer((request, response) => {
    request.resume();
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Whether a connection to that address and port is taken. */
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

/** One request of each kind: the ones that read, and the ones that change the database. */
function requests(client: RuntimeAccess): { reads: Record<string, () => Promise<unknown>>; writes: Record<string, () => Promise<unknown>> } {
  return {
    reads: {
      info: () => client.info(),
      schema: () => client.schema(),
      browse: () => client.browse({ table: "users" }),
      row: () => client.row({ table: "users", key: { id: 1 } }),
      "sql (read)": () => client.sql({ sql: "SELECT 1", mode: "read" }),
      events: () => client.events(),
    },
    writes: {
      insert: () => client.insert({ table: "notes", values: { text: "sent" } }),
      update: () => client.update({ table: "users", key: { id: 1 }, values: { name: "sent" } }),
      delete: () => client.delete({ table: "users", key: { id: 25 } }),
      "sql (write)": () => client.sql({ sql: "DELETE FROM notes", mode: "write" }),
    },
  };
}

describe("the control of a runtime", () => {
  const closing: { close(): Promise<void> }[] = [];
  afterEach(async () => {
    for (const each of closing.splice(0)) {
      await each.close();
    }
  });

  const serve = async (options: { readOnly?: string; limits?: Partial<AccessLimits> } = {}) => {
    const opened = await open(options);
    const server: ControlServer = await startControlServer({ access: opened.access });
    closing.push(server);
    const client = new ControlClient({ url: server.url, token: server.token, instance: IDENTITY.instance });
    return { ...opened, server, client };
  };
  /** `as`: what the request says of who sends it; the owner's token unless it is said otherwise, and nothing for `{}`. */
  const ask = (server: { url: string; token?: string }, method: string, path: string, body?: unknown, as: { authorization?: string } = { authorization: `Bearer ${server.token}` }): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      method,
      headers: { ...(as.authorization !== undefined && { authorization: as.authorization }), ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const answer = async (response: Response): Promise<[number, unknown]> => [response.status, await response.json()];

  describe("where it is served", () => {
    it("is this machine's own address and no other, on a port of its own, with a token no one can guess", async () => {
      const { server } = await serve();
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(server.token, /^[0-9a-f]{48}$/);
      const port = Number(new URL(server.url).port);
      assert.equal(await reaches("127.0.0.1", port), true);
      // The addresses this machine has on its networks do not lead to it.
      const addresses = Object.values(networkInterfaces())
        .flat()
        .filter((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4")
        .map((entry) => entry?.address as string);
      for (const address of addresses) {
        assert.equal(await reaches(address, port), false, `the control answers at ${address}`);
      }
      // Another runtime is served somewhere else, with another token.
      const other = await serve();
      assert.notEqual(other.server.url, server.url);
      assert.notEqual(other.server.token, server.token);
    });

    it("is closed when it is told to, and that can be said twice", async () => {
      const { server, client } = await serve();
      await client.info();
      await server.close();
      await server.close();
      await refused(client.info(), "OWNER_UNREACHABLE");
    });
  });

  describe("who is answered", () => {
    it("is whoever has the owner's token, and no one else: nothing is carried out, and nothing is said", async () => {
      const { server, storage, events } = await serve();
      const without = [undefined, "", "Bearer", `Bearer ${"0".repeat(48)}`, `Basic ${server.token}`, server.token, `Bearer ${server.token.toUpperCase()}`, `Bearer ${server.token}0`, `Bearer ${server.token.slice(0, 47)}`];
      const attempts: [string, string, unknown?][] = [
        ["GET", "/health"],
        ["POST", "/access/info", {}],
        ["POST", "/access/browse", { request: { table: "users" } }],
        ["POST", "/access/delete", { request: { table: "users", key: { id: 25 } } }],
        ["POST", "/access/sql", { request: { sql: "DELETE FROM notes", mode: "write" } }],
        ["GET", "/nowhere"],
      ];
      const before = events.length;
      for (const authorization of without) {
        for (const [method, path, body] of attempts) {
          const response = await ask(server, method, path, body, authorization === undefined ? {} : { authorization });
          const text = await response.text();
          assert.equal(response.status, 401, `${method} ${path} with ${String(authorization)}`);
          assert.deepEqual(JSON.parse(text), { error: { code: "UNAUTHORIZED", message: "The token of the database's owner is required." } });
          assert.equal(text.includes(server.token), false);
        }
      }
      // A token in the address is no token.
      assert.equal((await fetch(`${server.url}/health?token=${server.token}`)).status, 401);
      assert.equal((await fetch(`${server.url}/access/info?authorization=Bearer%20${server.token}`, { method: "POST" })).status, 401);
      assert.equal(storage.saved.length, 0);
      assert.equal(events.length, before);
      // With it, the same requests are answered.
      assert.equal((await ask(server, "GET", "/health")).status, 200);
      assert.equal((await ask(server, "POST", "/access/delete", { request: { table: "users", key: { id: 25 } } })).status, 200);
      assert.equal(storage.rows("users").length, 24);
    });

    it("says which owner answers, as whoever looks for a database's owner asks it", async () => {
      const { server } = await serve();
      const response = await ask(server, "GET", "/health");
      assert.deepEqual(await answer(response), [200, { protocol: 1, instance: IDENTITY.instance }]);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
      // No page of another site is told that it may read an answer.
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      // The way the storage asks an owner whether it is there (`probeOwnerControl`) is answered by this.
      const record: OwnerRecord = { version: 1, pid: process.pid, startedAt: new Date().toISOString(), instance: IDENTITY.instance, kind: "postgrest", database: IDENTITY.database, control: { url: server.url, token: server.token } };
      assert.equal(await probeOwnerControl(record), "alive");
      assert.equal(await probeOwnerControl({ ...record, instance: OTHER_INSTANCE }), "other");
      assert.equal(await probeOwnerControl({ ...record, control: { url: server.url, token: "0".repeat(48) } }), "other");
      await server.close();
      assert.equal(await probeOwnerControl(record), "gone");
    });
  });

  describe("what goes through it", () => {
    it("is every operation of the access, carried out as the access itself carries it out", async () => {
      const { client, access, storage } = await serve();
      assert.deepEqual([...ACCESS_OPERATIONS], ["info", "schema", "browse", "row", "insert", "update", "delete", "sql", "events"]);
      assert.deepEqual([...WRITE_OPERATIONS], ["insert", "update", "delete"]);
      assert.deepEqual(await client.info(), await access.info());
      assert.deepEqual(await client.schema(), await access.schema());
      const page = { table: "users", limit: 3, offset: 1, orderBy: [{ column: "id", direction: "desc" as const }], filters: [{ column: "role", op: "eq" as const, value: "reader" }] };
      assert.deepEqual(await client.browse(page), await access.browse(page));
      assert.deepEqual((await client.browse(page)).rows.map((row) => row[0]), [24, 23, 22]);
      assert.deepEqual(await client.row({ table: "users", key: { id: 1 } }), await access.row({ table: "users", key: { id: 1 } }));
      assert.deepEqual(await client.insert({ table: "users", values: { name: "Ada", settings: { a: [1, null] }, joined: "2026-05-06T07:08:09.000Z" } }), { affectedRows: 1, lastInsertId: 26 });
      assert.deepEqual(await client.update({ table: "users", key: { id: 26 }, values: { name: "Ada L.", score: null } }), { affectedRows: 1 });
      assert.deepEqual(storage.rows("users").at(-1), { id: 26, name: "Ada L.", active: true, score: null, joined: "2026-05-06T07:08:09.000Z", settings: { a: [1, null] }, role: "reader" });
      assert.deepEqual(await client.delete({ table: "users", key: { id: 26 } }), { affectedRows: 1 });
      assert.equal(storage.rows("users").length, 25);
      const read = await client.sql({ sql: "SELECT id, name FROM users WHERE id < 3 ORDER BY id", mode: "read", maxRows: 1 });
      assert.deepEqual(read.results.map((each) => [each.operation, each.columns, each.rows, each.truncated]), [["SELECT", ["id", "name"], [[1, "user 01"]], true]]);
      const written = await client.sql({ sql: "UPDATE notes SET text = 'x' WHERE text IS NULL; SELECT COUNT(*) AS n FROM notes WHERE text = 'x'", mode: "write" });
      assert.deepEqual([written.results.map((each) => [each.operation, each.affectedRows, each.rows]), written.error], [[["UPDATE", 1, []], ["SELECT", 0, [[1]]]], undefined]);
      assert.equal(storage.rows("notes").at(-1)?.text, "x");
      const failed = await client.sql({ sql: "DELETE FROM notes; INSERT INTO users (name) VALUES ('user 01')", mode: "write" });
      assert.deepEqual([failed.results.length, failed.error?.statement, failed.error?.code, failed.rolledBack], [1, 2, "CONSTRAINT", true]);
      assert.equal(storage.rows("notes").length, 3);
      const { events, last } = await client.events();
      assert.deepEqual([events, last], [(await access.events()).events, (await access.events()).last]);
      assert.ok(last > 10 && events.every((event) => event.requestId === "studio"));
      assert.deepEqual(await client.events({ after: last }), { events: [], last });
    });

    it("is a refusal of the access as the access gives it: its code, its words, and a status for its kind", async () => {
      const { client, server, runtime } = await serve();
      await refused(client.browse({ table: "nowhere" }), "NOT_FOUND", /^There is no table "nowhere"\.$/);
      await refused(client.insert({ table: "users", values: { name: "user 01" } }), "CONSTRAINT", /UNIQUE constraint failed: users\.name/);
      await refused(client.insert({ table: "users", values: { name: "Zed", joined: "soon" } }), "INVALID_VALUE", /"joined" holds "soon", which is not a date-time/);
      await refused(client.browse({ table: "users", limit: -1 }), "INVALID_REQUEST", /"limit" must be a whole number, 0 or more/);
      await refused(client.sql({ sql: "SELECT 1", mode: "both" as "read" }), "INVALID_REQUEST", /"mode" must be "read" or "write"/);
      assert.deepEqual(await answer(await ask(server, "POST", "/access/browse", { request: { table: "nowhere" } })), [404, { error: { code: "NOT_FOUND", message: 'There is no table "nowhere".' } }]);
      assert.equal((await ask(server, "POST", "/access/insert", { request: { table: "users", values: { name: "user 01" } } })).status, 409);
      assert.equal((await ask(server, "POST", "/access/browse", { request: { table: "users", limit: -1 } })).status, 400);
      // While the application has a transaction open, nothing of another's goes into it.
      runtime.begin();
      await refused(client.browse({ table: "users" }), "BUSY", /^The application has a transaction open on the runtime\. Nothing was done; try again\.$/);
      assert.equal((await ask(server, "POST", "/access/insert", { request: { table: "notes", values: { text: "x" } } })).status, 409);
      runtime.rollback();
      assert.equal((await client.browse({ table: "users" })).total, 25);
      // Where nothing may be changed, a change is refused there, with the reason.
      const fixed = await serve({ readOnly: "Studio was started with --read-only." });
      await refused(fixed.client.delete({ table: "users", key: { id: 25 } }), "READ_ONLY", /^Studio was started with --read-only\.$/);
      assert.equal((await ask(fixed.server, "POST", "/access/sql", { request: { sql: "DELETE FROM notes", mode: "write" } })).status, 403);
      assert.equal(fixed.storage.saved.length, 0);
    });

    it("is the operations of an access and nothing else: there is no other door", async () => {
      const { server, storage, events } = await serve();
      const before = events.length;
      const notThere: [string, string][] = [
        ["POST", "/access/exec"],
        ["POST", "/access/close"],
        ["POST", "/access/constructor"],
        ["POST", "/access/__proto__"],
        ["POST", "/access/toString"],
        ["POST", "/access/"],
        ["POST", "/access"],
        ["POST", "/access/info/more"],
        ["POST", "/access/INFO"],
        ["POST", "/"],
        ["GET", "/"],
        ["POST", "/shell"],
        ["GET", "/health/more"],
      ];
      for (const [method, path] of notThere) {
        const [status, body] = await answer(await ask(server, method, path, method === "POST" ? { request: { command: "whoami" } } : undefined));
        assert.deepEqual([status, (body as { error: { code: string } }).error.code], [404, "NOT_FOUND"], `${method} ${path}`);
      }
      const notThatWay: [string, string][] = [
        ["GET", "/access/info"],
        ["PUT", "/access/insert"],
        ["DELETE", "/access/delete"],
        ["PATCH", "/access/update"],
        ["POST", "/health"],
        ["DELETE", "/health"],
      ];
      for (const [method, path] of notThatWay) {
        const response = await ask(server, method, path);
        assert.deepEqual([response.status, ((await response.json()) as { error: { code: string } }).error.code], [405, "INVALID_REQUEST"], `${method} ${path}`);
      }
      assert.equal(storage.saved.length, 0);
      assert.equal(events.length, before);
    });

    it("is not a request that cannot be read", async () => {
      const { server, storage } = await serve();
      const unreadable = async (body: string, message: RegExp): Promise<void> => {
        const [status, said] = await answer(await ask(server, "POST", "/access/insert", body));
        assert.equal(status, 400, body);
        assert.equal((said as { error: { code: string } }).error.code, "INVALID_REQUEST", body);
        assert.match((said as { error: { message: string } }).error.message, message, body);
      };
      await unreadable("{ not json", /^The request is not JSON\.$/);
      await unreadable("[1]", /^A request is an object: \{ "for": the owner it is made for, "request": what is asked \}\.$/);
      await unreadable('"insert"', /^A request is an object/);
      await unreadable("null", /^A request is an object/);
      await unreadable(JSON.stringify({ for: 7, request: { table: "notes", values: {} } }), /^"for" must be the name of an owner\.$/);
      assert.equal(storage.saved.length, 0);
      // What is asked is read by the access, which says what it misses.
      assert.deepEqual(await answer(await ask(server, "POST", "/access/insert", "{}")), [404, { error: { code: "NOT_FOUND", message: "There is no table undefined." } }]);
      assert.deepEqual(await answer(await ask(server, "POST", "/access/insert")), [404, { error: { code: "NOT_FOUND", message: "There is no table undefined." } }]);
      assert.equal((await ask(server, "POST", "/access/info")).status, 200);
    });

    it("is nothing of a request that was made for another owner", async () => {
      const { server, storage, client } = await serve();
      const gone = { table: "users", key: { id: 25 } };
      const [status, said] = await answer(await ask(server, "POST", "/access/delete", { for: OTHER_INSTANCE, request: gone }));
      assert.deepEqual([status, (said as { error: { code: string } }).error.code], [409, "OWNER_CHANGED"]);
      assert.match((said as { error: { message: string } }).error.message, /^The database is open in another process than the one this was asked of\. Nothing was done\./);
      // A client says whom it asks, each time: one that was made for another owner gets nothing done here.
      const other = new ControlClient({ url: server.url, token: server.token, instance: OTHER_INSTANCE });
      for (const [name, send] of Object.entries({ ...requests(other).reads, ...requests(other).writes })) {
        await refused(send(), "OWNER_CHANGED", /Nothing was done/).catch((error: unknown) => assert.fail(`${name}: ${String(error)}`));
      }
      // And so does whoever asks through a client for an owner it has seen before.
      await refused(client.delete(gone, { owner: OTHER_INSTANCE }), "OWNER_CHANGED");
      await refused(client.sql({ sql: "DELETE FROM notes", mode: "write" }, { owner: OTHER_INSTANCE }), "OWNER_CHANGED");
      await refused(client.browse({ table: "users" }, { owner: OTHER_INSTANCE }), "OWNER_CHANGED");
      assert.equal(storage.saved.length, 0);
      // Made for this one, it is carried out.
      assert.deepEqual(await client.delete(gone, { owner: IDENTITY.instance }), { affectedRows: 1 });
      assert.equal((await ask(server, "POST", "/access/insert", { for: IDENTITY.instance, request: { table: "notes", values: { text: "for this one" } } })).status, 200);
      assert.equal(storage.saved.length, 2);
    });
  });

  describe("how much goes through it", () => {
    it("is no more of a request than a request may have", async () => {
      const { server, storage, client } = await serve({ limits: { maxRequestBytes: 2_000 } });
      const insert = (length: number) => ({ request: { table: "notes", values: { text: "x".repeat(length) } } });
      assert.deepEqual(await answer(await ask(server, "POST", "/access/insert", insert(5_000))), [413, { error: { code: "LIMIT_EXCEEDED", message: "A request may have 2000 bytes; this one has more." } }]);
      // Also when it does not say how long it is.
      const unannounced = await fetch(`${server.url}/access/insert`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}` },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(insert(5_000))));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
      assert.deepEqual([unannounced.status, ((await unannounced.json()) as { error: { code: string } }).error.code], [413, "LIMIT_EXCEEDED"]);
      assert.equal(storage.saved.length, 0);
      await refused(client.insert(insert(5_000).request), "LIMIT_EXCEEDED", /^A request may have 2000 bytes; this one has more\.$/);
      assert.equal(storage.saved.length, 0);
      // One that fits is carried out.
      assert.deepEqual(await client.insert(insert(1_000).request), { affectedRows: 1 });
      assert.equal(storage.saved.length, 1);
    });

    it("is no more of an answer than an answer may have: whoever asks is told, and nothing was changed for it", async () => {
      const sized = await open();
      const page = Buffer.byteLength(JSON.stringify(await sized.access.browse({ table: "users" })));
      const [all] = (await sized.access.sql({ sql: "SELECT * FROM users", mode: "read" })).results;
      // Less than a page of every user has, and less than a statement that returns them all.
      const most = Math.min(page, Buffer.byteLength(JSON.stringify(all))) - 1;
      const { client, storage, server } = await serve({ limits: { maxResponseBytes: most } });
      const tooMuch = await refused(client.browse({ table: "users" }), "LIMIT_EXCEEDED");
      assert.equal(tooMuch.message, `A page of 25 rows of "users" has ${page} bytes, and an answer may have ${most}. Ask for fewer rows.`);
      assert.equal((await ask(server, "POST", "/access/browse", { request: { table: "users" } })).status, 413);
      assert.equal((await client.browse({ table: "users", limit: 10 })).rows.length, 10);
      // A request to the console that returns more than that is taken back before it is committed.
      const written = await client.sql({ sql: "DELETE FROM notes; SELECT * FROM users; DELETE FROM memberships", mode: "write" });
      assert.deepEqual([written.results.map((each) => each.operation), written.error?.statement, written.error?.code, written.rolledBack], [["DELETE"], 2, "LIMIT_EXCEEDED", true]);
      assert.match(written.error?.message ?? "", /^The results of this request have more than \d+ bytes, which is what an answer may have\. Ask for fewer rows\.$/);
      assert.equal(storage.saved.length, 0);
      assert.equal((await client.browse({ table: "notes" })).total, 3);
      const read = await client.sql({ sql: "SELECT 1 AS one; SELECT * FROM users; SELECT 2", mode: "read" });
      assert.deepEqual([read.results.map((each) => each.rows), read.error?.statement, read.error?.code, read.rolledBack], [[[[1]]], 2, "LIMIT_EXCEEDED", undefined]);
    });

    it("is no answer at all when what would be answered is larger than that, whatever it is", async () => {
      const sized = await open();
      const schema = Buffer.byteLength(JSON.stringify({ result: await sized.access.schema() }));
      const fits = await serve({ limits: { maxResponseBytes: schema } });
      assert.equal((await fits.client.schema()).tables.length, 4);
      const { client, server } = await serve({ limits: { maxResponseBytes: schema - 1 } });
      assert.deepEqual(await answer(await ask(server, "POST", "/access/schema")), [413, { error: { code: "LIMIT_EXCEEDED", message: `The answer has ${schema} bytes, and an answer may have ${schema - 1}.` } }]);
      await refused(client.schema(), "LIMIT_EXCEEDED");
    });
  });

  describe("what a client makes of an owner that does not answer", () => {
    const client = (url: string, options: { timeoutMs?: number; maxResponseBytes?: number } = {}): ControlClient => new ControlClient({ url, token: "t".repeat(48), instance: IDENTITY.instance }, options);

    it("is that the owner cannot be reached, when nothing listens there: nothing was sent, so nothing was done", async () => {
      const nowhere = await listener(() => undefined);
      await nowhere.close();
      const { reads, writes } = requests(client(nowhere.url));
      for (const [name, send] of Object.entries({ ...reads, ...writes })) {
        const error = await refused(send(), "OWNER_UNREACHABLE", /^The process that has the database open does not answer \(http:\/\/127\.0\.0\.1:\d+\): nothing listens there\. Nothing was sent, and nothing was done\.$/);
        assert.equal(error.message.includes("t".repeat(48)), false, name);
      }
    });

    it("is that the outcome is not known, when a change was sent and no answer came", async () => {
      const received: string[] = [];
      // Takes what is sent, and ends the connection without a word.
      const silent = await listener((socket) => socket.once("data", (chunk) => (received.push(String(chunk)), socket.destroy())));
      closing.push(silent);
      const { reads, writes } = requests(client(silent.url));
      for (const [name, send] of Object.entries(writes)) {
        const error = await refused(send(), "OUTCOME_UNKNOWN", /^The change was sent to the process that has the database open, and no answer came: whether it was carried out is not known\. Look at the data before doing it again\.$/);
        assert.equal(error.message.includes("t".repeat(48)), false, name);
      }
      // Each was sent once, and not again.
      assert.equal(received.length, 4);
      // A request that changes nothing can be asked again, so it is only said that the owner is not there.
      for (const send of Object.values(reads)) {
        await refused(send(), "OWNER_UNREACHABLE", /^The process that has the database open does not answer \(http:\/\/127\.0\.0\.1:\d+\): the connection ended before an answer came\.$/);
      }
      assert.equal(received.length, 10);
    });

    it("is the same when an answer is begun and not finished, and when none comes in time", async () => {
      const half = await listener((socket) =>
        socket.once("data", () => {
          socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 400\r\n\r\n{"result":{"affectedRows"');
          setTimeout(() => socket.destroy(), 20);
        }),
      );
      closing.push(half);
      await refused(requests(client(half.url)).writes.insert?.() as Promise<unknown>, "OUTCOME_UNKNOWN");
      await refused(requests(client(half.url)).reads.browse?.() as Promise<unknown>, "OWNER_UNREACHABLE");

      const mute = await listener(() => undefined);
      closing.push(mute);
      const startedAt = Date.now();
      await refused(requests(client(mute.url, { timeoutMs: 150 })).writes.delete?.() as Promise<unknown>, "OUTCOME_UNKNOWN");
      await refused(requests(client(mute.url, { timeoutMs: 150 })).reads.schema?.() as Promise<unknown>, "OWNER_UNREACHABLE", /no answer came in 150 ms\.$/);
      assert.ok(Date.now() - startedAt < 5_000);
    });

    it("is that another has taken its place, when what answers there is not the owner", async () => {
      for (const [status, body] of [
        [200, "hello"],
        [200, '{"unrelated":true}'],
        [200, '{"result":'],
        [404, "<html>Not found</html>"],
        [500, '{"error":"no"}'],
        [200, '{"error":{"code":"MADE_UP","message":"x"}}'],
      ] as const) {
        const other = await stranger(status, body);
        closing.push(other);
        const { reads, writes } = requests(client(other.url));
        // Nothing of the owner's was changed by it, whatever was asked.
        for (const send of [...Object.values(reads), ...Object.values(writes)]) {
          await refused(send(), "OWNER_CHANGED", /^What answers at http:\/\/127\.0\.0\.1:\d+ is not the process that had the database open\.$/);
        }
      }
      // Another owner of a database, in its place: it knows another token.
      const real = await serve();
      await refused(client(real.server.url).info(), "UNAUTHORIZED", /^The token of the database's owner is required\.$/);
      await refused(client(real.server.url).delete({ table: "users", key: { id: 25 } }), "UNAUTHORIZED");
      assert.equal(real.storage.saved.length, 0);
    });

    it("reads no more of an answer than an answer may have", async () => {
      const flood = await stranger(200, JSON.stringify({ result: { text: "x".repeat(20_000) } }));
      closing.push(flood);
      await refused(requests(client(flood.url, { maxResponseBytes: 5_000 })).reads.info?.() as Promise<unknown>, "LIMIT_EXCEEDED", /^The answer from http:\/\/127\.0\.0\.1:\d+ has more than 5000 bytes, which is what an answer may have\.$/);
      await refused(requests(client(flood.url, { maxResponseBytes: 5_000 })).writes.insert?.() as Promise<unknown>, "OUTCOME_UNKNOWN");
      assert.deepEqual(await client(flood.url, { maxResponseBytes: 50_000 }).info(), { text: "x".repeat(20_000) });
    });

    it("sends nothing to an address that is not this machine's own", async () => {
      for (const url of ["http://192.168.1.20:4000", "http://example.com", "https://127.0.0.1:4000", "http://127.0.0.1:4000/path", "http://127.0.0.1.example.com:4000", "http://localhost:4000", "http://[::1]:4000", "http://127.0.0.1", "file:///etc/passwd", ""]) {
        assert.throws(
          () => client(url),
          (error: unknown) => {
            assert.equal((error as { code?: string }).code, "OWNER_UNREACHABLE", url);
            assert.match((error as Error).message, /^The owner's record names an address that is not this machine's own .*nothing is sent there\.$/, url);
            return true;
          },
        );
      }
      assert.doesNotThrow(() => client("http://127.0.0.1:4000"));
    });
  });

  it("does not keep the process that serves it running: the owner's own work does that", async () => {
    // A process that serves a runtime and does nothing else ends by itself.
    const child = spawn(process.execPath, [join(import.meta.dirname, "support", "serve-only.ts")], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 30_000);
      child.once("exit", (exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
    assert.equal(code, 0, `the process did not end by itself:\n${output}${errors}`);
    assert.match(output, /^http:\/\/127\.0\.0\.1:\d+\r?\n$/);
  });
});
