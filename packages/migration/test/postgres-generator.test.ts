import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ColumnSchema, DatabaseSchema } from "../../runtime/src/index.ts";
import { BIGINT, INTEGER, TEXT, column, enumType, keyColumn, origin, renamed, schema, table } from "../../schema-diff/test/support.ts";
import { MigrationPlanError } from "../src/index.ts";
import type { MigrationPlan } from "../src/index.ts";
import { generatePostgresMigration, renderPostgresMigration, stringifyPostgresMigration } from "../src/postgres/index.ts";
import type { PostgresGeneration, StepAssessment } from "../src/postgres/index.ts";
import { arrives, generate, roundTrip, statementsOf } from "./support/postgres-round-trip.ts";
import { deepFreeze } from "./support/semantic-form.ts";

/*
 * The PostgreSQL generator (D-039) on schemas that are written here, not
 * collected: what a collector never gives (a constraint without a name, a
 * column without a canonical type, two objects whose names PostgreSQL keeps
 * in one place), a plan that is written by hand, and what a migration is as
 * text: a script, and JSON.
 */

const brief = (steps: readonly StepAssessment[]): string[] => steps.filter((step) => step.safety !== "safe").map((step) => `${step.step}. ${step.operation}: ${step.safety} (${step.reason})`);

function refusals(before: DatabaseSchema, after: DatabaseSchema, options: { assumeValidData?: boolean } = {}): StepAssessment[] {
  const { generation } = generate(before, after, options);
  assert.equal(generation.status, "refused", "a migration was generated");
  return generation.status === "refused" ? generation.refusals : [];
}

const sqlOf = (generation: PostgresGeneration): string[] => (generation.status === "generated" ? statementsOf(generation.migration).map((statement) => statement.sql) : assert.fail(`refused: ${JSON.stringify(generation.refusals)}`));

/** A column of arrays of an enumerated type. */
const enumArray = (name: string, type: string, extra: Partial<ColumnSchema> = {}): ColumnSchema => ({ name, type: "json", canonicalType: { kind: "array", element: { kind: "enum", name: type } }, declaredType: `${type}[]`, nullable: true, primary: false, ...extra });

describe("PostgreSQL generator: constraints that a schema does not name", () => {
  test("one that is added is added without a name, and PostgreSQL gives it one", async () => {
    const before = schema([table("p", [keyColumn("id")]), table("t", [column("id", INTEGER, { nullable: false }), column("a"), column("p_id")])]);
    const after = schema([table("p", [keyColumn("id")]), table("t", [keyColumn("id"), column("a"), column("p_id", INTEGER, { references: { table: "p", column: "id", onDelete: "set null" } })], { uniques: [{ columns: ["a"] }], checks: [{ expression: "a > 0" }] })]);
    const { sql } = await arrives(before, after, {}, { names: false });
    assert.deepEqual(sql, [`ALTER TABLE "t" ADD PRIMARY KEY ("id")`, `ALTER TABLE "t" ADD UNIQUE ("a")`, `ALTER TABLE "t" ADD CHECK (a > 0)`, `ALTER TABLE "t" ADD FOREIGN KEY ("p_id") REFERENCES "p" ("id") ON DELETE SET NULL`]);
  });

  test("a table is created with them", async () => {
    const after = schema([table("t", [keyColumn("id"), column("a", TEXT)], { uniques: [{ columns: ["a"] }], checks: [{ expression: "a <> ''" }] })]);
    const { sql } = await arrives(schema([]), after, {}, { names: false });
    assert.deepEqual(sql, [[`CREATE TABLE "t" (`, `  "id" integer NOT NULL,`, `  "a" text,`, `  PRIMARY KEY ("id"),`, `  UNIQUE ("a"),`, `  CHECK (a <> '')`, `)`].join("\n")]);
  });

  test("one that is dropped is refused: PostgreSQL drops a constraint by its name", () => {
    const before = schema([table("p", [keyColumn("id")]), table("t", [keyColumn("id"), column("a"), column("p_id", INTEGER, { references: { table: "p", column: "id" } })], { uniques: [{ columns: ["a"] }], checks: [{ expression: "a > 0" }] })]);
    const after = schema([table("p", [keyColumn("id")]), table("t", [column("id", INTEGER, { nullable: false }), column("a"), column("p_id")])]);
    const refused = refusals(before, after);
    assert.deepEqual(brief(refused), [
      '1. dropForeignKey of table "t": unsupported (constraint-name-unknown)',
      '2. dropCheck of table "t": unsupported (constraint-name-unknown)',
      '3. dropUnique of table "t": unsupported (constraint-name-unknown)',
      '4. dropPrimaryKey of table "t": unsupported (constraint-name-unknown)',
    ]);
    assert.equal(refused[3]?.detail, 'The primary key of table "t" that is dropped has no name in the schema. PostgreSQL drops a constraint by its name, and nothing here says what the database calls it.');
  });

  test("a foreign key without a name that rests on a key which is dropped is refused too: it would have to be dropped and added again", () => {
    const before = schema([table("p", [keyColumn("id")], { primaryKey: { name: "p_pkey", columns: ["id"] } }), table("c", [column("p_id", INTEGER, { references: { table: "p", column: "id" } })])]);
    const after = schema([table("p", [column("id", INTEGER, { nullable: false })], { uniques: [{ name: "p_id_key", columns: ["id"] }] }), table("c", [column("p_id", INTEGER, { references: { table: "p", column: "id" } })])]);
    const refused = refusals(before, after);
    assert.deepEqual(brief(refused), ['1. dropPrimaryKey "p_pkey" of table "p": unsupported (constraint-name-unknown)']);
    assert.match(refused[0]?.detail ?? "", /^A foreign key of table "c" over \(p_id\) has to be dropped for this step and added again, and the schema has no name for it\./);
  });
});

