import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { TableSchema } from "../../runtime/src/index.ts";
import { DirectoryStorageAdapter, JsonStorageAdapter, JsonStorageError, createDatabase, parseSchemaDocument, toSchemaDocument } from "../src/index.ts";
import { beyondFileFormat } from "../src/schema-document.ts";

/*
 * Table definitions beyond columns and single-column keys: unique
 * constraints, foreign keys over several columns, indexes, checks,
 * enumerated values, and computed defaults (directory format 4). A database
 * directory stores them; a single file (format 1) refuses them. An
 * enumerated type is stored once, under `types.enums`, and columns name it
 * (D-036); in memory, a column has the type's values resolved.
 */

const SCHEMA: TableSchema[] = [
  {
    name: "accounts",
    columns: [
      { name: "id", type: "integer", declaredType: "int8", nullable: false, primary: true },
      { name: "region", type: "text", nullable: false, primary: false },
      { name: "email", type: "text", nullable: false, primary: false },
      {
        name: "status",
        type: "text",
        declaredType: "account_status",
        nullable: false,
        primary: false,
        default: "active",
        enum: { name: "account_status", values: ["active", "closed"] },
      },
      { name: "created_at", type: "datetime", declaredType: "timestamptz", nullable: false, primary: false, defaultFunction: "current_timestamp", defaultExpression: "now()" },
      { name: "token", type: "text", declaredType: "uuid", nullable: true, primary: false, generated: "uuid", defaultExpression: "gen_random_uuid()" },
    ],
    uniques: [{ name: "accounts_email_key", columns: ["email"] }, { columns: ["region", "email"] }],
    indexes: [
      { name: "accounts_region_idx", columns: ["region"] },
      { name: "accounts_email_lower_idx", columns: [], unique: true, expressions: ["lower(email)"] },
      { name: "accounts_open_idx", columns: ["region"], where: "status = 'active'" },
    ],
    checks: [{ name: "accounts_email_check", expression: "email <> ''" }],
  },
  {
    name: "memberships",
    columns: [
      { name: "account_id", type: "integer", nullable: false, primary: true, references: { table: "accounts", column: "id", onDelete: "CASCADE", onUpdate: "CASCADE", name: "memberships_account_fkey" } },
      { name: "region", type: "text", nullable: false, primary: true },
      { name: "email", type: "text", nullable: false, primary: false },
      { name: "since", type: "date", nullable: true, primary: false, defaultFunction: "current_date" },
    ],
    foreignKeys: [{ name: "memberships_owner_fkey", columns: ["region", "email"], references: { table: "accounts", columns: ["region", "email"] }, onDelete: "SET NULL", onUpdate: "NO ACTION" }],
  },
];

const PLAIN: TableSchema[] = [
  {
    name: "notes",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "author", type: "integer", nullable: true, primary: false, references: { table: "people", column: "id", onDelete: "SET NULL" } },
      { name: "text", type: "text", nullable: false, primary: false, default: "" },
    ],
  },
];

