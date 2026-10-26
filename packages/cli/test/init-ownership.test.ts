import "reflect-metadata";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NestFactory } from "@nestjs/core";
import { getDataSourceToken } from "@nestjs/typeorm";
import { SandboxModule } from "../../nest-typeorm/src/index.ts";
import { compileDecorators } from "../../nest-typeorm/test/support/decorators.ts";
import { clientFor } from "../../postgrest/test/support.ts";
import { canonicalDatabasePath, createDatabase, ownerRecordPath } from "../../storage-json/src/index.ts";
import type { OwnerRecord } from "../../storage-json/src/index.ts";
import { allFiles, storedRows } from "../../storage-json/test/support/database-files.ts";
import { startStudio } from "../../studio/src/index.ts";
import { runCli } from "../src/index.ts";

/*
 * `init --force` replaces a database. A database that a process has open is
 * that process's (D-042, D-043): replaced under it, the process would go on
 * serving rows that are stored nowhere any more, and could not save. So
 * `init` claims the database before it replaces it, as every writer does,
 * and is refused one that a live process has. Nothing is replaced then.
 */

// The NestJS sandbox module needs an application's entities: the fixture application of the NestJS tests.
const app = join(import.meta.dirname, "../../nest-typeorm/test/fixtures/app");
compileDecorators(app);
// Specifiers are computed so that the type checker does not follow them into decorator code.
const load = (name: string): Promise<any> => import(pathToFileURL(join(app, name)).href);
const { User } = await load("user.entity.ts");
const { Category } = await load("category.entity.ts");

class AppModule {}

