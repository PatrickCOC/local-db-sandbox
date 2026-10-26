import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { SandboxLimitError } from "../../core/src/index.ts";
import type { DatabaseState } from "../../core/src/index.ts";
import { JsonStorageAdapter } from "../../storage-json/src/index.ts";
import { RuntimeSchemaError, SandboxDialectUnsupportedError, SandboxParameterError, SandboxReadOnlyError, SqliteRuntime, compileQuery, createSqlLogger, formatSqlEvent } from "../src/index.ts";
import type { SnapshotStorage, SqlEvent, SqlValue, TableSchema } from "../src/index.ts";

class MemoryStorage implements SnapshotStorage {
  saved: DatabaseState[] = [];
  failNextSave: Error | undefined;
  #state: DatabaseState;

  constructor(collections: DatabaseState["collections"] = {}) {
    this.#state = { meta: { version: 1 }, collections };
  }

  async load(): Promise<DatabaseState> {
    return structuredClone(this.#state);
  }

  saveSync(state: DatabaseState): void {
    if (this.failNextSave !== undefined) {
      const error = this.failNextSave;
      this.failNextSave = undefined;
      throw error;
    }
    this.#state = structuredClone(state);
    this.saved.push(this.#state);
  }
}

const SCHEMA: TableSchema[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "name", type: "text", nullable: false, primary: false },
      { name: "active", type: "boolean", nullable: false, primary: false, default: true },
      { name: "score", type: "real", nullable: true, primary: false },
      { name: "balance", type: "numeric", nullable: true, primary: false },
      { name: "created_at", key: "createdAt", type: "datetime", nullable: true, primary: false },
      { name: "birthday", type: "date", nullable: true, primary: false },
      { name: "settings", type: "json", nullable: true, primary: false },
    ],
  },
  {
    name: "orders",
    columns: [
      { name: "number", type: "text", nullable: false, primary: true },
      { name: "userId", type: "integer", nullable: true, primary: false, references: { table: "users", column: "id", onDelete: "SET NULL" } },
      { name: "total", type: "integer", nullable: false, primary: false, default: 0 },
    ],
  },
];

const USERS = [
  { id: 1, name: "Ada", active: true, score: 1.5, balance: 10.25, createdAt: "2026-01-02T03:04:05.678Z", birthday: "1990-12-10", settings: { theme: "dark", tags: ["a"] } },
  { id: 2, name: "Bo", active: false, score: null, balance: null, createdAt: null, birthday: null, settings: null },
];
const ORDERS = [{ number: "A-1", userId: 1, total: 30 }];

