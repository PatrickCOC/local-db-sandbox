import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TableSchema } from "../../runtime/src/index.ts";
import { JsonStorageError, assignTableFiles, isSafeTableFile, mergeSchemas, parseSchemaDocument, sameSchema, tableFileBase, toSchemaDocument } from "../src/index.ts";

describe("table file names", () => {
  it("keeps ordinary table names as they are", () => {
    assert.deepEqual(["users", "user_role", "Order-Items", "t2"].map(tableFileBase), ["users", "user_role", "Order-Items", "t2"]);
  });

  it("encodes every character that is not safe in a file name on every platform", () => {
    assert.equal(tableFileBase("audit.log"), "audit%2Elog");
    assert.equal(tableFileBase("my table"), "my%20table");
    assert.equal(tableFileBase("a/b\\c:d*e?f\"g<h>i|j"), "a%2Fb%5Cc%3Ad%2Ae%3Ff%22g%3Ch%3Ei%7Cj");
    assert.equal(tableFileBase("../../etc/passwd"), "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd");
    assert.equal(tableFileBase("100%"), "100%25");
    assert.equal(tableFileBase("a~2"), "a%7E2");
    assert.equal(tableFileBase("café"), "caf%C3%A9");
    assert.equal(tableFileBase("表"), "%E8%A1%A8");
    assert.equal(tableFileBase("line\nbreak"), "line%0Abreak");
  });

  it("avoids names that are reserved or awkward on some platforms", () => {
    // Windows device names are reserved whatever the extension.
    assert.deepEqual(["con", "PRN", "aux", "nul", "com1", "LPT9"].map(tableFileBase), ["%63on", "%50RN", "%61ux", "%6Eul", "%63om1", "%4CPT9"]);
    assert.equal(tableFileBase("console"), "console");
    assert.equal(tableFileBase("-rf"), "%2Drf");
    assert.equal(tableFileBase(""), "~empty");
  });

  it("shortens very long names, keeping them distinct", () => {
    const long = "t".repeat(300);
    const other = `${"t".repeat(299)}x`;
    assert.ok(tableFileBase(long).length <= 100);
    assert.match(tableFileBase(long), /^t{91}~[0-9a-f]{8}$/);
    assert.notEqual(tableFileBase(long), tableFileBase(other));
    // The same name always gets the same file name.
    assert.equal(tableFileBase(long), tableFileBase(long));
  });

  it("gives every table its own file, also on file systems that ignore case", () => {
    const files = assignTableFiles(["Users", "users", "USERS", "orders", "a b", "a%20b"], new Map());
    assert.deepEqual([...files], [
      ["Users", "Users.json"],
      ["users", "users~2.json"],
      ["USERS", "USERS~3.json"],
      ["orders", "orders.json"],
      ["a b", "a%20b.json"],
      ["a%20b", "a%2520b.json"],
    ]);
    assert.equal(new Set([...files.values()].map((file) => file.toLowerCase())).size, 6);
  });

  it("keeps the files that tables already have", () => {
    const existing = new Map([["users", "people.json"], ["gone", "gone.json"]]);
    assert.deepEqual([...assignTableFiles(["orders", "users", "people"], existing)], [
      ["orders", "orders.json"],
      ["users", "people.json"],
      ["people", "people~2.json"],
    ]);
  });

  it("accepts only plain file names from a manifest", () => {
    for (const file of ["users.json", "a%20b.json", "Users~2.json", "x-y_z.json"]) {
      assert.equal(isSafeTableFile(file), true, file);
    }
    for (const file of ["../users.json", "sub/users.json", "sub\\users.json", "users", "users.txt", ".json", "con.json", "a b.json", "C:x.json", ".hidden.json", "a..json"]) {
      assert.equal(isSafeTableFile(file), false, file);
    }
  });
});

