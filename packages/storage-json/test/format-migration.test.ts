import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { SandboxLimitError } from "../../core/src/index.ts";
import type { Row } from "../../core/src/index.ts";
import { SqliteRuntime } from "../../runtime/src/index.ts";
import type { TableSchema } from "../../runtime/src/index.ts";
import {
  CURRENT_FORMAT_VERSION,
  DatabaseFormatError,
  DirectoryStorageAdapter,
  FORMAT_HISTORY,
  FORMAT_MIGRATIONS,
  JsonStorageAdapter,
  JsonStorageError,
  assessFormat,
  createDatabase,
  findMigrationPath,
  inspectDatabase,
  migrateDatabase,
  openDatabaseStorage,
  planMigration,
} from "../src/index.ts";
import type { DatabaseFormat, DirectoryMigrationOutput, FormatMigration, MigrationEdge } from "../src/index.ts";
import { allFiles } from "./support/database-files.ts";

/*
 * The format version of a stored database: what a build may do with each
 * format, finding a database's format without changing it, and migrating.
 *
 * The databases are the ones in fixtures/formats: one per format, as a build
 * of that format left it. Each test works on a copy.
 */

const FIXTURES = join(import.meta.dirname, "fixtures/formats");
const SOURCE = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;
const BYTES_PER_MB = 1024 * 1024;
/** What the step to format 4 changes in a database that the step to format 3 has just made. */
const STEP_3_TO_4_CHANGES = ["manifest.json: formatVersion 3 -> 4, minimumReaderVersion 4", "schema.json: kept as it is (a format 3 schema is a valid format 4 schema)", "tables/: 4 table files kept as they are"];
/** The same, for the format 3 fixture, whose schema file is named after a generation. */
const STEP_3_TO_4_CHANGES_GENERATION_3 = ["manifest.json: formatVersion 3 -> 4, minimumReaderVersion 4", "schema.g2.json: kept as it is (a format 3 schema is a valid format 4 schema)", "tables/: 4 table files kept as they are"];
/** What the step to format 5 changes in a database that the steps from format 2 have just made: its schema file is written again, in generation 2. */
const STEP_4_TO_5_CHANGES = [
  'manifest.json: formatVersion 4 -> 5, minimumReaderVersion 5, generation 2, schema "schema.g2.json"',
  "schema.json -> schema.g2.json: written again as a schema document of version 2",
  "tables/: 4 table files kept as they are",
];
/** The same, for the fixtures of format 3 and 4, which are at generation 3. */
const STEP_4_TO_5_CHANGES_GENERATION_3 = [
  'manifest.json: formatVersion 4 -> 5, minimumReaderVersion 5, generation 4, schema "schema.g4.json"',
  "schema.g2.json -> schema.g4.json: written again as a schema document of version 2",
  "tables/: 4 table files kept as they are",
];

function readFileSyncText(path: string): string {
  return readFileSync(path, "utf8");
}

const CONFIG = { server: { port: 4999 }, limits: { maxFileSizeMb: 2 }, defaults: { delayMs: 0 } };
const EXTRA = { $notes: "kept as it is", $owner: { team: "fixtures" } };
const TABLES = [
  { name: "users", file: "users.json" },
  { name: "orders", file: "orders.json" },
  { name: "Order Items", file: "Order%20Items.json" },
  { name: "empty", file: "empty.json" },
];
/** Definitions for the two tables of the fixtures that their schema does not declare. */
const UNDECLARED: TableSchema[] = [
  {
    name: "Order Items",
    columns: [
      { name: "orderId", type: "integer", nullable: false, primary: true },
      { name: "line", type: "integer", nullable: false, primary: true },
      { name: "sku", type: "text", nullable: false, primary: false },
      { name: "note", type: "text", nullable: true, primary: false },
    ],
  },
  { name: "empty", columns: [{ name: "id", type: "integer", nullable: false, primary: true }] },
];

const [toFormat3] = FORMAT_MIGRATIONS.filter((migration) => migration.storage === "directory" && migration.from === 2) as [FormatMigration];
const [toFormat4] = FORMAT_MIGRATIONS.filter((migration) => migration.storage === "directory" && migration.from === 3) as [FormatMigration];
const [toFormat5] = FORMAT_MIGRATIONS.filter((migration) => migration.storage === "directory" && migration.from === 4) as [FormatMigration];

function formatError(code: string, message: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof DatabaseFormatError, String(error));
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  };
}

function refused(message: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof JsonStorageError, String(error));
    assert.match(error.message, message);
    return true;
  };
}

