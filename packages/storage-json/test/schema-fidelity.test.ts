import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseSchema, TableSchema } from "../../runtime/src/index.ts";
import { JsonStorageError, readSchemaDocument, toSchemaDocument } from "../src/index.ts";
import { SCHEMA_VERSION, beyondFileFormat, toFileSchemaDocument } from "../src/schema-document.ts";

/*
 * What schema document version 2 holds beyond version 1 (D-040, directory
 * format 5): how an index is built and what its keys are, whether a key or a
 * foreign key is deferrable, the clauses of a source that the schema has no
 * place for, and what the text of an expression names, with what each of
 * those things is called now.
 *
 * A version 1 document has none of it. It is still read, by the rule for
 * such documents: what it could not say is not taken to be said.
 */

const position = (statement: number, file = "0001_init.sql") => ({ source: "postgresql-migrations", file, sha256: "a".repeat(64), statement, line: statement });
const origin = (name: string, statement = 1) => ({ ...position(statement), name });

const DOCS: TableSchema = {
  name: "docs",
  columns: [
    { name: "id", type: "integer", nullable: false, primary: true },
    {
      name: "owner",
      type: "integer",
      nullable: true,
      primary: false,
      references: { table: "people", column: "id", name: "docs_owner_fkey", deferrable: "deferred", sourceClauses: ["MATCH FULL"] },
    },
    { name: "title", type: "text", nullable: false, primary: false },
    { name: "tags", type: "json", nullable: true, primary: false },
    { name: "slug", type: "text", nullable: true, primary: false, defaultExpression: "make_slug('x')", defaultNames: [{ kind: "function", name: "make_slug", now: "slugify" }] },
    { name: "kind", type: "text", nullable: true, primary: false, defaultExpression: "upper('x')", defaultNames: [] },
    { name: "old", type: "text", nullable: true, primary: false, defaultExpression: "pick('a')", defaultMayBeStale: true },
  ],
  primaryKey: { name: "docs_pkey", columns: ["id"], include: ["title"], deferrable: "immediate", sourceClauses: ["USING INDEX TABLESPACE fast"] },
  uniques: [{ name: "docs_title_key", columns: ["title"], include: ["slug", "tags"], deferrable: "deferred", nullsNotDistinct: true, sourceClauses: ["WITH (fillfactor=70)"] }],
  foreignKeys: [{ name: "docs_pair_fkey", columns: ["id", "owner"], references: { table: "pairs", columns: ["a", "b"] }, deferrable: "immediate", sourceClauses: ["NOT VALID"] }],
  indexes: [
    { name: "docs_tags_idx", columns: ["tags"], method: "gin", keys: [{ column: "tags", operatorClass: "jsonb_path_ops" }] },
    { name: "docs_title_idx", columns: ["title", "id"], keys: [{ column: "title", order: "desc", nulls: "last", collation: "C" }, { column: "id" }], include: ["slug", "tags"] },
    {
      name: "docs_mixed_idx",
      columns: ["id"],
      unique: true,
      expressions: ["lower(name)"],
      where: "owner IS NOT NULL",
      keys: [{ expression: "lower(name)" }, { column: "id" }],
      nullsNotDistinct: true,
      names: [
        { kind: "column", name: "name", now: "title" },
        { kind: "column", name: "owner" },
      ],
      sourceClauses: ["WITH (fillfactor=70)"],
    },
    { name: "docs_hash_idx", columns: ["title"], method: "hash" },
    { name: "docs_old_idx", columns: [], expressions: ["lower(slug)"], mayBeStale: true },
  ],
  checks: [
    {
      name: "docs_title_check",
      expression: "papers.name <> '' and kind <> 'draft'",
      names: [
        { kind: "column", name: "name", now: "title" },
        { kind: "column", name: "kind" },
        { kind: "table", name: "papers", now: "docs" },
        { kind: "value", name: "draft", now: "new", type: "state" },
        { kind: "value", name: "draft", type: "other_state" },
        { kind: "type", name: "state" },
      ],
      sourceClauses: ["NO INHERIT"],
    },
    { name: "docs_free_check", expression: "1 > 0", names: [] },
    { name: "docs_old_check", expression: "name <> ''", mayBeStale: true },
  ],
};