describe("PostgreSQL generator: types are written from what they are", () => {
  test("how a source spelled a type is never written", async () => {
    const before = schema([table("t", [column("a", { ...INTEGER, declaredType: "int4 /* as declared */" })])]);
    const after = schema([table("t", [column("a", { ...BIGINT, declaredType: 'INT8"; DROP TABLE users; --' }), column("b", { ...TEXT, declaredType: "longtext" })])]);
    const { sql } = await arrives(before, after);
    assert.deepEqual(sql, [`ALTER TABLE "t" ADD COLUMN "b" text`, `ALTER TABLE "t" ALTER COLUMN "a" TYPE bigint`]);
  });

  test("a column without a canonical type is refused wherever its type would be written", () => {
    const spelled = { type: "integer" as const, declaredType: "int" };
    const before = schema([table("t", [column("a", spelled), column("d", spelled)])]);
    const after = schema([table("t", [column("a", { type: "integer", declaredType: "bigint" }), column("b", { type: "text", declaredType: "text" }), column("d", spelled, { default: 1 })]), table("u", [column("c", spelled)])]);
    const refused = refusals(before, after);
    assert.deepEqual(brief(refused), ['1. addTable "u": unsupported (no-canonical-type)', '2. addColumn "t"."b": unsupported (no-canonical-type)', '3. alterColumnType "t"."a": unsupported (no-canonical-type)', '4. setDefault "t"."d": unsupported (no-canonical-type)']);
    assert.equal(refused[1]?.detail, 'The column "t"."b" says how its type was spelled ("text"), and not what the type is. A type is written from what it is.');
  });

  test("what needs no type is written for such a schema all the same", () => {
    const spelled = { type: "integer" as const, declaredType: "int" };
    const before = schema([table("t", [column("a", spelled), column("b", spelled, { nullable: false })]), table("gone", [column("x", spelled)])]);
    const after = schema([table("t", [column("b", spelled)], { indexes: [{ name: "t_b", columns: ["b"] }] })]);
    assert.deepEqual(sqlOf(generate(before, after).generation), [`ALTER TABLE "t" DROP COLUMN "a"`, `DROP TABLE "gone"`, `ALTER TABLE "t" ALTER COLUMN "b" DROP NOT NULL`, `CREATE INDEX "t_b" ON "t" ("b")`]);
  });

  test("a type of another database is refused", () => {
    const refused = refusals(schema([table("t", [column("a")])]), schema([table("t", [column("a"), column("b", { type: "integer", canonicalType: { kind: "other", dialect: "mysql", name: "tinyint", modifiers: [1] }, declaredType: "tinyint(1)" })])]));
    assert.deepEqual(brief(refused), ['1. addColumn "t"."b": unsupported (type-not-representable)']);
  });

  test("a constant that the schema does not hold exactly, and a name that PostgreSQL would cut short, are refused", () => {
    const long = "n".repeat(64);
    const refused = refusals(schema([table("t", [column("a", BIGINT)])]), schema([table("t", [column("a", BIGINT, { default: 2 ** 60 }), column(long)])]));
    assert.deepEqual(brief(refused), [`1. addColumn "t"."${long}": unsupported (name-not-representable)`, '2. setDefault "t"."a": unsupported (value-not-representable)']);
  });
});

