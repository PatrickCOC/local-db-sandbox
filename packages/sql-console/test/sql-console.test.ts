import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { TableSchema } from "../../runtime/src/index.ts";
import { createDatabase } from "../../storage-json/src/index.ts";
import { databaseFiles, tableFile } from "../../storage-json/test/support/database-files.ts";
import { SqlConsole, hasSql, inferTableSchema, splitStatements } from "../src/index.ts";

describe("splitStatements", () => {
  it("splits at semicolons and keeps the unfinished rest", () => {
    assert.deepEqual(splitStatements("SELECT 1; SELECT 2 ;\nSELECT 3"), { statements: ["SELECT 1", "SELECT 2"], rest: "\nSELECT 3" });
    assert.deepEqual(splitStatements(";;  ;"), { statements: [], rest: "" });
  });

  it("does not split inside strings, quoted names, or comments", () => {
    const text = `INSERT INTO t VALUES ('a;b', 'it''s; fine', "c;d", [e;f], \`g;h\`); -- one; two\n/* three; */ SELECT 2;`;
    assert.deepEqual(splitStatements(text).statements, [`INSERT INTO t VALUES ('a;b', 'it''s; fine', "c;d", [e;f], \`g;h\`)`, "-- one; two\n/* three; */ SELECT 2"]);
    assert.deepEqual(splitStatements("SELECT 'unfinished; string"), { statements: [], rest: "SELECT 'unfinished; string" });
  });

  it("tells SQL from space and comments", () => {
    assert.equal(hasSql("  -- only a comment\n /* and another */ "), false);
    assert.equal(hasSql("-- comment\nSELECT 1"), true);
  });
});

describe("inferTableSchema", () => {
  const types = (rows: Record<string, unknown>[]): unknown => Object.fromEntries(inferTableSchema("t", rows).columns.map((column) => [column.name, column.type]));

  it("takes one column per key, typed from the values that are there", () => {
    assert.deepEqual(
      types([
        { id: 1, name: "a", active: true, price: 1, tags: ["x"], meta: null, mixed: 1, flag: true },
        { id: 2, name: null, active: false, price: 2.5, tags: [], extra: { a: 1 }, mixed: "one", flag: "yes" },
      ]),
      { id: "integer", name: "text", active: "boolean", price: "real", tags: "json", meta: "any", mixed: "any", flag: "json", extra: "json" },
    );
  });

  it("uses id as the key only when every row has a different one", () => {
    const key = (rows: Record<string, unknown>[]): unknown => inferTableSchema("t", rows).columns.filter((column) => column.primary).map((column) => [column.name, column.autoIncrement ?? false]);
    assert.deepEqual(key([{ id: 1 }, { id: 2 }]), [["id", true]]);
    assert.deepEqual(key([{ id: "a" }, { id: "b" }]), [["id", false]]);
    assert.deepEqual(key([{ id: 1 }, { id: 1 }]), []);
    assert.deepEqual(key([{ id: 1 }, { name: "no id" }]), []);
    assert.deepEqual(key([{ code: "x" }]), []);
  });

  it("gives an empty collection a generated integer id and nothing else", () => {
    assert.deepEqual(inferTableSchema("empty", []), { name: "empty", columns: [{ name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true }] });
  });
});

