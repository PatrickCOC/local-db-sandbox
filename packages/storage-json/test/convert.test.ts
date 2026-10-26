import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Row } from "../../core/src/index.ts";
import type { TableSchema } from "../../runtime/src/index.ts";
import { JsonStorageAdapter, JsonStorageError, convertDatabase, createDatabase, openDatabaseStorage } from "../src/index.ts";
import { allFiles, databaseFiles } from "./support/database-files.ts";

const SCHEMA: TableSchema[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true, generated: "increment" },
      { name: "display_name", key: "name", type: "text", nullable: false, primary: false },
    ],
  },
  {
    name: "orders",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true, generated: "increment" },
      { name: "userId", type: "integer", nullable: true, primary: false, references: { table: "users", column: "id", onDelete: "CASCADE" } },
    ],
  },
];
const CONFIG = { server: { port: 4999 }, defaults: { delayMs: 10 } };
const DATA = {
  users: [
    { id: 1, name: "Ada" },
    { id: 2, name: "Bo" },
  ],
  orders: [{ id: 10, userId: 1 }],
  empty: [],
};

/** A single-file database written the way the sandbox writes it. */
function fileText(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The files a directory database consists of now, under the names they have in a new database. */
const directoryFiles = databaseFiles;

describe("converting between the single-file and the directory format", () => {
  let root: string;
  let file: string;
  let directory: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-convert-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    file = join(root, "sandbox.db.json");
    directory = join(root, "sandbox.db");
  });

  describe("single file to directory", () => {
    it("writes one file per table with the same rows, and keeps the configuration", async () => {
      await writeFile(file, fileText({ $meta: { version: 1 }, $config: CONFIG, data: DATA }));
      const result = await convertDatabase(file, directory);

      assert.deepEqual(result, {
        from: { path: file, format: "file" },
        to: { path: directory, format: "directory" },
        tables: 3,
        rows: 3,
        declaredTables: 0,
        schemaSource: "none",
        notes: [],
      });
      const written = await directoryFiles(directory);
      assert.deepEqual(Object.keys(written), ["manifest.json", "schema.json", "tables/empty.json", "tables/orders.json", "tables/users.json"]);
      assert.deepEqual(JSON.parse(written["manifest.json"] as string), {
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
      assert.deepEqual(JSON.parse(written["tables/users.json"] as string), DATA.users);
      assert.equal(written["tables/empty.json"], "[]\n");
      // The original is neither changed nor removed.
      assert.equal(await readFile(file, "utf8"), fileText({ $meta: { version: 1 }, $config: CONFIG, data: DATA }));
    });

    it("stores table definitions it is given when the file has none", async () => {
      await writeFile(file, fileText({ data: DATA }));
      let asked = 0;
      const result = await convertDatabase(file, directory, {
        fallbackSchema: () => {
          asked += 1;
          return SCHEMA;
        },
      });
      assert.deepEqual([result.declaredTables, result.schemaSource, asked], [2, "given", 1]);

      // The directory can now be opened without whatever the definitions came from.
      const storage = openDatabaseStorage(directory);
      await storage.load();
      assert.deepEqual(storage.schema, SCHEMA);
    });

    it("keeps other top-level keys of the file, without mistaking a JSON Schema reference for table definitions", async () => {
      const document = { $schema: "./db.schema.json", $meta: { version: 1 }, $config: CONFIG, $notes: { owner: "team" }, data: DATA };
      await writeFile(file, fileText(document));
      await convertDatabase(file, directory);
      assert.deepEqual(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).extra, { $schema: "./db.schema.json", $notes: { owner: "team" } });

      const back = join(root, "back.db.json");
      await convertDatabase(directory, back);
      assert.deepEqual(JSON.parse(await readFile(back, "utf8")), { $meta: { version: 1 }, $config: CONFIG, $schema: "./db.schema.json", $notes: { owner: "team" }, data: DATA });
    });
  });

  describe("directory to single file", () => {
    it("writes the rows under data, the configuration, and the table definitions", async () => {
      await createDatabase(directory, { collections: structuredClone(DATA), config: CONFIG, schema: SCHEMA });
      const result = await convertDatabase(directory, file);
      assert.deepEqual([result.from.format, result.to.format, result.tables, result.rows, result.declaredTables, result.schemaSource, result.notes], ["directory", "file", 3, 3, 2, "stored", []]);

      const document = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(Object.keys(document), ["$meta", "$config", "$tableSchema", "data"]);
      assert.deepEqual([document.$meta, document.$config, document.data], [{ version: 1 }, CONFIG, DATA]);
      // The same definitions. A single file's schema document is of version 1, as it has always been.
      assert.deepEqual(document.$tableSchema, { ...JSON.parse(await readFile(join(directory, "schema.json"), "utf8")), schemaVersion: 1 });

      const storage = new JsonStorageAdapter(file);
      await storage.load();
      assert.deepEqual(storage.schema, SCHEMA);
    });

    it("leaves out what the columns are in the database of an ORM's entities, which is worked out from the entities, and says so", async () => {
      // As a directory of TypeORM entities has it (D-040): a canonical type beside what was declared, and the enumerated type a column names.
      const entities: TableSchema[] = [
        {
          name: "users",
          columns: [
            { name: "id", type: "integer", declaredType: "Number", canonicalType: { kind: "integer", bits: 32 }, nullable: false, primary: true, generated: "increment", autoIncrement: true },
            { name: "role", type: "text", declaredType: "enum", canonicalType: { kind: "enum", name: "users_role_enum" }, nullable: false, primary: false, default: "reader" },
          ],
        },
      ];
      await createDatabase(directory, { collections: { users: [{ id: 1, role: "reader" }] }, schema: entities, types: { enums: [{ name: "users_role_enum", values: ["admin", "reader"] }] } });
      const result = await convertDatabase(directory, file);
      assert.deepEqual(result.notes, ["What the columns are in the database of their entities (canonical types, and the enumerated types they name) is not stored in a single file: it is worked out from the entities."]);
      const storage = new JsonStorageAdapter(file);
      await storage.load();
      assert.deepEqual(
        storage.schema,
        entities.map((table) => ({ ...table, columns: table.columns.map(({ canonicalType: _type, ...column }) => column) })),
      );
      assert.equal(storage.types, undefined);
    });

    it("refuses what a source said of its own types, and an enumerated type that no such column names: nothing of that is left out", async () => {
      const collected: TableSchema[] = [{ name: "t", columns: [{ name: "id", type: "integer", canonicalType: { kind: "integer", bits: 32 }, sourceDialectType: { dialect: "postgresql", type: "int4" }, nullable: false, primary: true }] }];
      await createDatabase(directory, { collections: { t: [] }, schema: collected });
      await assert.rejects(convertDatabase(directory, file), /cannot store \(t: canonical types\)/);
      await rm(directory, { recursive: true, force: true });
      const typed: TableSchema[] = [{ name: "t", columns: [{ name: "id", type: "integer", canonicalType: { kind: "integer", bits: 32 }, nullable: false, primary: true }] }];
      await createDatabase(directory, { collections: { t: [] }, schema: typed, types: { enums: [{ name: "unused", values: ["a"] }] } });
      await assert.rejects(convertDatabase(directory, file), /cannot store \(enumerated types: unused\)/);
    });

    it("names the canonical type among what is refused of a column that says where it comes from, or carries its type's values: it is not left out on the way", async () => {
      const id = { name: "id", type: "integer" as const, nullable: false, primary: true };
      const traced: TableSchema[] = [
        { name: "t", columns: [{ ...id, canonicalType: { kind: "integer", bits: 32 }, origin: { source: "postgresql-migrations", file: "0001_init.sql", sha256: "0".repeat(64), statement: 1, line: 1, name: "id" } }] },
      ];
      await createDatabase(directory, { collections: { t: [] }, schema: traced });
      await assert.rejects(convertDatabase(directory, file), /cannot store \(t: canonical types, provenance\)/);
      await rm(directory, { recursive: true, force: true });
      const valued: TableSchema[] = [{ name: "t", columns: [id, { name: "state", type: "text", canonicalType: { kind: "enum", name: "mood" }, enum: { name: "mood", values: ["ok", "sad"] }, nullable: false, primary: false }] }];
      await createDatabase(directory, { collections: { t: [] }, schema: valued, types: { enums: [{ name: "mood", values: ["ok", "sad"] }] } });
      await assert.rejects(convertDatabase(directory, file), /cannot store \(enumerated types: mood; t: enumerated values, canonical types\)/);
    });

    it("leaves out what a single file has no place for, and says so", async () => {
      await createDatabase(directory, { collections: { users: [] }, persistence: "memory" });
      const result = await convertDatabase(directory, file);
      assert.equal(result.schemaSource, "none");
      assert.deepEqual(result.notes, ['The directory\'s "persistence": "memory" is not stored in a single file.']);
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { $meta: { version: 1 }, data: { users: [] } });
    });
  });

  describe("round trips", () => {
    it("gives back the same single file, byte for byte", async () => {
      const original = fileText({ $meta: { version: 1 }, $config: CONFIG, data: DATA });
      await writeFile(file, original);
      await convertDatabase(file, directory);
      const back = join(root, "back.db.json");
      await convertDatabase(directory, back);
      assert.equal(await readFile(back, "utf8"), original);
    });

    it("gives back the same directory, file for file, including the table definitions", async () => {
      await createDatabase(directory, { collections: structuredClone(DATA), config: CONFIG, schema: SCHEMA, extra: { $notes: "kept" } });
      await convertDatabase(directory, file);
      const again = join(root, "again", "sandbox.db");
      await mkdir(join(root, "again"));
      await convertDatabase(file, again);
      assert.deepEqual(await directoryFiles(again), await directoryFiles(directory));
    });

    it("handles a database of 41 tables, with names that are not safe file names", async () => {
      const data: Record<string, Row[]> = {};
      for (let index = 1; index <= 41; index += 1) {
        const name = index % 10 === 0 ? `schema.table/${index}` : index === 7 ? "CON" : index === 8 ? "Con" : `table_${String(index).padStart(2, "0")}`;
        data[name] = Array.from({ length: index % 5 }, (_, row) => ({ id: row + 1, label: `${name} #${row + 1}`, nested: { tags: [index, row] }, flag: row % 2 === 0, missing: null }));
      }
      const original = fileText({ $meta: { version: 1 }, data });
      await writeFile(file, original);

      const result = await convertDatabase(file, directory);
      assert.deepEqual([result.tables, result.rows], [41, Object.values(data).reduce((sum, rows) => sum + rows.length, 0)]);
      const tableFiles = await readdir(join(directory, "tables"));
      assert.equal(tableFiles.length, 41);
      assert.equal(new Set(tableFiles.map((name) => name.toLowerCase())).size, 41);
      assert.ok(tableFiles.every((name) => /^[A-Za-z0-9_%~-]+\.json$/.test(name)), tableFiles.join(" "));

      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
      assert.deepEqual(manifest.tables.map((table: { name: string }) => table.name), Object.keys(data));
      assert.deepEqual(
        manifest.tables.filter((table: { name: string }) => !/^table_\d\d$/.test(table.name)).map((table: { name: string; file: string }) => [table.name, table.file]),
        [["CON", "%43ON.json"], ["Con", "%43on~2.json"], ["schema.table/10", "schema%2Etable%2F10.json"], ["schema.table/20", "schema%2Etable%2F20.json"], ["schema.table/30", "schema%2Etable%2F30.json"], ["schema.table/40", "schema%2Etable%2F40.json"]],
      );

      const storage = openDatabaseStorage(directory);
      assert.deepEqual((await storage.load()).collections, data);
      const back = join(root, "back.db.json");
      await convertDatabase(directory, back);
      assert.equal(await readFile(back, "utf8"), original);
    });
  });

  describe("what it refuses", () => {
    it("does not replace an existing database unless told to", async () => {
      await writeFile(file, fileText({ data: DATA }));
      await convertDatabase(file, directory);
      await assert.rejects(convertDatabase(file, directory), (error) => error instanceof JsonStorageError && /sandbox\.db already exists/.test(error.message));

      await writeFile(file, fileText({ data: { users: [{ id: 5, name: "Only" }] } }));
      await convertDatabase(file, directory, { overwrite: true });
      // Replacing also removes the files of tables that are no longer there.
      assert.deepEqual(Object.keys(await directoryFiles(directory)), ["manifest.json", "schema.json", "tables/users.json"]);

      await assert.rejects(convertDatabase(directory, file), /sandbox\.db\.json already exists/);
      await convertDatabase(directory, file, { overwrite: true });
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")).data, { users: [{ id: 5, name: "Only" }] });
    });

    it("does not write into a folder that is not a database, or over the wrong kind of path", async () => {
      await writeFile(file, fileText({ data: DATA }));
      await mkdir(join(directory, "src"), { recursive: true });
      await writeFile(join(directory, "src/main.ts"), "// someone's project");
      await assert.rejects(convertDatabase(file, directory, { overwrite: true }), /sandbox\.db exists and is not a database directory/);
      assert.deepEqual(Object.keys(await allFiles(directory)), ["src/main.ts"]);
    });

    it("needs the other format as its target, and an existing source", async () => {
      await writeFile(file, fileText({ data: DATA }));
      await assert.rejects(convertDatabase(file, join(root, "copy.json")), /is a single-file database already; give a directory path to convert it/);
      await convertDatabase(file, directory);
      await assert.rejects(convertDatabase(directory, join(root, "copy.db")), /is a directory database already; give a \.json path to convert it/);
      await assert.rejects(convertDatabase(join(root, "missing.db"), file), /Database not found/);
    });
  });
});

