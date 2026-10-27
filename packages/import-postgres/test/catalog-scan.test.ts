import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { TableSchema } from "../../runtime/src/index.ts";
import { CATALOG_SOURCE, PostgresConnectionError, PostgresScanError, SCAN_FILE, scanPostgresDatabase } from "../src/index.ts";
import type { ScannedSchema } from "../src/index.ts";
import { closedPort, startDisposablePostgres, startProxy } from "./support/disposable-postgres.ts";
import type { DisposablePostgres } from "./support/disposable-postgres.ts";

/*
 * The schema of a running PostgreSQL database, read from its catalog
 * (D-049), on synthetic schemas served by PGlite (PostgreSQL 18) on a port
 * of 127.0.0.1: fixtures/catalog/shop.sql (keys, foreign keys, uniques,
 * defaults, numbering, the common types) and fixtures/catalog/edges.sql
 * (what the sandbox does not reproduce, several schemas, an empty one).
 */

const FIXTURES = join(import.meta.dirname, "fixtures", "catalog");
const SHOP = readFileSync(join(FIXTURES, "shop.sql"), "utf8");
const EDGES = readFileSync(join(FIXTURES, "edges.sql"), "utf8");
/** Rows in the source, which the scan must not read. */
const SHOP_ROWS = `
insert into customers (email, name) values ('ada@example.com', 'Ada'), ('alan@example.com', 'Alan');
insert into products (sku, title, price) values ('A-1', 'Kettle', 19.5);
insert into orders (customer_id, total) values (1, 19.5);
`;
const SHOP_TABLES = ["customers", "order_lines", "orders", "products", "stock_levels", "tags", "warehouses"];

const table = (scanned: ScannedSchema, name: string): TableSchema => {
  const found = scanned.collected.tables.find((candidate) => candidate.name === name);
  assert.ok(found, `table ${name}`);
  return found;
};
/** A column without its provenance, which is where it was read, not what it is. */
const column = (scanned: ScannedSchema, tableName: string, name: string): Record<string, unknown> => {
  const { origin, renames, ...rest } = table(scanned, tableName).columns.find((candidate) => candidate.name === name) ?? assert.fail(`${tableName}.${name}`);
  assert.equal(origin?.source, CATALOG_SOURCE);
  return rest;
};
const withoutProvenance = <T>(value: T): T => JSON.parse(JSON.stringify(value, (key, inner) => (key === "origin" || key === "renames" ? undefined : inner)));

