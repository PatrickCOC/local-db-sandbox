import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { CanonicalType, ColumnSchema, EnumType, SchemaOrigin, SchemaRename, SchemaTypes, TableSchema } from "../../runtime/src/index.ts";
import {
  DirectoryStorageAdapter,
  FORMAT_MIGRATIONS,
  JsonStorageAdapter,
  JsonStorageError,
  beyondFileFormat,
  convertDatabase,
  createDatabase,
  migrateDatabase,
  readSchemaDocument,
  sameDatabaseSchema,
  toSchemaDocument,
} from "../src/index.ts";
import type { FormatMigration } from "../src/index.ts";
import { toFileSchemaDocument } from "../src/schema-document.ts";

/*
 * The canonical schema in the schema document (D-036, format 4 as amended
 * before release): enumerated types at the level of the schema, which columns
 * name; the primary key as a constraint, with its name and column order;
 * canonical types and the types of the source's dialect; and provenance.
 */

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const AT_RENAME = { source: "postgresql-migrations", file: "0004_rename.sql", sha256: SHA_B, statement: 3, line: 26 };

function origin(name: string, statement = 1, more: Partial<SchemaOrigin> = {}): SchemaOrigin {
  return { source: "postgresql-migrations", file: "0001_init.sql", sha256: SHA_A, statement, line: statement * 10, name, ...more };
}

function rename(from: string, to: string): SchemaRename {
  return { from, to, at: { ...AT_RENAME } };
}

const MOOD: EnumType = {
  name: "mood",
  values: ["happy", "calm", "sad"],
  sourceDialectType: { dialect: "postgresql", type: "public.mood" },
  origin: origin("feeling", 1),
  renames: [rename("feeling", "mood")],
  valueRenames: [rename("glad", "happy")],
};
const UNUSED: EnumType = { name: "unused_status", values: [] };
const TYPES: SchemaTypes = { enums: [MOOD, UNUSED] };

const resolved = (type: EnumType): { name: string; values: string[] } => ({ name: type.name, values: [...type.values] });

const COLUMNS: ColumnSchema[] = [
  {
    name: "country",
    type: "text",
    declaredType: "text",
    canonicalType: { kind: "text" },
    sourceDialectType: { dialect: "postgresql", type: "text" },
    nullable: false,
    primary: true,
    origin: origin("country", 2),
  },
  {
    name: "code",
    type: "text",
    declaredType: "character varying(20)",
    canonicalType: { kind: "varchar", length: 20 },
    sourceDialectType: { dialect: "postgresql", type: "varchar(20)" },
    nullable: false,
    primary: true,
    origin: origin("region_code", 2),
    renames: [rename("region_code", "code")],
  },
  {
    name: "feeling",
    type: "text",
    declaredType: "mood",
    canonicalType: { kind: "enum", name: "mood" },
    sourceDialectType: { dialect: "postgresql", type: "mood" },
    nullable: true,
    primary: false,
    default: "calm",
    enum: resolved(MOOD),
  },
  {
    name: "parent_country",
    type: "text",
    nullable: true,
    primary: false,
    references: { table: "regions", column: "country", onDelete: "SET NULL", name: "regions_parent_fkey", origin: origin("regions_parent_fkey", 2, { generatedName: true }), renames: [rename("old_fkey", "regions_parent_fkey")] },
  },
];

const REGIONS: TableSchema = {
  name: "regions",
  columns: COLUMNS,
  primaryKey: { name: "regions_pk", columns: ["country", "code"], origin: origin("regions_pk", 2) },
  uniques: [{ name: "regions_code_key", columns: ["code"], origin: origin("regions_code_key", 2, { generatedName: true }) }],
  foreignKeys: [{ name: "regions_self_fkey", columns: ["parent_country", "code"], references: { table: "regions", columns: ["country", "code"] }, onUpdate: "CASCADE", origin: origin("regions_self_fkey", 5) }],
  indexes: [{ name: "regions_feeling_idx", columns: ["feeling"], origin: origin("regions_feeling_idx", 6), renames: [rename("regions_mood_idx", "regions_feeling_idx")] }],
  checks: [{ name: "regions_code_check", expression: "code <> ''", origin: origin("regions_code_check", 2, { generatedName: true }) }],
  origin: origin("areas", 2),
  renames: [rename("areas", "regions")],
};

const PLAIN: TableSchema[] = [
  {
    name: "notes",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "text", type: "text", nullable: false, primary: false, default: "" },
    ],
  },
];

