import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StepAssessment } from "../src/postgres/index.ts";
import { ROUND_TRIPS } from "./support/postgres-cases.ts";
import { assertParses, collected, generate, roundTrip } from "./support/postgres-round-trip.ts";

/*
 * The gate of the PostgreSQL generator (D-039). For two schemas A and B:
 *
 *   diffSchemas(A, B) -> planMigration -> generatePostgresMigration -> SQL
 *   the SQL, applied to A by the PostgreSQL collector, gives C
 *   C means B
 *
 * A is what the collector makes of `base`, and B of `base` and `change`. The
 * generated SQL is collected after `base`, in the place of `change`. Each
 * case also says the statements it expects, so that a migration that arrives
 * by another way than the one meant shows too.
 */

/** A step that is not safe, without its sentence for people. */
const brief = (steps: readonly StepAssessment[]): string[] => steps.filter((step) => step.safety !== "safe").map((step) => `${step.step}. ${step.operation}: ${step.safety} (${step.reason})`);

describe("PostgreSQL migrations: generated, applied by the collector, and arriving at the schema they are for", () => {
  for (const entry of ROUND_TRIPS) {
    test(entry.title, async () => {
      const result = await roundTrip(entry.base, entry.change, entry.assumeValidData === true ? { assumeValidData: true } : {});
      assert.deepEqual(result.sql, entry.sql);
      assert.deepEqual(result.segments, entry.segments ?? [`transaction: ${entry.sql.length}`]);
      if (entry.assumeValidData === true) {
        // Without the caller's word that the rows fit, nothing is generated.
        const { generation } = generate(result.before, result.after);
        assert.equal(generation.status, "refused");
        assert.ok(generation.status === "refused" && generation.refusals.every((refusal) => refusal.safety === "requiresDataMigration"));
      }
    });
  }

  test("two schemas that do not differ give a migration without statements", async () => {
    const result = await roundTrip("create table t (id integer primary key);", "comment on table t is 'nothing changes';");
    assert.deepEqual(result.migration, { version: 1, dialect: "postgresql", segments: [] });
    assert.deepEqual(result.generation.steps, []);
    assert.equal(result.script, "-- PostgreSQL migration: no statements.\n");
  });
});

