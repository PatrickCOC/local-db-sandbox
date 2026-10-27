import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Row } from "../../core/src/index.ts";
import type { CanonicalType, DatabaseSchema, TableSchema } from "../../runtime/src/index.ts";
import { exportPostgresSql } from "../src/postgres/index.ts";
import type { SqlExport, SqlExportMode } from "../src/postgres/index.ts";

/*
 * The SQL export (D-050): tables of a sandbox as a script for PostgreSQL.
 * Every script that is made here is loaded into a new, empty PostgreSQL
 * (PGlite, PostgreSQL 18 in this process), and what PostgreSQL then has is
 * compared with what the sandbox had: the catalog, and the rows.
 */

const INT: CanonicalType = { kind: "integer", bits: 32 };
const BIG: CanonicalType = { kind: "integer", bits: 64 };
const TEXT: CanonicalType = { kind: "text" };

/** A column with its canonical type and the storage type the runtime gives it. */
const col = (name: string, type: CanonicalType, extra: Partial<TableSchema["columns"][number]> = {}): TableSchema["columns"][number] => ({
  name,
  type: type.kind === "integer" ? "integer" : type.kind === "boolean" ? "boolean" : type.kind === "decimal" ? "numeric" : type.kind === "timestamp" ? "datetime" : type.kind === "date" ? "date" : type.kind === "json" || type.kind === "array" ? "json" : type.kind === "binary" ? "binary" : "text",
  canonicalType: type,
  nullable: true,
  primary: false,
  ...extra,
});
const key = (name: string, type: CanonicalType = INT, numbered = false): TableSchema["columns"][number] => col(name, type, { nullable: false, primary: true, ...(numbered && { autoIncrement: true, generated: "increment" }) });

const MOOD = { name: "mood", values: ["ok", "it's \"fine\""] };

/** Tables with keys over one and several columns, foreign keys of both kinds, a unique constraint, defaults, an enumerated type, the common types. */
const SCHEMA: DatabaseSchema = {
  tables: [
    {
      name: "people",
      columns: [
        key("id", INT, true),
        col("email", { kind: "varchar", length: 200 }, { nullable: false }),
        col("name", TEXT),
        col("vip", { kind: "boolean" }, { nullable: false, default: false }),
        col("joined", { kind: "timestamp", withTimeZone: true }, { nullable: false, defaultFunction: "current_timestamp", defaultExpression: "now()" }),
        col("born", { kind: "date" }),
        col("token", { kind: "uuid" }),
        col("settings", { kind: "json", binary: true }, { default: {} }),
        col("mood", { kind: "enum", name: "mood" }, { enum: MOOD, default: "ok" }),
        col("balance", { kind: "decimal", precision: 12, scale: 2 }),
        col("visits", BIG),
        col("tags", { kind: "array", element: TEXT }),
        col("avatar", { kind: "binary" }),
      ],
      uniques: [{ name: "people_email_key", columns: ["email"] }],
    },
    {
      name: "teams",
      columns: [key("region", TEXT), key("code", TEXT), col("label", TEXT, { nullable: false })],
      primaryKey: { name: "teams_pkey", columns: ["region", "code"] },
    },
    {
      name: "members",
      columns: [
        key("person", INT),
        col("region", TEXT, { nullable: false, primary: true }),
        col("code", TEXT, { nullable: false, primary: true }),
        col("role", TEXT, { default: "member" }),
      ],
      primaryKey: { name: "members_pkey", columns: ["person", "region", "code"] },
      foreignKeys: [{ name: "members_team_fkey", columns: ["region", "code"], references: { table: "teams", columns: ["region", "code"] }, onUpdate: "CASCADE" }],
    },
  ],
  types: { enums: [MOOD] },
};
SCHEMA.tables[2]!.columns[0] = { ...SCHEMA.tables[2]!.columns[0]!, references: { table: "people", column: "id", name: "members_person_fkey", onDelete: "CASCADE" } };

