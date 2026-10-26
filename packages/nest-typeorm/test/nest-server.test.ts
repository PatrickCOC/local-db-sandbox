import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { runCli } from "../../cli/src/index.ts";
import { startStudio } from "../../studio/src/index.ts";
import { NestSandboxError, initNest } from "../src/index.ts";
import { databaseFiles as filesOf, storedRows, tableFile } from "./support/nest-project.ts";

/*
 * fixtures/nest-project is an ordinary NestJS + TypeORM project: an entry
 * point that sets a global prefix, CORS, and a global pipe, a root module
 * that configures a real database (in-memory SQLite through sql.js), and
 * feature modules with repositories. It is copied to a temporary folder and
 * never edited by the test.
 *
 * The original server is started the way the project would start it (with a
 * stand-in for `nest start`); the sandbox server is started with the script
 * that `init-nest` adds. Both are separate processes, used over real HTTP.
 */
const repository = join(import.meta.dirname, "../../..");
const fixture = join(import.meta.dirname, "fixtures", "nest-project");
const runOriginal = join(import.meta.dirname, "support", "run-original.ts");
const PROJECT_PACKAGES = ["@nestjs", "typeorm", "typescript", "reflect-metadata", "rxjs", "sql.js"];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Whether a TCP connection to the address and port is accepted. */
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

/** This machine's addresses on its networks: where another machine would reach it. */
function networkAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry !== undefined && !entry.internal && entry.family === "IPv4")
    .map((entry) => entry?.address as string);
}

interface Running {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function start(cwd: string, args: string[], env: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, output: () => output, exited };
}

/** Resolves once the server answers, and fails if its process ends first. */
async function ready(running: Running, url: string): Promise<void> {
  let ended = false;
  void running.exited.then(() => (ended = true));
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (ended) {
      assert.fail(`process ended before serving ${url}:\n${running.output()}`);
    }
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.fail(`no answer from ${url}:\n${running.output()}`);
}

async function sourceFiles(dir: string): Promise<Record<string, string>> {
  const names = (await readdir(join(dir, "src"), { recursive: true })).filter((name) => name.endsWith(".ts")).map((name) => join("src", name));
  const files: Record<string, string> = {};
  for (const name of [...names, "tsconfig.json", "nest-cli.json"].sort()) {
    files[name] = await readFile(join(dir, name), "utf8");
  }
  return files;
}