describe("PostgreSQL migrations: what a statement says besides its SQL", () => {
  test("every statement names the step of the plan it carries out", async () => {
    const result = await roundTrip("create table t (a integer, b integer);\ncreate index t_a on t (a);", "drop index t_a;\nalter table t rename column b to c;\nalter table t add column d text;");
    assert.deepEqual(
      result.plan.steps.map((step) => step.op),
      ["dropIndex", "renameColumn", "addColumn"],
    );
    assert.deepEqual(
      result.statements.map((statement) => [statement.step, statement.kind, statement.safety]),
      [
        [1, "dropIndex", "safe"],
        [2, "renameColumn", "safe"],
        [3, "addColumn", "safe"],
      ],
    );
    assert.deepEqual(result.generation.steps, [
      { step: 1, operation: 'dropIndex "t_a" of table "t"', safety: "safe" },
      { step: 2, operation: 'renameColumn "t"."b" to "c"', safety: "safe" },
      { step: 3, operation: 'addColumn "t"."d"', safety: "safe" },
    ]);
  });

  test("a statement that PostgreSQL needs beyond its step says why, and which step it is for", async () => {
    const result = await roundTrip(
      "create table p (id integer, constraint p_pkey primary key (id));\ncreate table c (p_id integer, constraint c_p_id_fkey foreign key (p_id) references p (id));",
      "alter table c drop constraint c_p_id_fkey;\nalter table p drop constraint p_pkey;\nalter table p add constraint p_id_key unique (id);\nalter table c add constraint c_p_id_fkey foreign key (p_id) references p (id);",
    );
    assert.deepEqual(
      result.plan.steps.map((step) => step.op),
      ["dropPrimaryKey", "addUnique"],
    );
    assert.deepEqual(
      result.statements.map((statement) => [statement.step, statement.kind, statement.because ?? null]),
      [
        [1, "dropConstraint", "foreign-key-rests-on-dropped-key"],
        [1, "dropConstraint", null],
        [2, "addConstraint", null],
        [1, "addConstraint", "foreign-key-rests-on-dropped-key"],
      ],
    );
    assert.match(result.script, /^-- Step 1\. PostgreSQL does not drop a key that a foreign key rests on: the foreign key goes first, and is added again after the last step\.\nALTER TABLE "c" DROP CONSTRAINT "c_p_id_fkey";$/m);
  });

  test("a statement that rests on what the rows are says what it assumes of them", async () => {
    const result = await roundTrip("create table t (a integer, b bigint);", "alter table t alter column a set not null, alter column b type integer, add column c text not null;", { assumeValidData: true });
    assert.deepEqual(
      result.statements.map((statement) => [statement.sql, statement.safety, statement.assumes?.reason]),
      [
        ['ALTER TABLE "t" ADD COLUMN "c" text NOT NULL', "requiresDataMigration", "rows-need-a-value"],
        ['ALTER TABLE "t" ALTER COLUMN "b" TYPE integer', "requiresDataMigration", "values-may-not-fit"],
        ['ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL', "requiresDataMigration", "rows-may-hold-null"],
      ],
    );
    assert.deepEqual(brief(result.generation.steps), ['1. addColumn "t"."c": requiresDataMigration (rows-need-a-value)', '2. alterColumnType "t"."b": requiresDataMigration (values-may-not-fit)', '3. setNotNull "t"."a": requiresDataMigration (rows-may-hold-null)']);
    assert.match(result.script, /^-- Step 3\. Assumes what the rows are: No row of "t" may hold NULL in "a"\.\nALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;$/m);
    // Without the caller's word: the same three steps, refused, and no migration.
    const { generation } = generate(result.before, result.after);
    assert.equal(generation.status, "refused");
    assert.deepEqual(brief(generation.status === "refused" ? generation.refusals : []), brief(result.generation.steps));
  });

  test("a statement that drops rows says so", async () => {
    const result = await roundTrip("create table t (a integer, b integer);\ncreate table gone (id integer);", "alter table t drop column b;\ndrop table gone;");
    assert.deepEqual(
      result.statements.map((statement) => [statement.sql, statement.dropsData ?? false]),
      [
        ['ALTER TABLE "t" DROP COLUMN "b"', true],
        ['DROP TABLE "gone"', true],
      ],
    );
    assert.match(result.script, /^-- Step 2\. The rows it holds are lost\.\nDROP TABLE "gone";$/m);
  });

  test("a statement lists the expressions it holds as their source wrote them", async () => {
    const result = await roundTrip(
      "create table t (a integer, b text);",
      "alter table t add constraint positive check ((a > 0) or (a is null)), add column c timestamptz default now(), alter column b set default ('x' || 'y');\ncreate index t_lower on t (lower(b)) where a > 0;\ncreate table u (d integer default (1 + 1), e text, check (e <> ''));",
    );
    assert.deepEqual(
      result.statements.map((statement) => [statement.kind, statement.expressions ?? []]),
      [
        ["createTable", ["1 + 1", "e <> ''"]],
        ["addColumn", ["now()"]],
        ["setDefault", ["'x' || 'y'"]],
        ["addConstraint", ["(a > 0) or (a is null)"]],
        ["createIndex", ["lower(b)", "a > 0"]],
      ],
    );
  });

  test("an index over columns and expressions lists its expressions too, in the order of its keys: each is checked to be one expression", async () => {
    const result = await roundTrip("create table t (a integer, b text);", "create index t_mixed on t (a, lower(b), (a + 1) desc) where a > 0;");
    assert.deepEqual(
      result.statements.map((statement) => [statement.kind, statement.expressions ?? []]),
      [["createIndex", ["lower(b)", "a + 1", "a > 0"]]],
    );
  });

  test("PostgreSQL parses each kind of statement as what it is meant to be", async () => {
    const result = await roundTrip(
      "create type mood as enum ('sad');\ncreate table t (a integer, b integer, constraint t_check check (a > 0));\ncreate index t_a on t (a);\ncreate table gone (id integer);",
      "drop table gone;\nalter table t rename constraint t_check to t_positive;\nalter index t_a rename to t_a_idx;\nalter type mood add value 'ok';\ncreate table u (id integer primary key);\nalter table t add column c mood, alter column b set default 1;\ncreate index t_b on t (b);",
    );
    assert.deepEqual(
      (await assertParses(result.migration)).map((kind, index) => `${result.statements[index]?.kind}: ${kind}`),
      ["dropTable: DropStmt", "renameConstraint: RenameStmt", "renameIndex: RenameStmt", "addEnumValue: AlterEnumStmt", "createTable: CreateStmt", "addColumn: AlterTableStmt", "setDefault: AlterTableStmt", "createIndex: IndexStmt"],
    );
  });
});