function refuses(document: unknown, message: RegExp): void {
  assert.throws(
    () => readSchemaDocument(document, "schema.json"),
    (error: unknown) => error instanceof JsonStorageError && message.test(error.message),
    message.source,
  );
}

/** A document of one table `t` with a key column `id` and the given other columns, table keys, and document keys. */
function documentWith(columns: unknown[], table: Record<string, unknown> = {}, more: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, ...more, tables: [{ name: "t", columns: [{ column: "id", type: "integer", primaryKey: true }, ...columns], ...table }] };
}

describe("enumerated types of the schema", () => {
  it("are stored once, under types.enums, and columns name them; reading resolves each column's values", () => {
    const document = toSchemaDocument([REGIONS], TYPES);
    assert.deepEqual(Object.keys(document), ["schemaVersion", "types", "tables"]);
    assert.deepEqual(document.types?.enums.map((type) => type.name), ["mood", "unused_status"]);
    assert.equal(document.tables[0]?.columns[2]?.enum, "mood");

    const read = readSchemaDocument(JSON.parse(JSON.stringify(document)), "schema.json");
    assert.deepEqual(read, { tables: [REGIONS], types: TYPES });
    assert.deepEqual(read.tables[0]?.columns[2]?.enum, { name: "mood", values: ["happy", "calm", "sad"] });
  });

  it("a type that columns name and that is not given is stored from the columns; one given and named once is not repeated", () => {
    const status = { name: "status", values: ["on", "off"] };
    const tables: TableSchema[] = [
      { name: "a", columns: [{ name: "s", type: "text", nullable: true, primary: false, enum: status }] },
      { name: "b", columns: [{ name: "s", type: "text", nullable: true, primary: false, enum: status }, { name: "m", type: "text", nullable: true, primary: false, enum: resolved(MOOD) }] },
    ];
    assert.deepEqual(toSchemaDocument(tables, { enums: [MOOD] }).types?.enums.map((type) => type.name), ["mood", "status"]);
    assert.deepEqual(toSchemaDocument(tables).types?.enums, [status, { name: "mood", values: ["happy", "calm", "sad"] }]);
  });

  it("a type defined twice with different values is refused when the schema is written", () => {
    const tables: TableSchema[] = [
      {
        name: "t",
        columns: [
          { name: "x", type: "text", nullable: true, primary: false, enum: { name: "mood", values: ["a", "b"] } },
          { name: "y", type: "text", nullable: true, primary: false, enum: { name: "mood", values: ["a"] } },
        ],
      },
    ];
    assert.throws(() => toSchemaDocument(tables), (error: unknown) => error instanceof JsonStorageError && /The enumerated type "mood" has the values \(a, b\), but "t"\."y" gives it the values \(a\)\. A type is defined once\./.test(error.message));
    assert.throws(() => toSchemaDocument([REGIONS], { enums: [{ name: "mood", values: ["happy"] }] }), /The enumerated type "mood" has the values \(happy\), but "regions"\."feeling" gives it the values \(happy, calm, sad\)/);
    assert.throws(() => toSchemaDocument([], { enums: [MOOD, MOOD] }), /The enumerated type "mood" is defined more than once/);
  });

  it("are refused when they cannot be used, saying where the problem is", () => {
    const types = (enums: unknown): Record<string, unknown> => ({ types: { enums } });
    const refusals: [unknown, RegExp][] = [
      [documentWith([], {}, { views: [] }), /: the schema has the unknown key "views"\./],
      [documentWith([], {}, { types: [] }), /: "types" must be an object with a list of "enums"\./],
      [documentWith([], {}, { types: { domains: [] } }), /: "types" has the unknown key "domains"\./],
      [documentWith([], {}, { types: { enums: {} } }), /: "enums" of "types" must be a list\./],
      [documentWith([], {}, types([{ values: [] }])), /: enumerated type 1 needs a "name"\./],
      [documentWith([], {}, types([{ name: "mood", values: ["a"] }, { name: "mood", values: ["b"] }])), /: enumerated type "mood" is defined more than once\./],
      [documentWith([], {}, types([{ name: "mood", values: ["a", "b", "a"] }])), /: enumerated type "mood" has the value "a" more than once\./],
      [documentWith([], {}, types([{ name: "mood", values: "a" }])), /: enumerated type "mood" needs a list of text "values"\./],
      [documentWith([], {}, types([{ name: "mood", values: [""] }])), /: enumerated type "mood" needs a list of text "values"\./],
      [documentWith([], {}, types([{ name: "mood", values: ["a"], ordered: true }])), /: enumerated type "mood" has the unknown key "ordered"\./],
      [documentWith([], {}, types([{ name: "mood", values: ["a"], sourceDialectType: { dialect: "postgresql" } }])), /: "sourceDialectType" of enumerated type "mood" must name a "dialect" and a "type"\./],
      [documentWith([{ column: "s", type: "text", enum: { name: "mood", values: ["a"] } }], {}, types([{ name: "mood", values: ["a"] }])), /"enum" of column "s" of table "t" is an inline definition\. Declare the enumerated type once, under "types"/],
      [documentWith([{ column: "s", type: "text", enum: "nope" }], {}, types([{ name: "mood", values: ["a"] }])), /"enum" of column "s" of table "t" names the enumerated type "nope", which "types\.enums" does not define\./],
    ];
    for (const [document, message] of refusals) {
      refuses(document, message);
    }
  });

  it("may have no values, as in PostgreSQL", () => {
    const read = readSchemaDocument(documentWith([], {}, { types: { enums: [{ name: "empty", values: [] }] } }), "schema.json");
    assert.deepEqual(read.types, { enums: [{ name: "empty", values: [] }] });
  });
});

