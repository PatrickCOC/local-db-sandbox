import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SqliteRuntime, UnkeptSchemaChangeError } from "../src/index.ts";
import type { TableSchema } from "../src/index.ts";

/*
 * What SQL did to the runtime's tables, read back from SQLite's catalog as
 * table definitions (sqlite-catalog.ts, D-045): what is kept, and what is
 * refused with what it is.
 */

const ITEMS: TableSchema = {
  name: "items",
  columns: [
    { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
    // What SQLite does not know of a column, which a definition that is kept keeps.
    { name: "name", type: "text", nullable: false, primary: false, declaredType: "character varying(40)", sourceDialectType: { dialect: "postgresql", type: "varchar(40)" } },
  ],
  indexes: [{ name: "items_name", columns: ["name"] }],
};

async function open(): Promise<SqliteRuntime> {
  return SqliteRuntime.open({ schema: [ITEMS], state: { meta: { version: 1 }, collections: { items: [{ id: 1, name: "one" }] } }, persistence: "memory" });
}

describe("SqliteRuntime.readCatalog: SQL's changes of the tables as table definitions", () => {
  it("keeps the definition of a table that SQL did not change, as it was given, and changes nothing of the runtime's schema", async () => {
    const runtime = await open();
    try {
      runtime.execute("INSERT INTO items (name) VALUES ('two')");
      const reading = runtime.readCatalog();
      assert.equal(reading.tables[0], ITEMS);
      assert.equal(runtime.readCatalog(reading).tables[0], ITEMS);
      assert.deepEqual(runtime.schema, [ITEMS]);
    } finally {
      runtime.close();
    }
  });

  it("describes a table SQL made: SQLite's type names, keys, references, unique constraints, and defaults", async () => {
    const runtime = await open();
    try {
      runtime.execute(
        "CREATE TABLE parts (item_id INTEGER REFERENCES items ON UPDATE CASCADE, code VARCHAR(12), qty BIGINT DEFAULT (-1), price DECIMAL(10, 2) DEFAULT 1.5, " +
          "label TEXT DEFAULT 'it''s', ok BOOLEAN NOT NULL DEFAULT TRUE, on_day DATE DEFAULT CURRENT_DATE, raw BLOB, anything, PRIMARY KEY (item_id, code), UNIQUE (label, qty))",
      );
      runtime.execute("CREATE TABLE links (a INTEGER, b VARCHAR(12), FOREIGN KEY (a, b) REFERENCES parts (item_id, code) ON DELETE SET NULL)");
      const [, parts, links] = runtime.readCatalog().tables as [TableSchema, TableSchema, TableSchema];
      assert.deepEqual(parts, {
        name: "parts",
        columns: [
          { name: "item_id", type: "integer", declaredType: "INTEGER", nullable: true, primary: true, references: { table: "items", column: "id", onUpdate: "CASCADE" } },
          { name: "code", type: "text", declaredType: "VARCHAR(12)", nullable: true, primary: true },
          { name: "qty", type: "integer", declaredType: "BIGINT", nullable: true, primary: false, default: -1 },
          { name: "price", type: "numeric", declaredType: "DECIMAL(10, 2)", nullable: true, primary: false, default: 1.5 },
          { name: "label", type: "text", declaredType: "TEXT", nullable: true, primary: false, default: "it's" },
          { name: "ok", type: "boolean", declaredType: "BOOLEAN", nullable: false, primary: false, default: true },
          { name: "on_day", type: "date", declaredType: "DATE", nullable: true, primary: false, defaultFunction: "current_date" },
          { name: "raw", type: "binary", declaredType: "BLOB", nullable: true, primary: false },
          { name: "anything", type: "any", nullable: true, primary: false },
        ],
        primaryKey: { columns: ["item_id", "code"] },
        uniques: [{ columns: ["label", "qty"] }],
      });
      assert.deepEqual(links.foreignKeys, [{ columns: ["a", "b"], references: { table: "parts", columns: ["item_id", "code"] }, onDelete: "SET NULL" }]);
      assert.equal(links.columns.some((column) => column.references !== undefined), false);
    } finally {
      runtime.close();
    }
  });

  it("follows a column added and one dropped, and keeps what was said of the others", async () => {
    const runtime = await open();
    try {
      runtime.execute("ALTER TABLE items ADD COLUMN price REAL NOT NULL DEFAULT 0");
      const added = runtime.readCatalog();
      const [items] = added.tables as [TableSchema];
      assert.deepEqual(items.columns.slice(0, 2), ITEMS.columns);
      assert.deepEqual(items.indexes, ITEMS.indexes);
      assert.deepEqual(items.columns[2], { name: "price", type: "real", declaredType: "REAL", nullable: false, primary: false, default: 0 });

      runtime.execute("ALTER TABLE items DROP COLUMN price");
      assert.deepEqual(runtime.readCatalog(added).tables[0], { ...ITEMS, columns: ITEMS.columns });
      assert.deepEqual(runtime.stateOf(runtime.readCatalog(added).tables).collections, { items: [{ id: 1, name: "one" }] });
    } finally {
      runtime.close();
    }
  });

  it("gives the rows of the tables as they are now, in their definitions' types", async () => {
    const runtime = await open();
    try {
      runtime.execute("CREATE TABLE flags (id INTEGER PRIMARY KEY, on_off BOOLEAN)");
      runtime.execute("INSERT INTO flags (on_off) VALUES (1), (0)");
      runtime.execute("DROP TABLE items");
      const reading = runtime.readCatalog();
      assert.deepEqual(
        reading.tables.map((table) => table.name),
        ["flags"],
      );
      assert.deepEqual(runtime.stateOf(reading.tables).collections, {
        flags: [
          { id: 1, on_off: true },
          { id: 2, on_off: false },
        ],
      });
    } finally {
      runtime.close();
    }
  });

  for (const [what, sql, message] of [
    ["a type name that is not SQLite's", "CREATE TABLE t (id uuid)", /Column "t"\."id" has the type "uuid"/],
    ["json, which SQLite does not name", "CREATE TABLE t (doc JSON)", /has the type "JSON"/],
    ["an index", "CREATE INDEX items_id ON items (id)", /The index "items_id" was made/],
    ["an index of the stored definitions dropped", "DROP INDEX items_name", /The index "items_name" was dropped/],
    ["a trigger", "CREATE TRIGGER t AFTER INSERT ON items BEGIN SELECT 1; END", /The trigger "t" was made/],
    ["a collation", "CREATE TABLE t (name TEXT COLLATE NOCASE)", /Table "t" has a collation/],
    ["a generated column", "CREATE TABLE t (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2))", /has a generated column/],
    ["STRICT", "CREATE TABLE t (a INTEGER) STRICT", /has STRICT/],
    ["a default of another type", "CREATE TABLE t (n INTEGER DEFAULT 'x')", /has the default 'x', which is not a value of a integer column/],
    ["a renamed table", "ALTER TABLE items RENAME TO things", /The index "items_name" was changed/],
  ] as const) {
    it(`refuses ${what}, and leaves the reading it started from as it was`, async () => {
      const runtime = await open();
      try {
        const before = runtime.readCatalog();
        runtime.execute(sql);
        assert.throws(() => runtime.readCatalog(before), (error: unknown) => error instanceof UnkeptSchemaChangeError && message.test(error.message));
        assert.deepEqual(before.tables, [ITEMS]);
      } finally {
        runtime.close();
      }
    });
  }
});
