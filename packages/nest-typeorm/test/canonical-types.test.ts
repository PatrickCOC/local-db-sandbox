import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";
import type { ImportedCollection, ImportedField } from "../../import-typeorm/src/index.ts";
import { diffSchemas } from "../../schema-diff/src/index.ts";
import { arrives, generate, statementsOf } from "../../migration/test/support/postgres-round-trip.ts";
import type { CanonicalType, DatabaseSchema } from "../../runtime/src/index.ts";
import { canonicalTypeOf, databaseSchema, postgresTypeName, tableSchemas } from "../src/index.ts";

/*
 * The canonical type of a column of a TypeORM entity (D-040): what the
 * column is in the database the entity was written for, read as TypeORM's
 * own PostgreSQL driver reads the declaration. With it, a schema that comes
 * from entities is compared and written as a schema from migrations is: by
 * what its types are, and never by how the entity spelled them.
 */

const field = (sourceType: string | undefined, more: Partial<ImportedField> = {}): ImportedField => ({ name: "value", type: "string", primary: false, nullable: false, ...(sourceType !== undefined && { sourceType }), ...more });
const typeOf = (sourceType: string | undefined, more: Partial<ImportedField> = {}): CanonicalType | undefined => canonicalTypeOf(field(sourceType, more), "things")?.type;

