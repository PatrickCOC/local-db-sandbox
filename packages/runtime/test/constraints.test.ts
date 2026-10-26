import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RuntimeSchemaError, SqliteRuntime } from "../src/index.ts";
import type { TableSchema } from "../src/index.ts";

/*
 * Unique constraints, foreign keys over several columns, indexes, enumerated
 * values, checks, and computed defaults in the runtime's table definitions
 * (D-033): what is enforced is enforced by SQLite, and what is information
 * stays information.
 */

const SCHEMA: TableSchema[] = [
  {
    name: "regions",
    columns: [
      { name: "country", type: "text", nullable: false, primary: true },
      { name: "code", type: "text", nullable: false, primary: true },
    ],
  },
  {
    name: "stores",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "country", type: "text", nullable: false, primary: false },
      { name: "region", type: "text", nullable: false, primary: false },
      { name: "email", type: "text", nullable: true, primary: false },
      { name: "status", type: "text", nullable: false, primary: false, default: "draft", enum: { name: "store_status", values: ["draft", "open", "closed"] } },
      { name: "opened_at", type: "datetime", nullable: false, primary: false, defaultFunction: "current_timestamp", defaultExpression: "now()" },
      { name: "opened_on", type: "date", nullable: true, primary: false, defaultFunction: "current_date" },
      { name: "ref", type: "text", nullable: true, primary: false, generated: "uuid", defaultExpression: "gen_random_uuid()" },
      { name: "rating", type: "integer", nullable: true, primary: false },
    ],
    uniques: [{ name: "stores_email_key", columns: ["email"] }],
    foreignKeys: [{ name: "stores_region_fk", columns: ["country", "region"], references: { table: "regions", columns: ["country", "code"] }, onDelete: "CASCADE", onUpdate: "CASCADE" }],
    indexes: [
      { name: "stores_status_idx", columns: ["status"] },
      { name: "stores_country_rating_key", columns: ["country", "rating"], unique: true },
      { name: "stores_email_lower", columns: [], unique: true, expressions: ["lower(email)"] },
      { name: "stores_open", columns: ["region"], where: "status = 'open'" },
    ],
    checks: [{ name: "stores_rating_check", expression: "rating between 1 and 5" }],
  },
];

async function open(): Promise<SqliteRuntime> {
  return SqliteRuntime.open({ schema: SCHEMA, state: { meta: { version: 1 }, collections: { regions: [{ country: "de", code: "be" }, { country: "de", code: "hh" }] } } });
}

function rejects(runtime: SqliteRuntime, sql: string, message: RegExp): void {
  assert.throws(() => runtime.execute(sql), (error: unknown) => error instanceof Error && message.test(error.message), sql);
}

