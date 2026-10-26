import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { TableSchema } from "../../runtime/src/index.ts";
import { claimDatabase, createDatabase, openDatabaseStorage, ownerRecordPath } from "../../storage-json/src/index.ts";
import { allFiles } from "../../storage-json/test/support/database-files.ts";
import { runCli } from "../src/index.ts";
import { previewPathOf } from "../src/simulate-command.ts";

/*
 * `simulate` runs a SQL script on a copy of a database (Phase E1, D-045).
 * The database is read and never written; the copy is a new database
 * beside it, written once the script has run, with what it changed, and
 * with the definitions of the tables and columns it made, added, or dropped.
 */

const SCHEMA: TableSchema[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "email", type: "text", nullable: false, primary: false },
      { name: "active", type: "boolean", nullable: false, primary: false, default: true },
    ],
    uniques: [{ columns: ["email"] }],
  },
  {
    name: "posts",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "user_id", type: "integer", nullable: false, primary: false, references: { table: "users", column: "id" } },
      { name: "title", type: "text", nullable: false, primary: false },
      { name: "draft", type: "text", nullable: true, primary: false },
    ],
  },
];

const ROWS = {
  users: [
    { id: 1, email: "ada@example.test", active: true },
    { id: 2, email: "bo@example.test", active: false },
  ],
  posts: [
    { id: 1, user_id: 1, title: "Hello", draft: null },
    { id: 2, user_id: 2, title: "Second", draft: "notes" },
  ],
};