describe("TypeORM canonical types: a declared type is what TypeORM's PostgreSQL driver makes of it", () => {
  test("truth values, and whole numbers of each size", () => {
    assert.deepEqual([typeOf("boolean"), typeOf("bool"), typeOf("Boolean")], [{ kind: "boolean" }, { kind: "boolean" }, { kind: "boolean" }]);
    for (const [names, bits] of [
      [["smallint", "int2"], 16],
      [["int", "int4", "integer", "Number"], 32],
      [["bigint", "int8"], 64],
    ] as const) {
      for (const name of names) {
        assert.deepEqual(typeOf(name), { kind: "integer", bits }, name);
      }
    }
  });

  test("exact decimals with their digits, and floating-point numbers: `float` is of 64 bits", () => {
    assert.deepEqual(typeOf("decimal"), { kind: "decimal" });
    assert.deepEqual(typeOf("numeric", { precision: 12, scale: 2 }), { kind: "decimal", precision: 12, scale: 2 });
    assert.deepEqual(typeOf("decimal", { precision: 12 }), { kind: "decimal", precision: 12 });
    // A scale without a precision says nothing: TypeORM's driver writes the type's name alone then.
    assert.deepEqual(typeOf("decimal", { scale: 2 }), { kind: "decimal" });
    assert.deepEqual([typeOf("real"), typeOf("float4")], [{ kind: "float", bits: 32 }, { kind: "float", bits: 32 }]);
    assert.deepEqual([typeOf("float"), typeOf("float8"), typeOf("double precision")], [{ kind: "float", bits: 64 }, { kind: "float", bits: 64 }, { kind: "float", bits: 64 }]);
  });

  test("texts: of any length, of at most a length, and of exactly one", () => {
    assert.deepEqual(typeOf("text"), { kind: "text" });
    assert.deepEqual([typeOf("varchar"), typeOf("character varying"), typeOf("String")], [{ kind: "varchar" }, { kind: "varchar" }, { kind: "varchar" }]);
    assert.deepEqual(typeOf("varchar", { length: 200 }), { kind: "varchar", length: 200 });
    assert.deepEqual(typeOf("String", { length: 80 }), { kind: "varchar", length: 80 });
    // PostgreSQL's `character` without a length is one character.
    assert.deepEqual([typeOf("char"), typeOf("character"), typeOf("char", { length: 3 })], [{ kind: "char", length: 1 }, { kind: "char", length: 1 }, { kind: "char", length: 3 }]);
    assert.deepEqual(typeOf("uuid"), { kind: "uuid" });
  });

  test("dates, times, and moments: `timestamp` and a `Date` property are without a time zone, as TypeORM creates them", () => {
    assert.deepEqual(typeOf("date"), { kind: "date" });
    assert.deepEqual([typeOf("timestamp"), typeOf("timestamp without time zone"), typeOf("Date")], Array(3).fill({ kind: "timestamp", withTimeZone: false }));
    assert.deepEqual([typeOf("timestamptz"), typeOf("timestamp with time zone")], Array(2).fill({ kind: "timestamp", withTimeZone: true }));
    assert.deepEqual(typeOf("timestamptz", { precision: 3 }), { kind: "timestamp", withTimeZone: true, precision: 3 });
    assert.deepEqual([typeOf("time"), typeOf("time without time zone")], Array(2).fill({ kind: "time", withTimeZone: false }));
    assert.deepEqual([typeOf("timetz"), typeOf("time with time zone", { precision: 0 })], [
      { kind: "time", withTimeZone: true },
      { kind: "time", withTimeZone: true, precision: 0 },
    ]);
    assert.deepEqual(typeOf("interval"), { kind: "interval" });
  });

  test("the columns TypeORM fills itself: a date-time without a time zone, and a version that is a whole number", () => {
    for (const decorator of ["@CreateDateColumn", "@UpdateDateColumn", "@DeleteDateColumn"]) {
      assert.deepEqual(typeOf(decorator), { kind: "timestamp", withTimeZone: false }, decorator);
      // Unless the decorator says another type.
      assert.deepEqual(typeOf(decorator, { declaredType: "timestamptz", precision: 3 }), { kind: "timestamp", withTimeZone: true, precision: 3 }, decorator);
    }
    assert.deepEqual(typeOf("@VersionColumn"), { kind: "integer", bits: 32 });
  });

  test("JSON, and what TypeORM keeps as text: `simple-json` and `simple-array` are text columns", () => {
    assert.deepEqual([typeOf("json"), typeOf("jsonb")], [
      { kind: "json", binary: false },
      { kind: "json", binary: true },
    ]);
    assert.deepEqual([typeOf("simple-json"), typeOf("simple-array")], [{ kind: "text" }, { kind: "text" }]);
    assert.deepEqual(typeOf("bytea"), { kind: "binary" });
  });

  test("an array is an array of what its type is", () => {
    assert.deepEqual(typeOf("int", { array: true }), { kind: "array", element: { kind: "integer", bits: 32 } });
    assert.deepEqual(typeOf("varchar", { array: true, length: 20 }), { kind: "array", element: { kind: "varchar", length: 20 } });
  });

  test("a type of PostgreSQL without a canonical meaning is kept as PostgreSQL's", () => {
    assert.deepEqual(typeOf("citext"), { kind: "other", dialect: "postgresql", name: "citext" });
    assert.deepEqual(typeOf("inet"), { kind: "other", dialect: "postgresql", name: "inet" });
    assert.deepEqual(typeOf("tsvector"), { kind: "other", dialect: "postgresql", name: "tsvector" });
  });

  test("a name that PostgreSQL does not have, and a property type TypeORM's PostgreSQL driver has no column for, have no canonical type", () => {
    for (const name of ["tinyint", "mediumint", "datetime", "datetime2", "longtext", "mediumtext", "nvarchar", "blob", "varbinary", "double", "number", "string", "Buffer", "Object", "made-up"]) {
      assert.equal(canonicalTypeOf(field(name), "things"), undefined, name);
    }
    assert.equal(canonicalTypeOf(field(undefined), "things"), undefined);
    assert.equal(canonicalTypeOf(field("datetime", { array: true }), "things"), undefined);
  });

  test("the same declaration gives the same type, however often it is asked", () => {
    const declared = field("numeric", { precision: 10, scale: 4, array: true });
    assert.deepEqual(canonicalTypeOf(declared, "t"), canonicalTypeOf(structuredClone(declared), "t"));
    assert.deepEqual(declared, field("numeric", { precision: 10, scale: 4, array: true }));
  });
});

