import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkSqlStatements } from "../../import-postgres/src/sql-check.ts";
import { DiffApplicationError, MigrationPlanError, planMigration } from "../../migration/src/index.ts";
import type { MigrationStep } from "../../migration/src/index.ts";
import { generatePostgresMigration, renderPostgresMigration, stringifyPostgresGeneration } from "../../migration/src/postgres/index.ts";
import type { PostgresMigration } from "../../migration/src/postgres/index.ts";
import { diffSchemas } from "../../schema-diff/src/index.ts";
import type { SchemaChange } from "../../schema-diff/src/index.ts";
import type { CliIo } from "./cli.ts";
import { readBeforeAndAfter } from "./diff-schema-command.ts";
import { parseMaxFileSize } from "./inspect-command.ts";
import { formatStep } from "./plan-migration-command.ts";
import { unsaidChanges, unsaidSentence } from "./unsaid-changes.ts";

export const GENERATE_MIGRATION_USAGE = `Usage: local-db-sandbox generate-migration <before> <after> --dialect postgres [options]

Writes the migration that makes <before> into <after>, as SQL for PostgreSQL:
the steps that "plan-migration" shows, each as the statements PostgreSQL
carries it out with. Nothing is carried out: no database is connected to, and
neither side is changed. The migration is printed, or written to a file you
name. Read it before you run it.

<before> and <after> are read as "diff-schema" reads them: a database
directory, a single-file database, a schema file, PostgreSQL migrations, or
TypeORM entities (a NestJS project, a folder of entity files, or one entity
file).

Entities say less than a database: no indexes, no unique or check
constraints, and not every default, table, column, and key of them is read.
A step that is there only because a side of entities lacks such a thing may
be a difference, or only what was not read. No migration is written while
the plan has one: compare a project with the database "init-nest" made of
it, or two sets of entities.

Every step of the plan is one of four, and a migration is written only when
no step is refused:
  safe                   Written as it is. It leaves every row as it is, and either
                         cannot fail because of the rows, or is a key, constraint,
                         or index, which PostgreSQL checks against the rows.
  requiresDataMigration  Whether it can be carried out depends on the rows: a
                         column that becomes NOT NULL, a type made narrower, a
                         value taken out of an enumerated type. Refused, unless
                         --assume-valid-data says that the rows fit.
  requiresExplicitCast   A column's type changes, and PostgreSQL has no conversion
                         of its values that is known to keep every one of them.
                         How they are converted (USING) is yours to say. Refused.
  unsupported            What the schema does not say, or PostgreSQL cannot have.
                         Refused.

The script has BEGIN and COMMIT around what is one transaction. A value added
to an enumerated type stands outside them: PostgreSQL does not let it be used
before it is committed. Such a migration is not one transaction, and says so.
Run a script with a client that sends each statement on its own (psql -f).

Options:
      --dialect <name>     The database to write the migration for: postgres (required)
      --assume-valid-data  Also write the statements that rest on what the rows are,
                           on your word that the rows fit. Each is marked; PostgreSQL
                           still refuses one as a whole when they do not
      --json               Print what was generated as JSON, and nothing else: every
                           step with its class, and the statements in their segments;
                           the same bytes for the same two schemas
      --out <file>         Write the migration to this file instead of printing it.
                           A file that exists is never replaced
      --max-file-size <MB> Largest database or schema file to read (default: 150; at most 250)
  -h, --help               Show this help

The SQL is given to PostgreSQL's own parser before it is printed.

Exits with 0 when a migration was generated, and with 1 when one of the two
could not be read, their differences cannot be planned, or a step is refused.
`;

/** The names a generator is asked for by, each with the dialect it writes. */
const DIALECTS: Record<string, "postgresql"> = { postgres: "postgresql", postgresql: "postgresql" };

/** A migration in a few words: `3 statements in one transaction`. */
function summary(migration: PostgresMigration): string {
  const count = migration.segments.reduce((total, segment) => total + segment.statements.length, 0);
  if (count === 0) {
    return "no statements";
  }
  const [only] = migration.segments;
  const where = migration.segments.length > 1 ? `${migration.segments.length} segments` : only?.mode === "transaction" ? "one transaction" : "one segment, outside a transaction";
  return `${count} statement${count === 1 ? "" : "s"} in ${where}`;
}