describe("SqlConsole", () => {
  let dir: string;
  let file: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-console-"));
    file = join(dir, "db.json");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses given table definitions, and the data for collections they do not cover", async () => {
    const schema: TableSchema[] = [
      {
        name: "users",
        columns: [
          { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
          { name: "display_name", key: "displayName", type: "text", nullable: false, primary: false },
          { name: "createdAt", type: "datetime", nullable: true, primary: false },
        ],
      },
    ];
    await writeFile(file, JSON.stringify({ data: { users: [], notes: [{ text: "hello" }] } }));
    const sqlConsole = await SqlConsole.open({ file, schema });

    assert.deepEqual(sqlConsole.tables(), [
      { name: "users", rows: 0, source: "given" },
      { name: "notes", rows: 1, source: "data" },
    ]);
    // The empty collection is usable, because its columns are known.
    assert.equal(sqlConsole.execute("INSERT INTO users (display_name, createdAt) VALUES ('Ada', '2026-01-02 03:04:05.000')").kind, "write");
    assert.equal(sqlConsole.close(), false);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).data, {
      users: [{ id: 1, displayName: "Ada", createdAt: "2026-01-02T03:04:05.000Z" }],
      notes: [{ text: "hello" }],
    });
  });

  it("answers TO_CHAR for dates, from rows whose table is described by its data, and says what it does not format", async () => {
    await writeFile(file, JSON.stringify({ data: { orders: [{ id: 1, placedAt: "2026-01-02 03:04:05" }, { id: 2, placedAt: "2026-01-20T10:00:00.000Z" }, { id: 3, placedAt: "2026-02-01" }, { id: 4, placedAt: null }] } }));
    const sqlConsole = await SqlConsole.open({ file, readOnly: true });

    const monthly = sqlConsole.execute("SELECT TO_CHAR(placedAt, 'YYYY-MM') AS month, COUNT(*) AS orders FROM orders GROUP BY TO_CHAR(placedAt, 'YYYY-MM') ORDER BY 1");
    assert.deepEqual(monthly.kind === "rows" ? monthly.rows : monthly, [{ month: null, orders: 1 }, { month: "2026-01", orders: 2 }, { month: "2026-02", orders: 1 }]);
    const time = sqlConsole.execute("SELECT to_char(placedAt, 'DD/MM/YYYY HH24:MI') AS at FROM orders WHERE id = 2");
    assert.deepEqual(time.kind === "rows" ? time.rows : time, [{ at: "20/01/2026 10:00" }]);

    const refused = sqlConsole.execute("SELECT TO_CHAR(placedAt, 'Month') FROM orders");
    assert.deepEqual(refused.kind === "error" ? [refused.code, /^TO_CHAR: the pattern "Month" in the format "Month" is not supported\./.test(refused.message)] : refused, ["SANDBOX_DIALECT_UNSUPPORTED", true]);
    const number = sqlConsole.execute("SELECT TO_CHAR(id, '999') FROM orders");
    assert.deepEqual(number.kind === "error" ? [number.code, /formatting a number \(1\) is not supported/.test(number.message)] : number, ["SANDBOX_DIALECT_UNSUPPORTED", true]);
    sqlConsole.close();
  });

  it("returns failures instead of throwing, with a code", async () => {
    await writeFile(file, JSON.stringify({ data: { users: [{ id: 1 }] } }));
    const sqlConsole = await SqlConsole.open({ file, readOnly: true });
    const codes = ["SELEC 1", "DELETE FROM users", "SELECT * FROM users"].map((sql) => {
      const result = sqlConsole.execute(sql);
      return result.kind === "error" ? result.code : result.kind;
    });
    assert.deepEqual(codes, ["SANDBOX_DIALECT_UNSUPPORTED", "SANDBOX_READ_ONLY", "rows"]);
    sqlConsole.close();
  });
});