/** What tells each file under a directory apart from one written in its place, by relative path. */
async function identities(directory: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of (await readdir(directory, { recursive: true, withFileTypes: true })).filter((candidate) => candidate.isFile())) {
    const path = join(entry.parentPath, entry.name);
    const stats = statSync(path, { bigint: true });
    found[path.slice(directory.length + 1).replaceAll("\\", "/")] = `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

/** Everything a database stores, read the way anything that opens it reads it. */
async function contentsOf(path: string): Promise<Record<string, unknown>> {
  const storage = openDatabaseStorage(path);
  const { collections } = await storage.load();
  return { collections, ...storage.metadata(), maxFileSizeBytes: storage.maxFileSizeBytes };
}

function exit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; output: string }> {
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  return new Promise((resolve) => child.once("exit", (code) => resolve({ code, output })));
}

describe("format versions", () => {
  const edges = (...steps: [DatabaseFormat, number, number][]): MigrationEdge[] => steps.map(([storage, from, to]) => ({ storage, from, to }));
  const stamp = (formatVersion: number, minimumReaderVersion = formatVersion) => ({ formatVersion, minimumReaderVersion, declared: true });

  it("are counted per kind of storage, and the current one is the last of its history", () => {
    assert.deepEqual(CURRENT_FORMAT_VERSION, { file: 1, directory: 5 });
    for (const storage of ["file", "directory"] as const) {
      const versions = FORMAT_HISTORY[storage].map((format) => format.version);
      assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
      assert.equal(versions.at(-1), CURRENT_FORMAT_VERSION[storage]);
    }
  });

  it("have a migration to the current one from every earlier format of the history", () => {
    for (const storage of ["file", "directory"] as const) {
      for (const { version } of FORMAT_HISTORY[storage]) {
        assert.ok(findMigrationPath(FORMAT_MIGRATIONS, storage, version, CURRENT_FORMAT_VERSION[storage]) !== undefined, `${storage} format ${version}`);
      }
    }
    assert.deepEqual(
      FORMAT_MIGRATIONS.map(({ storage, from, to }) => ({ storage, from, to })),
      [
        { storage: "directory", from: 2, to: 3 },
        { storage: "directory", from: 3, to: 4 },
        { storage: "directory", from: 4, to: 5 },
      ],
    );
  });

  it("are linked by the migrations into a path, the shortest there is", () => {
    const chain = edges(["directory", 1, 2], ["directory", 2, 3], ["directory", 3, 4], ["directory", 4, 5]);
    assert.deepEqual(findMigrationPath(chain, "directory", 1, 5), [1, 2, 3, 4, 5]);
    assert.deepEqual(findMigrationPath(chain, "directory", 3, 4), [3, 4]);
    assert.deepEqual(findMigrationPath(chain, "directory", 4, 4), [4]);
    // A migration that skips formats is taken when it is there.
    assert.deepEqual(findMigrationPath([...chain, ...edges(["directory", 2, 5])], "directory", 1, 5), [1, 2, 5]);
    // No way back, no way across a gap, and no way through the migrations of another kind of storage.
    assert.equal(findMigrationPath(chain, "directory", 5, 3), undefined);
    assert.equal(findMigrationPath(edges(["directory", 1, 2], ["directory", 3, 4]), "directory", 1, 4), undefined);
    assert.equal(findMigrationPath(edges(["file", 2, 3]), "directory", 2, 3), undefined);
  });

  it("decide what a build does with a database: read and write, read only, or neither", () => {
    const assess = (formatVersion: number, minimumReaderVersion = formatVersion) => {
      const { compatibility, readable, writable, migrationRequired, migrationPath } = assessFormat("directory", stamp(formatVersion, minimumReaderVersion), FORMAT_MIGRATIONS);
      return { compatibility, readable, writable, migrationRequired, migrationPath };
    };
    assert.deepEqual(assess(5), { compatibility: "current", readable: true, writable: true, migrationRequired: false, migrationPath: [] });
    assert.deepEqual(assess(4), { compatibility: "older", readable: true, writable: false, migrationRequired: true, migrationPath: [4, 5] });
    assert.deepEqual(assess(3), { compatibility: "older", readable: true, writable: false, migrationRequired: true, migrationPath: [3, 4, 5] });
    assert.deepEqual(assess(2), { compatibility: "older", readable: true, writable: false, migrationRequired: true, migrationPath: [2, 3, 4, 5] });
    assert.deepEqual(assess(1), { compatibility: "unsupported-old", readable: false, writable: false, migrationRequired: true, migrationPath: [] });
    assert.deepEqual(assess(6), { compatibility: "unsupported-new", readable: false, writable: false, migrationRequired: false, migrationPath: [] });
    // Only the database can say that readers of an earlier format read a later one.
    assert.deepEqual(assess(6, 5), { compatibility: "newer", readable: true, writable: false, migrationRequired: false, migrationPath: [] });
    assert.deepEqual(assess(9, 2), { compatibility: "newer", readable: true, writable: false, migrationRequired: false, migrationPath: [] });

    const status = assessFormat("directory", stamp(2), FORMAT_MIGRATIONS);
    assert.deepEqual([status.currentVersion, status.oldestSupportedVersion], [5, 2]);
    // A single file has one format, and nothing to migrate from.
    const file = assessFormat("file", stamp(1), FORMAT_MIGRATIONS);
    assert.deepEqual([file.compatibility, file.currentVersion, file.oldestSupportedVersion], ["current", 1, 1]);
    assert.equal(assessFormat("file", stamp(2), FORMAT_MIGRATIONS).compatibility, "unsupported-new");
  });

  it("support more formats when there are more migrations", () => {
    const more = [...FORMAT_MIGRATIONS, ...edges(["directory", 1, 2])];
    const status = assessFormat("directory", stamp(1), more);
    assert.deepEqual([status.compatibility, status.oldestSupportedVersion, status.migrationPath], ["older", 1, [1, 2, 3, 4, 5]]);
  });
});

describe("format of a stored database", () => {
  let root: string;
  let format2: string;
  let format3: string;
  let format4: string;
  let format5: string;
  let file1: string;
  let unversioned: string;

  const manifest = async (directory: string): Promise<any> => JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const editManifest = async (directory: string, edit: (value: any) => void): Promise<void> => {
    const value = await manifest(directory);
    edit(value);
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(value, null, 2)}\n`);
  };
  /** Runs `check` and then makes sure that not one file under `path` was touched by it. */
  const unchanged = async (path: string, check: () => unknown): Promise<void> => {
    const directory = statSync(path).isDirectory();
    const before = directory ? [await allFiles(path), await identities(path)] : [await readFile(path, "utf8"), statSync(path, { bigint: true }).mtimeNs];
    await check();
    const after = directory ? [await allFiles(path), await identities(path)] : [await readFile(path, "utf8"), statSync(path, { bigint: true }).mtimeNs];
    assert.deepEqual(after, before);
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-format-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await mkdir(root, { recursive: true });
    [format2, format3, format4, format5, file1, unversioned] = [join(root, "old.db"), join(root, "mid.db"), join(root, "four.db"), join(root, "current.db"), join(root, "file.db.json"), join(root, "plain.db.json")];
    await cp(join(FIXTURES, "directory-format-2"), format2, { recursive: true });
    await cp(join(FIXTURES, "directory-format-3"), format3, { recursive: true });
    await cp(join(FIXTURES, "directory-format-4"), format4, { recursive: true });
    await cp(join(FIXTURES, "directory-format-5"), format5, { recursive: true });
    await cp(join(FIXTURES, "file-format-1.db.json"), file1);
    await cp(join(FIXTURES, "file-unversioned.db.json"), unversioned);
  });

  describe("inspecting", () => {
    it("describes a directory of the current format", async () => {
      await unchanged(format5, () => {
        const { logicalSizeBytes, ...inspection } = inspectDatabase(format5);
        assert.deepEqual(inspection, {
          path: format5,
          storage: "directory",
          formatVersion: 5,
          minimumReaderVersion: 5,
          declared: true,
          currentVersion: 5,
          oldestSupportedVersion: 2,
          compatibility: "current",
          readable: true,
          writable: true,
          migrationRequired: false,
          migrationPath: [],
          tables: 4,
          generation: 4,
          notes: [],
        });
        assert.ok((logicalSizeBytes as number) > 0);
      });
    });

    it("describes a directory of an earlier format, with the path of its migration, and changes nothing", async () => {
      await unchanged(format2, async () => {
        const inspection = inspectDatabase(format2);
        assert.deepEqual(
          [inspection.storage, inspection.formatVersion, inspection.minimumReaderVersion, inspection.currentVersion, inspection.compatibility],
          ["directory", 2, 2, 5, "older"],
        );
        assert.deepEqual([inspection.readable, inspection.writable, inspection.migrationRequired, inspection.migrationPath], [true, false, true, [2, 3, 4, 5]]);
        assert.deepEqual([inspection.tables, inspection.generation, inspection.notes], [4, 0, []]);
        // The logical size is that of the files the database consists of.
        const files = await allFiles(format2);
        assert.equal(inspection.logicalSizeBytes, Object.values(files).reduce((total, text) => total + Buffer.byteLength(text), 0));
      });
    });

    it("describes a directory of format 3 as an earlier format, two steps from the current one", async () => {
      await unchanged(format3, () => {
        const inspection = inspectDatabase(format3);
        assert.deepEqual(
          [inspection.formatVersion, inspection.minimumReaderVersion, inspection.currentVersion, inspection.compatibility, inspection.readable, inspection.writable, inspection.migrationPath],
          [3, 3, 5, "older", true, false, [3, 4, 5]],
        );
        assert.deepEqual([inspection.tables, inspection.generation], [4, 3]);
      });
    });

    it("describes a directory of format 4 as an earlier format, one step from the current one", async () => {
      await unchanged(format4, () => {
        const inspection = inspectDatabase(format4);
        assert.deepEqual(
          [inspection.formatVersion, inspection.minimumReaderVersion, inspection.currentVersion, inspection.compatibility, inspection.readable, inspection.writable, inspection.migrationPath],
          [4, 4, 5, "older", true, false, [4, 5]],
        );
        assert.deepEqual([inspection.tables, inspection.generation], [4, 3]);
      });
    });

    it("describes a single file that states no version by the rule for such files: format 1", async () => {
      await unchanged(unversioned, () => {
        const inspection = inspectDatabase(unversioned);
        assert.deepEqual(
          [inspection.storage, inspection.formatVersion, inspection.declared, inspection.currentVersion, inspection.compatibility, inspection.migrationRequired, inspection.migrationPath],
          ["file", 1, false, 1, "current", false, []],
        );
        assert.deepEqual([inspection.readable, inspection.writable, inspection.tables], [true, true, 2]);
        assert.equal(inspection.logicalSizeBytes, statSync(unversioned).size);
        assert.deepEqual(inspection.notes, ['The file states no version ("$meta"). A single-file database without one has format 1, and states it from its next save on.']);
      });
    });

    it("describes a single file that states its version", async () => {
      await unchanged(file1, () => {
        const inspection = inspectDatabase(file1);
        assert.deepEqual([inspection.storage, inspection.formatVersion, inspection.declared, inspection.compatibility, inspection.tables, inspection.notes], ["file", 1, true, "current", 4, []]);
      });
    });

    it("reads nothing but the manifest of a directory", async () => {
      // Table files and the schema that cannot be read at all: inspecting does not open them.
      await writeFile(join(format2, "tables/users.json"), "{ not json");
      await writeFile(join(format2, "schema.json"), "{ not json");
      assert.deepEqual([inspectDatabase(format2).tables, inspectDatabase(format2).compatibility], [4, "older"]);

      // A file that is missing is noted, since the size cannot be worked out, and is not an error.
      await rm(join(format2, "tables/orders.json"));
      const inspection = inspectDatabase(format2);
      assert.equal(inspection.logicalSizeBytes, undefined);
      assert.match(inspection.notes[0] as string, /^Table "orders" has no file: tables\/orders\.json is listed in manifest\.json but does not exist/);
    });

    it("describes a database of a format it cannot read, as far as the version numbers go", async () => {
      await editManifest(format5, (value) => Object.assign(value, { formatVersion: 6, minimumReaderVersion: 6, tables: "something else entirely" }));
      const newer = inspectDatabase(format5);
      assert.deepEqual(
        [newer.formatVersion, newer.compatibility, newer.readable, newer.writable, newer.migrationRequired, newer.tables, newer.logicalSizeBytes],
        [6, "unsupported-new", false, false, false, undefined, undefined],
      );

      await editManifest(format2, (value) => (value.formatVersion = 1));
      const older = inspectDatabase(format2);
      assert.deepEqual([older.formatVersion, older.compatibility, older.readable, older.migrationRequired, older.migrationPath, older.tables], [1, "unsupported-old", false, true, [], undefined]);
    });

    it("says what is wrong with something that is not a database", async () => {
      assert.throws(() => inspectDatabase(join(root, "missing.db")), refused(/^Database not found: .*missing\.db$/));
      await mkdir(join(root, "folder"));
      assert.throws(() => inspectDatabase(join(root, "folder")), refused(/folder is not a database directory: it has no manifest\.json/));
      await writeFile(join(root, "broken.json"), "{ not json");
      assert.throws(() => inspectDatabase(join(root, "broken.json")), refused(/Database file is not valid JSON/));
      await writeFile(join(format5, "manifest.json"), "[]");
      assert.throws(() => inspectDatabase(format5), refused(/manifest\.json must contain a JSON object/));
      assert.throws(() => inspectDatabase(file1, { maxFileSizeMb: 0.0001 }), (error) => error instanceof SandboxLimitError);
      assert.throws(() => inspectDatabase(file1, { maxFileSizeMb: 0 }), refused(/maxFileSizeMb must be a number greater than 0/));
    });
  });

  describe("planning a migration", () => {
    it("gives the path and what the step would change, and changes nothing", async () => {
      await unchanged(format2, () => {
        assert.deepEqual(planMigration(format2), {
          path: format2,
          storage: "directory",
          formatVersion: 2,
          targetVersion: 5,
          currentVersion: 5,
          migrationPath: [2, 3, 4, 5],
          steps: [
            {
              from: 2,
              to: 3,
              summary: toFormat3.summary,
              changes: [
                'manifest.json: formatVersion 2 -> 3; adds minimumReaderVersion 3, generation 1, and schema "schema.json"',
                "schema.json: kept as it is",
                "tables/: 4 table files kept as they are",
              ],
              status: "planned",
            },
            {
              from: 3,
              to: 4,
              summary: toFormat4.summary,
              // A later step is planned on a database that only the earlier one makes, so what it changes is only known when it runs.
              changes: [],
              status: "planned",
            },
            { from: 4, to: 5, summary: toFormat5.summary, changes: [], status: "planned" },
          ],
          dryRun: true,
          migrated: false,
        });
        assert.deepEqual(planMigration(format2, { to: 3 }).migrationPath, [2, 3]);
        assert.deepEqual(planMigration(format2, { to: 3 }).steps.map((step) => [step.from, step.to]), [[2, 3]]);
      });
    });

    it("has nothing to do for a database of the target format", () => {
      for (const path of [format5, file1, unversioned]) {
        const plan = planMigration(path);
        assert.deepEqual([plan.formatVersion, plan.targetVersion, plan.migrationPath, plan.steps], [plan.currentVersion, plan.currentVersion, [], []], path);
      }
      assert.deepEqual(planMigration(format2, { to: 2 }).steps, []);
    });

    it("refuses a target it cannot reach, saying why", async () => {
      assert.throws(() => planMigration(format2, { to: 6 }), refused(/^This build migrates a database directory up to format 5; it does not know format 6\.$/));
      assert.throws(() => planMigration(file1, { to: 2 }), refused(/^This build migrates a single-file database up to format 1; it does not know format 2\.$/));
      assert.throws(() => planMigration(format5, { to: 2 }), refused(/current\.db has format 5\. A database is not taken back to an earlier format \(2\)\.$/));
      assert.throws(() => planMigration(format5, { to: 4 }), refused(/current\.db has format 5\. A database is not taken back to an earlier format \(4\)\.$/));
      assert.throws(() => planMigration(format2, { to: 0 }), refused(/must be a whole number, 1 or more/));
      assert.throws(() => planMigration(format2, { to: 2.5 }), refused(/must be a whole number, 1 or more/));
    });
  });

  describe("migrating a directory from format 2 to the current format", () => {
    it("reports what it would do and changes nothing, in a dry run", async () => {
      await unchanged(format2, () => {
        const report = migrateDatabase(format2, { dryRun: true });
        assert.deepEqual([report.dryRun, report.migrated, report.migrationPath, report.steps.map((step) => step.status)], [true, false, [2, 3, 4, 5], ["planned", "planned", "planned"]]);
        assert.equal(report.steps[0]?.changes.length, 3);
        assert.deepEqual([report.tables, report.rows], [undefined, undefined]);
      });
      assert.equal(inspectDatabase(format2).formatVersion, 2);
    });

    it("keeps every row, table definition, and setting, and every table file", async () => {
      const before = await contentsOf(format2);
      const files = await identities(format2);
      const texts = await allFiles(format2);
      const stored = await manifest(format2);

      const report = migrateDatabase(format2);
      assert.deepEqual(
        [report.formatVersion, report.targetVersion, report.migrationPath, report.dryRun, report.migrated, report.tables, report.rows],
        [2, 5, [2, 3, 4, 5], false, true, 4, 8],
      );
      const [toThree, toFour, toFive] = planMigration(join(FIXTURES, "directory-format-2")).steps;
      assert.deepEqual(report.steps, [
        { ...toThree, status: "applied" },
        { ...toFour, changes: STEP_3_TO_4_CHANGES, status: "applied" },
        { ...toFive, changes: STEP_4_TO_5_CHANGES, status: "applied" },
      ]);

      // What the database stores is what it stored: rows of every table, definitions, configuration, name, persistence, extra keys, and its size limit.
      assert.deepEqual(await contentsOf(format2), before);
      assert.deepEqual(before.collections, {
        users: JSON.parse(texts["tables/users.json"] as string),
        orders: JSON.parse(texts["tables/orders.json"] as string),
        "Order Items": JSON.parse(texts["tables/Order%20Items.json"] as string),
        empty: [],
      });
      // The manifest was written, and the schema file anew, as a document of version 2, under the name of its generation. Every table file is the file it was.
      const { "manifest.json": _old, "schema.json": _schema, ...otherFiles } = files;
      const { "manifest.json": _new, "schema.g2.json": _written, ...otherFilesAfter } = await identities(format2);
      assert.deepEqual(otherFilesAfter, otherFiles);
      assert.equal(JSON.parse((await allFiles(format2))["schema.g2.json"] as string).schemaVersion, 2);
      assert.deepEqual(await manifest(format2), {
        formatVersion: 5,
        minimumReaderVersion: 5,
        database: stored.database,
        persistence: stored.persistence,
        config: stored.config,
        generation: 2,
        schema: "schema.g2.json",
        tables: stored.tables,
        extra: stored.extra,
      });
      assert.deepEqual([stored.config, stored.tables, stored.extra], [CONFIG, TABLES, EXTRA]);
      assert.equal(inspectDatabase(format2).compatibility, "current");
    });

    it("leaves a manifest that the storage itself would have written", async () => {
      migrateDatabase(format2);
      const text = await readFile(join(format2, "manifest.json"), "utf8");
      const storage = new DirectoryStorageAdapter(format2, { retiredFileGraceMs: 0 });
      const state = await storage.load();
      assert.deepEqual([state.meta, storage.generation, storage.formatStatus?.compatibility], [{ version: 5 }, 2, "current"]);
      // Saving what is stored finds nothing to write.
      storage.saveSync(state);
      assert.equal(storage.lastSave?.published, false);
      assert.equal(await readFile(join(format2, "manifest.json"), "utf8"), text);
    });

    it("does nothing when it is run again", async () => {
      migrateDatabase(format2);
      await unchanged(format2, () => {
        const again = migrateDatabase(format2);
        assert.deepEqual([again.formatVersion, again.targetVersion, again.migrationPath, again.steps, again.migrated, again.dryRun], [5, 5, [], [], false, false]);
      });
    });

    it("does nothing to a database of the current format", async () => {
      for (const path of [format5, file1, unversioned]) {
        await unchanged(path, () => {
          const report = migrateDatabase(path);
          assert.deepEqual([report.migrated, report.steps, report.formatVersion === report.currentVersion], [false, [], true], path);
        });
      }
      // A manifest without the second version number: it is taken to be the format itself, and there is nothing to do.
      await editManifest(format5, (value) => delete value.minimumReaderVersion);
      await unchanged(format5, () => assert.equal(migrateDatabase(format5).migrated, false));
      assert.deepEqual([inspectDatabase(format5).minimumReaderVersion, inspectDatabase(format5).compatibility], [5, "current"]);
    });

    it("is refused for a format this build does not read, and changes nothing", async () => {
      await editManifest(format5, (value) => Object.assign(value, { formatVersion: 6, minimumReaderVersion: 6 }));
      await unchanged(format5, () => {
        assert.throws(() => migrateDatabase(format5), formatError("DATABASE_FORMAT_TOO_NEW", /current\.db: Database format 6 is newer than this build supports \(max 5\)\. Upgrade local-db-sandbox\.$/));
      });
      // Also when the later format can be read: there is nothing this build could migrate it to.
      await editManifest(format5, (value) => (value.minimumReaderVersion = 5));
      await unchanged(format5, () => assert.throws(() => migrateDatabase(format5), formatError("DATABASE_FORMAT_TOO_NEW", /Database format 6 is newer than this build supports \(max 5\)/)));

      await editManifest(format2, (value) => (value.formatVersion = 1));
      await unchanged(format2, () => {
        assert.throws(
          () => migrateDatabase(format2),
          formatError("DATABASE_FORMAT_TOO_OLD", /old\.db: Database format 1 is older than this build supports \(oldest: 2\)\. Migrate it with an earlier version of local-db-sandbox, one that reads format 1, and then with this one\.$/),
        );
      });
    });

    it("keeps the size limit, and refuses to publish a result that would be above it", async () => {
      migrateDatabase(format2);
      const storage = new DirectoryStorageAdapter(format2, { retiredFileGraceMs: 0 });
      const state = await storage.load();
      // The limit of 2 MB that the database's own configuration sets is still the limit.
      assert.equal(storage.maxFileSizeBytes, 2 * BYTES_PER_MB);
      const files = await allFiles(format2);
      assert.throws(() => storage.saveSync({ ...state, collections: { ...state.collections, empty: [{ id: 1, text: "x".repeat(2 * BYTES_PER_MB) }] } }), (error) => error instanceof SandboxLimitError);
      assert.deepEqual(await allFiles(format2), files);

      // A database above the limit it is opened with is not read, so not migrated.
      await cp(join(FIXTURES, "directory-format-2"), join(root, "big.db"), { recursive: true });
      await unchanged(join(root, "big.db"), () => assert.throws(() => migrateDatabase(join(root, "big.db"), { maxFileSizeMb: 0.001 }), (error) => error instanceof SandboxLimitError));

      // A database that fits its own limit in format 2 and would not in format 3, whose manifest is a little longer.
      const tight = join(root, "tight.db");
      await cp(join(FIXTURES, "directory-format-2"), tight, { recursive: true });
      const withLimit = async (limit: string): Promise<void> => writeFile(join(tight, "manifest.json"), (await readFile(join(tight, "manifest.json"), "utf8")).replace(/"maxFileSizeMb": [\d.]+/, `"maxFileSizeMb": ${limit}`));
      await withLimit("0.111111");
      const size = inspectDatabase(tight).logicalSizeBytes as number;
      await withLimit(((size + 20) / BYTES_PER_MB).toFixed(6));
      assert.equal(inspectDatabase(tight).logicalSizeBytes, size);
      await new DirectoryStorageAdapter(tight).load();
      await unchanged(tight, () => {
        assert.throws(
          () => migrateDatabase(tight),
          (error: unknown) => error instanceof SandboxLimitError && /^In format 3, .*tight\.db would be [\d.]+ MB, above its limit of [\d.]+ MB\. It was not migrated, and is still format 2\./.test(error.message),
        );
      });
    });

    it("saves only the tables a commit changed afterwards, as in any directory of this format", async () => {
      migrateDatabase(format2);
      const storage = new DirectoryStorageAdapter(format2, { retiredFileGraceMs: 0 });
      const state = await storage.load();
      const runtime = await SqliteRuntime.open({ schema: [...(storage.schema as TableSchema[]), ...UNDECLARED], storage, state, persistence: "json" });
      const files = await identities(format2);

      runtime.execute('UPDATE "users" SET "active" = 0 WHERE "id" = 1');
      const save = storage.lastSave;
      assert.deepEqual(
        [save?.kind, save?.published, save?.serializedTables, save?.writtenTables, save?.reusedTables, save?.schemaWritten, save?.generation],
        ["tables", true, ["users"], ["users"], 3, false, 3],
      );
      // A transaction that changes two tables writes those two, and one that is rolled back writes nothing.
      runtime.begin();
      runtime.execute('INSERT INTO "orders" ("id", "userId", "total") VALUES (13, 2, 5)');
      runtime.execute('INSERT INTO "empty" ("id") VALUES (1)');
      runtime.commit();
      assert.deepEqual([storage.lastSave?.kind, storage.lastSave?.writtenTables, storage.lastSave?.generation], ["tables", ["orders", "empty"], 4]);
      runtime.begin();
      runtime.execute('DELETE FROM "Order Items"');
      runtime.rollback();
      assert.equal(storage.generation, 4);
      runtime.close();

      assert.deepEqual(
        (await manifest(format2)).tables,
        [
          { name: "users", file: "users.g3.json" },
          { name: "orders", file: "orders.g4.json" },
          { name: "Order Items", file: "Order%20Items.json" },
          { name: "empty", file: "empty.g4.json" },
        ],
      );
      // The table that no commit changed is the file the format 2 build wrote, and the schema is the file the migration wrote.
      const after = await identities(format2);
      assert.deepEqual([after["tables/Order%20Items.json"], after["schema.g2.json"]], [files["tables/Order%20Items.json"], files["schema.g2.json"]]);
      assert.ok(files["schema.g2.json"] !== undefined);
      const reloaded = (await new DirectoryStorageAdapter(format2).load()).collections;
      assert.deepEqual([(reloaded.users as Row[])[0]?.active, (reloaded.orders as Row[]).length, reloaded.empty], [false, 4, [{ id: 1 }]]);
    });
  });

  describe("migrating a directory from format 3 to format 4", () => {
    it("describes the step in a dry run, with the one that follows it, and changes nothing", async () => {
      await unchanged(format3, () => {
        const report = migrateDatabase(format3, { dryRun: true });
        assert.deepEqual([report.formatVersion, report.targetVersion, report.migrationPath, report.migrated], [3, 5, [3, 4, 5], false]);
        assert.deepEqual(report.steps, [
          { from: 3, to: 4, summary: toFormat4.summary, changes: STEP_3_TO_4_CHANGES_GENERATION_3, status: "planned" },
          { from: 4, to: 5, summary: toFormat5.summary, changes: [], status: "planned" },
        ]);
      });
    });

    it("writes the manifest and nothing else, and the database holds what it held", async () => {
      const before = await contentsOf(format3);
      const files = await identities(format3);
      const stored = await manifest(format3);

      const report = migrateDatabase(format3, { to: 4 });
      assert.deepEqual([report.migrated, report.migrationPath, report.steps.map((step) => step.status), report.tables], [true, [3, 4], ["applied"], 4]);
      assert.deepEqual(await manifest(format3), { ...stored, formatVersion: 4, minimumReaderVersion: 4 });
      const { "manifest.json": _old, ...otherFiles } = files;
      const { "manifest.json": _new, ...otherFilesAfter } = await identities(format3);
      assert.deepEqual(otherFilesAfter, otherFiles);
      assert.deepEqual(await contentsOf(format3), before);
      // One step is left from there.
      assert.deepEqual([inspectDatabase(format3).compatibility, inspectDatabase(format3).migrationPath], ["older", [4, 5]]);

      // Run again, there is nothing to do.
      await unchanged(format3, () => assert.deepEqual([migrateDatabase(format3, { to: 4 }).migrated, migrateDatabase(format3, { to: 4 }).steps], [false, []]));
    });

    it("is read as it is before it is migrated, and is not saved to", async () => {
      const files = await allFiles(format3);
      const storage = new DirectoryStorageAdapter(format3);
      const state = await storage.load();
      assert.deepEqual([state.meta, storage.formatStatus?.compatibility, storage.formatStatus?.migrationPath], [{ version: 3 }, "older", [3, 4, 5]]);
      assert.deepEqual(state.collections, (await contentsOf(join(FIXTURES, "directory-format-4"))).collections);
      assert.throws(() => storage.saveSync(state), formatError("DATABASE_MIGRATION_REQUIRED", /mid\.db: Database format 3 is older than the format this build writes \(5\)\. It can be read as it is, and was not changed\. To change it, migrate it first: local-db-sandbox migrate .*mid\.db$/));
      assert.deepEqual(await allFiles(format3), files);
    });

    it("is refused for a manifest that is not one of format 3", async () => {
      await editManifest(format3, (value) => (value.surprise = true));
      assert.throws(() => toFormat4.transform({ directory: format3, manifest: JSON.parse(readFileSyncText(join(format3, "manifest.json"))) }), refused(/has the key "surprise", which a format 3 manifest does not have/));
      assert.throws(() => toFormat4.transform({ directory: format3, manifest: { formatVersion: 2 } }), refused(/is not a format 3 manifest/));
    });
  });

  describe("migrating a directory from format 4 to format 5", () => {
    it("describes the step in a dry run, and changes nothing", async () => {
      await unchanged(format4, () => {
        const report = migrateDatabase(format4, { dryRun: true });
        assert.deepEqual([report.formatVersion, report.targetVersion, report.migrationPath, report.migrated], [4, 5, [4, 5], false]);
        assert.deepEqual(report.steps, [{ from: 4, to: 5, summary: toFormat5.summary, changes: STEP_4_TO_5_CHANGES_GENERATION_3, status: "planned" }]);
      });
    });

    it("writes the schema file again as a document of version 2, under the name of a new generation, and the database holds what it held", async () => {
      const before = await contentsOf(format4);
      const files = await identities(format4);
      const stored = await manifest(format4);

      const report = migrateDatabase(format4);
      assert.deepEqual([report.migrated, report.migrationPath, report.steps.map((step) => step.status), report.tables], [true, [4, 5], ["applied"], 4]);
      assert.deepEqual(await manifest(format4), { ...stored, formatVersion: 5, minimumReaderVersion: 5, generation: 4, schema: "schema.g4.json" });
      // Every table file is the file it was; the schema file of format 4 is gone, and the one of format 5 is in its place.
      const { "manifest.json": _old, "schema.g2.json": _schema, ...otherFiles } = files;
      const { "manifest.json": _new, "schema.g4.json": _written, ...otherFilesAfter } = await identities(format4);
      assert.deepEqual(otherFilesAfter, otherFiles);
      assert.deepEqual(await contentsOf(format4), before);
      assert.equal(inspectDatabase(format4).compatibility, "current");
      // It is the database that the fixture of format 5 is.
      assert.deepEqual(await allFiles(format4), await allFiles(format5));

      // Run again, there is nothing to do; and a save of what is stored writes nothing.
      await unchanged(format4, () => assert.deepEqual([migrateDatabase(format4).migrated, migrateDatabase(format4).steps], [false, []]));
      const storage = new DirectoryStorageAdapter(format4, { retiredFileGraceMs: 0 });
      const state = await storage.load();
      storage.saveSync(state);
      assert.equal(storage.lastSave?.published, false);
    });

    it("is read as it is before it is migrated, and is not saved to", async () => {
      const files = await allFiles(format4);
      const storage = new DirectoryStorageAdapter(format4);
      const state = await storage.load();
      assert.deepEqual([state.meta, storage.formatStatus?.compatibility, storage.formatStatus?.migrationPath], [{ version: 4 }, "older", [4, 5]]);
      assert.deepEqual(state.collections, (await contentsOf(join(FIXTURES, "directory-format-5"))).collections);
      assert.throws(() => storage.saveSync(state), formatError("DATABASE_MIGRATION_REQUIRED", /four\.db: Database format 4 is older than the format this build writes \(5\)\. It can be read as it is, and was not changed\. To change it, migrate it first: local-db-sandbox migrate .*four\.db$/));
      assert.deepEqual(await allFiles(format4), files);
    });

    it("marks the expressions that a recorded rename may have left behind, which format 4 had no place to record", async () => {
      const at = { source: "postgresql-migrations", file: "0002_rename.sql", sha256: "b".repeat(64), statement: 1, line: 1 };
      // The schema of a format 4 database as a collector of that time left it: a check that was written before its column was renamed.
      const schema = {
        schemaVersion: 1,
        tables: [
          {
            name: "users",
            columns: [
              { column: "id", property: "id", type: "integer", nullable: false, primaryKey: true },
              { column: "display_name", property: "name", type: "text", nullable: false, primaryKey: false, renames: [{ from: "name", to: "display_name", at }] },
            ],
            checks: [{ name: "users_name_check", expression: "name <> ''" }],
            indexes: [{ name: "users_lower_idx", columns: [], expressions: ["lower(name)"] }],
          },
        ],
      };
      await writeFile(join(format4, "schema.g2.json"), `${JSON.stringify(schema, null, 2)}\n`);
      // Read as it is, the format 4 database already says so.
      const asItIs = new DirectoryStorageAdapter(format4);
      await asItIs.load();
      assert.deepEqual([asItIs.schema?.[0]?.checks?.[0]?.mayBeStale, asItIs.schema?.[0]?.indexes?.[0]?.mayBeStale], [true, true]);

      const report = migrateDatabase(format4);
      assert.equal(
        report.steps[0]?.changes[1],
        "schema.g2.json -> schema.g4.json: written again as a schema document of version 2; 2 expressions are marked as possibly stale, since a rename is recorded that may have reached them and format 4 did not record what a text names",
      );
      const written = JSON.parse((await allFiles(format4))["schema.g4.json"] as string);
      assert.equal(written.schemaVersion, 2);
      assert.deepEqual(written.tables[0].checks, [{ name: "users_name_check", expression: "name <> ''", mayBeStale: true }]);
      assert.deepEqual(written.tables[0].indexes, [{ name: "users_lower_idx", columns: [], expressions: ["lower(name)"], mayBeStale: true }]);
    });

    it("writes the manifest alone for a database without table definitions", async () => {
      const bare = join(root, "bare.db");
      await createDatabase(bare, { collections: { notes: [{ id: 1 }] } });
      // As a database that came from format 2 without a schema file is: the manifest names none, and there is none.
      await editManifest(bare, (value) => {
        Object.assign(value, { formatVersion: 4, minimumReaderVersion: 4 });
        delete value.schema;
      });
      await rm(join(bare, "schema.json"));
      const files = await identities(bare);
      const report = migrateDatabase(bare);
      assert.deepEqual(report.steps[0]?.changes, ["manifest.json: formatVersion 4 -> 5, minimumReaderVersion 5", "schema: there is none", "tables/: 1 table file kept as it is"]);
      const { "manifest.json": _old, ...otherFiles } = files;
      const { "manifest.json": _new, ...otherFilesAfter } = await identities(bare);
      assert.deepEqual(otherFilesAfter, otherFiles);
    });

    it("is refused for a manifest that is not one of format 4, and for a schema file it cannot read", async () => {
      assert.throws(() => toFormat5.transform({ directory: format4, manifest: { ...JSON.parse(readFileSyncText(join(format4, "manifest.json"))), surprise: true } }), refused(/has the key "surprise", which a format 4 manifest does not have/));
      assert.throws(() => toFormat5.transform({ directory: format4, manifest: { formatVersion: 3 } }), refused(/is not a format 4 manifest/));
      await writeFile(join(format4, "schema.g2.json"), JSON.stringify({ schemaVersion: 1, tables: [{ name: "t", columns: [] }] }));
      await unchanged(format4, () => assert.throws(() => migrateDatabase(format4), refused(/four\.db was not migrated from format 4 to format 5: .*table "t" needs at least one column\. It is still format 4\.$/)));
    });
  });

  describe("a migration that cannot be completed", () => {
    /** The migration to format 3 with its result changed, to stand for a step that goes wrong, followed by the ones to format 4 and 5. */
    const broken = (change: (output: DirectoryMigrationOutput) => void, more: Partial<FormatMigration> = {}): FormatMigration[] => [
      {
        ...toFormat3,
        ...more,
        transform: (source) => {
          const output = toFormat3.transform(source);
          change(output);
          return output;
        },
      },
      toFormat4,
      toFormat5,
    ];
    const usersText = (rows: unknown): string => `${JSON.stringify(rows, null, 2)}\n`;
    const pointUsersAt = (output: DirectoryMigrationOutput, file: string): void => {
      output.manifest.tables = TABLES.map((table) => (table.name === "users" ? { name: "users", file } : table));
    };

    it("leaves the database as it was, in its old format, whatever went wrong before it was published", async () => {
      const users = JSON.parse(await readFile(join(format2, "tables/users.json"), "utf8"));
      const failures: [string, FormatMigration[], RegExp][] = [
        [
          "the step fails",
          broken(() => {
            throw new Error("the disk is on fire");
          }),
          /old\.db was not migrated from format 2 to format 3: the disk is on fire\. It is still format 2\.$/,
        ],
        ["the result names a file that is not there", broken((output) => (output.manifest.tables = [...TABLES, { name: "ghost", file: "ghost.json" }])), /was not migrated from format 2 to format 3: Table "ghost" has no file/],
        ["the result is not the target format", broken((output) => Object.assign(output.manifest, { formatVersion: 2, minimumReaderVersion: 2 })), /was not migrated.*the format 3 manifest says format 2\. It is still format 2\.$/],
        ["the result is not a manifest of the target format", broken((output) => (output.manifest.surprise = true)), /was not migrated.*the format 3 manifest has the unknown key "surprise"/],
        [
          "the result has other rows",
          broken((output) => {
            output.write["tables/users.g1.json"] = usersText(users.slice(1));
            pointUsersAt(output, "users.g1.json");
          }),
          /was not migrated.*the rows of table "users" are not the same in the result\. It is still format 2\.$/,
        ],
        ["the result has other tables", broken((output) => (output.manifest.tables = TABLES.slice(1))), /was not migrated.*the result has the tables orders, Order Items, empty where the database has users, orders, Order Items, empty/],
        ["the result has other settings", broken((output) => (output.manifest.config = { ...CONFIG, server: { port: 1 } })), /was not migrated.*"config" is not the same in the result/],
        ["the result has another name", broken((output) => (output.manifest.database = "other")), /was not migrated.*"name" is not the same in the result/],
        [
          "the step's own check refuses the result",
          broken(() => undefined, {
            verify: () => {
              throw new Error("not what this step should give");
            },
          }),
          /was not migrated.*not what this step should give\. It is still format 2\.$/,
        ],
        ["the step would write over a file of the database", broken((output) => (output.write["tables/users.json"] = "[]\n")), /was not migrated from format 2 to format 3: EEXIST/],
        ["the step would write outside the database", broken((output) => (output.write["../outside.json"] = "[]\n")), /was not migrated.*a migration may not write or remove "\.\.\/outside\.json"/],
        ["the step would write the manifest itself", broken((output) => (output.write["manifest.json"] = "{}")), /was not migrated.*a migration may not write or remove "manifest\.json"/],
        ["the step would remove a file the result consists of", broken((output) => output.remove.push("tables/orders.json")), /was not migrated.*the migration would remove .*orders\.json, which the result consists of/],
      ];
      const before = await contentsOf(format2);
      for (const [label, migrations, message] of failures) {
        await unchanged(format2, () => assert.throws(() => migrateDatabase(format2, { migrations }), refused(message), label));
      }
      assert.equal(existsSync(join(root, "outside.json")), false);
      // Still format 2, still complete, and still to be migrated.
      assert.deepEqual([inspectDatabase(format2).formatVersion, await contentsOf(format2)], [2, before]);
      assert.equal(migrateDatabase(format2).migrated, true);
      assert.deepEqual(await contentsOf(format2), before);
    });

    it("publishes what a step writes under a new name, and removes what it replaced only afterwards", async () => {
      // A step that rewrites a table, as one that changed how rows are stored would.
      const text = await readFile(join(format2, "tables/users.json"), "utf8");
      const seen: Record<string, [boolean, boolean, number]> = {};
      const migrations = broken((output) => {
        output.write["tables/users.g1.json"] = text;
        pointUsersAt(output, "users.g1.json");
        output.remove.push("tables/users.json");
      });
      const before = await contentsOf(format2);
      const report = migrateDatabase(format2, {
        migrations,
        onProgress: ({ from, to, phase }) => (seen[`${from}->${to} ${phase}`] = [existsSync(join(format2, "tables/users.json")), existsSync(join(format2, "tables/users.g1.json")), inspectDatabase(format2).formatVersion]),
      });
      // Before the manifest is replaced both files are there and the format is the old one; after it, the new one. The replaced file is gone before the next step.
      assert.deepEqual(seen, {
        "2->3 prepared": [true, true, 2],
        "2->3 published": [true, true, 3],
        "3->4 prepared": [false, true, 3],
        "3->4 published": [false, true, 4],
        "4->5 prepared": [false, true, 4],
        "4->5 published": [false, true, 5],
      });
      assert.equal(report.migrated, true);
      assert.deepEqual(Object.keys(await allFiles(format2)), ["manifest.json", "schema.g2.json", "tables/empty.json", "tables/Order%20Items.json", "tables/orders.json", "tables/users.g1.json"]);
      assert.deepEqual(await contentsOf(format2), before);
    });

    it("is refused while another process is saving the database", async () => {
      // The draft of the next manifest, held by a process that is running.
      await writeFile(join(format2, "manifest.json.tmp"), String(process.ppid));
      await unchanged(format2, () => assert.throws(() => migrateDatabase(format2), refused(/old\.db is being saved by another process \(pid \d+\)\. One process saves a database at a time/)));
      assert.equal(inspectDatabase(format2).formatVersion, 2);
    });

    for (const [phase, format] of [
      ["prepared", 2],
      ["published", 3],
    ] as const) {
      it(`leaves format ${format}, complete, when the process is killed ${phase === "prepared" ? "just before" : "just after"} the migration is published`, async () => {
        // What a save of format 2 staged and never committed: not part of the database in either format.
        await mkdir(join(format2, ".staging-999999999-1/tables"), { recursive: true });
        await writeFile(join(format2, ".staging-999999999-1/tables/users.json"), "[]");
        const before = await contentsOf(format2);
        const script = join(root, "killed.mjs");
        await writeFile(
          script,
          `import { migrateDatabase } from ${JSON.stringify(SOURCE)};\n` +
            "const [path, phase] = process.argv.slice(2);\n" +
            "migrateDatabase(path, { onProgress: (progress) => { if (progress.phase === phase) { process.kill(process.pid, 'SIGKILL'); for (;;); } } });\n" +
            "process.stdout.write('finished');\n",
        );
        const killed = await exit(spawn(process.execPath, [script, format2, phase], { stdio: ["ignore", "pipe", "pipe"] }));
        assert.notEqual(killed.code, 0, killed.output);
        assert.doesNotMatch(killed.output, /finished/);

        // One format or the other, never something in between; and all of the database either way.
        const inspection = inspectDatabase(format2);
        assert.deepEqual([inspection.formatVersion, inspection.compatibility, inspection.tables], [format, "older", 4]);
        assert.deepEqual(await contentsOf(format2), before);
        assert.equal((await new DirectoryStorageAdapter(format2).load()).meta.version, format);

        // Running it again goes on from the format the database has.
        const again = migrateDatabase(format2);
        assert.deepEqual([again.migrated, again.migrationPath], [true, format === 2 ? [2, 3, 4, 5] : [3, 4, 5]]);
        assert.deepEqual([inspectDatabase(format2).formatVersion, await contentsOf(format2)], [5, before]);
        // What the killed process left is gone with the next save at the latest.
        const storage = new DirectoryStorageAdapter(format2, { retiredFileGraceMs: 0 });
        const state = await storage.load();
        storage.saveSync({ ...state, collections: { ...state.collections, empty: [{ id: 1 }] } });
        assert.deepEqual(Object.keys(await allFiles(format2)), ["manifest.json", "schema.g2.json", "tables/empty.g3.json", "tables/Order%20Items.json", "tables/orders.json", "tables/users.json"]);
      });
    }
  });

  describe("a save that a format 2 build committed and did not finish", () => {
    /** Committed by a process that is gone: the files are staged, one has been moved, and one table is to be removed. */
    const commit = async (pid: number | string): Promise<void> => {
      const staging = `.staging-${pid}-1`;
      await mkdir(join(format2, staging, "tables"), { recursive: true });
      const committed = await manifest(format2);
      committed.tables = committed.tables.filter((table: { name: string }) => table.name !== "empty");
      await writeFile(join(format2, staging, "manifest.json"), JSON.stringify(committed));
      await writeFile(join(format2, staging, "tables/users.json"), JSON.stringify([{ id: 9, name: "New", active: true, joined: null, balance: 1, profile: null }]));
      await writeFile(join(format2, "tables/orders.json"), "[]");
      await writeFile(join(format2, ".commit.json"), JSON.stringify({ staging, files: ["manifest.json", "tables/users.json", "tables/orders.json"], remove: ["tables/empty.json"] }));
    };

    it("is not finished by reading or inspecting: the database is refused, and says that migrating finishes it", async () => {
      await commit(999999999);
      await unchanged(format2, async () => {
        await assert.rejects(
          new DirectoryStorageAdapter(format2).load(),
          formatError("DATABASE_MIGRATION_REQUIRED", /old\.db holds a save that a format 2 build committed and did not finish putting in place \(3 files to move, 1 file to remove\), so it cannot be read as it is\. Migrating it finishes that save: local-db-sandbox migrate .*old\.db$/),
        );
        const inspection = inspectDatabase(format2);
        assert.deepEqual([inspection.formatVersion, inspection.migrationPath], [2, [2, 3, 4, 5]]);
        assert.match(inspection.notes.join("\n"), /The directory holds a save that a format 2 build committed and did not finish putting in place/);
        // A dry run says that it comes first, and does not do it.
        assert.deepEqual(migrateDatabase(format2, { dryRun: true }).steps[0]?.changes, [
          "first, a save that a format 2 build committed and did not finish putting in place (3 files to move, 1 file to remove) is finished",
          `then: ${toFormat3.summary}`,
        ]);
      });
    });

    it("is finished by the migration, which then migrates what that save made of the database", async () => {
      await commit(999999999);
      const report = migrateDatabase(format2);
      assert.deepEqual([report.migrated, report.tables, report.rows], [true, 3, 3]);
      assert.deepEqual(Object.keys(await allFiles(format2)), ["manifest.json", "schema.g2.json", "tables/Order%20Items.json", "tables/orders.json", "tables/users.json"]);
      const { collections } = await new DirectoryStorageAdapter(format2).load();
      assert.deepEqual([collections.users, collections.orders, Object.keys(collections)], [[{ id: 9, name: "New", active: true, joined: null, balance: 1, profile: null }], [], ["users", "orders", "Order Items"]]);
    });

    it("is left alone while the process that made it is still running", async () => {
      await commit(process.ppid);
      await unchanged(format2, () => assert.throws(() => migrateDatabase(format2), refused(/was not migrated from format 2 to format 3: .*is being saved by a format 2 build right now \(pid \d+\)\. Stop that process, then migrate\. It is still format 2\.$/)));
    });

    it("that was interrupted before it committed left files that are no part of the database; the migration removes them", async () => {
      await mkdir(join(format2, ".staging-999-1/tables"), { recursive: true });
      await writeFile(join(format2, ".staging-999-1/tables/users.json"), "[]");
      await writeFile(join(format2, ".staging-999-1/manifest.json"), "{}");
      const before = await contentsOf(format2);

      assert.deepEqual(migrateDatabase(format2).steps[0]?.changes.at(-1), "removed: .staging-999-1 (left by a save that was interrupted before it committed; never part of the database)");
      assert.deepEqual(Object.keys(await allFiles(format2)), ["manifest.json", "schema.g2.json", "tables/empty.json", "tables/Order%20Items.json", "tables/orders.json", "tables/users.json"]);
      assert.deepEqual(await contentsOf(format2), before);
    });
  });

  describe("a process that reads while another one migrates", { timeout: 120_000 }, () => {
    it("gets all of the database every time, in the old format or in the new one", async () => {
      const collections: Record<string, Row[]> = {};
      for (let table = 0; table < 60; table += 1) {
        collections[`table_${table}`] = Array.from({ length: 20 }, (_, row) => ({ id: row, table, text: `row ${row} of table ${table}` }));
      }
      const expected = JSON.stringify(collections);
      const script = join(root, "migrate.mjs");
      await writeFile(script, `import { migrateDatabase } from ${JSON.stringify(SOURCE)};\nprocess.stdout.write(String(migrateDatabase(process.argv[2]).migrated));\n`);

      const seen = new Set<number>();
      for (let round = 0; round < 4; round += 1) {
        const path = join(root, `read-${round}.db`);
        await createDatabase(path, { collections });
        // As a build of format 2 left it.
        await editManifest(path, (value) => {
          value.formatVersion = 2;
          for (const key of ["minimumReaderVersion", "generation", "schema"]) {
            delete value[key];
          }
        });

        const versions: number[] = [];
        const read = async (): Promise<void> => {
          const state = await new DirectoryStorageAdapter(path).load();
          assert.equal(JSON.stringify(state.collections), expected, `a read during round ${round} did not get the whole database`);
          versions.push(state.meta.version);
        };
        await read();
        const migrating = exit(spawn(process.execPath, [script, path], { stdio: ["ignore", "pipe", "pipe"] }));
        let running = true;
        void migrating.then(() => (running = false));
        while (running) {
          await read();
          // Reading does not wait for anything, so the end of the other process is only noticed when it is waited for.
          await new Promise((resolve) => setImmediate(resolve));
        }
        await read();

        assert.deepEqual(await migrating, { code: 0, output: "true" });
        // Format 2 until the first step was published, then format 3, 4, and 5, and never back.
        assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
        assert.deepEqual([versions[0], versions.at(-1)], [2, 5]);
        versions.forEach((version) => seen.add(version));
      }
      assert.ok([...seen].every((version) => [2, 3, 4, 5].includes(version)), [...seen].join(", "));
    });
  });

  describe("a single-file database", () => {
    it("is read and written in format 1, with everything it holds", async () => {
      const text = await readFile(file1, "utf8");
      const storage = new JsonStorageAdapter(file1);
      const state = await storage.load();
      assert.deepEqual([state.meta, storage.formatStatus?.compatibility, storage.formatStatus?.declared, Object.keys(state.collections)], [{ version: 1 }, "current", true, ["users", "orders", "Order Items", "empty"]]);
      // Saving what was loaded writes the same file.
      await storage.save(state);
      assert.equal(await readFile(file1, "utf8"), text);
      assert.deepEqual(JSON.parse(text).$meta, { version: 1 });
    });

    it("that states no version is read as format 1, and states it from its first save", async () => {
      const storage = new JsonStorageAdapter(unversioned);
      const state = await storage.load();
      assert.deepEqual([state.meta, storage.formatStatus?.formatVersion, storage.formatStatus?.declared, storage.formatStatus?.writable], [{ version: 1 }, 1, false, true]);

      (state.collections.orders as Row[]).push({ id: 1, userId: 2 });
      storage.saveSync(state);
      const document = JSON.parse(await readFile(unversioned, "utf8"));
      assert.deepEqual(Object.keys(document), ["$meta", "data"]);
      assert.deepEqual([document.$meta, document.data.orders], [{ version: 1 }, [{ id: 1, userId: 2 }]]);
      assert.deepEqual([inspectDatabase(unversioned).declared, inspectDatabase(unversioned).notes], [true, []]);
    });

    it("of a later format is refused, and is not written to when it says that it can be read", async () => {
      const document = JSON.parse(await readFile(file1, "utf8"));
      await writeFile(file1, JSON.stringify({ ...document, $meta: { version: 2 } }));
      await unchanged(file1, async () => {
        await assert.rejects(new JsonStorageAdapter(file1).load(), formatError("DATABASE_FORMAT_TOO_NEW", /file\.db\.json: Database format 2 is newer than this build supports \(max 1\)\. Upgrade local-db-sandbox\.$/));
        assert.deepEqual([inspectDatabase(file1).compatibility, inspectDatabase(file1).tables], ["unsupported-new", undefined]);
        assert.throws(() => migrateDatabase(file1), formatError("DATABASE_FORMAT_TOO_NEW", /Database format 2 is newer than this build supports \(max 1\)/));
      });

      await writeFile(file1, JSON.stringify({ ...document, $meta: { version: 2, minimumReaderVersion: 1 } }));
      await unchanged(file1, async () => {
        const storage = new JsonStorageAdapter(file1);
        const state = await storage.load();
        assert.deepEqual([state.meta, storage.formatStatus?.compatibility, Object.keys(state.collections).length], [{ version: 2 }, "newer", 4]);
        const refusal = formatError("DATABASE_FORMAT_READ_ONLY", /Database format 2 is newer than this build supports \(max 1\)\. It says that a reader of format 1 can read it/);
        assert.throws(() => storage.assertWritable(), refusal);
        assert.throws(() => storage.saveSync(state), refusal);
        await assert.rejects(storage.save(state), refusal);
      });
    });
  });
});