describe("schema document", () => {
  const tables: TableSchema[] = [
    {
      name: "user_role",
      columns: [
        { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true, generated: "increment" },
        { name: "user_role", key: "userRole", type: "text", nullable: false, primary: false, default: "client_admin" },
        { name: "active", type: "boolean", nullable: false, primary: false, default: true },
        { name: "settings", type: "json", nullable: true, primary: false, default: { theme: "light" } },
      ],
    },
    {
      name: "user",
      columns: [
        { name: "uuid", type: "text", nullable: false, primary: true, generated: "uuid" },
        { name: "role_id", key: "roleId", type: "integer", nullable: true, primary: false, references: { table: "user_role", column: "id", onDelete: "SET NULL" } },
        { name: "createdAt", type: "datetime", nullable: false, primary: false },
        { name: "balance", type: "numeric", nullable: true, primary: false },
      ],
    },
    {
      name: "membership",
      columns: [
        { name: "accountId", type: "integer", nullable: false, primary: true, references: { table: "user", column: "uuid" } },
        { name: "groupId", type: "integer", nullable: false, primary: true },
      ],
    },
  ];

  it("writes table, property, and column names, types, keys, generation, defaults, and references", () => {
    assert.deepEqual(toSchemaDocument(tables), {
      schemaVersion: 2,
      tables: [
        {
          name: "user_role",
          columns: [
            { column: "id", property: "id", type: "integer", nullable: false, primaryKey: true, generated: "increment" },
            { column: "user_role", property: "userRole", type: "text", nullable: false, primaryKey: false, default: "client_admin" },
            { column: "active", property: "active", type: "boolean", nullable: false, primaryKey: false, default: true },
            { column: "settings", property: "settings", type: "json", nullable: true, primaryKey: false, default: { theme: "light" } },
          ],
        },
        {
          name: "user",
          columns: [
            { column: "uuid", property: "uuid", type: "text", nullable: false, primaryKey: true, generated: "uuid" },
            { column: "role_id", property: "roleId", type: "integer", nullable: true, primaryKey: false, references: { table: "user_role", column: "id", onDelete: "SET NULL" } },
            { column: "createdAt", property: "createdAt", type: "datetime", nullable: false, primaryKey: false },
            { column: "balance", property: "balance", type: "numeric", nullable: true, primaryKey: false },
          ],
        },
        {
          name: "membership",
          columns: [
            { column: "accountId", property: "accountId", type: "integer", nullable: false, primaryKey: true, references: { table: "user", column: "uuid" } },
            { column: "groupId", property: "groupId", type: "integer", nullable: false, primaryKey: true },
          ],
        },
      ],
    });
  });

  it("reads back exactly the tables it wrote", () => {
    assert.deepEqual(parseSchemaDocument(JSON.parse(JSON.stringify(toSchemaDocument(tables))), "schema.json"), tables);
  });

  it("lets the database generate an integer key only for a single integer primary key", () => {
    const read = (columns: object[]): unknown =>
      parseSchemaDocument({ schemaVersion: 1, tables: [{ name: "t", columns }] }, "schema.json")[0]?.columns.map((column) => [column.name, column.generated, column.autoIncrement ?? false]);
    const base = { type: "integer", nullable: false };
    assert.deepEqual(read([{ column: "id", ...base, primaryKey: true, generated: "increment" }]), [["id", "increment", true]]);
    assert.deepEqual(read([{ column: "id", type: "text", nullable: false, primaryKey: true, generated: "uuid" }]), [["id", "uuid", false]]);
    // Not the only key column, or not a key at all: the strategy is kept as information.
    assert.deepEqual(read([{ column: "a", ...base, primaryKey: true, generated: "increment" }, { column: "b", ...base, primaryKey: true }]), [["a", "increment", false], ["b", undefined, false]]);
    assert.deepEqual(read([{ column: "id", ...base, primaryKey: true }, { column: "n", ...base, generated: "increment" }]), [["id", undefined, false], ["n", "increment", false]]);
  });

  it("fills in what a hand-written schema leaves out", () => {
    const [table] = parseSchemaDocument({ tables: [{ name: "notes", columns: [{ column: "id", type: "integer", primaryKey: true }, { column: "text", type: "text" }] }] }, "schema.json");
    assert.deepEqual(table, {
      name: "notes",
      columns: [
        { name: "id", type: "integer", nullable: false, primary: true },
        { name: "text", type: "text", nullable: true, primary: false },
      ],
    });
    assert.deepEqual(parseSchemaDocument({ tables: [] }, "schema.json"), []);
  });

  it("refuses a schema it cannot use, saying where the problem is", () => {
    const refused = (document: unknown, message: RegExp): void => {
      assert.throws(() => parseSchemaDocument(document, "schema.json"), (error) => {
        assert.ok(error instanceof JsonStorageError, String(error));
        assert.match(error.message, message);
        return true;
      });
    };
    const column = { column: "id", type: "integer" };
    refused([], /schema\.json must be an object with a "tables" list/);
    refused({ schemaVersion: 3, tables: [] }, /schema\.json has schemaVersion 3; this version reads schemaVersion 1 and 2/);
    refused({ tables: [{ name: "", columns: [column] }] }, /schema\.json: table 1 needs a name/);
    refused({ tables: [{ name: "t", columns: [] }] }, /schema\.json: table "t" needs at least one column/);
    refused({ tables: [{ name: "t", columns: [column] }, { name: "t", columns: [column] }] }, /schema\.json: table "t" is defined more than once/);
    refused({ tables: [{ name: "t", columns: [{ type: "integer" }] }] }, /schema\.json: column 1 of table "t" needs a "column" name/);
    refused({ tables: [{ name: "t", columns: [{ column: "id", type: "serial" }] }] }, /schema\.json: column "id" of table "t" has the type "serial"; expected one of integer, real, numeric, text, boolean, datetime, date, json, binary, any/);
    refused({ tables: [{ name: "t", columns: [{ ...column, nullable: "no" }] }] }, /schema\.json: "nullable" of column "id" of table "t" must be true or false/);
    refused({ tables: [{ name: "t", columns: [{ ...column, nullabel: true }] }] }, /schema\.json: column "id" of table "t" has the unknown key "nullabel"/);
    refused({ tables: [{ name: "t", columns: [column, column] }] }, /schema\.json: column "id" of table "t" is defined more than once/);
    refused({ tables: [{ name: "t", columns: [{ ...column, references: { table: "other" } }] }] }, /schema\.json: "references" of column "id" of table "t" needs a "table" and a "column"/);
    refused({ tables: [{ name: "t", columns: [column], rows: [] }] }, /schema\.json: table "t" has the unknown key "rows"/);
  });
});

