import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { Database, SandboxLimitError } from "../../core/src/index.ts";
import type { DatabaseState, Row } from "../../core/src/index.ts";
import { SqliteRuntime } from "../../runtime/src/index.ts";
import type { TableSchema } from "../../runtime/src/index.ts";
import { DatabaseFormatError, DirectoryStorageAdapter, JsonStorageAdapter, JsonStorageError, createDatabase, databaseFormatFor, openDatabaseStorage } from "../src/index.ts";
import type { DirectorySaveReport, DirectoryStorageOptions, SizeWarning } from "../src/index.ts";
import { allFiles, databaseFiles, storedRows, tableFile } from "./support/database-files.ts";

const SCHEMA: TableSchema[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true, generated: "increment" },
      { name: "display_name", key: "name", type: "text", nullable: false, primary: false },
      { name: "active", type: "boolean", nullable: false, primary: false, default: true },
    ],
  },
  {
    name: "orders",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true, generated: "increment" },
      { name: "userId", type: "integer", nullable: true, primary: false, references: { table: "users", column: "id", onDelete: "SET NULL" } },
      { name: "total", type: "integer", nullable: false, primary: false, default: 0 },
    ],
  },
];

const USERS: Row[] = [
  { id: 1, name: "Ada", active: true },
  { id: 2, name: "Bo", active: false },
];
const ORDERS: Row[] = [{ id: 10, userId: 1, total: 30 }];
const CONFIG = { server: { port: 4999 } };
const NEW_FILES = ["manifest.json", "schema.json", "tables/empty.json", "tables/orders.json", "tables/users.json"];

function refused(message: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof JsonStorageError, String(error));
    assert.match(error.message, message);
    return true;
  };
}