describe("CLI: simulate (a SQL script on a copy of a database)", () => {
  let dir: string;
  let database: string;
  let preview: string;
  let original: Record<string, string>;

  const run = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["simulate", ...args], { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  };
  const script = async (name: string, sql: string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, sql);
    return path;
  };
  const rowsOf = async (path: string): Promise<Record<string, unknown[]>> => (await openDatabaseStorage(path).load()).collections;
  const schemaOf = async (path: string): Promise<TableSchema[] | undefined> => {
    const storage = openDatabaseStorage(path);
    await storage.load();
    return storage.schema;
  };
  /** Every file of the database is as it was before the test. */
  const assertUnchanged = async (): Promise<void> => {
    assert.deepEqual(await allFiles(database), original);
    assert.equal(existsSync(ownerRecordPath(database)), false);
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-simulate-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    database = join(dir, "sandbox.db");
    preview = join(dir, "sandbox-preview.db");
    await createDatabase(database, { schema: SCHEMA, collections: structuredClone(ROWS) });
    original = await allFiles(database);
  });

  it("names the copy <name>-preview, beside the database, in its format", () => {
    assert.equal(previewPathOf(join("work", "sandbox.db")), join("work", "sandbox-preview.db"));
    assert.equal(previewPathOf("sandbox.db.json"), "sandbox-preview.db.json");
    assert.equal(previewPathOf("data.json"), "data-preview.json");
    assert.equal(previewPathOf("data"), "data-preview");
    assert.equal(previewPathOf(".hidden"), ".hidden-preview");
    assert.equal(previewPathOf("./sandbox.db"), "./sandbox-preview.db");
    assert.equal(previewPathOf(".\\sandbox.db"), ".\\sandbox-preview.db");
  });

  it("runs INSERT, UPDATE, and DELETE on a copy, and leaves the database as it was", async () => {
    const path = await script(
      "rows.sql",
      "UPDATE users SET active = 1 WHERE id = 2;\nINSERT INTO users (email) VALUES ('cy@example.test');\nDELETE FROM posts WHERE id = 2;\nSELECT id, email FROM users ORDER BY id",
    );
    const { code, stdout, stderr } = await run(database, path);
    assert.equal(stderr, "");
    assert.equal(code, 0);
    assert.match(stdout, /^1 row affected \(.+\)\n1 row affected \(.+\)\n1 row affected \(.+\)\nid {2}email\n/);
    assert.match(stdout, new RegExp(`Simulated: the 4 statements of ${escape(path)} ran on a copy of ${escape(database)}\\. ${escape(database)} was not changed\\.\nCopy: ${escape(preview)}\n`));
    assert.match(stdout, new RegExp(`To look at it: {3}local-db-sandbox studio ${escape(preview)}\n`));
    assert.match(stdout, new RegExp(`To compare: {6}local-db-sandbox diff-schema ${escape(database)} ${escape(preview)}\n`));
    assert.match(stdout, new RegExp(`To discard it: {3}delete ${escape(preview)}\n$`));
    assert.doesNotMatch(stdout, /Tables of the copy/);

    assert.deepEqual(await rowsOf(preview), {
      users: [...ROWS.users.map((row) => ({ ...row, active: true })), { id: 3, email: "cy@example.test", active: true }],
      posts: [ROWS.posts[0]],
    });
    // The table definitions are the stored ones, as they were.
    assert.deepEqual(await schemaOf(preview), await schemaOf(database));
    await assertUnchanged();
    assert.equal(existsSync(ownerRecordPath(preview)), false);
  });

  it("keeps the tables and columns that CREATE TABLE, ALTER TABLE, and DROP TABLE make and drop, with the rows there are", async () => {
    const path = await script(
      "schema.sql",
      [
        "ALTER TABLE users ADD COLUMN age INTEGER NOT NULL DEFAULT 0",
        "UPDATE users SET age = 36 WHERE id = 1",
        "ALTER TABLE posts DROP COLUMN draft",
        "CREATE TABLE tags (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE, label VARCHAR(20) NOT NULL DEFAULT 'none', score REAL, at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE (post_id, label))",
        "INSERT INTO tags (post_id, label, at) VALUES (1, 'intro', '2026-10-12T10:00:00.000Z')",
        "CREATE TABLE scratch (id INTEGER PRIMARY KEY)",
        "DROP TABLE scratch",
        "",
      ].join(";\n"),
    );
    const { code, stdout, stderr } = await run(database, path);
    assert.equal(stderr, "");
    assert.equal(code, 0);
    assert.match(stdout, /\nTables of the copy: column "users"\."age" added; column "posts"\."draft" dropped; table "tags" made\.\n/);

    assert.deepEqual(await rowsOf(preview), {
      users: [
        { ...ROWS.users[0], age: 36 },
        { ...ROWS.users[1], age: 0 },
      ],
      posts: ROWS.posts.map(({ draft: _draft, ...row }) => row),
      tags: [{ id: 1, post_id: 1, label: "intro", score: null, at: "2026-10-12T10:00:00.000Z" }],
    });
    const schema = (await schemaOf(preview)) as TableSchema[];
    assert.deepEqual(
      schema.map((table) => table.name),
      ["users", "posts", "tags"],
    );
    const [users, posts, tags] = schema as [TableSchema, TableSchema, TableSchema];
    const [storedUsers, storedPosts] = (await schemaOf(database)) as [TableSchema, TableSchema];
    // What was stored is kept: the unique constraint of users, its default, and the reference of posts.
    assert.deepEqual(users.uniques, [{ columns: ["email"] }]);
    assert.deepEqual(users.columns.slice(0, 3), storedUsers.columns);
    assert.deepEqual(users.columns[3], { name: "age", type: "integer", declaredType: "INTEGER", nullable: false, primary: false, default: 0 });
    assert.deepEqual(posts.columns, storedPosts.columns.slice(0, 3));
    assert.deepEqual(tags, {
      name: "tags",
      columns: [
        // The storage writes a generated key as `generated: "increment"`, as for any table.
        { name: "id", type: "integer", declaredType: "INTEGER", nullable: false, primary: true, autoIncrement: true, generated: "increment" },
        { name: "post_id", type: "integer", declaredType: "INTEGER", nullable: false, primary: false, references: { table: "posts", column: "id", onDelete: "CASCADE" } },
        { name: "label", type: "text", declaredType: "VARCHAR(20)", nullable: false, primary: false, default: "none" },
        { name: "score", type: "real", declaredType: "REAL", nullable: true, primary: false },
        { name: "at", type: "datetime", declaredType: "DATETIME", nullable: true, primary: false, defaultFunction: "current_timestamp" },
      ],
      uniques: [{ columns: ["post_id", "label"] }],
    });
    await assertUnchanged();

    // The copy is a database of the sandbox like any other: the SQL console opens it, and the new tables enforce what they say.
    let out = "";
    let err = "";
    const io = { stdout: { write: (text: string) => (out += text) }, stderr: { write: (text: string) => (err += text) }, signals: new EventEmitter() };
    assert.equal(await runCli(["sql", preview, "SELECT u.email, u.age, t.label FROM users u JOIN posts p ON p.user_id = u.id JOIN tags t ON t.post_id = p.id"], io), 0);
    assert.match(out, /ada@example\.test {2}36 {3}intro/);
    assert.equal(await runCli(["sql", preview, "INSERT INTO tags (post_id, label) VALUES (1, 'intro')"], io), 1);
    assert.match(err, /UNIQUE constraint failed/);
  });

  it("stops at a statement that fails, says so, and writes a copy with what the statements before it changed", async () => {
    const path = await script("fails.sql", "UPDATE users SET active = 1 WHERE id = 2;\nUPDATE users SET email = 'ada@example.test';\nDELETE FROM posts;\nINSERT INTO posts (user_id, title) VALUES (1, 'never');\n");
    const { code, stdout, stderr } = await run(database, path);
    assert.equal(code, 1);
    assert.match(stdout, /^1 row affected \(\d+\.\d ms\)\n$/);
    assert.match(stderr, /^Error: UNIQUE constraint failed: users\.email\n/);
    assert.match(stderr, /\nSimulation failed at statement 2 of 4: UPDATE users SET email = 'ada@example\.test'\nStatement 1 ran; statement 2 changed nothing; statements 3-4 did not run\.\n/);
    assert.match(stderr, new RegExp(`\n${escape(database)} was not changed\\.\nCopy \\(partial\\): ${escape(preview)}, with what statement 1 changed\\. It is not what the whole script would give\\.\n`));
    // Statement 1 is in the copy; statement 2 changed no row, and 3 and 4 did not run.
    assert.deepEqual(await rowsOf(preview), { users: ROWS.users.map((row) => ({ ...row, active: true })), posts: ROWS.posts });
    await assertUnchanged();
  });

  it("leaves out of the copy what a transaction changed that was not committed", async () => {
    const path = await script(
      "transaction.sql",
      "DELETE FROM posts WHERE id = 2;\nBEGIN;\nINSERT INTO users (email) VALUES ('cy@example.test');\nINSERT INTO posts (user_id, title) VALUES (99, 'no such user');\nCOMMIT;\n",
    );
    const { code, stderr } = await run(database, path);
    assert.equal(code, 1);
    assert.match(stderr, /^Error: FOREIGN KEY constraint failed\n/);
    assert.match(stderr, /\nStatements 1-3 ran; statement 4 changed nothing; statement 5 did not run\.\nA transaction was open from statement 2, and it was rolled back: what statements 2-3 changed is not in the copy\.\n/);
    assert.match(stderr, /Copy \(partial\): .*, with what statement 1 changed\./);
    assert.deepEqual(await rowsOf(preview), { users: ROWS.users, posts: [ROWS.posts[0]] });
    await assertUnchanged();
  });

  it("rolls back a transaction that the script leaves open, and says so", async () => {
    const path = await script("open.sql", "BEGIN;\nUPDATE users SET active = 0;\n");
    const { code, stdout, stderr } = await run(database, path);
    assert.equal(code, 1);
    assert.match(stdout, /^BEGIN \(.+\)\n2 rows affected/);
    assert.match(stderr, /^The script left a transaction open from statement 1, and it was rolled back: what statements 1-2 changed is not in the copy\.\n/);
    assert.match(stderr, /Copy: .*sandbox-preview\.db, with nothing the script changed: it holds the database as it was read\.\n/);
    assert.deepEqual(await rowsOf(preview), ROWS);
    await assertUnchanged();
  });

  it("follows CREATE TABLE and ALTER TABLE into a transaction, and out of it when it is rolled back", async () => {
    const path = await script(
      "rolled-back.sql",
      "BEGIN;\nALTER TABLE users ADD COLUMN nickname TEXT;\nCREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\nROLLBACK;\nALTER TABLE users ADD COLUMN age INTEGER;\n",
    );
    const { code, stdout, stderr } = await run(database, path);
    assert.equal(stderr, "");
    assert.equal(code, 0);
    assert.match(stdout, /\nTables of the copy: column "users"\."age" added\.\n/);
    const schema = (await schemaOf(preview)) as TableSchema[];
    assert.deepEqual(
      schema.map((table) => [table.name, table.columns.map((column) => column.name)]),
      [
        ["users", ["id", "email", "active", "age"]],
        ["posts", ["id", "user_id", "title", "draft"]],
      ],
    );
  });

  for (const [what, sql, message] of [
    ["an index", "CREATE INDEX users_active ON users (active)", /The index "users_active" was made: a simulated copy keeps tables and their columns, and no index that SQL makes or changes\. The statement was undone\./],
    ["a view", "CREATE VIEW active_users AS SELECT * FROM users WHERE active", /The view "active_users" was made/],
    ["a type SQLite gives no meaning of its own", "CREATE TABLE events (id serial PRIMARY KEY, at timestamptz)", /Column "events"\."id" has the type "serial", which the sandbox's SQLite gives no meaning of its own/],
    ["a CHECK constraint", "CREATE TABLE prices (id INTEGER PRIMARY KEY, amount REAL CHECK (amount > 0))", /Table "prices" has a CHECK constraint, which a table definition of the sandbox has no place for\./],
    ["a CHECK constraint on an added column", "ALTER TABLE users ADD COLUMN age INTEGER CHECK (age >= 0)", /The column added to "users" has a CHECK constraint/],
    ["a renamed column", "ALTER TABLE posts RENAME COLUMN title TO heading", /Table "posts" has its columns renamed or in another order, which the simulation does not follow\./],
    ["a renamed table that another refers to", "ALTER TABLE users RENAME TO members", /Table "posts" was changed in a way the simulation does not follow/],
    ["a default that is an expression", "CREATE TABLE codes (id INTEGER PRIMARY KEY, code TEXT DEFAULT (lower('X')))", /Column "codes"\."code" has the default lower\('X'\), an expression/],
  ] as const) {
    it(`refuses ${what}: the statement fails and changes nothing, and the copy has what came before it`, async () => {
      const path = await script("refused.sql", `DELETE FROM posts WHERE id = 2;\n${sql};\nDELETE FROM users WHERE id = 2;\n`);
      const { code, stderr } = await run(database, path);
      assert.equal(code, 1);
      assert.match(stderr, message);
      assert.match(stderr, /\nStatement 1 ran; statement 2 changed nothing; statement 3 did not run\.\n/);
      assert.deepEqual(await rowsOf(preview), { users: ROWS.users, posts: [ROWS.posts[0]] });
      assert.deepEqual(await schemaOf(preview), await schemaOf(database));
      await assertUnchanged();
    });
  }

  it("does not translate PostgreSQL: what SQLite cannot run is an error with SQLite's reason", async () => {
    const path = await script("postgres.sql", "ALTER TABLE users ALTER COLUMN email TYPE varchar(320);\n");
    const { code, stderr } = await run(database, path);
    assert.equal(code, 1);
    assert.match(stderr, /^Error: SQLite cannot run this statement: near "ALTER": syntax error\. The sandbox runs SQL on embedded SQLite and does not translate the syntax or functions of other databases\./);
    assert.match(stderr, /\nStatement 1 changed nothing\.\n/);
    await assertUnchanged();
  });

  it("does not run ATTACH, DETACH, or VACUUM, which write elsewhere than the copy", async () => {
    const attached = join(dir, "elsewhere.sqlite");
    const path = await script("attach.sql", `ATTACH DATABASE '${attached.replaceAll("'", "''")}' AS other;\n`);
    const { code, stderr } = await run(database, path);
    assert.equal(code, 1);
    assert.match(stderr, /^Error: ATTACH is not run in a simulation: it would write elsewhere than the copy\.\n/);
    assert.equal(existsSync(attached), false);
    const vacuum = await script("vacuum.sql", `VACUUM INTO '${attached.replaceAll("'", "''")}';\n`);
    assert.equal((await run(database, vacuum, "--out", join(dir, "second.db"))).code, 1);
    assert.equal(existsSync(attached), false);
    await assertUnchanged();
  });

  it("writes no copy when the tables the script left cannot be opened again", async () => {
    const path = await script("orphan.sql", "PRAGMA foreign_keys = OFF;\nINSERT INTO posts (user_id, title) VALUES (99, 'orphan');\n");
    const { code, stderr } = await run(database, path);
    assert.equal(code, 1);
    // Every statement ran: the summary is only that nothing was written, and why.
    assert.match(stderr, /^No copy was written: the tables the script left cannot be kept as a database of the sandbox\. Cannot load the fixture: a row refers to a row that does not exist \(FOREIGN KEY constraint failed\)\.\n.*sandbox\.db was not changed\.\n$/);
    assert.equal(existsSync(preview), false);
    await assertUnchanged();
  });

  it("refuses paths that are not safe or not clear, before anything is read or written", async () => {
    const path = await script("ok.sql", "DELETE FROM posts;\n");
    const cases: [string[], RegExp][] = [
      [[join(dir, "missing.db"), path], /^Error: Database not found: /],
      [[database, join(dir, "missing.sql")], /^Error: SQL script not found: /],
      [[database, dir], /is not a file\. Give the file of SQL to run\./],
      [[database, path, "--out", database], /that is the database itself\. Give --out a path of its own\./],
      [[database, path, "--out", join(database, "inner.db")], /it would be inside the database\. Give --out a path beside it\./],
      [[database, path, "--out", join(dir, "copy.json")], /is a database directory, and .*copy\.json would be a single file\./],
      [[database], /^Error: Expected the database and the SQL script\./],
    ];
    for (const [args, message] of cases) {
      const { code, stdout, stderr } = await run(...args);
      assert.deepEqual([code, stdout], [1, ""], args.join(" "));
      assert.match(stderr, message);
    }
    const empty = await script("empty.sql", "-- nothing yet\n");
    assert.match((await run(database, empty)).stderr, /empty\.sql has no SQL statement\./);
    // A script inside the database is refused, and the database is not looked into for it.
    assert.match((await run(database, join(database, "manifest.json"))).stderr, /is inside .*sandbox\.db\. Keep the script outside the database and the copy\./);
    assert.equal(existsSync(preview), false);
    await assertUnchanged();
  });

  it("does not write over a copy that is there, unless told to, and not while a process has it open", async () => {
    const first = await script("first.sql", "DELETE FROM posts WHERE id = 2;\n");
    assert.equal((await run(database, first)).code, 0);
    const second = await script("second.sql", "DELETE FROM posts WHERE id = 2;\nDELETE FROM users WHERE id = 2;\n");

    const again = await run(database, second);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /sandbox-preview\.db exists already, and a simulation does not write over it\. Delete it if it is a copy you are done with, give another --out, or add --replace\./);
    assert.deepEqual(await rowsOf(preview), { users: ROWS.users, posts: [ROWS.posts[0]] });

    // A Studio, say, has the copy open: it is refused, and the copy is as it was.
    const studio = await claimDatabase(preview, { kind: "studio" });
    try {
      const refused = await run(database, second, "--replace");
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /Local DB Studio/);
      assert.match(refused.stderr, /Nothing was run, and .*sandbox-preview\.db was not changed\. Stop that process, or give another --out\./);
      assert.deepEqual(await rowsOf(preview), { users: ROWS.users, posts: [ROWS.posts[0]] });
    } finally {
      studio.release();
    }

    const replaced = await run(database, second, "--replace");
    assert.deepEqual([replaced.code, replaced.stderr], [0, ""]);
    assert.deepEqual(await rowsOf(preview), { users: [ROWS.users[0]], posts: [ROWS.posts[0]] });
    assert.equal(existsSync(ownerRecordPath(preview)), false);
    await assertUnchanged();
  });

  it("copies a database that a process has open as it is stored, and leaves that process its database", async () => {
    const owner = await claimDatabase(database, { kind: "sql" });
    try {
      const record = await readFile(ownerRecordPath(database), "utf8");
      const path = await script("owned.sql", "DELETE FROM posts WHERE id = 2;\n");
      const { code, stderr } = await run(database, path);
      assert.equal(code, 0);
      assert.match(stderr, /^Note: .*sandbox\.db is open in the SQL console \(pid \d+, since .+\)\. The copy starts from what is stored now; that process and its database are left alone\.\n$/);
      assert.equal(await readFile(ownerRecordPath(database), "utf8"), record);
      assert.deepEqual(await rowsOf(preview), { users: ROWS.users, posts: [ROWS.posts[0]] });
    } finally {
      owner.release();
    }
    await assertUnchanged();
  });

  it("copies a single-file database into a single file", async () => {
    const file = join(dir, "sandbox.db.json");
    const text = `${JSON.stringify({ data: { items: [{ id: 1, name: "one" }, { id: 2, name: "two" }] } }, null, 2)}\n`;
    await writeFile(file, text);
    const path = await script("file.sql", "UPDATE items SET name = 'uno' WHERE id = 1;\nINSERT INTO items (name) VALUES ('three');\n");
    const { code, stdout } = await run(file, path);
    assert.equal(code, 0);
    const copy = join(dir, "sandbox-preview.db.json");
    assert.match(stdout, new RegExp(`Copy: ${escape(copy)}\n`));
    assert.deepEqual(await rowsOf(copy), {
      items: [
        { id: 1, name: "uno" },
        { id: 2, name: "two" },
        { id: 3, name: "three" },
      ],
    });
    assert.equal(await readFile(file, "utf8"), text);
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.endsWith(".json")).sort(),
      ["sandbox-preview.db.json", "sandbox.db.json"],
    );
  });
});

/** Text as a regular expression that matches it. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