describe("the primary key as a constraint", () => {
  it("keeps its name and the order of its columns", () => {
    const document = toSchemaDocument([REGIONS], TYPES);
    assert.deepEqual(document.tables[0]?.primaryKey, { name: "regions_pk", columns: ["country", "code"], origin: origin("regions_pk", 2) });
    // The columns stay marked, as they always were.
    assert.deepEqual(document.tables[0]?.columns.map((column) => column.primaryKey), [true, true, false, false]);
    assert.deepEqual(readSchemaDocument(JSON.parse(JSON.stringify(document)), "schema.json").tables[0]?.primaryKey, REGIONS.primaryKey);
    // A table without it is written as before.
    assert.equal("primaryKey" in (toSchemaDocument(PLAIN).tables[0] ?? {}), false);
  });

  it("makes the columns it lists key columns, also when they are not marked, and not null unless the document says", () => {
    const document = {
      tables: [{ name: "t", columns: [{ column: "id", type: "integer" }, { column: "code", type: "text" }, { column: "note", type: "text" }], primaryKey: { columns: ["code", "id"] } }],
    };
    const [table] = readSchemaDocument(document, "schema.json").tables;
    assert.deepEqual(table?.columns.map((column) => [column.name, column.primary, column.nullable]), [
      ["id", true, false],
      ["code", true, false],
      ["note", false, true],
    ]);
    assert.deepEqual(table?.primaryKey, { columns: ["code", "id"] });
  });

  it("is refused when it does not agree with the columns, or names columns that are not there", () => {
    const columns = [{ column: "id", type: "integer", primaryKey: true }, { column: "code", type: "text", primaryKey: false }, { column: "x", type: "text", primaryKey: true }];
    const table = (primaryKey: unknown, list: unknown[] = columns): Record<string, unknown> => ({ tables: [{ name: "t", columns: list, primaryKey }] });
    const refusals: [unknown, RegExp][] = [
      [table({ columns: ["id"] }), /: column "x" of table "t" is marked as a key column, but "primaryKey" of table "t" does not list it\./],
      [table({ columns: ["id", "x", "code"] }), /: column "code" of table "t" is marked as not a key column, but "primaryKey" of table "t" lists it\./],
      [table({ columns: ["id", "nope"] }), /: "primaryKey" of table "t" names the column "nope", which table "t" does not have\./],
      [table({ columns: ["id", "x", "id"] }), /: "primaryKey" of table "t" names the column "id" more than once\./],
      [table({ columns: [] }), /: "primaryKey" of table "t" needs a list of column names\./],
      [table({ name: "", columns: ["id", "x"] }), /: "name" of "primaryKey" of table "t" must be a name\./],
      [table({ columns: ["id", "x"], clustered: true }), /: "primaryKey" of table "t" has the unknown key "clustered"\./],
      [table(["id", "x"]), /: "primaryKey" of table "t" must be an object with a list of "columns"\./],
    ];
    for (const [document, message] of refusals) {
      refuses(document, message);
    }
  });
});