describe("constraints, indexes, enumerated values, and computed defaults in the schema document", () => {
  it("are written, and read back exactly", () => {
    const document = toSchemaDocument(SCHEMA);
    const [accounts, memberships] = document.tables;
    assert.deepEqual(accounts?.uniques, SCHEMA[0]?.uniques);
    assert.deepEqual(accounts?.indexes, SCHEMA[0]?.indexes);
    assert.deepEqual(accounts?.checks, SCHEMA[0]?.checks);
    assert.deepEqual(memberships?.foreignKeys, SCHEMA[1]?.foreignKeys);
    assert.deepEqual(accounts?.columns[3], {
      column: "status",
      property: "status",
      type: "text",
      declaredType: "account_status",
      nullable: false,
      primaryKey: false,
      default: "active",
      enum: "account_status",
    });
    // The type is stored once, at the level of the schema.
    assert.deepEqual(document.types, { enums: [{ name: "account_status", values: ["active", "closed"] }] });
    assert.deepEqual([accounts?.columns[4]?.defaultFunction, accounts?.columns[4]?.defaultExpression], ["current_timestamp", "now()"]);
    assert.deepEqual(memberships?.columns[0]?.references, { table: "accounts", column: "id", onDelete: "CASCADE", onUpdate: "CASCADE", name: "memberships_account_fkey" });

    // Through JSON, as it is stored.
    assert.deepEqual(parseSchemaDocument(JSON.parse(JSON.stringify(document)), "schema.json"), SCHEMA);
  });

  it("are left out of the document of a table that has none, which is then what it always was", () => {
    assert.deepEqual(Object.keys(toSchemaDocument(PLAIN).tables[0] ?? {}), ["name", "columns"]);
    assert.deepEqual(toSchemaDocument(PLAIN).tables[0]?.columns[1]?.references, { table: "people", column: "id", onDelete: "SET NULL" });
    // Empty lists are not kept either way.
    assert.deepEqual(Object.keys(toSchemaDocument([{ ...(PLAIN[0] as TableSchema), uniques: [], indexes: [] }]).tables[0] ?? {}), ["name", "columns"]);
    const read = parseSchemaDocument({ tables: [{ name: "t", columns: [{ column: "id", type: "integer", primaryKey: true }], uniques: [], checks: [] }] }, "schema.json");
    assert.deepEqual(Object.keys(read[0] ?? {}), ["name", "columns"]);
  });

  it("are refused when they cannot be used, saying where the problem is", () => {
    const column = { column: "id", type: "integer", primaryKey: true };
    const table = (more: Record<string, unknown>, columns: unknown[] = [column, { column: "code", type: "text" }]) => ({ tables: [{ name: "t", columns, ...more }] });
    const refusals: [unknown, RegExp][] = [
      [table({ uniques: [{ columns: ["code"], clustered: true }] }), /entry 1 of "uniques" of table "t" has the unknown key "clustered"/],
      [table({ uniques: [{ columns: ["missing"] }] }), /entry 1 of "uniques" of table "t" names the column "missing", which table "t" does not have/],
      [table({ uniques: [{ columns: [] }] }), /entry 1 of "uniques" of table "t" needs a list of column names/],
      [table({ uniques: "code" }), /"uniques" of table "t" must be a list/],
      [table({ indexes: [{ columns: ["code"] }] }), /entry 1 of "indexes" of table "t" needs a "name"/],
      [table({ indexes: [{ name: "i", columns: ["code"], unique: "yes" }] }), /"unique" of entry 1 of "indexes" of table "t" must be true or false/],
      [table({ indexes: [{ name: "i", columns: ["nope"] }] }), /names the column "nope", which table "t" does not have/],
      [table({ foreignKeys: [{ columns: ["code"], references: { table: "u" } }] }), /"references" of entry 1 of "foreignKeys" of table "t" needs a "table" and a list of "columns"/],
      [table({ foreignKeys: [{ columns: ["code"], references: { table: "u", columns: ["x"], match: "full" } }] }), /"references" of entry 1 of "foreignKeys" of table "t" has the unknown key "match"/],
      [table({ checks: [{ name: "c" }] }), /entry 1 of "checks" of table "t" needs an "expression"/],
      [table({ partitions: [] }), /table "t" has the unknown key "partitions"/],
      [table({}, [column, { column: "at", type: "datetime", default: "2026-01-01T00:00:00Z", defaultFunction: "current_timestamp" }]), /column "at" of table "t" has both "default" and "defaultFunction"; it can have one/],
      [table({}, [column, { column: "at", type: "datetime", defaultFunction: "now" }]), /"defaultFunction" of column "at" of table "t" must be one of current_timestamp, current_date/],
      [table({}, [column, { column: "at", type: "datetime", defaultExpression: "" }]), /"defaultExpression" of column "at" of table "t" must be text/],
      [table({}, [column, { column: "s", type: "text", enum: { name: "mood", values: ["a"] } }]), /"enum" of column "s" of table "t" is an inline definition\. Declare the enumerated type once, under "types"/],
      [table({}, [column, { column: "s", type: "text", enum: "mood" }]), /"enum" of column "s" of table "t" names the enumerated type "mood", which "types\.enums" does not define/],
      [table({}, [column, { column: "s", type: "text", enum: 1 }]), /"enum" of column "s" of table "t" must name an enumerated type of "types\.enums"/],
      [table({}, [{ ...column, references: { table: "u", column: "id", onUpdate: 1 } }]), /"onUpdate" of column "id" of table "t" must be text such as "CASCADE"/],
      [table({}, [{ ...column, references: { table: "u", column: "id", match: "full" } }]), /"references" of column "id" of table "t" has the unknown key "match"/],
    ];
    for (const [document, message] of refusals) {
      assert.throws(
        () => parseSchemaDocument(document, "schema.json"),
        (error: unknown) => error instanceof JsonStorageError && message.test(error.message),
        message.source,
      );
    }
  });

  it("are named, table by table, as what a single-file database cannot store", () => {
    assert.deepEqual(beyondFileFormat(PLAIN), []);
    assert.deepEqual(beyondFileFormat(SCHEMA), [
      "accounts: unique constraints, indexes, check constraints, enumerated values, computed defaults",
      "memberships: foreign keys over several columns, computed defaults, named foreign keys or ON UPDATE actions",
    ]);
  });
});

