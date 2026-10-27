import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  MigrationError,
  MigrationSyntaxError,
  PostgresConnectionError,
  PostgresScanError,
  describeTarget,
  parseConnectionUrl,
  scanPostgresDatabase,
  summarizeReport,
} from "../../import-postgres/src/index.ts";
import type { ScanNote, ScannedSchema } from "../../import-postgres/src/index.ts";
import { DatabaseOwnedError, claimDatabaseIfThere, maxFileSizeMbProblem } from "../../storage-json/src/index.ts";
import type { DatabaseClaim } from "../../storage-json/src/index.ts";
import { bootstrapDatabase } from "./bootstrap.ts";
import type { CliIo } from "./cli.ts";
import { describeGitignore, ignoreSandboxFiles } from "./gitignore.ts";
import { nextSteps, shownPath, studioCommand, writeFailureReason } from "./project-paths.ts";

export const INIT_PG_USAGE = `Usage: local-db-sandbox init-pg <connection-url> [options]

Creates a sandbox database from the schema of a running PostgreSQL database,
read from its system catalog. No migrations and no ORM are needed.
<connection-url> is postgresql://<user>@<host>[:<port>]/<database>, with
?sslmode=disable|prefer|require|verify-full if needed (default: prefer).
Give the password in the PGPASSWORD environment variable; one in the URL is
taken too, but the shell may keep it in its history.

The scan only reads the catalog, in a read-only transaction: no row of any
table is read, and nothing is written to PostgreSQL. A role that may connect
is enough; use a read-only role. Tables, columns, types, defaults, primary
keys, foreign keys, unique constraints, check constraints, and indexes are
read; the new database has the tables, and no rows. What the sandbox does
not reproduce (views, partitions, row level security, triggers, extension
tables, types of schemas that are not read) is listed, and the full report
is written next to the database. The sandbox has one namespace: tables are
named without their schema, and two schemas that have an object of the same
name are refused.

Options:
  -s, --schema <name>      Schema to read; repeat for more (default: public)
  -o, --out <directory>    Database directory to create (default:
                           .local-db-sandbox/sandbox.db in this directory)
      --report <file>      Where to write the report (default: <database>.report.json)
      --force              Replace the database if it exists; its rows are lost. Refused while a
                           process has the database open: stop that process first.
      --strict             Fail, writing nothing, if something of the schema is unsupported
      --connect-timeout <seconds>  How long connecting may take (default: ${DEFAULT_CONNECT_TIMEOUT_MS / 1000})
      --query-timeout <seconds>    How long each catalog query may take (default: ${DEFAULT_QUERY_TIMEOUT_MS / 1000})
      --max-file-size <MB> Largest database to accept
      --no-gitignore       Leave .gitignore alone. By default, the paths this writes (the database,
                           its report, and the files a sandbox keeps beside it) are added to the
                           .gitignore of this directory's Git repository, when the database is in it
  -h, --help               Show this help

Example:
  PGPASSWORD=... local-db-sandbox init-pg postgresql://reader@127.0.0.1:5432/app --schema public

Then look into it, or serve it:
  local-db-sandbox studio <database>
`;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A number of seconds, more than 0 and at most an hour, as milliseconds; `undefined` when it is not one. */
function seconds(value: string): number | undefined {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return undefined;
  }
  const number = Number(value);
  return number > 0 && number <= 3600 ? Math.round(number * 1000) : undefined;
}