describe("NestJS project with a parallel sandbox server", { timeout: 180_000 }, () => {
  let dir: string;
  let originalPort: number;
  let sandboxPort: number;
  let original: Running;
  let sandbox: Running;
  let sourcesBefore: Record<string, string>;
  let init: { code: number; stdout: string; stderr: string };
  const processes: Running[] = [];

  const api = (port: number, path: string, init?: RequestInit): Promise<Response> =>
    fetch(`http://localhost:${port}${path}`, init);
  const send = (port: number, method: string, path: string, body: unknown): Promise<Response> =>
    api(port, path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // A new project's database is a directory: one file of rows per table.
  const stored = (collection: string): Promise<Record<string, unknown>[]> => storedRows(join(dir, "sandbox.db"), collection);
  const databaseFiles = (): Promise<Record<string, string>> => filesOf(join(dir, "sandbox.db"));
  const cli = async (...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      signals: new EventEmitter(),
    });
    return { code, stdout, stderr };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-nest-project-"));
    await cp(fixture, dir, { recursive: true });

    // What `npm install` would provide: the project's packages, and this package under its own name.
    await mkdir(join(dir, "node_modules", "local-db-sandbox"), { recursive: true });
    for (const name of PROJECT_PACKAGES) {
      await symlink(join(repository, "node_modules", name), join(dir, "node_modules", name), "junction");
    }
    const entryPoint = pathToFileURL(join(repository, "packages/cli/src/index.ts")).href;
    await writeFile(join(dir, "node_modules/local-db-sandbox/package.json"), JSON.stringify({ name: "local-db-sandbox", type: "module", exports: "./index.js" }));
    await writeFile(join(dir, "node_modules/local-db-sandbox/index.js"), `export * from ${JSON.stringify(entryPoint)};\n`);

    sourcesBefore = await sourceFiles(dir);
    [originalPort, sandboxPort] = [await freePort(), await freePort()];

    init = await cli("init-nest", join(dir, "src", "main.ts"), "--port", String(sandboxPort));
    assert.equal(init.code, 0, init.stderr);

    // Both get the same environment: the application reads its port from PORT.
    const env = { PORT: String(originalPort) };
    original = start(dir, [runOriginal, join(dir, "src", "main.ts")], env);
    sandbox = start(dir, [".local-db-sandbox/sandbox.server.ts"], env);
    processes.push(original, sandbox);
    await Promise.all([ready(original, `http://localhost:${originalPort}/api/info`), ready(sandbox, `http://localhost:${sandboxPort}/api/info`)]);
  });

  after(async () => {
    for (const running of processes) {
      running.child.kill();
      await running.exited;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  describe("init-nest", () => {
    it("reports what it detected and what it wrote", () => {
      assert.equal(init.stderr, "");
      assert.match(init.stdout, /^Nest entry point: src\/main\.ts\n {2}root module: AppModule \(\.\/app\.module\)\n {2}TypeORM root: src\/app\.module\.ts\n/);
      assert.match(init.stdout, /\nImported 2 TypeORM entities from src\n {2}category \(Category\): code, label\n {2}users \(User\): id, name, active, createdAt\n/);
      assert.match(
        init.stdout,
        /\nWrote sandbox\.db \(database directory: an empty file per table, and their definitions\)\.\nWrote \.local-db-sandbox\/sandbox\.server\.ts\nWrote \.local-db-sandbox\/sandbox\.config\.json\n/,
      );
      assert.ok(init.stdout.includes(`\nSandbox port: ${sandboxPort}\nAdded the "sandbox" script to package.json.\n`));
      assert.ok(
        init.stdout.endsWith(
          "Start the sandbox with: npm run sandbox   (restarts when the application's sources change)\n" +
            "Start it once, without watching: node .local-db-sandbox/sandbox.server.ts\n" +
            "The application's own sources and start command are unchanged.\n",
        ),
        init.stdout,
      );
    });

    it("writes a small entry point and configuration under .local-db-sandbox", async () => {
      assert.deepEqual((await readdir(join(dir, ".local-db-sandbox"))).sort(), ["sandbox.config.json", "sandbox.server.ts"]);
      assert.deepEqual(JSON.parse(await readFile(join(dir, ".local-db-sandbox/sandbox.config.json"), "utf8")), {
        entry: "../src/main.ts",
        database: "../sandbox.db",
        port: sandboxPort,
      });
      const server = await readFile(join(dir, ".local-db-sandbox/sandbox.server.ts"), "utf8");
      assert.match(server, /import \{ runNestSandbox \} from "local-db-sandbox";/);
      assert.ok(server.split("\n").length < 16);
    });

    it("adds only the sandbox script to package.json", async () => {
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      const fixtureManifest = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
      assert.deepEqual(manifest, {
        ...fixtureManifest,
        scripts: { ...fixtureManifest.scripts, sandbox: "node .local-db-sandbox/sandbox.server.ts --watch" },
      });
    });

    it("finds the entry point from nest-cli.json and changes nothing when run again", async () => {
      await send(sandboxPort, "POST", "/api/categories", { code: "kept", label: "Kept" });
      const snapshot = async (): Promise<unknown> => [
        await databaseFiles(),
        ...(await Promise.all(["package.json", ".local-db-sandbox/sandbox.config.json"].map((name) => readFile(join(dir, name), "utf8")))),
      ];
      const filesBefore = await snapshot();

      const result = await initNest({ cwd: dir });
      assert.equal(result.entry, "src/main.ts");
      assert.equal(result.port, sandboxPort);
      // The running sandbox has saved since: the definitions it stores are the ones init-nest reads.
      assert.deepEqual(result.database, { file: "sandbox.db", format: "directory", created: false, addedCollections: [], definitionsUpdated: false });
      assert.deepEqual(result.generated.map((entry) => entry.changed), [false, false]);
      assert.equal(result.script.status, "present");

      assert.deepEqual(await snapshot(), filesBefore);
      await api(sandboxPort, "/api/categories/kept", { method: "DELETE" });
    });

    it("leaves a database directory that describes its tables without the application", async () => {
      assert.deepEqual(Object.keys(await databaseFiles()).sort(), ["manifest.json", "schema.json", "tables/category.json", "tables/users.json"]);
      const schema = JSON.parse((await databaseFiles())["schema.json"] as string);
      assert.deepEqual(
        schema.tables.map((table: { name: string; columns: { column: string }[] }) => [table.name, table.columns.map((column) => column.column)]),
        [["category", ["code", "label"]], ["users", ["id", "name", "active", "createdAt"]]],
      );
    });
  });

  describe("the two servers", () => {
    it("run at the same time on different ports", async () => {
      assert.notEqual(originalPort, sandboxPort);
      assert.equal((await api(originalPort, "/api/info")).status, 200);
      assert.equal((await api(sandboxPort, "/api/info")).status, 200);
      // The entry point asked for the original port in both processes.
      assert.ok(sandbox.output().includes(`the entry point asked for port ${originalPort}; the sandbox uses ${sandboxPort} on 127.0.0.1 (this machine only) instead.`));
      assert.match(sandbox.output(), /Local DB Sandbox: application running at http:\/\/127\.0\.0\.1:\d+\n/);
    });

    it("the sandbox listens on 127.0.0.1 alone, where the application's own start listens where it asked (D-047)", async () => {
      // What the operating system lets connect, and not what was configured.
      assert.equal(await reaches("127.0.0.1", sandboxPort), true);
      assert.equal(await reaches("::1", sandboxPort), false);
      for (const address of networkAddresses()) {
        assert.equal(await reaches(address, sandboxPort), false, `the sandbox answers at ${address}`);
        // The application's own start is as it was: `app.listen(port)` with no host is on every interface.
        assert.equal(await reaches(address, originalPort), true, `the original does not answer at ${address}`);
      }
    });

    it("use the real database in the original and no database connection in the sandbox", async () => {
      assert.deepEqual(await (await api(originalPort, "/api/info")).json(), { database: "sqljs" });
      // The sandbox's DataSource is TypeORM on the embedded SQLite runtime.
      assert.deepEqual(await (await api(sandboxPort, "/api/info")).json(), { database: "better-sqlite3" });
      // The application's own database options are read only by the original server.
      assert.match(original.output(), /Connecting to the original database/);
      assert.doesNotMatch(sandbox.output(), /Connecting to the original database/);
    });

    it("expose the same routes, global prefix, pipes, and CORS", async () => {
      const requests: [string, string, unknown?][] = [
        ["GET", "/api/users"],
        ["GET", "/api/categories"],
        ["GET", "/users"],
        ["GET", "/api/users/abc"],
        ["GET", "/api/users/999"],
        ["GET", "/api/categories/none"],
        ["GET", "/api/nothing"],
        ["PUT", "/api/users/1", {}],
        ["DELETE", "/api/users/999"],
      ];
      const answers = async (port: number): Promise<unknown[]> =>
        Promise.all(
          requests.map(async ([method, path, body]) => {
            const response = body === undefined ? await api(port, path, { method }) : await send(port, method, path, body);
            return [method, path, response.status, await response.text()];
          }),
        );
      const fromOriginal = await answers(originalPort);
      assert.deepEqual(await answers(sandboxPort), fromOriginal);
      assert.deepEqual(fromOriginal.map((answer) => (answer as unknown[])[2]), [200, 200, 404, 400, 404, 404, 404, 404, 404]);

      for (const port of [originalPort, sandboxPort]) {
        const response = await api(port, "/api/users", { headers: { origin: "http://frontend.test" } });
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
      }
    });

    it("answer the same request with the same shape, each from its own data", async () => {
      const fromOriginal = await send(originalPort, "POST", "/api/users", { name: "  Original  " });
      const fromSandbox = await send(sandboxPort, "POST", "/api/users", { name: "  Sandbox  " });
      assert.equal(fromOriginal.status, 201);
      assert.equal(fromSandbox.status, 201);

      const originalUser = (await fromOriginal.json()) as Record<string, unknown>;
      const sandboxUser = (await fromSandbox.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(sandboxUser).sort(), Object.keys(originalUser).sort());
      // The global pipe trimmed the name in both.
      assert.deepEqual([originalUser.name, originalUser.id, originalUser.active], ["Original", 1, true]);
      assert.deepEqual([sandboxUser.name, sandboxUser.id, sandboxUser.active], ["Sandbox", 1, true]);
      assert.match(String(sandboxUser.createdAt), /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);

      assert.deepEqual(((await (await api(originalPort, "/api/users")).json()) as { name: string }[]).map((user) => user.name), ["Original"]);
      assert.deepEqual(((await (await api(sandboxPort, "/api/users")).json()) as { name: string }[]).map((user) => user.name), ["Sandbox"]);
      assert.deepEqual((await stored("users")).map((row) => row.name), ["Sandbox"]);
    });
  });

  describe("transactions and QueryBuilder", () => {
    const names = async (port: number, path: string): Promise<string[]> =>
      ((await (await api(port, path)).json()) as { name: string }[]).map((user) => user.name);

    it("commit several writes together on both servers", async () => {
      for (const port of [originalPort, sandboxPort]) {
        const response = await send(port, "POST", "/api/users/batch", { names: ["Tx One", "Tx Two"] });
        assert.equal(response.status, 201);
        assert.deepEqual(((await response.json()) as { name: string }[]).map((user) => user.name), ["Tx One", "Tx Two"]);
      }
      assert.deepEqual((await stored("users")).map((row) => row.name).slice(-2), ["Tx One", "Tx Two"]);
    });

    it("roll back every write of a failed transaction on both servers", async () => {
      const before = await databaseFiles();
      for (const port of [originalPort, sandboxPort]) {
        const count = (await names(port, "/api/users")).length;
        const response = await send(port, "POST", "/api/users/batch", { names: ["Never", "Stored", ""] });
        assert.equal(response.status, 400);
        assert.equal((await names(port, "/api/users")).length, count);
      }
      // No file of the directory changed, and nothing of the attempt is left in it.
      assert.deepEqual(await databaseFiles(), before);
    });

    it("answer a QueryBuilder query the same way on both servers", async () => {
      for (const port of [originalPort, sandboxPort]) {
        assert.deepEqual(await names(port, "/api/users/search?name=Tx"), ["Tx Two", "Tx One"]);
        assert.deepEqual(await names(port, "/api/users/search?name=nobody"), []);
      }
    });
  });

  describe("the sandbox server", () => {
    it("persists create, update, and delete to the database directory", async () => {
      const created = (await (await send(sandboxPort, "POST", "/api/users", { name: "Bo", active: false })).json()) as { id: number };
      assert.deepEqual((await stored("users")).at(-1), { name: "Bo", active: false, createdAt: (await stored("users")).at(-1)?.createdAt, id: created.id });

      const updated = await send(sandboxPort, "PATCH", `/api/users/${created.id}`, { name: " Bo B. " });
      assert.equal(updated.status, 200);
      assert.equal(((await updated.json()) as { name: string }).name, "Bo B.");
      assert.equal((await stored("users")).at(-1)?.name, "Bo B.");

      assert.equal((await api(sandboxPort, `/api/users/${created.id}`, { method: "DELETE" })).status, 200);
      assert.equal((await api(sandboxPort, `/api/users/${created.id}`)).status, 404);
      assert.ok((await stored("users")).every((row) => row.id !== created.id));
    });

    it("serves an entity whose primary key is not named id", async () => {
      assert.equal((await send(sandboxPort, "POST", "/api/categories", { code: "books", label: "Books" })).status, 201);
      assert.deepEqual(await stored("category"), [{ code: "books", label: "Books" }]);

      assert.deepEqual(await (await api(sandboxPort, "/api/categories/books")).json(), { code: "books", label: "Books" });
      const renamed = await send(sandboxPort, "PATCH", "/api/categories/books", { label: "Printed books" });
      assert.deepEqual(await renamed.json(), { code: "books", label: "Printed books" });
      // Saving the same key again updates the row.
      await send(sandboxPort, "POST", "/api/categories", { code: "books", label: "Books again" });
      assert.deepEqual(await stored("category"), [{ code: "books", label: "Books again" }]);

      assert.equal((await api(sandboxPort, "/api/categories/books", { method: "DELETE" })).status, 200);
      assert.equal((await api(sandboxPort, "/api/categories/books")).status, 404);
      assert.deepEqual(await stored("category"), []);
    });

    it("keeps its data across a restart", async () => {
      // One process has a database at a time (D-042), and the sandbox of this suite runs on. What a restart finds is
      // the directory as that sandbox saved it, so the next start is of a copy of the directory.
      const port = await freePort();
      const config = join(dir, ".local-db-sandbox", "restart.config.json");
      await cp(join(dir, "sandbox.db"), join(dir, "restarted.db"), { recursive: true });
      await writeFile(config, JSON.stringify({ entry: "../src/main.ts", database: "../restarted.db", port }));
      const restarted = start(dir, ["--input-type=module", "-e", 'import { runNestSandbox } from "local-db-sandbox"; await runNestSandbox(process.argv[1]);', config]);
      processes.push(restarted);
      await ready(restarted, `http://localhost:${port}/api/info`);
      assert.deepEqual(((await (await api(port, "/api/users")).json()) as { name: string }[]).map((user) => user.name), ["Sandbox", "Tx One", "Tx Two"]);
      await rm(config);
    });

    it("is reached by a Studio attached to it: a row added there without @CreateDateColumn's value gets the time, and the API tab reaches the sandbox (D-047)", async () => {
      const studio = await startStudio({ database: join(dir, "sandbox.db"), port: 0, api: `http://127.0.0.1:${sandboxPort}/api/users` });
      try {
        const page = (path: string, body?: unknown): Promise<Response> =>
          fetch(`${studio.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${studio.key}`, "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
        const status = (await (await page("/api/status")).json()) as { mode: string; info: { kind: string; instance: string } };
        assert.deepEqual([status.mode, status.info.kind], ["attached", "nest"]);
        const createdAt = ((await (await page("/api/access/schema", {})).json()) as any).result.tables.find((table: { name: string }) => table.name === "users").columns.find((column: { name: string }) => column.name === "createdAt");
        assert.deepEqual([createdAt.declaredType, createdAt.nullable, createdAt.generated], ["@CreateDateColumn", false, "insert time"]);

        const before = Date.now();
        const added = (await (await page("/api/access/insert", { for: status.info.instance, request: { table: "users", values: { name: "Added in Studio" } } })).json()) as { result: { lastInsertId: number } };
        const row = (await (await api(sandboxPort, `/api/users/${added.result.lastInsertId}`)).json()) as { name: string; active: boolean; createdAt: string };
        assert.deepEqual([row.name, row.active], ["Added in Studio", true]);
        assert.ok(Date.parse(row.createdAt) >= before - 1000 && Date.parse(row.createdAt) <= Date.now() + 1000, row.createdAt);
        // A time that is given is kept.
        const given = (await (await page("/api/access/insert", { for: status.info.instance, request: { table: "users", values: { name: "Given a time", createdAt: "2020-01-02T03:04:05.000Z" } } })).json()) as { result: { lastInsertId: number } };
        assert.equal(((await (await api(sandboxPort, `/api/users/${given.result.lastInsertId}`)).json()) as { createdAt: string }).createdAt, "2020-01-02T03:04:05.000Z");

        // The API tab sends to the sandbox on 127.0.0.1.
        const sent = (await (await page("/api/request", { request: { method: "GET", url: `http://127.0.0.1:${sandboxPort}/api/users/${added.result.lastInsertId}` } })).json()) as { result: { status: number; body: string } };
        assert.deepEqual([sent.result.status, JSON.parse(sent.result.body).name], [200, "Added in Studio"]);
        const local = (await (await page("/api/request", { request: { method: "GET", url: `http://localhost:${sandboxPort}/api/info` } })).json()) as { result: { status: number } };
        assert.equal(local.result.status, 200);

        for (const id of [added.result.lastInsertId, given.result.lastInsertId]) {
          assert.equal((await api(sandboxPort, `/api/users/${id}`, { method: "DELETE" })).status, 200);
        }
      } finally {
        await studio.stop();
      }
    });

    it("listens on 127.0.0.1 also when the entry point asks for every interface, and keeps that to itself", async () => {
      const port = await freePort();
      const config = join(dir, ".local-db-sandbox", "any-host.config.json");
      const entry = join(dir, ".local-db-sandbox", "any-host.main.ts");
      await cp(join(dir, "sandbox.db"), join(dir, "any-host.db"), { recursive: true });
      // An entry point of the kind that is deployed: it asks for 0.0.0.0. It is the test's, beside the project's sources.
      await writeFile(
        entry,
        'import { NestFactory } from "@nestjs/core";\nimport { AppModule } from "../src/app.module";\n\n' +
          'async function bootstrap() {\n  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });\n  app.setGlobalPrefix("api");\n  await app.listen(3000, "0.0.0.0");\n}\nbootstrap();\n',
      );
      await writeFile(config, JSON.stringify({ entry: "./any-host.main.ts", database: "../any-host.db", port }));
      const running = start(dir, ["--input-type=module", "-e", 'import { runNestSandbox } from "local-db-sandbox"; await runNestSandbox(process.argv[1]);', config]);
      processes.push(running);
      await ready(running, `http://127.0.0.1:${port}/api/info`);
      assert.ok(running.output().includes(`the entry point asked for port 3000 on 0.0.0.0; the sandbox uses ${port} on 127.0.0.1 (this machine only) instead.`), running.output());
      assert.equal(await reaches("127.0.0.1", port), true);
      for (const address of networkAddresses()) {
        assert.equal(await reaches(address, port), false, `the sandbox answers at ${address}`);
      }
      assert.equal((await api(port, "/api/users")).status, 200);
      running.child.kill();
      await running.exited;
      await rm(config);
      await rm(entry);
    });

    it("has its database to itself: a second sandbox on the same directory does not start, and says who has it", async () => {
      const port = await freePort();
      const config = join(dir, ".local-db-sandbox", "second.config.json");
      await writeFile(config, JSON.stringify({ entry: "../src/main.ts", database: "../sandbox.db", port }));
      const before = await databaseFiles();
      const second = start(dir, ["--input-type=module", "-e", 'import { runNestSandbox } from "local-db-sandbox"; await runNestSandbox(process.argv[1]);', config]);
      processes.push(second);
      assert.equal(await second.exited, 1, second.output());
      assert.match(second.output(), new RegExp(`sandbox\\.db is open in the NestJS sandbox \\(pid ${sandbox.child.pid}, since .*\\)\\. One process has a database open to write at a time: stop that one first\\.`));
      // The first runs on, with its database as it was, and its record.
      assert.equal((await api(sandboxPort, "/api/users")).status, 200);
      assert.deepEqual(await databaseFiles(), before);
      const record = JSON.parse(await readFile(join(dir, "sandbox.db.owner.json"), "utf8"));
      assert.deepEqual([record.kind, record.pid, /^http:\/\/127\.0\.0\.1:\d+$/.test(record.control?.url)], ["nest", sandbox.child.pid, true]);
      // Where the first serves is in its record, for whoever attaches to it. Its token is in nothing the second printed.
      assert.match(record.control.token, /^[0-9a-f]{48}$/);
      assert.equal(second.output().includes(record.control.token), false, second.output());
      await rm(config);
    });

    it("is refused a database that a Studio has to itself, and prints nothing of that Studio's token; it starts once that Studio is stopped", async () => {
      // A database of its own: the sandbox of this suite has sandbox.db.
      const [database, port] = [join(dir, "studio-owned.db"), await freePort()];
      await cp(join(dir, "sandbox.db"), database, { recursive: true });
      const config = join(dir, ".local-db-sandbox", "studio-owned.config.json");
      await writeFile(config, JSON.stringify({ entry: "../src/main.ts", database: "../studio-owned.db", port }));
      const command = ["--input-type=module", "-e", 'import { runNestSandbox } from "local-db-sandbox"; await runNestSandbox(process.argv[1]);', config];

      const studio = await startStudio({ database, port: 0 });
      try {
        const page = (path: string, body?: unknown): Promise<Response> =>
          fetch(`${studio.url}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${studio.key}`, "content-type": "application/json" }, ...(body !== undefined && { body: JSON.stringify(body) }) });
        assert.equal(studio.mode, "standalone");
        const record = JSON.parse(await readFile(`${database}.owner.json`, "utf8"));
        assert.deepEqual([record.kind, record.pid], ["studio", process.pid]);
        assert.match(record.control.token, /^[0-9a-f]{48}$/);
        const before = await filesOf(database);

        const refused = start(dir, command);
        processes.push(refused);
        assert.equal(await refused.exited, 1, refused.output());
        // All that the process wrote, to either stream. NestJS prints an error that ends a start with all the error holds, not its message alone.
        const printed = refused.output();
        assert.match(
          printed,
          new RegExp(
            `studio-owned\\.db is open in Local DB Studio \\(pid ${process.pid}, since ${record.startedAt.replaceAll(".", "\\.")}\\)\\. One process has a database open to write at a time: stop that one first\\. ` +
              "That Studio has the database to itself\\. To run the sandbox on it: stop that Studio \\(Ctrl\\+C in its terminal\\), start the sandbox, and start Studio again\\.",
          ),
        );
        assert.equal(printed.includes(record.control.token), false, printed);
        assert.equal(printed.includes(studio.key), false, printed);

        // Studio runs on: the database is as it was and is still Studio's, and Studio reads and changes it.
        assert.deepEqual(await filesOf(database), before);
        assert.deepEqual(JSON.parse(await readFile(`${database}.owner.json`, "utf8")), record);
        const status = (await (await page("/api/status")).json()) as { mode: string; connected: boolean; info: { kind: string; instance: string } };
        assert.deepEqual([status.mode, status.connected, status.info.kind, status.info.instance], ["standalone", true, "studio", record.instance]);
        const added = await page("/api/access/insert", { for: record.instance, request: { table: "users", values: { name: "Added while a sandbox was refused" } } });
        assert.equal(added.status, 200, await added.clone().text());
        const users = (await (await page("/api/access/browse", { request: { table: "users", filters: [{ column: "name", op: "eq", value: "Added while a sandbox was refused" }] } })).json()) as { result: { total: number } };
        assert.equal(users.result.total, 1);
      } finally {
        await studio.stop();
      }

      // The way the refusal names: once that Studio is stopped, the sandbox starts on the database, with what Studio wrote.
      assert.equal(statSync(`${database}.owner.json`, { throwIfNoEntry: false }), undefined);
      const running = start(dir, command);
      processes.push(running);
      await ready(running, `http://127.0.0.1:${port}/api/info`);
      const names = ((await (await api(port, "/api/users")).json()) as { name: string }[]).map((user) => user.name);
      assert.ok(names.includes("Added while a sandbox was refused"), names.join(", "));
      const owner = JSON.parse(await readFile(`${database}.owner.json`, "utf8"));
      assert.deepEqual([owner.kind, owner.pid], ["nest", running.child.pid]);
      running.child.kill();
      await running.exited;
      await rm(config);
    });

    it("can be queried with the SQL console from its directory, which finds the definitions in it", async () => {
      const tables = await cli("sql", join(dir, "sandbox.db"), "--read-only", ".tables");
      assert.deepEqual([tables.code, tables.stderr], [0, ""]);
      assert.match(tables.stdout, /^category {2}0 {5}stored schema$/m);
      assert.match(tables.stdout, /^users {5}3 {5}stored schema$/m);
      const users = await cli("sql", join(dir, "sandbox.db"), "--read-only", "--json", "SELECT name, active FROM users ORDER BY id");
      assert.deepEqual(JSON.parse(users.stdout).rows, [{ name: "Sandbox", active: 1 }, { name: "Tx One", active: 1 }, { name: "Tx Two", active: 1 }]);
    });

    it("does not start on a database directory of an earlier format, and serves it once it has been migrated", async () => {
      // The sandbox's data in a directory as a build of format 2 left it: plain file names, and a manifest without generation and schema.
      const [single, old] = [join(dir, "export.db.json"), join(dir, "format-2.db")];
      assert.equal((await cli("convert", join(dir, "sandbox.db"), "--out", single, "--no-entities")).code, 0);
      assert.equal((await cli("convert", single, "--out", old, "--no-entities")).code, 0);
      const { minimumReaderVersion: _reader, generation: _generation, schema: _schema, ...manifest } = JSON.parse(await readFile(join(old, "manifest.json"), "utf8"));
      await writeFile(join(old, "manifest.json"), JSON.stringify({ ...manifest, formatVersion: 2 }, null, 2));
      const before = await filesOf(old);

      const port = await freePort();
      const config = join(dir, ".local-db-sandbox", "format.config.json");
      await writeFile(config, JSON.stringify({ entry: "../src/main.ts", database: "../format-2.db", port }));
      const command = ["--input-type=module", "-e", 'import { runNestSandbox } from "local-db-sandbox"; await runNestSandbox(process.argv[1]);', config];

      const refused = start(dir, command);
      processes.push(refused);
      assert.notEqual(await refused.exited, 0, refused.output());
      assert.match(refused.output(), /format-2\.db: Database format 2 is older than the format this build writes \(5\)\. It can be read as it is, and was not changed\. To change it, migrate it first: local-db-sandbox migrate /);
      assert.deepEqual(await filesOf(old), before);

      const migrated = await cli("migrate", old);
      assert.equal(migrated.code, 0, migrated.stderr);
      const running = start(dir, command);
      processes.push(running);
      await ready(running, `http://localhost:${port}/api/info`);
      assert.deepEqual(((await (await api(port, "/api/users")).json()) as { name: string }[]).map((user) => user.name), ["Sandbox", "Tx One", "Tx Two"]);
      const created = (await (await send(port, "POST", "/api/users", { name: "Migrated", active: true })).json()) as { id: number };
      assert.equal((await storedRows(old, "users")).at(-1)?.id, created.id);
      // The commit wrote the table it changed, in a file of the next generation, and no other. (Generation 2 is the migration's, which wrote the schema file again.)
      assert.match(tableFile(old, "users"), /users\.g3\.json$/);
      assert.match(tableFile(old, "category"), /category\.json$/);
      await rm(config);
    });
  });

  describe("the application", () => {
    it("has no changed source file", async () => {
      assert.deepEqual(await sourceFiles(dir), sourcesBefore);
      assert.equal(Object.keys(sourcesBefore).length, 16);
    });
  });

  describe("unsupported applications", () => {
    const entryWith = async (name: string, source: string): Promise<string> => {
      await mkdir(join(dir, "unsupported"), { recursive: true });
      await writeFile(join(dir, "unsupported", name), source);
      return join(dir, "unsupported", name);
    };
    const refused = (message: RegExp) => (error: unknown): boolean => {
      assert.ok(error instanceof NestSandboxError, String(error));
      assert.match(error.message, message);
      return true;
    };
    /** Runs an entry point in sandbox mode and returns how the process ended. */
    const run = async (entry: string): Promise<{ code: number | null; output: string }> => {
      const config = join(dir, "unsupported", "sandbox.config.json");
      await writeFile(config, JSON.stringify({ entry, database: "../sandbox.db", port: await freePort() }));
      const running = start(dir, ["--input-type=module", "-e", 'import { runNestSandbox } from "local-db-sandbox"; await runNestSandbox(process.argv[1]);', config]);
      processes.push(running);
      const timer = setTimeout(() => running.child.kill(), 30_000);
      const code = await running.exited;
      clearTimeout(timer);
      return { code, output: running.output() };
    };

    after(async () => {
      await rm(join(dir, "unsupported"), { recursive: true, force: true });
    });

    it("are refused by init-nest when the entry point cannot be reused", async () => {
      const bootstrap = (body: string): string => `import { NestFactory } from "@nestjs/core";\nimport { AppModule } from "../src/app.module";\nasync function bootstrap() {\n${body}\n}\nbootstrap();\n`;

      const delegated = await entryWith("delegated.ts", 'import { bootstrap } from "./bootstrap";\nbootstrap();\n');
      await assert.rejects(initNest({ entry: delegated }), refused(/does not call NestFactory\.create\(<RootModule>\)/));

      const microservice = await entryWith("microservice.ts", bootstrap("  const app = await NestFactory.createMicroservice(AppModule);\n  await app.listen();"));
      await assert.rejects(initNest({ entry: microservice }), refused(/NestFactory\.createMicroservice\(\)\. Only HTTP applications/));

      const noListen = await entryWith("no-listen.ts", bootstrap("  const app = await NestFactory.create(AppModule);\n  await app.init();\n  // await app.listen(3000);"));
      await assert.rejects(initNest({ entry: noListen }), refused(/does not call app\.listen\(\)/));

      const samePort = await entryWith("same-port.ts", bootstrap("  const app = await NestFactory.create(AppModule);\n  await app.listen(3001);"));
      await assert.rejects(initNest({ entry: samePort, port: 3001 }), refused(/listens on port 3001\. Choose a different sandbox port/));

      // The entry point is fine, but nothing next to it sets up TypeORM's root module.
      const noTypeorm = await entryWith("no-typeorm.ts", bootstrap("  const app = await NestFactory.create(AppModule);\n  await app.listen(3000);"));
      await assert.rejects(initNest({ entry: noTypeorm, port: 3002 }), refused(/No TypeOrmModule\.forRoot\(\) or forRootAsync\(\) call was found/));

      await assert.rejects(initNest({ cwd: dir, entry: "src/missing.ts" }), refused(/Entry point does not exist/));
      const failed = await cli("init-nest", delegated);
      assert.equal(failed.code, 1);
      assert.match(failed.stderr, /^Error: .*does not call NestFactory\.create/);
    });

    it("stop with a diagnostic when they use a named data source", async () => {
      const entry = await entryWith(
        "named.ts",
        'import { Module } from "@nestjs/common";\nimport { NestFactory } from "@nestjs/core";\nimport { TypeOrmModule } from "@nestjs/typeorm";\n\n' +
          '@Module({ imports: [TypeOrmModule.forRoot({ name: "reports", type: "sqljs" })] })\nclass NamedModule {}\n\n' +
          "NestFactory.create(NamedModule).then((app) => app.listen(3000));\n",
      );
      const { code, output } = await run(entry);
      assert.equal(code, 1);
      assert.match(output, /Error: TypeOrmModule\.forRoot\(\) was called for the data source "reports"\. Sandbox mode replaces the default data source only/);
    });

    it("stop instead of connecting when they create their own DataSource", async () => {
      const entry = await entryWith(
        "own-data-source.ts",
        'import { Module } from "@nestjs/common";\nimport { NestFactory } from "@nestjs/core";\nimport { DataSource } from "typeorm";\n\n' +
          '@Module({ providers: [{ provide: "DATA_SOURCE", useFactory: () => new DataSource({ type: "sqljs" }).initialize() }] })\nclass OwnModule {}\n\n' +
          'NestFactory.create(OwnModule, { logger: ["error"] }).then((app) => app.listen(3000));\n',
      );
      const { code, output } = await run(entry);
      assert.notEqual(code, 0);
      assert.match(output, /A TypeORM DataSource \(type "sqljs"\) was about to connect to a real database in sandbox mode/);
    });

    it("stop instead of listening when TypeORM was never replaced", async () => {
      const entry = await entryWith(
        "no-typeorm-module.ts",
        'import { Module } from "@nestjs/common";\nimport { NestFactory } from "@nestjs/core";\n\n@Module({})\nclass PlainModule {}\n\n' +
          'NestFactory.create(PlainModule, { logger: ["error"] }).then((app) => app.listen(3000));\n',
      );
      const { code, output } = await run(entry);
      assert.notEqual(code, 0);
      assert.match(output, /starting without having called TypeOrmModule\.forRoot\(\) or forRootAsync\(\)/);
    });
  });
});

