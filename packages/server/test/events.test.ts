import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Database } from "../../core/src/index.ts";
import type { DatabaseState, StorageAdapter } from "../../core/src/index.ts";
import { SandboxServer, formatOperationEvent, formatRequestEvent } from "../src/index.ts";
import type { RequestEvent, SimulationConfig } from "../src/index.ts";

const DELAY_MS = 120;
// Timers may fire a few milliseconds early.
const DELAYED = DELAY_MS - 10;

describe("request events", () => {
  let server: SandboxServer | undefined;
  let baseUrl: string;
  let events: RequestEvent[];

  async function start(simulation?: SimulationConfig, saveDelayMs = 0): Promise<void> {
    let state: DatabaseState = {
      meta: { version: 1 },
      collections: {
        users: [
          { id: 1, name: "Patrick", active: true },
          { id: 2, name: "Alex", active: false },
        ],
        orders: [{ id: 1, total: 5 }],
      },
    };
    const storage: StorageAdapter = {
      load: async () => structuredClone(state),
      save: async (next) => {
        await new Promise((resolve) => setTimeout(resolve, saveDelayMs));
        state = structuredClone(next);
      },
    };
    events = [];
    server = new SandboxServer({
      database: await Database.open(storage),
      port: 0,
      simulation,
      onRequest: (event) => events.push(event),
    });
    baseUrl = (await server.start()).url;
  }

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  async function call(method: string, path: string, body?: unknown): Promise<RequestEvent> {
    const before = events.length;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    await response.text();
    assert.equal(events.length, before + 1, "one event per request");
    const event = events[before] as RequestEvent;
    assert.equal(event.status, response.status);
    return event;
  }

  describe("normal requests", () => {
    it("describes a list request from HTTP to local operation", async () => {
      await start();
      const before = Date.now();
      const event = await call("GET", "/users?active=true&_sort=-name&_limit=5");

      assert.equal(event.method, "GET");
      assert.equal(event.path, "/users?active=true&_sort=-name&_limit=5");
      assert.equal(event.status, 200);
      assert.equal(event.rows, 1);
      assert.equal(event.errorCode, undefined);
      assert.deepEqual(event.simulated, []);
      assert.equal(event.simulatedDelayMs, 0);
      assert.ok(event.timestamp >= before && event.timestamp <= Date.now());

      assert.equal(event.operations.length, 1);
      const [operation] = event.operations;
      assert.equal(operation?.operation, "SELECT");
      assert.equal(operation?.collection, "users");
      assert.equal(operation?.rows, 1);
      assert.equal(operation?.statement, "SELECT * FROM users WHERE active = 'true' ORDER BY name DESC LIMIT 5");

      assert.equal(event.localExecutionMs, operation?.localExecutionMs);
      assert.ok((event.localExecutionMs as number) >= 0);
      assert.ok(event.totalMs >= (event.localExecutionMs as number));
    });

    it("reports rows affected for each write", async () => {
      await start();
      const created = await call("POST", "/users", { name: "Sam" });
      assert.equal(created.status, 201);
      assert.equal(created.rows, 1);
      assert.equal(created.operations[0]?.statement, "INSERT INTO users (id, name) VALUES (3, 'Sam')");

      const patched = await call("PATCH", "/users/3", { active: true });
      assert.equal(patched.rows, 1);
      assert.equal(patched.operations[0]?.statement, "UPDATE users SET active = true WHERE id = 3");

      const replaced = await call("PUT", "/users/3", { name: "Sammy" });
      assert.equal(replaced.operations[0]?.operation, "UPDATE");

      const removed = await call("DELETE", "/users/3");
      assert.equal(removed.rows, 1);
      assert.equal(removed.operations[0]?.statement, "DELETE FROM users WHERE id = 3");

      const read = await call("GET", "/users/1");
      assert.equal(read.rows, 1);
      assert.equal(read.operations[0]?.statement, "SELECT * FROM users WHERE id = 1");
    });

    it("includes storage time in local execution time, within total time", async () => {
      await start(undefined, 40);
      const event = await call("POST", "/users", { name: "Sam" });
      assert.ok((event.localExecutionMs as number) >= 30, `got ${event.localExecutionMs}`);
      assert.ok(event.totalMs >= (event.localExecutionMs as number));
      assert.equal(event.simulatedDelayMs, 0);
    });

    it("omits rows and local time when no core operation runs", async () => {
      await start();
      for (const event of [await call("GET", "/"), await call("OPTIONS", "/users")]) {
        assert.deepEqual(event.operations, []);
        assert.equal(event.rows, undefined);
        assert.equal(event.localExecutionMs, undefined);
        assert.equal(event.errorCode, undefined);
        assert.ok(event.totalMs >= 0);
      }
    });

    it("keeps operations with their own request when requests overlap", async () => {
      await start(undefined, 15);
      const requests = [1, 2, 3, 4, 5, 6].flatMap((n) => [
        fetch(`${baseUrl}/users?n=${n}`, { method: "POST", body: JSON.stringify({ name: `user ${n}` }) }),
        fetch(`${baseUrl}/orders?n=${n}`),
      ]);
      await Promise.all(requests.map(async (request) => (await request).text()));

      assert.equal(events.length, 12);
      for (const event of events) {
        assert.equal(event.operations.length, 1, event.path);
        const [operation] = event.operations;
        if (event.method === "POST") {
          const n = new URLSearchParams(event.path.split("?")[1]).get("n");
          assert.equal(operation?.operation, "INSERT");
          assert.match(operation?.statement ?? "", new RegExp(`'user ${n}'\\)$`));
        } else {
          assert.equal(operation?.operation, "SELECT");
          assert.equal(operation?.collection, "orders");
        }
      }
    });
  });

  describe("real errors", () => {
    it("carries the core error code and the failed operation", async () => {
      await start();
      const missing = await call("GET", "/users/99");
      assert.equal(missing.status, 404);
      assert.equal(missing.errorCode, "ROW_NOT_FOUND");
      assert.equal(missing.rows, 0);
      assert.equal(missing.operations[0]?.errorCode, "ROW_NOT_FOUND");
      assert.deepEqual(missing.simulated, []);

      const duplicate = await call("POST", "/users", { id: 1 });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.errorCode, "DUPLICATE_ID");
      assert.equal(duplicate.rows, 0);

      const invalid = await call("GET", "/users?_limit=x");
      assert.equal(invalid.errorCode, "INVALID_QUERY");
      assert.equal(invalid.operations[0]?.statement, "SELECT * FROM users LIMIT NaN");
    });

    it("reports transport errors without operations", async () => {
      await start();
      const badJson = await call("POST", "/users", "{ nope");
      assert.equal(badJson.status, 400);
      assert.equal(badJson.errorCode, "INVALID_JSON");
      assert.deepEqual(badJson.operations, []);
      assert.equal(badJson.rows, undefined);

      const wrongMethod = await call("DELETE", "/users");
      assert.equal(wrongMethod.errorCode, "METHOD_NOT_ALLOWED");
    });
  });

  describe("simulated requests", () => {
    it("separates simulated delay from local execution time", async () => {
      await start({ delayMs: DELAY_MS });
      const event = await call("GET", "/users");

      assert.deepEqual(event.simulated, ["delay"]);
      assert.ok(event.simulatedDelayMs >= DELAYED, `delay ${event.simulatedDelayMs}`);
      assert.ok(event.totalMs >= event.simulatedDelayMs);
      assert.ok((event.localExecutionMs as number) < 50, "delay is not counted as local execution");
      assert.ok(event.totalMs - event.simulatedDelayMs < DELAYED, "the rest of the request stays fast");
      assert.equal(event.rows, 2);
    });

    it("reports a forced error with no operation", async () => {
      await start({ delayMs: DELAY_MS, routes: { "POST /users": { error: { status: 503, code: "DOWN" } } } });
      const event = await call("POST", "/users", { name: "Sam" });

      assert.equal(event.status, 503);
      assert.equal(event.errorCode, "DOWN");
      assert.deepEqual(event.simulated, ["delay", "error"]);
      assert.deepEqual(event.operations, []);
      assert.equal(event.rows, undefined);
      assert.equal(event.localExecutionMs, undefined);
      assert.ok(event.simulatedDelayMs >= DELAYED);
    });

    it("reports a forced status together with the operation that ran", async () => {
      await start({ status: 202 });
      const created = await call("POST", "/users", { name: "Sam" });
      assert.equal(created.status, 202);
      assert.deepEqual(created.simulated, ["status"]);
      assert.equal(created.rows, 1);
      assert.equal(created.operations[0]?.operation, "INSERT");
      assert.equal(created.errorCode, undefined);

      const missing = await call("GET", "/users/99");
      assert.equal(missing.status, 202);
      assert.equal(missing.errorCode, "ROW_NOT_FOUND");
      assert.equal(missing.rows, 0);
    });

    it("reports zero rows sent for an empty simulation while keeping the real operation", async () => {
      await start({ empty: true });
      const list = await call("GET", "/users");
      assert.deepEqual(list.simulated, ["empty"]);
      assert.equal(list.rows, 0);
      assert.equal(list.operations[0]?.rows, 2);

      const one = await call("GET", "/users/1");
      assert.deepEqual(one.simulated, []);
      assert.equal(one.rows, 1);

      const unknown = await call("GET", "/nope");
      assert.deepEqual(unknown.simulated, []);
      assert.equal(unknown.errorCode, "COLLECTION_NOT_FOUND");
    });
  });

  describe("listeners", () => {
    it("a throwing listener does not affect the response", async () => {
      const database = await Database.open({
        load: async () => ({ meta: { version: 1 }, collections: { users: [] } }),
        save: async () => {},
      });
      server = new SandboxServer({
        database,
        port: 0,
        onRequest: () => {
          throw new Error("listener failed");
        },
      });
      const { url } = await server.start();
      assert.equal((await fetch(`${url}/users`)).status, 200);
      assert.equal((await fetch(`${url}/users`)).status, 200);
    });

    it("collects operations again after a restart", async () => {
      await start();
      await server?.stop();
      baseUrl = (await (server as SandboxServer).start()).url;
      const event = await call("GET", "/users");
      assert.equal(event.operations.length, 1);
    });
  });
});