const ROWS: Record<string, Row[]> = {
  people: [
    {
      id: 3,
      email: "o'brien@example.com",
      name: 'Zoë "the quote" \\ back\\slash, 日本語, emoji 🎉, tab\tnew\nline',
      vip: true,
      joined: "2026-10-26T07:08:09.123Z",
      born: "1990-02-03",
      token: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      settings: { theme: "dark", nested: { q: "it's", list: [1, null, true] }, "key with \"quotes\"": "x" },
      mood: 'it\'s "fine"',
      balance: 1234.5,
      visits: "9007199254740993",
      tags: ["a", "b'c", null],
      avatar: "AAEC/w==",
    },
    { id: 7, email: "nulls@example.com", name: null, vip: false, joined: "2026-10-26T08:00:00.000Z", born: null, token: null, settings: null, mood: "ok", balance: null, visits: null, tags: null, avatar: null },
  ],
  teams: [
    { region: "eu", code: "1", label: "Europe one" },
    { region: "us", code: "1", label: "US one" },
  ],
  members: [
    { person: 3, region: "eu", code: "1", role: "lead" },
    { person: 7, region: "us", code: "1", role: null },
  ],
};

function exported(result: SqlExport): Extract<SqlExport, { status: "exported" }> {
  assert.equal(result.status, "exported", result.status === "refused" ? JSON.stringify(result.refusals) : "");
  return result as Extract<SqlExport, { status: "exported" }>;
}

/** A new, empty PostgreSQL that has run `scripts`, in order. */
async function load(...scripts: string[]): Promise<PGlite> {
  const db = await PGlite.create();
  for (const script of scripts) {
    await db.exec(script);
  }
  return db;
}

const rowsOf = async (db: PGlite, sql: string): Promise<unknown[]> => (await db.query(sql)).rows;