describe("PostgreSQL catalog scan", { timeout: 180_000 }, () => {
  describe("of a schema with keys, foreign keys, and the common types", () => {
    let server: DisposablePostgres;
    let scanned: ScannedSchema;
    let queries: string[];

    before(async () => {
      server = await startDisposablePostgres(SHOP + SHOP_ROWS);
      const proxy = await startProxy(server.port);
      try {
        scanned = await scanPostgresDatabase({ connection: { url: `postgresql://postgres@127.0.0.1:${proxy.port}/postgres?sslmode=disable` } });
        queries = [...proxy.queries];
      } finally {
        await proxy.stop();
      }
    });
    after(async () => {
      await server.stop();
    });

    it("reads the tables of public, and says where from", () => {
      assert.deepEqual(scanned.collected.tables.map((entry) => entry.name), SHOP_TABLES);
      assert.deepEqual(scanned.schemas, ["public"]);
      assert.match(scanned.serverVersion, /^18\./);
      assert.deepEqual(scanned.target, { host: "127.0.0.1", port: scanned.target.port, database: "postgres", user: "postgres", sslMode: "disable" });
      assert.deepEqual(scanned.notes, []);
      assert.deepEqual(scanned.collected.report.filter((entry) => entry.outcome === "unsupported"), []);
    });

    it("maps each type into the canonical schema as the collector of migrations does", () => {
      const types = (tableName: string): [string, string, unknown, unknown, boolean][] =>
        table(scanned, tableName).columns.map((entry) => [entry.name, entry.type, entry.canonicalType, entry.declaredType, entry.nullable]);
      assert.deepEqual(types("customers"), [
        ["id", "integer", { kind: "integer", bits: 32 }, "integer", false],
        ["email", "text", { kind: "varchar", length: 200 }, "character varying(200)", false],
        ["name", "text", { kind: "text" }, "text", true],
        ["vip", "boolean", { kind: "boolean" }, "boolean", false],
        ["created_at", "datetime", { kind: "timestamp", withTimeZone: true }, "timestamp with time zone", false],
        ["birthday", "date", { kind: "date" }, "date", true],
        ["external_id", "text", { kind: "uuid" }, "uuid", true],
        ["preferences", "json", { kind: "json", binary: true }, "jsonb", true],
      ]);
      assert.deepEqual(types("products"), [
        ["sku", "text", { kind: "varchar", length: 32 }, "character varying(32)", false],
        ["title", "text", { kind: "text" }, "text", false],
        ["price", "numeric", { kind: "decimal", precision: 10, scale: 2 }, "numeric(10,2)", false],
        ["stock", "integer", { kind: "integer", bits: 32 }, "integer", false],
        ["views", "integer", { kind: "integer", bits: 64 }, "bigint", true],
        ["updated_at", "datetime", { kind: "timestamp", withTimeZone: false }, "timestamp without time zone", true],
      ]);
      assert.deepEqual(types("order_lines").slice(0, 2), [
        ["order_id", "integer", { kind: "integer", bits: 64 }, "bigint", false],
        ["line", "integer", { kind: "integer", bits: 16 }, "smallint", false],
      ]);
      assert.deepEqual(column(scanned, "orders", "state"), {
        name: "state",
        type: "text",
        declaredType: "order_state",
        canonicalType: { kind: "enum", name: "order_state" },
        sourceDialectType: { dialect: "postgresql", type: "order_state" },
        nullable: false,
        primary: false,
        default: "new",
        enum: { name: "order_state", values: ["new", "paid", "shipped"] },
      });
      assert.deepEqual(withoutProvenance(scanned.collected.types.enums), [{ name: "order_state", values: ["new", "paid", "shipped"], sourceDialectType: { dialect: "postgresql", type: "order_state" } }]);
    });

    it("reads defaults, and numbering by a sequence and by identity", () => {
      const pick = (tableName: string, name: string): Record<string, unknown> => {
        const { autoIncrement, generated, default: value, defaultFunction, defaultExpression } = column(scanned, tableName, name) as Record<string, unknown>;
        return Object.fromEntries(Object.entries({ autoIncrement, generated, default: value, defaultFunction, defaultExpression }).filter(([, inner]) => inner !== undefined));
      };
      // serial: a default of nextval(); identity, ALWAYS and BY DEFAULT: numbered by the sandbox as a single integer key.
      assert.deepEqual(pick("customers", "id"), { autoIncrement: true, generated: "increment" });
      assert.deepEqual(pick("orders", "id"), { autoIncrement: true, generated: "increment" });
      assert.deepEqual(pick("tags", "id"), { autoIncrement: true, generated: "increment" });
      assert.deepEqual(pick("customers", "vip"), { default: false });
      assert.deepEqual(pick("customers", "created_at"), { defaultFunction: "current_timestamp", defaultExpression: "now()" });
      assert.deepEqual(pick("orders", "placed_on"), { defaultFunction: "current_date", defaultExpression: "CURRENT_DATE" });
      assert.deepEqual(pick("customers", "preferences"), { default: {} });
      assert.deepEqual(pick("products", "price"), { default: 0 });
      // A default the sandbox does not compute is kept as information, and said so.
      assert.deepEqual(pick("customers", "external_id"), { generated: "uuid", defaultExpression: "gen_random_uuid()" });
      assert.deepEqual(pick("customers", "name"), {});
    });

    it("reads primary keys over one and several columns, and unique constraints", () => {
      assert.deepEqual(withoutProvenance(table(scanned, "warehouses").primaryKey), { name: "warehouses_pkey", columns: ["region", "code"] });
      assert.deepEqual(withoutProvenance(table(scanned, "stock_levels").primaryKey), { name: "stock_levels_pkey", columns: ["region", "code", "sku"] });
      assert.deepEqual(table(scanned, "customers").columns.filter((entry) => entry.primary).map((entry) => entry.name), ["id"]);
      assert.deepEqual(withoutProvenance(table(scanned, "customers").uniques), [{ name: "customers_email_key", columns: ["email"] }]);
      assert.deepEqual(withoutProvenance(table(scanned, "order_lines").uniques), [{ name: "order_lines_order_id_sku_key", columns: ["order_id", "sku"] }]);
      assert.deepEqual(withoutProvenance(table(scanned, "warehouses").uniques), [{ name: "warehouses_label_key", columns: ["label"] }]);
    });

    it("reads foreign keys over one and several columns, with their actions", () => {
      assert.deepEqual(withoutProvenance(column(scanned, "orders", "customer_id").references), { table: "customers", column: "id", onDelete: "CASCADE", name: "orders_customer_id_fkey" });
      assert.deepEqual(withoutProvenance(column(scanned, "order_lines", "order_id").references), { table: "orders", column: "id", name: "order_lines_order_id_fkey" });
      assert.deepEqual(withoutProvenance(table(scanned, "stock_levels").foreignKeys), [
        { name: "stock_levels_warehouse_fkey", columns: ["region", "code"], references: { table: "warehouses", columns: ["region", "code"] }, onUpdate: "CASCADE" },
      ]);
    });

    it("reads indexes and checks; what the sandbox does not create or enforce is kept as information, and said", () => {
      assert.deepEqual(
        withoutProvenance(table(scanned, "orders").indexes)?.map((index) => [index.name, index.columns, index.where ?? null]),
        [
          ["orders_customer_idx", ["customer_id"], null],
          ["orders_open_idx", ["placed_on"], "state <> 'shipped'::order_state"],
        ],
      );
      assert.deepEqual(
        scanned.collected.report.filter((entry) => entry.outcome === "retained").map((entry) => entry.object),
        ["customers.external_id", "products.products_stock_check", "orders_open_idx", "products_title_lower_idx"],
      );
    });

    it("reads the catalog only: no row, and nothing but reads in one read-only transaction that is rolled back", async () => {
      assert.deepEqual(scanned.collected.seeds, {});
      assert.equal(queries[0], "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      assert.equal(queries.at(-1), "ROLLBACK");
      for (const query of queries.slice(1, -1)) {
        assert.match(query, /^SELECT /, query);
        // What is read is the system catalog: no table of the database is named.
        for (const name of SHOP_TABLES) {
          assert.equal(new RegExp(`\\b${name}\\b`).test(query), false, `${name} in ${query}`);
        }
      }
      // And the source is as it was.
      assert.deepEqual((await server.db.query("SELECT (SELECT count(*) FROM customers)::int AS customers, (SELECT count(*) FROM orders)::int AS orders")).rows, [{ customers: 2, orders: 1 }]);
    });

    it("gives the catalog as the statements the collector read, which hold definitions and no rows", () => {
      assert.match(scanned.script, /^CREATE TYPE "order_state" AS ENUM \('new', 'paid', 'shipped'\);\n/);
      assert.match(scanned.script, /\nALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_warehouse_fkey" FOREIGN KEY \(region, code\) REFERENCES warehouses\(region, code\) ON UPDATE CASCADE;\n/);
      assert.equal(/INSERT|ada@example\.com|Kettle/i.test(scanned.script), false);
      assert.equal(table(scanned, "orders").origin?.file, SCAN_FILE);
    });
  });

  describe("by a role that may read no table", () => {
    it("reads all the same: the catalog shows what information_schema hides from such a role", async () => {
      // `reader` may connect, and use the schema as every role may by default: no privilege on any table.
      const setup = `${SHOP}${SHOP_ROWS}\ncreate role reader login;\n`;
      const owner = await startDisposablePostgres(setup);
      let asOwner: ScannedSchema;
      try {
        asOwner = await scanPostgresDatabase({ connection: { url: owner.url } });
      } finally {
        await owner.stop();
      }
      const server = await startDisposablePostgres(setup, { role: "reader" });
      try {
        // What information_schema shows this role of the constraints: nothing, so a scan through it would find no keys.
        assert.deepEqual((await server.db.query("SELECT count(*)::int AS count FROM information_schema.table_constraints WHERE table_schema = 'public'")).rows, [{ count: 0 }]);
        await assert.rejects(server.db.query("SELECT * FROM public.customers"), /permission denied for table customers/);
        const scanned = await scanPostgresDatabase({ connection: { url: server.url.replace("postgres@", "reader@") } });
        assert.equal(scanned.target.user, "reader");
        assert.deepEqual(withoutProvenance(scanned.collected.tables), withoutProvenance(asOwner.collected.tables));
        assert.deepEqual(scanned.collected.report.map((entry) => entry.message), asOwner.collected.report.map((entry) => entry.message));
      } finally {
        await server.stop();
      }
    });

    it("refuses a schema the role may not use, and says which privilege to grant, which gives no access to rows", async () => {
      // Without USAGE, PostgreSQL writes every name of the schema with the schema in front: the scan would not read its tables as its own.
      const server = await startDisposablePostgres(`${SHOP}\ncreate role reader login;\nrevoke all on schema public from public;\n`, { role: "reader" });
      try {
        const error = await scanPostgresDatabase({ connection: { url: server.url.replace("postgres@", "reader@") } }).then(
          () => assert.fail("expected the scan to fail"),
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof PostgresScanError);
        assert.equal(error.code, "no-usage");
        assert.equal(
          error.message,
          'The user "reader" may not use the schema "public" (it has no USAGE privilege), so PostgreSQL does not write the names of it as the scan reads them. USAGE gives no access to any row: GRANT USAGE ON SCHEMA "public" TO "reader";',
        );
      } finally {
        await server.stop();
      }
    });

    it("says so when the catalog itself was closed to the role, and writes nothing", async () => {
      const server = await startDisposablePostgres(`${SHOP}\ncreate role reader login;\nrevoke select on pg_catalog.pg_class from public;\n`, { role: "reader" });
      try {
        const error = await scanPostgresDatabase({ connection: { url: server.url.replace("postgres@", "reader@") } }).then(
          () => assert.fail("expected the scan to fail"),
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof PostgresConnectionError);
        assert.deepEqual([error.code, error.causeCode], ["permission-denied", "42501"]);
        assert.match(error.message, /^The user "reader" may not read what the scan needs at 127\.0\.0\.1:\d+ \(database "postgres", user "reader"\): permission denied for table pg_class\. The scan reads the system catalog \(pg_catalog\) only/);
      } finally {
        await server.stop();
      }
    });
  });

  describe("of schemas with what the sandbox does not reproduce", () => {
    let server: DisposablePostgres;

    before(async () => {
      server = await startDisposablePostgres(EDGES);
    });
    after(async () => {
      await server.stop();
    });

    const scan = (schemas?: string[]): Promise<ScannedSchema> => scanPostgresDatabase({ connection: { url: server.url }, ...(schemas !== undefined && { schemas }) });
    const failure = async (schemas: string[], url = server.url): Promise<unknown> =>
      scanPostgresDatabase({ connection: { url }, schemas }).then(
        () => assert.fail("expected the scan to fail"),
        (thrown: unknown) => thrown,
      );

    it("says, object by object, what is left out or kept as PostgreSQL's own, and what is unsupported", async () => {
      const scanned = await scan();
      assert.deepEqual(scanned.collected.tables.map((entry) => entry.name), ["accounts", "bookings", "oddities", "orders", "palette"]);
      assert.deepEqual(
        scanned.notes.map((entry) => [entry.outcome, entry.category, entry.object]),
        [
          ["not-reproduced", "views", "public.account_handles"],
          ["not-reproduced", "table", "public.bookings_2026"],
          ["not-reproduced", "extensions", "public.extension_settings"],
          ["not-reproduced", "row-level-security", "public.accounts"],
          ["not-reproduced", "other-schemas", "public.palette.color"],
          ["not-reproduced", "other-schemas", "public.palette.colors"],
          ["not-reproduced", "triggers", "public.accounts"],
        ],
      );
      assert.match(scanned.notes[2]?.message ?? "", /belongs to the extension "plpgsql" and is left out\./);
      assert.match(scanned.notes[4]?.message ?? "", /has the type lookup\.color, of the schema "lookup", which is not read; it is kept as PostgreSQL's own type/);
      // Types the sandbox does not know (a geometric type, a range, a domain, a type of a schema not read) are kept, stored as given, and said.
      assert.deepEqual(
        scanned.collected.report.filter((entry) => entry.outcome === "retained").map((entry) => [entry.object, entry.message.replace(/^.*?(has the type|is a generated)/, "$1")]),
        [
          ["oddities.spot", "has the type point, which the sandbox does not know; its values are stored as they are given."],
          ["oddities.during", "has the type tsrange, which the sandbox does not know; its values are stored as they are given."],
          ["oddities.amount", "has the type positive_int, which the sandbox does not know; its values are stored as they are given."],
          ["oddities.total", "is a generated column; the sandbox does not compute it, so it holds what is written to it."],
          ["palette.color", "has the type lookup.color, which the sandbox does not know; its values are stored as they are given."],
        ],
      );
      assert.deepEqual(column(scanned, "palette", "color").canonicalType, { kind: "other", dialect: "postgresql", name: "lookup.color" });
      assert.deepEqual(column(scanned, "palette", "colors").canonicalType, { kind: "array", element: { kind: "other", dialect: "postgresql", name: "lookup.color" } });
      assert.deepEqual(column(scanned, "oddities", "address").canonicalType, { kind: "other", dialect: "postgresql", name: "inet" });
      // An exclusion constraint the sandbox cannot keep: unsupported.
      assert.deepEqual(
        scanned.collected.report.filter((entry) => entry.outcome === "unsupported").map((entry) => [entry.object, entry.message]),
        [["oddities.oddities_no_overlap", 'EXCLUDE constraint "oddities_no_overlap" is not reproduced locally.']],
      );
      // The partitioned table is one table, with its key.
      assert.deepEqual(withoutProvenance(table(scanned, "bookings").primaryKey), { name: "bookings_pkey", columns: ["id", "starts"] });
    });

    it("reads other schemas than public, with their names without the schema, and says what refers outside them", async () => {
      const scanned = await scan(["archive", "lookup"]);
      assert.deepEqual(scanned.collected.tables.map((entry) => entry.name), ["labels", "orders"]);
      // The enumerated type of a schema that is read is one: the column takes its values.
      assert.deepEqual(column(scanned, "labels", "color").canonicalType, { kind: "enum", name: "color" });
      assert.equal(column(scanned, "labels", "color").default, "green");
      assert.deepEqual(scanned.notes, [
        {
          outcome: "not-reproduced",
          category: "constraint",
          object: "archive.orders.orders_account_id_fkey",
          message: 'The foreign key "orders_account_id_fkey" of archive.orders refers to public.accounts, which is not read (its schema is not one of those read); it is not reproduced, and the column takes any value.',
        },
      ]);
      assert.equal(column(scanned, "orders", "account_id").references, undefined);
    });

    it("refuses schemas that have objects of the same name, and lists them all, instead of keeping one", async () => {
      const error = await failure(["public", "archive"]);
      assert.ok(error instanceof PostgresScanError);
      assert.equal(error.code, "name-conflict");
      assert.equal(
        error.message,
        'The schemas that are read have objects of the same name, and the sandbox has one namespace, so one would replace the other:\n  "orders": table archive.orders, table public.orders\n  "by_account": index public.by_account, index archive.by_account\nRead the schemas one at a time (one --schema each), into databases of their own.',
      );
    });

    it("refuses an empty schema, one without tables, one that is not there, and PostgreSQL's own", async () => {
      const cases: [string[], PostgresScanError["code"], string][] = [
        [["empty_one"], "no-tables", 'The schema "empty_one" has no tables to create.'],
        [["lookup"], "no-tables", 'The schema "lookup" has no tables to create.'],
        [["nowhere", "public", "elsewhere"], "schema-not-found", 'The database has no schema "nowhere", "elsewhere".'],
      ];
      for (const [schemas, code, message] of cases) {
        const error = await failure(schemas);
        assert.ok(error instanceof PostgresScanError, String(error));
        assert.deepEqual([error.code, error.message], [code, message], schemas.join());
      }
      // PostgreSQL's own schemas are refused before anything is connected to: here, a port on which nothing listens.
      const nowhere = `postgresql://postgres@127.0.0.1:${await closedPort()}/postgres`;
      for (const schema of ["pg_catalog", "information_schema", "pg_toast", ""]) {
        const error = await failure([schema], nowhere);
        assert.ok(error instanceof PostgresScanError, String(error));
        assert.equal(error.code, "invalid-schema");
      }
    });

    it("gives up when the server stops answering in the middle of the scan", async () => {
      const proxy = await startProxy(server.port, { answered: 5 });
      try {
        const error = await scanPostgresDatabase({ connection: { url: `postgresql://postgres@127.0.0.1:${proxy.port}/postgres?sslmode=disable`, queryTimeoutMs: 400 } }).then(
          () => assert.fail("expected the scan to fail"),
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof PostgresConnectionError);
        assert.equal(error.code, "timeout");
        assert.match(error.message, /did not finish within 0\.4 s; the connection was closed\.$/);
      } finally {
        await proxy.stop();
      }
    });
  });
});
