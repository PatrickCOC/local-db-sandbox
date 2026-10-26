import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, before, describe, it } from "node:test";
import { initNest, watchNestSandbox } from "../../nest-typeorm/src/index.ts";
import type { NestSandboxWatch, SandboxWatchEvent } from "../../nest-typeorm/src/index.ts";
import { createNestProject, freePort, isAlive, storedRows, until } from "../../nest-typeorm/test/support/nest-project.ts";
import { canonicalDatabasePath, ownerRecordPath } from "../../storage-json/src/index.ts";
import type { OwnerRecord } from "../../storage-json/src/index.ts";
import { startStudio } from "../src/index.ts";
import type { RunningStudio, StudioStatus } from "../src/index.ts";

/*
 * Studio attached to a sandbox that its watcher restarts (D-042). The
 * project is a copy of the NestJS fixture, the watcher is the one
 * `npm run sandbox` runs, and the restart is the one an edit of a source
 * file causes: the sandbox process is killed and another one is started,
 * which claims the database and serves its runtime anew. Studio is not
 * restarted; it finds the new process by itself.
 */

const FIXTURE = join(import.meta.dirname, "../../nest-typeorm/test/fixtures/nest-project");

interface Answer {
  status: number;
  body: any;
}

describe("Studio attached to a sandbox that restarts on source changes", { timeout: 300_000 }, () => {
  let dir: string;
  let port: number;
  let database: string;
  let watch: NestSandboxWatch | undefined;
  let studio: RunningStudio | undefined;
  let events: SandboxWatchEvent[] = [];
  let output = "";

  const app = (path: string, init?: RequestInit): Promise<Response> => fetch(`http://localhost:${port}${path}`, init);
  const post = (path: string, body: unknown): Promise<Response> => app(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const pids = (type: "started" | "exited"): number[] => events.flatMap((event) => (event.type === type ? [event.pid] : []));
  const record = (): OwnerRecord => JSON.parse(readFileSync(ownerRecordPath(database), "utf8"));
  /** What Studio's page asks. A request that finds the application in a transaction of its own was not carried out, and is asked again. */
  const ask = async (operation: string, request?: unknown, madeFor?: string): Promise<Answer> => {
    for (;;) {
      const response = await fetch(`${studio?.url}/api/access/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${studio?.key}`, "content-type": "application/json" },
        body: JSON.stringify({ ...(madeFor !== undefined && { for: madeFor }), ...(request !== undefined && { request }) }),
      });
      const answer: Answer = { status: response.status, body: await response.json() };
      if (answer.body?.error?.code !== "BUSY") {
        return answer;
      }
      await delay(50);
    }
  };
  const status = async (): Promise<StudioStatus> => (await (await fetch(`${studio?.url}/api/status`, { headers: { authorization: `Bearer ${studio?.key}` } })).json()) as StudioStatus;
  /** Edits the application: its info route now also returns `revision`. */
  const editApplication = async (revision: number): Promise<void> => {
    const source = await readFile(join(FIXTURE, "src/info.controller.ts"), "utf8");
    await writeFile(join(dir, "src", "info.controller.ts"), source.replace("{ database: this.dataSource.options.type }", `{ database: this.dataSource.options.type, revision: ${revision} } as any`));
  };
  const startWatching = async (config: string): Promise<void> => {
    events = [];
    output = "";
    watch = watchNestSandbox({
      configFile: config,
      debounceMs: 100,
      log: (line) => (output += `${line}\n`),
      output: { stdout: { write: (text) => (output += text) }, stderr: { write: (text) => (output += text) } },
      signals: new EventEmitter(),
      onEvent: (event) => events.push(event),
    });
    await until(async () => (await app("/api/info")).ok, () => `the sandbox did not start\n${output}`, 60_000);
  };

  before(async () => {
    dir = await createNestProject();
  });
  afterEach(async () => {
    await studio?.stop();
    studio = undefined;
    await watch?.stop();
    watch = undefined;
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("finds the sandbox process that replaced the one it was attached to, shows that it is away meanwhile, and sends it nothing that was meant for the other", async () => {
    port = await freePort();
    database = join(dir, "sandbox.db");
    await initNest({ cwd: dir, port });
    await startWatching(join(dir, ".local-db-sandbox", "sandbox.config.json"));
    const [firstPid] = pids("started");

    // Studio attaches to the sandbox process: the watcher's child, which has the database.
    studio = await startStudio({ database, port: 0 });
    assert.equal(studio.mode, "attached");
    const before = await status();
    assert.deepEqual([before.mode, before.connected, before.database, before.info?.kind, before.info?.pid, before.info?.format, before.info?.readOnly], ["attached", true, canonicalDatabasePath(database), "nest", firstPid, "directory", undefined]);
    const first = before.info?.instance as string;
    assert.deepEqual([record().instance, record().pid, record().kind], [first, firstPid, "nest"]);

    // One runtime: what the application writes, Studio shows, and what Studio changes, the application answers with.
    assert.equal((await post("/api/users", { name: "Ada" })).status, 201);
    assert.deepEqual((await ask("browse", { table: "users" })).body.result.rows.map((row: unknown[]) => row[1]), ["Ada"]);
    assert.deepEqual((await ask("insert", { table: "category", values: { code: "studio", label: "From Studio" } }, first)).body, { result: { affectedRows: 1 } });
    assert.deepEqual(await (await app("/api/categories/studio")).json(), { code: "studio", label: "From Studio" });
    assert.deepEqual((await ask("update", { table: "users", key: { id: 1 }, values: { name: "Ada L." } }, first)).body, { result: { affectedRows: 1 } });
    assert.deepEqual(((await (await app("/api/users")).json()) as { name: string }[]).map((user) => user.name), ["Ada L."]);

    // The application is edited: the watcher ends its sandbox process, and starts another.
    const seen: StudioStatus[] = [];
    let watching = true;
    const observing = (async () => {
      while (watching) {
        seen.push(await status());
        await delay(60);
      }
    })();
    await editApplication(2);
    await until(() => pids("exited").length === 1, () => `the sandbox process was not ended\n${output}`, 60_000);

    // No process has the database now. Studio says so, and does nothing.
    await until(async () => !(await status()).connected, () => "Studio did not notice that the sandbox process is gone");
    const away = await status();
    assert.deepEqual([away.mode, away.connected, away.info], ["attached", false, undefined]);
    assert.match(away.disconnected ?? "", /database open/);
    const unread = await ask("browse", { table: "users" });
    const unsent = await ask("insert", { table: "category", values: { code: "lost", label: "While the sandbox was away" } }, first);
    // (The new process may be there already: then the reading was carried out by it, and the change was refused by name.)
    assert.ok(unread.status === 503 || unread.status === 200, JSON.stringify(unread));
    assert.ok((unsent.status === 503 && unsent.body.error.code === "OWNER_UNREACHABLE") || (unsent.status === 409 && unsent.body.error.code === "OWNER_CHANGED"), JSON.stringify(unsent));

    // The new process serves the application, and Studio is attached to it, without having been told.
    await until(async () => ((await (await app("/api/info")).json()) as { revision?: number }).revision === 2, () => `the sandbox never served the changed application\n${output}`, 60_000);
    await until(async () => (await status()).connected, () => "Studio did not find the new sandbox process");
    watching = false;
    await observing;
    const [, secondPid] = pids("started");
    const back = await status();
    assert.deepEqual([back.mode, back.connected, back.disconnected, back.info?.kind, back.info?.pid], ["attached", true, undefined, "nest", secondPid]);
    const second = back.info?.instance as string;
    assert.notEqual(second, first);
    assert.deepEqual([record().instance, record().pid], [second, secondPid]);
    // The restart was one process after the other, as before: never two.
    assert.deepEqual(events.map((event) => event.type), ["started", "changed", "exited", "started"]);
    // (That the first has ended is in those events. Its process number is not asked: Windows gives one to another process soon after.)
    assert.deepEqual(events.filter((event) => event.type === "exited").map((event) => event.pid), [firstPid]);
    assert.equal(isAlive(secondPid as number), true);
    // Studio showed that it was away in between, and was never attached to anything but the two.
    assert.ok(seen.some((each) => !each.connected), "no status in between said that the sandbox was away");
    assert.ok(seen.some((each) => each.connected && each.info?.instance === first), "no status before said that the first process was there");
    assert.deepEqual(seen.filter((each) => each.connected && each.info?.instance !== first && each.info?.instance !== second), []);

    // What it shows now is what the new process has: everything the first one saved.
    assert.deepEqual((await ask("browse", { table: "users" })).body.result.rows.map((row: unknown[]) => row[1]), ["Ada L."]);
    assert.deepEqual((await ask("row", { table: "category", key: { code: "studio" } })).body.result.row, { code: "studio", label: "From Studio" });
    // The change that found no one was not kept for later, and was not sent to the new process.
    assert.equal((await ask("row", { table: "category", key: { code: "lost" } })).status, 404);
    assert.equal((await app("/api/categories/lost")).status, 404);
    // A change that was asked for while the page showed the first process's rows is refused by the second...
    const late = await ask("delete", { table: "users", key: { id: 1 } }, first);
    assert.deepEqual([late.status, late.body.error.code], [409, "OWNER_CHANGED"]);
    assert.equal(((await (await app("/api/users")).json()) as unknown[]).length, 1);
    // ...and one that is asked for after looking again is carried out by it, and saved by it.
    assert.deepEqual((await ask("insert", { table: "category", values: { code: "after", label: "After the restart" } }, second)).body, { result: { affectedRows: 1 } });
    assert.deepEqual(await (await app("/api/categories/after")).json(), { code: "after", label: "After the restart" });
    assert.deepEqual((await storedRows(database, "category")).map((row) => row.code).sort(), ["after", "studio"]);
    assert.equal((await post("/api/users", { name: "Bo" })).status, 201);
    assert.deepEqual((await ask("browse", { table: "users" })).body.result.rows.map((row: unknown[]) => row[1]), ["Ada L.", "Bo"]);

    // The sandbox is stopped for good: Studio stays attached to no one, and takes nothing for itself.
    await watch?.stop();
    watch = undefined;
    await until(async () => !(await status()).connected, () => "Studio did not notice that the sandbox was stopped");
    assert.equal((await ask("insert", { table: "category", values: { code: "alone", label: "x" } }, second)).status, 503);
    assert.ok(!existsSync(ownerRecordPath(database)) || record().kind === "nest");
    assert.deepEqual((await storedRows(database, "category")).map((row) => row.code).sort(), ["after", "studio"]);
  });

  it("is not restarted by its own record: a sandbox whose database lies among the watched sources starts once", async () => {
    const project = await createNestProject();
    try {
      port = await freePort();
      database = join(project, "src", "data", "sandbox.db");
      await initNest({ cwd: project, port, database: "src/data/sandbox.db" });
      await startWatching(join(project, ".local-db-sandbox", "sandbox.config.json"));
      // The sandbox process wrote its record next to the database, in a folder the watcher watches.
      assert.equal(record().kind, "nest");
      assert.equal((await post("/api/users", { name: "Cy" })).status, 201);
      await delay(1500);
      assert.deepEqual(events.map((event) => event.type), ["started"], output);
      assert.equal(isAlive(pids("started")[0] as number), true);
      assert.doesNotMatch(output, /restarting/);
    } finally {
      await watch?.stop();
      watch = undefined;
      await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
