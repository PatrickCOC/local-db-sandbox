import assert from "node:assert/strict";
import { execFile, execSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const root = join(import.meta.dirname, "../../..");
const NAME = "local-db-sandbox";

/*
 * Packs the package, installs the tarball into an empty project, and uses it
 * only through what the package publishes: its `bin` and its `exports`.
 */
describe("installed package", { timeout: 240_000 }, () => {
  let dir: string;
  let consumer: string;
  let installed: string;
  let child: ChildProcess | undefined;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-pkg-"));
    consumer = join(dir, "consumer");
    await mkdir(consumer);

    // A sandbox that was killed while it had the example database open leaves the record of its owner beside it (D-042).
    const leftBehind = join(root, "examples/basic/db.json.owner.json");
    await writeFile(leftBehind, JSON.stringify({ version: 1, pid: 1, startedAt: "2026-01-02T03:04:05.000Z", instance: "0".repeat(48), kind: "rest", database: join(root, "examples/basic/db.json") }));
    try {
      // `npm pack` runs the `prepare` script, which builds dist/.
      execSync(`npm pack --pack-destination "${dir}"`, { cwd: root, stdio: "pipe" });
    } finally {
      await rm(leftBehind, { force: true });
    }
    const tarball = (await readdir(dir)).find((file) => file.endsWith(".tgz"));
    assert.ok(tarball, "npm pack produced a tarball");

    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
    execSync(`npm install "${join(dir, tarball)}" --offline --no-audit --no-fund`, { cwd: consumer, stdio: "pipe" });
    installed = join(consumer, "node_modules", NAME);
    await copyFile(join(installed, "examples/basic/db.json"), join(consumer, "db.json"));
  });

  after(async () => {
    child?.kill();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("ships the build output and no sources or tests", async () => {
    const top = await readdir(installed);
    assert.ok(top.includes("dist"));
    assert.ok(top.includes("README.md"));
    assert.ok(!top.includes("packages"));
    assert.deepEqual(await readdir(join(installed, "dist/packages/cli")), ["src"]);
    // The example database, and not the record of whoever had it open when the package was packed.
    assert.deepEqual(await readdir(join(installed, "examples/basic")), ["db.json"]);
    // The three runtime dependencies: PostgreSQL's parser for the migration collector (D-034), with its types package;
    // the client that init-pg reads a server's catalog with (D-049), which has none of its own; and the layout of
    // Studio's ER diagram (D-053), with its graph library.
    assert.deepEqual(await readdir(join(consumer, "node_modules")).then((names) => names.filter((n) => !n.startsWith("."))), [
      "@dagrejs",
      "@pgsql",
      "libpg-query",
      NAME,
      "postgres",
    ]);
    assert.deepEqual(await readdir(join(consumer, "node_modules/@dagrejs")), ["dagre", "graphlib"]);
  });

  it("installs a runnable command", async () => {
    const shim = join(consumer, "node_modules/.bin", process.platform === "win32" ? `${NAME}.cmd` : NAME);
    assert.ok(existsSync(shim), "command shim is installed");

    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    const { stdout } = await promisify(execFile)(process.execPath, [join(installed, manifest.bin[NAME]), "--version"]);
    assert.equal(stdout.trim(), manifest.version);
  });

  it("serves a JSON file, logs requests, and persists changes through the command", async () => {
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    child = spawn(process.execPath, [join(installed, manifest.bin[NAME]), "db.json", "--port", "0", "--verbose"], {
      cwd: consumer,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => child?.once("exit", (code) => resolve(code)));

    const url = await new Promise<string>((resolve, reject) => {
      const check = (): void => {
        const match = /running at (http:\S+)/.exec(output);
        if (match) {
          resolve(match[1] as string);
        }
      };
      child?.stdout?.on("data", check);
      void exited.then((code) => reject(new Error(`exited with ${code}: ${output}`)));
    });

    assert.equal(((await (await fetch(`${url}/users?active=true`)).json()) as unknown[]).length, 1);
    const created = await fetch(`${url}/orders`, { method: "POST", body: JSON.stringify({ total: 9 }) });
    assert.equal(created.status, 201);
    assert.equal((await fetch(`${url}/orders/99`)).status, 404);

    const stored = JSON.parse(await readFile(join(consumer, "db.json"), "utf8"));
    assert.deepEqual(stored.data.orders.at(-1), { id: 2, total: 9 });

    // Log lines are written before each response is delivered. What the command wrote reaches this process through a
    // pipe, which can be a moment after the answer to the last request has arrived: waited for, and then asserted.
    for (let waited = 0; !/GET {3}\/orders\/99/.test(output) && waited < 100; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(output, /GET {3}\/users\?active=true {2}200 {2}1 row {2}local=[\d.]+ms total=[\d.]+ms/);
    assert.match(output, /SELECT \* FROM users WHERE active = 'true'/);
    assert.match(output, /POST {2}\/orders {2}201 {2}1 row/);
    assert.match(output, /INSERT INTO orders \(id, total\) VALUES \(2, 9\)/);
    assert.match(output, /GET {3}\/orders\/99 {2}404 .*ROW_NOT_FOUND/);

    if (process.platform === "win32") {
      // Windows cannot deliver SIGINT/SIGTERM to a child process; kill() ends it
      // without running handlers. Signal handling is covered in cli.test.ts.
      child.kill();
      await exited;
    } else {
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
      assert.match(output, /Stopped\.\n$/);
    }
    child = undefined;
    await assert.rejects(fetch(`${url}/users`));
  });

  it("can be imported as a library", async () => {
    await writeFile(
      join(consumer, "check.mjs"),
      `import { startSandbox, formatRequestEvent } from "${NAME}";
const events = [];
const sandbox = await startSandbox({ file: "db.json", port: 0, onRequest: (event) => events.push(event) });
const users = await (await fetch(sandbox.url + "/users")).json();
await sandbox.stop();
console.log(JSON.stringify({ users: users.length, line: formatRequestEvent(events[0]), collections: sandbox.database.listCollections() }));
`,
    );
    const { stdout } = await promisify(execFile)(process.execPath, ["check.mjs"], { cwd: consumer });
    const result = JSON.parse(stdout);
    assert.equal(result.users, 2);
    assert.deepEqual(result.collections, ["users", "orders"]);
    assert.match(result.line, /GET {3}\/users {2}200 {2}2 rows/);
  });

  it("provides type declarations that a TypeScript consumer can use", async () => {
    await writeFile(
      join(consumer, "check.ts"),
      `import { startSandbox } from "${NAME}";
import type { RequestEvent, RunningSandbox } from "${NAME}";
const events: RequestEvent[] = [];
const sandbox: RunningSandbox = await startSandbox({ file: "db.json", onRequest: (event) => events.push(event) });
const port: number = sandbox.port;
await sandbox.stop();
export { port };
`,
    );
    const tsc = join(root, "node_modules/typescript/bin/tsc");
    await promisify(execFile)(
      process.execPath,
      [tsc, "check.ts", "--noEmit", "--strict", "--module", "nodenext", "--target", "es2022"],
      { cwd: consumer },
    ).catch((error: { stdout?: string }) => assert.fail(`tsc failed:\n${error.stdout}`));
  });
});