describe("SqliteRuntime", () => {
  let storage: MemoryStorage;
  let runtime: SqliteRuntime;

  beforeEach(async () => {
    storage = new MemoryStorage({ users: structuredClone(USERS), orders: structuredClone(ORDERS), notes: [{ text: "not a table" }] });
    runtime = await SqliteRuntime.open({ schema: SCHEMA, storage });
  });

  describe("schema", () => {
    it("creates one SQLite table per schema table with the mapped column types", () => {
      const columns = (table: string): unknown[] =>
        runtime.execute(`PRAGMA table_info("${table}")`).rows.map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
      assert.deepEqual(columns("users"), [
        ["id", "INTEGER", 0, null, 1],
        ["name", "TEXT", 1, null, 0],
        ["active", "BOOLEAN", 1, "1", 0],
        ["score", "REAL", 0, null, 0],
        ["balance", "NUMERIC", 0, null, 0],
        ["created_at", "DATETIME", 0, null, 0],
        ["birthday", "DATE", 0, null, 0],
        ["settings", "TEXT", 0, null, 0],
      ]);
      assert.deepEqual(columns("orders"), [
        ["number", "TEXT", 1, null, 1],
        ["userId", "INTEGER", 0, null, 0],
        ["total", "INTEGER", 1, "0", 0],
      ]);
      assert.deepEqual(
        runtime.execute('PRAGMA foreign_key_list("orders")').rows.map((row) => [row.from, row.table, row.to, row.on_delete]),
        [["userId", "users", "id", "SET NULL"]],
      );
    });

    it("supports composite primary keys and rejects schemas it cannot create", async () => {
      const column = { type: "integer", nullable: false, primary: true } as const;
      const composite = await SqliteRuntime.open({ schema: [{ name: "memberships", columns: [{ name: "a", ...column }, { name: "b", ...column }] }] });
      composite.execute("INSERT INTO memberships (a, b) VALUES (1, 1), (1, 2)");
      assert.throws(() => composite.execute("INSERT INTO memberships (a, b) VALUES (1, 2)"), /UNIQUE constraint failed/);

      await assert.rejects(SqliteRuntime.open({ schema: [SCHEMA[1] as TableSchema, SCHEMA[1] as TableSchema] }), /Table "orders" is defined more than once/);
      await assert.rejects(
        SqliteRuntime.open({ schema: [{ name: "t", columns: [{ name: "a", ...column, autoIncrement: true }, { name: "b", ...column }] }] }),
        /only a single integer primary key can be generated/,
      );
      await assert.rejects(SqliteRuntime.open({ schema: SCHEMA, persistence: "json" }), /needs a storage/);
    });
  });

  describe("loading the fixture", () => {
    it("inserts the fixture rows, stored the way SQLite holds each type", () => {
      assert.deepEqual(runtime.execute("SELECT * FROM users ORDER BY id").rows, [
        { id: 1, name: "Ada", active: 1, score: 1.5, balance: 10.25, created_at: "2026-01-02 03:04:05.678", birthday: "1990-12-10", settings: '{"theme":"dark","tags":["a"]}' },
        { id: 2, name: "Bo", active: 0, score: null, balance: null, created_at: null, birthday: null, settings: null },
      ]);
      assert.deepEqual(runtime.execute("SELECT * FROM orders").rows, ORDERS);
      // Loading is not a change: nothing was saved.
      assert.equal(storage.saved.length, 0);
    });

    it("returns the same fixture as its snapshot", () => {
      assert.deepEqual(runtime.snapshot(), { meta: { version: 1 }, collections: { users: USERS, orders: ORDERS, notes: [{ text: "not a table" }] } });
    });

    it("applies column defaults to fields the fixture leaves out and creates tables the fixture lacks", async () => {
      const partial = await SqliteRuntime.open({ schema: SCHEMA, storage: new MemoryStorage({ users: [{ name: "Cy" }] }) });
      assert.deepEqual(partial.snapshot().collections, {
        users: [{ id: 1, name: "Cy", active: true, score: null, balance: null, createdAt: null, birthday: null, settings: null }],
        orders: [],
      });
    });

    it("a default of a binary column is bytes: a row that leaves the column out gets them, also none at all", async () => {
      // The default is a fixture value, Base64 text of the bytes, as every binary value of a fixture is.
      const files: TableSchema[] = [
        {
          name: "files",
          columns: [
            { name: "id", type: "integer", nullable: false, primary: true },
            { name: "body", type: "binary", nullable: false, primary: false, default: "AQL/" },
            { name: "quote", type: "binary", nullable: true, primary: false, default: Buffer.from("it's").toString("base64") },
            { name: "empty", type: "binary", nullable: true, primary: false, default: "" },
          ],
        },
      ];
      const opened = await SqliteRuntime.open({ schema: files, storage: new MemoryStorage({ files: [{ id: 1 }, { id: 2, body: "AA==" }] }) });
      assert.deepEqual(opened.snapshot().collections.files, [
        { id: 1, body: "AQL/", quote: "aXQncw==", empty: "" },
        { id: 2, body: "AA==", quote: "aXQncw==", empty: "" },
      ]);
      assert.deepEqual(opened.execute("SELECT hex(body) AS body, length(empty) AS empty FROM files WHERE id = 1").rows, [{ body: "0102FF", empty: 0 }]);
    });

    it("refuses rows that do not fit the schema, naming the row", async () => {
      const open = (collections: DatabaseState["collections"]): Promise<SqliteRuntime> => SqliteRuntime.open({ schema: SCHEMA, storage: new MemoryStorage(collections) });
      const refused = (message: RegExp) => (error: unknown): boolean => {
        assert.ok(error instanceof RuntimeSchemaError, String(error));
        assert.match(error.message, message);
        return true;
      };
      await assert.rejects(open({ users: [{ name: "A" }, { name: "B", nickname: "b" }] }), refused(/Cannot load row 2 of "users": it has the field "nickname", which is not a column/));
      await assert.rejects(open({ users: [{ name: "A", createdAt: "yesterday" }] }), refused(/row 1 of "users": "createdAt" holds "yesterday", which is not a date-time/));
      await assert.rejects(open({ users: [{ name: { first: "A" } }] }), refused(/"name" holds a object, but its column type is text/));
      await assert.rejects(open({ users: [{ id: 1 }] }), refused(/row 1 of "users": NOT NULL constraint failed: users\.name/));
      await assert.rejects(open({ users: [{ id: 1, name: "A" }, { id: 1, name: "B" }] }), refused(/row 2 of "users": UNIQUE constraint failed: users\.id/));
      await assert.rejects(open({ orders: [{ number: "A-1", userId: 9 }] }), refused(/a row refers to a row that does not exist/));
    });
  });

  describe("executing SQL", () => {
    it("returns rows for queries, and affected rows and the new key for writes", () => {
      assert.deepEqual(runtime.execute("SELECT name FROM users WHERE active = ? ORDER BY id", [true]).rows, [{ name: "Ada" }]);

      const inserted = runtime.execute("INSERT INTO users (name) VALUES (?)", ["Cy"]);
      assert.deepEqual(inserted, { rows: [], affectedRows: 1, lastInsertId: 3 });
      assert.equal(runtime.execute("UPDATE users SET score = ? WHERE id > ?", [9, 1]).affectedRows, 2);
      assert.equal(runtime.execute("DELETE FROM users WHERE id = ?", [3]).affectedRows, 1);
      assert.deepEqual(runtime.execute("INSERT INTO users (name) VALUES ('Di') RETURNING id").rows, [{ id: 4 }]);

      const statement = runtime.prepare("SELECT COUNT(*) AS n FROM users WHERE active = ?");
      assert.equal(statement.returnsRows, true);
      assert.deepEqual([statement.execute([true]).rows, statement.execute([false]).rows], [[{ n: 2 }], [{ n: 1 }]]);
      assert.equal(runtime.prepare("DELETE FROM orders").returnsRows, false);
    });

    it("binds booleans and dates the way they are stored", () => {
      runtime.execute("INSERT INTO users (name, active, created_at) VALUES (?, ?, ?)", ["Cy", false, new Date("2026-05-06T07:08:09.010Z")]);
      assert.deepEqual(runtime.execute("SELECT active, created_at FROM users WHERE name = 'Cy'").rows, [{ active: 0, created_at: "2026-05-06 07:08:09.010" }]);
      assert.equal(runtime.snapshot().collections.users?.at(-1)?.createdAt, "2026-05-06T07:08:09.010Z");
    });

    it("refuses a parameter that SQLite cannot bind, instead of converting it or binding nothing", () => {
      const insert = "INSERT INTO users (name, settings) VALUES (?, ?)";
      const refuse = (parameters: unknown[], message: RegExp): void => {
        assert.throws(() => runtime.execute(insert, parameters as never), (error) => error instanceof TypeError && message.test(error.message));
      };
      refuse(["Cy", { theme: "dark" }], /^Parameter 2 is an object, which SQLite cannot bind\. .* any other value has to be converted before it reaches the runtime\.$/);
      refuse(["Cy", ["a"]], /^Parameter 2 is an array/);
      refuse([() => "Cy", null], /^Parameter 1 is a function/);
      // node:sqlite takes an object in first position for named parameters; an empty one would bind nothing.
      refuse([{}, null], /^Parameter 1 is an object/);
      assert.throws(() => runtime.execute("SELECT * FROM users WHERE name = ?", [{}] as never), /^TypeError: Parameter 1 is an object/);

      assert.equal(runtime.execute("SELECT COUNT(*) AS n FROM users WHERE name = 'Cy'").rows[0]?.n, 0);
      assert.equal(runtime.inTransaction, false);
      assert.equal(storage.saved.length, 0);
      // Binary data is bound as it is.
      assert.deepEqual(runtime.execute("SELECT length(?) AS n", [new Uint8Array([1, 2, 3])]).rows, [{ n: 3 }]);
    });

    it("enforces constraints and foreign key actions in SQLite", () => {
      assert.throws(() => runtime.execute("INSERT INTO orders (number, userId) VALUES ('A-2', 99)"), /FOREIGN KEY constraint failed/);
      assert.throws(() => runtime.execute("INSERT INTO users (id, name) VALUES (1, 'Again')"), /UNIQUE constraint failed: users\.id/);
      runtime.execute("DELETE FROM users WHERE id = 1");
      assert.deepEqual(runtime.execute("SELECT userId FROM orders").rows, [{ userId: null }]);
    });

    it("runs queries given in the Query IR", () => {
      assert.deepEqual(compileQuery({ kind: "select", table: "users", columns: ["id"], where: [{ column: "active", op: "eq", value: true }, { column: "score", op: "eq", value: null }], orderBy: [{ column: "id", direction: "desc" }], limit: 5, offset: 1 }), {
        sql: 'SELECT "id" FROM "users" WHERE "active" = ? AND "score" IS NULL ORDER BY "id" DESC LIMIT 5 OFFSET 1',
        parameters: [true],
      });
      assert.equal(compileQuery({ kind: "select", table: "users", offset: 2 }).sql, 'SELECT * FROM "users" LIMIT -1 OFFSET 2');
      assert.equal(compileQuery({ kind: "insert", table: 'odd"name', values: {} }).sql, 'INSERT INTO "odd""name" DEFAULT VALUES');
      assert.throws(() => compileQuery({ kind: "update", table: "users", set: {} }), /at least one column/);
      assert.throws(() => compileQuery({ kind: "select", table: "users", limit: -1 }), /limit must be a non-negative integer/);

      assert.equal(runtime.run({ kind: "insert", table: "users", values: { name: "Cy", active: false } }).lastInsertId, 3);
      assert.deepEqual(runtime.run({ kind: "count", table: "users", where: [{ column: "active", op: "eq", value: false }] }).rows, [{ count: 2 }]);
      assert.equal(runtime.run({ kind: "update", table: "users", set: { name: "Cyd" }, where: [{ column: "id", op: "eq", value: 3 }] }).affectedRows, 1);
      assert.deepEqual(runtime.run({ kind: "select", table: "users", columns: ["name"], orderBy: [{ column: "id", direction: "desc" }], limit: 1 }).rows, [{ name: "Cyd" }]);
      assert.equal(runtime.run({ kind: "delete", table: "users", where: [{ column: "id", op: "eq", value: 3 }] }).affectedRows, 1);
    });
  });

  describe("SQL of other dialects", () => {
    const unsupported = (message: RegExp) => (error: unknown): boolean => {
      assert.ok(error instanceof SandboxDialectUnsupportedError, String(error));
      assert.equal(error.code, "SANDBOX_DIALECT_UNSUPPORTED");
      assert.match(error.message, message);
      return true;
    };

    it("fails clearly instead of being translated", () => {
      assert.throws(() => runtime.execute("SELECT * FROM users WHERE name ILIKE ?", ["a%"]), unsupported(/SQLite cannot run this statement: near "ILIKE": syntax error\. The sandbox runs SQL on embedded SQLite and does not translate/));
      assert.throws(() => runtime.execute("SELECT now()::date"), unsupported(/unrecognized token|syntax error/));
      assert.throws(() => runtime.execute("SELECT gen_random_uuid()"), unsupported(/no such function: gen_random_uuid/));
      assert.throws(() => runtime.prepare("SELECT * FROM users FOR UPDATE"), unsupported(/SQL: SELECT \* FROM users FOR UPDATE/));
    });

    it("says so when a table or column is not part of the runtime's schema", () => {
      assert.throws(() => runtime.execute("SELECT * FROM audit_log"), unsupported(/no such table: audit_log\. The sandbox's SQLite schema.*has no such table or column/));
    });

    it("leaves data errors as they are", () => {
      assert.throws(() => runtime.execute("INSERT INTO users (name) VALUES (NULL)"), (error) => !(error instanceof SandboxDialectUnsupportedError) && /NOT NULL constraint failed/.test(String(error)));
    });
  });

  describe("PostgreSQL-style positional parameters ($1, $2, ...)", () => {
    const refused = (message: RegExp) => (error: unknown): boolean => {
      assert.ok(error instanceof SandboxParameterError, String(error));
      assert.equal(error.code, "SANDBOX_PARAMETER");
      assert.match(error.message, message);
      return true;
    };
    const names = (sql: string, parameters: SqlValue[]): unknown[] => runtime.execute(sql, parameters).rows.map((row) => row.name);

    beforeEach(() => {
      runtime.execute("INSERT INTO users (name, active, score) VALUES ('Cy', 1, 2), ('$1', 0, 1.5)");
    });

    it("binds $N to the Nth parameter", () => {
      assert.deepEqual(names('SELECT "u"."name" as "name" FROM "users" "u" WHERE "u"."id" = $1', [2]), ["Bo"]);
      assert.deepEqual(names("SELECT name FROM users WHERE active = $1 AND score = $2 ORDER BY id", [1, 2]), ["Cy"]);
      assert.deepEqual(names("SELECT name FROM users WHERE name IN ($1, $2, $3) ORDER BY id LIMIT $4", ["Ada", "Bo", "Cy", 2]), ["Ada", "Bo"]);
      assert.equal(runtime.execute("UPDATE users SET score = $2 WHERE id = $1", [2, 9]).affectedRows, 1);
      assert.deepEqual(runtime.execute("SELECT score FROM users WHERE id = 2").rows, [{ score: 9 }]);
      assert.equal(runtime.execute("INSERT INTO users (name, score) VALUES ($1, $2)", ["Di", 4]).lastInsertId, 5);
    });

    it("binds by number, not by where the placeholder stands", () => {
      // active = 0 AND score = 1.5 is the user named "$1"; read by position it would be active = 1.5 AND score = 0.
      assert.deepEqual(names("SELECT name FROM users WHERE score = $2 AND active = $1", [0, 1.5]), ["$1"]);
      assert.deepEqual(runtime.execute("SELECT $3 AS c, $1 AS a, $2 AS b", ["a", "b", "c"]).rows, [{ c: "c", a: "a", b: "b" }]);
    });

    it("binds one parameter to every placeholder that repeats its number", () => {
      assert.deepEqual(names("SELECT name FROM users WHERE id = $1 OR score = $1 ORDER BY id", [2]), ["Bo", "Cy"]);
      assert.deepEqual(runtime.execute("SELECT $1 AS a, $2 AS b, $1 AS c, $2 AS d", ["x", "y"]).rows, [{ a: "x", b: "y", c: "x", d: "y" }]);
    });

    it("does not need every parameter to be used, as long as the last one is", () => {
      assert.deepEqual(runtime.execute("SELECT $1 AS a, $3 AS c", ["a", "unused", "c"]).rows, [{ a: "a", c: "c" }]);
    });

    it("takes $N inside a string, a quoted identifier, or a comment as text", () => {
      assert.deepEqual(names("SELECT name FROM users WHERE name = '$1'", []), ["$1"]);
      assert.deepEqual(names("SELECT name FROM users WHERE name = '$1' OR id = $1", [1]), ["Ada", "$1"]);
      assert.deepEqual(runtime.execute('SELECT id AS "$1" FROM users WHERE id = $1 -- not $2', [1]).rows, [{ $1: 1 }]);
      assert.deepEqual(runtime.execute("SELECT /* $2, $3 */ $1 AS value", ["v"]).rows, [{ value: "v" }]);
    });

    it("refuses a placeholder that has no parameter, and parameters after the last placeholder", () => {
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE id = $1 OR id = $3", [1, 2]), refused(/^The statement uses \$3, but 2 parameters were given\. \$N is bound to the Nth parameter\.\n {2}SQL: SELECT name FROM users WHERE id = \$1 OR id = \$3$/));
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE id = $1"), refused(/uses \$1, but no parameters were given/));
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE id = $2", [1]), refused(/uses \$2, but 1 parameter was given/));
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE id = $1", [1, 2]), refused(/^2 parameters were given, but the statement uses none after \$1\./));
      assert.throws(() => runtime.execute("SELECT $0"), refused(/\$0 is not a parameter: they are numbered from \$1/));
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE id = $1 AND active = ?", [1, 1]), refused(/mixes \$N and \? placeholders/));
      // Nothing was changed by a statement that was refused.
      assert.throws(() => runtime.execute("DELETE FROM users WHERE id = $1 OR id = $2", [1]), refused(/uses \$2/));
      assert.equal(runtime.execute("SELECT COUNT(*) AS n FROM users").rows[0]?.n, 4);
      assert.equal(runtime.inTransaction, false);
    });

    it("converts the values as it does for ? placeholders", () => {
      const at = new Date("2026-05-06T07:08:09.000Z");
      runtime.execute("UPDATE users SET created_at = $2, active = $3, score = $4 WHERE id = $1", [2, at, true, null]);
      assert.deepEqual(runtime.execute("SELECT created_at, active, score FROM users WHERE id = $1", [2]).rows, [{ created_at: "2026-05-06 07:08:09.000", active: 1, score: null }]);
      assert.deepEqual(names("SELECT name FROM users WHERE score IS $1", [null]), ["Bo"]);
      assert.deepEqual(names("SELECT name FROM users WHERE score IS $1", [undefined]), ["Bo"]);
      // A value nothing converted is refused under the number the application gave it.
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE name = $2 AND id = $1", [1, { a: 1 }] as never), /^TypeError: Parameter 2 is an object, which SQLite cannot bind/);
    });

    it("still does not translate SQL of another dialect around the placeholders", () => {
      const unsupported = (message: RegExp) => (error: unknown): boolean => {
        assert.ok(error instanceof SandboxDialectUnsupportedError, String(error));
        assert.match(error.message, message);
        return true;
      };
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE id = $1::int", [1]), unsupported(/unrecognized token.*\n {2}SQL: SELECT name FROM users WHERE id = \$1::int$/s));
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE name ILIKE $1", ["a%"]), unsupported(/near "ILIKE": syntax error/));
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE id = $1 FOR UPDATE", [1]), unsupported(/near "FOR": syntax error/));
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE settings ? $1", ["theme"]), unsupported(/syntax error/));
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE settings @> $1", ["{}"]), unsupported(/unrecognized token|syntax error/));
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE id = ANY($1)", ["{1}"]), unsupported(/ANY/));
      assert.throws(() => runtime.execute("SELECT now() - INTERVAL $1", ["1 day"]), unsupported(/near "\?1": syntax error\. The statement's \$N placeholders are given to SQLite as \?N\./));
    });

    it("reports the statement and the parameters as the application gave them", async () => {
      const events: SqlEvent[] = [];
      runtime.subscribe((event) => events.push(event));
      const sql = 'SELECT "u"."name" as "name" FROM "users" "u" WHERE "u"."id" = $2 OR "u"."id" = $1 ORDER BY "u"."id"';
      runtime.prepare(sql).execute([2, 1]);
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE id = $2", [1]));
      assert.throws(() => runtime.execute("SELECT name FROM users WHERE id = $1::int", [1]));

      assert.deepEqual(events.map((event) => [event.sql, event.parameters, event.tables, event.returnedRows, event.errorCode]), [
        [sql, [2, 1], ["users"], 2, undefined],
        ["SELECT name FROM users WHERE id = $2", [1], ["users"], undefined, "SANDBOX_PARAMETER"],
        ["SELECT name FROM users WHERE id = $1::int", [], ["users"], undefined, "SANDBOX_DIALECT_UNSUPPORTED"],
      ]);
      assert.deepEqual(formatSqlEvent(events[0] as SqlEvent, { mode: "verbose" }).split("\n").slice(1, 3), [`sql: ${sql}`, "params: [2,1]"]);
      assert.match(formatSqlEvent(events[1] as SqlEvent, { mode: "verbose" }), /\nerror: SANDBOX_PARAMETER: The statement uses \$2, but 1 parameter was given\./);
    });
  });

  describe("transactions", () => {
    it("commits several writes together and saves once", () => {
      runtime.begin();
      assert.equal(runtime.inTransaction, true);
      runtime.execute("INSERT INTO users (name) VALUES ('Cy')");
      runtime.execute("INSERT INTO orders (number, userId) VALUES ('A-2', 3)");
      runtime.execute("UPDATE users SET active = 0 WHERE id = 1");
      assert.equal(storage.saved.length, 0);

      runtime.commit();
      assert.equal(runtime.inTransaction, false);
      assert.equal(storage.saved.length, 1);
      assert.deepEqual(storage.saved[0]?.collections.users?.map((row) => [row.name, row.active]), [["Ada", false], ["Bo", false], ["Cy", true]]);
      assert.equal(storage.saved[0]?.collections.orders?.length, 2);
    });

    it("rolls back every write and saves nothing", () => {
      runtime.execute("BEGIN");
      runtime.execute("INSERT INTO users (name) VALUES ('Cy')");
      runtime.execute("DELETE FROM orders");
      runtime.execute("ROLLBACK");

      assert.equal(storage.saved.length, 0);
      assert.deepEqual(runtime.snapshot().collections.users, USERS);
      assert.deepEqual(runtime.snapshot().collections.orders, ORDERS);
      // The next commit saves only what it changed.
      runtime.execute("UPDATE orders SET total = 31");
      assert.equal(storage.saved.length, 1);
    });

    it("supports savepoints inside a transaction", () => {
      runtime.execute("BEGIN");
      runtime.execute("INSERT INTO users (name) VALUES ('Cy')");
      runtime.execute("SAVEPOINT inner_1");
      runtime.execute("INSERT INTO users (name) VALUES ('Di')");
      runtime.execute("ROLLBACK TO SAVEPOINT inner_1");
      runtime.execute("COMMIT");
      assert.deepEqual(storage.saved[0]?.collections.users?.map((row) => row.name), ["Ada", "Bo", "Cy"]);
    });
  });

  describe("persistence", () => {
    it("saves a snapshot for each committed change, and none for reads", () => {
      runtime.execute("SELECT * FROM users");
      assert.equal(storage.saved.length, 0);

      runtime.execute("INSERT INTO users (name) VALUES ('Cy')");
      runtime.execute("UPDATE users SET name = 'Cyd' WHERE id = 3");
      runtime.execute("UPDATE users SET name = 'x' WHERE id = 99");
      assert.equal(storage.saved.length, 2);
      assert.deepEqual(storage.saved[1]?.collections.users?.at(-1), { id: 3, name: "Cyd", active: true, score: null, balance: null, createdAt: null, birthday: null, settings: null });
      // Collections that are not tables are carried along unchanged, in their place.
      assert.deepEqual(Object.keys(storage.saved[1]?.collections ?? {}), ["users", "orders", "notes"]);
    });

    it("does not commit a statement whose snapshot cannot be saved", () => {
      storage.failNextSave = new Error("disk full");
      assert.throws(() => runtime.execute("INSERT INTO users (name) VALUES ('Cy')"), /disk full/);
      assert.equal(runtime.inTransaction, false);
      assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM users").rows, [{ n: 2 }]);

      runtime.execute("INSERT INTO users (name) VALUES ('Di')");
      assert.deepEqual(storage.saved.at(-1)?.collections.users?.map((row) => row.name), ["Ada", "Bo", "Di"]);
    });

    it("does not commit a transaction whose snapshot cannot be saved", () => {
      runtime.begin();
      runtime.execute("DELETE FROM orders");
      storage.failNextSave = new Error("disk full");
      assert.throws(() => runtime.commit(), /disk full/);
      assert.equal(runtime.inTransaction, false);
      assert.deepEqual(runtime.snapshot().collections.orders, ORDERS);
      assert.equal(storage.saved.length, 0);
    });

    it("discards changes in memory mode", async () => {
      const memory = await SqliteRuntime.open({ schema: SCHEMA, storage, persistence: "memory" });
      memory.execute("DELETE FROM orders");
      assert.deepEqual(memory.snapshot().collections.orders, []);
      assert.equal(storage.saved.length, 0);
      assert.deepEqual((await storage.load()).collections.orders, ORDERS);
    });
  });

  describe("read-only", () => {
    it("refuses every write, in SQLite itself, and still answers queries", async () => {
      const readOnly = await SqliteRuntime.open({ schema: SCHEMA, storage, readOnly: true });
      const events: SqlEvent[] = [];
      readOnly.subscribe((event) => events.push(event));
      const refused = (error: unknown): boolean => error instanceof SandboxReadOnlyError && error.code === "SANDBOX_READ_ONLY";

      assert.deepEqual(readOnly.execute("SELECT name FROM users ORDER BY id").rows, [{ name: "Ada" }, { name: "Bo" }]);
      assert.throws(() => readOnly.execute("INSERT INTO users (name) VALUES ('Cy')"), refused);
      assert.throws(() => readOnly.execute("UPDATE users SET name = 'x'"), refused);
      assert.throws(() => readOnly.execute("DELETE FROM orders"), refused);
      assert.throws(() => readOnly.execute("WITH gone AS (SELECT 1) DELETE FROM orders"), refused);
      assert.throws(() => readOnly.execute("DROP TABLE orders"), refused);
      assert.throws(() => readOnly.execute("PRAGMA query_only = OFF"), refused);

      assert.deepEqual(readOnly.snapshot().collections.users, USERS);
      assert.equal(storage.saved.length, 0);
      assert.deepEqual(events.map((event) => event.errorCode), [undefined, ...Array(6).fill("SANDBOX_READ_ONLY")]);
    });
  });

  describe("prepared statements", () => {
    it("name the columns of their result set", () => {
      assert.deepEqual(runtime.prepare("SELECT id, name AS label, 1 + 1 AS two FROM users WHERE id < 0").columns, ["id", "label", "two"]);
      assert.deepEqual(runtime.prepare("DELETE FROM orders").columns, []);
    });
  });

  describe("events", () => {
    let clock: number;
    let events: SqlEvent[];
    let requestId: string | undefined;
    let sequence: number;
    let timed: SqliteRuntime;

    beforeEach(async () => {
      clock = 0;
      events = [];
      requestId = undefined;
      sequence = 0;
      timed = await SqliteRuntime.open({
        schema: SCHEMA,
        storage,
        now: () => (clock += 2),
        context: () => (requestId === undefined ? undefined : { requestId, sequence: (sequence += 1) }),
      });
      timed.subscribe((event) => events.push(event));
    });

    it("reports a read with its real SQL, parameters, tables, and the number of rows returned", () => {
      timed.execute("SELECT u.name FROM users u JOIN orders o ON o.userId = u.id WHERE u.active = ?", [true]);
      assert.deepEqual(events, [
        {
          sql: "SELECT u.name FROM users u JOIN orders o ON o.userId = u.id WHERE u.active = ?",
          parameters: [true],
          operation: "SELECT",
          tables: ["users", "orders"],
          rows: 1,
          returnedRows: 1,
          resultPreview: [{ name: "Ada" }],
          localExecutionMs: 2,
        },
      ]);
    });

    it("puts the returned rows on the event, up to the preview limit", async () => {
      timed.execute("INSERT INTO users (name) VALUES ('C'), ('D'), ('E') RETURNING id");
      timed.execute("SELECT id FROM users ORDER BY id");
      timed.execute("SELECT id FROM users WHERE id < 0");
      timed.execute("DELETE FROM orders");
      // Twenty rows by default; here three of five were kept for the INSERT and all five for the SELECT.
      assert.deepEqual(events.map((event) => [event.returnedRows, event.resultPreview]), [
        [3, [{ id: 3 }, { id: 4 }, { id: 5 }]],
        [5, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]],
        [0, undefined],
        [undefined, undefined],
      ]);

      const limited: SqlEvent[] = [];
      const two = await SqliteRuntime.open({ schema: SCHEMA, storage: new MemoryStorage({ users: Array.from({ length: 30 }, (_, index) => ({ name: `u${index}` })) }), resultPreviewRows: 2 });
      two.subscribe((event) => limited.push(event));
      assert.equal(two.execute("SELECT id FROM users ORDER BY id").rows.length, 30);
      assert.deepEqual([limited[0]?.returnedRows, limited[0]?.resultPreview], [30, [{ id: 1 }, { id: 2 }]]);

      const none = await SqliteRuntime.open({ schema: SCHEMA, storage, resultPreviewRows: 0 });
      none.subscribe((event) => limited.push(event));
      none.execute("SELECT id FROM users");
      assert.equal("resultPreview" in (limited[1] as SqlEvent), false);

      const byDefault = await SqliteRuntime.open({ schema: SCHEMA, storage: new MemoryStorage({ users: Array.from({ length: 30 }, (_, index) => ({ name: `u${index}` })) }) });
      byDefault.subscribe((event) => limited.push(event));
      byDefault.execute("SELECT id FROM users");
      assert.deepEqual([limited[2]?.returnedRows, limited[2]?.resultPreview?.length], [30, 20]);
    });

    it("reports the rows affected by INSERT, UPDATE, and DELETE", () => {
      timed.execute('INSERT INTO "users" ("name") VALUES (?), (?)', ["Cy", "Di"]);
      timed.execute("UPDATE users SET score = ? WHERE id > ?", [1, 0]);
      timed.execute("DELETE FROM users WHERE id > ?", [2]);
      timed.execute("INSERT INTO users (name) VALUES ('Ed') RETURNING id");
      assert.deepEqual(events.map((event) => [event.operation, event.tables, event.affectedRows, event.returnedRows, event.rows]), [
        ["INSERT", ["users"], 2, undefined, 2],
        ["UPDATE", ["users"], 4, undefined, 4],
        ["DELETE", ["users"], 2, undefined, 2],
        ["INSERT", ["users"], 1, 1, 1],
      ]);
      assert.equal("returnedRows" in (events[0] as SqlEvent), false);
    });

    it("recognizes a statement that begins with comments", () => {
      timed.execute("-- add one\n/* really */ INSERT INTO users (name) VALUES ('Cy')");
      timed.execute("/* open */ BEGIN");
      timed.execute("-- undo\nROLLBACK");
      assert.deepEqual(events.map((event) => [event.operation, event.transaction, event.affectedRows]), [
        ["INSERT", undefined, 1],
        ["TRANSACTION", "BEGIN", undefined],
        ["TRANSACTION", "ROLLBACK", undefined],
      ]);
      assert.equal(storage.saved.length, 1);
    });

    it("reports transaction boundaries", () => {
      timed.execute("BEGIN TRANSACTION");
      timed.execute("SAVEPOINT typeorm_1");
      timed.execute("ROLLBACK TO SAVEPOINT typeorm_1");
      timed.execute("RELEASE SAVEPOINT typeorm_1");
      timed.execute("COMMIT");
      timed.begin();
      timed.rollback();
      assert.deepEqual(events.map((event) => [event.operation, event.transaction, event.sql]), [
        ["TRANSACTION", "BEGIN", "BEGIN TRANSACTION"],
        ["TRANSACTION", "SAVEPOINT", "SAVEPOINT typeorm_1"],
        ["TRANSACTION", "ROLLBACK TO SAVEPOINT", "ROLLBACK TO SAVEPOINT typeorm_1"],
        ["TRANSACTION", "RELEASE", "RELEASE SAVEPOINT typeorm_1"],
        ["TRANSACTION", "COMMIT", "COMMIT"],
        ["TRANSACTION", "BEGIN", "BEGIN"],
        ["TRANSACTION", "ROLLBACK", "ROLLBACK"],
      ]);
      assert.deepEqual(events[0], { sql: "BEGIN TRANSACTION", parameters: [], operation: "TRANSACTION", transaction: "BEGIN", rows: 0, localExecutionMs: 2 });
    });

    it("names only tables of its schema, and none when it cannot tell", () => {
      timed.execute("SELECT 'from orders' AS text FROM users");
      timed.execute("SELECT * FROM (SELECT 1 AS n)");
      timed.execute("SELECT name FROM sqlite_master");
      timed.execute("PRAGMA table_info(users)");
      timed.execute('INSERT INTO "orders" ("number") VALUES (?) ON CONFLICT ("number") DO UPDATE SET "total" = 1', ["A-1"]);
      assert.deepEqual(events.map((event) => [event.operation, event.tables]), [
        ["SELECT", ["users"]],
        ["SELECT", undefined],
        ["SELECT", undefined],
        ["OTHER", undefined],
        ["INSERT", ["orders"]],
      ]);
    });

    it("reports failures with a code and the engine's message", () => {
      assert.throws(() => timed.execute("SELECT * FROM users LIMIT 1 FOR UPDATE"));
      assert.throws(() => timed.execute("INSERT INTO users (id, name) VALUES (1, 'x')"));
      assert.deepEqual(events, [
        {
          sql: "SELECT * FROM users LIMIT 1 FOR UPDATE",
          parameters: [],
          operation: "SELECT",
          tables: ["users"],
          rows: 0,
          localExecutionMs: 2,
          errorCode: "SANDBOX_DIALECT_UNSUPPORTED",
          errorMessage: events[0]?.errorMessage,
        },
        {
          sql: "INSERT INTO users (id, name) VALUES (1, 'x')",
          parameters: [],
          operation: "INSERT",
          tables: ["users"],
          rows: 0,
          affectedRows: 0,
          localExecutionMs: 2,
          errorCode: "SQL_ERROR",
          errorMessage: "UNIQUE constraint failed: users.id",
        },
      ]);
      assert.match(events[0]?.errorMessage ?? "", /^SQLite cannot run this statement: near "FOR": syntax error/);
    });

    it("tags each statement with what it ran for and its number, as the adapter tells it", () => {
      timed.execute("SELECT 1");
      requestId = "req-1";
      timed.execute("SELECT 2");
      timed.execute("BEGIN");
      assert.throws(() => timed.execute("SELEC 3"));
      requestId = "req-2";
      timed.execute("ROLLBACK");
      assert.deepEqual(events.map((event) => [event.requestId, event.sequence]), [[undefined, undefined], ["req-1", 1], ["req-1", 2], ["req-1", 3], ["req-2", 4]]);
      assert.equal("requestId" in (events[0] as SqlEvent), false);
    });

    it("stops reporting to a listener that unsubscribed", () => {
      const seen: SqlEvent[] = [];
      const stop = timed.subscribe((event) => seen.push(event));
      timed.execute("SELECT 1");
      stop();
      timed.execute("SELECT 2");
      assert.equal(seen.length, 1);
    });
  });

  describe("log formatting", () => {
    const select: SqlEvent = {
      sql: 'SELECT "u"."id", "r"."userRole"\n  FROM "users" "u" LEFT JOIN "roles" "r" ON "r"."id" = "u"."roleId" WHERE "u"."id" = ?',
      parameters: [1],
      operation: "SELECT",
      tables: ["users", "roles"],
      rows: 1,
      returnedRows: 1,
      resultPreview: [{ id: 1, userRole: "client_admin" }],
      localExecutionMs: 0.24,
      requestId: "req-abc",
      sequence: 2,
    };
    const insert: SqlEvent = {
      sql: 'INSERT INTO "users"("name", "active") VALUES (?, ?)',
      parameters: ["Ada", 1],
      operation: "INSERT",
      tables: ["users"],
      rows: 1,
      affectedRows: 1,
      localExecutionMs: 12.44,
      requestId: "req-abc",
      sequence: 3,
    };
    const failed: SqlEvent = {
      sql: "SELECT * FROM users FOR UPDATE",
      parameters: [],
      operation: "SELECT",
      tables: ["users"],
      rows: 0,
      localExecutionMs: 0.31,
      requestId: "background",
      sequence: 7,
      errorCode: "SANDBOX_DIALECT_UNSUPPORTED",
      errorMessage: 'SQLite cannot run this statement: near "FOR": syntax error.\n  SQL: ...',
    };
    const begin: SqlEvent = { sql: "BEGIN TRANSACTION", parameters: [], operation: "TRANSACTION", transaction: "BEGIN", rows: 0, localExecutionMs: 0.04, requestId: "req-abc", sequence: 1 };

    it("prints one numbered line per statement in summary mode", () => {
      assert.equal(formatSqlEvent(begin), "[req-abc #1] 0.0ms BEGIN");
      assert.equal(formatSqlEvent(select), "[req-abc #2] 0.2ms SELECT users,roles rows=1");
      assert.equal(formatSqlEvent(insert, { mode: "summary" }), "[req-abc #3] 12.4ms INSERT users rows=1");
      assert.equal(formatSqlEvent(failed), "[background #7] 0.3ms SELECT users rows=0 SANDBOX_DIALECT_UNSUPPORTED");
      // Events without a request, as from the SQL console, have no prefix.
      assert.equal(formatSqlEvent({ ...insert, requestId: undefined, sequence: undefined }), "12.4ms INSERT users rows=1");
      assert.equal(formatSqlEvent({ ...begin, operation: "OTHER", transaction: undefined, sql: "PRAGMA foreign_keys = ON" }), "[req-abc #1] 0.0ms OTHER rows=0");
    });

    it("prints the SQL, the parameters, the counts, the returned rows, and the time in verbose mode", () => {
      assert.equal(
        formatSqlEvent(select, { mode: "verbose" }),
        [
          "[req-abc #2] SELECT users,roles",
          'sql: SELECT "u"."id", "r"."userRole" FROM "users" "u" LEFT JOIN "roles" "r" ON "r"."id" = "u"."roleId" WHERE "u"."id" = ?',
          "params: [1]",
          "rows: 1",
          'result: [{"id":1,"userRole":"client_admin"}]',
          "time: 0.2ms",
        ].join("\n"),
      );
      assert.equal(
        formatSqlEvent(insert, { mode: "verbose" }),
        ["[req-abc #3] INSERT users", 'sql: INSERT INTO "users"("name", "active") VALUES (?, ?)', 'params: ["Ada",1]', "affected: 1", "time: 12.4ms"].join("\n"),
      );
      assert.equal(formatSqlEvent(begin, { mode: "verbose" }), "[req-abc #1] BEGIN\nsql: BEGIN TRANSACTION\ntime: 0.0ms");
      assert.equal(
        formatSqlEvent(failed, { mode: "verbose" }),
        ["[background #7] SELECT users", "sql: SELECT * FROM users FOR UPDATE", "params: []", "time: 0.3ms", 'error: SANDBOX_DIALECT_UNSUPPORTED: SQLite cannot run this statement: near "FOR": syntax error.'].join("\n"),
      );
    });

    it("says how many rows are shown when a result has more than the preview", () => {
      const many: SqlEvent = { ...select, rows: 153, returnedRows: 153, resultPreview: Array.from({ length: 20 }, (_, index) => ({ id: index + 1 })) };
      const lines = formatSqlEvent(many, { mode: "verbose" }).split("\n");
      assert.deepEqual(lines.slice(3, 5), ["rows: 153", "showing: 20"]);
      assert.equal(JSON.parse((lines[5] as string).slice("result: ".length)).length, 20);

      const fewer = formatSqlEvent(many, { mode: "verbose", previewRows: 2 }).split("\n");
      assert.deepEqual(fewer.slice(3, 6), ["rows: 153", "showing: 2", 'result: [{"id":1},{"id":2}]']);
      // With no preview at all, the count is still there and no row values are.
      const none = formatSqlEvent({ ...many, resultPreview: undefined }, { mode: "verbose" });
      assert.match(none, /\nrows: 153\ntime: /);
      assert.deepEqual(formatSqlEvent(many, { mode: "verbose", previewRows: 0 }).split("\n").slice(3, 6), ["rows: 153", "showing: 0", "time: 0.2ms"]);
    });

    it("shortens long values instead of printing them whole", () => {
      const text = formatSqlEvent({ ...select, parameters: ["p".repeat(500)], resultPreview: [{ body: "r".repeat(1000) }] }, { mode: "verbose" });
      assert.match(text, /\nparams: \["p{200}\.\.\. \(500 characters\)"\]\n/);
      assert.match(text, /\nresult: \[\{"body":"r{200}\.\.\. \(1000 characters\)"\}\]\n/);
    });

    it("lets the caller replace parameters and rows before they are printed", () => {
      const text = formatSqlEvent(select, {
        mode: "verbose",
        redact: (parameters) => parameters.map(() => "?"),
        redactRows: (rows) => rows.map((row) => ({ ...row, userRole: "***" })),
      });
      assert.match(text, /\nparams: \["\?"\]\n/);
      assert.match(text, /\nresult: \[\{"id":1,"userRole":"\*\*\*"\}\]\n/);
      assert.doesNotMatch(text, /client_admin/);
    });

    it("gives no logger for off, and a logger that writes formatted entries otherwise", () => {
      assert.equal(createSqlLogger("off", () => assert.fail("nothing is written")), undefined);

      const lines: string[] = [];
      createSqlLogger("summary", (line) => lines.push(line))?.(insert);
      createSqlLogger("verbose", (line) => lines.push(line))?.(begin);
      assert.deepEqual(lines, ["[req-abc #3] 12.4ms INSERT users rows=1", "[req-abc #1] BEGIN\nsql: BEGIN TRANSACTION\ntime: 0.0ms"]);
      assert.throws(() => createSqlLogger("loud" as never, () => undefined), /SQL log mode must be "off", "summary", or "verbose"/);
    });
  });
});

describe("SqliteRuntime with a JSON database file", () => {
  let dir: string;
  let file: string;
  const read = async (): Promise<Record<string, any>> => JSON.parse(await readFile(file, "utf8"));

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-runtime-"));
    file = join(dir, "sandbox.db.json");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await writeFile(file, JSON.stringify({ $meta: { version: 1 }, $config: { server: { port: 4999 } }, data: { users: USERS, orders: ORDERS } }));
  });

  it("loads the file into SQLite and writes committed changes back to it", async () => {
    const runtime = await SqliteRuntime.open({ schema: SCHEMA, storage: new JsonStorageAdapter(file) });
    assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM users").rows, [{ n: 2 }]);

    runtime.execute("INSERT INTO orders (number, userId, total) VALUES (?, ?, ?)", ["A-2", 2, 5]);
    assert.deepEqual((await read()).data.orders, [...ORDERS, { number: "A-2", userId: 2, total: 5 }]);
    assert.deepEqual((await read()).data.users, USERS);
    assert.deepEqual((await read()).$config, { server: { port: 4999 } });

    runtime.begin();
    runtime.execute("DELETE FROM orders");
    assert.equal((await read()).data.orders.length, 2);
    runtime.rollback();
    assert.equal((await read()).data.orders.length, 2);
    runtime.close();

    const reopened = await SqliteRuntime.open({ schema: SCHEMA, storage: new JsonStorageAdapter(file) });
    assert.deepEqual(reopened.execute("SELECT number FROM orders ORDER BY number").rows, [{ number: "A-1" }, { number: "A-2" }]);
  });

  it("refuses a change that would take the file above the size limit, and keeps the runtime and the file as they were", async () => {
    const runtime = await SqliteRuntime.open({ schema: SCHEMA, storage: new JsonStorageAdapter(file, { maxFileSizeMb: 0.002 }) });
    const before = await readFile(file, "utf8");

    assert.throws(() => runtime.execute("INSERT INTO users (name) VALUES (?)", ["x".repeat(4000)]), (error) => error instanceof SandboxLimitError);
    runtime.begin();
    runtime.execute("UPDATE users SET name = ?", ["y".repeat(4000)]);
    assert.throws(() => runtime.commit(), (error) => error instanceof SandboxLimitError);

    assert.equal(await readFile(file, "utf8"), before);
    assert.deepEqual(runtime.snapshot().collections.users, USERS);
    // A change within the limit still goes through.
    runtime.execute("UPDATE users SET name = 'Adah' WHERE id = 1");
    assert.equal((await read()).data.users[0].name, "Adah");
  });

  it("refuses to load a file above the size limit", async () => {
    await writeFile(file, JSON.stringify({ data: { users: [{ name: "x".repeat(4000) }] } }));
    await assert.rejects(SqliteRuntime.open({ schema: SCHEMA, storage: new JsonStorageAdapter(file, { maxFileSizeMb: 0.002 }) }), (error) => error instanceof SandboxLimitError);
  });
});
