import "reflect-metadata";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { NotFoundException } from "@nestjs/common";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getDataSourceToken, getRepositoryToken } from "@nestjs/typeorm";
import { SqliteRuntime } from "../../runtime/src/index.ts";
import { AccessError, AttachedRuntimeAccess, SINGLE_FILE_READ_ONLY } from "../../runtime-access/src/index.ts";
import { DatabaseOwnedError, canonicalDatabasePath, createDatabase, ownerRecordPath } from "../../storage-json/src/index.ts";
import type { OwnerRecord } from "../../storage-json/src/index.ts";
import { startStudio } from "../../studio/src/index.ts";
import { SANDBOX_RUNTIME, SandboxModule, isSandboxDataSource, sandboxRepositoryToken } from "../src/index.ts";
import { compileDecorators } from "./support/decorators.ts";

/*
 * fixtures/app is an ordinary NestJS + TypeORM feature: entities, services
 * that inject `Repository<Entity>`, a controller, and modules that import
 * `TypeOrmModule.forFeature`. None of it knows about the sandbox. Only the
 * root module differs: it imports `SandboxModule.forRoot` where the real
 * application imports `TypeOrmModule.forRoot`.
 *
 * This covers the module used on its own. The parallel sandbox server, over
 * real HTTP, is covered in nest-server.test.ts.
 */
const app = join(import.meta.dirname, "fixtures", "app");
compileDecorators(app);
// Specifiers are computed so that the type checker does not follow them into decorator code.
const load = (name: string): Promise<any> => import(pathToFileURL(join(app, name)).href);
const { User } = await load("user.entity.ts");
const { Category } = await load("category.entity.ts");
const { UsersModule } = await load("users.module.ts");
const { UsersController } = await load("users.controller.ts");
const { CategoriesModule, CategoriesService } = await load("categories.module.ts");
const typeorm = createRequire(import.meta.url)("typeorm");

class AppModule {}

