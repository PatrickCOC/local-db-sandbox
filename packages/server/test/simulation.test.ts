import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Database } from "../../core/src/index.ts";
import type { DatabaseState, StorageAdapter } from "../../core/src/index.ts";
import { SandboxServer, SimulationConfigError } from "../src/index.ts";
import type { RequestEvent, SimulationConfig } from "../src/index.ts";

const DELAY_MS = 120;
// Timers may fire a few milliseconds early.
const DELAYED = DELAY_MS - 10;

describe("simulation", () => {
  let server: SandboxServer | undefined;
  let baseUrl: string;
  let saves: number;
  let events: RequestEvent[];

  async function start(simulation?: SimulationConfig): Promise<void> {
    saves = 0;
    events = [];
    let state: DatabaseState = {
      meta: { version: 1 },
      collections: {
        users: [
          { id: 1, name: "Patrick" },
          { id: 2, name: "Alex" },
        ],
        orders: [{ id: 1, total: 5 }],
      },
    };
    const storage: StorageAdapter = {
      load: async () => structuredClone(state),
      save: async (next) => {
        saves += 1;
        state = structuredClone(next);
      },
    };
    server = new SandboxServer({ database: await Database.open(storage), port: 0, simulation, onRequest: (event) => events.push(event) });
    baseUrl = (await server.start()).url;
  }

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  /*
   * `elapsedMs` is the time the request took as seen from here. It shows that
   * a request was delayed: it cannot be shorter than the delay. It does not
   * show that a request was not delayed, because it also holds whatever this
   * process and the machine were busy with, and in a full test run that has
   * been longer than the delay itself. That is read from `simulatedDelayMs`,
   * the server's own measurement of the time it waited: 0 when it did not.
   */
  async function call(method: string, path: string, body?: unknown) {
    const started = performance.now();
    const request = events.length;
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      json: text === "" ? undefined : JSON.parse(text),
      elapsedMs: performance.now() - started,
      simulatedDelayMs: (events[request] as RequestEvent).simulatedDelayMs,
    };
  }

  describe("success", () => {
    it("changes nothing when no simulation is configured", async () => {
      await start();
      const list = await call("GET", "/users");
      assert.equal(list.status, 200);
      assert.equal(list.json.length, 2);
      assert.equal(list.simulatedDelayMs, 0);
      assert.equal((await call("POST", "/users", { name: "Sam" })).status, 201);
    });

    it("changes nothing for an empty config", async () => {
      await start({ routes: {} });
      assert.equal((await call("GET", "/users/1")).json.name, "Patrick");
    });
  });

  describe("delay", () => {
    it("delays every request when set at the top level", async () => {
      await start({ delayMs: DELAY_MS });
      const list = await call("GET", "/users");
      assert.equal(list.status, 200);
      assert.equal(list.json.length, 2);
      assert.ok(list.elapsedMs >= DELAYED, `took ${list.elapsedMs}ms`);

      const missing = await call("GET", "/users/99");
      assert.equal(missing.status, 404);
      assert.ok(missing.elapsedMs >= DELAYED);
    });

    it("delays only the configured route", async () => {
      await start({ routes: { "/users": { delayMs: DELAY_MS } } });
      assert.ok((await call("GET", "/users")).elapsedMs >= DELAYED);
      assert.equal((await call("GET", "/orders")).simulatedDelayMs, 0);
      assert.equal((await call("GET", "/users/1")).simulatedDelayMs, 0);
    });

    it("still applies the operation after the delay", async () => {
      await start({ delayMs: DELAY_MS });
      const created = await call("POST", "/users", { name: "Sam" });
      assert.equal(created.status, 201);
      assert.ok(created.elapsedMs >= DELAYED);
      assert.equal((await call("GET", "/users/3")).json.name, "Sam");
    });
  });

  describe("forced status", () => {
    it("replaces the status but keeps the body and runs the operation", async () => {
      await start({ routes: { "POST /users": { status: 202 } } });
      const created = await call("POST", "/users", { name: "Sam" });
      assert.equal(created.status, 202);
      assert.deepEqual(created.json, { id: 3, name: "Sam" });
      assert.equal(saves, 1);
      assert.equal((await call("GET", "/users")).status, 200);
    });

    it("also replaces the status of real errors", async () => {
      await start({ status: 503 });
      const missing = await call("GET", "/users/99");
      assert.equal(missing.status, 503);
      assert.equal(missing.json.error.code, "ROW_NOT_FOUND");
    });

    it("sends no body for 204", async () => {
      await start({ routes: { "DELETE /users/:id": { status: 204 } } });
      const removed = await call("DELETE", "/users/1");
      assert.equal(removed.status, 204);
      assert.equal(removed.json, undefined);
      assert.equal((await call("GET", "/users")).json.length, 1);
    });
  });

  describe("forced error", () => {
    it("responds with a default error and skips the operation", async () => {
      await start({ routes: { "POST /users": { error: {} } } });
      const created = await call("POST", "/users", { name: "Sam" });
      assert.equal(created.status, 500);
      assert.deepEqual(created.json, { error: { code: "SIMULATED_ERROR", message: "Simulated error." } });
      assert.equal(saves, 0);
      assert.equal((await call("GET", "/users")).json.length, 2);
    });

    it("uses the configured status, code, and message", async () => {
      await start({ error: { status: 429, code: "RATE_LIMITED", message: "Slow down." } });
      const list = await call("GET", "/users");
      assert.equal(list.status, 429);
      assert.deepEqual(list.json, { error: { code: "RATE_LIMITED", message: "Slow down." } });
      assert.equal(list.headers.get("access-control-allow-origin"), "*");
    });
  });

  describe("empty result", () => {
    it("returns no rows for list requests", async () => {
      await start({ empty: true });
      const list = await call("GET", "/users?_sort=name");
      assert.equal(list.status, 200);
      assert.deepEqual(list.json, []);
      assert.equal(list.headers.get("x-total-count"), "0");
    });

    it("leaves other requests and real errors alone", async () => {
      await start({ empty: true });
      assert.equal((await call("GET", "/users/1")).json.name, "Patrick");
      assert.deepEqual((await call("GET", "/")).json, { collections: ["users", "orders"] });
      assert.equal((await call("POST", "/users", { name: "Sam" })).status, 201);
      assert.equal((await call("GET", "/nope")).status, 404);
      assert.equal((await call("GET", "/users?_limit=x")).status, 400);
    });
  });

  describe("per-route overrides", () => {
    it("matches by method, path, and :param segments, ignoring the query string", async () => {
      await start({
        routes: {
          "get /users": { status: 203 },
          "/orders/:id": { status: 202 },
          "/": { status: 206 },
        },
      });
      assert.equal((await call("GET", "/users?name=Alex")).status, 203);
      assert.equal((await call("POST", "/users", { name: "Sam" })).status, 201);
      assert.equal((await call("GET", "/orders/1")).status, 202);
      assert.equal((await call("PATCH", "/orders/1", { total: 6 })).status, 202);
      assert.equal((await call("GET", "/orders")).status, 200);
      assert.equal((await call("GET", "/")).status, 206);
    });

    it("prefers literal segments, then a named method, then declaration order", async () => {
      await start({
        routes: {
          "/users/:id": { status: 201 },
          "GET /users/:id": { status: 202 },
          "/users/1": { status: 203 },
          "GET /:collection/:id": { status: 204 },
          "/users/:other": { status: 205 },
        },
      });
      assert.equal((await call("GET", "/users/1")).status, 203);
      assert.equal((await call("GET", "/users/2")).status, 202);
      assert.equal((await call("PATCH", "/users/2", {})).status, 201);
      assert.equal((await call("GET", "/orders/1")).status, 204);
    });

    it("overrides top-level defaults field by field", async () => {
      await start({
        delayMs: DELAY_MS,
        status: 203,
        routes: { "/orders": { delayMs: 0 }, "/users/:id": { status: 202 } },
      });
      const orders = await call("GET", "/orders");
      assert.equal(orders.status, 203);
      assert.equal(orders.simulatedDelayMs, 0);

      const user = await call("GET", "/users/1");
      assert.equal(user.status, 202);
      assert.ok(user.elapsedMs >= DELAYED);
    });

    it("lets a route turn defaults off", async () => {
      await start({
        error: { status: 503 },
        status: 202,
        empty: true,
        routes: { "/users": { error: null, status: null, empty: false }, "/orders": { error: null } },
      });
      const users = await call("GET", "/users");
      assert.equal(users.status, 200);
      assert.equal(users.json.length, 2);

      const orders = await call("GET", "/orders");
      assert.equal(orders.status, 202);
      assert.deepEqual(orders.json, []);

      assert.equal((await call("GET", "/users/1")).status, 503);
    });

    it("does not combine fields from several matching routes", async () => {
      await start({ routes: { "/users": { delayMs: DELAY_MS }, "GET /users": { status: 203 } } });
      const list = await call("GET", "/users");
      assert.equal(list.status, 203);
      assert.equal(list.simulatedDelayMs, 0);
    });
  });

  describe("precedence within a rule", () => {
    it("error wins over empty and status, and delay still applies", async () => {
      await start({ delayMs: DELAY_MS, error: { status: 502 }, empty: true, status: 201 });
      const list = await call("GET", "/users");
      assert.equal(list.status, 502);
      assert.equal(list.json.error.code, "SIMULATED_ERROR");
      assert.ok(list.elapsedMs >= DELAYED);
    });

    it("empty and status combine", async () => {
      await start({ empty: true, status: 203 });
      const list = await call("GET", "/users");
      assert.equal(list.status, 203);
      assert.deepEqual(list.json, []);
    });
  });

  it("never simulates CORS preflight requests", async () => {
    await start({ delayMs: DELAY_MS, error: {} });
    const response = await fetch(`${baseUrl}/users`, { method: "OPTIONS" });
    assert.equal(response.status, 204);
    assert.deepEqual(events.map((event) => [event.simulatedDelayMs, event.simulated]), [[0, []]]);
  });

  it("applies top-level defaults to a path that cannot be decoded", async () => {
    await start({ status: 203, routes: { "/users/:id": { status: 202 } } });
    const result = await call("GET", "/users/%E0%A4%A");
    assert.equal(result.status, 203);
    assert.equal(result.json.error.code, "INVALID_PATH");
  });

  describe("invalid config", () => {
    const database = () =>
      Database.open({ load: async () => ({ meta: { version: 1 }, collections: {} }), save: async () => {} });

    const invalid: Record<string, unknown> = {
      "negative delay": { delayMs: -1 },
      "non-numeric delay": { delayMs: "100" },
      "status out of range": { status: 99 },
      "fractional status": { status: 200.5 },
      "non-boolean empty": { empty: "yes" },
      "non-object error": { error: true },
      "error status out of range": { error: { status: 700 } },
      "non-string error message": { error: { message: 5 } },
      "non-object routes": { routes: [] },
      "route without a path": { routes: { users: {} } },
      "route with unknown method": { routes: { "FETCH /users": {} } },
      "non-object route rule": { routes: { "/users": 5 } },
      "invalid route rule": { routes: { "/users": { delayMs: -5 } } },
    };
    for (const [label, simulation] of Object.entries(invalid)) {
      it(`rejects ${label}`, async () => {
        const db = await database();
        assert.throws(
          () => new SandboxServer({ database: db, simulation: simulation as SimulationConfig }),
          SimulationConfigError,
        );
      });
    }
  });
});