describe("TypeORM canonical types: an enumerated type has the name TypeORM gives it in PostgreSQL", () => {
  test("its own name where the column gives one, and the table's and the column's otherwise", () => {
    const named = canonicalTypeOf(field("enum", { enum: ["draft", "live"], enumName: "post_status" }), "posts");
    assert.deepEqual(named, { type: { kind: "enum", name: "post_status" }, enumType: { name: "post_status", values: ["draft", "live"] } });
    const unnamed = canonicalTypeOf(field("enum", { name: "status", column: "Post_Status", enum: ["draft", "live"] }), "posts");
    assert.deepEqual(unnamed, { type: { kind: "enum", name: "posts_post_status_enum" }, enumType: { name: "posts_post_status_enum", values: ["draft", "live"] } });
    assert.deepEqual(canonicalTypeOf(field("simple-enum", { name: "state", enum: ["on", "off"] }), "switches")?.type, { kind: "enum", name: "switches_state_enum" });
  });

  test("its values are texts, as every value of an enumerated type of PostgreSQL is", () => {
    assert.deepEqual(canonicalTypeOf(field("enum", { name: "tier", type: "number", enum: [0, 1] }), "users")?.enumType, { name: "users_tier_enum", values: ["0", "1"] });
  });

  test("an array of it is an array of the type, whose values the column's elements have", () => {
    const colors = canonicalTypeOf(field("enum", { name: "colors", type: "array", array: true, elementEnum: ["red", "blue"] }), "things");
    assert.deepEqual(colors, { type: { kind: "array", element: { kind: "enum", name: "things_colors_enum" } }, enumType: { name: "things_colors_enum", values: ["red", "blue"] } });
  });

  test("a column that says it is enumerated and has no values that could be read has no canonical type", () => {
    assert.equal(canonicalTypeOf(field("enum"), "things"), undefined);
  });
});

describe("TypeORM canonical types: the reading of a type name is TypeORM's own", () => {
  const require = createRequire(import.meta.url);
  const NAMES = [
    "int", "int2", "int4", "int8", "smallint", "integer", "bigint", "decimal", "numeric", "real", "float", "float4", "float8", "double precision",
    "character varying", "varchar", "character", "char", "text", "citext", "bytea", "timetz", "timestamptz", "timestamp", "timestamp without time zone",
    "timestamp with time zone", "date", "time", "time without time zone", "time with time zone", "interval", "bool", "boolean", "enum", "simple-enum",
    "uuid", "json", "jsonb", "simple-json", "simple-array", "inet", "tsvector",
    // Names of other databases, which TypeORM's PostgreSQL driver leaves as they are, and PostgreSQL does not have.
    "tinyint", "mediumint", "datetime", "longtext", "blob", "double",
  ];
  for (const packageName of ["typeorm", "typeorm-0.3.17"]) {
    test(`the name PostgreSQL has for each declared type is the one ${packageName} normalizes it to`, () => {
      const { PostgresDriver } = require(`${packageName}/driver/postgres/PostgresDriver`) as { PostgresDriver: { prototype: { normalizeType(column: { type: unknown }): string } } };
      const normalize = (type: unknown): string => PostgresDriver.prototype.normalizeType.call({}, { type });
      for (const name of NAMES) {
        assert.equal(postgresTypeName(name), normalize(name), name);
      }
      for (const [constructor, name] of [[Number, "Number"], [String, "String"], [Date, "Date"], [Boolean, "Boolean"]] as const) {
        assert.equal(postgresTypeName(name), normalize(constructor), name);
      }
    });
  }
});

/** Entities as the importer gives them: a blog with an enumerated type, lengths, digits, a relation, and columns TypeORM fills. */
const BLOG: ImportedCollection[] = [
  {
    name: "users",
    source: "User",
    fields: [
      { name: "id", type: "number", sourceType: "Number", primary: true, nullable: false, generated: "increment" },
      { name: "email", type: "string", sourceType: "varchar", length: 200, primary: false, nullable: false },
      { name: "bio", type: "string", sourceType: "text", primary: false, nullable: true },
      { name: "active", type: "boolean", sourceType: "Boolean", primary: false, nullable: false, default: true },
      { name: "role", type: "string", sourceType: "enum", primary: false, nullable: false, enum: ["admin", "editor", "reader"], default: "reader" },
      { name: "createdAt", column: "created_at", type: "date", sourceType: "@CreateDateColumn", primary: false, nullable: false },
    ],
  },
  {
    name: "posts",
    source: "Post",
    fields: [
      { name: "id", type: "string", sourceType: "uuid", primary: true, nullable: false },
      { name: "title", type: "string", sourceType: "String", primary: false, nullable: false },
      { name: "price", type: "string", sourceType: "decimal", precision: 10, scale: 2, primary: false, nullable: true },
      { name: "views", type: "string", sourceType: "bigint", primary: false, nullable: false, default: 0 },
      { name: "meta", type: "json", sourceType: "jsonb", primary: false, nullable: true },
      { name: "tags", type: "array", sourceType: "varchar", array: true, primary: false, nullable: true },
      { name: "publishedAt", column: "published_at", type: "date", sourceType: "timestamptz", primary: false, nullable: true },
      { name: "authorId", type: "number", sourceType: "Number", primary: false, nullable: false, references: { collection: "users", field: "id", onDelete: "CASCADE" } },
    ],
  },
];