/*
 * Regression test for the failure of a real application's sandbox server:
 *
 *   TypeError: Class constructor SandboxSqliteConnection cannot be invoked without 'new'
 *
 * That application has TypeORM 0.3.17, whose better-sqlite3 driver creates its
 * connection with a plain call (`this.sqlite(database, options)`); the TypeORM
 * this repository develops against uses `new`. Here the same fixture project
 * is installed with TypeORM 0.3.17 and started the way the application is:
 * `init-nest` from the command line, then the generated sandbox entry point.
 * The project's own code, @nestjs/typeorm, and the sandbox all load that one
 * TypeORM, as they do in an application that has it installed.
 */
describe("NestJS project on TypeORM 0.3.17 with a sandbox server", { timeout: 180_000 }, () => {
  let dir: string;
  let port: number;
  let sandbox: Running;
  let init: Running;
  const processes: Running[] = [];

  const api = (path: string, options?: RequestInit): Promise<Response> => fetch(`http://localhost:${port}${path}`, options);
  const send = (method: string, path: string, body: unknown): Promise<Response> =>
    api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // A new project's database is a directory: one file of rows per table.
  const stored = (collection: string): Promise<Record<string, unknown>[]> => storedRows(join(dir, "sandbox.db"), collection);
  const databaseFiles = (): Promise<Record<string, string>> => filesOf(join(dir, "sandbox.db"));
  const names = async (path: string): Promise<string[]> => ((await (await api(path)).json()) as { name: string }[]).map((user) => user.name);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-nest-typeorm-0317-"));
    await cp(fixture, dir, { recursive: true });

    // What `npm install` would provide for a project that depends on typeorm@0.3.17.
    const installed = join(dir, "node_modules");
    await mkdir(join(installed, "@nestjs"), { recursive: true });
    await mkdir(join(installed, "local-db-sandbox"));
    for (const name of ["@nestjs/common", "@nestjs/core", "@nestjs/platform-express", "typescript", "reflect-metadata", "rxjs"]) {
      await symlink(join(repository, "node_modules", name), join(installed, name), "junction");
    }
    await symlink(join(repository, "node_modules", "typeorm-0.3.17"), join(installed, "typeorm"), "junction");
    // A copy, not a link: a linked package would resolve `typeorm` from this repository instead of from the project.
    await cp(join(repository, "node_modules", "@nestjs", "typeorm"), join(installed, "@nestjs", "typeorm"), { recursive: true });
    const entryPoint = pathToFileURL(join(repository, "packages/cli/src/index.ts")).href;
    await writeFile(join(installed, "local-db-sandbox/package.json"), JSON.stringify({ name: "local-db-sandbox", type: "module", exports: "./index.js" }));
    await writeFile(join(installed, "local-db-sandbox/index.js"), `export * from ${JSON.stringify(entryPoint)};\n`);

    port = await freePort();
    init = start(dir, [join(repository, "packages/cli/src/bin.ts"), "init-nest", "src/main.ts", "--port", String(port)]);
    assert.equal(await init.exited, 0, init.output());

    sandbox = start(dir, [".local-db-sandbox/sandbox.server.ts"]);
    processes.push(sandbox);
    await ready(sandbox, `http://localhost:${port}/api/info`);
  });

  after(async () => {
    for (const running of processes) {
      running.child.kill();
      await running.exited;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("is a project whose TypeORM is 0.3.17", async () => {
    const resolved = createRequire(join(dir, "package.json")).resolve("typeorm");
    assert.equal(JSON.parse(await readFile(join(dirname(resolved), "package.json"), "utf8")).version, "0.3.17");
    assert.match(init.output(), /Imported 2 TypeORM entities from src/);
  });

  it("starts: TypeORM's own SQLite driver connects to the sandbox runtime, and no real database is used", async () => {
    assert.deepEqual(await (await api("/api/info")).json(), { database: "better-sqlite3" });
    assert.match(sandbox.output(), /Local DB Sandbox: application running at http:/);
    assert.doesNotMatch(sandbox.output(), /cannot be invoked without 'new'/);
    assert.doesNotMatch(sandbox.output(), /Connecting to the original database/);
  });

  it("serves the application's routes and persists writes to the database directory", async () => {
    const created = await send("POST", "/api/users", { name: "  Ada  " });
    assert.equal(created.status, 201);
    const ada = (await created.json()) as { id: number; name: string; active: boolean; createdAt: string };
    assert.deepEqual([ada.id, ada.name, ada.active], [1, "Ada", true]);
    assert.deepEqual(await stored("users"), [{ id: 1, name: "Ada", active: true, createdAt: ada.createdAt }]);

    // Each request that writes saves the table it changed. The other table's file is not written again.
    const categoryFile = tableFile(join(dir, "sandbox.db"), "category");
    const category = statSync(categoryFile, { bigint: true });
    assert.equal(((await (await send("PATCH", "/api/users/1", { name: "Ada L." })).json()) as { name: string }).name, "Ada L.");
    assert.equal((await stored("users"))[0]?.name, "Ada L.");
    assert.equal(tableFile(join(dir, "sandbox.db"), "category"), categoryFile);
    assert.deepEqual([statSync(categoryFile, { bigint: true }).ino, statSync(categoryFile, { bigint: true }).mtimeNs], [category.ino, category.mtimeNs]);
    assert.match(tableFile(join(dir, "sandbox.db"), "users"), /users\.g\d+\.json$/);
    assert.equal((await api("/api/users/abc")).status, 400);
    assert.equal((await api("/users")).status, 404);

    // An entity whose primary key is not named id.
    assert.equal((await send("POST", "/api/categories", { code: "books", label: "Books" })).status, 201);
    assert.deepEqual(await (await api("/api/categories/books")).json(), { code: "books", label: "Books" });
    assert.equal((await api("/api/categories/books", { method: "DELETE" })).status, 200);
    assert.deepEqual(await stored("category"), []);
  });

  it("commits and rolls back DataSource.transaction, and answers a QueryBuilder query", async () => {
    assert.equal((await send("POST", "/api/users/batch", { names: ["Tx One", "Tx Two"] })).status, 201);
    assert.deepEqual((await stored("users")).map((row) => row.name), ["Ada L.", "Tx One", "Tx Two"]);

    const before = await databaseFiles();
    assert.equal((await send("POST", "/api/users/batch", { names: ["Never", "Stored", ""] })).status, 400);
    assert.deepEqual(await databaseFiles(), before);
    assert.deepEqual(await names("/api/users"), ["Ada L.", "Tx One", "Tx Two"]);

    assert.deepEqual(await names("/api/users/search?name=Tx"), ["Tx Two", "Tx One"]);

    assert.equal((await api("/api/users/1", { method: "DELETE" })).status, 200);
    assert.deepEqual((await stored("users")).map((row) => row.id), [2, 3]);
  });
});