describe("NestJS application with SandboxModule.forRoot", () => {
  let dir: string;
  let file: string;
  let context: INestApplicationContext;

  const start = (): Promise<INestApplicationContext> =>
    NestFactory.createApplicationContext(
      { module: AppModule, imports: [SandboxModule.forRoot({ file, entities: [User, Category] }), UsersModule, CategoriesModule] },
      { logger: false, abortOnError: false },
    );
  const stored = async (collection: string): Promise<Record<string, unknown>[]> =>
    JSON.parse(await readFile(file, "utf8")).data[collection];

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-nest-"));
    file = join(dir, "sandbox.db.json");
    await writeFile(file, JSON.stringify({ $meta: { version: 1 }, data: { users: [], category: [] } }));
    context = await start();
  });
  after(async () => {
    await context.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("provides TypeORM's own DataSource, EntityManager, and repositories, connected to the SQLite runtime", () => {
    const dataSource = context.get(getDataSourceToken());
    assert.ok(dataSource instanceof typeorm.DataSource);
    assert.equal(isSandboxDataSource(dataSource), true);
    assert.ok(context.get(typeorm.EntityManager) instanceof typeorm.EntityManager);
    assert.ok(context.get(SANDBOX_RUNTIME) instanceof SqliteRuntime);

    assert.equal(sandboxRepositoryToken(User), getRepositoryToken(User));
    assert.ok(context.get(getRepositoryToken(User)) instanceof typeorm.Repository);
  });

  it("creates, reads, updates, and deletes through the unchanged controller and service", async () => {
    const users = context.get(UsersController);

    const ada = await users.create({ name: "Ada" });
    const bo = await users.create({ name: "Bo", active: false });
    assert.ok(ada instanceof User);
    assert.deepEqual([ada.id, ada.name, ada.active], [1, "Ada", true]);
    assert.ok(ada.createdAt instanceof Date);
    assert.deepEqual(await stored("users"), [
      { id: 1, name: "Ada", active: true, createdAt: ada.createdAt.toISOString() },
      { id: 2, name: "Bo", active: false, createdAt: bo.createdAt.toISOString() },
    ]);

    assert.deepEqual((await users.findAll()).map((user: any) => user.name), ["Ada", "Bo"]);
    assert.deepEqual(await users.findOne(2), bo);

    const renamed = await users.update(1, { name: "Ada L." });
    assert.deepEqual([renamed.id, renamed.name, renamed.active], [1, "Ada L.", true]);
    assert.equal((await stored("users"))[0]?.name, "Ada L.");

    await users.remove(2);
    assert.deepEqual((await stored("users")).map((row) => row.id), [1]);
    await assert.rejects(users.findOne(2), NotFoundException);
    await assert.rejects(users.remove(2), NotFoundException);
  });

  it("serves an entity whose primary key is not named id", async () => {
    const categories = context.get(CategoriesService);

    const created = await categories.create("books", "Books");
    assert.deepEqual({ ...created }, { code: "books", label: "Books" });
    assert.deepEqual(await stored("category"), [{ code: "books", label: "Books" }]);

    const found = await categories.findByCode("books");
    assert.ok(found instanceof Category);
    assert.equal((await categories.rename("books", "Printed books")).label, "Printed books");
    assert.equal(await categories.findByCode("music"), null);

    assert.equal(await categories.remove("books"), 1);
    assert.equal(await categories.remove("books"), 0);
    assert.deepEqual(await stored("category"), []);
  });

  it("has its database to itself while it runs, and serves its runtime to whoever asks through the owner's record", async () => {
    // D-042. The record is next to the database, and says that this is a NestJS sandbox, and where it serves.
    const record: OwnerRecord = JSON.parse(await readFile(ownerRecordPath(file), "utf8"));
    assert.deepEqual([record.kind, record.pid, record.database, /^http:\/\/127\.0\.0\.1:\d+$/.test(record.control?.url ?? "")], ["nest", process.pid, canonicalDatabasePath(file), true]);
    const attached = new AttachedRuntimeAccess({ database: file });
    assert.equal(await attached.check(), true);
    assert.equal(attached.owner?.instance, record.instance);
    // What the application has is what is seen: the row it changed, as it left it.
    assert.deepEqual((await attached.browse({ table: "users" })).rows.map((row) => [row[0], row[1]]), [[1, "Ada L."]]);
    assert.deepEqual((await attached.sql({ sql: "SELECT COUNT(*) AS n FROM users", mode: "read" })).results[0]?.rows, [[1]]);
    // A single-file database is not changed through Studio: the access to it reads, and that is all.
    const info = await attached.info();
    assert.deepEqual([info.kind, info.format, info.persistence, info.readOnly], ["nest", "file", "json", SINGLE_FILE_READ_ONLY]);
    for (const change of [attached.insert({ table: "users", values: { name: "x" } }), attached.delete({ table: "users", key: { id: 1 } }), attached.sql({ sql: "DELETE FROM users", mode: "write" })]) {
      await assert.rejects(change, (error: unknown) => error instanceof AccessError && error.code === "READ_ONLY" && error.message === SINGLE_FILE_READ_ONLY);
    }
    assert.deepEqual((await stored("users")).map((row) => row.name), ["Ada L."]);
    // A second application on the same database is refused while this one runs, and is told who has it.
    await assert.rejects(start(), (error: unknown) => error instanceof DatabaseOwnedError && /sandbox\.db\.json is open in the NestJS sandbox \(pid \d+, since .*\)\. One process has a database open to write at a time: stop that one first\./.test(error.message));
    assert.equal(JSON.parse(await readFile(ownerRecordPath(file), "utf8")).instance, record.instance);
  });

  it("that is started while a Studio has its database to itself is refused, and is told how the database is handed over", async () => {
    const directory = join(dir, "handover.db");
    await createDatabase(directory, { collections: { users: [], category: [] } });
    const application = (): Promise<INestApplicationContext> =>
      NestFactory.createApplicationContext({ module: AppModule, imports: [SandboxModule.forRoot({ file: directory, entities: [User, Category] }), UsersModule, CategoriesModule] }, { logger: false, abortOnError: false });
    const studio = await startStudio({ database: directory, port: 0 });
    try {
      await assert.rejects(application(), (error: unknown) => {
        assert.ok(error instanceof DatabaseOwnedError, String(error));
        assert.match(
          error.message,
          /handover\.db is open in Local DB Studio \(pid \d+, since .*\)\. One process has a database open to write at a time: stop that one first\. That Studio has the database to itself\. To run the sandbox on it: stop that Studio \(Ctrl\+C in its terminal\), start the sandbox, and start Studio again\. It then attaches to the sandbox, and both show the same rows\.$/,
        );
        return true;
      });
      // Nothing let go of the database for it: Studio has it as before.
      assert.equal(JSON.parse(await readFile(ownerRecordPath(directory), "utf8")).kind, "studio");
    } finally {
      await studio.stop();
    }
    // Stopped by whoever runs it, the application starts. A Studio that is started then is attached to it, and has nothing to hand over.
    const started = await application();
    try {
      const again = await startStudio({ database: directory, port: 0 });
      try {
        assert.deepEqual([again.mode, again.notices, (await again.status()).info?.kind], ["attached", [], "nest"]);
      } finally {
        await again.stop();
      }
    } finally {
      await started.close();
    }
  });

  it("keeps the data for the next application start, and closes the runtime with the application", async () => {
    // One application has a database at a time (D-042): the one that ran until now ends, and lets go of it.
    const first = context.get(getDataSourceToken());
    await context.close();
    assert.equal(first.isInitialized, false);
    assert.equal(existsSync(ownerRecordPath(file)), false);
    context = await start();
    const dataSource = context.get(getDataSourceToken());
    assert.deepEqual((await context.get(UsersController).findAll()).map((user: any) => [user.id, user.name]), [[1, "Ada L."]]);
    await context.close();
    assert.equal(dataSource.isInitialized, false);
    assert.equal(existsSync(ownerRecordPath(file)), false);
    // For whatever follows, and for the end.
    context = await start();
  });
});