/** The lines `init-pg` prints about a scan. */
export function describeScan(scanned: ScannedSchema, database: string, rows: Record<string, number>, reportPath: string): string[] {
  const { collected, notes } = scanned;
  const schemas = scanned.schemas.map((name) => `"${name}"`).join(", ");
  const lines = [
    `Read schema${scanned.schemas.length === 1 ? "" : "s"} ${schemas} of PostgreSQL ${scanned.serverVersion} at ${describeTarget(scanned.target)}: ${plural(collected.tables.length, "table")}${collected.types.enums.length > 0 ? `, ${plural(collected.types.enums.length, "enumerated type")}` : ""}`,
    `Created ${database}`,
    ...collected.tables.map((table) => {
      const extras = [
        table.uniques?.length ? plural(table.uniques.length, "unique constraint") : undefined,
        table.indexes?.length ? plural(table.indexes.length, "index").replace("indexs", "indexes") : undefined,
      ].filter((part) => part !== undefined);
      return `  ${table.name}: ${plural(table.columns.length, "column")}${extras.length > 0 ? `, ${extras.join(", ")}` : ""}, ${plural(rows[table.name] ?? 0, "row")}`;
    }),
    ...(collected.types.enums.length > 0 ? [`  enumerated types: ${collected.types.enums.map((type) => type.name).join(", ")}`] : []),
    "No rows were read from PostgreSQL: the tables are empty.",
  ];
  const listed = (title: string, entries: { object?: string; message: string }[]): void => {
    if (entries.length > 0) {
      lines.push(title, ...entries.map((entry) => `  ${entry.object === undefined ? "" : `${entry.object}: `}${entry.message}`));
    }
  };
  const fromNotes = (outcome: ScanNote["outcome"]): ScanNote[] => notes.filter((entry) => entry.outcome === outcome);
  listed("Kept as information, not enforced:", collected.report.filter((entry) => entry.outcome === "retained"));
  listed("Not reproduced locally:", [...fromNotes("not-reproduced"), ...collected.report.filter((entry) => entry.outcome === "not-reproduced")]);
  listed("Unsupported (the local schema may differ from PostgreSQL's here):", [...fromNotes("unsupported"), ...collected.report.filter((entry) => entry.outcome === "unsupported")]);
  lines.push(`Report: ${reportPath}`);
  return lines;
}

/** The report as it is written to a file. It holds where the schema was read from, and never a password. */
export function scanReportDocument(scanned: ScannedSchema, database: string, rows: Record<string, number>): unknown {
  const { host, port, database: name, user } = scanned.target;
  return {
    reportVersion: 1,
    source: { kind: "postgresql-database", server: { host, port, database: name, user, version: scanned.serverVersion }, schemas: scanned.schemas },
    database,
    summary: { ...summarizeReport(scanned.collected.report), tables: scanned.collected.tables.length, rows },
    enums: scanned.collected.types.enums,
    provenance: scanned.collected.provenance,
    notes: scanned.notes,
    entries: scanned.collected.report,
    // What the catalog was read as, and what the lines of the entries are lines of. Definitions only: no rows.
    script: scanned.script,
  };
}

