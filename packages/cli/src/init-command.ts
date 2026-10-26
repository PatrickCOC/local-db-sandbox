import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MigrationError, MigrationSourceError, MigrationSyntaxError, collectPostgresMigrations, findMigrationsDirectory, summarizeReport } from "../../import-postgres/src/index.ts";
import type { CollectedSchema, ReportCategory, ReportEntry } from "../../import-postgres/src/index.ts";
import { DatabaseOwnedError, claimDatabaseIfThere, maxFileSizeMbProblem } from "../../storage-json/src/index.ts";
import type { DatabaseClaim } from "../../storage-json/src/index.ts";
import { bootstrapDatabase } from "./bootstrap.ts";
import type { CliIo } from "./cli.ts";

export const INIT_USAGE = `Usage: local-db-sandbox init <project-or-migrations> [options]

Creates a sandbox database from a project's PostgreSQL migrations, without a
running database. <project-or-migrations> is a directory of .sql migrations,
or a project that keeps them in supabase/migrations, migrations,
db/migrations, database/migrations, or sql/migrations.

The migrations are read with PostgreSQL's own parser and applied in order to
work out the tables they leave: columns, keys, foreign keys, unique
constraints, indexes, defaults, and enumerated types. Rows the migrations
insert are loaded. What the sandbox does not reproduce (row level security,
roles and grants, extensions, functions, triggers, scheduled jobs, views) is
listed, and the full report is written next to the database.

Options:
  -o, --out <directory>  Database directory to create (default: .local-db-sandbox/sandbox.db
                         in the project)
      --report <file>    Where to write the report (default: <database>.report.json)
      --force            Replace the database if it exists; its rows are lost. Refused while a
                         process has the database open: stop that process first.
      --strict           Fail, writing nothing, if a statement is unsupported
      --max-file-size <MB> Largest database to accept
  -h, --help             Show this help

Then serve it, for example to supabase-js clients:
  local-db-sandbox postgrest <database>
`;