describe("comparing and combining table definitions", () => {
  const table = (name: string, ...columns: string[]): TableSchema => ({ name, columns: columns.map((column) => ({ name: column, type: "text", nullable: true, primary: false })) });

  it("calls definitions the same when they would be stored as the same document", () => {
    const users = table("users", "id", "name");
    assert.equal(sameSchema([users], [structuredClone(users)]), true);
    // How a column is held in memory does not matter: a key equal to the name is the name.
    assert.equal(sameSchema([users], [{ name: "users", columns: users.columns.map((column) => ({ ...column, key: column.name })) }]), true);
    assert.equal(sameSchema(undefined, []), true);

    assert.equal(sameSchema([users], [table("users", "id")]), false);
    assert.equal(sameSchema([users], [table("users", "name", "id")]), false);
    assert.equal(sameSchema([users], [{ ...users, columns: users.columns.map((column) => ({ ...column, nullable: false })) }]), false);
    assert.equal(sameSchema([users], []), false);
  });

  it("replaces the tables that are given again and keeps the others, in their places", () => {
    const stored = [table("users", "id"), table("orders", "id"), table("notes", "text")];
    const usersNow = table("users", "id", "email");
    const audit = table("audit", "id");

    assert.deepEqual(mergeSchemas(stored, [audit, usersNow]), [usersNow, stored[1], stored[2], audit]);
    assert.deepEqual(mergeSchemas(undefined, [audit]), [audit]);
    assert.deepEqual(mergeSchemas(stored, []), stored);
    // Giving the same definitions again changes nothing, whatever their order.
    assert.equal(sameSchema(mergeSchemas(stored, [stored[2] as TableSchema, stored[0] as TableSchema]), stored), true);
  });
});