describe("canonical types and the types of the source's dialect", () => {
  const typed = (canonicalType: CanonicalType): Record<string, unknown> => ({ column: "c", type: "any", canonicalType });

  it("are written and read back", () => {
    const examples: CanonicalType[] = [
      { kind: "integer", bits: 64 },
      { kind: "decimal", precision: 12, scale: 2 },
      // A scale below zero rounds to the left of the point; one above the precision is a fraction with leading zeros.
      { kind: "decimal", precision: 5, scale: -2 },
      { kind: "decimal", precision: 3, scale: 5 },
      { kind: "decimal" },
      { kind: "varchar" },
      { kind: "timestamp", withTimeZone: true, precision: 3 },
      { kind: "array", element: { kind: "varchar", length: 20 } },
      { kind: "json", binary: true },
      { kind: "other", dialect: "postgresql", name: "citext" },
      { kind: "other", dialect: "postgresql", name: "vector", modifiers: [1536] },
    ];
    for (const canonicalType of examples) {
      const [table] = readSchemaDocument(documentWith([typed(canonicalType)]), "schema.json").tables;
      assert.deepEqual(table?.columns[1]?.canonicalType, canonicalType, JSON.stringify(canonicalType));
      assert.deepEqual(toSchemaDocument(table === undefined ? [] : [table]).tables[0]?.columns[1]?.canonicalType, canonicalType);
    }
    const enumColumn = { column: "c", type: "text", enum: "mood", canonicalType: { kind: "enum", name: "mood" } };
    const [table] = readSchemaDocument(documentWith([enumColumn], {}, { types: { enums: [{ name: "mood", values: ["a"] }] } }), "schema.json").tables;
    assert.deepEqual([table?.columns[1]?.canonicalType, table?.columns[1]?.enum], [{ kind: "enum", name: "mood" }, { name: "mood", values: ["a"] }]);
    const dialect = readSchemaDocument(documentWith([{ column: "c", type: "integer", sourceDialectType: { dialect: "postgresql", type: "int4" } }]), "schema.json").tables[0]?.columns[1];
    assert.deepEqual(dialect?.sourceDialectType, { dialect: "postgresql", type: "int4" });
  });

  it("a column may be of an enumerated type by its canonical type alone: it names the type, and does not carry the values", () => {
    // As a schema from an ORM's entities has it (D-040): the type is the schema's, and the runtime does not check the column's values against it.
    const document = documentWith([{ column: "c", type: "text", canonicalType: { kind: "enum", name: "mood" } }, { column: "many", type: "json", canonicalType: { kind: "array", element: { kind: "enum", name: "mood" } } }], {}, { types: { enums: [{ name: "mood", values: ["a", "b"] }] } });
    const { tables, types } = readSchemaDocument(document, "schema.json");
    assert.deepEqual(types, { enums: [{ name: "mood", values: ["a", "b"] }] });
    assert.deepEqual([tables[0]?.columns[1]?.canonicalType, tables[0]?.columns[1]?.enum], [{ kind: "enum", name: "mood" }, undefined]);
    // Written, it is the document it was read from.
    const written = toSchemaDocument(tables, types);
    assert.deepEqual([written.tables[0]?.columns[1]?.canonicalType, written.tables[0]?.columns[1]?.enum, written.types], [{ kind: "enum", name: "mood" }, undefined, { enums: [{ name: "mood", values: ["a", "b"] }] }]);
    assert.deepEqual(readSchemaDocument(JSON.parse(JSON.stringify(written)), "schema.json"), { tables, types });
  });

  it("are refused when they are not canonical types, or do not agree with the column's enumerated type", () => {
    const mood = { types: { enums: [{ name: "mood", values: ["a"] }, { name: "status", values: ["on"] }] } };
    const refusals: [unknown, RegExp][] = [
      [documentWith([{ column: "c", type: "any", canonicalType: { kind: "money" } }]), /: "canonicalType" of column "c" of table "t" is not a canonical type: it needs a "kind", one of boolean, integer,/],
      [documentWith([{ column: "c", type: "any", canonicalType: { kind: "text", length: 5 } }]), /is not a canonical type: "length" is not a field of the kind "text"\./],
      [documentWith([{ column: "c", type: "any", canonicalType: { kind: "integer", bits: 33 } }]), /is not a canonical type: "bits" must be 16, 32, or 64\./],
      [documentWith([{ column: "c", type: "any", canonicalType: { kind: "decimal", scale: 2 } }]), /is not a canonical type: "scale" must be a whole number, and needs a "precision"\./],
      [documentWith([{ column: "c", type: "any", canonicalType: { kind: "decimal", precision: 5, scale: 1.5 } }]), /is not a canonical type: "scale" must be a whole number, and needs a "precision"\./],
      [documentWith([{ column: "c", type: "any", canonicalType: { kind: "decimal", precision: 0 } }]), /is not a canonical type: "precision" must be a whole number, 1 or more\./],
      [documentWith([{ column: "c", type: "any", canonicalType: "integer" }]), /is not a canonical type: it needs a "kind"/],
      [documentWith([{ column: "c", type: "text", enum: "status", canonicalType: { kind: "enum", name: "mood" } }], {}, mood), /: column "c" of table "t" names the enumerated type "status" in "enum", but its canonical type is of the enumerated type "mood"\./],
      [documentWith([{ column: "c", type: "text", canonicalType: { kind: "enum", name: "ghost" } }], {}, mood), /: "canonicalType" of column "c" of table "t" names the enumerated type "ghost", which "types\.enums" does not define\./],
      [documentWith([{ column: "c", type: "text", enum: "mood", canonicalType: { kind: "text" } }], {}, mood), /: column "c" of table "t" names the enumerated type "mood" in "enum", but its canonical type is of the kind "text"\./],
      [documentWith([{ column: "c", type: "json", canonicalType: { kind: "array", element: { kind: "enum", name: "ghost" } } }], {}, mood), /: "canonicalType" of column "c" of table "t" names the enumerated type "ghost", which "types\.enums" does not define\./],
      [documentWith([{ column: "c", type: "integer", sourceDialectType: "int4" }]), /: "sourceDialectType" of column "c" of table "t" must name a "dialect" and a "type"\./],
      [documentWith([{ column: "c", type: "integer", sourceDialectType: { dialect: "postgresql", type: "int4", schema: "pg_catalog" } }]), /: "sourceDialectType" of column "c" of table "t" has the unknown key "schema"\./],
    ];
    for (const [document, message] of refusals) {
      refuses(document, message);
    }
  });
});