describe("TypeORM canonical schema: the tables of entities, as a canonical schema", () => {
  test("every column whose declared type PostgreSQL has, has its canonical type, and the enumerated types are the schema's", () => {
    const schema = databaseSchema(BLOG);
    const types = Object.fromEntries(schema.tables.flatMap((table) => table.columns.map((column) => [`${table.name}.${column.name}`, column.canonicalType])));
    assert.deepEqual(types, {
      "users.id": { kind: "integer", bits: 32 },
      "users.email": { kind: "varchar", length: 200 },
      "users.bio": { kind: "text" },
      "users.active": { kind: "boolean" },
      "users.role": { kind: "enum", name: "users_role_enum" },
      "users.created_at": { kind: "timestamp", withTimeZone: false },
      "posts.id": { kind: "uuid" },
      "posts.title": { kind: "varchar" },
      "posts.price": { kind: "decimal", precision: 10, scale: 2 },
      "posts.views": { kind: "integer", bits: 64 },
      "posts.meta": { kind: "json", binary: true },
      "posts.tags": { kind: "array", element: { kind: "varchar" } },
      "posts.published_at": { kind: "timestamp", withTimeZone: true },
      "posts.authorId": { kind: "integer", bits: 32 },
    });
    assert.deepEqual(schema.types, { enums: [{ name: "users_role_enum", values: ["admin", "editor", "reader"] }] });
    // How the entity spelled a type stays what was declared; the canonical type is beside it.
    assert.deepEqual([schema.tables[0]?.columns[1]?.declaredType, schema.tables[0]?.columns[1]?.type], ["varchar", "text"]);
    // The values of an enumerated column are not enforced by the runtime for it: the column does not carry them.
    assert.equal(schema.tables[0]?.columns[4]?.enum, undefined);
  });

  test("the tables without canonical types are what they always were: for a storage that cannot hold them", () => {
    const plain = tableSchemas(BLOG);
    assert.equal(plain.flatMap((table) => table.columns).some((column) => column.canonicalType !== undefined), false);
    const withTypes = databaseSchema(BLOG).tables;
    assert.deepEqual(
      withTypes.map((table) => ({ ...table, columns: table.columns.map(({ canonicalType: _type, ...column }) => column) })),
      plain,
    );
  });

  test("a column whose type PostgreSQL does not have keeps what was declared, and no canonical type: nothing is made up", () => {
    const schema = databaseSchema([{ name: "legacy", source: "Legacy", fields: [{ name: "id", type: "number", sourceType: "tinyint", primary: true, nullable: false }, { name: "at", type: "date", sourceType: "datetime", primary: false, nullable: true }] }]);
    assert.deepEqual(schema.tables[0]?.columns.map((column) => [column.declaredType, column.canonicalType]), [
      ["tinyint", undefined],
      ["datetime", undefined],
    ]);
  });

  test("two columns that name one enumerated type share it; two that give one name to different values keep the first, and say nothing more of the second", () => {
    const shared = (values: string[]): ImportedCollection[] => [
      { name: "a", source: "A", fields: [{ name: "s", type: "string", sourceType: "enum", primary: false, nullable: false, enum: ["x", "y"], enumName: "state" }] },
      { name: "b", source: "B", fields: [{ name: "s", type: "string", sourceType: "enum", primary: false, nullable: false, enum: values, enumName: "state" }] },
    ];
    assert.deepEqual(databaseSchema(shared(["x", "y"])).types.enums, [{ name: "state", values: ["x", "y"] }]);
    const differing = databaseSchema(shared(["x", "z"]));
    assert.deepEqual(differing.types.enums, [{ name: "state", values: ["x", "y"] }]);
    assert.deepEqual(differing.tables.map((table) => table.columns[0]?.canonicalType), [{ kind: "enum", name: "state" }, undefined]);
  });
});