describe("table definitions in a single-file database", () => {
  let root: string;
  let file: string;
  const read = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(file, "utf8"));

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-tableschema-"));
    file = join(root, "db.json");
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("are never added to a file that has none", async () => {
    await writeFile(file, fileText({ $meta: { version: 1 }, $config: CONFIG, data: DATA }));
    const storage = new JsonStorageAdapter(file);
    const state = await storage.load();
    assert.equal(storage.schema, undefined);

    storage.describe(SCHEMA);
    assert.equal(storage.schema, undefined);
    storage.saveSync(state);
    assert.equal(await readFile(file, "utf8"), fileText({ $meta: { version: 1 }, $config: CONFIG, data: DATA }));
    assert.deepEqual(storage.metadata(), { config: CONFIG });
  });

  it("are read from $tableSchema and kept up to date by a save", async () => {
    await createDatabase(file, { collections: structuredClone(DATA), schema: [SCHEMA[0] as TableSchema] }, { overwrite: true });
    const storage = new JsonStorageAdapter(file);
    const state = await storage.load();
    assert.deepEqual(storage.schema, [SCHEMA[0]]);

    storage.describe(SCHEMA);
    await storage.save(state);
    assert.deepEqual(((await read()).$tableSchema as { tables: unknown[] }).tables.length, 2);
    const reopened = new JsonStorageAdapter(file);
    await reopened.load();
    assert.deepEqual(reopened.schema, SCHEMA);
  });

  it("are refused when they cannot be used, naming the file", async () => {
    await writeFile(file, fileText({ $tableSchema: { tables: [{ name: "users", columns: [] }] }, data: DATA }));
    await assert.rejects(new JsonStorageAdapter(file).load(), (error) => error instanceof JsonStorageError && /"\$tableSchema" in .*db\.json: table "users" needs at least one column/.test(error.message));
  });
});