describe("provenance", () => {
  it("is written and read back on tables, columns, keys, constraints, indexes, and enumerated types", () => {
    const document = JSON.parse(JSON.stringify(toSchemaDocument([REGIONS], TYPES)));
    const [table] = document.tables;
    assert.deepEqual(table.origin, origin("areas", 2));
    assert.deepEqual(table.renames, [rename("areas", "regions")]);
    assert.deepEqual(table.columns[1].renames, [rename("region_code", "code")]);
    assert.deepEqual(table.columns[3].references.origin, origin("regions_parent_fkey", 2, { generatedName: true }));
    assert.deepEqual(table.checks[0].origin.generatedName, true);
    assert.deepEqual(document.types.enums[0].valueRenames, [rename("glad", "happy")]);
    // Absent `generatedName` is left out, not written as false.
    assert.equal("generatedName" in table.origin, false);
    assert.deepEqual(readSchemaDocument(document, "schema.json"), { tables: [REGIONS], types: TYPES });
  });

  it("is refused when it is malformed", () => {
    const withOrigin = (value: unknown): Record<string, unknown> => documentWith([{ column: "c", type: "text", origin: value }]);
    const withRenames = (value: unknown): Record<string, unknown> => documentWith([{ column: "c", type: "text", renames: value }]);
    const good = origin("c");
    const { sha256: _sha256, ...withoutHash } = good;
    const refusals: [unknown, RegExp][] = [
      [withOrigin(withoutHash), /: "sha256" of "origin" of column "c" of table "t" must be a name\./],
      [withOrigin({ ...good, statement: 0 }), /: "statement" of "origin" of column "c" of table "t" must be a whole number, 1 or more\./],
      [withOrigin({ ...good, line: 2.5 }), /: "line" of "origin" of column "c" of table "t" must be a whole number, 1 or more\./],
      [withOrigin({ ...good, name: "" }), /: "name" of "origin" of column "c" of table "t" must be a name\./],
      [withOrigin({ ...good, generatedName: "yes" }), /: "generatedName" of "origin" of column "c" of table "t" must be true or false\./],
      [withOrigin({ ...good, hash: "x" }), /: "origin" of column "c" of table "t" has the unknown key "hash"\./],
      [withOrigin("0001_init.sql:7"), /: "origin" of column "c" of table "t" must be an object with "source", "file", "sha256", "statement", and "line"\./],
      [withRenames(rename("a", "c")), /: "renames" of column "c" of table "t" must be a list of renames\./],
      [withRenames([{ from: "a", to: "c" }]), /: "at" of rename 1 of "renames" of column "c" of table "t" must be an object with "source"/],
      [withRenames([{ from: "a", at: AT_RENAME }]), /: rename 1 of "renames" of column "c" of table "t" needs the names "from" and "to"\./],
      [withRenames([{ ...rename("a", "c"), when: "today" }]), /: rename 1 of "renames" of column "c" of table "t" has the unknown key "when"\./],
      [withRenames([{ from: "a", to: "c", at: { ...AT_RENAME, name: "x" } }]), /: "at" of rename 1 of "renames" of column "c" of table "t" has the unknown key "name"\./],
      [documentWith([], { origin: { ...good, statement: "2" } }), /: "statement" of "origin" of table "t" must be a whole number, 1 or more\./],
      [documentWith([], { uniques: [{ columns: ["id"], origin: "x" }] }), /: "origin" of entry 1 of "uniques" of table "t" must be an object/],
      [documentWith([], { primaryKey: { columns: ["id"], renames: [{}] } }), /: rename 1 of "renames" of "primaryKey" of table "t" needs the names "from" and "to"\./],
      [documentWith([{ column: "r", type: "integer", references: { table: "t", column: "id", origin: { ...good, file: 3 } } }]), /: "file" of "origin" of "references" of column "r" of table "t" must be a name\./],
      [documentWith([], {}, { types: { enums: [{ name: "mood", values: ["a"], valueRenames: [{ from: "x", to: "a" }] }] } }), /: "at" of rename 1 of "valueRenames" of enumerated type "mood" must be an object/],
    ];
    for (const [document, message] of refusals) {
      refuses(document, message);
    }
  });
});

