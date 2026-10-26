import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createDatabase } from "../../storage-json/src/index.ts";
import { storedRows, tableFile } from "../../storage-json/test/support/database-files.ts";
import { ConfigError, parseSandboxConfig, runCli } from "../src/index.ts";

const root = join(import.meta.dirname, "../../..");
const fixturePath = join(root, "examples/basic/db.json");

interface Session {
  url: string;
  out: () => string;
  lines: () => string[];
  signals: EventEmitter;
  stop: (signal?: "SIGINT" | "SIGTERM") => Promise<number>;
}

describe("CLI", () => {
  let dir: string;
  let dbPath: string;
  let sessions: Session[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-cli-"));
    dbPath = join(dir, "db.json");
    await copyFile(fixturePath, dbPath);
    sessions = [];
  });

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.stop()));
    await rm(dir, { recursive: true, force: true });
  });

  /** Runs a command that is expected to finish on its own. */
  async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      signals: new EventEmitter(),
    });
    return { code, stdout, stderr };
  }

  /** Starts the server through the CLI and waits until it reports its URL. */
  async function serve(...argv: string[]): Promise<Session> {
    let stdout = "";
    let announce: (url: string) => void = () => {};
    const ready = new Promise<string>((resolve) => (announce = resolve));
    const signals = new EventEmitter();

    const exit = runCli(argv, {
      stdout: {
        write: (text) => {
          stdout += text;
          const match = /running at (http:\S+)/.exec(stdout);
          if (match) {
            announce(match[1] as string);
          }
        },
      },
      stderr: { write: (text) => (stdout += text) },
      signals,
    });

    const url = await Promise.race([
      ready,
      exit.then((code) => Promise.reject(new Error(`CLI exited with ${code}: ${stdout}`))),
    ]);
    let stopped: Promise<number> | undefined;
    const session: Session = {
      url,
      signals,
      out: () => stdout,
      lines: () => stdout.split("\n").filter((line) => /^\d\d:\d\d:\d\d /.test(line) || line.startsWith("    ")),
      stop: (signal = "SIGTERM") => {
        stopped ??= (signals.emit(signal), exit);
        return stopped;
      },
    };
    sessions.push(session);
    return session;
  }

  async function writeDb(config: unknown): Promise<void> {
    await writeFile(dbPath, JSON.stringify({ $config: config, data: { users: [{ id: 1, name: "Patrick" }] } }));
  }

  function listen(): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
    });
  }

  describe("usage", () => {
    it("prints help", async () => {
      const { code, stdout, stderr } = await run("--help");
      assert.equal(code, 0);
      assert.match(stdout, /^Usage: local-db-sandbox <database> \[options\]/);
      assert.match(stdout, /<database> is a single file\s+\(sandbox\.db\.json\) or a database directory \(sandbox\.db\)/);
      assert.match(stdout, /--port/);
      assert.equal(stderr, "");
    });

    it("prints the package version", async () => {
      const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      assert.deepEqual(await run("--version"), { code: 0, stdout: `${manifest.version}\n`, stderr: "" });
    });

    const mistakes: Record<string, { argv: string[]; message: RegExp }> = {
      "no file": { argv: [], message: /Missing the JSON database: a file or a database directory\./ },
      "two files": { argv: ["a.json", "b.json"], message: /exactly one/ },
      "an unknown option": { argv: ["db.json", "--nope"], message: /nope/ },
      "a non-numeric port": { argv: ["db.json", "--port", "abc"], message: /--port must be an integer/ },
      "a port out of range": { argv: ["db.json", "--port", "70000"], message: /--port must be an integer/ },
      "an empty host": { argv: ["db.json", "--host", ""], message: /--host/ },
    };
    for (const [label, { argv, message }] of Object.entries(mistakes)) {
      it(`rejects ${label}`, async () => {
        const { code, stdout, stderr } = await run(...argv);
        assert.equal(code, 1);
        assert.equal(stdout, "");
        assert.match(stderr, message);
        assert.match(stderr, /--help/);
      });
    }
  });

  describe("startup", () => {
    it("serves the file with one command and reports where", async () => {
      const session = await serve(dbPath, "--port", "0");

      assert.match(session.out(), /^Local DB Sandbox running at http:\/\/127\.0\.0\.1:\d+\n/);
      assert.ok(session.out().includes(`file:        ${dbPath}`));
      assert.match(session.out(), /collections: users, orders/);
      assert.match(session.out(), /Ctrl\+C/);

      const users = (await (await fetch(`${session.url}/users`)).json()) as unknown[];
      assert.equal(users.length, 2);
    });

    it("persists changes to the file", async () => {
      const session = await serve(dbPath, "-p", "0");
      const response = await fetch(`${session.url}/users`, { method: "POST", body: JSON.stringify({ name: "Sam" }) });
      assert.equal(response.status, 201);

      const stored = JSON.parse(await readFile(dbPath, "utf8"));
      assert.deepEqual(stored.data.users[2], { id: 3, name: "Sam" });
      assert.deepEqual(stored.$config, { routes: {} });
    });

    it("serves a database directory, and saves changes to the files of its tables", async () => {
      const directory = join(dir, "sandbox.db");
      const { data, $config } = JSON.parse(await readFile(dbPath, "utf8"));
      await createDatabase(directory, { collections: data, config: $config });
      const orders = tableFile(directory, "orders");
      const untouched = await readFile(orders, "utf8");

      const session = await serve(directory, "--port", "0");
      assert.ok(session.out().includes(`directory:   ${directory}`), session.out());
      assert.match(session.out(), /collections: users, orders/);
      assert.equal(((await (await fetch(`${session.url}/users`)).json()) as unknown[]).length, 2);

      const response = await fetch(`${session.url}/users`, { method: "POST", body: JSON.stringify({ name: "Sam" }) });
      assert.equal(response.status, 201);
      assert.deepEqual((await storedRows(directory, "users"))[2], { id: 3, name: "Sam" });
      // The table that did not change is the same file as before.
      assert.equal(tableFile(directory, "orders"), orders);
      assert.equal(await readFile(orders, "utf8"), untouched);
      assert.deepEqual(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).config, { routes: {} });
      assert.deepEqual((await readdir(directory)).sort(), ["manifest.json", "schema.json", "tables"]);
    });

    it("does not write to a directory that declares memory persistence, and says so", async () => {
      const directory = join(dir, "fixture.db");
      await createDatabase(directory, { collections: { users: [{ id: 1, name: "Patrick" }] }, persistence: "memory" });
      const before = await readFile(join(directory, "tables/users.json"), "utf8");

      const session = await serve(directory, "--port", "0");
      assert.match(session.out(), /changes are not saved \("persistence": "memory" in manifest\.json\)/);
      assert.equal((await fetch(`${session.url}/users`, { method: "POST", body: JSON.stringify({ name: "Sam" }) })).status, 201);
      // The running sandbox has the change; the directory does not.
      assert.equal(((await (await fetch(`${session.url}/users`)).json()) as unknown[]).length, 2);
      assert.equal(await readFile(join(directory, "tables/users.json"), "utf8"), before);
    });

    const failures: Record<string, { content?: string; message: RegExp }> = {
      "a missing file": { message: /Cannot read database file/ },
      "invalid JSON": { content: "{ nope", message: /not valid JSON/ },
      "an invalid data section": { content: '{ "data": [] }', message: /"data" must be an object/ },
      "an unknown $config key": { content: '{ "$config": { "port": 1 }, "data": {} }', message: /Unknown key "port" in "\$config"/ },
      "an invalid $config port": {
        content: '{ "$config": { "server": { "port": "80" } }, "data": {} }',
        message: /\$config\.server\.port/,
      },
      "an invalid simulation rule": {
        content: '{ "$config": { "defaults": { "delayMs": -1 } }, "data": {} }',
        message: /delayMs must be a non-negative number/,
      },
      "an invalid route key": {
        content: '{ "$config": { "routes": { "users": {} } }, "data": {} }',
        message: /Simulation route "users"/,
      },
    };
    for (const [label, { content, message }] of Object.entries(failures)) {
      it(`fails clearly for ${label}`, async () => {
        const file = content === undefined ? join(dir, "missing.json") : dbPath;
        if (content !== undefined) {
          await writeFile(dbPath, content);
        }
        const { code, stdout, stderr } = await run(file, "--port", "0");
        assert.equal(code, 1);
        assert.equal(stdout, "");
        assert.match(stderr, /^Error: /);
        assert.match(stderr, message);
      });
    }

    it("fails clearly for a missing database directory, and for a broken one", async () => {
      const missing = await run(join(dir, "missing.db"), "--port", "0");
      assert.deepEqual([missing.code, missing.stdout], [1, ""]);
      assert.match(missing.stderr, /^Error: Database not found: .*missing\.db\n/);

      const directory = join(dir, "sandbox.db");
      await createDatabase(directory, { collections: { users: [] }, config: { port: 1 } });
      assert.match((await run(directory, "--port", "0")).stderr, /^Error: Unknown key "port" in "\$config"/);
      await writeFile(join(directory, "tables/users.json"), "{ nope");
      assert.match((await run(directory, "--port", "0")).stderr, /^Error: .*tables\/users\.json is not valid JSON\./);
    });
  });

  describe("configuration", () => {
    it("uses the host and port from $config.server", async () => {
      const { server, port } = await listen();
      await new Promise((resolve) => server.close(resolve));
      await writeDb({ server: { host: "localhost", port } });

      const session = await serve(dbPath);
      assert.equal(new URL(session.url).port, String(port));
      assert.equal((await fetch(`http://localhost:${port}/users`)).status, 200);
    });

    it("reports a busy port, and lets flags override $config", async () => {
      const { server, port } = await listen();
      try {
        await writeDb({ server: { port } });

        const busy = await run(dbPath);
        assert.equal(busy.code, 1);
        assert.match(busy.stderr, /already in use/);

        const explicit = await run(dbPath, "--port", String(port));
        assert.match(explicit.stderr, new RegExp(`Port ${port} is already in use`));

        const session = await serve(dbPath, "--port", "0");
        assert.notEqual(new URL(session.url).port, String(port));
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it("applies simulation defaults and route overrides from $config", async () => {
      await writeDb({
        defaults: { status: 203 },
        routes: {
          "POST /users": { error: { status: 503, code: "DOWN", message: "Try later." } },
          "/users/:id": { status: null },
        },
      });
      const session = await serve(dbPath, "--port", "0");

      assert.equal((await fetch(`${session.url}/users`)).status, 203);
      assert.equal((await fetch(`${session.url}/users/1`)).status, 200);
      const failed = await fetch(`${session.url}/users`, { method: "POST", body: "{}" });
      assert.equal(failed.status, 503);
      assert.deepEqual(await failed.json(), { error: { code: "DOWN", message: "Try later." } });

      assert.match(session.lines()[2] as string, /POST {2}\/users {2}503 .* DOWN {2}simulated=error$/);
    });
  });

  describe("logging", () => {
    it("prints one concise line per request by default", async () => {
      const session = await serve(dbPath, "--port", "0");
      await fetch(`${session.url}/users?active=true`);
      await fetch(`${session.url}/users/99`);
      await fetch(`${session.url}/users`, { method: "OPTIONS" });

      const lines = session.lines();
      assert.equal(lines.length, 2, "preflight requests are not logged by default");
      assert.match(
        lines[0] as string,
        /^\d\d:\d\d:\d\d GET {3}\/users\?active=true {2}200 {2}1 row {2}local=[\d.]+ms total=[\d.]+ms$/,
      );
      assert.match(lines[1] as string, /GET {3}\/users\/99 {2}404 {2}0 rows .* ROW_NOT_FOUND$/);
    });

    it("adds operation lines and preflight requests with --verbose", async () => {
      const session = await serve(dbPath, "--port", "0", "--verbose");
      await fetch(`${session.url}/users?active=true`);
      await fetch(`${session.url}/users`, { method: "OPTIONS" });

      const lines = session.lines();
      assert.equal(lines.length, 3);
      assert.match(lines[0] as string, /GET {3}\/users\?active=true {2}200/);
      assert.match(
        lines[1] as string,
        /^ {4}SELECT {2}1 row {2}local=[\d.]+ms {2}SELECT \* FROM users WHERE active = 'true'$/,
      );
      assert.match(lines[2] as string, /OPTIONS \/users {2}204/);
    });

    it("prints no request lines with --quiet", async () => {
      const session = await serve(dbPath, "--port", "0", "--quiet");
      assert.equal((await fetch(`${session.url}/users`)).status, 200);
      assert.deepEqual(session.lines(), []);
      assert.match(session.out(), /running at/);
    });
  });

  describe("shutdown", () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      it(`stops cleanly on ${signal}`, async () => {
        const session = await serve(dbPath, "--port", "0");
        assert.equal((await fetch(`${session.url}/users`)).status, 200);

        assert.equal(await session.stop(signal), 0);
        assert.match(session.out(), /Stopped\.\n$/);
        await assert.rejects(fetch(`${session.url}/users`));
        assert.equal(session.signals.listenerCount("SIGINT"), 0);
        assert.equal(session.signals.listenerCount("SIGTERM"), 0);
      });
    }

    it("lets an in-flight request finish before stopping", async () => {
      await writeDb({ defaults: { delayMs: 150 } });
      const session = await serve(dbPath, "--port", "0");

      const pending = fetch(`${session.url}/users`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const [code, response] = await Promise.all([session.stop(), pending]);

      assert.equal(code, 0);
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as unknown[]).length, 1);
    });
  });
});