describe("SqlConsole and the table definitions stored with a database", () => {
  const USERS: TableSchema = {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true, generated: "increment" },
      { name: "display_name", key: "displayName", type: "text", nullable: false, primary: false },
    ],
  };
  const USERS_WITH_EMAIL: TableSchema = { name: "users", columns: [...USERS.columns, { name: "email", type: "text", nullable: true, primary: false }] };
  let dir: string;
  let directory: string;

  /** A file of the directory, by what it is: `schema.json`, or `tables/<table>.json`. */
  const json = async (path: string): Promise<any> => JSON.parse((await databaseFiles(directory))[path] as string);
  const declared = async (): Promise<string[][]> => (await json("schema.json")).tables.map((table: { name: string; columns: { column: string }[] }) => [table.name, ...table.columns.map((column) => column.column)]);
  /** Fails the test when the console asks for definitions it should not need. */
  const neverAsked = (): never => {
    throw new Error("the console asked for table definitions");
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-console-dir-"));
    directory = join(dir, "sandbox.db");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("uses the definitions of a directory database, without asking for others", async () => {
    await createDatabase(directory, { collections: { users: [], notes: [{ text: "hello" }] }, schema: [USERS] });
    const sqlConsole = await SqlConsole.open({ file: directory, fallbackSchema: neverAsked });

    assert.deepEqual(sqlConsole.tables(), [
      { name: "users", rows: 0, source: "stored" },
      { name: "notes", rows: 1, source: "data" },
    ]);
    // The empty table is usable: its columns are known from schema.json alone.
    assert.equal(sqlConsole.execute("INSERT INTO users (display_name) VALUES ('Ada')").kind, "write");
    sqlConsole.close();

    assert.deepEqual(await json("tables/users.json"), [{ id: 1, displayName: "Ada" }]);
    assert.deepEqual(await json("tables/notes.json"), [{ text: "hello" }]);
    // What was worked out from the rows of "notes" is not written down as its definition.
    assert.deepEqual(await declared(), [["users", "id", "display_name"]]);
  });

  it("writes the file of the table a statement changed, and leaves the files of the others as they are", async () => {
    const tags: TableSchema = { name: "tags", columns: [{ name: "label", type: "text", nullable: false, primary: true }] };
    await createDatabase(directory, { collections: { users: [], tags: [{ label: "kept" }] }, schema: [USERS, tags] });
    const identity = (table: string): string => {
      const stats = statSync(tableFile(directory, table), { bigint: true });
      return `${tableFile(directory, table)}:${stats.ino}:${stats.mtimeNs}`;
    };
    const before = { users: identity("users"), tags: identity("tags") };

    const sqlConsole = await SqlConsole.open({ file: directory });
    sqlConsole.execute("INSERT INTO users (display_name) VALUES ('Ada')");
    assert.deepEqual([identity("tags"), identity("users") === before.users], [before.tags, false]);
    // A transaction that is rolled back writes nothing.
    const afterInsert = identity("users");
    sqlConsole.execute("BEGIN");
    sqlConsole.execute("DELETE FROM tags");
    sqlConsole.execute("ROLLBACK");
    sqlConsole.execute("SELECT * FROM users");
    sqlConsole.close();

    assert.deepEqual({ users: identity("users"), tags: identity("tags") }, { users: afterInsert, tags: before.tags });
    assert.deepEqual([await json("tables/users.json"), await json("tables/tags.json")], [[{ id: 1, displayName: "Ada" }], [{ label: "kept" }]]);
  });

  it("asks for definitions when the database stores none, and stores them with the next save", async () => {
    await createDatabase(directory, { collections: { users: [] } });
    let asked = 0;
    const sqlConsole = await SqlConsole.open({
      file: directory,
      fallbackSchema: () => {
        asked += 1;
        return [USERS];
      },
    });
    assert.equal(asked, 1);
    assert.deepEqual(sqlConsole.tables(), [{ name: "users", rows: 0, source: "given" }]);
    // Opening a database does not write to it.
    assert.deepEqual(await declared(), []);

    assert.equal(sqlConsole.execute("INSERT INTO users (display_name) VALUES ('Ada')").kind, "write");
    sqlConsole.close();
    assert.deepEqual(await declared(), [["users", "id", "display_name"]]);

    // From then on the directory describes itself.
    const reopened = await SqlConsole.open({ file: directory, fallbackSchema: neverAsked });
    assert.deepEqual(reopened.tables(), [{ name: "users", rows: 1, source: "stored" }]);
    reopened.close();
  });

  it("describes a table from its rows when nobody has a definition for it", async () => {
    await createDatabase(directory, { collections: { users: [{ id: 1, name: "Ada" }] } });
    const sqlConsole = await SqlConsole.open({ file: directory, fallbackSchema: () => undefined });
    assert.deepEqual(sqlConsole.tables(), [{ name: "users", rows: 1, source: "data" }]);
    sqlConsole.execute("UPDATE users SET name = 'Adah'");
    sqlConsole.close();
    assert.deepEqual([await json("tables/users.json"), await declared()], [[{ id: 1, name: "Adah" }], []]);
  });

  it("takes definitions it is given over the stored ones of the same tables, and stores them with the next save", async () => {
    const tags: TableSchema = { name: "tags", columns: [{ name: "label", type: "text", nullable: false, primary: true }] };
    await createDatabase(directory, { collections: { users: [{ id: 1, displayName: "Ada" }], tags: [] }, schema: [USERS, tags] });
    const sqlConsole = await SqlConsole.open({ file: directory, schema: [USERS_WITH_EMAIL], fallbackSchema: neverAsked });
    // "tags" was not given again: its stored definition still applies.
    assert.deepEqual(sqlConsole.tables(), [
      { name: "users", rows: 1, source: "given" },
      { name: "tags", rows: 0, source: "stored" },
    ]);
    assert.equal(sqlConsole.replacesStoredSchema, true);
    assert.deepEqual(await declared(), [["users", "id", "display_name"], ["tags", "label"]]);

    assert.equal(sqlConsole.execute("UPDATE users SET email = 'ada@example.test'").kind, "write");
    assert.equal(sqlConsole.execute("INSERT INTO tags (label) VALUES ('new')").kind, "write");
    sqlConsole.close();
    assert.deepEqual(await json("tables/users.json"), [{ id: 1, displayName: "Ada", email: "ada@example.test" }]);
    assert.deepEqual(await declared(), [["users", "id", "display_name", "email"], ["tags", "label"]]);

    // Given the same definitions as the stored ones, nothing is replaced.
    const same = await SqlConsole.open({ file: directory, schema: [USERS_WITH_EMAIL] });
    assert.equal(same.replacesStoredSchema, false);
    same.close();
  });

  it("does not save to a database that declares memory persistence, unless told to", async () => {
    await createDatabase(directory, { collections: { users: [] }, schema: [USERS], persistence: "memory" });
    const before = await readFile(join(directory, "tables/users.json"), "utf8");

    const discarding = await SqlConsole.open({ file: directory });
    assert.equal(discarding.execute("INSERT INTO users (display_name) VALUES ('Ada')").kind, "write");
    assert.equal(discarding.runtime.persistence, "memory");
    discarding.close();
    assert.equal(await readFile(join(directory, "tables/users.json"), "utf8"), before);

    const saving = await SqlConsole.open({ file: directory, save: true });
    saving.execute("INSERT INTO users (display_name) VALUES ('Ada')");
    saving.close();
    assert.deepEqual(await json("tables/users.json"), [{ id: 1, displayName: "Ada" }]);
  });

  it("uses the definitions a single file carries, and leaves a file without them as it is", async () => {
    const file = join(dir, "single.db.json");
    await createDatabase(file, { collections: { users: [] }, schema: [USERS] }, { overwrite: true });
    const described = await SqlConsole.open({ file, fallbackSchema: neverAsked });
    assert.deepEqual(described.tables(), [{ name: "users", rows: 0, source: "stored" }]);
    described.close();

    // A file of an earlier version: definitions are used for the session, and never written into it.
    await writeFile(file, JSON.stringify({ data: { users: [] } }));
    const legacy = await SqlConsole.open({ file, fallbackSchema: () => [USERS] });
    assert.deepEqual(legacy.tables(), [{ name: "users", rows: 0, source: "given" }]);
    legacy.execute("INSERT INTO users (display_name) VALUES ('Ada')");
    legacy.close();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { $meta: { version: 1 }, data: { users: [{ id: 1, displayName: "Ada" }] } });
  });
});