describe("SQL export for PostgreSQL", { timeout: 120_000 }, () => {
  it("writes the definitions of the tables, which PostgreSQL creates as the sandbox has them", async () => {
    const script = exported(exportPostgresSql({ schema: SCHEMA, mode: "schema" }));
    assert.deepEqual([script.tables, script.rows, script.warnings], [["people", "teams", "members"], 0, []]);
    assert.doesNotMatch(script.sql, /INSERT/);
    assert.match(script.sql, /^-- Local DB Sandbox: SQL export for PostgreSQL\.\n-- Mode: schema only\. Tables \(3\): people, teams, members\.\n/);
    assert.match(script.sql, /\nBEGIN;\n[\s\S]*\nCOMMIT;\n\n-- End of export: \d+ statements\.\n$/);
    const db = await load(script.sql);
    try {
      assert.deepEqual(await rowsOf(db, "SELECT enum_range(NULL::mood)::text AS values"), [{ values: '{ok,"it\'s \\"fine\\""}' }]);
      const constraints = await rowsOf(db, "SELECT conrelid::regclass::text AS t, conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype <> 'n' ORDER BY 1, 2");
      assert.deepEqual(constraints, [
        { t: "members", name: "members_person_fkey", def: "FOREIGN KEY (person) REFERENCES people(id) ON DELETE CASCADE" },
        { t: "members", name: "members_pkey", def: "PRIMARY KEY (person, region, code)" },
        { t: "members", name: "members_team_fkey", def: "FOREIGN KEY (region, code) REFERENCES teams(region, code) ON UPDATE CASCADE" },
        { t: "people", name: "people_email_key", def: "UNIQUE (email)" },
        { t: "people", name: "people_pkey", def: "PRIMARY KEY (id)" },
        { t: "teams", name: "teams_pkey", def: "PRIMARY KEY (region, code)" },
      ]);
      const columns = await rowsOf(
        db,
        "SELECT attname AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS not_null, attidentity AS identity, pg_get_expr(adbin, adrelid) AS default FROM pg_attribute LEFT JOIN pg_attrdef ON adrelid = attrelid AND adnum = attnum WHERE attrelid = 'people'::regclass AND attnum > 0 ORDER BY attnum",
      );
      assert.deepEqual(columns, [
        { name: "id", type: "integer", not_null: true, identity: "d", default: null },
        { name: "email", type: "character varying(200)", not_null: true, identity: "", default: null },
        { name: "name", type: "text", not_null: false, identity: "", default: null },
        { name: "vip", type: "boolean", not_null: true, identity: "", default: "false" },
        { name: "joined", type: "timestamp with time zone", not_null: true, identity: "", default: "now()" },
        { name: "born", type: "date", not_null: false, identity: "", default: null },
        { name: "token", type: "uuid", not_null: false, identity: "", default: null },
        { name: "settings", type: "jsonb", not_null: false, identity: "", default: "'{}'::jsonb" },
        { name: "mood", type: "mood", not_null: false, identity: "", default: "'ok'::mood" },
        { name: "balance", type: "numeric(12,2)", not_null: false, identity: "", default: null },
        { name: "visits", type: "bigint", not_null: false, identity: "", default: null },
        { name: "tags", type: "text[]", not_null: false, identity: "", default: null },
        { name: "avatar", type: "bytea", not_null: false, identity: "", default: null },
      ]);
    } finally {
      await db.close();
    }
  });

  it("writes the rows with their values as they are: NULL, booleans, numbers, dates, quotes, Unicode, JSON, arrays, bytes", async () => {
    const script = exported(exportPostgresSql({ schema: SCHEMA, rows: ROWS, mode: "schema-and-data" }));
    assert.deepEqual([script.tables, script.rows], [["people", "teams", "members"], 6]);
    assert.match(script.sql, /-- It holds the rows of the tables as they are in the sandbox: data you entered, which may be personal\./);
    // Foreign keys come after the rows.
    assert.ok(script.sql.lastIndexOf("INSERT INTO") < script.sql.indexOf('ADD CONSTRAINT "members_person_fkey"'));
    const db = await load(script.sql);
    try {
      const people = await rowsOf(db, "SELECT id, email, name, vip, (joined AT TIME ZONE 'UTC')::text AS joined, born::text, token::text, settings, mood::text, balance::text, visits::text, tags, encode(avatar, 'hex') AS avatar FROM people ORDER BY id");
      assert.deepEqual(people, [
        {
          id: 3,
          email: "o'brien@example.com",
          name: ROWS.people?.[0]?.name,
          vip: true,
          joined: "2026-10-26 07:08:09.123",
          born: "1990-02-03",
          token: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
          settings: ROWS.people?.[0]?.settings,
          mood: 'it\'s "fine"',
          balance: "1234.50",
          visits: "9007199254740993",
          tags: ["a", "b'c", null],
          avatar: "000102ff",
        },
        { id: 7, email: "nulls@example.com", name: null, vip: false, joined: "2026-10-26 08:00:00", born: null, token: null, settings: null, mood: "ok", balance: null, visits: null, tags: null, avatar: null },
      ]);
      assert.deepEqual(await rowsOf(db, "SELECT person, region, code, role FROM members ORDER BY person"), [
        { person: 3, region: "eu", code: "1", role: "lead" },
        { person: 7, region: "us", code: "1", role: null },
      ]);
      // The numbered column goes on after the largest value the rows have.
      assert.deepEqual(await rowsOf(db, "INSERT INTO people (email) VALUES ('next@example.com') RETURNING id"), [{ id: 8 }]);
    } finally {
      await db.close();
    }
  });

  it("writes rows alone for tables that are there, in the order of their foreign keys, and sets the numbering", async () => {
    const schema = exported(exportPostgresSql({ schema: SCHEMA, mode: "schema" }));
    const data = exported(exportPostgresSql({ schema: SCHEMA, rows: ROWS, mode: "data" }));
    assert.doesNotMatch(data.sql, /CREATE TABLE|ALTER TABLE/);
    assert.match(data.sql, /-- Load it into a database that has these tables, empty/);
    // people and teams before members, which refers to both.
    assert.ok(data.sql.indexOf('INSERT INTO "members"') > data.sql.indexOf('INSERT INTO "teams"') && data.sql.indexOf('INSERT INTO "members"') > data.sql.indexOf('INSERT INTO "people"'));
    const db = await load(schema.sql, data.sql);
    try {
      assert.deepEqual(await rowsOf(db, "SELECT (SELECT count(*) FROM people)::int AS people, (SELECT count(*) FROM members)::int AS members"), [{ people: 2, members: 2 }]);
      assert.deepEqual(await rowsOf(db, "INSERT INTO people (email) VALUES ('next@example.com') RETURNING id"), [{ id: 8 }]);
    } finally {
      await db.close();
    }
  });

  it("exports one table, several, or all, and leaves out, and says, a foreign key to a table that is not exported", async () => {
    const one = exported(exportPostgresSql({ schema: { tables: [SCHEMA.tables[2]!], types: SCHEMA.types }, rows: { members: ROWS.members! }, mode: "schema-and-data" }));
    assert.deepEqual(one.tables, ["members"]);
    assert.deepEqual(one.warnings, ['The foreign key of "members" (person) to "people" is left out: "people" is not exported.', 'The foreign key of "members" (region, code) to "teams" is left out: "teams" is not exported.']);
    assert.match(one.sql, /-- Warnings:\n--   The foreign key of "members" \(person\) to "people" is left out/);
    const db = await load(one.sql);
    try {
      assert.deepEqual(await rowsOf(db, "SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f'"), [{ count: 0 }]);
      assert.deepEqual(await rowsOf(db, "SELECT count(*)::int AS count FROM members"), [{ count: 2 }]);
    } finally {
      await db.close();
    }
    const two = exported(exportPostgresSql({ schema: { tables: SCHEMA.tables.slice(0, 2), types: SCHEMA.types }, mode: "schema" }));
    assert.deepEqual([two.tables, two.warnings], [["people", "teams"], []]);
    // Rows alone of a table whose foreign keys go to tables that are not exported: the target has to hold them.
    const rowsAlone = exported(exportPostgresSql({ schema: { tables: [SCHEMA.tables[2]!], types: SCHEMA.types }, rows: { members: ROWS.members! }, mode: "data" }));
    assert.match(rowsAlone.warnings.join("\n"), /Rows refer to tables that are not exported, which the target has to hold already: "members" \(person\) refers to "people"; "members" \(region, code\) refers to "teams"\./);
  });

  it("writes a table without rows as its definition, and no INSERT", async () => {
    const script = exported(exportPostgresSql({ schema: SCHEMA, rows: { people: [], teams: [], members: [] }, mode: "schema-and-data" }));
    assert.equal(script.rows, 0);
    assert.doesNotMatch(script.sql, /INSERT|setval/);
    const db = await load(script.sql);
    await db.close();
    const nothing = exported(exportPostgresSql({ schema: SCHEMA, rows: { people: [], teams: [], members: [] }, mode: "data" }));
    assert.equal(nothing.statements, 0);
    assert.match(nothing.sql, /\nBEGIN;\n\nCOMMIT;\n/);
  });

  it("quotes every name, whatever it holds, and refuses one that PostgreSQL would not keep", async () => {
    const odd: DatabaseSchema = {
      tables: [
        {
          name: 'Order "Lines"; DROP TABLE x; --',
          columns: [key("select", INT, true), col("Mixed Case", TEXT), col('we"ird\nname', TEXT), col("ünïcødé", TEXT)],
        },
      ],
      types: { enums: [] },
    };
    const script = exported(exportPostgresSql({ schema: odd, rows: { 'Order "Lines"; DROP TABLE x; --': [{ select: 1, "Mixed Case": "a", 'we"ird\nname': "b", ünïcødé: "c" }] }, mode: "schema-and-data" }));
    assert.match(script.sql, /CREATE TABLE "Order ""Lines""; DROP TABLE x; --"/);
    // A name in a comment loses its line ends: nothing of it can end the comment.
    assert.match(script.sql, /^-- Mode: schema and data\. Tables \(1\): Order "Lines"; DROP TABLE x; --\./m);
    const db = await load(script.sql);
    try {
      assert.deepEqual(await rowsOf(db, 'SELECT "select", "Mixed Case", "we""ird\nname" AS weird, "ünïcødé" FROM "Order ""Lines""; DROP TABLE x; --"'), [{ select: 1, "Mixed Case": "a", weird: "b", ünïcødé: "c" }]);
      assert.deepEqual(await rowsOf(db, "SELECT count(*)::int AS tables FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace"), [{ tables: 1 }]);
    } finally {
      await db.close();
    }
    const tooLong = "t".repeat(64);
    const refused = exportPostgresSql({ schema: { tables: [{ name: tooLong, columns: [key("id")] }], types: { enums: [] } }, mode: "schema" });
    assert.equal(refused.status, "refused");
  });

  it("loads tables that refer to one another, and to themselves, in any order: the foreign keys come after the rows", async () => {
    const cyclic: DatabaseSchema = {
      tables: [
        { name: "a", columns: [key("id"), col("b_id", INT, { references: { table: "b", column: "id", name: "a_b_fkey" } })] },
        { name: "b", columns: [key("id"), col("a_id", INT, { references: { table: "a", column: "id", name: "b_a_fkey" } })] },
        { name: "nodes", columns: [key("id"), col("parent", INT, { references: { table: "nodes", column: "id", name: "nodes_parent_fkey" } })] },
      ],
      types: { enums: [] },
    };
    const rows = {
      a: [{ id: 1, b_id: 10 }],
      b: [{ id: 10, a_id: 1 }],
      // The child before its parent, as the sandbox happens to hold them.
      nodes: [
        { id: 2, parent: 1 },
        { id: 3, parent: 2 },
        { id: 1, parent: null },
      ],
    };
    const both = exported(exportPostgresSql({ schema: cyclic, rows, mode: "schema-and-data" }));
    assert.deepEqual(both.warnings, []);
    const db = await load(both.sql);
    try {
      assert.deepEqual(await rowsOf(db, "SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f'"), [{ count: 3 }]);
      assert.deepEqual(await rowsOf(db, "SELECT id, parent FROM nodes ORDER BY id"), [{ id: 1, parent: null }, { id: 2, parent: 1 }, { id: 3, parent: 2 }]);
    } finally {
      await db.close();
    }
    // Rows alone: what refers to itself is put in its order; what refers in a circle is said, and loads where the target's foreign keys are DEFERRABLE.
    const data = exported(exportPostgresSql({ schema: cyclic, rows, mode: "data" }));
    assert.equal(data.warnings.length, 1);
    assert.match(data.warnings[0] ?? "", /^"a", "b", "nodes" refer to one another or to themselves\. The rows are loaded in one order; where the foreign keys of the target are not DEFERRABLE, a row may come before the row it refers to and be refused\. Export schema and data together to load them without that\.$/);
    assert.match(data.sql, /\nSET CONSTRAINTS ALL DEFERRED;\n/);
    assert.ok(data.sql.indexOf("(1, NULL)") < data.sql.indexOf("(2, 1)") && data.sql.indexOf("(2, 1)") < data.sql.indexOf("(3, 2)"));
    const deferrable = [
      "CREATE TABLE a (id integer PRIMARY KEY, b_id integer);",
      "CREATE TABLE b (id integer PRIMARY KEY, a_id integer REFERENCES a (id) DEFERRABLE);",
      "ALTER TABLE a ADD FOREIGN KEY (b_id) REFERENCES b (id) DEFERRABLE;",
      "CREATE TABLE nodes (id integer PRIMARY KEY, parent integer REFERENCES nodes (id));",
    ].join("\n");
    const target = await load(deferrable, data.sql);
    try {
      assert.deepEqual(await rowsOf(target, "SELECT (SELECT count(*) FROM a)::int AS a, (SELECT count(*) FROM b)::int AS b, (SELECT count(*) FROM nodes)::int AS nodes"), [{ a: 1, b: 1, nodes: 3 }]);
    } finally {
      await target.close();
    }
  });

  it("is refused as a whole, with every reason, when a value or a definition cannot be written as what it is", async () => {
    const wrong = exportPostgresSql({ schema: SCHEMA, rows: { ...ROWS, people: [{ ...ROWS.people![0]!, vip: "yes" }, { ...ROWS.people![1]!, visits: 1.5 }] }, mode: "schema-and-data" });
    assert.equal(wrong.status, "refused");
    assert.deepEqual(
      wrong.status === "refused" && wrong.refusals.map((refusal) => [refusal.table, refusal.column, refusal.message]),
      [
        ["people", "vip", 'Row 1: "yes" is not true or false.'],
        ["people", "visits", "Row 2: 1.5 is not a whole number."],
      ],
    );
    assert.equal("sql" in wrong, false);
    // A column of which the schema does not say what its type is: definitions cannot be written; rows alone can, and say so.
    const untyped: DatabaseSchema = { tables: [{ name: "plain", columns: [{ name: "id", type: "integer", nullable: false, primary: true }, { name: "note", type: "text", nullable: true, primary: false }] }], types: { enums: [] } };
    const definitions = exportPostgresSql({ schema: untyped, mode: "schema" });
    assert.equal(definitions.status, "refused");
    assert.match(definitions.status === "refused" ? (definitions.refusals[0]?.message ?? "") : "", /says how its type was spelled, and not what the type is/);
    const rowsAlone = exported(exportPostgresSql({ schema: untyped, rows: { plain: [{ id: 1, note: "o'k" }] }, mode: "data" }));
    assert.deepEqual(rowsAlone.warnings, ['"plain": id, note have no type of the database in the sandbox\'s schema; their values are written as constants that PostgreSQL reads into the type the column has where the script is loaded.']);
    const db = await load("CREATE TABLE plain (id bigint PRIMARY KEY, note varchar(10));", rowsAlone.sql);
    try {
      assert.deepEqual(await rowsOf(db, "SELECT id::int AS id, note FROM plain"), [{ id: 1, note: "o'k" }]);
    } finally {
      await db.close();
    }
  });

  it("is refused when the script would be larger than an export may be, and when nothing or no rows are given", () => {
    const many = { people: Array.from({ length: 2_000 }, (_unused, index) => ({ ...ROWS.people![1]!, id: index + 1, email: `p${index}@example.com` })), teams: [], members: [] };
    const big = exportPostgresSql({ schema: SCHEMA, rows: many, mode: "data", maxBytes: 50_000 });
    assert.equal(big.status, "refused");
    assert.match(big.status === "refused" ? (big.refusals[0]?.message ?? "") : "", /^The script would have \d+ bytes, and an export may have 50000\. Export fewer tables, or the schema alone\.$/);
    const within = exported(exportPostgresSql({ schema: SCHEMA, rows: many, mode: "data" }));
    // A hundred rows to an INSERT.
    assert.equal((within.sql.match(/INSERT INTO "people"/g) ?? []).length, 20);
    assert.deepEqual(exportPostgresSql({ schema: { tables: [], types: { enums: [] } }, mode: "schema" }), { status: "refused", refusals: [{ message: "No table was chosen to export." }] });
    for (const mode of ["data", "schema-and-data"] as SqlExportMode[]) {
      assert.equal(exportPostgresSql({ schema: SCHEMA, mode }).status, "refused");
    }
  });

  it("gives the same script for the same tables and rows", () => {
    const first = exported(exportPostgresSql({ schema: SCHEMA, rows: ROWS, mode: "schema-and-data" }));
    const again = exported(exportPostgresSql({ schema: structuredClone(SCHEMA), rows: structuredClone(ROWS), mode: "schema-and-data" }));
    assert.equal(first.sql, again.sql);
  });
});