describe("where such definitions are stored", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-constraints-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("a database directory stores them in its schema file, and reads them back", async () => {
    const path = join(dir, "constraints.db");
    await createDatabase(path, { collections: { accounts: [], memberships: [] }, schema: SCHEMA }, { format: "directory" });
    const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    assert.deepEqual([manifest.formatVersion, manifest.minimumReaderVersion], [5, 5]);
    const stored = JSON.parse(await readFile(join(path, manifest.schema), "utf8"));
    assert.deepEqual(stored.tables[0].uniques, SCHEMA[0]?.uniques);

    const storage = new DirectoryStorageAdapter(path);
    await storage.load();
    assert.deepEqual(storage.schema, SCHEMA);
  });

  it("a database directory refuses definitions that it could not read back, and writes nothing", async () => {
    // A key over no columns, and a type that is not a canonical type: what a source of definitions with a defect may hand over.
    const withoutColumns: TableSchema[] = [{ name: "t", columns: [{ name: "id", type: "integer", nullable: false, primary: false }], primaryKey: { name: "t_pkey", columns: [] } }];
    const withBadType: TableSchema[] = [{ name: "t", columns: [{ name: "id", type: "integer", nullable: false, primary: true, canonicalType: { kind: "decimal", precision: 5, scale: 1.5 } }] }];
    const refusal =
      (problem: RegExp) =>
      (error: unknown): boolean =>
        error instanceof JsonStorageError && error.message.includes("cannot store these table definitions, because it could not read them back") && problem.test(error.message);
    const path = join(dir, "unreadable.db");
    await assert.rejects(createDatabase(path, { collections: { t: [] }, schema: withoutColumns }, { format: "directory" }), refusal(/unreadable\.db cannot store .*: "primaryKey" of table "t" needs a list of column names\./));
    await assert.rejects(createDatabase(path, { collections: { t: [] }, schema: withBadType }, { format: "directory" }), refusal(/"canonicalType" of column "id" of table "t" is not a canonical type: "scale" must be a whole number/));
    await assert.rejects(readFile(join(path, "manifest.json"), "utf8"), { code: "ENOENT" });

    // Nor are they saved into a database that exists: it stays as it was, and can still be read.
    const existing = join(dir, "kept.db");
    await createDatabase(existing, { collections: { notes: [] }, schema: PLAIN }, { format: "directory" });
    const manifest = await readFile(join(existing, "manifest.json"), "utf8");
    const storage = new DirectoryStorageAdapter(existing);
    const state = await storage.load();
    storage.describe(withoutColumns);
    assert.throws(() => storage.saveSync(state), refusal(/kept\.db cannot store/));
    assert.equal(await readFile(join(existing, "manifest.json"), "utf8"), manifest);
    const reread = new DirectoryStorageAdapter(existing);
    await reread.load();
    assert.deepEqual(toSchemaDocument(reread.schema ?? []), toSchemaDocument(PLAIN));
  });

  it("a single-file database refuses to save them, and writes nothing", async () => {
    const path = join(dir, "refused.db.json");
    const refusal = (error: unknown): boolean =>
      error instanceof JsonStorageError &&
      /refused\.db\.json would hold table definitions that a single-file database cannot store \(accounts: unique constraints, .*; memberships: foreign keys over several columns, .*\)\. Use a database directory/.test(error.message);
    await assert.rejects(createDatabase(path, { collections: { accounts: [] }, schema: SCHEMA }, { format: "file" }), refusal);
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });

    // Nor are they added to a file that exists.
    const existing = join(dir, "existing.db.json");
    await createDatabase(existing, { collections: { notes: [] }, schema: PLAIN }, { format: "file" });
    const text = await readFile(existing, "utf8");
    const storage = new JsonStorageAdapter(existing);
    const state = await storage.load();
    // As an integration does when it gives the definitions it knows.
    storage.describe(SCHEMA);
    assert.throws(() => storage.saveSync(state), (error: unknown) => error instanceof JsonStorageError && /existing\.db\.json would hold table definitions that a single-file database cannot store/.test(error.message));
    assert.equal(await readFile(existing, "utf8"), text);
  });

  it("a single-file database that holds them is refused when it is read", async () => {
    const path = join(dir, "hand-written.db.json");
    await writeFile(path, JSON.stringify({ $meta: { version: 1 }, $tableSchema: toSchemaDocument(SCHEMA), data: { accounts: [], memberships: [] } }));
    await assert.rejects(
      new JsonStorageAdapter(path).load(),
      (error: unknown) =>
        error instanceof JsonStorageError &&
        /hand-written\.db\.json holds table definitions that a single-file database cannot store \(enumerated types: account_status; accounts: .*\)\. Use a database directory/.test(error.message),
    );
  });

  it("a single-file database with plain table definitions is stored and read as before", async () => {
    const path = join(dir, "plain.db.json");
    await createDatabase(path, { collections: { notes: [{ id: 1, author: null, text: "hi" }] }, schema: PLAIN }, { format: "file" });
    const document = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(Object.keys(document), ["$meta", "$tableSchema", "data"]);
    assert.deepEqual(document.$meta, { version: 1 });
    // A single file's schema document is of version 1, as it has always been.
    assert.deepEqual(document.$tableSchema, { ...toSchemaDocument(PLAIN), schemaVersion: 1 });
    const storage = new JsonStorageAdapter(path);
    assert.deepEqual((await storage.load()).collections, { notes: [{ id: 1, author: null, text: "hi" }] });
    assert.deepEqual(toSchemaDocument(storage.schema ?? []), toSchemaDocument(PLAIN));
  });
});