describe("what a single-file database cannot store", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-schema-types-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** One feature of format 4 each, on an otherwise plain table. */
  const plainTable = (more: Partial<TableSchema> = {}, column: Partial<ColumnSchema> = {}): TableSchema => ({
    name: "t",
    columns: [{ name: "id", type: "integer", nullable: false, primary: true, ...column }],
    ...more,
  });
  const FEATURES: [string, TableSchema[], SchemaTypes | undefined, RegExp][] = [
    ["the primary key as a constraint", [plainTable({ primaryKey: { name: "t_pkey", columns: ["id"] } })], undefined, /\(t: primary key names or order\)/],
    ["a canonical type", [plainTable({}, { canonicalType: { kind: "integer", bits: 32 } })], undefined, /\(t: canonical types\)/],
    ["a type of the source's dialect", [plainTable({}, { sourceDialectType: { dialect: "postgresql", type: "int4" } })], undefined, /\(t: canonical types\)/],
    ["provenance of a table", [plainTable({ origin: origin("t") })], undefined, /\(t: provenance\)/],
    ["renames of a column", [plainTable({}, { renames: [rename("x", "id")] })], undefined, /\(t: provenance\)/],
    ["provenance of a unique constraint", [plainTable({ uniques: [{ columns: ["id"], origin: origin("t_id_key") }] })], undefined, /\(t: unique constraints, provenance\)/],
    ["enumerated types", PLAIN, { enums: [{ name: "mood", values: ["a"] }] }, /\(enumerated types: mood\)/],
  ];

  it("names each feature", () => {
    assert.deepEqual(beyondFileFormat(PLAIN), []);
    assert.deepEqual(beyondFileFormat(PLAIN, { enums: [] }), []);
    assert.deepEqual(beyondFileFormat([REGIONS], TYPES), [
      "enumerated types: mood, unused_status",
      "regions: primary key names or order, unique constraints, foreign keys over several columns, indexes, check constraints, enumerated values, named foreign keys or ON UPDATE actions, canonical types, provenance",
    ]);
  });

  it("is refused when a single file would be saved with it, and nothing is written", async () => {
    for (const [label, tables, types, message] of FEATURES) {
      const path = join(dir, `refused-${label.replaceAll(/\W+/g, "-")}.db.json`);
      await assert.rejects(
        createDatabase(path, { collections: { t: [] }, schema: tables, ...(types !== undefined && { types }) }, { format: "file" }),
        (error: unknown) => error instanceof JsonStorageError && /would hold table definitions that a single-file database cannot store/.test(error.message) && message.test(error.message),
        label,
      );
      await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" }, label);
    }
  });

  it("is refused when a single file that holds it is read", async () => {
    for (const [label, tables, types, message] of FEATURES) {
      const path = join(dir, `written-by-hand-${label.replaceAll(/\W+/g, "-")}.db.json`);
      await writeFile(path, JSON.stringify({ $meta: { version: 1 }, $tableSchema: toSchemaDocument(tables, types), data: { t: [] } }));
      await assert.rejects(
        new JsonStorageAdapter(path).load(),
        (error: unknown) => error instanceof JsonStorageError && /holds table definitions that a single-file database cannot store/.test(error.message) && message.test(error.message),
        label,
      );
    }
  });

  it("a single file with plain table definitions is written byte for byte as before", async () => {
    const path = join(dir, "plain.db.json");
    await createDatabase(path, { collections: { notes: [{ id: 1, text: "hi" }] }, schema: PLAIN }, { format: "file" });
    const expected = `${JSON.stringify(
      {
        $meta: { version: 1 },
        $tableSchema: {
          schemaVersion: 1,
          tables: [
            {
              name: "notes",
              columns: [
                { column: "id", property: "id", type: "integer", nullable: false, primaryKey: true, generated: "increment" },
                { column: "text", property: "text", type: "text", nullable: false, primaryKey: false, default: "" },
              ],
            },
          ],
        },
        data: { notes: [{ id: 1, text: "hi" }] },
      },
      null,
      2,
    )}\n`;
    assert.equal(await readFile(path, "utf8"), expected);
    const storage = new JsonStorageAdapter(path);
    await storage.load();
    assert.equal(storage.types, undefined);
    assert.equal("types" in storage.metadata(), false);
  });

  it("converting a directory with enumerated types into a single file is refused, and writes nothing", async () => {
    const source = join(dir, "typed.db");
    await createDatabase(source, { collections: { t: [] }, schema: PLAIN, types: { enums: [{ name: "mood", values: ["a"] }] } }, { format: "directory" });
    const target = join(dir, "typed.db.json");
    await assert.rejects(
      convertDatabase(source, target),
      (error: unknown) => error instanceof JsonStorageError && /typed\.db\.json would hold table definitions that a single-file database cannot store \(enumerated types: mood\)/.test(error.message),
    );
    await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
  });
});

