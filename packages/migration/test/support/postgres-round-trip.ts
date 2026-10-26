import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { collectMigrationFiles } from "../../../import-postgres/src/index.ts";
import type { MigrationFile } from "../../../import-postgres/src/index.ts";
import { checkSqlStatements } from "../../../import-postgres/src/sql-check.ts";
import type { DatabaseSchema } from "../../../runtime/src/index.ts";
import { diffSchemas } from "../../../schema-diff/src/index.ts";
import { planMigration } from "../../src/index.ts";
import type { MigrationPlan } from "../../src/index.ts";
import { generatePostgresMigration, renderPostgresMigration, stringifyPostgresMigration } from "../../src/postgres/index.ts";
import type { PostgresGeneration, PostgresGenerationOptions, PostgresMigration, PostgresStatement } from "../../src/postgres/index.ts";
import { listedDifferently } from "./history-generator.ts";
import { assertSameSchema, deepFreeze } from "./semantic-form.ts";
import type { FormOptions } from "./semantic-form.ts";

/*
 * The round trip that the PostgreSQL generator is held to (D-039):
 *
 *   schema A  --diff, plan, generate-->  SQL
 *   the SQL applied to A, by the collector  -->  schema C
 *   C means B
 *
 * A and B are what the collector makes of migrations: `base`, and `base`
 * with `change` after it. The generated SQL is then collected after `base`
 * in place of `change`. The collector applies statements as PostgreSQL does,
 * and refuses what PostgreSQL refuses of them, so a statement in the wrong
 * place, or one that names what is not there, fails here.
 *
 * Every statement is also given to PostgreSQL's own parser, with the
 * expressions that were copied into it.
 */

function migrationFile(file: string, sql: string): MigrationFile {
  const bytes = Buffer.from(sql, "utf8");
  return { file, path: file, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The schema that migrations leave, by the collector: the files by name, in the order given. */
export async function collected(files: Record<string, string>): Promise<DatabaseSchema> {
  const result = await collectMigrationFiles(
    "migrations",
    Object.entries(files).map(([file, sql]) => migrationFile(file, sql)),
  );
  return { tables: result.tables, types: result.types };
}

export const statementsOf = (migration: PostgresMigration): PostgresStatement[] => migration.segments.flatMap((segment) => segment.statements);

/** Fails unless PostgreSQL's parser takes every statement as one statement, and every expression copied into one as one expression. Gives what each was parsed as. */
export async function assertParses(migration: PostgresMigration): Promise<string[]> {
  const statements = statementsOf(migration);
  const checks = await checkSqlStatements(statements.map((statement) => ({ sql: statement.sql, ...(statement.expressions !== undefined && { expressions: statement.expressions }) })));
  for (const [index, check] of checks.entries()) {
    assert.equal(check.problem, undefined, `${statements[index]?.sql}\n${check.problem}`);
  }
  return checks.map((check) => check.kind as string);
}

/** The generated migration of the plan from one schema to another; the plan and the schema are not changed by it. */
export function generate(before: DatabaseSchema, after: DatabaseSchema, options: PostgresGenerationOptions = {}): { plan: MigrationPlan; generation: PostgresGeneration } {
  const plan = planMigration(before, diffSchemas(before, after));
  return { plan, generation: generatePostgresMigration(deepFreeze(structuredClone(before)), deepFreeze(structuredClone(plan)), options) };
}

const NOTHING: DatabaseSchema = { tables: [], types: { enums: [] } };

/**
 * The same round trip for two schemas that are given as they are, not as
 * migrations: the migration that makes the first from nothing is generated
 * and collected, which has to give the first; then the migration from the
 * first to the second is collected after it, which has to give the second.
 * A migration that is refused is given back as that.
 */
export async function arrives(before: DatabaseSchema, after: DatabaseSchema, options: PostgresGenerationOptions = {}, form: FormOptions = {}): Promise<{ plan: MigrationPlan; generation: PostgresGeneration; sql: string[] }> {
  const made = generate(NOTHING, before, { assumeValidData: true }).generation;
  assert.ok(made.status === "generated", `The schema to start from cannot be made by a generated migration: ${JSON.stringify(made.status === "refused" ? made.refusals : [], null, 2)}`);
  const creation = renderPostgresMigration(made.migration);
  assertSameSchema(await collected({ "0001_before.sql": creation }), before, form, `The migration that makes the schema to start from does not arrive at it:\n${creation}`);
  const { plan, generation } = generate(before, after, options);
  if (generation.status === "refused") {
    return { plan, generation, sql: [] };
  }
  await assertParses(generation.migration);
  const script = renderPostgresMigration(generation.migration);
  assertSameSchema(await collected({ "0001_before.sql": creation, "0002_generated.sql": script }), after, form, `The generated migration does not arrive at the schema it is for:\n${script}`);
  return { plan, generation, sql: statementsOf(generation.migration).map((statement) => statement.sql) };
}

export interface RoundTrip {
  before: DatabaseSchema;
  after: DatabaseSchema;
  plan: MigrationPlan;
  generation: PostgresGeneration;
  /** The migration; a round trip that was refused has none, and asking for it fails. */
  migration: PostgresMigration;
  /** Its statements as SQL, in their order. */
  sql: string[];
  /** Its segments: how each is run, and how many statements it has. */
  segments: string[];
  statements: PostgresStatement[];
  script: string;
}

/**
 * Generates the migration from the schema of `base` to the schema of `base`
 * and `change`. When one is generated: checks it with the parser, collects it
 * after `base`, and fails unless that gives the schema of `base` and `change`.
 */
export async function roundTrip(base: string, change: string, options: PostgresGenerationOptions = {}, form: FormOptions = {}): Promise<RoundTrip> {
  const before = await collected({ "0001_base.sql": base });
  const after = await collected({ "0001_base.sql": base, "0002_change.sql": change });
  const { plan, generation } = generate(before, after, options);
  const refused = (): never => assert.fail(`No migration was generated: ${JSON.stringify(generation.status === "refused" ? generation.refusals : [], null, 2)}`);
  if (generation.status === "refused") {
    return { before, after, plan, generation, get migration() { return refused(); }, get sql() { return refused(); }, get segments() { return refused(); }, get statements() { return refused(); }, get script() { return refused(); } };
  }
  const { migration } = generation;
  await assertParses(migration);
  const script = renderPostgresMigration(migration);
  const arrived = await collected({ "0001_base.sql": base, "0002_generated.sql": script });
  assertSameSchema(arrived, after, form, `The generated migration does not arrive at the schema it is for:\n${script}`);
  // The same plan gives the same migration, to the byte, however the schema lists its objects.
  const text = stringifyPostgresMigration(migration);
  const again = generatePostgresMigration(listedDifferently(before, 7), plan, options);
  assert.equal(again.status === "generated" ? stringifyPostgresMigration(again.migration) : "refused", text, "the migration of the same schema, listed in another order");
  const statements = statementsOf(migration);
  return { before, after, plan, generation, migration, sql: statements.map((statement) => statement.sql), segments: migration.segments.map((segment) => `${segment.mode}: ${segment.statements.length}`), statements, script };
}
