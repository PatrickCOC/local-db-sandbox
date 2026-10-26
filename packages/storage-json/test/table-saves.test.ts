import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Row } from "../../core/src/index.ts";
import { SqliteRuntime } from "../../runtime/src/index.ts";
import type { SnapshotSaveEvent, SqlEvent, TableSchema } from "../../runtime/src/index.ts";
import { DirectoryStorageAdapter, JsonStorageAdapter, createDatabase } from "../src/index.ts";
import type { DirectorySaveReport } from "../src/index.ts";
import { allFiles, databaseFiles, storedRows, tableFile } from "./support/database-files.ts";

/*
 * A commit of the relational runtime on a database directory writes the
 * files of the tables it changed, and no others.
 *
 * The database here is made up for the test: 48 tables in a chain of foreign
 * keys, about 570 KB in all. Nothing below knows more about it than a table's
 * name, so what holds for it holds for any schema of that size.
 */

const TABLES = 48;
const ROWS = 36;
const name = (index: number): string => `table_${String(index).padStart(2, "0")}`;

/** Every table refers to the one before it; deleting a row there clears the reference. */
const SCHEMA: TableSchema[] = Array.from({ length: TABLES }, (_, index) => ({
  name: name(index + 1),
  columns: [
    { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
    { name: "label", type: "text", nullable: false, primary: false },
    { name: "amount", type: "integer", nullable: false, primary: false, default: 0 },
    { name: "payload", type: "text", nullable: true, primary: false },
    ...(index === 0 ? [] : [{ name: "parentId", type: "integer" as const, nullable: true, primary: false, references: { table: name(index), column: "id", onDelete: "SET NULL" } }]),
  ],
}));

function fixture(): Record<string, Row[]> {
  return Object.fromEntries(
    SCHEMA.map((table, index) => [
      table.name,
      Array.from({ length: ROWS }, (_, row) => ({
        id: row + 1,
        label: `${table.name} row ${row + 1}`,
        amount: (index + 1) * (row + 1),
        payload: `${table.name}:${row + 1}:`.padEnd(200, "x"),
        ...(index > 0 && { parentId: row + 1 }),
      })),
    ]),
  );
}

/** What tells a file apart from another one under the same name, and from itself after it was written again. */
function identity(path: string): string {
  const stats = statSync(path, { bigint: true });
  return `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

describe("a commit on a database directory of 48 tables", { timeout: 120_000 }, () => {
  let root: string;
  let path: string;
  let storage: DirectoryStorageAdapter;
  let runtime: SqliteRuntime;
  let reports: DirectorySaveReport[];
  let saves: SnapshotSaveEvent[];
  let identities: Map<string, string>;

  const open = async (schema: TableSchema[] = SCHEMA): Promise<void> => {
    reports = [];
    saves = [];
    storage = new DirectoryStorageAdapter(path, { retiredFileGraceMs: 0, onSave: (report) => reports.push(report) });
    const state = await storage.load();
    runtime = await SqliteRuntime.open({ schema, storage, state, onSave: (event) => saves.push(event) });
    runtime.execute("PRAGMA foreign_keys = ON");
    identities = new Map(Object.keys(state.collections).map((table) => [table, identity(tableFile(path, table))]));
  };
  /** The tables whose file is not the file it was when the database was opened. */
  const rewritten = (): string[] => [...identities].filter(([table, was]) => identity(tableFile(path, table)) !== was).map(([table]) => table);
  const run = (...statements: string[]): void => {
    for (const sql of statements) {
      runtime.execute(sql);
    }
  };
  const lastReport = (): DirectorySaveReport => reports.at(-1) as DirectorySaveReport;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-table-saves-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    runtime?.close();
    path = join(root, "sandbox.db");
    await rm(path, { recursive: true, force: true });
    await createDatabase(path, { collections: fixture(), schema: SCHEMA });
    await open();
  });

  it("starts from 48 table files of the size this is about", async () => {
    const files = await databaseFiles(path);
    assert.equal(Object.keys(files).filter((file) => file.startsWith("tables/")).length, TABLES);
    const bytes = Object.values(files).reduce((total, text) => total + Buffer.byteLength(text), 0);
    assert.ok(bytes > 400_000 && bytes < 600_000, `${bytes} bytes`);
  });

  for (const [what, sql] of [
    ["INSERT", "INSERT INTO table_17 (label, amount) VALUES ('new', 1)"],
    ["UPDATE", "UPDATE table_17 SET amount = amount + 1 WHERE id = 3"],
    ["DELETE", "DELETE FROM table_48 WHERE id = 36"],
  ] as const) {
    it(`writes one table file for a statement that changed one table: ${what}`, async () => {
      const before = await allFiles(path);
      const table = /table_\d\d/.exec(sql)?.[0] as string;
      run(sql);

      assert.deepEqual(rewritten(), [table]);
      const report = lastReport();
      assert.deepEqual([reports.length, report.kind, report.serializedTables, report.writtenTables, report.reusedTables, report.schemaWritten], [1, "tables", [table], [table], TABLES - 1, false]);
      assert.deepEqual(saves.map((event) => [event.kind, event.tables]), [["tables", [table]]]);
      // One table file and the manifest, out of a database twenty times that size.
      assert.ok(report.bytesWritten < report.sizeBytes / 20, `${report.bytesWritten} of ${report.sizeBytes} bytes were written`);
      // Every other file in the directory is byte for byte what it was.
      const after = await allFiles(path);
      const changed = Object.keys({ ...before, ...after }).filter((file) => before[file] !== after[file]);
      assert.deepEqual(changed.sort(), ["manifest.json", `tables/${table}.g2.json`, `tables/${table}.json`]);
      assert.deepEqual(await storedRows(path, table), runtime.snapshot().collections[table]);
    });
  }

  it("writes two table files for a transaction that changed two tables", () => {
    run("BEGIN", "UPDATE table_03 SET label = 'changed' WHERE id = 1", "INSERT INTO table_40 (label) VALUES ('new')", "UPDATE table_03 SET amount = 0 WHERE id = 2", "COMMIT");
    assert.deepEqual(rewritten(), ["table_03", "table_40"]);
    assert.deepEqual([reports.length, lastReport().writtenTables, lastReport().reusedTables], [1, ["table_03", "table_40"], TABLES - 2]);
  });

  it("writes nothing for a transaction that is rolled back, or that only reads", async () => {
    const before = await allFiles(path);
    run("BEGIN", "DELETE FROM table_10", "UPDATE table_11 SET amount = 0", "INSERT INTO table_12 (label) VALUES ('x')", "ROLLBACK");
    run("BEGIN", ...SCHEMA.map((table) => `SELECT COUNT(*) FROM ${table.name}`), "COMMIT");
    run("SELECT * FROM table_01 JOIN table_02 ON table_02.parentId = table_01.id");

    assert.deepEqual([reports, saves, rewritten()], [[], [], []]);
    assert.deepEqual(await allFiles(path), before);
    assert.equal(storage.generation, 1);
  });

  it("writes only the tables that are still changed after a rollback to a savepoint", () => {
    run("BEGIN", "UPDATE table_05 SET amount = 1", "SAVEPOINT s", "DELETE FROM table_06", "UPDATE table_07 SET amount = 1", "ROLLBACK TO s", "INSERT INTO table_08 (label) VALUES ('after')", "COMMIT");
    assert.deepEqual(rewritten(), ["table_05", "table_08"]);
    assert.deepEqual(lastReport().writtenTables, ["table_05", "table_08"]);
  });

  it("writes the table that a foreign key's action changed along with the one the statement names", async () => {
    run("DELETE FROM table_20 WHERE id = 5");
    assert.deepEqual(rewritten(), ["table_20", "table_21"]);
    assert.equal((await storedRows(path, "table_21"))[4]?.parentId, null);
  });

  it("falls back to saving the complete state when a table cannot be watched, and still writes only the files that differ", async () => {
    runtime.close();
    await rm(path, { recursive: true, force: true });
    const keyless: TableSchema = { name: "notes", columns: [{ name: "text", type: "text", nullable: true, primary: false }] };
    await createDatabase(path, { collections: { ...fixture(), notes: [{ text: "first" }] }, schema: [...SCHEMA, keyless] });
    await open([...SCHEMA, keyless]);

    // A row of the table without a key: the engine's record of changes does not show it.
    run("INSERT INTO notes (text) VALUES ('second')");
    assert.deepEqual([lastReport().kind, lastReport().serializedTables.length, lastReport().writtenTables], ["complete", TABLES + 1, ["notes"]]);
    assert.deepEqual(await storedRows(path, "notes"), [{ text: "first" }, { text: "second" }]);

    // Any other write is saved the same way: every table is read and compared, and the one that differs is written.
    run("UPDATE table_30 SET amount = -1 WHERE id = 1");
    assert.deepEqual([lastReport().kind, lastReport().serializedTables.length, lastReport().writtenTables, lastReport().reusedTables], ["complete", TABLES + 1, ["table_30"], TABLES]);
    assert.deepEqual(saves.map((event) => event.kind), ["complete", "complete"]);
    assert.deepEqual(rewritten(), ["table_30", "notes"]);
    assert.equal((await storedRows(path, "table_30"))[0]?.amount, -1);
  });

  it("is the same database when it is opened again, whatever was saved table by table", async () => {
    run("INSERT INTO table_01 (label) VALUES ('a')", "BEGIN", "UPDATE table_02 SET parentId = 37 WHERE id = 1", "DELETE FROM table_47 WHERE id > 30", "COMMIT", "DELETE FROM table_09 WHERE id = 1");
    const expected = runtime.snapshot().collections;
    runtime.close();

    await open();
    assert.deepEqual(runtime.snapshot().collections, expected);
    assert.equal(storage.generation, 4);
    assert.deepEqual(Object.keys(expected), SCHEMA.map((table) => table.name));
  });

  it("tells the time of the statement, of reading the rows, and of each step of the save apart", () => {
    const events: SqlEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    run("UPDATE table_25 SET label = 'timed' WHERE id = 1");

    const [event] = events as [SqlEvent];
    const [save] = saves as [SnapshotSaveEvent];
    const report = lastReport();
    // The statement's time includes the save; the save's time is the reading of the rows and the storage's part.
    assert.ok((event.snapshotSaveMs as number) <= event.localExecutionMs);
    assert.ok(save.extractionMs + save.storageMs <= (event.snapshotSaveMs as number) + 0.5);
    assert.ok(report.totalMs <= save.storageMs + 0.5);
    assert.ok(report.serializeMs + report.writeMs + report.publishMs + report.cleanupMs <= report.totalMs + 0.5);
    for (const [step, ms] of Object.entries({ ...save, ...report }).filter(([key]) => key.endsWith("Ms"))) {
      assert.ok(typeof ms === "number" && ms >= 0, `${step} = ${String(ms)}`);
    }
  });

  it("takes less time for a commit that changed one table than a save of every table does", async (context) => {
    // A save of every table, as a commit was before it was told which tables changed: all 48 files are new.
    const everything: number[] = [];
    for (let round = 1; round <= 5; round += 1) {
      const state = runtime.snapshot();
      for (const rows of Object.values(state.collections)) {
        (rows[0] as Row).amount = -round;
      }
      const startedAt = performance.now();
      storage.saveSync(state);
      everything.push(performance.now() - startedAt);
      assert.equal(lastReport().writtenTables.length, TABLES);
    }
    runtime.close();
    await open();

    const one: number[] = [];
    const steps = { extraction: [] as number[], serialize: [] as number[], write: [] as number[], publish: [] as number[], cleanup: [] as number[] };
    for (let round = 1; round <= 25; round += 1) {
      const startedAt = performance.now();
      run(`UPDATE table_24 SET amount = ${round} WHERE id = 2`);
      one.push(performance.now() - startedAt);
      steps.extraction.push((saves.at(-1) as SnapshotSaveEvent).extractionMs);
      steps.serialize.push(lastReport().serializeMs);
      steps.write.push(lastReport().writeMs);
      steps.publish.push(lastReport().publishMs);
      steps.cleanup.push(lastReport().cleanupMs);
    }
    context.diagnostic(
      `48 tables, ${(lastReport().sizeBytes / 1024).toFixed(0)} KB: saving every table ${median(everything).toFixed(1)} ms; a commit that changed one table ${median(one).toFixed(1)} ms ` +
        `(reading its rows ${median(steps.extraction).toFixed(2)}, to text ${median(steps.serialize).toFixed(2)}, writing ${median(steps.write).toFixed(2)}, manifest ${median(steps.publish).toFixed(2)}, removing the old file ${median(steps.cleanup).toFixed(2)})`,
    );
    assert.ok(median(one) < median(everything), `one table: ${median(one).toFixed(1)} ms; every table: ${median(everything).toFixed(1)} ms`);
  });
});

describe("a single-file database", () => {
  it("is written as a whole at every commit, as before: it has no files of single tables to write", async () => {
    const root = await mkdtemp(join(tmpdir(), "local-db-sandbox-table-saves-file-"));
    try {
      const file = join(root, "sandbox.db.json");
      const [first, second] = SCHEMA as [TableSchema, TableSchema];
      await createDatabase(file, { collections: { table_01: [{ id: 1, label: "a", amount: 1, payload: null }], table_02: [] } });
      const storage = new JsonStorageAdapter(file);
      assert.equal((storage as { saveTablesSync?: unknown }).saveTablesSync, undefined);

      const saves: SnapshotSaveEvent[] = [];
      const runtime = await SqliteRuntime.open({ schema: [first, second], storage, onSave: (event) => saves.push(event) });
      runtime.execute("INSERT INTO table_02 (label, parentId) VALUES ('b', 1)");
      runtime.execute("BEGIN");
      runtime.execute("UPDATE table_01 SET amount = 2");
      runtime.execute("ROLLBACK");
      runtime.close();

      assert.deepEqual(saves.map((event) => [event.kind, event.tables]), [["complete", ["table_01", "table_02"]]]);
      assert.deepEqual(JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf8")).data, {
        table_01: [{ id: 1, label: "a", amount: 1, payload: null }],
        table_02: [{ id: 1, label: "b", amount: 0, payload: null, parentId: 1 }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
