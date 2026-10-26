import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createDatabase } from "../../storage-json/src/index.ts";
import { allFiles, schemaFile } from "../../storage-json/test/support/database-files.ts";
import { runCli } from "../src/index.ts";

const INIT = ["create type status as enum ('draft', 'live');", "create table rates (id serial primary key, rate numeric not null, state status not null default 'draft');"].join("\n");
const CHANGE = ["alter table rates rename column rate to reference_rate;", "alter table rates add column low numeric, add column high numeric not null default 0;", "alter type status add value 'archived';"].join("\n");

/** What `diff-schema` prints for the schema of INIT and the schema of INIT and CHANGE. */
const CHANGES = [
  "4 changes:",
  "  ~ column rates.rate renamed to reference_rate (0002_change.sql:1)",
  "  + enum status: value archived after live",
  "  + column rates.high numeric not null default 0",
  "  + column rates.low numeric",
];

describe("CLI: diff-schema (what differs between two schemas)", () => {
  let dir: string;
  let first: string;
  let second: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-diff-"));
    first = migrations("first", { "0001_init.sql": INIT });
    second = migrations("second", { "0001_init.sql": INIT, "0002_change.sql": CHANGE });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  }

  /** A directory of PostgreSQL migrations under the test's directory. */
  function migrations(name: string, files: Record<string, string>): string {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    for (const [file, sql] of Object.entries(files)) {
      writeFileSync(join(root, file), sql);
    }
    return root;
  }

  /** A database directory created from migrations, by `init`. */
  async function database(name: string, from: string): Promise<string> {
    const out = join(dir, name);
    const created = await run("init", from, "--out", out, "--report", join(dir, `${name}.report.json`));
    assert.equal(created.code, 0, created.stderr);
    return out;
  }

  function write(name: string, value: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  /** Every file under a path with its size and the time it was last written, and every directory. */
  function fingerprint(path: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
      const full = join(entry.parentPath, entry.name);
      const stats = statSync(full);
      found[full.slice(path.length + 1).replaceAll("\\", "/")] = entry.isDirectory() ? "directory" : `${stats.size} bytes, written ${stats.mtimeMs}`;
    }
    return found;
  }

  it("prints its help, and is listed in the general help", async () => {
    const { code, stdout } = await run("diff-schema", "--help");
    assert.equal(code, 0);
    assert.match(stdout, /^Usage: local-db-sandbox diff-schema <before> <after> \[options\]\n/);
    assert.match(stdout, /Nothing is changed/);
    assert.match(stdout, /no SQL is generated/);
    assert.match(stdout, /what is dropped\s+\(named as <before> names it\), then the renames, then what is added or changed\s+\(named as <after> names it\)/);
    assert.match(stdout, /--json/);
    const general = (await run("--help")).stdout;
    assert.match(general, /local-db-sandbox diff-schema <before> <after> \[options\]/);
    assert.match(general, /"diff-schema" says what differs between two schemas/);
  });

  it("compares the schemas of two sets of migrations: a recorded rename is a rename, and what was added is added", async () => {
    const { code, stdout, stderr } = await run("diff-schema", first, second);
    assert.deepEqual([code, stderr], [0, ""]);
    assert.equal(stdout, [`Before: ${first} (PostgreSQL migrations, 1 file)`, `After:  ${second} (PostgreSQL migrations, 2 files)`, ...CHANGES, ""].join("\n"));
  });

  it("says that there are no differences, and exits with 0 either way", async () => {
    const { code, stdout, stderr } = await run("diff-schema", second, second);
    assert.deepEqual([code, stderr], [0, ""]);
    assert.equal(stdout, [`Before: ${second} (PostgreSQL migrations, 2 files)`, `After:  ${second} (PostgreSQL migrations, 2 files)`, "No differences.", ""].join("\n"));
  });

  it("with --json prints the diff alone, as JSON that is the same bytes every time", async () => {
    const { code, stdout, stderr } = await run("diff-schema", first, second, "--json");
    assert.deepEqual([code, stderr], [0, ""]);
    const diff = JSON.parse(stdout);
    assert.equal(diff.diffVersion, 1);
    assert.deepEqual(diff.changes.map((change: { op: string }) => change.op), ["renameColumn", "addEnumValue", "addColumn", "addColumn"]);
    const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
    assert.deepEqual(diff.changes[0], {
      op: "renameColumn",
      table: "rates",
      column: "reference_rate",
      from: "rate",
      evidence: {
        origin: { name: "rate", file: "0001_init.sql", line: 2, sha256: sha256(INIT), source: "postgresql-migrations", statement: 2 },
        renames: [{ from: "rate", to: "reference_rate", at: { file: "0002_change.sql", line: 1, sha256: sha256(CHANGE), source: "postgresql-migrations", statement: 1 } }],
      },
    });
    assert.match(stdout, /^\{\n  "diffVersion": 1,\n  "changes": \[\n    \{\n      "op": "renameColumn",\n      "table": "rates",\n/);
    assert.ok(stdout.endsWith("\n}\n"));
    assert.equal((await run("diff-schema", first, second, "--json")).stdout, stdout);
    // The paths of what was compared are not part of it: a copy of the same migrations elsewhere gives the same bytes.
    assert.equal((await run("diff-schema", migrations("copy-1", { "0001_init.sql": INIT }), migrations("copy-2", { "0001_init.sql": INIT, "0002_change.sql": CHANGE }), "--json")).stdout, stdout);
    assert.equal((await run("diff-schema", first, first, "--json")).stdout, '{\n  "diffVersion": 1,\n  "changes": []\n}\n');
  });

  it("compares a database with migrations: none with those it was created from, and with later ones what they change", async () => {
    const db = await database("sandbox.db", first);
    assert.equal((await run("diff-schema", db, first)).stdout, [`Before: ${db} (database directory)`, `After:  ${first} (PostgreSQL migrations, 1 file)`, "No differences.", ""].join("\n"));
    // The rename is found: the database stores where its columns come from.
    const later = await run("diff-schema", db, second);
    assert.deepEqual([later.code, later.stderr], [0, ""]);
    assert.equal(later.stdout, [`Before: ${db} (database directory)`, `After:  ${second} (PostgreSQL migrations, 2 files)`, ...CHANGES, ""].join("\n"));
    // Two databases.
    const newer = await database("newer.db", second);
    assert.equal((await run("diff-schema", db, newer)).stdout, [`Before: ${db} (database directory)`, `After:  ${newer} (database directory)`, ...CHANGES, ""].join("\n"));
    assert.equal((await run("diff-schema", db, newer, "--json")).stdout, (await run("diff-schema", first, second, "--json")).stdout);
  });

  it("finds a project's migrations where init finds them", async () => {
    const project = join(dir, "project");
    mkdirSync(join(project, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(project, "supabase", "migrations", "0001_init.sql"), INIT);
    writeFileSync(join(project, "supabase", "migrations", "0002_change.sql"), CHANGE);
    const { code, stdout } = await run("diff-schema", first, project);
    assert.equal(code, 0);
    assert.equal(stdout, [`Before: ${first} (PostgreSQL migrations, 1 file)`, `After:  ${project} (PostgreSQL migrations, 2 files)`, ...CHANGES, ""].join("\n"));
  });

  it("compares a schema file: a database's own, and a copy that was changed by hand", async () => {
    const db = await database("sandbox.db", second);
    const document = JSON.parse(readFileSync(schemaFile(db), "utf8"));
    const copy = write("schema-copy.json", document);
    assert.equal((await run("diff-schema", db, copy)).stdout, [`Before: ${db} (database directory)`, `After:  ${copy} (schema file)`, "No differences.", ""].join("\n"));

    const rates = document.tables[0];
    rates.columns.find((column: { column: string }) => column.column === "low").canonicalType = { kind: "decimal", precision: 12, scale: 2 };
    rates.columns.find((column: { column: string }) => column.column === "high").nullable = true;
    rates.columns.push({ column: "note", type: "text", canonicalType: { kind: "text" } });
    rates.indexes = [{ name: "rates_note_idx", columns: ["note"] }];
    document.types.enums[0].values.push("gone");
    document.tables.push({ name: "audit", columns: [{ column: "id", type: "integer", primaryKey: true, canonicalType: { kind: "integer", bits: 64 } }] });
    const changed = write("schema-changed.json", document);
    const { code, stdout, stderr } = await run("diff-schema", db, changed);
    assert.deepEqual([code, stderr], [0, ""]);
    assert.equal(
      stdout,
      [
        `Before: ${db} (database directory)`,
        `After:  ${changed} (schema file)`,
        "6 changes:",
        "  + enum status: value gone after archived",
        "  + table audit (1 column, primary key (id))",
        "  + column rates.note text",
        "  ~ column rates.low: type numeric -> numeric(12,2)",
        "  ~ column rates.high: nullable",
        "  + index rates_note_idx on rates (note)",
        "",
      ].join("\n"),
    );
  });

  it("compares a single-file database by the table definitions it stores", async () => {
    const users = (...columns: object[]): object => ({ schemaVersion: 1, tables: [{ name: "users", columns: [{ column: "id", type: "integer", primaryKey: true }, { column: "name", type: "text" }, ...columns] }] });
    const file = write("app.db.json", { $meta: { version: 1 }, $tableSchema: users(), data: { users: [{ id: 1, name: "Ann" }] } });
    const wider = write("wider.schema.json", users({ column: "email", type: "text", nullable: false }));
    assert.equal((await run("diff-schema", file, wider)).stdout, [`Before: ${file} (single-file database)`, `After:  ${wider} (schema file)`, "1 change:", "  + column users.email text not null", ""].join("\n"));
  });

  it("changes neither side: every file of both is as it was, and none is added", async () => {
    const db = await database("sandbox.db", first);
    const copy = write("schema-copy.json", readFileSync(schemaFile(db), "utf8"));
    const file = write("app.db.json", { $tableSchema: { schemaVersion: 1, tables: [{ name: "users", columns: [{ column: "id", type: "integer", primaryKey: true }] }] }, data: { users: [] } });
    const before = { db: fingerprint(db), second: fingerprint(second), dir: fingerprint(dir), files: await allFiles(dir) };
    for (const [a, b] of [[db, second], [second, db], [copy, db], [db, file], [file, second]] as const) {
      assert.equal((await run("diff-schema", a, b)).code, 0);
      assert.equal((await run("diff-schema", a, b, "--json")).code, 0);
    }
    assert.deepEqual({ db: fingerprint(db), second: fingerprint(second), dir: fingerprint(dir), files: await allFiles(dir) }, before);
  });

  it("reads a database of an earlier format as it is, with a note, and does not change it", async () => {
    const fixtures = join(import.meta.dirname, "../../storage-json/test/fixtures/formats");
    const [format2, format3, format4, format5] = [join(dir, "two.db"), join(dir, "three.db"), join(dir, "four.db"), join(dir, "five.db")];
    cpSync(join(fixtures, "directory-format-2"), format2, { recursive: true });
    cpSync(join(fixtures, "directory-format-3"), format3, { recursive: true });
    cpSync(join(fixtures, "directory-format-4"), format4, { recursive: true });
    cpSync(join(fixtures, "directory-format-5"), format5, { recursive: true });
    const before = [fingerprint(format2), fingerprint(format3), fingerprint(format4), fingerprint(format5)];

    // The table definitions of format 3 are in a file named after a save's generation; the manifest says which.
    const same = await run("diff-schema", format3, format5);
    assert.equal(same.code, 0);
    assert.equal(same.stdout, [`Before: ${format3} (database directory)`, `After:  ${format5} (database directory)`, "No differences.", ""].join("\n"));
    assert.match(same.stderr, /^Note: <before>: .*three\.db has database format 3; this build writes format 5\. It is read as it is and not changed\. To bring it up to date: local-db-sandbox migrate .*three\.db"?\n$/);
    // The note is about the side that has the older format, whichever it is.
    assert.match((await run("diff-schema", format5, format3)).stderr, /^Note: <after>: .*three\.db has database format 3;/);
    // Format 4 is an earlier format too, one step back; and it holds what format 5 holds of this database.
    const fourAndFive = await run("diff-schema", format4, format5);
    assert.equal(fourAndFive.stdout, [`Before: ${format4} (database directory)`, `After:  ${format5} (database directory)`, "No differences.", ""].join("\n"));
    assert.match(fourAndFive.stderr, /^Note: <before>: .*four\.db has database format 4; this build writes format 5\./);

    // Format 2 did not keep how a column's type was declared. Without canonical types, the diff says that it compared spellings.
    const declared = await run("diff-schema", format2, format3);
    assert.equal(declared.code, 0);
    assert.match(declared.stdout, /\n9 changes:\n {2}~ column orders\.id: declared type none -> int \(compared as declared\)\n/);
    assert.match(declared.stdout, /\n {2}~ column users\.active: declared type none -> boolean \(compared as declared\)\n/);
    assert.deepEqual([fingerprint(format2), fingerprint(format3), fingerprint(format4), fingerprint(format5)], before);
  });

  it("notes on stderr when the collector did not support a statement of the migrations, and compares what it collected", async () => {
    const withView = migrations("with-view", { "0001_init.sql": INIT, "0002_view.sql": "create view live_rates as select * from rates;\nupdate rates set rate = 1;" });
    const { code, stdout, stderr } = await run("diff-schema", first, withView, "--json");
    assert.equal(code, 0);
    assert.equal(stdout, '{\n  "diffVersion": 1,\n  "changes": []\n}\n');
    assert.equal(stderr, `Note: <after>: ${withView}: 2 statements of these migrations are unsupported by the collector, so the schema it collected may differ from PostgreSQL's there. "local-db-sandbox init" lists them.\n`);
    assert.match((await run("diff-schema", withView, withView)).stderr, /^Note: <before>: .*with-view: 2 statements .*\nNote: <after>: .*with-view: 2 statements .*\n$/);
  });

  it("says what is wrong with its arguments", async () => {
    const usage = '\nRun "local-db-sandbox diff-schema --help" for usage.\n';
    assert.deepEqual(await run("diff-schema"), { code: 1, stdout: "", stderr: `Error: Missing the two schemas to compare: <before> and <after>.${usage}` });
    assert.deepEqual(await run("diff-schema", first), { code: 1, stdout: "", stderr: `Error: Missing the schema to compare with: <after>.${usage}` });
    assert.deepEqual(await run("diff-schema", first, second, first), { code: 1, stdout: "", stderr: `Error: Expected exactly two schemas to compare: <before> and <after>.${usage}` });
    assert.match((await run("diff-schema", first, second, "--sql")).stderr, /^Error: Unknown option '--sql'/);
    assert.deepEqual(await run("diff-schema", first, second, "--max-file-size", "0"), { code: 1, stdout: "", stderr: `Error: --max-file-size must be a number greater than 0 and at most 250.${usage}` });
  });

  it("says what is wrong with what it is given, and prints no diff", async () => {
    const failure = async (path: string): Promise<string> => {
      const { code, stdout, stderr } = await run("diff-schema", first, path);
      assert.deepEqual([code, stdout], [1, ""], stderr);
      return stderr.split("\n")[0] ?? "";
    };
    const noMigrations = "it has no .sql files, and neither has supabase/migrations, migrations, db/migrations, database/migrations, sql/migrations under it";
    const missing = join(dir, "nowhere");
    assert.equal(await failure(missing), `Error: <after>: ${missing} does not exist.`);

    const empty = join(dir, "empty");
    mkdirSync(empty);
    assert.equal(await failure(empty), `Error: <after>: ${empty} is neither a database directory (it has no manifest.json), nor PostgreSQL migrations (${noMigrations}), nor TypeORM entities (no file in it declares one).`);

    const text = write("notes.txt", "not json");
    assert.equal(await failure(text), `Error: <after>: ${text} is not valid JSON. A file to compare is a single-file database, a schema file, or a file of TypeORM entities.`);
    const list = write("list.json", [1, 2]);
    assert.equal(await failure(list), `Error: <after>: ${list} is neither a single-file database (an object with "data") nor a schema file (an object with a "tables" list).`);

    const plain = write("plain.db.json", { data: { users: [{ id: 1 }] } });
    assert.equal(await failure(plain), `Error: <after>: ${plain} stores no table definitions, so there is nothing to compare. A schema diff reads declared definitions; it does not work them out from rows.`);

    const broken = write("broken.schema.json", { schemaVersion: 1, tables: [{ name: "t", columns: [{ column: "id", type: "serial" }] }] });
    assert.match(await failure(broken), /^Error: <after>: .*broken\.schema\.json: column "id" of table "t" has the type "serial"; expected one of integer, real, /);

    // A migration is named by where its file is, so that it is found whichever side it is on.
    const unparsable = migrations("unparsable", { "0001_init.sql": INIT, "0002_broken.sql": "\nalter tabel rates add column x int;" });
    assert.equal(await failure(unparsable), `Error: <after>: ${join(unparsable, "0002_broken.sql")}:2:7: PostgreSQL cannot parse this migration: syntax error at or near "tabel".`);
    const refused = migrations("refused", { "0001_init.sql": INIT, "0002_refused.sql": "alter table missing add column x int;" });
    assert.equal(await failure(refused), `Error: <after>: ${join(refused, "0002_refused.sql")}:1: relation "missing" does not exist.`);

    // What the message says is left as it is, whatever it has in it that looks like a path.
    const slashes = migrations("slashes", { "0001_init.sql": INIT, "0002_slashes.sql": 'alter table "a/../b\\c" add column x int;' });
    assert.equal(await failure(slashes), `Error: <after>: ${join(slashes, "0002_slashes.sql")}:1: relation "a/../b\\c" does not exist.`);

    // One file of migrations is not a schema: they are compared as a whole.
    const oneFile = join(first, "0001_init.sql");
    assert.equal(await failure(oneFile), `Error: <after>: ${oneFile} is one migration file. Migrations are read as a whole: give the directory that holds them (${first}).`);

    // The side that could not be read is named: here the first.
    const reversed = await run("diff-schema", missing, first);
    assert.deepEqual([reversed.code, reversed.stdout, reversed.stderr.split("\n")[0]], [1, "", `Error: <before>: ${missing} does not exist.`]);
  });

  it("tells a database directory from a project that has a manifest.json of its own", async () => {
    // A web application's manifest is no database's: the project is read for its migrations.
    const project = join(dir, "project");
    mkdirSync(join(project, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(project, "manifest.json"), JSON.stringify({ name: "App", icons: [] }));
    writeFileSync(join(project, "supabase", "migrations", "0001_init.sql"), INIT);
    const read = await run("diff-schema", first, project);
    assert.deepEqual([read.code, read.stderr], [0, ""]);
    assert.equal(read.stdout, [`Before: ${first} (PostgreSQL migrations, 1 file)`, `After:  ${project} (PostgreSQL migrations, 1 file)`, "No differences.", ""].join("\n"));

    const failure = async (path: string): Promise<string> => {
      const { code, stdout, stderr } = await run("diff-schema", first, path);
      assert.deepEqual([code, stdout], [1, ""], stderr);
      return stderr.split("\n")[0] ?? "";
    };
    const other = join(dir, "other");
    mkdirSync(other);
    writeFileSync(join(other, "manifest.json"), JSON.stringify({ name: "App" }));
    assert.equal(
      await failure(other),
      `Error: <after>: ${other} is neither a database directory (its manifest.json states no "formatVersion", so it is not a database's), nor PostgreSQL migrations (it has no .sql files, and neither has supabase/migrations, migrations, db/migrations, database/migrations, sql/migrations under it), nor TypeORM entities (no file in it declares one).`,
    );

    // A manifest that cannot be read at all may be a damaged database's: the storage says what is wrong with it.
    const damaged = join(dir, "damaged.db");
    cpSync(await database("whole.db", first), damaged, { recursive: true });
    writeFileSync(join(damaged, "manifest.json"), "{ not json");
    assert.equal(await failure(damaged), `Error: <after>: ${join(damaged, "manifest.json")} is not valid JSON.`);
    // The path is not said twice when it was given in another spelling than the storage's.
    assert.equal(await failure(damaged.replaceAll("\\", "/")), `Error: <after>: ${join(damaged, "manifest.json")} is not valid JSON.`);
  });

  it("compares a database that holds enumerated types and no table", async () => {
    const onlyTypes = migrations("only-types", { "0001_types.sql": "create type status as enum ('draft', 'live');" });
    const moreValues = migrations("more-values", { "0001_types.sql": "create type status as enum ('draft', 'live');", "0002_more.sql": "alter type status add value 'archived';" });
    // "init" makes no database without a table; one that is made in code may hold types alone.
    const db = join(dir, "types.db");
    await createDatabase(db, { collections: {}, schema: [], types: { enums: [{ name: "status", values: ["draft", "live"] }] } }, { format: "directory" });
    const same = await run("diff-schema", db, onlyTypes);
    assert.deepEqual([same.code, same.stderr], [0, ""]);
    assert.equal(same.stdout, [`Before: ${db} (database directory)`, `After:  ${onlyTypes} (PostgreSQL migrations, 1 file)`, "No differences.", ""].join("\n"));
    const later = await run("diff-schema", db, moreValues);
    assert.deepEqual([later.code, later.stderr], [0, ""]);
    assert.match(later.stdout, /\n1 change:\n {2}\+ enum status: value archived after live\n$/);
  });

  it("applies the size limit before it reads a database or a schema file", async () => {
    const db = await database("sandbox.db", first);
    const big = write("big.schema.json", { schemaVersion: 1, tables: [{ name: "t", columns: [{ column: "id", type: "integer", default: "x".repeat(2 * 1024 * 1024) }] }] });
    const refusedFile = await run("diff-schema", db, big, "--max-file-size", "1");
    assert.deepEqual([refusedFile.code, refusedFile.stdout], [1, ""]);
    assert.match(refusedFile.stderr, /^Error: <after>: .*big\.schema\.json is 2\.00 MB \(2,097,\d{3} bytes\), above the limit of 1 MB, and was not read\./);
    const refusedDatabase = await run("diff-schema", db, first, "--max-file-size", "0.0001");
    assert.deepEqual([refusedDatabase.code, refusedDatabase.stdout], [1, ""]);
    // What the storage says does not name the database, so the path is put before it.
    assert.match(refusedDatabase.stderr, /^Error: <before>: .*sandbox\.db: The database directory is .* above the limit of .*, and was not loaded\./);
  });
});
