import { parseArgs } from "node:util";
import { migrateDatabase } from "../../storage-json/src/index.ts";
import type { MigrationReport } from "../../storage-json/src/index.ts";
import type { CliIo } from "./cli.ts";
import { STORAGE_NAMES, parseMaxFileSize } from "./inspect-command.ts";

export const MIGRATE_USAGE = `Usage: local-db-sandbox migrate <database> [options]

Brings a database to the format this build writes. A database that has it
already is left alone.

  local-db-sandbox inspect sandbox.db            what format it has, and whether it has to be migrated
  local-db-sandbox migrate sandbox.db --dry-run  what a migration would change; changes nothing
  local-db-sandbox migrate sandbox.db            migrate it

Options:
      --to <version>       Migrate to this format (default: the current one)
      --dry-run            Report what would be done, and change nothing
      --json               Print the result as JSON
      --max-file-size <MB> Largest database to accept (default: 150; at most 250)
  -h, --help               Show this help

A migration is published in one step. Until then the database is in its old
format, complete; from then on it is in the new one, complete. One that fails
or is interrupted leaves the old format. No copy is made, and a database is
not taken back to an earlier format: to keep one for an older version of this
package, copy it before migrating. Stop a sandbox that uses the database
first, and start it again afterwards.
`;

const count = (items: number, noun: string): string => `${items.toLocaleString("en-US")} ${noun}${items === 1 ? "" : "s"}`;

/** The lines `migrate` prints. The report stays the source of truth; `--json` prints it. */
export function formatMigration(report: MigrationReport): string[] {
  const lines = [`Database: ${report.path}`, `Storage: ${STORAGE_NAMES[report.storage]}`, `Format version: ${report.formatVersion}`, `Target version: ${report.targetVersion}`];
  if (report.steps.length === 0) {
    return [...lines, `Nothing to migrate: ${report.path} has format ${report.targetVersion} already.`];
  }
  lines.push(`Migration path: ${report.migrationPath.join(" -> ")}`);
  for (const step of report.steps) {
    lines.push(`Step ${step.from} -> ${step.to}: ${step.summary}`, ...step.changes.map((change) => `  ${change}`));
  }
  if (report.dryRun) {
    lines.push("Dry run: nothing was changed.");
  } else {
    lines.push(
      `Migrated ${report.path} from format ${report.formatVersion} to format ${report.targetVersion}. ` +
        `${count(report.tables ?? 0, "table")} (${count(report.rows ?? 0, "row")}), the table definitions, and the configuration were read back from the result before it was published, and are the same as before.`,
    );
  }
  return lines;
}

/** Runs `migrate` and resolves with the process exit code. */
export async function runMigrate(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox migrate --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        to: { type: "string" },
        "dry-run": { type: "boolean" },
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
    io.stdout.write(MIGRATE_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    return fail(positionals.length === 0 ? "Missing the database to migrate." : "Expected exactly one database to migrate.");
  }
  let to: number | undefined;
  if (values.to !== undefined) {
    if (!/^[1-9]\d*$/.test(values.to)) {
      return fail("--to must be a format version: a whole number, 1 or more.");
    }
    to = Number(values.to);
  }
  const { maxFileSizeMb, problem } = parseMaxFileSize(values["max-file-size"]);
  if (problem !== undefined) {
    return fail(problem);
  }

  let report: MigrationReport;
  try {
    report = migrateDatabase(positionals[0] as string, { to, dryRun: values["dry-run"], maxFileSizeMb });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (values.json) {
    const { path, ...rest } = report;
    io.stdout.write(`${JSON.stringify({ database: path, ...rest }, null, 2)}\n`);
  } else {
    io.stdout.write(`${formatMigration(report).join("\n")}\n`);
  }
  return 0;
}