/** A pid that no process has: of a process that has ended. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

describe("CLI: init --force and a database that a process has open", { timeout: 120_000 }, () => {
  let dir: string;
  let root: string;
  let out: string;
  let stops: (() => Promise<unknown>)[];

  async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  }
  /** Starts the `postgrest` command, as a user does, and resolves with the address it serves at once it has said so. */
  async function endpoint(database: string): Promise<{ url: string; stop: () => Promise<number> }> {
    let output = "";
    let announce: (url: string) => void = () => {};
    const ready = new Promise<string>((resolve) => (announce = resolve));
    const signals = new EventEmitter();
    const write = (text: string): void => {
      output += text;
      const match = /Supabase URL for clients: (http:\S+)/.exec(output);
      if (match && /Press Ctrl\+C to stop\./.test(output)) {
        announce(match[1] as string);
      }
    };
    const exit = runCli(["postgrest", database, "--port", "0", "--quiet", "--sql-log", "off"], { stdout: { write }, stderr: { write }, signals });
    const url = await Promise.race([ready, exit.then((code) => Promise.reject(new Error(`exited with ${code}: ${output}`)))]);
    let stopped: Promise<number> | undefined;
    const stop = (): Promise<number> => (stopped ??= (signals.emit("SIGINT"), exit));
    stops.push(stop);
    return { url, stop };
  }
  const record = (database: string): OwnerRecord => JSON.parse(readFileSync(ownerRecordPath(database), "utf8"));
  const leftBeside = (database: string): string[] => [".owner.json", ".owner.lock"].filter((suffix) => existsSync(`${canonicalDatabasePath(database)}${suffix}`));
  /** Everything a database is, and what `init` writes beside it: its files, byte for byte, and its report. */
  const everything = async (database: string): Promise<{ files: Record<string, string>; report: string | undefined }> => ({
    files: await allFiles(database),
    report: existsSync(`${database}.report.json`) ? await readFile(`${database}.report.json`, "utf8") : undefined,
  });
  /** What `init --force` says when a live process has the database: who, since when, what to do, and that nothing happened. */
  const refusal = (name: string, owner: string): RegExp =>
    new RegExp(
      `^Error: .*${name} is open in ${owner} \\(pid ${process.pid}, since .*\\)\\. One process has a database open to write at a time: stop that one first\\. ` +
        'Nothing was replaced: the database is as it was\\.\\nRun "local-db-sandbox init --help" for usage\\.\\n$',
    );
  const notes = async (): Promise<Record<string, unknown>[]> => storedRows(out, "notes");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-init-owner-"));
    stops = [];
    root = join(dir, "project");
    mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(root, "supabase", "migrations", "0001_notes.sql"), "create table notes (id int primary key, body text not null);\ninsert into notes (id, body) values (1, 'seed');\n");
    out = join(dir, "out.db");
    const made = await run("init", root, "--out", out);
    assert.equal(made.code, 0, made.stderr);
    // What a later init makes of the project is another database: one more column, and no row that was added since.
    writeFileSync(join(root, "supabase", "migrations", "0002_extra.sql"), "alter table notes add column extra text;\n");
  });
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) {
      await stop();
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("is refused while a PostgREST endpoint has the database, which stays as it was, and replaces it once the endpoint has stopped", async () => {
    const serving = await endpoint(out);
    const client = clientFor(serving.url);
    assert.equal((await client.from("notes").upsert({ id: 2, body: "added through the endpoint" })).error, null);
    const [before, owner] = [await everything(out), record(out)];
    assert.equal(owner.kind, "postgrest");

    const refused = await run("init", root, "--out", out, "--force");
    assert.deepEqual([refused.code, refused.stdout], [1, ""]);
    assert.match(refused.stderr, refusal("out\\.db", "the PostgREST endpoint"));
    // Nothing of the database was touched, and the endpoint has it as before: it was not stopped, and not asked to let go.
    assert.deepEqual(await everything(out), before);
    assert.deepEqual(record(out), owner);
    assert.deepEqual(leftBeside(out), [".owner.json"]);
    // It serves what it served, and saves what it is given.
    assert.deepEqual((await client.from("notes").select("id").gte("id", 1)).data, [{ id: 1 }, { id: 2 }]);
    assert.equal((await client.from("notes").upsert({ id: 3, body: "added after the refusal" })).error, null);
    assert.deepEqual((await notes()).map((note) => note.id), [1, 2, 3]);

    // Stopped by whoever runs it: now the database is replaced.
    assert.equal(await serving.stop(), 0);
    const replaced = await run("init", root, "--out", out, "--force");
    assert.equal(replaced.code, 0, replaced.stderr);
    assert.deepEqual(await notes(), [{ id: 1, body: "seed", extra: null }]);
    assert.deepEqual(leftBeside(out), []);
  });

  it("is refused while a Studio has the database to itself", async () => {
    const studio = await startStudio({ database: out, port: 0 });
    stops.push(() => studio.stop());
    const { instance } = record(out);
    assert.equal((await studio.status()).info?.instance, instance);
    const before = await everything(out);

    const refused = await run("init", root, "--out", out, "--force");
    assert.deepEqual([refused.code, refused.stdout], [1, ""]);
    assert.match(refused.stderr, refusal("out\\.db", "Local DB Studio"));
    assert.deepEqual(await everything(out), before);
    assert.deepEqual([record(out).kind, record(out).instance], ["studio", instance]);

    await studio.stop();
    assert.equal((await run("init", root, "--out", out, "--force")).code, 0);
    assert.deepEqual(Object.keys((await notes())[0] ?? {}), ["id", "body", "extra"]);
  });

  it("is refused while a NestJS application has the database", async () => {
    const database = join(dir, "nest.db");
    await createDatabase(database, { collections: { users: [], category: [] } });
    // The module is what an application imports in place of TypeOrmModule.forRoot; its own type names no NestJS type.
    const sandbox: any = SandboxModule.forRoot({ file: database, entities: [User, Category] });
    const context = await NestFactory.createApplicationContext({ module: AppModule, imports: [sandbox] }, { logger: false, abortOnError: false });
    stops.push(() => context.close());
    const [before, owner] = [await allFiles(database), record(database)];
    assert.equal(owner.kind, "nest");

    const refused = await run("init", root, "--out", database, "--force");
    assert.deepEqual([refused.code, refused.stdout], [1, ""]);
    assert.match(refused.stderr, refusal("nest\\.db", "the NestJS sandbox"));
    assert.deepEqual(await allFiles(database), before);
    assert.deepEqual(record(database), owner);
    assert.equal(existsSync(`${database}.report.json`), false);
    // The application writes to its database as before, and the row is stored.
    await context.get(getDataSourceToken()).getRepository(User).save({ name: "Bo" });
    assert.deepEqual((await storedRows(database, "users")).map((user) => user.name), ["Bo"]);

    await context.close();
    assert.equal((await run("init", root, "--out", database, "--force")).code, 0);
    assert.deepEqual((await storedRows(database, "notes")).map((note) => note.id), [1]);
  });

  it("replaces a database whose owner's record was left behind, as every writer takes such a database", async () => {
    // By a process that is gone, and by one whose process number another process has by now: nothing listens where it served.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    for (const left of [
      { pid: await deadPid(), kind: "nest" },
      { pid: process.pid, kind: "postgrest", control: { url: `http://127.0.0.1:${port}`, token: "t".repeat(48) } },
    ]) {
      writeFileSync(ownerRecordPath(out), JSON.stringify({ version: 1, startedAt: "2026-01-02T03:04:05.000Z", instance: "0".repeat(48), database: canonicalDatabasePath(out), ...left }));
      const replaced = await run("init", root, "--out", out, "--force");
      assert.equal(replaced.code, 0, replaced.stderr);
      assert.deepEqual(await notes(), [{ id: 1, body: "seed", extra: null }]);
      // The record went with the claim that took it over: nothing is left beside the database.
      assert.deepEqual(leftBeside(out), []);
    }
  });

  it("is refused a database that another process is claiming this moment", async () => {
    // A record that cannot be read yet is one that is being written.
    writeFileSync(ownerRecordPath(out), "{");
    const before = await everything(out);
    const refused = await run("init", root, "--out", out, "--force");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^Error: .*out\.db is being opened by another process right now\. One process has a database open to write at a time\. If no such process is there, delete .*out\.db\.owner\.json\. Nothing was replaced: the database is as it was\.\n/);
    assert.deepEqual(await everything(out), before);
    assert.equal(readFileSync(ownerRecordPath(out), "utf8"), "{");
  });

  it("lets go of the database again when the migrations cannot be read, and has changed nothing", async () => {
    writeFileSync(join(root, "supabase", "migrations", "0003_broken.sql"), "create tabel oops (id int);\n");
    const before = await everything(out);
    const failed = await run("init", root, "--out", out, "--force");
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /0003_broken\.sql:1:\d+: PostgreSQL cannot parse this migration: .* Nothing was written\./);
    assert.deepEqual(await everything(out), before);
    assert.deepEqual(leftBeside(out), []);
  });

  it("claims nothing where there is nothing to replace, and leaves nothing beside a database it made", async () => {
    const fresh = join(dir, "fresh.db");
    assert.equal((await run("init", root, "--out", fresh)).code, 0);
    assert.deepEqual(leftBeside(fresh), []);
    // Without --force an existing database is refused as before, whoever has it or no one.
    const again = await run("init", root, "--out", fresh);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /fresh\.db exists\. Use --force to replace it; the rows it holds are lost\./);
    assert.deepEqual(leftBeside(fresh), []);
  });

  it("has no switch that replaces a database under the process that has it, and says in its help that this is refused", async () => {
    const studio = await startStudio({ database: out, port: 0 });
    stops.push(() => studio.stop());
    const before = await everything(out);
    for (const flag of ["--force-active", "--force=active", "--yes"]) {
      const refused = await run("init", root, "--out", out, "--force", flag);
      assert.equal(refused.code, 1, flag);
      assert.deepEqual(await everything(out), before, flag);
    }
    const help = (await run("init", "--help")).stdout;
    assert.match(help, /--force\s+Replace the database if it exists; its rows are lost\.\s+Refused while a\s+process has the database open: stop that process first\./);
  });
});
