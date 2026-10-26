import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { runCli } from "../src/index.ts";
import { databaseFiles, storedRows } from "../../storage-json/test/support/database-files.ts";

const DOCUMENT = {
  $meta: { version: 1 },
  $config: { server: { port: 4999 } },
  data: {
    users: [
      { id: 1, name: "Ada" },
      { id: 2, name: "Bo" },
    ],
    orders: [{ id: 10, userId: 1, total: 30 }],
    empty: [],
  },
};
const TEXT = `${JSON.stringify(DOCUMENT, null, 2)}\n`;

describe("convert command", () => {
  let dir: string;
  let file: string;
  let directory: string;

  const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["convert", ...args], { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  };
  const names = async (): Promise<string[]> => (await readdir(directory, { recursive: true })).map((name) => name.replaceAll("\\", "/")).sort();
  const json = async (path: string): Promise<any> => JSON.parse(await readFile(path, "utf8"));

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-convert-cli-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    file = join(dir, "sandbox.db.json");
    directory = join(dir, "sandbox.db");
    await writeFile(file, TEXT);
  });

  it("converts a single file into a directory, and leaves the file as it was", async () => {
    const { code, stdout, stderr } = await run([file, "--out", directory]);
    assert.deepEqual([code, stderr], [0, ""]);
    assert.equal(
      stdout,
      `Converted ${file} (single file) to ${directory} (directory).\n` +
        "  tables: 3 (3 rows)\n" +
        "  table definitions: none stored; tables are described from their rows when the database is opened\n" +
        "The original was not changed.\n",
    );
    assert.deepEqual(await names(), ["manifest.json", "schema.json", "tables", "tables/empty.json", "tables/orders.json", "tables/users.json"]);
    assert.deepEqual(await json(join(directory, "manifest.json")), {
      formatVersion: 5,
      minimumReaderVersion: 5,
      database: "sandbox",
      persistence: "json",
      config: DOCUMENT.$config,
      generation: 1,
      schema: "schema.json",
      tables: [
        { name: "users", file: "users.json" },
        { name: "orders", file: "orders.json" },
        { name: "empty", file: "empty.json" },
      ],
    });
    assert.deepEqual(await json(join(directory, "tables/users.json")), DOCUMENT.data.users);
    assert.equal(await readFile(file, "utf8"), TEXT);
  });

  it("converts a directory into a single file, and back to the same bytes", async () => {
    await run([file, "--out", directory]);
    const back = join(dir, "back.db.json");
    const { code, stdout, stderr } = await run([directory, "-o", back]);
    assert.deepEqual([code, stderr], [0, ""]);
    assert.match(stdout, /^Converted .*sandbox\.db \(directory\) to .*back\.db\.json \(single file\)\.\n {2}tables: 3 \(3 rows\)\n/);
    assert.equal(await readFile(back, "utf8"), TEXT);
  });

  it("stores the table definitions of TypeORM entities with --entities", async () => {
    const entities = join(import.meta.dirname, "../../import-typeorm/test/fixtures/blog");
    await writeFile(file, JSON.stringify({ data: { post_categories: [{ code: "news", label: "News" }], users: [], post: [], notes: [{ text: "kept" }] } }));
    const { code, stdout, stderr } = await run([file, "--out", directory, "--entities", entities]);
    assert.deepEqual([code, stderr], [0, ""]);
    assert.ok(stdout.includes(`\n  tables: 4 (2 rows)\n  table definitions: 3, from the TypeORM entities in ${entities}\n`), stdout);

    const schema = await json(join(directory, "schema.json"));
    assert.deepEqual(schema.tables.map((table: { name: string }) => table.name).sort(), ["post", "post_categories", "users"]);
    assert.deepEqual(schema.tables.find((table: { name: string }) => table.name === "post_categories").columns, [
      { column: "code", property: "code", type: "text", declaredType: "varchar", nullable: false, primaryKey: true },
      { column: "label", property: "label", type: "text", declaredType: "String", nullable: false, primaryKey: false },
    ]);
    assert.deepEqual(await json(join(directory, "tables/post_categories.json")), [{ code: "news", label: "News" }]);
    assert.deepEqual(await json(join(directory, "tables/notes.json")), [{ text: "kept" }]);

    // Back in a single file, the definitions travel with it.
    const back = join(dir, "back.db.json");
    assert.match((await run([directory, "--out", back])).stdout, /\n {2}table definitions: 3, as stored in .*sandbox\.db\n/);
    // A single file's schema document is of version 1, as it has always been.
    assert.deepEqual((await json(back)).$tableSchema, { ...schema, schemaVersion: 1 });
  });

  it("does not replace a database that is already there, unless told to", async () => {
    await run([file, "--out", directory]);
    await writeFile(file, JSON.stringify({ data: { users: [{ id: 5, name: "Only" }] } }));

    const refused = await run([file, "--out", directory]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^Error: .*sandbox\.db already exists\. Use --force to replace it\.\n/);
    assert.equal((await json(join(directory, "tables/users.json"))).length, 2);

    assert.equal((await run([file, "--out", directory, "--force"])).code, 0);
    assert.deepEqual(Object.keys(await databaseFiles(directory)), ["manifest.json", "schema.json", "tables/users.json"]);
    assert.deepEqual(await storedRows(directory, "users"), [{ id: 5, name: "Only" }]);
  });

  it("never writes into a folder that is not a database", async () => {
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src/main.ts"), "// someone's project");
    const { code, stderr } = await run([file, "--out", directory, "--force"]);
    assert.equal(code, 1);
    assert.match(stderr, /^Error: .*sandbox\.db exists and is not a database directory\./);
    assert.deepEqual(await names(), ["src", "src/main.ts"]);
  });

  it("refuses a database above the size limit", async () => {
    await writeFile(file, JSON.stringify({ data: { users: [{ id: 1, name: "x".repeat(4000) }] } }));
    const { code, stderr } = await run([file, "--out", directory, "--max-file-size", "0.002"]);
    assert.equal(code, 1);
    assert.match(stderr, /^Error: The database file is [\d.]+ MB, above the limit of [\d.]+ MB, and was not loaded\./);
    assert.deepEqual(await readdir(dir), ["sandbox.db.json"]);
  });

  it("says what is wrong with its arguments", async () => {
    const errors: [string[], RegExp][] = [
      [[], /^Error: Missing the database to convert\./],
      [[file], /^Error: Missing --out: the path to write the converted database to\./],
      [[file, directory, "--out", directory], /^Error: Expected exactly one database to convert\./],
      [[file, "--out", join(dir, "copy.json")], /is a single-file database already; give a directory path to convert it to/],
      [[join(dir, "missing.db"), "--out", file], /^Error: Database not found: /],
      [[file, "--out", directory, "--entities", "x", "--no-entities"], /^Error: --entities and --no-entities cannot be used together\./],
      [[file, "--out", directory, "--max-file-size", "0"], /^Error: --max-file-size must be a number greater than 0 and at most 250\./],
      [[file, "--out", directory, "--nope"], /^Error: Unknown option '--nope'/],
    ];
    for (const [args, expected] of errors) {
      const { code, stdout, stderr } = await run(args);
      assert.deepEqual([code, stdout], [1, ""], args.join(" "));
      assert.match(stderr, expected);
      assert.match(stderr, /Run "local-db-sandbox convert --help" for usage\.\n$/);
    }
    assert.deepEqual(await readdir(dir), ["sandbox.db.json"]);
  });

  it("prints its usage, and is listed in the main usage", async () => {
    const usage = await run(["--help"]);
    assert.equal(usage.code, 0);
    assert.match(usage.stdout, /^Usage: local-db-sandbox convert <database> --out <path> \[options\]\n/);
    assert.match(usage.stdout, /convert sandbox\.db\.json --out sandbox\.db /);
    assert.match(usage.stdout, /convert sandbox\.db --out sandbox\.db\.json /);

    let main = "";
    await runCli(["--help"], { stdout: { write: (text) => (main += text) }, stderr: { write: () => undefined }, signals: new EventEmitter() });
    assert.match(main, /local-db-sandbox convert <database> --out <path>/);
  });
});