const read = (document: unknown): DatabaseSchema => readSchemaDocument(JSON.parse(JSON.stringify(document)), "schema.json");
const refused = (document: unknown, message: RegExp): void => {
  assert.throws(
    () => read(document),
    (error) => {
      assert.ok(error instanceof JsonStorageError, String(error));
      assert.match(error.message, message);
      return true;
    },
  );
};

const ID = { column: "id", type: "integer", primaryKey: true };
const CODE = { column: "code", type: "text" };
/** A document with one table `t` (`id`, `code`), with more on the table and on the column `code`. */
const table = (more: Record<string, unknown> = {}, code: Record<string, unknown> = {}, version?: number): object => ({
  ...(version !== undefined && { schemaVersion: version }),
  tables: [{ name: "t", columns: [ID, { ...CODE, ...code }], ...more }],
});

describe("schema document version 2: index keys, deferrable constraints, clauses of the source, and what a text names", () => {
  it("is the version that is written", () => {
    assert.equal(SCHEMA_VERSION, 2);
    assert.equal(toSchemaDocument([DOCS]).schemaVersion, 2);
    assert.equal(toSchemaDocument([]).schemaVersion, 2);
  });

  it("writes them, and reads them back exactly", () => {
    const [docs] = toSchemaDocument([DOCS]).tables;
    assert.deepEqual(docs?.indexes, DOCS.indexes);
    assert.deepEqual(docs?.checks, DOCS.checks);
    assert.deepEqual(docs?.uniques, DOCS.uniques);
    assert.deepEqual(docs?.foreignKeys, DOCS.foreignKeys);
    assert.deepEqual(docs?.primaryKey, DOCS.primaryKey);
    assert.deepEqual(docs?.columns[1]?.references, DOCS.columns[1]?.references);
    assert.deepEqual([docs?.columns[4]?.defaultExpression, docs?.columns[4]?.defaultNames], ["make_slug('x')", [{ kind: "function", name: "make_slug", now: "slugify" }]]);
    assert.deepEqual([docs?.columns[5]?.defaultNames, docs?.columns[5]?.defaultMayBeStale], [[], undefined]);
    assert.deepEqual([docs?.columns[6]?.defaultNames, docs?.columns[6]?.defaultMayBeStale], [undefined, true]);
    assert.deepEqual(read(toSchemaDocument([DOCS])).tables, [DOCS]);
  });

  it("writes what a text names also when that is nothing: then it is known that no rename reaches the text", () => {
    const [written] = toSchemaDocument([{ name: "t", columns: [{ name: "id", type: "integer", nullable: false, primary: true }], checks: [{ expression: "1 > 0", names: [] }], indexes: [{ name: "i", columns: [], expressions: ["1"], names: [] }] }]).tables;
    assert.deepEqual(written?.checks, [{ expression: "1 > 0", names: [] }]);
    assert.deepEqual(written?.indexes, [{ name: "i", columns: [], expressions: ["1"], names: [] }]);
    // And a name in one order of keys, without a name for now that is the text's own.
    const [check] = toSchemaDocument([{ name: "t", columns: [{ name: "id", type: "integer", nullable: false, primary: true }], checks: [{ expression: "id > 0", names: [{ type: "state", now: "x", name: "x", kind: "value" }] }] }]).tables[0]?.checks ?? [];
    assert.equal(JSON.stringify(check), '{"expression":"id > 0","names":[{"kind":"value","name":"x","type":"state"}]}');
  });

  it("writes each of them in one order of keys, whatever order the definition has them in", () => {
    const [index] = toSchemaDocument([{ ...DOCS, indexes: [{ sourceClauses: ["WITH (fillfactor=70)"], include: ["slug"], keys: [{ nulls: "first", column: "title" }], method: "btree_gist", unique: false, columns: ["title"], name: "i" }] }]).tables[0]
      ?.indexes ?? [];
    assert.equal(JSON.stringify(index), '{"name":"i","columns":["title"],"method":"btree_gist","keys":[{"column":"title","nulls":"first"}],"include":["slug"],"sourceClauses":["WITH (fillfactor=70)"]}');
  });

  it("leaves out what says nothing: an empty list, and a flag that is false", () => {
    const plain: TableSchema = {
      name: "t",
      // What a text names is said of a text: a column without a default that is one has none, nor has an index over columns alone.
      columns: [{ name: "id", type: "integer", nullable: false, primary: true, defaultNames: [], defaultMayBeStale: false }],
      uniques: [{ columns: ["id"], nullsNotDistinct: false, sourceClauses: [] }],
      indexes: [{ name: "i", columns: ["id"], include: [], names: [], mayBeStale: false, sourceClauses: [], nullsNotDistinct: false }],
      checks: [{ expression: "id > 0", mayBeStale: false, sourceClauses: [] }],
    };
    const [written] = toSchemaDocument([plain]).tables;
    assert.deepEqual(written?.uniques, [{ columns: ["id"] }]);
    assert.deepEqual(written?.indexes, [{ name: "i", columns: ["id"] }]);
    assert.deepEqual(written?.checks, [{ expression: "id > 0" }]);
    assert.deepEqual(Object.keys(written?.columns[0] ?? {}), ["column", "property", "type", "nullable", "primaryKey"]);
  });

  it("reads them from a document that states no version: one written by hand says what it means", () => {
    const { tables } = read(
      table({
        uniques: [{ columns: ["code"], deferrable: "deferred" }],
        indexes: [{ name: "i", columns: ["code"], method: "gin", keys: [{ column: "code", order: "desc" }], include: ["id"] }],
      }),
    );
    assert.deepEqual(tables[0]?.uniques, [{ columns: ["code"], deferrable: "deferred" }]);
    assert.deepEqual(tables[0]?.indexes, [{ name: "i", columns: ["code"], method: "gin", keys: [{ column: "code", order: "desc" }], include: ["id"] }]);
  });

  it("refuses what cannot be used, saying where the problem is", () => {
    const index = (more: Record<string, unknown>): object => table({ indexes: [{ name: "i", columns: ["code"], ...more }] });
    const check = (more: Record<string, unknown>): object => table({ checks: [{ expression: "id > 0", ...more }] });
    const refusals: [unknown, RegExp][] = [
      [table({ uniques: [{ columns: ["code"], deferrable: true }] }), /"deferrable" of entry 1 of "uniques" of table "t" must be "immediate" or "deferred"/],
      [table({ primaryKey: { columns: ["id"], deferrable: "later" } }), /"deferrable" of "primaryKey" of table "t" must be "immediate" or "deferred"/],
      [table({ foreignKeys: [{ columns: ["code"], references: { table: "u", columns: ["x"] }, deferrable: "no" }] }), /"deferrable" of entry 1 of "foreignKeys" of table "t" must be "immediate" or "deferred"/],
      [table({}, { references: { table: "u", column: "x", deferrable: 1 } }), /"deferrable" of "references" of column "code" of table "t" must be "immediate" or "deferred"/],
      [table({ uniques: [{ columns: ["code"], nullsNotDistinct: "yes" }] }), /"nullsNotDistinct" of entry 1 of "uniques" of table "t" must be true or false/],
      [table({ uniques: [{ columns: ["code"], sourceClauses: "MATCH FULL" }] }), /"sourceClauses" of entry 1 of "uniques" of table "t" must be a list of text/],
      [table({ checks: [{ expression: "id > 0", sourceClauses: [""] }] }), /"sourceClauses" of entry 1 of "checks" of table "t" must be a list of text/],
      [index({ method: "" }), /"method" of entry 1 of "indexes" of table "t" must be a name/],
      [index({ method: 7 }), /"method" of entry 1 of "indexes" of table "t" must be a name/],
      [index({ keys: "code" }), /"keys" of entry 1 of "indexes" of table "t" must be a list of keys/],
      [index({ keys: [{ column: "code", order: "asc" }] }), /entry 1 of "indexes" of table "t": "order" of key 1 must be "desc"/],
      [index({ keys: [{ column: "code", order: "desc", sorted: true }] }), /key 1 of entry 1 of "indexes" of table "t" has the unknown key "sorted"/],
      [index({ keys: [{ column: "code", collation: "" }] }), /"collation" of key 1 of entry 1 of "indexes" of table "t" must be a name/],
      [index({ keys: [{ column: "id", order: "desc" }] }), /entry 1 of "indexes" of table "t": "columns" must be the columns of "keys" in their order \(id\)/],
      [index({ keys: [{ column: "code" }] }), /entry 1 of "indexes" of table "t": "keys" says nothing that "columns" and "expressions" do not say/],
      [table({ indexes: [{ name: "i", columns: ["nope"], keys: [{ column: "nope", order: "desc" }] }] }), /names the column "nope", which table "t" does not have/],
      [index({ include: ["nope"] }), /"include" of entry 1 of "indexes" of table "t" names the column "nope", which table "t" does not have/],
      [index({ include: "id" }), /"include" of entry 1 of "indexes" of table "t" needs a list of column names/],
      [table({ uniques: [{ columns: ["code"], include: ["nope"] }] }), /"include" of entry 1 of "uniques" of table "t" names the column "nope", which table "t" does not have/],
      [table({ primaryKey: { columns: ["id"], include: "code" } }), /"include" of "primaryKey" of table "t" needs a list of column names/],
      [index({ nullsNotDistinct: true }), /"nullsNotDistinct" of entry 1 of "indexes" of table "t" is for a unique index/],
      [index({ names: [] }), /"names" of entry 1 of "indexes" of table "t": the index has no expression and no condition/],
      [index({ mayBeStale: true }), /"mayBeStale" of entry 1 of "indexes" of table "t": the index has no expression and no condition/],
      [check({ names: [{ kind: "row", name: "x" }] }), /"kind" of name 1 of "names" of entry 1 of "checks" of table "t" must be one of column, table, type, value, function/],
      [check({ names: [{ kind: "column" }] }), /name 1 of "names" of entry 1 of "checks" of table "t" needs a "name"/],
      [check({ names: [{ kind: "column", name: "a", now: "" }] }), /"now" of name 1 of "names" of entry 1 of "checks" of table "t" must be a name/],
      [check({ names: [{ kind: "column", name: "a", now: "a" }] }), /"now" of name 1 of "names" of entry 1 of "checks" of table "t" is the name the text has; it is left out then/],
      [check({ names: [{ kind: "column", name: "a", was: "b" }] }), /name 1 of "names" of entry 1 of "checks" of table "t" has the unknown key "was"/],
      [check({ names: {} }), /"names" of entry 1 of "checks" of table "t" must be a list/],
      [check({ names: ["a"] }), /name 1 of "names" of entry 1 of "checks" of table "t" must be an object with a "kind" and a "name"/],
      [check({ names: [{ kind: "value", name: "a" }] }), /name 1 of "names" of entry 1 of "checks" of table "t" is a value, and needs the "type" it is a value of/],
      [check({ names: [{ kind: "column", name: "a", type: "state" }] }), /"type" of name 1 of "names" of entry 1 of "checks" of table "t" is for a value/],
      [check({ names: [{ kind: "column", name: "a" }, { kind: "table", name: "a" }, { kind: "column", name: "a", now: "b" }] }), /name 3 of "names" of entry 1 of "checks" of table "t" is of the column "a", which name 1 is of already/],
      [check({ names: [{ kind: "value", name: "a", type: "s" }, { kind: "value", name: "a", type: "s" }] }), /name 2 of "names" of entry 1 of "checks" of table "t" is of the value "a" of "s", which name 1 is of already/],
      [check({ mayBeStale: "yes" }), /"mayBeStale" of entry 1 of "checks" of table "t" must be true or false/],
      [check({ mayBeStale: true, names: [] }), /"mayBeStale" of entry 1 of "checks" of table "t" says that it is not known what the text names, and "names" says what it names: it is one or the other/],
      [table({}, { defaultNames: [] }), /"defaultNames" of column "code" of table "t": the column has no "defaultExpression"/],
      [table({}, { defaultMayBeStale: true }), /"defaultMayBeStale" of column "code" of table "t": the column has no "defaultExpression"/],
      [table({}, { defaultExpression: "f()", defaultMayBeStale: true, defaultNames: [] }), /"defaultMayBeStale" of column "code" of table "t" says that it is not known what the text names, and "defaultNames" says what it names: it is one or the other/],
      [table({}, { defaultExpression: "f()", defaultNames: [{ kind: "column", name: "id" }] }), /name 1 of "defaultNames" of column "code" of table "t" is of a column: a default names no column, and not its table/],
      [table({}, { defaultExpression: "f()", defaultNames: [{ kind: "table", name: "t" }] }), /name 1 of "defaultNames" of column "code" of table "t" is of a table: a default names no column, and not its table/],
    ];
    for (const [document, message] of refusals) {
      refused(document, message);
    }
  });
});