describe("PostgreSQL generator: what PostgreSQL does with a statement beyond what it says", () => {
  test("a table with several keys over the same columns: PostgreSQL leaves the later ones out of CREATE TABLE, so they are added on their own", async () => {
    const after = schema([
      table("t", [keyColumn("a"), column("b")], {
        primaryKey: { name: "t_pkey", columns: ["a"] },
        uniques: [
          { name: "also_a", columns: ["a"] },
          { name: "a_b", columns: ["a", "b"] },
          { name: "b_a", columns: ["b", "a"] },
          { name: "a_b_again", columns: ["a", "b"] },
        ],
      }),
    ]);
    const { sql, generation } = await arrives(schema([]), after);
    assert.deepEqual(sql, [
      [`CREATE TABLE "t" (`, `  "a" integer NOT NULL,`, `  "b" integer,`, `  CONSTRAINT "t_pkey" PRIMARY KEY ("a"),`, `  CONSTRAINT "a_b" UNIQUE ("a", "b"),`, `  CONSTRAINT "b_a" UNIQUE ("b", "a")`, `)`].join("\n"),
      `ALTER TABLE "t" ADD CONSTRAINT "a_b_again" UNIQUE ("a", "b")`,
      `ALTER TABLE "t" ADD CONSTRAINT "also_a" UNIQUE ("a")`,
    ]);
    assert.deepEqual(generation.status === "generated" && statementsOf(generation.migration).map((statement) => statement.because ?? null), [null, "key-over-the-same-columns", "key-over-the-same-columns"]);
  });
});

describe("PostgreSQL generator: what PostgreSQL cannot have", () => {
  const P = table("p", [keyColumn("id"), column("code")], { primaryKey: { name: "p_pkey", columns: ["id"] } });

  test("two objects whose names PostgreSQL keeps in one place", () => {
    const T = table("t", [column("a")]);
    const one = (after: DatabaseSchema): string[] => brief(refusals(schema([P, T]), after));
    // An index like a table, a key like another table's key, a key like its own table.
    assert.deepEqual(one(schema([P, table("t", [column("a")], { indexes: [{ name: "p", columns: ["a"] }] })])), ['1. addIndex "p" of table "t": unsupported (name-conflict)']);
    assert.deepEqual(one(schema([P, table("t", [column("a")], { uniques: [{ name: "p_pkey", columns: ["a"] }] })])), ['1. addUnique "p_pkey" of table "t": unsupported (name-conflict)']);
    assert.deepEqual(one(schema([P, T, table("u", [keyColumn("id")], { primaryKey: { name: "u", columns: ["id"] } })])), ['1. addTable "u": unsupported (name-conflict)']);
    // A table and an enumerated type: a table has a type of its own name.
    assert.deepEqual(one(schema([P, T], [{ name: "t", values: ["x"] }])), ['1. addEnumType "t": unsupported (name-conflict)']);
    const refused = refusals(schema([P], [{ name: "status", values: ["x"] }]), schema([P, table("status", [column("a")])], [{ name: "status", values: ["x"] }]));
    assert.deepEqual(brief(refused), ['1. addTable "status": unsupported (name-conflict)']);
    assert.equal(refused[0]?.detail, 'The table "status" would have the name of the enumerated type "status". PostgreSQL keeps a type for every table, under the table\'s name.');
  });

  test("a foreign key to columns that no key is over, and one with an action PostgreSQL does not have", () => {
    const refused = refusals(schema([P, table("t", [column("x"), column("y")])]), schema([P, table("t", [column("x", INTEGER, { references: { table: "p", column: "code", name: "t_x_fkey" } }), column("y", INTEGER, { references: { table: "p", column: "id", name: "t_y_fkey", onDelete: "ERASE" } })])]));
    assert.deepEqual(brief(refused), ['1. addForeignKey "t_x_fkey" of table "t": unsupported (foreign-key-without-key)', '2. addForeignKey "t_y_fkey" of table "t": unsupported (unknown-referential-action)']);
    assert.match(refused[0]?.detail ?? "", /refers to "p" \(code\), and no primary key, unique constraint, or unique index is over exactly those columns at this step/);
  });

  test("a column of a primary key that is said to take NULL", () => {
    const takesNull = column("id", INTEGER, { nullable: true, primary: true });
    assert.deepEqual(brief(refusals(schema([]), schema([table("t", [takesNull], { primaryKey: { name: "t_pkey", columns: ["id"] } })]))), ['1. addTable "t": unsupported (primary-key-column-takes-null)']);
    assert.deepEqual(brief(refusals(schema([table("t", [column("id")])]), schema([table("t", [takesNull], { primaryKey: { name: "t_pkey", columns: ["id"] } })]))), ['1. addPrimaryKey "t_pkey" of table "t": unsupported (primary-key-column-takes-null)']);
  });

  test("a numbered column that is to take NULL, and stays numbered", () => {
    // PostgreSQL's numbered column takes no NULL: one that does has a sequence of its own, which a schema does not hold.
    const numbered = (nullable: boolean): DatabaseSchema => schema([table("t", [column("id", INTEGER, { nullable, generated: "increment" })])]);
    const refused = refusals(numbered(false), numbered(true));
    assert.deepEqual(brief(refused), ['1. dropNotNull "t"."id": unsupported (numbering-not-representable)']);
    assert.match(refused[0]?.detail ?? "", /^The column "t"\."id" is numbered, and is to take NULL/);
    assert.deepEqual(brief(refusals(schema([]), numbered(true))), ['1. addTable "t": unsupported (numbering-not-representable)']);
  });

  test("an expression with nothing in it", () => {
    assert.deepEqual(brief(refusals(schema([table("t", [column("a")])]), schema([table("t", [column("a")], { checks: [{ name: "empty", expression: "  " }] })]))), ['1. addCheck "empty" of table "t": unsupported (expression-not-representable)']);
  });

  test("a default that is no value of its type when the type is made again, and that no step changes", () => {
    const moods = (values: string[]): DatabaseSchema => schema([table("t", [enumArray("ms", "mood", { default: ["happy", "ok"] }), column("m", enumType("mood"), { default: "ok" })])], [{ name: "mood", values }]);
    const refused = refusals(moods(["sad", "ok", "happy"]), moods(["sad", "ok"]), { assumeValidData: true });
    assert.deepEqual(brief(refused), ['1. removeEnumValue "happy" of enumerated type "mood": unsupported (default-not-a-value-of-its-type)']);
    assert.equal(refused[0]?.detail, 'The default of the column "t"."ms" is no value of the type the column has from this step on, and no later step of the plan changes it.');
  });
});