describe("PostgreSQL migrations: what is not generated is refused, with the step and the reason", () => {
  const refusals = async (base: string, change: string, options: { assumeValidData?: boolean } = {}): Promise<StepAssessment[]> => {
    const { generation } = generate(await collected({ "0001_base.sql": base }), await collected({ "0001_base.sql": base, "0002_change.sql": change }), options);
    assert.equal(generation.status, "refused");
    return generation.status === "refused" ? generation.refusals : [];
  };

  test("a type change that PostgreSQL has no conversion for: how the values are converted is not made up", async () => {
    const refused = await refusals("create table t (a text, b integer, c numeric(10,4), d timestamp);", "alter table t alter column a type integer using a::integer, alter column b type boolean using b <> 0, alter column c type numeric(10,2), alter column d type timestamptz;", { assumeValidData: true });
    assert.deepEqual(brief(refused), [
      '1. alterColumnType "t"."a": requiresExplicitCast (no-safe-conversion)',
      '2. alterColumnType "t"."b": requiresExplicitCast (no-safe-conversion)',
      '3. alterColumnType "t"."c": requiresExplicitCast (no-safe-conversion)',
      '4. alterColumnType "t"."d": requiresExplicitCast (no-safe-conversion)',
    ]);
    assert.match(refused[0]?.detail ?? "", /^PostgreSQL has no conversion from text to integer that it makes on its own and that is known to keep every value\. How the values of text become values of integer has to be said \(USING\), and is not made up\.$/);
    assert.match(refused[2]?.detail ?? "", /^PostgreSQL rounds a value of numeric\(10,4\) to the digits numeric\(10,2\) has after the point\./);
    assert.match(refused[3]?.detail ?? "", /time zone of the session/);
  });

  test("what rests on the rows is refused unless the caller says that they fit", async () => {
    const refused = await refusals(
      "create type mood as enum ('sad', 'ok');\ncreate type less as enum ('ok');\ncreate table t (a integer, b bigint, m mood);",
      "alter table t alter column a set not null, alter column b type integer, add column c text not null, alter column m type less using m::text::less;\ndrop type mood;",
    );
    assert.deepEqual(brief(refused), [
      '1. addColumn "t"."c": requiresDataMigration (rows-need-a-value)',
      '2. alterColumnType "t"."b": requiresDataMigration (values-may-not-fit)',
      '3. alterColumnType "t"."m": requiresDataMigration (rows-may-hold-removed-value)',
      '4. setNotNull "t"."a": requiresDataMigration (rows-may-hold-null)',
    ]);
    assert.equal(refused[0]?.detail, 'The table "t" may have rows, and the new column "c" takes no NULL and has no default: PostgreSQL has no value for them.');
    assert.equal(refused[2]?.detail, 'The type enum less has no value "sad", which enum mood has. PostgreSQL refuses the statement when a row holds one.');
    assert.equal(refused[3]?.detail, 'No row of "t" may hold NULL in "a".');
  });

  test("a value taken out of an enumerated type that columns have: every step of it", async () => {
    const refused = await refusals(
      "create type mood as enum ('awful', 'sad', 'ok');\ncreate table t (m mood);",
      "alter type mood rename to mood_before;\ncreate type mood as enum ('ok');\nalter table t alter column m type mood using m::text::mood;\ndrop type mood_before;",
    );
    assert.deepEqual(brief(refused), ['1. removeEnumValue "awful" of enumerated type "mood": requiresDataMigration (rows-may-hold-removed-value)', '2. removeEnumValue "sad" of enumerated type "mood": requiresDataMigration (rows-may-hold-removed-value)']);
    assert.equal(refused[0]?.detail, 'No row may hold "awful" or "sad" in "t"."m": the type "mood" is made again without them.');
  });

  test("a value taken out of an enumerated type that no column has is safe: there are no rows of it", async () => {
    const result = await roundTrip("create type mood as enum ('awful', 'sad', 'ok');\ncreate table t (id integer);", "drop type mood;\ncreate type mood as enum ('ok', 'sad');");
    assert.deepEqual(result.sql, [`DROP TYPE "mood"`, `CREATE TYPE "mood" AS ENUM ('ok', 'sad')`]);
  });

  test("a numbered column that takes NULL, and numbering given to a column that is there", async () => {
    assert.deepEqual(brief(await refusals("create table t (id integer);\ncreate sequence t_n_seq;", "alter table t add column n integer default nextval('t_n_seq');")), ['1. addColumn "t"."n": unsupported (numbering-not-representable)']);
    const given = await refusals("create table t (id integer not null);", "alter table t alter column id add generated by default as identity;");
    assert.deepEqual(brief(given), ['1. setDefault "t"."id": unsupported (numbering-not-representable)']);
    assert.match(given[0]?.detail ?? "", /^The column "t"\."id" is there already, and is to be numbered/);
  });

  test("an index that has more to it than the schema holds, and a constraint that has: written from the rest, it would be another one", async () => {
    const refused = await refusals("create table p (id integer primary key);\ncreate table t (a text, b integer);", "create index t_fill on t (b) with (fillfactor = 70);\nalter table t add constraint t_p foreign key (b) references p (id) match full;");
    assert.deepEqual(brief(refused), ['1. addIndex "t_fill" of table "t": unsupported (index-not-representable)', '2. addForeignKey "t_p" of table "t": unsupported (constraint-not-representable)']);
    assert.equal(refused[0]?.detail, 'The index "t_fill" of table "t" says what the schema has no place for: WITH (fillfactor=70). Written from the rest, it would be another index.');
    assert.equal(refused[1]?.detail, 'The foreign key "t_p" of table "t" says what the schema has no place for: MATCH FULL. Written from the rest, it would be another constraint.');
  });

  test("an expression that a rename has left behind is not written into a table that is made from the schema", async () => {
    // The schema of these migrations has the check as it was written, over `a`, which is `amount` now, and another column is `a`.
    const refused = await refusals("create table other (id integer);", "create table t (a integer, constraint t_a check (a > 0));\nalter table t rename column a to amount;\nalter table t add column a text;");
    assert.deepEqual(brief(refused), ['1. addTable "t": unsupported (stale-expression-after-rename)']);
    assert.equal(
      refused[0]?.detail,
      'The check "t_a" of table "t" was written as (a > 0) when things had other names: column "a" is "amount" now. PostgreSQL has what the text meant, and the schema has the text as it was written: written into a database again, it would be refused, or be of whatever has that name by now.',
    );
  });

  test("a type of PostgreSQL's that the schema keeps as PostgreSQL holds it, not as it is written", async () => {
    const refused = await refusals("create table t (id integer);", "alter table t add column span interval day to second;");
    assert.deepEqual(brief(refused), ['1. addColumn "t"."span": unsupported (type-not-representable)']);
  });

  test("refused steps are all named, and the steps that could be written are not held against the migration", async () => {
    const { generation } = generate(await collected({ "0001_base.sql": "create table t (a text, b integer);" }), await collected({ "0001_base.sql": "create table t (a text, b integer);", "0002_change.sql": "alter table t alter column a type integer using 0, add column c text;\ncreate index t_fill on t (b) with (fillfactor = 70);" }));
    assert.equal(generation.status, "refused");
    assert.deepEqual(
      generation.steps.map((step) => `${step.step}. ${step.safety}`),
      ["1. safe", "2. requiresExplicitCast", "3. unsupported"],
    );
    assert.deepEqual(brief(generation.status === "refused" ? generation.refusals : []), ['2. alterColumnType "t"."a": requiresExplicitCast (no-safe-conversion)', '3. addIndex "t_fill" of table "t": unsupported (index-not-representable)']);
  });
});
