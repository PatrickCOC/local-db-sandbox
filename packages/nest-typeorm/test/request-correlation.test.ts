import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import { SqliteRuntime, formatSqlEvent } from "../../runtime/src/index.ts";
import type { SqlEvent, TableSchema } from "../../runtime/src/index.ts";
import { createRequestCorrelation, formatSandboxRequestEvent } from "../src/index.ts";
import type { SandboxRequestEvent } from "../src/index.ts";

const SCHEMA: TableSchema[] = [
  {
    name: "notes",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "text", type: "text", nullable: false, primary: false },
    ],
  },
  {
    name: "authors",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "name", type: "text", nullable: false, primary: false },
    ],
  },
];

/*
 * A plain Node HTTP server whose handler does asynchronous work between SQL
 * statements, as an application's request handling does. The sandbox attaches
 * to it from outside, the way it attaches to a NestJS application's server.
 *
 *   /notes?text=...   two separate SELECTs around an INSERT
 *   /transaction?...  BEGIN, INSERT, then COMMIT (or ROLLBACK for text=bad)
 */
describe("request correlation", () => {
  let server: Server;
  let url: string;
  let runtime: SqliteRuntime;
  let sql: SqlEvent[];
  let requests: SandboxRequestEvent[];

  const of = (id: string): SqlEvent[] => sql.filter((event) => event.requestId === id);

  before(async () => {
    const correlation = createRequestCorrelation({ onRequest: (event) => requests.push(event) });
    runtime = await SqliteRuntime.open({ schema: SCHEMA, context: correlation.sqlContext });
    runtime.subscribe((event) => {
      correlation.record(event);
      sql.push(event);
    });
    runtime.execute("INSERT INTO authors (name) VALUES ('Ada')");

    server = createServer((request, response) => {
      void (async () => {
        const { pathname, searchParams } = new URL(request.url ?? "/", "http://localhost");
        const text = searchParams.get("text") ?? "";
        if (pathname === "/transaction") {
          runtime.execute("BEGIN");
          runtime.execute("INSERT INTO notes (text) VALUES (?)", [text]);
          runtime.execute(text === "bad" ? "ROLLBACK" : "COMMIT");
        } else {
          runtime.execute("SELECT id, name FROM authors WHERE id = ?", [1]);
          await delay(text === "slow" ? 60 : 5);
          runtime.execute("INSERT INTO notes (text) VALUES (?)", [text]);
          await delay(5);
          runtime.execute("SELECT COUNT(*) AS n FROM notes");
        }
        response.statusCode = text === "bad" ? 400 : 200;
        response.end("{}");
      })();
    });
    correlation.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    sql = [];
    requests = [];
  });

  it("numbers every statement of a request, under the request's ID", async () => {
    const response = await fetch(`${url}/notes?text=one`, { headers: { "x-request-id": "client-1" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), null);

    // The two SELECTs are two entries; nothing is merged.
    assert.deepEqual(sql.map((event) => [event.requestId, event.sequence, event.operation, event.tables]), [
      ["client-1", 1, "SELECT", ["authors"]],
      ["client-1", 2, "INSERT", ["notes"]],
      ["client-1", 3, "SELECT", ["notes"]],
    ]);
    assert.deepEqual(sql.map((event) => formatSqlEvent({ ...event, localExecutionMs: 0 })), [
      "[client-1 #1] 0.0ms SELECT authors rows=1",
      "[client-1 #2] 0.0ms INSERT notes rows=1",
      "[client-1 #3] 0.0ms SELECT notes rows=1",
    ]);
    assert.deepEqual(sql[0]?.resultPreview, [{ id: 1, name: "Ada" }]);
  });

  it("reports the request with a sqlCount equal to the number of its SQL events", async () => {
    await fetch(`${url}/notes?text=a`, { headers: { "x-request-id": "count-a" } });
    await fetch(`${url}/transaction?text=b`, { headers: { "x-request-id": "count-b" } });

    for (const request of requests) {
      const events = of(request.requestId);
      assert.equal(request.sqlCount, events.length);
      assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
      assert.equal(request.sqlExecutionMs, events.reduce((sum, event) => sum + event.localExecutionMs, 0));
      assert.ok(request.totalMs >= request.sqlExecutionMs);
    }
    assert.deepEqual(requests.map((request) => [request.requestId, request.method, request.path, request.status, request.sqlCount]), [
      ["count-a", "GET", "/notes?text=a", 200, 3],
      ["count-b", "GET", "/transaction?text=b", 200, 3],
    ]);
  });

  it("includes the transaction statements of a request", async () => {
    await fetch(`${url}/transaction?text=kept`, { headers: { "x-request-id": "commit" } });
    await fetch(`${url}/transaction?text=bad`, { headers: { "x-request-id": "rollback" } });
    assert.deepEqual(of("commit").map((event) => [event.sequence, event.transaction ?? event.operation]), [[1, "BEGIN"], [2, "INSERT"], [3, "COMMIT"]]);
    assert.deepEqual(of("rollback").map((event) => [event.sequence, event.transaction ?? event.operation]), [[1, "BEGIN"], [2, "INSERT"], [3, "ROLLBACK"]]);
    assert.deepEqual(requests.map((request) => [request.requestId, request.status, request.sqlCount]), [["commit", 200, 3], ["rollback", 400, 3]]);
  });

  it("makes up an ID when the client sends none, different for each request", async () => {
    await fetch(`${url}/notes?text=a`);
    await fetch(`${url}/notes?text=b`, { headers: { "x-request-id": "background" } });
    const ids = requests.map((event) => event.requestId);
    assert.match(ids[0] ?? "", /^[0-9a-f]{8}$/);
    // A client cannot claim the ID that marks SQL outside any request.
    assert.match(ids[1] ?? "", /^[0-9a-f]{8}$/);
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(sql.map((event) => [event.requestId, event.sequence]), [[ids[0], 1], [ids[0], 2], [ids[0], 3], [ids[1], 1], [ids[1], 2], [ids[1], 3]]);
  });

  it("keeps overlapping requests apart, each with its own numbering", async () => {
    // "slow" is still waiting between its statements while "fast" runs all of its own.
    const slow = fetch(`${url}/notes?text=slow`, { headers: { "x-request-id": "slow" } });
    await delay(20);
    await fetch(`${url}/notes?text=quick`, { headers: { "x-request-id": "fast" } });
    await slow;

    const order = sql.map((event) => event.requestId);
    assert.ok(order.indexOf("fast") > order.indexOf("slow") && order.indexOf("fast") < order.lastIndexOf("slow"), order.join(","));
    assert.deepEqual(of("slow").map((event) => [event.sequence, event.operation, event.parameters]), [[1, "SELECT", [1]], [2, "INSERT", ["slow"]], [3, "SELECT", []]]);
    assert.deepEqual(of("fast").map((event) => [event.sequence, event.operation, event.parameters]), [[1, "SELECT", [1]], [2, "INSERT", ["quick"]], [3, "SELECT", []]]);
    assert.deepEqual(requests.map((event) => [event.requestId, event.sqlCount]).sort(), [["fast", 3], ["slow", 3]]);
  });

  it("reports SQL outside any request as background, with its own numbering", () => {
    runtime.execute("SELECT 1 AS one");
    runtime.execute("DELETE FROM notes WHERE id < 0");
    assert.deepEqual(sql.map((event) => event.requestId), ["background", "background"]);
    assert.equal((sql[1]?.sequence ?? 0) - (sql[0]?.sequence ?? 0), 1);
    assert.match(formatSqlEvent(sql[0] as SqlEvent), /^\[background #\d+\] \d+\.\dms SELECT rows=1$/);
  });

  it("formats a request line that names the ID and the count its SQL entries add up to", () => {
    assert.equal(
      formatSandboxRequestEvent({ requestId: "ab12", method: "POST", path: "/api/users", status: 201, totalMs: 12.34, sqlCount: 3, sqlExecutionMs: 1.26 }),
      "[ab12] POST /api/users 201 sqlCount=3 sqlTime=1.3ms total=12.3ms",
    );
  });
});
