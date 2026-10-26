import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createDatabase } from "../../storage-json/src/index.ts";
import { databaseFiles } from "../../storage-json/test/support/database-files.ts";
import { NestSandboxError, initNest } from "../src/index.ts";
import { createNestProject } from "./support/nest-project.ts";

/*
 * Which database `init-nest` sets a project up with: a database directory for
 * a new project, and whatever an existing project already uses. The project
 * is a copy of fixtures/nest-project, with the entities Category and User.
 */
describe("init-nest and the format of the database", { timeout: 120_000 }, () => {
  let dir: string;

  /** A JSON file of the project. One of the database directory is looked up by what it is, not by the name it has now. */
  const json = async (path: string): Promise<any> => {
    const inDatabase = /^sandbox\.db\/(.+)$/.exec(path)?.[1];
    return JSON.parse(inDatabase === undefined ? await readFile(join(dir, path), "utf8") : ((await directoryFiles())[inDatabase] as string));
  };
  const configured = async (): Promise<string> => (await json(".local-db-sandbox/sandbox.config.json")).database;
  /** The files the project's database directory consists of now, under the names they have in a new database. */
  const directoryFiles = (): Promise<Record<string, string>> => databaseFiles(join(dir, "sandbox.db"));
  const declared = async (): Promise<[string, string[]][]> =>
    (await json("sandbox.db/schema.json")).tables.map((table: { name: string; columns: { column: string }[] }) => [table.name, table.columns.map((column) => column.column)]);

  before(async () => {
    dir = await createNestProject();
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  beforeEach(async () => {
    for (const name of [".local-db-sandbox", "sandbox.db", "sandbox.db.json", "data"]) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  });

  describe("a new project", () => {
    it("gets a database directory: a manifest, the entities' table definitions, and an empty file per table", async () => {
      const result = await initNest({ cwd: dir });
      assert.deepEqual(result.database, { file: "sandbox.db", format: "directory", created: true, addedCollections: ["category", "users"], definitionsUpdated: false });
      assert.equal(await configured(), "../sandbox.db");
      assert.equal(existsSync(join(dir, "sandbox.db.json")), false);

      assert.deepEqual(Object.keys(await directoryFiles()).sort(), ["manifest.json", "schema.json", "tables/category.json", "tables/users.json"]);
      assert.deepEqual(await json("sandbox.db/manifest.json"), {
        formatVersion: 5,
        minimumReaderVersion: 5,
        database: "sandbox",
        persistence: "json",
        generation: 1,
        schema: "schema.json",
        tables: [
          { name: "category", file: "category.json" },
          { name: "users", file: "users.json" },
        ],
      });
      assert.deepEqual([await json("sandbox.db/tables/category.json"), await json("sandbox.db/tables/users.json")], [[], []]);
      assert.deepEqual(await json("sandbox.db/schema.json"), {
        schemaVersion: 2,
        tables: [
          {
            name: "category",
            columns: [
              // "canonicalType" is what the column is in the database the entity was written for, as TypeORM creates it there (D-040).
              { column: "code", property: "code", type: "text", declaredType: "String", canonicalType: { kind: "varchar" }, nullable: false, primaryKey: true },
              { column: "label", property: "label", type: "text", declaredType: "String", canonicalType: { kind: "varchar" }, nullable: false, primaryKey: false },
            ],
          },
          {
            name: "users",
            columns: [
              // "type" is how the values are stored; "declaredType" is what the entity declared, here by the properties' own types.
              { column: "id", property: "id", type: "integer", declaredType: "Number", canonicalType: { kind: "integer", bits: 32 }, nullable: false, primaryKey: true, generated: "increment" },
              { column: "name", property: "name", type: "text", declaredType: "String", canonicalType: { kind: "varchar" }, nullable: false, primaryKey: false },
              { column: "active", property: "active", type: "boolean", declaredType: "Boolean", canonicalType: { kind: "boolean" }, nullable: false, primaryKey: false, default: true },
              { column: "createdAt", property: "createdAt", type: "datetime", declaredType: "@CreateDateColumn", canonicalType: { kind: "timestamp", withTimeZone: false }, nullable: false, primaryKey: false },
            ],
          },
        ],
      });
    });

    it("gets a single file when a .json path is asked for", async () => {
      const result = await initNest({ cwd: dir, database: "data/fixtures.json" });
      assert.deepEqual(result.database, { file: "data/fixtures.json", format: "file", created: true, addedCollections: ["category", "users"], definitionsUpdated: false });
      assert.equal(await configured(), "../data/fixtures.json");
      assert.deepEqual(await json("data/fixtures.json"), { $meta: { version: 1 }, data: { category: [], users: [] } });
      assert.equal(existsSync(join(dir, "sandbox.db")), false);
    });

    it("gets a directory at the path that is asked for", async () => {
      const result = await initNest({ cwd: dir, database: "data/fixtures" });
      assert.deepEqual([result.database.file, result.database.format, await configured()], ["data/fixtures", "directory", "../data/fixtures"]);
      assert.deepEqual((await readdir(join(dir, "data/fixtures"))).sort(), ["manifest.json", "schema.json", "tables"]);
      assert.equal((await json("data/fixtures/manifest.json")).database, "fixtures");
    });
  });

  describe("a project that already uses sandbox.db.json", () => {
    const LEGACY = `${JSON.stringify({ $meta: { version: 1 }, $config: { limits: { maxFileSizeMb: 20 } }, data: { category: [{ code: "books", label: "Books" }], users: [] } }, null, 2)}\n`;

    it("keeps the file it was set up with, byte for byte", async () => {
      // What an earlier version of init-nest left behind.
      await mkdir(join(dir, ".local-db-sandbox"));
      await writeFile(join(dir, ".local-db-sandbox/sandbox.config.json"), JSON.stringify({ entry: "../src/main.ts", database: "../sandbox.db.json", port: 3055 }));
      await writeFile(join(dir, "sandbox.db.json"), LEGACY);

      const result = await initNest({ cwd: dir });
      assert.deepEqual(result.database, { file: "sandbox.db.json", format: "file", created: false, addedCollections: [], definitionsUpdated: false });
      assert.equal(result.port, 3055);
      assert.equal(await configured(), "../sandbox.db.json");
      assert.equal(await readFile(join(dir, "sandbox.db.json"), "utf8"), LEGACY);
      assert.equal(existsSync(join(dir, "sandbox.db")), false);
    });

    it("keeps a file that is in the project without a configuration, and only adds what is missing", async () => {
      await writeFile(join(dir, "sandbox.db.json"), JSON.stringify({ data: { category: [{ code: "books", label: "Books" }] } }));

      const result = await initNest({ cwd: dir });
      assert.deepEqual(result.database, { file: "sandbox.db.json", format: "file", created: false, addedCollections: ["users"], definitionsUpdated: false });
      assert.equal(await configured(), "../sandbox.db.json");
      // The same format as before: the rows are kept, and no table definitions are written into it.
      assert.deepEqual(await json("sandbox.db.json"), { data: { category: [{ code: "books", label: "Books" }], users: [] } });
      assert.equal(existsSync(join(dir, "sandbox.db")), false);
    });

    it("moves to a directory only when the project is pointed at one", async () => {
      await writeFile(join(dir, "sandbox.db.json"), LEGACY);
      await initNest({ cwd: dir });
      assert.equal(await configured(), "../sandbox.db.json");

      const result = await initNest({ cwd: dir, database: "sandbox.db" });
      assert.deepEqual([result.database.format, result.database.created, await configured()], ["directory", true, "../sandbox.db"]);
      // The file is left where it is; "convert" is what copies its rows, and the result says so.
      assert.equal(await readFile(join(dir, "sandbox.db.json"), "utf8"), LEGACY);
      assert.deepEqual(await json("sandbox.db/tables/category.json"), []);
      assert.deepEqual(result.warnings, [
        'The sandbox now uses sandbox.db, which is new and empty. The rows of sandbox.db.json were not copied; "local-db-sandbox convert sandbox.db.json --out sandbox.db --force" copies them.',
      ]);
      // Nothing to warn about once the project uses it.
      assert.deepEqual((await initNest({ cwd: dir })).warnings, []);
    });
  });

  describe("a project that already has a database directory", () => {
    it("changes nothing when the directory has every table and the current definitions", async () => {
      await initNest({ cwd: dir });
      await writeFile(join(dir, "sandbox.db/tables/category.json"), '[{"code":"books","label":"Books"}]');
      const before = await directoryFiles();

      const result = await initNest({ cwd: dir });
      assert.deepEqual(result.database, { file: "sandbox.db", format: "directory", created: false, addedCollections: [], definitionsUpdated: false });
      assert.deepEqual(await directoryFiles(), before);
    });

    it("adds the tables of new entities and keeps the rows that are there", async () => {
      await createDatabase(join(dir, "sandbox.db"), { collections: { category: [{ code: "books", label: "Books" }], notes: [{ text: "mine" }] }, config: { limits: { maxFileSizeMb: 20 } } });

      const result = await initNest({ cwd: dir });
      assert.deepEqual(result.database, { file: "sandbox.db", format: "directory", created: false, addedCollections: ["users"], definitionsUpdated: true });
      assert.deepEqual((await json("sandbox.db/manifest.json")).tables.map((table: { name: string }) => table.name), ["category", "notes", "users"]);
      assert.deepEqual((await json("sandbox.db/manifest.json")).config, { limits: { maxFileSizeMb: 20 } });
      assert.deepEqual([await json("sandbox.db/tables/category.json"), await json("sandbox.db/tables/notes.json"), await json("sandbox.db/tables/users.json")], [[{ code: "books", label: "Books" }], [{ text: "mine" }], []]);
      // Tables the entities do not describe keep having no stored definition.
      assert.deepEqual(await declared(), [["category", ["code", "label"]], ["users", ["id", "name", "active", "createdAt"]]]);
    });

    it("brings stored definitions that fell behind the entities up to date, keeping the rows", async () => {
      await initNest({ cwd: dir });
      await writeFile(join(dir, "sandbox.db/tables/category.json"), JSON.stringify([{ code: "books", label: "Books" }]));
      const schema = await json("sandbox.db/schema.json");
      schema.tables[0].columns.pop();
      await writeFile(join(dir, "sandbox.db/schema.json"), JSON.stringify(schema));
      assert.deepEqual((await declared())[0], ["category", ["code"]]);

      const result = await initNest({ cwd: dir });
      assert.deepEqual(result.database, { file: "sandbox.db", format: "directory", created: false, addedCollections: [], definitionsUpdated: true });
      assert.deepEqual((await declared())[0], ["category", ["code", "label"]]);
      assert.deepEqual(await json("sandbox.db/tables/category.json"), [{ code: "books", label: "Books" }]);
      assert.equal((await initNest({ cwd: dir })).database.definitionsUpdated, false);
    });

    it("refuses a folder that is not a database, and a database it cannot read", async () => {
      await mkdir(join(dir, "sandbox.db", "notes"), { recursive: true });
      await writeFile(join(dir, "sandbox.db", "notes", "todo.txt"), "not a database");
      await assert.rejects(initNest({ cwd: dir }), (error) => error instanceof NestSandboxError && /sandbox\.db exists and is not a database directory.*Choose another path with --out\./.test(error.message));
      assert.deepEqual(await readdir(join(dir, "sandbox.db")), ["notes"]);

      await rm(join(dir, "sandbox.db"), { recursive: true });
      await initNest({ cwd: dir });
      await writeFile(join(dir, "sandbox.db/tables/users.json"), "{ nope");
      await assert.rejects(initNest({ cwd: dir }), (error) => error instanceof NestSandboxError && /tables\/users\.json is not valid JSON\. Fix or remove it, or choose another path with --out\./.test(error.message));
    });
  });
});