describe("table definitions that are given to a storage with the enumerated types they name", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "lds-describe-types-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const typed = (name: string): TableSchema => ({ name: "notes", columns: [{ name: "id", type: "integer", nullable: false, primary: true }, { name: "state", type: "text", nullable: true, primary: false, canonicalType: { kind: "enum", name } }] });
  const state = (values: string[], name = "note_state"): SchemaTypes => ({ enums: [{ name, values }] });

  it("a directory stores them: a type of a name it has is replaced, and the others are kept", async () => {
    const path = join(dir, "typed.db");
    await createDatabase(path, { collections: { notes: [] } }, { format: "directory" });
    const storage = new DirectoryStorageAdapter(path);
    assert.equal(storage.storesCanonicalSchema, true);
    const loaded = await storage.load();
    storage.describe([typed("note_state")], { enums: [...state(["new", "done"]).enums, { name: "unused", values: ["x"] }] });
    storage.saveSync(loaded);
    assert.deepEqual(storage.types, { enums: [{ name: "note_state", values: ["new", "done"] }, { name: "unused", values: ["x"] }] });
    // Given again with other values: the type of that name is the new one, in its place.
    storage.describe([typed("note_state")], state(["new", "done", "gone"]));
    storage.saveSync(loaded);
    const reopened = new DirectoryStorageAdapter(path);
    await reopened.load();
    assert.deepEqual(reopened.types, { enums: [{ name: "note_state", values: ["new", "done", "gone"] }, { name: "unused", values: ["x"] }] });
    assert.deepEqual(reopened.schema?.[0]?.columns[1]?.canonicalType, { kind: "enum", name: "note_state" });
    // Definitions that are given without types leave the types as they are.
    reopened.describe([typed("note_state")]);
    assert.deepEqual(reopened.types?.enums.length, 2);
  });

  it("a single file stores neither canonical types nor such types, and says so of itself", async () => {
    const path = join(dir, "plain.json");
    await writeFile(path, JSON.stringify({ $meta: { version: 1 }, $tableSchema: toFileSchemaDocument([{ name: "notes", columns: [{ name: "id", type: "integer", nullable: false, primary: true }] }]), data: { notes: [] } }));
    const storage = new JsonStorageAdapter(path);
    assert.equal(storage.storesCanonicalSchema, false);
    const loaded = await storage.load();
    // Who gives it such definitions all the same is refused at the save, as ever: nothing is left out in silence.
    storage.describe([typed("note_state")], state(["new"]));
    assert.throws(() => storage.saveSync(loaded), /would hold table definitions that a single-file database cannot store \(enumerated types: note_state; notes: canonical types\)/);
  });
});

