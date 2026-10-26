import { parseArgs } from "node:util";
import { DiffApplicationError, MigrationPlanError, planMigration, stringifyMigrationPlan } from "../../migration/src/index.ts";
import type { MigrationStep } from "../../migration/src/index.ts";
import { diffSchemas, formatSchemaChange } from "../../schema-diff/src/index.ts";
import type { RenameEvidence, SchemaChange } from "../../schema-diff/src/index.ts";
import type { CliIo } from "./cli.ts";
import { noteUnsaid, readBeforeAndAfter } from "./diff-schema-command.ts";
import { parseMaxFileSize } from "./inspect-command.ts";

export const PLAN_MIGRATION_USAGE = `Usage: local-db-sandbox plan-migration <before> <after> [options]

Says in which steps the differences between two schemas would be carried out.
The steps are the changes that "diff-schema" finds, in an order in which each
can be taken when its turn comes, with the steps that such an order needs.
Nothing is carried out, and no SQL is generated: this shows what the planner
makes of a diff.

<before> and <after> are read as "diff-schema" reads them: a database
directory, a single-file database, a schema file, PostgreSQL migrations, or
TypeORM entities (a NestJS project, a folder of entity files, or one entity
file). A step that may only be what entities do not say is noted.

A step the planner added, which the diff does not have, says why:
  rename-cycle             Names are exchanged or passed round, so one object
                           is first renamed to a temporary name.
  tables-dropped-together  Tables that are dropped refer to each other, so a
                           foreign key between them is dropped first.

Options:
      --json               Print the plan as JSON, and nothing else: the same bytes
                           for the same two schemas
      --max-file-size <MB> Largest database or schema file to read (default: 150; at most 250)
  -h, --help               Show this help

Exits with 0 when a plan was made, and with 1 when one of the two could not
be read or their differences cannot be planned.
`;

/** A rename that the planner added has no evidence; the diff's formatter reads one. */
const NO_EVIDENCE: RenameEvidence = { origin: { source: "", file: "", sha256: "", statement: 0, line: 0, name: "" }, renames: [] };

/** One line for a step: the change as \`diff-schema\` writes it, and why the planner added it if it did. */
export function formatStep(step: MigrationStep): string {
  const { planned, temporaryName: _temporaryName, ...operation } = step;
  const change = ("evidence" in operation || !operation.op.startsWith("rename") ? operation : { ...operation, evidence: NO_EVIDENCE }) as SchemaChange;
  return `${formatSchemaChange(change)}${planned === undefined ? "" : ` [planner: ${planned}]`}`;
}

/** Runs `plan-migration` and resolves with the process exit code. */
export async function runPlanMigration(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox plan-migration --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        "max-file-size": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(PLAN_MIGRATION_USAGE);
    return 0;
  }
  if (positionals.length !== 2) {
    return fail(
      positionals.length === 0 ? "Missing the two schemas to plan between: <before> and <after>." : positionals.length === 1 ? "Missing the schema to plan toward: <after>." : "Expected exactly two schemas: <before> and <after>.",
    );
  }
  const { maxFileSizeMb, problem } = parseMaxFileSize(values["max-file-size"]);
  if (problem !== undefined) {
    return fail(problem);
  }

  const [beforePath, afterPath] = positionals as [string, string];
  const read = await readBeforeAndAfter(beforePath, afterPath, maxFileSizeMb, io);
  if ("problem" in read) {
    return fail(read.problem);
  }
  const { before, after } = read;

  let plan;
  try {
    plan = planMigration(before.schema, diffSchemas(before.schema, after.schema));
  } catch (error) {
    if (error instanceof MigrationPlanError || error instanceof DiffApplicationError) {
      return fail(`The differences cannot be planned: ${error.message}`);
    }
    throw error;
  }
  // A step is a change of the diff, or one the planner made of them: what it is of is read from it as from a change.
  noteUnsaid(plan.steps as readonly unknown[] as readonly SchemaChange[], read, "step", io);

  if (values.json) {
    io.stdout.write(`${stringifyMigrationPlan(plan)}\n`);
    return 0;
  }
  const width = String(plan.steps.length).length;
  const lines =
    plan.steps.length === 0
      ? ["No steps: the two schemas do not differ."]
      : [`${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}:`, ...plan.steps.map((step, index) => `  ${String(index + 1).padStart(width)}. ${formatStep(step)}`)];
  io.stdout.write(`${[`Before: ${beforePath} (${before.description})`, `After:  ${afterPath} (${after.description})`, ...lines].join("\n")}\n`);
  return 0;
}