/** Runs `generate-migration` and resolves with the process exit code. */
export async function runGenerateMigration(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox generate-migration --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dialect: { type: "string" },
        "assume-valid-data": { type: "boolean" },
        json: { type: "boolean" },
        out: { type: "string" },
        "max-file-size": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(GENERATE_MIGRATION_USAGE);
    return 0;
  }
  if (positionals.length !== 2) {
    return fail(
      positionals.length === 0
        ? "Missing the two schemas to generate a migration between: <before> and <after>."
        : positionals.length === 1
          ? "Missing the schema to arrive at: <after>."
          : "Expected exactly two schemas: <before> and <after>.",
    );
  }
  if (values.dialect === undefined) {
    return fail("Missing --dialect: the database to write the migration for. There is one: postgres.");
  }
  if (DIALECTS[values.dialect.toLowerCase()] === undefined) {
    return fail(`There is no generator for "${values.dialect}". There is one: postgres.`);
  }
  const { maxFileSizeMb, problem } = parseMaxFileSize(values["max-file-size"]);
  if (problem !== undefined) {
    return fail(problem);
  }
  // Before anything is read: a file that is there is never written over.
  if (values.out !== undefined && existsSync(values.out)) {
    return fail(`${values.out} exists already. A generated migration never replaces a file: give another name, or remove it.`);
  }

  const [beforePath, afterPath] = positionals as [string, string];
  const read = await readBeforeAndAfter(beforePath, afterPath, maxFileSizeMb, io);
  if ("problem" in read) {
    return fail(read.problem);
  }
  const { before, after } = read;

  let generation;
  try {
    const plan = planMigration(before.schema, diffSchemas(before.schema, after.schema));
    // What a side of entities does not say is not written as SQL: a step that is there only because the entities lack
    // an index, a constraint, or what was not read of them could drop what the application still has.
    const unsaid = (["before", "after"] as const)
      .map((side) => ({ side, steps: unsaidChanges(plan.steps as readonly unknown[] as readonly SchemaChange[], read[side].entities, side) }))
      .filter((entry) => entry.steps.length > 0);
    if (unsaid.length > 0) {
      const lines = unsaid.flatMap(({ side, steps }, index) => [
        `${index === 0 ? "Error: No migration was generated: " : ""}${unsaidSentence(steps.length, "step", side, plan.steps.length)}`,
        ...steps.map((position) => `  step ${position + 1}: ${formatStep(plan.steps[position] as MigrationStep)}`),
      ]);
      lines.push(
        '"diff-schema" and "plan-migration" show every difference. For SQL, compare two sides that say the same things: a project and the database that "init-nest" made of it, or two sets of entities.',
        'Run "local-db-sandbox generate-migration --help" for usage.',
      );
      io.stderr.write(`${lines.join("\n")}\n`);
      return 1;
    }
    generation = generatePostgresMigration(before.schema, plan, { assumeValidData: values["assume-valid-data"] === true });
  } catch (error) {
    if (error instanceof MigrationPlanError || error instanceof DiffApplicationError) {
      return fail(`The differences cannot be planned: ${error.message}`);
    }
    throw error;
  }

  if (generation.status === "refused") {
    if (values.json) {
      io.stdout.write(`${stringifyPostgresGeneration(generation)}\n`);
      return 1;
    }
    const { refusals, steps } = generation;
    const lines = [
      `Error: No migration was generated: ${refusals.length} of ${steps.length} step${steps.length === 1 ? "" : "s"} cannot be written as SQL without knowing more.`,
      ...refusals.flatMap((refusal) => [`  step ${refusal.step}, ${refusal.operation}: ${refusal.safety} (${refusal.reason})`, `    ${refusal.detail}`]),
      ...(refusals.every((refusal) => refusal.safety === "requiresDataMigration") ? ["What is refused rests on what the rows are: with --assume-valid-data it is written, on your word that the rows fit."] : []),
      'Run "local-db-sandbox generate-migration --help" for what the classes mean.',
    ];
    io.stderr.write(`${lines.join("\n")}\n`);
    return 1;
  }

  // What was generated is given to PostgreSQL's own parser before it is given to anyone: every statement is one statement, every expression that was copied from a schema one expression.
  const { migration } = generation;
  const statements = migration.segments.flatMap((segment) => segment.statements);
  const checks = await checkSqlStatements(statements.map((statement) => ({ sql: statement.sql, ...(statement.expressions !== undefined && { expressions: statement.expressions }) })));
  const wrong = checks.findIndex((check) => check.problem !== undefined);
  if (wrong >= 0) {
    io.stderr.write(
      `${[
        `Error: The migration was not printed: PostgreSQL's own parser does not take statement ${wrong + 1} of it as it was meant.`,
        ...(statements[wrong]?.sql ?? "").split("\n").map((line) => `  ${line}`),
        `  ${checks[wrong]?.problem}`,
        "An expression of a schema (a check, a default, the condition of an index) is written into a statement as its source wrote it. One that is not one expression is not written.",
      ].join("\n")}\n`,
    );
    return 1;
  }

  const text = values.json ? `${stringifyPostgresGeneration(generation)}\n` : renderPostgresMigration(migration);
  if (values.out === undefined) {
    io.stdout.write(text);
    return 0;
  }
  try {
    // `wx`: fails when the file has come to be there since it was looked for.
    writeFileSync(values.out, text, { flag: "wx" });
  } catch (error) {
    return fail(`${values.out} could not be written: ${error instanceof Error ? error.message : String(error)}`);
  }
  io.stdout.write(`Wrote ${values.out}: ${summary(migration)}.\n`);
  return 0;
}