describe("TypeORM canonical schema: through the diff, the plan, and the PostgreSQL generator", () => {
  const NOTHING: DatabaseSchema = { tables: [], types: { enums: [] } };

  test("a schema from entities is written as PostgreSQL, and PostgreSQL's own schema of that is the same schema", async () => {
    const schema = databaseSchema(BLOG);
    // The round trip: generated from nothing, collected as migrations, compared with the schema from the entities. (Entities name no constraints.)
    const { sql, generation } = await arrives(NOTHING, schema, {}, { names: false });
    assert.equal(generation.status, "generated");
    assert.deepEqual(sql, [
      `CREATE TYPE "users_role_enum" AS ENUM ('admin', 'editor', 'reader')`,
      [
        `CREATE TABLE "posts" (`,
        `  "id" uuid NOT NULL,`,
        `  "title" varchar NOT NULL,`,
        `  "price" numeric(10,2),`,
        `  "views" bigint DEFAULT 0 NOT NULL,`,
        `  "meta" jsonb,`,
        `  "tags" varchar[],`,
        `  "published_at" timestamp with time zone,`,
        `  "authorId" integer NOT NULL,`,
        `  PRIMARY KEY ("id")`,
        `)`,
      ].join("\n"),
      [
        `CREATE TABLE "users" (`,
        `  "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,`,
        `  "email" varchar(200) NOT NULL,`,
        `  "bio" text,`,
        `  "active" boolean DEFAULT true NOT NULL,`,
        `  "role" "users_role_enum" DEFAULT 'reader' NOT NULL,`,
        `  "created_at" timestamp NOT NULL,`,
        `  PRIMARY KEY ("id")`,
        `)`,
      ].join("\n"),
      `ALTER TABLE "posts" ADD FOREIGN KEY ("authorId") REFERENCES "users" ("id") ON DELETE CASCADE`,
    ]);
  });

  test("a change of the entities is a diff, a plan, and a migration: what was refused for want of a canonical type is written", () => {
    const changed = structuredClone(BLOG);
    const users = changed[0] as ImportedCollection;
    users.fields = users.fields.filter((entry) => entry.name !== "bio");
    users.fields.push({ name: "nickname", type: "string", sourceType: "varchar", length: 40, primary: false, nullable: true });
    (users.fields.find((entry) => entry.name === "role") as ImportedField).enum = ["admin", "editor", "reader", "guest"];
    (users.fields.find((entry) => entry.name === "email") as ImportedField).length = 320;
    const [before, after] = [databaseSchema(BLOG), databaseSchema(changed)];
    assert.deepEqual(
      diffSchemas(before, after).changes.map((change) => change.op),
      ["dropColumn", "addEnumValue", "addColumn", "alterColumnType"],
    );
    const { generation } = generate(before, after);
    assert.ok(generation.status === "generated", JSON.stringify(generation));
    assert.deepEqual(
      statementsOf(generation.migration).map((statement) => statement.sql),
      [`ALTER TABLE "users" DROP COLUMN "bio"`, `ALTER TYPE "users_role_enum" ADD VALUE 'guest' AFTER 'reader'`, `ALTER TABLE "users" ADD COLUMN "nickname" varchar(40)`, `ALTER TABLE "users" ALTER COLUMN "email" TYPE varchar(320)`],
    );
    // Without canonical types, the same change is refused: a type is written from what it is.
    const refused = generate({ tables: tableSchemas(BLOG), types: { enums: [] } }, { tables: tableSchemas(changed), types: { enums: [] } }).generation;
    assert.equal(refused.status, "refused");
    assert.ok(refused.status === "refused" && refused.refusals.every((refusal) => refusal.reason === "no-canonical-type"));
  });
});