describe("a database directory with enumerated types", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-schema-types-dir-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("stores them in its schema file, including a type no column uses, and keeps them across saves and reopening", async () => {
    const path = join(dir, "typed.db");
    await createDatabase(path, { collections: { regions: [], notes: [] }, schema: [REGIONS, ...PLAIN], types: TYPES }, { format: "directory" });
    const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    const stored = JSON.parse(await readFile(join(path, manifest.schema), "utf8"));
    assert.deepEqual(stored.types.enums.map((type: EnumType) => type.name), ["mood", "unused_status"]);

    const storage = new DirectoryStorageAdapter(path, { retiredFileGraceMs: 0 });
    const state = await storage.load();
    assert.deepEqual(storage.types, TYPES);
    assert.deepEqual(storage.metadata().types, TYPES);
    assert.deepEqual(storage.schema?.[0], REGIONS);
    assert.deepEqual(toSchemaDocument(storage.schema ?? [], storage.types), toSchemaDocument([REGIONS, ...PLAIN], TYPES));

    // An integration that gives the tables it knows does not take the types away.
    storage.describe(PLAIN);
    storage.saveSync({ ...state, collections: { ...state.collections, notes: [{ id: 1, text: "x" }] } });
    const reopened = new DirectoryStorageAdapter(path);
    await reopened.load();
    assert.deepEqual(reopened.types, TYPES);
    assert.deepEqual(reopened.schema?.[0], REGIONS);
  });

  it("without enumerated types, has none and writes none", async () => {
    const path = join(dir, "plain.db");
    await createDatabase(path, { collections: { notes: [] }, schema: PLAIN }, { format: "directory" });
    const storage = new DirectoryStorageAdapter(path);
    await storage.load();
    assert.equal(storage.types, undefined);
    assert.equal("types" in storage.metadata(), false);
    const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    assert.equal("types" in JSON.parse(await readFile(join(path, manifest.schema), "utf8")), false);
  });

  it("a migration whose result changes an enumerated type is refused, and one that keeps them is published", async () => {
    const path = join(dir, "migrating.db");
    await createDatabase(path, { collections: { regions: [], notes: [] }, schema: [REGIONS, ...PLAIN], types: TYPES }, { format: "directory" });
    // The same files, stated as format 4: the step to format 5 is the last one the build has.
    const manifestPath = join(path, "manifest.json");
    await writeFile(manifestPath, `${JSON.stringify({ ...JSON.parse(await readFile(manifestPath, "utf8")), formatVersion: 4, minimumReaderVersion: 4 }, null, 2)}\n`);

    const toFormat5 = FORMAT_MIGRATIONS.find((migration) => migration.storage === "directory" && migration.from === 4) as FormatMigration;
    const changingTypes: FormatMigration = {
      ...toFormat5,
      transform: (source) => {
        const output = toFormat5.transform(source);
        const schema = { ...toSchemaDocument([REGIONS, ...PLAIN], TYPES) };
        schema.types = { enums: [MOOD, { ...UNUSED, values: ["sneaked_in"] }] };
        output.write["schema.g9.json"] = `${JSON.stringify(schema, null, 2)}\n`;
        output.manifest.schema = "schema.g9.json";
        return output;
      },
    };
    assert.throws(
      () => migrateDatabase(path, { migrations: [changingTypes] }),
      (error: unknown) => error instanceof JsonStorageError && /was not migrated from format 4 to format 5: the table definitions are not the same in the result\. It is still format 4\./.test(error.message),
    );
    assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).formatVersion, 4);

    assert.equal(migrateDatabase(path).migrated, true);
    const storage = new DirectoryStorageAdapter(path);
    await storage.load();
    assert.deepEqual([storage.formatStatus?.formatVersion, storage.types], [5, TYPES]);
  });

  it("are compared with the tables when two schemas are compared", () => {
    assert.equal(sameDatabaseSchema({ tables: [REGIONS], types: TYPES }, { tables: [REGIONS], types: TYPES }), true);
    assert.equal(sameDatabaseSchema({ tables: PLAIN, types: TYPES }, { tables: PLAIN, types: { enums: [MOOD] } }), false);
    assert.equal(sameDatabaseSchema({ tables: PLAIN }, { tables: PLAIN, types: { enums: [] } }), true);
  });
});