const CATEGORY_NAMES: Partial<Record<ReportCategory, string>> = {
  "row-level-security": "row level security and policies",
  permissions: "roles, grants, and ownership",
  extensions: "extensions",
  functions: "functions and code blocks",
  triggers: "triggers",
  scheduling: "scheduled jobs",
  replication: "replication and publications",
  "other-schemas": "objects of other schemas",
  "temporary-tables": "temporary tables",
  views: "views",
  sequences: "sequences",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The lines `init` prints about a collected schema. */
export function describeCollection(collected: CollectedSchema, database: string, rows: Record<string, number>, reportPath: string): string[] {
  const { outcomes, notReproduced } = summarizeReport(collected.report);
  const lines = [
    `Read ${plural(collected.migrations.length, "migration")} (${plural(collected.migrations.reduce((sum, migration) => sum + migration.statements, 0), "statement")}) from ${collected.directory}`,
    `Created ${database}`,
    ...collected.tables.map((table) => {
      const extras = [
        table.uniques?.length ? plural(table.uniques.length, "unique constraint") : undefined,
        table.indexes?.length ? plural(table.indexes.length, "index").replace("indexs", "indexes") : undefined,
      ].filter((part) => part !== undefined);
      return `  ${table.name}: ${plural(table.columns.length, "column")}${extras.length > 0 ? `, ${extras.join(", ")}` : ""}, ${plural(rows[table.name] ?? 0, "row")}`;
    }),
    ...(collected.types.enums.length > 0 ? [`  enumerated types: ${collected.types.enums.map((type) => type.name).join(", ")}`] : []),
    `Statements: ${outcomes.applied} applied, ${outcomes.seeded} inserting rows, ${outcomes.retained} kept as information, ${outcomes["not-reproduced"]} not reproduced, ${outcomes["no-effect"]} without effect, ${outcomes.unsupported} unsupported`,
  ];
  const categories = Object.entries(notReproduced) as [ReportCategory, number][];
  if (categories.length > 0) {
    lines.push("Not reproduced locally, on purpose:");
    for (const [category, count] of categories) {
      lines.push(`  ${CATEGORY_NAMES[category] ?? category}: ${plural(count, "statement")}`);
    }
  }
  const listed = (title: string, entries: ReportEntry[]): void => {
    if (entries.length > 0) {
      lines.push(title);
      lines.push(...entries.map((entry) => `  ${entry.file}:${entry.line}: ${entry.message}`));
    }
  };
  listed("Kept as information, not enforced:", collected.report.filter((entry) => entry.outcome === "retained"));
  listed("Unsupported (the local schema may differ from PostgreSQL's here):", collected.report.filter((entry) => entry.outcome === "unsupported"));
  lines.push(`Report: ${reportPath}`);
  return lines;
}

/** The report as it is written to a file. */
export function reportDocument(collected: CollectedSchema, database: string, rows: Record<string, number>): unknown {
  return {
    reportVersion: 1,
    source: { kind: "postgresql-migrations", directory: collected.directory, migrations: collected.migrations },
    database,
    summary: { ...summarizeReport(collected.report), tables: collected.tables.length, rows },
    enums: collected.types.enums,
    provenance: collected.provenance,
    entries: collected.report,
  };
}

/** Runs `init` and resolves with the process exit code. */
export async function runInit(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox init --help" for usage.\n`);
    return 1;
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        report: { type: "string" },
        force: { type: "boolean" },
        strict: { type: "boolean" },
        "max-file-size": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(INIT_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    return fail(positionals.length === 0 ? "Missing the project or migrations directory." : "Expected exactly one project or migrations directory.");
  }
  let maxFileSizeMb: number | undefined;
  if (values["max-file-size"] !== undefined) {
    maxFileSizeMb = /^\d+(\.\d+)?$/.test(values["max-file-size"]) ? Number(values["max-file-size"]) : Number.NaN;
    const problem = maxFileSizeMbProblem(maxFileSizeMb, "--max-file-size");
    if (problem !== undefined) {
      return fail(problem);
    }
  }

  const source = resolve(positionals[0] as string);
  let migrations: string;
  try {
    migrations = findMigrationsDirectory(source);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  // The project is what was given, unless the migrations directory itself was given.
  const project = migrations === source ? process.cwd() : source;
  const database = resolve(values.out ?? join(project, ".local-db-sandbox", "sandbox.db"));
  const reportPath = resolve(values.report ?? join(dirname(database), `${basename(database)}.report.json`));
  if (existsSync(database) && values.force !== true) {
    return fail(`${database} exists. Use --force to replace it; the rows it holds are lost.`);
  }
  if (existsSync(database) && !statSync(database).isDirectory()) {
    return fail(`${database} is a file; init creates a database directory.`);
  }

  // A database that is replaced is this command's while that is done, as it is every writer's (D-042, D-043): one that
  // a process has open is not replaced under it, and no process opens it meanwhile. A record that was left behind is
  // taken over, as by every writer. Where there is nothing to replace, there is nothing to claim.
  let claim: DatabaseClaim | undefined;
  try {
    claim = await claimDatabaseIfThere(database, { kind: "init" });
  } catch (error) {
    if (error instanceof DatabaseOwnedError) {
      return fail(`${error.message} Nothing was replaced: the database is as it was.`);
    }
    throw error;
  }
  try {
    let collected: CollectedSchema;
    try {
      collected = await collectPostgresMigrations(migrations);
    } catch (error) {
      if (error instanceof MigrationSyntaxError) {
        return fail(`${error.file}:${error.line}:${error.column}: PostgreSQL cannot parse this migration: ${error.message.replace(/^.*?: /, "")}. Nothing was written.`);
      }
      if (error instanceof MigrationError || error instanceof MigrationSourceError) {
        return fail(`${error.message} Nothing was written.`);
      }
      throw error;
    }
    const unsupported = collected.report.filter((entry) => entry.outcome === "unsupported");
    if (values.strict === true && unsupported.length > 0) {
      io.stderr.write(unsupported.map((entry) => `  ${entry.file}:${entry.line}: ${entry.message}\n`).join(""));
      return fail(`${plural(unsupported.length, "statement")} of the migrations ${unsupported.length === 1 ? "is" : "are"} unsupported (--strict). Nothing was written.`);
    }
    if (collected.tables.length === 0) {
      return fail(`The migrations in ${migrations} create no tables in the public schema. Nothing was written.`);
    }

    let rows: Record<string, number>;
    try {
      ({ rows } = await bootstrapDatabase({
        database,
        tables: collected.tables,
        types: collected.types,
        rows: collected.seeds,
        ...(values.force === true && { overwrite: true }),
        ...(maxFileSizeMb !== undefined && { maxFileSizeMb }),
      }));
    } catch (error) {
      return fail(`The database could not be created: ${error instanceof Error ? error.message : String(error)}`);
    }
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(reportDocument(collected, database, rows), null, 2)}\n`);

    const shown = relative(process.cwd(), database) || database;
    io.stdout.write(
      `${describeCollection(collected, database, rows, reportPath).join("\n")}\n` +
        `Next: local-db-sandbox postgrest ${/\s/.test(shown) ? JSON.stringify(shown) : shown}\n`,
    );
    return 0;
  } finally {
    claim?.release();
  }
}