describe("PostgreSQL generator: it carries out the plan it is given", () => {
  const before = schema([table("p", [keyColumn("id")], { primaryKey: { name: "p_pkey", columns: ["id"], origin: origin("p_pkey", "0001_init.sql", 2) } }), table("c", [column("p_id", INTEGER, { references: { table: "p", column: "id", name: "c_fk", origin: origin("c_fk", "0001_init.sql", 4) } })])]);

  test("the steps are taken in the order of the plan, which need not be the planner's", async () => {
    const start = schema([table("t", [column("a")])]);
    const plan: MigrationPlan = {
      version: 1,
      steps: [
        { op: "addColumn", table: "t", column: "z", after: { name: "z", type: { storage: "text", canonical: { kind: "text" } }, nullable: true } },
        { op: "addColumn", table: "t", column: "b", after: { name: "b", type: { storage: "integer", canonical: { kind: "integer", bits: 32 } }, nullable: true } },
      ],
    };
    assert.deepEqual(sqlOf(generatePostgresMigration(start, plan)), [`ALTER TABLE "t" ADD COLUMN "z" text`, `ALTER TABLE "t" ADD COLUMN "b" integer`]);
  });

  test("a foreign key that went ahead of its key, and that the plan renames: it comes back under its new name, and is not renamed where it is not", async () => {
    const after = schema([
      table("p", [column("id", INTEGER, { nullable: false })], { uniques: [{ name: "p_id_key", columns: ["id"] }] }),
      table("c", [column("p_id", INTEGER, { references: { table: "p", column: "id", name: "c_ref", origin: origin("c_fk", "0001_init.sql", 4), renames: [renamed("c_fk", "c_ref")] } })]),
    ]);
    const { plan, sql } = await arrives(before, after);
    assert.deepEqual(
      plan.steps.map((step) => step.op),
      ["dropPrimaryKey", "renameConstraint", "addUnique"],
    );
    assert.deepEqual(sql, [`ALTER TABLE "c" DROP CONSTRAINT "c_fk"`, `ALTER TABLE "p" DROP CONSTRAINT "p_pkey"`, `ALTER TABLE "p" ADD CONSTRAINT "p_id_key" UNIQUE ("id")`, `ALTER TABLE "c" ADD CONSTRAINT "c_ref" FOREIGN KEY ("p_id") REFERENCES "p" ("id")`]);
  });

  test("a foreign key that went ahead of its key, and that a later step drops: it is not dropped twice, and does not come back", () => {
    const plan: MigrationPlan = {
      version: 1,
      steps: [
        { op: "dropPrimaryKey", table: "p", constraint: "p_pkey", before: { name: "p_pkey", columns: ["id"] } },
        { op: "dropForeignKey", table: "c", constraint: "c_fk", before: { name: "c_fk", columns: ["p_id"], references: { table: "p", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" } },
      ],
    };
    const generation = generatePostgresMigration(before, plan);
    assert.deepEqual(sqlOf(generation), [`ALTER TABLE "c" DROP CONSTRAINT "c_fk"`, `ALTER TABLE "p" DROP CONSTRAINT "p_pkey"`]);
    assert.deepEqual(
      generation.steps.map((step) => `${step.step}. ${step.safety}`),
      ["1. safe", "2. safe"],
    );
  });

  test("a foreign key that would come back with nothing to rest on is refused, at the step it went for", () => {
    // The key goes and nothing over its column comes: the schema to arrive at is one PostgreSQL cannot have.
    const after = schema([table("p", [column("id", INTEGER, { nullable: false })]), table("c", [column("p_id", INTEGER, { references: { table: "p", column: "id", name: "c_fk" } })])]);
    assert.deepEqual(brief(refusals(before, after)), ['1. dropPrimaryKey "p_pkey" of table "p": unsupported (foreign-key-without-key)']);
  });

  test("a plan that cannot be carried out on the schema is an error, as it is to the validator of plans", () => {
    const plan: MigrationPlan = { version: 1, steps: [{ op: "dropTable", table: "nowhere", before: { name: "nowhere", columns: [], uniques: [], checks: [] } }] };
    assert.throws(() => generatePostgresMigration(before, plan), (error) => error instanceof MigrationPlanError && /^Step 1, dropTable "nowhere": there is no table "nowhere"\.$/.test(error.message));
    assert.throws(() => generatePostgresMigration(before, { version: 2, steps: [] } as unknown as MigrationPlan), MigrationPlanError);
  });

  test("neither the schema nor the plan is changed", () => {
    const after = schema([table("p", [column("id", INTEGER, { nullable: false })], { uniques: [{ name: "p_id_key", columns: ["id"] }] }), table("c", [column("p_id", INTEGER, { references: { table: "p", column: "id", name: "c_fk" } })])]);
    const { plan } = generate(before, after);
    const [schemaText, planText] = [JSON.stringify(before), JSON.stringify(plan)];
    // Frozen: a write to either throws.
    assert.equal(generatePostgresMigration(deepFreeze(structuredClone(before)), deepFreeze(structuredClone(plan))).status, "generated");
    assert.deepEqual([JSON.stringify(before), JSON.stringify(plan)], [schemaText, planText]);
  });
});

describe("PostgreSQL generator: a migration as text", () => {
  test("a migration of one transaction, as a script", async () => {
    const { script } = await roundTrip("create table t (id integer);\ncreate table gone (id integer);", "drop table gone;\nalter table t add column note text;");
    assert.equal(
      script,
      ["-- PostgreSQL migration: 2 statements in one transaction.", "", "BEGIN;", "", "-- Step 1. The rows it holds are lost.", 'DROP TABLE "gone";', 'ALTER TABLE "t" ADD COLUMN "note" text;', "", "COMMIT;", ""].join("\n"),
    );
  });

  test("a migration that no transaction holds together says so, and has its transactions written out", async () => {
    const { script } = await roundTrip(
      "create type mood as enum ('sad', 'ok');\ncreate table t (m mood default 'ok');\ncreate table gone (id integer);",
      "drop table gone;\nalter type mood add value 'happy';\nalter table t alter column m set default 'happy';\nalter table t add column was mood not null default 'happy';",
    );
    assert.equal(
      script,
      [
        "-- PostgreSQL migration: 4 statements in 3 segments.",
        "-- It is not one transaction: what a segment did stays when a later segment fails.",
        "-- Run it with a client that sends each statement on its own and adds no transaction of its own (psql -f).",
        "",
        "-- Segment 1 of 3: one transaction.",
        "BEGIN;",
        "",
        "-- Step 1. The rows it holds are lost.",
        'DROP TABLE "gone";',
        "",
        "COMMIT;",
        "",
        "-- Segment 2 of 3: outside a transaction, each statement on its own.",
        "-- A value added to an enumerated type cannot be used before it is committed.",
        `ALTER TYPE "mood" ADD VALUE 'happy' AFTER 'ok';`,
        "",
        "-- Segment 3 of 3: one transaction.",
        "BEGIN;",
        "",
        `ALTER TABLE "t" ADD COLUMN "was" "mood" DEFAULT 'happy' NOT NULL;`,
        `ALTER TABLE "t" ALTER COLUMN "m" SET DEFAULT 'happy';`,
        "",
        "COMMIT;",
        "",
      ].join("\n"),
    );
  });

  test("what PostgreSQL needs for a step is said once, before the statements it takes", async () => {
    const { script } = await roundTrip(
      "create type mood as enum ('sad', 'ok');\ncreate table t (m mood default 'ok');",
      "alter table t alter column m drop default;\nalter type mood rename to mood_before;\ncreate type mood as enum ('ok', 'sad');\nalter table t alter column m type mood using m::text::mood;\ndrop type mood_before;\nalter table t alter column m set default 'ok';",
    );
    assert.equal(
      script,
      [
        "-- PostgreSQL migration: 6 statements in one transaction.",
        "",
        "BEGIN;",
        "",
        "-- Step 1. PostgreSQL takes no value out of an enumerated type and does not reorder its values: the type is made again, and its columns are given the new one.",
        'ALTER TABLE "t" ALTER COLUMN "m" DROP DEFAULT;',
        'ALTER TYPE "mood" RENAME TO "migration_old_1";',
        `CREATE TYPE "mood" AS ENUM ('ok', 'sad');`,
        'ALTER TABLE "t" ALTER COLUMN "m" TYPE "mood" USING "m"::text::"mood";',
        'DROP TYPE "migration_old_1";',
        `ALTER TABLE "t" ALTER COLUMN "m" SET DEFAULT 'ok';`,
        "",
        "COMMIT;",
        "",
      ].join("\n"),
    );
  });

  test("a comment cannot be ended by a name: a line end in one is not a line end in the script", () => {
    const evil = "t\nDROP TABLE users; --";
    const { generation } = generate(schema([table(evil, [column("a")])]), schema([table(evil, [column("a", INTEGER, { nullable: false })])]), { assumeValidData: true });
    assert.ok(generation.status === "generated");
    const lines = renderPostgresMigration(generation.migration).split("\n");
    assert.deepEqual(lines.slice(4, 8), ['-- Step 1. Assumes what the rows are: No row of "t DROP TABLE users; --" may hold NULL in "a".', 'ALTER TABLE "t', 'DROP TABLE users; --" ALTER COLUMN "a" SET NOT NULL;', ""]);
  });

  test("a migration as JSON: the same bytes for the same migration, with every statement's parts and its SQL", async () => {
    const { migration, before, plan } = await roundTrip("create table t (a integer);", "alter table t alter column a set not null, add column m jsonb default '{\"b\": 1, \"a\": [2]}';", { assumeValidData: true });
    const text = stringifyPostgresMigration(migration);
    assert.equal(
      text,
      JSON.stringify(
        {
          version: 1,
          dialect: "postgresql",
          segments: [
            {
              mode: "transaction",
              statements: [
                {
                  step: 1,
                  kind: "addColumn",
                  sql: `ALTER TABLE "t" ADD COLUMN "m" jsonb DEFAULT '{"a":[2],"b":1}'::jsonb`,
                  safety: "safe",
                  table: "t",
                  column: { name: "m", type: { kind: "json", binary: true }, default: { kind: "value", type: { kind: "json", binary: true }, value: { a: [2], b: 1 } }, notNull: false },
                },
                {
                  step: 2,
                  kind: "setNotNull",
                  sql: 'ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL',
                  safety: "requiresDataMigration",
                  assumes: { reason: "rows-may-hold-null", detail: 'No row of "t" may hold NULL in "a".' },
                  table: "t",
                  column: "a",
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );
    assert.equal(stringifyPostgresMigration(migration, 0), JSON.stringify(JSON.parse(text)));
    const again = generatePostgresMigration(before, plan, { assumeValidData: true });
    assert.equal(again.status === "generated" && stringifyPostgresMigration(again.migration), text);
  });
});