/** What tells a file apart from another one under the same name, and from itself after it was written again. */
function identity(path: string): string {
  const stats = statSync(path, { bigint: true });
  return `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
}

describe("directory database", () => {
  let root: string;
  let path: string;

  const create = (collections: Record<string, Row[]> = { users: USERS, orders: ORDERS, empty: [] }, options: object = {}): Promise<unknown> =>
    createDatabase(path, { collections: structuredClone(collections), schema: SCHEMA, config: CONFIG, ...options });
  /** Deletes the files a save replaces with that save, so that what is in the directory afterwards does not depend on time. */
  const reopen = (options: DirectoryStorageOptions = {}): DirectoryStorageAdapter => new DirectoryStorageAdapter(path, { retiredFileGraceMs: 0, ...options });
  const json = async (file: string): Promise<any> => JSON.parse((await databaseFiles(path))[file] as string);
  const manifest = async (): Promise<any> => JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
  const editManifest = async (edit: (value: any) => void): Promise<void> => {
    const value = await manifest();
    edit(value);
    await writeFile(join(path, "manifest.json"), JSON.stringify(value));
  };
  /** A directory as a build of format 2 wrote it: every file under its plain name, and a manifest without generation and schema. */
  const createLegacy = async (collections: Record<string, Row[]> = { users: USERS, orders: ORDERS, empty: [] }): Promise<void> => {
    await create(collections);
    await editManifest((value) => {
      value.formatVersion = 2;
      delete value.minimumReaderVersion;
      delete value.generation;
      delete value.schema;
    });
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-directory-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    path = join(root, "sandbox.db");
    await rm(path, { recursive: true, force: true });
  });

  describe("layout", () => {
    it("is a manifest, a schema, and one file of rows per table", async () => {
      await create();
      assert.deepEqual(Object.keys(await allFiles(path)), NEW_FILES);

      assert.deepEqual(await manifest(), {
        formatVersion: 5,
        minimumReaderVersion: 5,
        database: "sandbox",
        persistence: "json",
        config: CONFIG,
        generation: 1,
        schema: "schema.json",
        tables: [
          { name: "users", file: "users.json" },
          { name: "orders", file: "orders.json" },
          { name: "empty", file: "empty.json" },
        ],
      });
      // A table file holds the table's rows and nothing else.
      assert.equal(await readFile(join(path, "tables/orders.json"), "utf8"), '[\n  {\n    "id": 10,\n    "userId": 1,\n    "total": 30\n  }\n]\n');
      assert.equal(await readFile(join(path, "tables/empty.json"), "utf8"), "[]\n");
      assert.deepEqual(await json("tables/users.json"), USERS);
    });

    it("stores the declared table definitions in schema.json, without the ORM they came from", async () => {
      await create();
      const schema = await json("schema.json");
      assert.equal(schema.schemaVersion, 2);
      assert.deepEqual(schema.tables.map((table: { name: string }) => table.name), ["users", "orders"]);
      assert.deepEqual(schema.tables[0].columns[1], { column: "display_name", property: "name", type: "text", nullable: false, primaryKey: false });
      assert.deepEqual(schema.tables[1].columns[1].references, { table: "users", column: "id", onDelete: "SET NULL" });
    });

    it("is recognized by its path", async () => {
      assert.equal(databaseFormatFor(path), "directory");
      assert.equal(databaseFormatFor(join(root, "new.db.json")), "file");
      await create();
      assert.equal(databaseFormatFor(path), "directory");
      assert.ok(openDatabaseStorage(path) instanceof DirectoryStorageAdapter);

      const file = join(root, "single.db.json");
      await writeFile(file, JSON.stringify({ data: { users: [] } }));
      assert.ok(openDatabaseStorage(file) instanceof JsonStorageAdapter);
      assert.throws(() => openDatabaseStorage(join(root, "missing.db")), refused(/Database not found: .*missing\.db/));
    });

    it("names the file of a table that was saved again after the save's generation, and lists it in the manifest", async () => {
      await create();
      const storage = reopen();
      const state = await storage.load();
      state.collections.users = [...USERS, { id: 3, name: "Cy", active: true }];
      storage.saveSync(state);

      assert.equal(storage.generation, 2);
      assert.deepEqual(Object.keys(await allFiles(path)), ["manifest.json", "schema.json", "tables/empty.json", "tables/orders.json", "tables/users.g2.json"]);
      const saved = await manifest();
      assert.deepEqual([saved.generation, saved.tables], [2, [{ name: "users", file: "users.g2.json" }, { name: "orders", file: "orders.json" }, { name: "empty", file: "empty.json" }]]);
      // Seen through the manifest, the database has the files of a new one.
      assert.deepEqual(Object.keys(await databaseFiles(path)), NEW_FILES);
    });
  });

  describe("loading", () => {
    it("returns the rows of every table in manifest order, with the configuration and the schema", async () => {
      await create();
      const storage = reopen();
      const state = await storage.load();

      assert.deepEqual(state, { meta: { version: 5 }, collections: { users: USERS, orders: ORDERS, empty: [] } });
      assert.deepEqual(Object.keys(state.collections), ["users", "orders", "empty"]);
      assert.deepEqual(storage.config, CONFIG);
      assert.deepEqual(storage.schema, SCHEMA);
      assert.equal(storage.persistence, "json");
      assert.equal(storage.format, "directory");
      assert.equal(storage.generation, 1);
    });

    it("says that it has no schema when no table is declared", async () => {
      await createDatabase(path, { collections: { notes: [{ text: "x" }] } });
      const storage = reopen();
      await storage.load();
      assert.equal(storage.schema, undefined);
      assert.deepEqual(await json("schema.json"), { schemaVersion: 2, tables: [] });
    });

    it("refuses a directory that is not a usable database, saying what is wrong", async () => {
      const broken = async (change: () => Promise<void>, message: RegExp): Promise<void> => {
        await rm(path, { recursive: true, force: true });
        await create();
        await change();
        await assert.rejects(reopen().load(), refused(message));
      };

      await broken(() => rm(join(path, "manifest.json")), /is not a database directory: it has no manifest\.json/);
      await broken(() => writeFile(join(path, "manifest.json"), "{ not json"), /manifest\.json is not valid JSON/);
      await broken(() => editManifest((value) => delete value.formatVersion), /manifest\.json has no usable "formatVersion" \(none\)/);
      await broken(() => editManifest((value) => (value.formatVersion = "3")), /manifest\.json has no usable "formatVersion" \("3"\): it must be a whole number, 1 or more/);
      await broken(() => editManifest((value) => (value.minimumReaderVersion = 6)), /"minimumReaderVersion" in .*manifest\.json must be a whole number from 1 to the format version \(5\)/);
      await broken(() => editManifest((value) => (value.persistence = "sqlite")), /"persistence" in .*manifest\.json must be "json" or "memory"/);
      await broken(() => editManifest((value) => (value.rows = [])), /manifest\.json has the unknown key "rows"/);
      await broken(() => editManifest((value) => (value.generation = -1)), /"generation" in .*manifest\.json must be a whole number, 0 or more/);
      await broken(() => editManifest((value) => (value.schema = "../schema.json")), /"schema" in .*manifest\.json must be the name of the schema file/);
      await broken(() => editManifest((value) => (value.tables[0].file = "../users.json")), /"\.\.\/users\.json" is not a usable file name for table "users"/);
      await broken(() => editManifest((value) => value.tables.push({ name: "users", file: "again.json" })), /lists the table "users" more than once/);
      await broken(() => editManifest((value) => (value.tables[1].file = "USERS.json")), /uses the file "USERS\.json" for more than one table/);
      // Two tables whose later files would get the same names.
      await broken(() => editManifest((value) => (value.tables[1].file = "users.g4.json")), /uses the file "users\.g4\.json" for more than one table/);
      await broken(() => rm(join(path, "tables/orders.json")), /Table "orders" has no file: .*orders\.json is listed in manifest\.json but does not exist/);
      await broken(() => rm(join(path, "schema.json")), /schema\.json is named in manifest\.json but does not exist/);
      await broken(() => writeFile(join(path, "tables/orders.json"), "[1, 2]"), /Table "orders" \(tables\/orders\.json\) must be an array of objects/);
      await broken(() => writeFile(join(path, "tables/orders.json"), "nope"), /tables\/orders\.json is not valid JSON/);
      await broken(() => writeFile(join(path, "tables/stray.json"), "[]"), /tables\/stray\.json is not listed in manifest\.json/);
      await broken(() => writeFile(join(path, "schema.json"), JSON.stringify({ tables: [{ name: "t", columns: [] }] })), /schema\.json: table "t" needs at least one column/);
    });

    it("accepts a directory whose manifest names no schema, and other files that are not tables", async () => {
      await create();
      // Written by hand: a manifest with tables only.
      await editManifest((value) => delete value.schema);
      await rm(join(path, "schema.json"));
      await writeFile(join(path, "README.md"), "notes");
      await writeFile(join(path, "tables/users.json.bak"), "old");
      const storage = reopen();
      assert.deepEqual((await storage.load()).collections.users, USERS);
      assert.equal(storage.schema, undefined);
    });

    it("takes a file in tables/ that is named after a generation and not listed for what it is: left by a save, and not a table", async () => {
      await create();
      await writeFile(join(path, "tables/users.g7.json"), '[{"id":99,"name":"Never saved","active":true}]');
      await writeFile(join(path, "tables/other.g3.json"), "not even JSON");
      assert.deepEqual((await reopen().load()).collections, { users: USERS, orders: ORDERS, empty: [] });
    });
  });

  describe("saving", () => {
    it("writes the new state of the tables that changed and leaves nothing temporary behind", async () => {
      await create();
      const storage = reopen();
      const state = await storage.load();
      state.collections.users = [...USERS, { id: 3, name: "Cy", active: true }];
      state.collections.orders = [];
      await storage.save(state);

      assert.deepEqual(Object.keys(await allFiles(path)), ["manifest.json", "schema.json", "tables/empty.json", "tables/orders.g2.json", "tables/users.g2.json"]);
      assert.deepEqual((await json("tables/users.json")).length, 3);
      assert.deepEqual(await json("tables/orders.json"), []);
      assert.deepEqual((await reopen().load()).collections, state.collections);
    });

    it("adds files for new tables and removes the files of tables that are gone", async () => {
      await create();
      const storage = reopen();
      const state = await storage.load();
      storage.saveSync({ ...state, collections: { users: USERS, "audit/log": [{ at: "now" }] } });

      assert.deepEqual(Object.keys(await allFiles(path)), ["manifest.json", "schema.json", "tables/audit%2Flog.g2.json", "tables/users.json"]);
      assert.deepEqual((await manifest()).tables, [
        { name: "users", file: "users.json" },
        { name: "audit/log", file: "audit%2Flog.g2.json" },
      ]);
      assert.deepEqual((await reopen().load()).collections, { users: USERS, "audit/log": [{ at: "now" }] });
    });

    it("keeps table names that are not safe file names, through the manifest", async () => {
      const collections = { "a/b": [{ n: 1 }], con: [{ n: 2 }], Users: [{ n: 3 }], users: [{ n: 4 }], "": [{ n: 5 }], "..": [{ n: 6 }] };
      const outside = async (): Promise<string[]> => Object.keys(await allFiles(root)).filter((name) => !name.startsWith("sandbox.db/"));
      const before = await outside();
      await createDatabase(path, { collections });
      assert.deepEqual((await manifest()).tables, [
        { name: "a/b", file: "a%2Fb.json" },
        { name: "con", file: "%63on.json" },
        { name: "Users", file: "Users.json" },
        { name: "users", file: "users~2.json" },
        { name: "", file: "~empty.json" },
        { name: "..", file: "%2E%2E.json" },
      ]);
      // Nothing was written outside the tables folder.
      assert.deepEqual(await outside(), before);
      assert.deepEqual(Object.keys(await allFiles(path)).filter((name) => !/^(manifest\.json|schema\.json|tables\/[^/]+\.json)$/.test(name)), []);
      assert.deepEqual((await reopen().load()).collections, collections);

      // Saved again, each keeps a file of its own, also where the names differ only in case.
      const storage = reopen();
      const state = await storage.load();
      storage.saveSync({ ...state, collections: Object.fromEntries(Object.entries(collections).map(([name, rows]) => [name, [...rows, { n: 0 }]])) });
      assert.deepEqual((await manifest()).tables.map((table: { file: string }) => table.file), ["a%2Fb.g2.json", "%63on.g2.json", "Users.g2.json", "users~2.g2.json", "~empty.g2.json", "%2E%2E.g2.json"]);
      assert.deepEqual((await reopen().load()).collections.users, [{ n: 4 }, { n: 0 }]);
    });

    it("keeps the configuration, the persistence mode, and extra keys of the manifest", async () => {
      await createDatabase(path, { collections: { users: USERS }, config: CONFIG, persistence: "memory", extra: { $notes: "kept", owner: { team: "core" } } });
      const storage = reopen();
      const state = await storage.load();
      assert.equal(storage.persistence, "memory");
      assert.deepEqual(storage.metadata(), { config: CONFIG, persistence: "memory", extra: { $notes: "kept", owner: { team: "core" } }, name: "sandbox" });

      state.collections.users = [];
      await storage.save(state);
      const saved = await manifest();
      assert.deepEqual([saved.persistence, saved.config, saved.extra], ["memory", CONFIG, { $notes: "kept", owner: { team: "core" } }]);
    });

    it("stores the table definitions it is given with the next save", async () => {
      await createDatabase(path, { collections: { users: USERS, orders: ORDERS } });
      const storage = reopen();
      const state = await storage.load();
      storage.describe(SCHEMA);
      assert.deepEqual(storage.schema, SCHEMA);
      assert.deepEqual((await json("schema.json")).tables, []);

      storage.saveSync(state);
      assert.equal((await manifest()).schema, "schema.g2.json");
      const reopened = reopen();
      await reopened.load();
      assert.deepEqual(reopened.schema, SCHEMA);
    });

    it("replaces the definitions of the tables it is given, and keeps the stored ones of other tables", async () => {
      await createDatabase(path, { collections: { users: USERS, orders: ORDERS }, schema: SCHEMA });
      const storage = reopen();
      const state = await storage.load();
      const [users, orders] = SCHEMA as [TableSchema, TableSchema];
      const usersNow: TableSchema = { name: "users", columns: [...users.columns, { name: "email", type: "text", nullable: true, primary: false }] };
      const audit: TableSchema = { name: "audit", columns: [{ name: "id", type: "integer", nullable: false, primary: true }] };

      // Given by someone who knows about "users" and "audit" only, as an application knows its own entities.
      storage.describe([audit, usersNow]);
      assert.deepEqual(storage.schema, [usersNow, orders, audit]);
      storage.saveSync(state);

      const reopened = reopen();
      await reopened.load();
      assert.deepEqual(reopened.schema, [usersNow, orders, audit]);
    });
  });

  describe("a save writes the tables that changed, and no others", () => {
    const reports: DirectorySaveReport[] = [];
    const open = async (): Promise<{ storage: DirectoryStorageAdapter; state: DatabaseState }> => {
      reports.length = 0;
      const storage = reopen({ onSave: (report) => reports.push(report) });
      return { storage, state: await storage.load() };
    };

    it("keeps the file of a table whose rows are the stored ones, also when it is given the whole state", async () => {
      await create();
      const { storage, state } = await open();
      const untouched = { orders: identity(tableFile(path, "orders")), empty: identity(tableFile(path, "empty")), schema: identity(join(path, "schema.json")) };

      state.collections.users = [...USERS, { id: 3, name: "Cy", active: true }];
      storage.saveSync(state);

      // The files of the other tables are the same files, not copies with the same text.
      assert.deepEqual({ orders: identity(tableFile(path, "orders")), empty: identity(tableFile(path, "empty")), schema: identity(join(path, "schema.json")) }, untouched);
      const [report] = reports as [DirectorySaveReport];
      assert.deepEqual(
        [report.kind, report.published, report.generation, report.serializedTables, report.writtenTables, report.reusedTables, report.schemaWritten],
        ["complete", true, 2, ["users", "orders", "empty"], ["users"], 2, false],
      );
      assert.equal(report.bytesWritten, statSync(tableFile(path, "users")).size + statSync(join(path, "manifest.json")).size);
      assert.deepEqual(storage.lastSave, report);
    });

    it("writes nothing at all when the state it is given is the stored one", async () => {
      await create();
      const { storage, state } = await open();
      const before = await allFiles(path);
      const identities = Object.keys(before).map((file) => identity(join(path, file)));

      storage.saveSync(state);
      storage.saveTablesSync({ users: structuredClone(USERS) });

      assert.deepEqual(await allFiles(path), before);
      assert.deepEqual(Object.keys(before).map((file) => identity(join(path, file))), identities);
      assert.deepEqual(reports.map((report) => [report.published, report.generation, report.writtenTables, report.bytesWritten]), [[false, 1, [], 0], [false, 1, [], 0]]);
      assert.equal(storage.generation, 1);
    });

    it("stores single tables without being given the others", async () => {
      await create();
      const { storage } = await open();
      const users = identity(tableFile(path, "users"));

      storage.saveTablesSync({ orders: [], added: [{ id: 1 }] });

      assert.deepEqual((await reopen().load()).collections, { users: USERS, orders: [], empty: [], added: [{ id: 1 }] });
      assert.equal(identity(tableFile(path, "users")), users);
      assert.deepEqual((await manifest()).tables.map((table: { file: string }) => table.file), ["users.json", "orders.g2.json", "empty.json", "added.g2.json"]);
      const [report] = reports as [DirectorySaveReport];
      assert.deepEqual([report.kind, report.serializedTables, report.writtenTables, report.reusedTables, report.removedTables], ["tables", ["orders", "added"], ["orders", "added"], 2, []]);
    });

    it("reports how long its steps took", async () => {
      await create();
      const { storage, state } = await open();
      state.collections.users = [];
      storage.saveSync(state);
      const [report] = reports as [DirectorySaveReport];
      for (const step of ["serializeMs", "writeMs", "publishMs", "cleanupMs", "totalMs"] as const) {
        assert.ok(report[step] >= 0 && Number.isFinite(report[step]), `${step} = ${report[step]}`);
      }
      assert.ok(report.totalMs >= report.serializeMs + report.writeMs + report.publishMs);
      assert.equal(report.sizeBytes, Object.values(await databaseFiles(path)).reduce((total, text) => total + Buffer.byteLength(text), 0));
    });

    it("keeps a replaced file for readers that are still reading it, and deletes it later", async () => {
      await create();
      const storage = reopen({ retiredFileGraceMs: 150 });
      const state = await storage.load();
      // A reader that has read the manifest and not yet the tables.
      const old = tableFile(path, "users");

      state.collections.users = [];
      storage.saveSync(state);
      assert.equal(existsSync(old), true);
      assert.deepEqual(JSON.parse(await readFile(old, "utf8")), USERS);
      // The manifest says that the file is on its way out, so that nobody takes it for a table that was added by hand.
      assert.deepEqual((await manifest()).retired, ["users.json"]);
      assert.deepEqual((await new DirectoryStorageAdapter(path).load()).collections.users, []);

      await delay(400);
      assert.equal(existsSync(old), false);
      assert.deepEqual(Object.keys(await allFiles(path)), ["manifest.json", "schema.json", "tables/empty.json", "tables/orders.json", "tables/users.g2.json"]);
      // The next save drops it from the manifest.
      state.collections.users = [{ id: 4, name: "Di", active: true }];
      storage.saveSync(state);
      assert.equal((await manifest()).retired, undefined);
    });

    it("keeps no more than a few dozen replaced files, however quickly saves follow each other", async () => {
      await create();
      // An hour of grace: time alone would keep every replaced file.
      const storage = new DirectoryStorageAdapter(path, { retiredFileGraceMs: 3_600_000 });
      const state = await storage.load();
      for (let round = 1; round <= 60; round += 1) {
        state.collections.users = [{ id: round, name: "Round", active: true }];
        storage.saveSync(state);
      }
      const tables = Object.keys(await allFiles(path)).filter((file) => file.startsWith("tables/"));
      // The three tables, and the 32 files that were replaced last.
      assert.equal(tables.length, 3 + 32);
      assert.ok(tables.includes("tables/users.g61.json") && tables.includes("tables/users.g29.json") && !tables.includes("tables/users.g28.json"), tables.join(" "));
      assert.deepEqual((await reopen().load()).collections.users, [{ id: 60, name: "Round", active: true }]);
    });

    it("does not delete the files of another database that has taken the directory's place", async () => {
      await create();
      const storage = reopen({ retiredFileGraceMs: 100 });
      const state = await storage.load();
      state.collections.users = [];
      // "users.json" is due for deletion in 100 ms.
      storage.saveSync(state);

      await rm(path, { recursive: true, force: true });
      await create();
      await delay(300);
      assert.deepEqual(Object.keys(await allFiles(path)), NEW_FILES);
      assert.deepEqual((await reopen().load()).collections.users, USERS);
    });
  });

  describe("a save is all or nothing", () => {
    it("leaves the previous generation in place when a file of the new one cannot be written", async () => {
      await create();
      const storage = reopen();
      const state = await storage.load();
      state.collections.empty = [{ id: 1 }];
      storage.saveSync(state);
      const before = await allFiles(path);

      // The second table's new file cannot be created: something is in its place.
      await mkdir(join(path, "tables/orders.g3.json"));
      const changed = { ...state, collections: { ...state.collections, users: [], orders: [{ id: 11, userId: 2, total: 5 }] } };
      assert.throws(() => storage.saveSync(changed), refused(/Cannot write database directory.*A file of the new generation was already there/));
      await rm(join(path, "tables/orders.g3.json"), { recursive: true });

      // Nothing of the failed save is left, and the database is what it was.
      assert.deepEqual(await allFiles(path), before);
      assert.deepEqual((await reopen().load()).collections, state.collections);

      // The same save goes through once nothing is in the way, under a generation number of its own.
      storage.saveSync(changed);
      assert.deepEqual((await reopen().load()).collections, changed.collections);
      assert.equal((await manifest()).generation, 4);
    });

    it("is the previous generation until the manifest is replaced, whatever a save that was interrupted before that wrote", async () => {
      await create();
      const before = await databaseFiles(path);
      // A save that was killed after it had written its files and filled in the next manifest.
      await writeFile(join(path, "tables/users.g2.json"), "[]\n");
      await writeFile(join(path, "tables/orders.g2.json"), "[\n  {\n    \"id\": 99");
      const next = await manifest();
      next.generation = 2;
      next.tables[0].file = "users.g2.json";
      next.tables[1].file = "orders.g2.json";
      await writeFile(join(path, "manifest.json.tmp"), JSON.stringify(next));
      const longAgo = new Date(Date.now() - 60_000);
      await utimes(join(path, "manifest.json.tmp"), longAgo, longAgo);

      const storage = reopen();
      const state = await storage.load();
      assert.deepEqual(state.collections, { users: USERS, orders: ORDERS, empty: [] });
      assert.deepEqual(await databaseFiles(path), before);

      // The next save removes what was left, and uses the names for its own files.
      state.collections.orders = [];
      storage.saveSync(state);
      assert.deepEqual(Object.keys(await allFiles(path)), ["manifest.json", "schema.json", "tables/empty.json", "tables/orders.g2.json", "tables/users.json"]);
      assert.deepEqual((await reopen().load()).collections, { users: USERS, orders: [], empty: [] });
    });

    it("is the new generation, complete, once the manifest is replaced, whatever the save did not get to afterwards", async () => {
      await create();
      // A save that was killed right after the manifest was in place: the files it replaced are still there.
      const interrupted = new DirectoryStorageAdapter(path, { retiredFileGraceMs: 3_600_000 });
      const state = await interrupted.load();
      const changed = { users: [{ id: 9, name: "New", active: true }], orders: [], empty: [{ id: 1 }] };
      interrupted.saveSync({ ...state, collections: changed });
      assert.equal(Object.keys(await allFiles(path)).length, NEW_FILES.length + 3);

      // Every reader gets the new state, all tables together.
      assert.deepEqual((await reopen().load()).collections, changed);
      // Whoever saves next removes the files that are no longer part of the database.
      const storage = reopen();
      const next = await storage.load();
      next.collections.empty = [];
      storage.saveSync(next);
      assert.deepEqual(Object.keys(await allFiles(path)), ["manifest.json", "schema.json", "tables/empty.g3.json", "tables/orders.g2.json", "tables/users.g2.json"]);
      assert.deepEqual((await reopen().load()).collections, { ...changed, empty: [] });
    });

    it("is never seen half done by a reader while another process saves, also when that process is killed", { timeout: 90_000 }, async () => {
      // Each save changes one pair of tables and a table that every save changes, out of 25. A reader must find
      // the two tables of every pair at the same save, and the newest of those saves in the table every save changes.
      const pairs = 12;
      const collections: Record<string, Row[]> = { head: [{ save: 0 }] };
      for (let pair = 0; pair < pairs; pair += 1) {
        collections[`left_${pair}`] = [{ save: 0 }];
        collections[`right_${pair}`] = [{ save: 0 }];
      }
      await createDatabase(path, { collections });
      const writerScript = join(root, "writer.mjs");
      await writeFile(
        writerScript,
        `import { DirectoryStorageAdapter } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href)};\n` +
          "const [path, durationMs] = process.argv.slice(2);\n" +
          "const storage = new DirectoryStorageAdapter(path);\n" +
          "const state = await storage.load();\n" +
          "let save = Math.max(...Object.values(state.collections).map((rows) => rows[0].save));\n" +
          "for (const end = Date.now() + Number(durationMs); Date.now() < end; ) {\n" +
          "  save += 1;\n" +
          `  const pair = save % ${pairs};\n` +
          "  storage.saveTablesSync({ [`left_${pair}`]: [{ save }], [`right_${pair}`]: [{ save }], head: [{ save }] });\n" +
          "  process.stdout.write(`${save}\\n`);\n" +
          "  if (save % 5 === 0) await new Promise((resolve) => setImmediate(resolve));\n" +
          "}\n",
      );
      const consistent = (read: Record<string, Row[]>): number => {
        const saves = Array.from({ length: pairs }, (_, pair) => {
          assert.equal(read[`left_${pair}`]?.[0]?.save, read[`right_${pair}`]?.[0]?.save, `pair ${pair} was read from two different saves`);
          return read[`left_${pair}`]?.[0]?.save as number;
        });
        assert.equal(read.head?.[0]?.save, Math.max(...saves), "the tables were read from different saves");
        return read.head?.[0]?.save as number;
      };
      /** Reads for as long as a writer runs, and returns the saves that were seen. With `killAfter`, the writer is killed outright after that many saves. */
      const readWhileWriting = async (durationMs: number, killAfter?: number): Promise<{ seen: Set<number>; reported: number; code: number | null }> => {
        const writer = spawn(process.execPath, [writerScript, path, String(durationMs)], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let problems = "";
        writer.stdout.on("data", (chunk) => {
          output += chunk;
          if (killAfter !== undefined && output.split("\n").length > killAfter) {
            writer.kill("SIGKILL");
          }
        });
        writer.stderr.on("data", (chunk) => (problems += chunk));
        let running = true;
        const exited = new Promise<number | null>((resolve) => writer.once("exit", (code) => resolve(code)));
        void exited.then(() => (running = false));
        const seen = new Set<number>();
        try {
          while (running) {
            // A read never gives up: the files of the generation it reads stay until it is done.
            seen.add(consistent((await new DirectoryStorageAdapter(path).load()).collections));
            await new Promise((resolve) => setImmediate(resolve));
          }
        } finally {
          if (running) {
            writer.kill();
          }
        }
        const code = await exited;
        assert.equal(problems, "");
        return { seen, reported: Number(output.trim().split("\n").at(-1)), code };
      };

      const first = await readWhileWriting(2500);
      assert.equal(first.code, 0);
      assert.ok(first.seen.size >= 5, `the reads overlapped too few saves to mean anything (${first.seen.size} saves seen)`);
      assert.equal(consistent((await reopen().load()).collections), first.reported);

      // Killed in the middle of its saves: what it leaves is one of its saves, complete.
      const killed = await readWhileWriting(20_000, 40);
      assert.notEqual(killed.code, 0);
      const left = consistent((await reopen().load()).collections);
      assert.ok(left >= killed.reported, `the database is at save ${left}, before save ${killed.reported} that the writer had reported`);
      // And the next process saves on from there.
      const last = await readWhileWriting(500);
      assert.equal(last.code, 0);
      assert.ok(last.reported > left);
      assert.equal(consistent((await reopen().load()).collections), last.reported);
    });
  });

  describe("one process saves at a time", () => {
    it("refuses a save from an adapter whose database was saved by something else since it loaded it", async () => {
      await create();
      const first = reopen();
      const second = reopen();
      const state = await first.load();
      const stale = await second.load();

      state.collections.users = [];
      first.saveSync(state);
      const before = await allFiles(path);

      stale.collections.orders = [];
      assert.throws(() => second.saveSync(stale), refused(/was saved by something else since it was loaded here.*One process saves a database at a time/));
      assert.throws(() => second.saveTablesSync({ orders: [] }), refused(/was saved by something else/));
      assert.deepEqual(await allFiles(path), before);

      // Loaded again, it is up to date and may save.
      const fresh = await second.load();
      fresh.collections.orders = [];
      second.saveSync(fresh);
      assert.deepEqual((await reopen().load()).collections, { users: [], orders: [], empty: [] });
      // And now the first one is behind.
      assert.throws(() => first.saveSync(state), refused(/was saved by something else/));
    });

    it("refuses to save to a database that it did not load", async () => {
      await create();
      const before = await allFiles(path);
      assert.throws(() => reopen().saveSync({ meta: { version: 3 }, collections: { users: [] } }), refused(/holds a database that was not loaded here\. Load it before saving to it\./));
      assert.deepEqual(await allFiles(path), before);
    });

    it("refuses a save while another running process is saving, and leaves that save alone", async () => {
      await create();
      const storage = reopen();
      const state = await storage.load();
      // What a save by another process looks like while it runs: the next manifest in the making, with that process's id.
      await writeFile(join(path, "manifest.json.tmp"), String(process.ppid));
      const before = await allFiles(path);

      state.collections.users = [];
      assert.throws(() => storage.saveSync(state), refused(new RegExp(`is being saved by another process \\(pid ${process.ppid}\\)`)));
      assert.deepEqual(await allFiles(path), before);
      // Reading is not affected.
      assert.deepEqual((await reopen().load()).collections.users, USERS);

      // That save ended without finishing, as its process did: the next one takes over.
      await writeFile(join(path, "manifest.json.tmp"), "999999999");
      storage.saveSync(state);
      assert.deepEqual((await reopen().load()).collections.users, []);
      assert.equal(existsSync(join(path, "manifest.json.tmp")), false);
    });
  });

  describe("a directory in another format", () => {
    const formatError = (code: string, message: RegExp) => {
      return (error: unknown): boolean => {
        assert.ok(error instanceof DatabaseFormatError, String(error));
        assert.equal(error.code, code);
        assert.match(error.message, message);
        return true;
      };
    };

    it("of an earlier format is read as it is, and reading changes nothing", async () => {
      await createLegacy();
      const before = await allFiles(path);
      const storage = reopen();
      assert.deepEqual(await storage.load(), { meta: { version: 2 }, collections: { users: USERS, orders: ORDERS, empty: [] } });
      assert.deepEqual([storage.schema, storage.config, storage.generation], [SCHEMA, CONFIG, 0]);
      assert.deepEqual(
        [storage.formatStatus?.compatibility, storage.formatStatus?.readable, storage.formatStatus?.writable, storage.formatStatus?.migrationPath],
        ["older", true, false, [2, 3, 4, 5]],
      );
      assert.deepEqual(await allFiles(path), before);
    });

    it("of an earlier format is never brought to this one by a save: the save is refused and says how to migrate", async () => {
      await createLegacy();
      const before = await allFiles(path);
      const storage = reopen();
      const state = await storage.load();
      state.collections.users = [...USERS, { id: 3, name: "Cy", active: true }];

      const refusal = formatError("DATABASE_MIGRATION_REQUIRED", /sandbox\.db: Database format 2 is older than the format this build writes \(5\)\. It can be read as it is, and was not changed\. To change it, migrate it first: local-db-sandbox migrate .*sandbox\.db$/);
      assert.throws(() => storage.assertWritable(), refusal);
      assert.throws(() => storage.saveSync(state), refusal);
      assert.throws(() => storage.saveTablesSync({ users: state.collections.users as Row[] }), refusal);
      await assert.rejects(storage.save(state), refusal);
      // A save that changes nothing is refused as well: it would have rewritten the manifest.
      assert.throws(() => reopen().saveSync({ meta: { version: 2 }, collections: {} }), refused(/holds a database that was not loaded here/));
      assert.deepEqual(await allFiles(path), before);
    });

    it("of a later format is refused, and nothing of it is read", async () => {
      await create();
      await editManifest((value) => {
        value.formatVersion = 6;
        value.minimumReaderVersion = 6;
        // What a later format may hold is not known: this must not be looked at.
        value.tables = "not what this build expects";
      });
      const before = await allFiles(path);
      const storage = reopen();
      await assert.rejects(storage.load(), formatError("DATABASE_FORMAT_TOO_NEW", /sandbox\.db: Database format 6 is newer than this build supports \(max 5\)\. Upgrade local-db-sandbox\.$/));
      assert.equal(storage.formatStatus, undefined);
      assert.deepEqual(await allFiles(path), before);

      // Without the second number, a later format says nothing about earlier readers: it is not read either.
      await editManifest((value) => delete value.minimumReaderVersion);
      await assert.rejects(reopen().load(), formatError("DATABASE_FORMAT_TOO_NEW", /Database format 6 is newer than this build supports \(max 5\)/));
    });

    it("of a later format that says readers of this one can read it is read, and not saved to", async () => {
      await create();
      // Format 6, and readers of format 5 read it.
      await editManifest((value) => Object.assign(value, { formatVersion: 6, minimumReaderVersion: 5 }));
      const before = await allFiles(path);
      const storage = reopen();
      const state = await storage.load();
      assert.deepEqual(state, { meta: { version: 6 }, collections: { users: USERS, orders: ORDERS, empty: [] } });
      assert.deepEqual([storage.formatStatus?.compatibility, storage.formatStatus?.readable, storage.formatStatus?.writable], ["newer", true, false]);

      assert.throws(
        () => storage.saveSync({ meta: { version: 6 }, collections: { users: USERS, orders: ORDERS, empty: [{ id: 1 }] } }),
        formatError("DATABASE_FORMAT_READ_ONLY", /Database format 6 is newer than this build supports \(max 5\)\. It says that a reader of format 5 can read it, so it was read, but it cannot be changed by this build\. Upgrade local-db-sandbox\.$/),
      );
      assert.deepEqual(await allFiles(path), before);
    });

    it("of a format older than any this build migrates is refused, with what to do", async () => {
      await createLegacy();
      await editManifest((value) => (value.formatVersion = 1));
      const before = await allFiles(path);
      await assert.rejects(
        reopen().load(),
        formatError("DATABASE_FORMAT_TOO_OLD", /sandbox\.db: Database format 1 is older than this build supports \(oldest: 2\)\. Migrate it with an earlier version of local-db-sandbox, one that reads format 1, and then with this one\.$/),
      );
      assert.deepEqual(await allFiles(path), before);
    });

    it("is replaced by a database of this format when a new one is written over it on purpose", async () => {
      await createLegacy();
      await assert.rejects(createDatabase(path, { collections: { notes: [{ id: 1 }] } }), refused(/already exists/));
      await createDatabase(path, { collections: { notes: [{ id: 1 }] } }, { overwrite: true, retiredFileGraceMs: 0 } as object);

      const saved = await manifest();
      // Its files are named after the generation, as those of every save over a database that is there.
      assert.deepEqual([saved.formatVersion, saved.minimumReaderVersion, saved.generation, saved.tables], [5, 5, 1, [{ name: "notes", file: "notes.g1.json" }]]);
      assert.deepEqual((await reopen().load()).collections, { notes: [{ id: 1 }] });
    });
  });

  describe("size limit", () => {
    const big = (bytes: number): Row[] => [{ id: 1, text: "x".repeat(bytes) }];

    it("counts every file of the database when saving, and writes nothing above the limit", async () => {
      await create();
      const storage = reopen({ maxFileSizeMb: 0.004 });
      const state = await storage.load();
      const before = await allFiles(path);

      // Each table is below the limit on its own; together they are above it.
      const tooBig = { ...state, collections: { users: big(1500), orders: big(1500), empty: big(1500) } };
      assert.throws(() => storage.saveSync(tooBig), (error) => error instanceof SandboxLimitError && Math.abs(error.limitBytes - 0.004 * 1024 * 1024) < 1 && error.sizeBytes > error.limitBytes);
      await assert.rejects(storage.save(tooBig), (error) => error instanceof SandboxLimitError);
      assert.deepEqual(await allFiles(path), before);

      storage.saveSync({ ...state, collections: { users: big(1500), orders: [], empty: [] } });
      assert.equal((await json("tables/users.json"))[0].text.length, 1500);
    });

    it("counts the tables that a save of single tables does not touch, and leaves the previous generation as it was", async () => {
      await create({ users: big(1500), orders: big(1500), empty: [] });
      const storage = reopen({ maxFileSizeMb: 0.005 });
      await storage.load();
      const before = await allFiles(path);

      // One more table of that size is too much, although it is the only one that is saved.
      assert.throws(() => storage.saveTablesSync({ empty: big(1500) }), (error) => error instanceof SandboxLimitError && error.sizeBytes > 0.005 * 1024 * 1024);
      assert.deepEqual(await allFiles(path), before);
      assert.equal(storage.generation, 1);

      // The files of earlier generations do not count: a table can be replaced any number of times.
      const keeping = new DirectoryStorageAdapter(path, { maxFileSizeMb: 0.005, retiredFileGraceMs: 3_600_000 });
      await keeping.load();
      for (let round = 1; round <= 4; round += 1) {
        keeping.saveTablesSync({ users: big(1500 + round) });
      }
      const onDisk = Object.values(await allFiles(path)).reduce((total, text) => total + Buffer.byteLength(text), 0);
      assert.ok(onDisk > 0.005 * 1024 * 1024, `${onDisk} bytes are in the directory`);
      assert.ok((keeping.lastSave as DirectorySaveReport).sizeBytes < 0.005 * 1024 * 1024);
      // And a database is loaded by what it consists of, not by what is in its directory.
      await reopen({ maxFileSizeMb: 0.005 }).load();
      assert.equal((await storedRows(path, "users"))[0]?.text.length, 1504);
    });

    it("refuses to load a database above the limit, measured across its files", async () => {
      await create({ users: big(2000), orders: big(2000), empty: [] });
      await assert.rejects(reopen({ maxFileSizeMb: 0.003 }).load(), (error) => error instanceof SandboxLimitError && /above the limit/.test(error.message));
      assert.deepEqual(Object.keys((await reopen({ maxFileSizeMb: 0.01 }).load()).collections), ["users", "orders", "empty"]);
    });

    it("lets the manifest's configuration lower the limit, not raise it", async () => {
      const limited = { config: { limits: { maxFileSizeMb: 0.002 } } };
      // A database cannot be created above its own limit either.
      await assert.rejects(create({ users: big(3000) }, limited), (error) => error instanceof SandboxLimitError);
      assert.equal(existsSync(join(path, "manifest.json")), false);

      await create({ users: big(100) }, limited);
      const storage = reopen({ maxFileSizeMb: 100 });
      const state = await storage.load();
      assert.ok(Math.abs(storage.maxFileSizeBytes - 0.002 * 1024 * 1024) < 1);
      assert.throws(() => storage.saveSync({ ...state, collections: { users: big(3000) } }), (error) => error instanceof SandboxLimitError);

      // Edited by hand to more than its configuration allows: refused when loaded.
      await writeFile(join(path, "tables/users.json"), JSON.stringify(big(3000)));
      await assert.rejects(reopen().load(), (error) => error instanceof SandboxLimitError);
      // A limit given from outside is checked before anything of the database is read.
      await assert.rejects(reopen({ maxFileSizeMb: 0.0001 }).load(), (error) => error instanceof SandboxLimitError);
    });

    it("does not count files that are not part of the database", async () => {
      await create();
      await writeFile(join(path, "notes.txt"), "n".repeat(50_000));
      await writeFile(join(path, "tables/export.csv"), "c".repeat(50_000));
      // Neither does it count the file of a save that was never finished.
      await writeFile(join(path, "tables/users.g9.json"), "u".repeat(50_000));
      assert.deepEqual((await reopen({ maxFileSizeMb: 0.004 }).load()).collections.users, USERS);
    });

    it("warns by the total size of the database, not the size of one file", async () => {
      const megabytes = (count: number): Row[] => [{ text: "x".repeat(count * 1024 * 1024) }];
      await createDatabase(path, { collections: { a: megabytes(13), b: megabytes(13) } });
      const warnings: SizeWarning[] = [];
      await reopen({ onSizeWarning: (warning) => warnings.push(warning) }).load();
      assert.deepEqual(warnings.map((warning) => [warning.level, warning.phase, warning.sizeBytes > 26 * 1024 * 1024]), [["warning", "load", true]]);
    });
  });

  describe("under the core and the relational runtime", () => {
    it("persists core CRUD, as the single-file adapter does", async () => {
      await create();
      const database = await Database.open(reopen());
      const orders = identity(tableFile(path, "orders"));
      const created = await database.insert("users", { name: "Cy", active: true });
      // The core saves its whole state; only the table that changed is written.
      assert.equal(identity(tableFile(path, "orders")), orders);
      await database.patch("orders", 10, { total: 31 });
      await database.remove("users", 1);

      assert.deepEqual(created, { name: "Cy", active: true, id: 3 });
      assert.deepEqual(await storedRows(path, "users"), [USERS[1], { name: "Cy", active: true, id: 3 }]);
      assert.deepEqual(await storedRows(path, "orders"), [{ id: 10, userId: 1, total: 31 }]);
      assert.deepEqual((await Database.open(reopen())).listCollections(), ["users", "orders", "empty"]);
    });

    it("saves the tables of a transaction together at its commit, and nothing on rollback", async () => {
      await create({ users: USERS, orders: ORDERS });
      const storage = reopen();
      const runtime = await SqliteRuntime.open({ schema: SCHEMA, storage });
      const before = await allFiles(path);

      runtime.begin();
      runtime.execute("INSERT INTO users (display_name) VALUES ('Cy')");
      runtime.execute("INSERT INTO orders (userId, total) VALUES (3, 7)");
      assert.deepEqual(await allFiles(path), before);
      runtime.commit();
      assert.deepEqual((await storedRows(path, "users")).at(-1), { id: 3, name: "Cy", active: true });
      assert.deepEqual((await storedRows(path, "orders")).at(-1), { id: 11, userId: 3, total: 7 });
      assert.equal(storage.generation, 2);

      const committed = await allFiles(path);
      runtime.begin();
      runtime.execute("DELETE FROM orders");
      runtime.execute("UPDATE users SET active = 0");
      runtime.rollback();
      assert.deepEqual(await allFiles(path), committed);
      runtime.close();

      const reopened = await SqliteRuntime.open({ schema: SCHEMA, storage: reopen() });
      assert.deepEqual(reopened.execute("SELECT COUNT(*) AS n FROM orders").rows, [{ n: 2 }]);
    });

    it("refuses a commit above the size limit and keeps the previous directory and the runtime as they were", async () => {
      await create({ users: USERS, orders: ORDERS });
      const runtime = await SqliteRuntime.open({ schema: SCHEMA, storage: reopen({ maxFileSizeMb: 0.003 }) });
      const before = await allFiles(path);

      assert.throws(() => runtime.execute("INSERT INTO users (display_name) VALUES (?)", ["x".repeat(5000)]), (error) => error instanceof SandboxLimitError);
      runtime.begin();
      runtime.execute("UPDATE users SET display_name = ?", ["y".repeat(5000)]);
      runtime.execute("DELETE FROM orders");
      assert.throws(() => runtime.commit(), (error) => error instanceof SandboxLimitError);

      assert.deepEqual(await allFiles(path), before);
      assert.deepEqual(runtime.snapshot().collections, { users: USERS, orders: ORDERS });
      runtime.execute("UPDATE users SET display_name = 'Adah' WHERE id = 1");
      assert.equal((await storedRows(path, "users"))[0]?.name, "Adah");
      // The table that the refused transaction would have emptied was not written since.
      assert.equal(tableFile(path, "orders"), join(path, "tables", "orders.json"));
    });
  });
});

/** The state a directory database holds, for comparing two of them. */
export async function directoryState(path: string): Promise<DatabaseState["collections"]> {
  return (await new DirectoryStorageAdapter(path).load()).collections;
}