describe("constraints and computed defaults of the runtime's tables", () => {
  test("unique constraints and unique indexes over columns are enforced", async () => {
    const runtime = await open();
    runtime.execute("INSERT INTO stores (country, region, email, rating) VALUES ('de', 'be', 'a@x', 1)");
    rejects(runtime, "INSERT INTO stores (country, region, email) VALUES ('de', 'hh', 'a@x')", /UNIQUE constraint failed: stores\.email/);
    rejects(runtime, "INSERT INTO stores (country, region, rating) VALUES ('de', 'hh', 1)", /UNIQUE constraint failed: stores\.country, stores\.rating/);
    // Several rows may hold NULL, as in PostgreSQL.
    runtime.execute("INSERT INTO stores (country, region) VALUES ('de', 'hh'), ('de', 'hh')");
    runtime.close();
  });

  test("a foreign key over several columns is enforced, with its actions", async () => {
    const runtime = await open();
    rejects(runtime, "INSERT INTO stores (country, region) VALUES ('fr', 'pa')", /FOREIGN KEY constraint failed/);
    runtime.execute("INSERT INTO stores (country, region) VALUES ('de', 'be')");
    runtime.execute("UPDATE regions SET code = 'b' WHERE code = 'be'");
    assert.deepEqual(runtime.execute("SELECT region FROM stores").rows, [{ region: "b" }]);
    runtime.execute("DELETE FROM regions WHERE code = 'b'");
    assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM stores").rows, [{ n: 0 }]);
    runtime.close();
  });

  test("an enumerated column takes its values only", async () => {
    const runtime = await open();
    runtime.execute("INSERT INTO stores (country, region, status) VALUES ('de', 'be', 'open')");
    rejects(runtime, "INSERT INTO stores (country, region, status) VALUES ('de', 'be', 'gone')", /CHECK constraint failed/);
    assert.deepEqual(runtime.execute("SELECT status FROM stores").rows, [{ status: "open" }]);
    runtime.close();
  });

  test("current_timestamp and current_date are computed when a row is written, in the runtime's stored form", async () => {
    const runtime = await open();
    const before = Date.now();
    runtime.execute("INSERT INTO stores (country, region) VALUES ('de', 'be')");
    const [row] = runtime.execute("SELECT opened_at, opened_on, ref, status FROM stores").rows as { opened_at: string; opened_on: string; ref: unknown; status: string }[];
    assert.match(row?.opened_at ?? "", /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
    assert.ok(Math.abs(Date.parse(`${row?.opened_at.replace(" ", "T")}Z`) - before) < 5000);
    assert.equal(row?.opened_on, new Date().toISOString().slice(0, 10));
    // A default kept as information is not computed.
    assert.deepEqual([row?.ref, row?.status], [null, "draft"]);
    // In the snapshot, the computed time is a date-time like any other.
    assert.match(String(runtime.snapshot().collections.stores?.[0]?.opened_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    runtime.close();
  });

  test("indexes over columns are created; over expressions or with a condition they are not; checks are not enforced", async () => {
    const runtime = await open();
    const indexes = runtime.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'stores' AND sql IS NOT NULL ORDER BY name").rows.map((row) => row.name);
    assert.deepEqual(indexes, ["stores_country_rating_key", "stores_status_idx"]);
    runtime.execute("INSERT INTO stores (country, region, email, rating) VALUES ('de', 'be', 'A@x', 9), ('de', 'be', 'a@x', 8)");
    runtime.close();
  });

  test("a definition that names a column the table does not have, or a default the runtime does not compute, is refused", async () => {
    const broken = (change: (table: TableSchema) => void): TableSchema[] => {
      const schema = structuredClone(SCHEMA);
      change(schema[1] as TableSchema);
      return schema;
    };
    const refused = async (schema: TableSchema[], message: RegExp): Promise<void> =>
      assert.rejects(SqliteRuntime.open({ schema }), (error: unknown) => error instanceof RuntimeSchemaError && message.test(error.message));
    await refused(broken((table) => (table.uniques = [{ columns: ["nope"] }])), /Table "stores": the unique constraint on \(nope\) names the column "nope", which the table does not have\./);
    await refused(broken((table) => (table.indexes = [{ name: "i", columns: ["nope"] }])), /the index "i" names the column "nope"/);
    await refused(broken((table) => (table.foreignKeys = [{ columns: ["country"], references: { table: "regions", columns: ["country", "code"] } }])), /has 1 columns and refers to 2/);
    await refused(broken((table) => ((table.columns[1] as { defaultFunction?: string }).defaultFunction = "current_timestamp")), /not one the runtime computes for a text column/);
  });

  test("a key into a table the schema does not have is kept as information, as for a column's reference", async () => {
    const schema = structuredClone(SCHEMA);
    (schema[1] as TableSchema).foreignKeys = [{ columns: ["country", "region"], references: { table: "elsewhere", columns: ["a", "b"] } }];
    const runtime = await SqliteRuntime.open({ schema });
    runtime.execute("INSERT INTO stores (country, region) VALUES ('xx', 'yy')");
    runtime.close();
  });
});

describe("the primary key as a constraint", () => {
  /** The position of each column in the table's primary key, as SQLite has it (0: not a key column). */
  async function keyPositions(table: TableSchema): Promise<Record<string, number>> {
    const runtime = await SqliteRuntime.open({ schema: [table] });
    try {
      return Object.fromEntries(runtime.execute(`PRAGMA table_info("${table.name}")`).rows.map((row) => [row.name as string, Number(row.pk)]));
    } finally {
      runtime.close();
    }
  }
  const regions = (primaryKey?: TableSchema["primaryKey"]): TableSchema => ({
    name: "regions",
    columns: [
      { name: "code", type: "text", nullable: false, primary: true },
      { name: "country", type: "text", nullable: false, primary: true },
      { name: "label", type: "text", nullable: true, primary: false },
    ],
    ...(primaryKey !== undefined && { primaryKey }),
  });

  test("a key over several columns has the order the constraint gives, not the order of the columns", async () => {
    assert.deepEqual(await keyPositions(regions({ name: "regions_pk", columns: ["country", "code"] })), { code: 2, country: 1, label: 0 });
    // Without the constraint, as before: the order of the columns.
    assert.deepEqual(await keyPositions(regions()), { code: 1, country: 2, label: 0 });
  });

  test("a constraint whose columns are not the columns marked primary is refused", async () => {
    await assert.rejects(
      SqliteRuntime.open({ schema: [regions({ name: "regions_pk", columns: ["code"] })] }),
      (error: unknown) => error instanceof RuntimeSchemaError && /Table "regions": the primary key "regions_pk" is on \(code\), but the columns marked primary are \(code, country\)\./.test(error.message),
    );
    await assert.rejects(SqliteRuntime.open({ schema: [regions({ columns: ["code", "label"] })] }), /the primary key is on \(code, label\), but the columns marked primary are \(code, country\)/);
    await assert.rejects(SqliteRuntime.open({ schema: [regions({ columns: ["code", "code"] })] }), RuntimeSchemaError);
  });
});