describe("parseSandboxConfig", () => {
  it("returns no settings for a missing or empty config", () => {
    assert.deepEqual(parseSandboxConfig(undefined), { simulation: {} });
    assert.deepEqual(parseSandboxConfig({}), { simulation: { routes: {} } });
    assert.deepEqual(parseSandboxConfig({ routes: {} }), { simulation: { routes: {} } });
  });

  it("maps server, defaults, and routes", () => {
    assert.deepEqual(
      parseSandboxConfig({
        server: { host: "0.0.0.0", port: 8080 },
        defaults: { delayMs: 50, empty: true },
        routes: { "GET /users": { status: 202 } },
      }),
      {
        host: "0.0.0.0",
        port: 8080,
        simulation: { delayMs: 50, empty: true, routes: { "GET /users": { status: 202 } } },
      },
    );
  });

  it("rejects wrong shapes and unknown keys", () => {
    const invalid: unknown[] = [
      [],
      "x",
      { simulation: {} },
      { server: [] },
      { server: { hostname: "x" } },
      { server: { host: "" } },
      { server: { port: 65536 } },
      { server: { port: 1.5 } },
      { defaults: { routes: {} } },
      { defaults: 5 },
      { routes: [] },
    ];
    for (const config of invalid) {
      assert.throws(() => parseSandboxConfig(config), ConfigError, JSON.stringify(config));
    }
  });
});