describe("log formatting", () => {
  const timestamp = new Date(2026, 0, 2, 12, 41, 3).getTime();
  const base: RequestEvent = {
    timestamp,
    method: "GET",
    path: "/users?active=true",
    status: 200,
    rows: 18,
    localExecutionMs: 2.44,
    simulatedDelayMs: 0,
    totalMs: 6.75,
    simulated: [],
    operations: [],
  };

  it("formats a request line from a structured event", () => {
    assert.equal(formatRequestEvent(base), "12:41:03 GET   /users?active=true  200  18 rows  local=2.4ms total=6.8ms");
  });

  it("uses the singular for one row", () => {
    assert.equal(
      formatRequestEvent({ ...base, method: "PATCH", path: "/users/12", rows: 1, localExecutionMs: 1.8, totalMs: 4.1 }),
      "12:41:03 PATCH /users/12  200  1 row  local=1.8ms total=4.1ms",
    );
  });

  it("shows simulated delay separately and names simulation effects and errors", () => {
    const { rows: _rows, localExecutionMs: _local, ...withoutOperation } = base;
    assert.equal(
      formatRequestEvent({
        ...withoutOperation,
        status: 503,
        simulatedDelayMs: 200.04,
        totalMs: 201.3,
        errorCode: "SIMULATED_ERROR",
        simulated: ["delay", "error"],
      }),
      "12:41:03 GET   /users?active=true  503  delay=200.0ms total=201.3ms  SIMULATED_ERROR  simulated=delay,error",
    );
  });

  it("formats an operation line", () => {
    assert.equal(
      formatOperationEvent({
        operation: "SELECT",
        collection: "users",
        statement: "SELECT * FROM users WHERE active = 'true'",
        rows: 2,
        localExecutionMs: 0.31,
      }),
      "SELECT  2 rows  local=0.3ms  SELECT * FROM users WHERE active = 'true'",
    );
    assert.equal(
      formatOperationEvent({
        operation: "DELETE",
        collection: "users",
        statement: "DELETE FROM users WHERE id = 9",
        rows: 0,
        localExecutionMs: 0.05,
        errorCode: "ROW_NOT_FOUND",
      }),
      "DELETE  0 rows  local=0.1ms  ROW_NOT_FOUND  DELETE FROM users WHERE id = 9",
    );
  });

  it("never labels a timing as database performance", () => {
    const line = formatRequestEvent({ ...base, simulatedDelayMs: 5 });
    assert.doesNotMatch(line, /\b(db|database|sql|query)\w*=/i);
  });
});
