import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { closeSync, openSync, readFileSync, utimesSync, watch as watchFiles } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, before, describe, it } from "node:test";
import { formatOperationEvent, formatRequestEvent, runCli, startSandbox } from "../../cli/src/index.ts";
import type { OperationEvent, RequestEvent } from "../../cli/src/index.ts";
import { initNest, watchNestSandbox } from "../src/index.ts";
import type { NestSandboxWatch, SandboxWatchEvent } from "../src/index.ts";
import { createNestProject, databaseFiles, freePort, isAlive, isPortFree, start, storedRows, until } from "./support/nest-project.ts";
import type { Running } from "./support/nest-project.ts";

/*
 * `npm run sandbox` with hot reload: a watcher process runs the generated
 * sandbox entry point as a child process and restarts it when the
 * application's sources change. The project is a copy of
 * fixtures/nest-project; "editing the application" means rewriting files of
 * that copy while the sandbox runs.
 */
describe("sandbox server that restarts on source changes", { timeout: 240_000 }, () => {
  let dir: string;
  let port: number;
  let config: string;
  let infoController: string;
  let watch: NestSandboxWatch | undefined;
  let events: SandboxWatchEvent[];
  let output: string;
  let signals: EventEmitter;
  const spawned: Running[] = [];

  const url = (path: string): string => `http://localhost:${port}${path}`;
  const info = async (): Promise<Record<string, unknown>> => (await (await fetch(url("/api/info"))).json()) as Record<string, unknown>;
  const pids = (type: "started" | "exited"): number[] => events.flatMap((event) => (event.type === type ? [event.pid] : []));
  // A new project's database is a directory: one file of rows per table.
  const stored = (collection: string): Promise<Record<string, unknown>[]> => storedRows(join(dir, "sandbox.db"), collection);
  /** Edits the application: the info route now also returns `revision`. */
  const editApplication = async (revision: unknown): Promise<void> => {
    const source = await readFile(join(import.meta.dirname, "fixtures/nest-project/src/info.controller.ts"), "utf8");
    await writeFile(infoController, source.replace("{ database: this.dataSource.options.type }", `{ database: this.dataSource.options.type, revision: ${JSON.stringify(revision)} } as any`));
  };
  const serves = (revision: unknown): Promise<void> =>
    until(async () => (await info()).revision === revision, () => `the sandbox never served revision ${String(revision)}\n${output}\n${JSON.stringify(events)}`);

  const startWatching = async (args: string[] = []): Promise<void> => {
    events = [];
    output = "";
    signals = new EventEmitter();
    watch = watchNestSandbox({
      configFile: config,
      args,
      debounceMs: 100,
      log: (line) => (output += `${line}\n`),
      output: { stdout: { write: (text) => (output += text) }, stderr: { write: (text) => (output += text) } },
      signals,
      onEvent: (event) => events.push(event),
    });
    await until(async () => (await fetch(url("/api/info"))).ok, () => `the sandbox did not start\n${output}`);
  };

  before(async () => {
    dir = await createNestProject();
    port = await freePort();
    config = join(dir, ".local-db-sandbox", "sandbox.config.json");
    infoController = join(dir, "src", "info.controller.ts");
    await initNest({ cwd: dir, port });
  });
  afterEach(async () => {
    await watch?.stop();
    watch = undefined;
    for (const running of spawned.splice(0)) {
      running.child.kill();
      await running.exited;
    }
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("is what the generated sandbox script runs", async () => {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(manifest.scripts.sandbox, "node .local-db-sandbox/sandbox.server.ts --watch");
  });

  it("restarts with the changed code, on the same port, with the data that was saved", async () => {
    await startWatching();
    assert.deepEqual(await info(), { database: "better-sqlite3" });
    const created = await fetch(url("/api/users"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ada" }) });
    assert.equal(created.status, 201);
    const filesBefore = await databaseFiles(join(dir, "sandbox.db"));

    await editApplication(2);
    await serves(2);

    // The old process is gone and a new one answers on the same port.
    const [first, second] = pids("started");
    assert.equal(pids("started").length, 2, JSON.stringify(events));
    // That the first has ended is what the watcher saw of it. Its process number is not asked whether it is alive:
    // Windows gives the number of a process that has ended to another one soon after, and a test run starts many.
    assert.deepEqual(pids("exited"), [first]);
    assert.equal(isAlive(second as number), true);
    assert.deepEqual(events.map((event) => event.type), ["started", "changed", "exited", "started"]);
    assert.deepEqual(events[1], { type: "changed", files: ["src/info.controller.ts"] });
    assert.match(output, /\[sandbox\] src\/info\.controller\.ts changed; restarting/);

    // The restart rebuilt the runtime from the database directory; nothing was regenerated or lost.
    assert.deepEqual(await databaseFiles(join(dir, "sandbox.db")), filesBefore);
    assert.deepEqual(((await (await fetch(url("/api/users"))).json()) as { name: string }[]).map((user) => user.name), ["Ada"]);
  });

  it("does not restart for the database, generated files, dependencies, or build output", async () => {
    await startWatching();
    await fetch(url("/api/users"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Bo" }) });
    assert.ok((await stored("users")).some((row) => row.name === "Bo"));
    for (const path of ["dist/main.js", "build/out.js", ".git/HEAD", ".local-db-sandbox/notes.txt", "node_modules/.package-lock.json", "src/main.ts~", "README.md"]) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), "changed");
    }
    await delay(800);
    assert.deepEqual(events.map((event) => event.type), ["started"]);
  });

  it("does not restart when files are only read or opened", async () => {
    // On Windows a read is reported as a change: NTFS writes the last-access time of a file that was
    // not read for about an hour, and fs.watch passes that on. Setting the last-access time back makes
    // every read of the loop such a first read. The modification time is set to the same value each time.
    const view = join(dir, "src", "views", "welcome.ejs");
    await mkdir(join(view, ".."), { recursive: true });
    await writeFile(view, "<p>Welcome, <%= name %></p>\n");
    const files = [view, infoController, join(dir, "src", "main.ts"), join(dir, "package.json"), join(dir, "tsconfig.json")];
    const modified = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    const longAgo = new Date(modified.getTime() - 2 * 86_400_000);
    for (const file of files) {
      utimesSync(file, longAgo, modified);
    }
    await startWatching();
    const [pid] = pids("started");

    // What the operating system reports for the same folders, to show that the reads below were noticed at all.
    const reported: string[] = [];
    const observers = [
      watchFiles(join(dir, "src"), { recursive: true }, (event, name) => reported.push(`${event}:${name}`)),
      watchFiles(dir, (event, name) => reported.push(`${event}:${name}`)),
    ];
    try {
      for (let round = 0; round < 5; round += 1) {
        for (const file of files) {
          utimesSync(file, longAgo, modified);
          readFileSync(file);
          closeSync(openSync(file, "r"));
        }
        await delay(250);
        assert.equal((await fetch(url("/api/info"))).status, 200);
      }
      await delay(800);
    } finally {
      for (const observer of observers) {
        observer.close();
      }
    }

    assert.ok(reported.some((entry) => entry.endsWith("welcome.ejs")), `no file event was reported for the reads: ${JSON.stringify(reported)}`);
    assert.deepEqual(events, [{ type: "started", pid }]);
    assert.equal(isAlive(pid as number), true);
    assert.doesNotMatch(output, /restarting/);
    assert.equal((await fetch(url("/api/info"))).status, 200);
  });

  it("restarts when a file's modification time changes although its content does not (touch)", async () => {
    await startWatching();
    const content = await readFile(infoController, "utf8");
    const now = new Date();
    utimesSync(infoController, now, now);
    await until(async () => pids("started").length === 2 && (await fetch(url("/api/info"))).ok, () => `touching a source file did not restart the sandbox\n${output}`);
    assert.deepEqual(events[1], { type: "changed", files: ["src/info.controller.ts"] });
    assert.equal(await readFile(infoController, "utf8"), content);
  });

  it("restarts when source files are added, removed, or moved with their folder", async () => {
    await startWatching();
    const restarted = (count: number): Promise<void> =>
      until(async () => pids("started").length === count && (await fetch(url("/api/info"))).ok, () => `expected ${count - 1} restarts\n${output}\n${JSON.stringify(events)}`);
    const changes = (): string[][] => events.flatMap((event) => (event.type === "changed" ? [event.files] : []));

    await mkdir(join(dir, "src", "mail"), { recursive: true });
    await writeFile(join(dir, "src", "mail", "notice.ejs"), "<p>Notice</p>\n");
    await restarted(2);
    await rename(join(dir, "src", "mail"), join(dir, "src", "letters"));
    await restarted(3);
    await rm(join(dir, "src", "letters"), { recursive: true });
    await restarted(4);

    assert.deepEqual(changes(), [["src/mail/notice.ejs"], ["src/letters/notice.ejs", "src/mail/notice.ejs"], ["src/letters/notice.ejs"]]);
  });

  it("never runs two sandbox processes, however quickly files change", async () => {
    await startWatching();
    for (let revision = 10; revision < 16; revision += 1) {
      await editApplication(revision);
      await writeFile(join(dir, "src", `scratch-${revision}.ts`), `export const revision = ${revision};\n`);
      await delay(40);
    }
    await serves(15);
    await delay(500);

    // Every process had exited before the next one started, and one is left.
    const order = events.filter((event) => event.type !== "changed").map((event) => event.type);
    assert.deepEqual(order, order.map((_, index) => (index % 2 === 0 ? "started" : "exited")), JSON.stringify(events));
    const started = pids("started");
    assert.deepEqual(pids("exited"), started.slice(0, -1));
    assert.equal(isAlive(started.at(-1) as number), true);
    assert.ok(started.length <= 4, `restarted ${started.length - 1} times for one burst of changes`);
    assert.equal((await info()).revision, 15);
  });

  it("keeps watching when the application fails to start, and recovers with the next change", async () => {
    await startWatching();
    const [first] = pids("started");
    await writeFile(infoController, "this is not TypeScript {{{\n");
    await until(() => events.filter((event) => event.type === "exited").length === 2, () => `the broken application did not end\n${output}`);
    assert.match(output, /\[sandbox\] the sandbox process ended \(code 1\); waiting for changes to start it again/);
    assert.ok(pids("exited").includes(first as number));
    assert.equal(await isPortFree(port), true);

    await editApplication(20);
    await serves(20);
    assert.equal(pids("started").length, 3);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`stops the watcher and the sandbox process on ${signal}, leaving the port free`, async () => {
      await startWatching();
      const [pid] = pids("started");

      signals.emit(signal);
      await watch?.closed;

      assert.deepEqual(pids("exited"), [pid]);
      assert.equal(events.at(-1)?.type, "stopped");
      assert.equal(await isPortFree(port), true);
      // Nothing restarts it afterwards.
      await editApplication(30);
      await delay(600);
      assert.equal(pids("started").length, 1);
      assert.equal(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM"), 0);
    });
  }

  it("works as the command itself, and its sandbox process does not outlive it", async () => {
    await editApplication(40);
    const watcher = start(dir, [".local-db-sandbox/sandbox.server.ts", "--watch"]);
    spawned.push(watcher);
    await until(async () => (await info()).revision === 40, () => `the watching command did not start the sandbox\n${watcher.output()}`);
    assert.match(watcher.output(), /\[sandbox\] watching src for changes/);

    await editApplication(41);
    await until(async () => (await info()).revision === 41, () => `the watching command did not restart the sandbox\n${watcher.output()}`);
    assert.match(watcher.output(), /\[sandbox\] src\/info\.controller\.ts changed; restarting/);

    // Killing the watcher outright runs none of its handlers; the sandbox process notices and ends.
    watcher.child.kill();
    await watcher.exited;
    await until(() => isPortFree(port), () => "the sandbox process kept the port after its watcher was killed", 15_000);
  });

  describe("SQL logging", () => {
    const json = (requestId: string, body?: unknown): RequestInit => ({
      headers: { "content-type": "application/json", "x-request-id": requestId },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const post = (name: string, requestId: string): Promise<Response> => fetch(url("/api/users"), { method: "POST", ...json(requestId, { name }) });
    /** Starts the sandbox once (no watcher), runs `use`, and returns everything it printed. */
    const printedBy = async (args: string[], use: () => Promise<void>): Promise<string> => {
      const sandbox = start(dir, [".local-db-sandbox/sandbox.server.ts", ...args]);
      spawned.push(sandbox);
      await until(async () => (await fetch(url("/api/info"), { headers: { "x-request-id": "startup-probe" } })).ok, () => `the sandbox did not start\n${sandbox.output()}`);
      await use();
      await delay(100);
      return sandbox.output();
    };
    /** The verbose entries of one request: `[id #n] HEADING` followed by its labelled lines. */
    const entries = (printed: string, requestId: string): { sequence: number; heading: string; lines: string[] }[] => {
      const found: { sequence: number; heading: string; lines: string[] }[] = [];
      for (const line of printed.split(/\r?\n/)) {
        const start = /^\[(\S+) #(\d+)\] (.*)$/.exec(line);
        if (start !== null) {
          found.push({ sequence: Number(start[2]), heading: start[3] as string, lines: [] });
          if (start[1] !== requestId) {
            found.pop();
            found.push({ sequence: -1, heading: "", lines: [] });
          }
        } else if (/^(sql|params|rows|affected|showing|result|time|error): /.test(line)) {
          found.at(-1)?.lines.push(line);
        }
      }
      return found.filter((entry) => entry.sequence !== -1);
    };

    it("prints every statement on its own numbered line by default (summary)", async () => {
      const printed = await printedBy([], async () => {
        assert.equal((await post("Summary", "s-1")).status, 201);
        assert.equal((await fetch(url("/api/users/1"), { method: "PATCH", ...json("s-2", { active: false }) })).status, 200);
      });
      const lines = (requestId: string): string[] =>
        printed.split(/\r?\n/).filter((line) => line.startsWith(`[${requestId} #`)).map((line) => line.replace(/\d+\.\dms/, "Tms").replace(/rows=\d+/, "rows=N"));
      // Saving is BEGIN, INSERT, a SELECT that reads generated values back, COMMIT: four entries.
      assert.deepEqual(lines("s-1"), ["[s-1 #1] Tms BEGIN", "[s-1 #2] Tms INSERT users rows=N", "[s-1 #3] Tms SELECT users rows=N", "[s-1 #4] Tms COMMIT"]);
      // An UPDATE and the SELECT after it stay two entries.
      assert.deepEqual(lines("s-2"), ["[s-2 #1] Tms UPDATE users rows=N", "[s-2 #2] Tms SELECT users rows=N"]);
      // No SQL text, no values, and no request lines.
      assert.doesNotMatch(printed, /INSERT INTO|^sql: |^params: |^result: |Summary|sqlCount=/m);
    });

    it("prints SQL, parameters, counts, returned rows, and time for every statement in verbose mode", async () => {
      const printed = await printedBy(["--sql-log=verbose"], async () => {
        assert.equal((await post("Verbose", "v-1")).status, 201);
        assert.equal((await fetch(url("/api/users/batch"), { method: "POST", ...json("v-2", { names: ["Never", ""] }) })).status, 400);
      });
      const first = entries(printed, "v-1");
      assert.deepEqual(first.map((entry) => [entry.sequence, entry.heading]), [[1, "BEGIN"], [2, "INSERT users"], [3, "SELECT users"], [4, "COMMIT"]]);
      assert.deepEqual(first[0]?.lines.map((line) => line.replace(/\d+\.\dms/, "Tms")), ["sql: BEGIN TRANSACTION", "time: Tms"]);

      const [, insert, select] = first;
      assert.match(insert?.lines[0] ?? "", /^sql: INSERT INTO "users"\(/);
      assert.deepEqual(insert?.lines.slice(1, 3), ['params: ["Verbose"]', "affected: 1"]);
      assert.match(insert?.lines.at(-1) ?? "", /^time: \d+\.\dms$/);

      // The SELECT shows the row it returned, as SQLite returned it.
      assert.match(select?.lines[0] ?? "", /^sql: SELECT "User"\."id" AS "User_id"/);
      assert.equal(select?.lines[2], "rows: 1");
      const row = JSON.parse((select?.lines[3] ?? "").replace(/^result: /, ""))[0];
      assert.deepEqual([typeof row.User_id, row.User_active], ["number", 1]);
      assert.match(row.User_createdAt, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);

      // The failed batch: its statements, including the rollback, belong to the second request.
      assert.deepEqual(entries(printed, "v-2").map((entry) => [entry.sequence, entry.heading]), [[1, "BEGIN"], [2, "INSERT users"], [3, "SELECT users"], [4, "ROLLBACK"]]);
      assert.equal(entries(printed, "v-2")[1]?.lines[1], 'params: ["Never"]');
    });

    it("ends each request with a line whose sqlCount is the number of entries printed for it", async () => {
      const printed = await printedBy(["--sql-log=verbose"], async () => {
        await post("Counted", "c-1");
        await fetch(url("/api/users/search?name=Counted"), json("c-2"));
        await fetch(url("/api/info"), json("c-3"));
        await fetch(url("/api/users/abc"), json("c-4"));
      });
      const completed = Object.fromEntries(
        [...printed.matchAll(/^\[(c-\d)\] (\w+) (\S+) (\d+) sqlCount=(\d+) sqlTime=\d+\.\dms total=\d+\.\dms$/gm)].map((match) => [match[1], match.slice(2, 6)]),
      );
      assert.deepEqual(completed, {
        "c-1": ["POST", "/api/users", "201", "4"],
        "c-2": ["GET", "/api/users/search?name=Counted", "200", "1"],
        "c-3": ["GET", "/api/info", "200", "0"],
        "c-4": ["GET", "/api/users/abc", "400", "0"],
      });
      for (const [requestId, [, , , sqlCount]] of Object.entries(completed)) {
        assert.deepEqual(entries(printed, requestId).map((entry) => entry.sequence), Array.from({ length: Number(sqlCount) }, (_, index) => index + 1));
      }
    });

    it("shows at most the configured number of returned rows", async () => {
      const printed = await printedBy(["--sql-log=verbose", "--sql-preview-rows=2"], async () => {
        for (const name of ["Preview A", "Preview B", "Preview C"]) {
          await post(name, "setup");
        }
        await fetch(url("/api/users/search?name=Preview"), json("p-1"));
      });
      const [select] = entries(printed, "p-1");
      assert.deepEqual(select?.lines.slice(2, 4), ["rows: 3", "showing: 2"]);
      const rows = JSON.parse((select?.lines[4] ?? "").replace(/^result: /, ""));
      assert.deepEqual(rows.map((row: { user_name: string }) => row.user_name), ["Preview C", "Preview B"]);
    });

    it("keeps the statements of overlapping requests under their own IDs and numbers", async () => {
      const printed = await printedBy(["--sql-log=verbose"], async () => {
        const responses = await Promise.all(["a", "b", "c", "d"].map((name) => post(`overlap-${name}`, `o-${name}`)));
        assert.deepEqual(responses.map((response) => response.status), [201, 201, 201, 201]);
      });
      for (const name of ["a", "b", "c", "d"]) {
        const own = entries(printed, `o-${name}`);
        assert.deepEqual(own.map((entry) => [entry.sequence, entry.heading]), [[1, "BEGIN"], [2, "INSERT users"], [3, "SELECT users"], [4, "COMMIT"]], printed);
        assert.equal(own[1]?.lines[1], `params: ["overlap-${name}"]`);
      }
    });

    it("logs SQL that runs outside any request as background", async () => {
      const printed = await printedBy(["--sql-log=verbose"], async () => undefined);
      // TypeORM's connection setup runs at startup, before any request.
      const background = entries(printed, "background");
      assert.deepEqual(background.map((entry) => entry.sequence), background.map((_, index) => index + 1));
      assert.ok(background.some((entry) => /^sql: PRAGMA foreign_keys = ON$/.test(entry.lines[0] ?? "")), printed);
    });

    it("prints nothing about SQL when logging is off", async () => {
      const printed = await printedBy(["--sql-log=off"], async () => {
        assert.equal((await post("Quiet", "q-1")).status, 201);
      });
      assert.doesNotMatch(printed, /INSERT|SELECT|BEGIN|PRAGMA|q-1|sqlCount|background/);
      assert.match(printed, /Local DB Sandbox: application running at/);
    });

    it("rejects an unknown mode, option, or preview limit", async () => {
      const cases = [
        [["--sql-log=loud"], /--sql-log must be "off", "summary", or "verbose"/],
        [["--hot"], /Unknown option --hot/],
        [["--sql-preview-rows=many"], /The SQL result preview limit must be a whole number of rows, 0 or more/],
      ] as const;
      for (const [args, message] of cases) {
        const sandbox = start(dir, [".local-db-sandbox/sandbox.server.ts", ...args]);
        spawned.push(sandbox);
        assert.equal(await sandbox.exited, 1);
        assert.match(sandbox.output(), message);
      }
    });
  });
});

describe("the sandbox script that init-nest writes", () => {
  let dir: string;
  const scripts = async (): Promise<Record<string, string>> => JSON.parse(await readFile(join(dir, "package.json"), "utf8")).scripts;
  const withScript = async (command: string | undefined): Promise<void> => {
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    manifest.scripts = { start: "nest start", ...(command !== undefined && { sandbox: command }) };
    await writeFile(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  };

  before(async () => {
    dir = await createNestProject();
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("replaces the script of an earlier version, which did not watch", async () => {
    await withScript("node .local-db-sandbox/sandbox.server.ts");
    const result = await initNest({ cwd: dir });
    assert.deepEqual(result.script, {
      name: "sandbox",
      command: "node .local-db-sandbox/sandbox.server.ts --watch",
      runCommand: "node .local-db-sandbox/sandbox.server.ts",
      status: "updated",
    });
    assert.deepEqual(await scripts(), { start: "nest start", sandbox: "node .local-db-sandbox/sandbox.server.ts --watch" });
    assert.equal((await initNest({ cwd: dir })).script.status, "present");
  });

  it("leaves a script the project wrote itself alone", async () => {
    await withScript("docker compose up sandbox");
    assert.equal((await initNest({ cwd: dir })).script.status, "different");
    assert.equal((await scripts()).sandbox, "docker compose up sandbox");
  });

  it("lets the SQL console find the project's entities for its database file", async () => {
    // A single-file database holds no table definitions, so the console has to get them from the project.
    await initNest({ cwd: dir, database: "sandbox.db.json" });
    let stdout = "";
    const io = { stdout: { write: (text: string) => (stdout += text) }, stderr: { write: (text: string) => (stdout += text) }, signals: new EventEmitter() };
    assert.equal(await runCli(["sql", join(dir, "sandbox.db.json"), "INSERT INTO category (code, label) VALUES ('books', 'Books')"], io), 0, stdout);
    assert.equal(await runCli(["sql", join(dir, "sandbox.db.json"), ".tables"], io), 0, stdout);
    assert.match(stdout, /^category {2}1 {5}entities$/m);
    assert.match(stdout, /^users {5}0 {5}entities$/m);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "sandbox.db.json"), "utf8")).data.category, [{ code: "books", label: "Books" }]);
  });

  it("keeps the logging and watch settings of an existing configuration", async () => {
    const config = join(dir, ".local-db-sandbox", "sandbox.config.json");
    const previous = JSON.parse(await readFile(config, "utf8"));
    await writeFile(config, JSON.stringify({ ...previous, sqlLog: "verbose", watch: ["../libs"] }));
    await initNest({ cwd: dir });
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { ...previous, sqlLog: "verbose", watch: ["../libs"] });
  });
});

/*
 * The standalone REST mode does not use the relational runtime. Its log
 * lines stay descriptions of core operations; none of the SQL event fields
 * or log modes above apply to it.
 */
describe("standalone REST mode logging", () => {
  it("still reports SQL-like descriptions of operations, in its own format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-rest-log-"));
    const file = join(dir, "db.json");
    await writeFile(file, JSON.stringify({ data: { users: [{ id: 1, name: "Ada", active: true }] } }));
    const requests: RequestEvent[] = [];
    const sandbox = await startSandbox({ file, port: 0, onRequest: (event) => requests.push(event) });
    try {
      await fetch(`${sandbox.url}/users?active=true`);
      await fetch(`${sandbox.url}/users`, { method: "POST", body: JSON.stringify({ name: "Bo" }) });
    } finally {
      await sandbox.stop();
      await rm(dir, { recursive: true, force: true });
    }

    const operations = requests.flatMap((request) => request.operations);
    assert.deepEqual(operations.map((operation) => [operation.operation, operation.collection, operation.statement, operation.rows]), [
      ["SELECT", "users", "SELECT * FROM users WHERE active = 'true'", 1],
      ["INSERT", "users", "INSERT INTO users (id, name) VALUES (2, 'Bo')", 1],
    ]);
    assert.deepEqual(Object.keys(operations[0] as object).sort(), ["collection", "localExecutionMs", "operation", "rows", "statement"]);
    assert.match(formatRequestEvent(requests[0] as RequestEvent), /GET {3}\/users\?active=true {2}200 {2}1 row {2}local=[\d.]+ms total=[\d.]+ms$/);
    assert.match(formatOperationEvent(operations[1] as OperationEvent), /^INSERT {2}1 row {2}local=[\d.]+ms {2}INSERT INTO users \(id, name\) VALUES \(2, 'Bo'\)$/);
  });
});