describe("schema document version 1, which could not say any of it", () => {
  it("is still read", () => {
    assert.deepEqual(read(table({ indexes: [{ name: "i", columns: ["code"] }] }, {}, 1)).tables[0]?.indexes, [{ name: "i", columns: ["code"] }]);
  });

  it("does not have the keys of version 2: a document that has one is not what it says it is", () => {
    const refusals: [unknown, RegExp][] = [
      [table({ indexes: [{ name: "i", columns: ["code"], method: "gin" }] }, {}, 1), /entry 1 of "indexes" of table "t" has the key "method", which a schemaVersion 1 document does not have/],
      [table({ indexes: [{ name: "i", columns: ["code"], keys: [{ column: "code", order: "desc" }] }] }, {}, 1), /has the key "keys", which a schemaVersion 1 document does not have/],
      [table({ uniques: [{ columns: ["code"], deferrable: "deferred" }] }, {}, 1), /entry 1 of "uniques" of table "t" has the key "deferrable", which a schemaVersion 1 document does not have/],
      [table({ primaryKey: { columns: ["id"], include: ["code"] } }, {}, 1), /"primaryKey" of table "t" has the key "include", which a schemaVersion 1 document does not have/],
      [table({ checks: [{ expression: "id > 0", names: [{ kind: "column", name: "id" }] }] }, {}, 1), /has the key "names", which a schemaVersion 1 document does not have/],
      [table({ checks: [{ expression: "id > 0", mayBeStale: true }] }, {}, 1), /has the key "mayBeStale", which a schemaVersion 1 document does not have/],
      [table({}, { defaultExpression: "f()", defaultNames: [] }, 1), /column "code" of table "t" has the key "defaultNames", which a schemaVersion 1 document does not have/],
      [table({}, { defaultExpression: "f()", defaultMayBeStale: true }, 1), /column "code" of table "t" has the key "defaultMayBeStale", which a schemaVersion 1 document does not have/],
      [table({}, { references: { table: "u", column: "x", deferrable: "deferred" } }, 1), /"references" of column "code" of table "t" has the key "deferrable", which a schemaVersion 1 document does not have/],
      // A key that no version has is unknown, as before.
      [table({ indexes: [{ name: "i", columns: ["code"], fillfactor: 70 }] }, {}, 1), /entry 1 of "indexes" of table "t" has the unknown key "fillfactor"/],
    ];
    for (const [document, message] of refusals) {
      refused(document, message);
    }
    refused({ schemaVersion: 3, tables: [] }, /schema\.json has schemaVersion 3; this version reads schemaVersion 1 and 2/);
  });

  it("did not record what a text names: where a rename is recorded that may have reached a text, the text may be stale", () => {
    const rename = (from: string, to: string, statement: number) => ({ from, to, at: position(statement, "0002_rename.sql") });
    const tables = (more: Record<string, unknown> = {}) => [
      {
        name: "t",
        ...more,
        columns: [
          { ...ID, origin: origin("id") },
          { column: "title", type: "text", renames: [rename("name", "label", 2), rename("label", "title", 5)] },
          { column: "plain", type: "text", defaultExpression: "lower('X')" },
        ],
        checks: [{ name: "c", expression: "name <> ''" }],
        indexes: [
          { name: "by_expression", columns: [], expressions: ["lower(name)"] },
          { name: "by_condition", columns: ["id"], where: "name IS NOT NULL" },
          { name: "plain", columns: ["id"] },
        ],
      },
      {
        name: "untouched",
        columns: [ID, { column: "at", type: "datetime", defaultExpression: "now()" }],
        checks: [{ expression: "id > 0" }],
        indexes: [{ name: "u", columns: [], expressions: ["id + 1"] }],
      },
    ];
    const [renamed, untouched] = read({ schemaVersion: 1, tables: tables() }).tables;
    assert.deepEqual(renamed?.checks, [{ name: "c", expression: "name <> ''", mayBeStale: true }]);
    assert.deepEqual(renamed?.indexes?.map((index) => [index.name, index.mayBeStale]), [
      ["by_expression", true],
      ["by_condition", true],
      // An index over columns alone has no text that could be stale.
      ["plain", undefined],
    ]);
    // A default names no column of its table, nor the table: the renames of those do not reach it.
    assert.deepEqual(renamed?.columns.map((column) => column.defaultMayBeStale), [undefined, undefined, undefined]);
    // A table of which no rename is recorded is as it was written.
    assert.deepEqual(untouched?.checks, [{ expression: "id > 0" }]);
    assert.deepEqual(untouched?.indexes, [{ name: "u", columns: [], expressions: ["id + 1"] }]);
    assert.equal(untouched?.columns[1]?.defaultMayBeStale, undefined);
    // The table's own rename reaches its expressions as a column's does.
    const [moved] = read({ schemaVersion: 1, tables: [{ name: "t", renames: [rename("old_t", "t", 1)], columns: [ID], checks: [{ expression: "old_t.id > 0" }] }] }).tables;
    assert.deepEqual(moved?.checks, [{ expression: "old_t.id > 0", mayBeStale: true }]);
    // What was worked out is stored from then on: the document that is written is of version 2, and says it.
    const again = read(toSchemaDocument(read({ schemaVersion: 1, tables: tables() }).tables));
    assert.deepEqual(again.tables[0]?.checks, renamed?.checks);
    // A document of version 2 says what it means: a text of which it says nothing is taken as it is written.
    assert.deepEqual(read({ schemaVersion: 2, tables: tables() }).tables[0]?.checks, [{ name: "c", expression: "name <> ''" }]);
  });

  it("takes every text for one that may be stale where an enumerated type, or a value of one, is recorded as renamed: a text of any table may name those", () => {
    const rename = (from: string, to: string, statement: number) => ({ from, to, at: position(statement, "0002_rename.sql") });
    const document = (type: Record<string, unknown>) => ({
      schemaVersion: 1,
      types: { enums: [{ name: "mood", values: ["sad", "glad"], ...type }] },
      tables: [
        { name: "t", columns: [ID, { column: "m", type: "text", enum: "mood", canonicalType: { kind: "enum", name: "mood" }, defaultExpression: "pick('ok')" }, { column: "v", type: "text", default: "x" }] },
        { name: "other", columns: [ID, { column: "at", type: "text", defaultExpression: "('sad'::mood)::text" }], checks: [{ expression: "id > 0" }], indexes: [{ name: "o", columns: ["id"], where: "id > 0" }, { name: "p", columns: ["id"] }] },
      ],
    });
    for (const type of [{ renames: [rename("feeling", "mood", 3)] }, { valueRenames: [rename("ok", "glad", 4)] }]) {
      const [t, other] = read(document(type)).tables;
      assert.deepEqual(t?.columns.map((column) => column.defaultMayBeStale), [undefined, true, undefined]);
      assert.deepEqual([other?.columns[1]?.defaultMayBeStale, other?.checks?.[0]?.mayBeStale, other?.indexes?.map((index) => index.mayBeStale)], [true, true, [true, undefined]]);
    }
    const [t, other] = read(document({})).tables;
    assert.deepEqual([t?.columns[1]?.defaultMayBeStale, other?.checks?.[0]?.mayBeStale], [undefined, undefined]);
  });
});

describe("what a single file (format 1) holds of it", () => {
  it("is nothing: its schema document stays of version 1", () => {
    const plain: TableSchema[] = [{ name: "notes", columns: [{ name: "id", type: "integer", nullable: false, primary: true }] }];
    assert.equal(toFileSchemaDocument(plain).schemaVersion, 1);
    assert.deepEqual({ ...toFileSchemaDocument(plain), schemaVersion: 2 }, toSchemaDocument(plain));
  });

  it("names a deferrable foreign key of a column, and clauses on one, as what it cannot store", () => {
    const withReference = (reference: object): TableSchema[] => [
      { name: "t", columns: [{ name: "id", type: "integer", nullable: false, primary: true }, { name: "owner", type: "integer", nullable: true, primary: false, references: { table: "people", column: "id", ...reference } }] },
    ];
    assert.deepEqual(beyondFileFormat(withReference({})), []);
    assert.deepEqual(beyondFileFormat(withReference({ deferrable: "deferred" })), ["t: deferrable foreign keys or clauses of the source"]);
    assert.deepEqual(beyondFileFormat(withReference({ sourceClauses: ["MATCH FULL"] })), ["t: deferrable foreign keys or clauses of the source"]);
  });
});