/** Runs `init-pg` and resolves with the process exit code. */
export async function runInitPg(argv: string[], io: CliIo, environment: { PGPASSWORD?: string } = process.env): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox init-pg --help" for usage.\n`);
    return 1;
  };
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        schema: { type: "string", short: "s", multiple: true },
        out: { type: "string", short: "o" },
        report: { type: "string" },
        force: { type: "boolean" },
        strict: { type: "boolean" },
        "connect-timeout": { type: "string" },
        "query-timeout": { type: "string" },
        "max-file-size": { type: "string" },
        "no-gitignore": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    // parseArgs names the argument it could not take; the connection string is a positional and is never one of them.
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(INIT_PG_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    return fail(positionals.length === 0 ? "Missing the connection URL (postgresql://<user>@<host>:<port>/<database>)." : "Expected exactly one connection URL.");
  }
  const url = positionals[0] as string;
  let passwordInUrl: boolean;
  try {
    passwordInUrl = parseConnectionUrl(url).password !== undefined;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const timeouts: { connectTimeoutMs?: number; queryTimeoutMs?: number } = {};
  for (const [option, key] of [
    ["connect-timeout", "connectTimeoutMs"],
    ["query-timeout", "queryTimeoutMs"],
  ] as const) {
    const given = values[option];
    if (given !== undefined) {
      const ms = seconds(given);
      if (ms === undefined) {
        return fail(`--${option} must be a number of seconds, more than 0 and at most 3600.`);
      }
      timeouts[key] = ms;
    }
  }
  let maxFileSizeMb: number | undefined;
  if (values["max-file-size"] !== undefined) {
    maxFileSizeMb = /^\d+(\.\d+)?$/.test(values["max-file-size"]) ? Number(values["max-file-size"]) : Number.NaN;
    const problem = maxFileSizeMbProblem(maxFileSizeMb, "--max-file-size");
    if (problem !== undefined) {
      return fail(problem);
    }
  }

  const database = resolve(values.out ?? join(process.cwd(), ".local-db-sandbox", "sandbox.db"));
  const reportPath = resolve(values.report ?? join(dirname(database), `${basename(database)}.report.json`));
  if (existsSync(database) && values.force !== true) {
    return fail(`${database} exists. Use --force to replace it; the rows it holds are lost.`);
  }
  if (existsSync(database) && !statSync(database).isDirectory()) {
    return fail(`${database} is a file; init-pg creates a database directory.`);
  }
  if (passwordInUrl) {
    io.stderr.write("Note: the password is in the URL. It is not written anywhere by this command, but your shell may keep it in its history; PGPASSWORD keeps it out.\n");
  }

  // As init does (D-042, D-043): a database that is replaced is this command's while that is done.
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
    let scanned: ScannedSchema;
    try {
      scanned = await scanPostgresDatabase({
        connection: { url, ...(environment.PGPASSWORD !== undefined && environment.PGPASSWORD !== "" && { password: environment.PGPASSWORD }), ...timeouts, applicationName: "local-db-sandbox init-pg" },
        ...(values.schema !== undefined && { schemas: values.schema }),
      });
    } catch (error) {
      if (error instanceof PostgresConnectionError || error instanceof PostgresScanError) {
        return fail(`${error.message} Nothing was written.`);
      }
      if (error instanceof MigrationError || error instanceof MigrationSyntaxError) {
        return fail(`The catalog could not be read as a schema: ${error.message}. Nothing was written.`);
      }
      throw error;
    }
    const unsupported = [...scanned.notes.filter((entry) => entry.outcome === "unsupported"), ...scanned.collected.report.filter((entry) => entry.outcome === "unsupported")];
    if (values.strict === true && unsupported.length > 0) {
      io.stderr.write(unsupported.map((entry) => `  ${entry.object ?? ""}: ${entry.message}\n`).join(""));
      return fail(`${plural(unsupported.length, "part")} of the schema ${unsupported.length === 1 ? "is" : "are"} unsupported (--strict). Nothing was written.`);
    }

    let rows: Record<string, number>;
    try {
      ({ rows } = await bootstrapDatabase({
        database,
        tables: scanned.collected.tables,
        types: scanned.collected.types,
        ...(values.force === true && { overwrite: true }),
        ...(maxFileSizeMb !== undefined && { maxFileSizeMb }),
      }));
    } catch (error) {
      const reason = writeFailureReason(error);
      return fail(`The database could not be created at ${shownPath(database)}: ${error instanceof Error ? error.message : String(error)}${reason === undefined ? "" : ` (${reason})`}`);
    }
    try {
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, `${JSON.stringify(scanReportDocument(scanned, database, rows), null, 2)}\n`);
    } catch (error) {
      const reason = writeFailureReason(error);
      io.stderr.write(`Warning: the database was created, and its report could not be written to ${shownPath(reportPath)}: ${reason ?? (error instanceof Error ? error.message : String(error))}.\n`);
    }

    const ignore = values["no-gitignore"] === true ? [] : describeGitignore(await ignoreSandboxFiles(process.cwd(), { database, format: "directory", report: reportPath }), (path) => shownPath(path));
    io.stdout.write(
      `${[
        ...describeScan(scanned, database, rows, reportPath),
        ...ignore,
        ...nextSteps([
          { command: studioCommand(database), why: "look into the tables, and add rows" },
          { command: `local-db-sandbox postgrest ${shownPath(database)}`, why: "serve the database to supabase-js clients" },
        ]),
      ].join("\n")}\n`,
    );
    return 0;
  } finally {
    claim?.release();
  }
}
