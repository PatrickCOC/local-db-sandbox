import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import { FORMAT_MIGRATIONS } from "../../storage-json/src/index.ts";
import { allFiles, storedRows, tableFile } from "../../storage-json/test/support/database-files.ts";
import { runCli, startSandbox } from "../src/index.ts";

/*
 * `inspect` and `migrate`, and what the other commands do with a database
 * that is not in the format this build writes. The databases are copies of
 * storage-json/test/fixtures/formats.
 */

const FIXTURES = join(import.meta.dirname, "../../storage-json/test/fixtures/formats");
const STEP = (FORMAT_MIGRATIONS[0] as { summary: string }).summary;
const STEP_4 = (FORMAT_MIGRATIONS[1] as { summary: string }).summary;
const STEP_5 = (FORMAT_MIGRATIONS[2] as { summary: string }).summary;

describe("inspect and migrate commands", () => {
  let dir: string;
  let format2: string;
  let format3: string;
  let format5: string;
  let unversioned: string;

  const run = async (...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    let stdout = "";
    let stderr = "";
    const stdin = new PassThrough();
    stdin.end("");
    const code = await runCli(argv, { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter(), stdin });
    return { code, stdout, stderr };
  };
  const editManifest = async (directory: string, edit: (value: any) => void): Promise<void> => {
    const value = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    edit(value);
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify(value, null, 2)}\n`);
  };
  const sizeOf = async (directory: string): Promise<number> => Object.values(await allFiles(directory)).reduce((total, text) => total + Buffer.byteLength(text), 0);
  const size = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB (${bytes.toLocaleString("en-US")} bytes)`;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-format-cli-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await mkdir(dir, { recursive: true });
    [format2, format3, format5, unversioned] = [join(dir, "old.db"), join(dir, "mid.db"), join(dir, "current.db"), join(dir, "plain.db.json")];
    await cp(join(FIXTURES, "directory-format-2"), format2, { recursive: true });
    await cp(join(FIXTURES, "directory-format-3"), format3, { recursive: true });
    await cp(join(FIXTURES, "directory-format-5"), format5, { recursive: true });
    await cp(join(FIXTURES, "file-unversioned.db.json"), unversioned);
  });

  describe("inspect", () => {
    it("says what format a database has and whether it has to be migrated, and changes nothing", async () => {
      const before = await allFiles(format2);
      const { code, stdout, stderr } = await run("inspect", format2);
      assert.deepEqual([code, stderr], [0, ""]);
      assert.equal(
        stdout,
        `Database: ${format2}\n` +
          "Storage: directory\n" +
          "Format version: 2\n" +
          "Current supported version: 5\n" +
          "Migration required: yes\n" +
          "Migration path: 2 -> 3 -> 4 -> 5\n" +
          "Tables: 4\n" +
          `Logical size: ${size(await sizeOf(format2))}\n` +
          `This build reads the database as it is and does not change it. To bring it to format 5: local-db-sandbox migrate ${format2}\n`,
      );
      assert.deepEqual(await allFiles(format2), before);
    });

    it("describes a database of the current format, and a single file that states no version", async () => {
      assert.equal(
        (await run("inspect", format5)).stdout,
        `Database: ${format5}\nStorage: directory\nFormat version: 5\nCurrent supported version: 5\nMigration required: no\nTables: 4\nLogical size: ${size(await sizeOf(format5))}\n`,
      );
      assert.match((await run("inspect", format3)).stdout, /\nFormat version: 3\nCurrent supported version: 5\nMigration required: yes\nMigration path: 3 -> 4 -> 5\n/);
      assert.equal(
        (await run("inspect", unversioned)).stdout,
        `Database: ${unversioned}\n` +
          "Storage: single file\n" +
          "Format version: 1 (not stated in the file)\n" +
          "Current supported version: 1\n" +
          "Migration required: no\n" +
          "Tables: 2\n" +
          `Logical size: ${statSync(unversioned).size} bytes\n` +
          'Note: The file states no version ("$meta"). A single-file database without one has format 1, and states it from its next save on.\n',
      );
    });

    it("prints the same as JSON with --json", async () => {
      const { code, stdout, stderr } = await run("inspect", format2, "--json");
      assert.deepEqual([code, stderr], [0, ""]);
      assert.deepEqual(JSON.parse(stdout), {
        database: format2,
        storage: "directory",
        formatVersion: 2,
        versionDeclared: true,
        minimumReaderVersion: 2,
        currentVersion: 5,
        oldestSupportedVersion: 2,
        compatibility: "older",
        readable: true,
        writable: false,
        migrationRequired: true,
        migrationPath: [2, 3, 4, 5],
        tables: 4,
        generation: 0,
        logicalSizeBytes: await sizeOf(format2),
        notes: [],
      });
      const file = JSON.parse((await run("inspect", unversioned, "--json")).stdout);
      assert.deepEqual([file.storage, file.formatVersion, file.versionDeclared, file.currentVersion, file.migrationRequired, file.migrationPath], ["file", 1, false, 1, false, []]);
    });

    it("describes a database of a format this build does not support, without failing", async () => {
      await editManifest(format5, (value) => Object.assign(value, { formatVersion: 6, minimumReaderVersion: 6 }));
      assert.deepEqual(await run("inspect", format5), {
        code: 0,
        stderr: "",
        stdout:
          `Database: ${format5}\nStorage: directory\nFormat version: 6\nCurrent supported version: 5\nMigration required: no\n` +
          "Database format 6 is newer than this build supports (max 5). Upgrade local-db-sandbox.\n",
      });
      await editManifest(format5, (value) => (value.minimumReaderVersion = 5));
      assert.match((await run("inspect", format5)).stdout, /\nFormat version: 6\nMinimum reader version: 5\nCurrent supported version: 5\nMigration required: no\nTables: 4\n.*\nDatabase format 6 is newer than this build supports \(max 5\)\. It can be read by this build, and not changed\. Upgrade local-db-sandbox\.\n$/);

      await editManifest(format2, (value) => (value.formatVersion = 1));
      assert.match(
        (await run("inspect", format2)).stdout,
        /\nFormat version: 1\nCurrent supported version: 5\nMigration required: yes\nMigration path: none in this build\nDatabase format 1 is older than this build supports \(oldest: 2\)\. Migrate it with an earlier version of local-db-sandbox, one that reads format 1, and then with this one\.\n$/,
      );
    });

    it("says what is wrong with its arguments, and with something that is not a database", async () => {
      const errors: [string[], RegExp][] = [
        [[], /^Error: Missing the database to inspect\./],
        [[format2, format5], /^Error: Expected exactly one database to inspect\./],
        [[join(dir, "missing.db")], /^Error: Database not found: /],
        [[dir], /^Error: .* is not a database directory: it has no manifest\.json\./],
        [[format2, "--max-file-size", "0"], /^Error: --max-file-size must be a number greater than 0 and at most 250\./],
        [[format2, "--nope"], /^Error: Unknown option '--nope'/],
      ];
      for (const [args, expected] of errors) {
        const { code, stdout, stderr } = await run("inspect", ...args);
        assert.deepEqual([code, stdout], [1, ""], args.join(" "));
        assert.match(stderr, expected);
        assert.match(stderr, /Run "local-db-sandbox inspect --help" for usage\.\n$/);
      }
    });
  });

  describe("migrate", () => {
    const head = (path: string): string => `Database: ${path}\nStorage: directory\nFormat version: 2\nTarget version: 5\nMigration path: 2 -> 3 -> 4 -> 5\n`;
    const changes =
      `Step 2 -> 3: ${STEP}\n` +
      '  manifest.json: formatVersion 2 -> 3; adds minimumReaderVersion 3, generation 1, and schema "schema.json"\n' +
      "  schema.json: kept as it is\n" +
      "  tables/: 4 table files kept as they are\n";
    // A later step is planned on a database that only the earlier one makes: what it changes is printed when it runs.
    const plannedStep4 = `Step 3 -> 4: ${STEP_4}\n`;
    const appliedStep4 =
      plannedStep4 +
      "  manifest.json: formatVersion 3 -> 4, minimumReaderVersion 4\n" +
      "  schema.json: kept as it is (a format 3 schema is a valid format 4 schema)\n" +
      "  tables/: 4 table files kept as they are\n";
    const plannedStep5 = `Step 4 -> 5: ${STEP_5}\n`;
    const appliedStep5 =
      plannedStep5 +
      '  manifest.json: formatVersion 4 -> 5, minimumReaderVersion 5, generation 2, schema "schema.g2.json"\n' +
      "  schema.json -> schema.g2.json: written again as a schema document of version 2\n" +
      "  tables/: 4 table files kept as they are\n";

    it("reports the current format, the target, the steps, and what they would change with --dry-run, and changes nothing", async () => {
      const before = await allFiles(format2);
      assert.deepEqual(await run("migrate", format2, "--dry-run"), { code: 0, stderr: "", stdout: `${head(format2)}${changes}${plannedStep4}${plannedStep5}Dry run: nothing was changed.\n` });
      const json = JSON.parse((await run("migrate", format2, "--dry-run", "--json")).stdout);
      assert.deepEqual(
        [json.database, json.formatVersion, json.targetVersion, json.migrationPath, json.dryRun, json.migrated, json.steps[0].status, json.steps[0].changes.length],
        [format2, 2, 5, [2, 3, 4, 5], true, false, "planned", 3],
      );
      assert.deepEqual(await allFiles(format2), before);
    });

    it("migrates to the current format and reports exactly what changed", async () => {
      const { "manifest.json": _manifest, "schema.json": _schema, ...before } = await allFiles(format2);
      assert.deepEqual(await run("migrate", format2), {
        code: 0,
        stderr: "",
        stdout:
          `${head(format2)}${changes}${appliedStep4}${appliedStep5}` +
          `Migrated ${format2} from format 2 to format 5. 4 tables (8 rows), the table definitions, and the configuration were read back from the result before it was published, and are the same as before.\n`,
      });
      // The table files are what they were; the schema file was written again, in the form of format 5.
      const { "manifest.json": manifest, "schema.g2.json": schema, ...after } = await allFiles(format2);
      assert.deepEqual(after, before);
      assert.equal(JSON.parse(schema as string).schemaVersion, 2);
      assert.deepEqual([JSON.parse(manifest as string).formatVersion, JSON.parse(manifest as string).minimumReaderVersion], [5, 5]);
      assert.match((await run("inspect", format2)).stdout, /\nFormat version: 5\nCurrent supported version: 5\nMigration required: no\n/);

      // Again: nothing to do.
      const files = await allFiles(format2);
      assert.deepEqual(await run("migrate", format2), {
        code: 0,
        stderr: "",
        stdout: `Database: ${format2}\nStorage: directory\nFormat version: 5\nTarget version: 5\nNothing to migrate: ${format2} has format 5 already.\n`,
      });
      assert.deepEqual(await allFiles(format2), files);
    });

    it("takes the target format with --to, and prints its result as JSON with --json", async () => {
      const { code, stdout } = await run("migrate", format2, "--to", "3", "--json");
      const report = JSON.parse(stdout);
      assert.deepEqual([code, report.migrated, report.dryRun, report.tables, report.rows, report.steps.length, report.steps[0].status], [0, true, false, 4, 8, 1, "applied"]);
      assert.match((await run("inspect", format2)).stdout, /\nFormat version: 3\nCurrent supported version: 5\nMigration required: yes\nMigration path: 3 -> 4 -> 5\n/);
      // From format 3, two steps remain.
      const rest = JSON.parse((await run("migrate", format3, "--json")).stdout);
      assert.deepEqual([rest.migrated, rest.migrationPath, rest.steps.map((step: { from: number; to: number }) => `${step.from}->${step.to}`)], [true, [3, 4, 5], ["3->4", "4->5"]]);
      assert.match((await run("migrate", unversioned)).stdout, /Storage: single file\nFormat version: 1\nTarget version: 1\nNothing to migrate: /);
    });

    it("refuses what it cannot do, and changes nothing then", async () => {
      await editManifest(format5, (value) => Object.assign(value, { formatVersion: 6, minimumReaderVersion: 6 }));
      const before = [await allFiles(format2), await allFiles(format5)];
      const errors: [string[], RegExp][] = [
        [[], /^Error: Missing the database to migrate\./],
        [[format2, format5], /^Error: Expected exactly one database to migrate\./],
        [[format2, "--to", "6"], /^Error: This build migrates a database directory up to format 5; it does not know format 6\./],
        [[format2, "--to", "three"], /^Error: --to must be a format version: a whole number, 1 or more\./],
        [[format2, "--to", "0"], /^Error: --to must be a format version/],
        [[format5], /^Error: .*current\.db: Database format 6 is newer than this build supports \(max 5\)\. Upgrade local-db-sandbox\.\n/],
        [[join(dir, "missing.db")], /^Error: Database not found: /],
        [[format2, "--max-file-size", "0.001"], /^Error: The database directory is [\d.]+ MB, above the limit of [\d.]+ MB, and was not loaded\./],
      ];
      for (const [args, expected] of errors) {
        const { code, stdout, stderr } = await run("migrate", ...args);
        assert.deepEqual([code, stdout], [1, ""], args.join(" "));
        assert.match(stderr, expected);
        assert.match(stderr, /Run "local-db-sandbox migrate --help" for usage\.\n$/);
      }
      assert.deepEqual([await allFiles(format2), await allFiles(format5)], before);
    });

    it("prints its usage, and both commands are listed in the main usage", async () => {
      assert.match((await run("migrate", "--help")).stdout, /^Usage: local-db-sandbox migrate <database> \[options\]\n/);
      assert.match((await run("inspect", "--help")).stdout, /^Usage: local-db-sandbox inspect <database> \[options\]\n/);
      const main = (await run("--help")).stdout;
      assert.match(main, /local-db-sandbox inspect <database> \[options\]/);
      assert.match(main, /local-db-sandbox migrate <database> \[options\]/);
    });
  });

  describe("the other commands", () => {
    const hint = /old\.db: Database format 2 is older than the format this build writes \(5\)\. It can be read as it is, and was not changed\. To change it, migrate it first: local-db-sandbox migrate .*old\.db\n/;

    it("do not start a sandbox on a database of an earlier format, and say how to migrate it; afterwards they do", async () => {
      const before = await allFiles(format2);
      const refusedStart = await run(format2, "--port", "0");
      assert.deepEqual([refusedStart.code, refusedStart.stdout], [1, ""]);
      assert.match(refusedStart.stderr, hint);
      assert.deepEqual(await allFiles(format2), before);

      assert.equal((await run("migrate", format2)).code, 0);
      const sandbox = await startSandbox({ file: format2, port: 0 });
      try {
        assert.equal(sandbox.formatNotice, undefined);
        assert.equal(((await (await fetch(`${sandbox.url}/users`)).json()) as unknown[]).length, 3);
        const created = await fetch(`${sandbox.url}/empty`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "first" }) });
        assert.equal(created.status, 201);
      } finally {
        await sandbox.stop();
      }
      assert.deepEqual(await storedRows(format2, "empty"), [{ label: "first", id: 1 }]);
    });

    it("serve a database of an earlier format that is never written to, and note its format", async () => {
      await editManifest(format2, (value) => (value.persistence = "memory"));
      const before = await allFiles(format2);
      const sandbox = await startSandbox({ file: format2, port: 0 });
      try {
        assert.equal(sandbox.saves, false);
        assert.match(sandbox.formatNotice as string, /old\.db has database format 2; this build writes format 5\. It is read as it is and not changed\. To bring it up to date: local-db-sandbox migrate .*old\.db$/);
        assert.equal((await fetch(`${sandbox.url}/empty`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 201);
      } finally {
        await sandbox.stop();
      }
      assert.deepEqual(await allFiles(format2), before);
    });

    it("open the SQL console on an earlier format only without saving, and on the migrated database as on any other", async () => {
      const before = await allFiles(format2);
      const refusedOpen = await run("sql", format2, "SELECT COUNT(*) AS n FROM users");
      assert.deepEqual([refusedOpen.code, refusedOpen.stdout], [1, ""]);
      assert.match(refusedOpen.stderr, hint);

      const readOnly = await run("sql", format2, "--read-only", "--json", "SELECT COUNT(*) AS n FROM users");
      assert.equal(readOnly.code, 0);
      assert.deepEqual(JSON.parse(readOnly.stdout).rows, [{ n: 3 }]);
      assert.match(readOnly.stderr, /^Note: .*old\.db has database format 2; this build writes format 5\. It is read as it is and not changed\./);
      assert.deepEqual(await allFiles(format2), before);

      assert.equal((await run("migrate", format2)).code, 0);
      const orders = statSync(tableFile(format2, "orders"), { bigint: true }).mtimeNs;
      const rows = await run("sql", format2, "--json", 'SELECT u.display_name AS name, COUNT(o.id) AS orders FROM users u LEFT JOIN orders o ON o."userId" = u.id GROUP BY u.id ORDER BY u.id');
      assert.deepEqual([rows.code, rows.stderr], [0, ""]);
      assert.deepEqual(
        JSON.parse(rows.stdout).rows.map((row: { orders: number }) => row.orders),
        [2, 0, 0],
      );

      // A change is saved to the table it changed, in a file of the next generation; the other tables keep their files.
      const update = await run("sql", format2, "UPDATE users SET active = 0 WHERE id = 1");
      assert.deepEqual([update.code, update.stderr], [0, ""]);
      assert.equal((await storedRows(format2, "users"))[0]?.active, false);
      // Generation 2 is the migration's, which wrote the schema file again; this save is the next.
      assert.match(tableFile(format2, "users"), /users\.g3\.json$/);
      assert.equal(statSync(tableFile(format2, "orders"), { bigint: true }).mtimeNs, orders);
      assert.match(tableFile(format2, "orders"), /orders\.json$/);
    });
  });
});
