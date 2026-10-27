import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PORT, formatOperationEvent, formatRequestEvent } from "../../server/src/index.ts";
import type { RequestEvent } from "../../server/src/index.ts";
import { formatSizeWarning, maxFileSizeMbProblem } from "../../storage-json/src/index.ts";
import { isPort } from "./config.ts";
import { runConvert } from "./convert-command.ts";
import { runDiffSchema } from "./diff-schema-command.ts";
import { runGenerateMigration } from "./generate-migration-command.ts";
import { runPlanMigration } from "./plan-migration-command.ts";
import { runImportTypeorm } from "./import-command.ts";
import { runInit } from "./init-command.ts";
import { runInitNest } from "./init-nest-command.ts";
import { runInitPg } from "./init-pg-command.ts";
import { runInspect } from "./inspect-command.ts";
import { runMail } from "./mail-command.ts";
import { runMigrate } from "./migrate-command.ts";
import { runPostgrest } from "./postgrest-command.ts";
import { runSimulate } from "./simulate-command.ts";
import { runSql } from "./sql-command.ts";
import { runStudio } from "./studio-command.ts";
import { startSandbox } from "./sandbox.ts";

const NAME = "local-db-sandbox";

const USAGE = `Usage: ${NAME} <database> [options]
       ${NAME} import-typeorm <path> [options]
       ${NAME} init [project-or-migrations] [options]
       ${NAME} init-nest [entry] [options]
       ${NAME} init-pg <connection-url> [options]
       ${NAME} sql <database> ["<SQL>"] [options]
       ${NAME} convert <database> --out <path> [options]
       ${NAME} inspect <database> [options]
       ${NAME} migrate <database> [options]
       ${NAME} mail list | show <id> | clear [options]
       ${NAME} postgrest <database> [options]
       ${NAME} diff-schema <before> <after> [options]
       ${NAME} plan-migration <before> <after> [options]
       ${NAME} generate-migration <before> <after> --dialect postgres [options]
       ${NAME} simulate <database> <script.sql> [options]
       ${NAME} studio [database] [options]

Serves a JSON database as a local REST API. <database> is a single file
(sandbox.db.json) or a database directory (sandbox.db).
"import-typeorm" creates a database file from TypeORM entities; see "${NAME} import-typeorm --help".
"init" creates a database from a project's PostgreSQL migrations; see "${NAME} init --help".
"init-nest" sets up a sandbox server for a NestJS + TypeORM project; see "${NAME} init-nest --help".
"init-pg" creates a database from the schema of a running PostgreSQL database, reading its catalog only; see "${NAME} init-pg --help".
"sql" opens a SQL console on a database; see "${NAME} sql --help".
"convert" copies a database into the other kind of storage; see "${NAME} convert --help".
"inspect" says what format a database has, without changing it; see "${NAME} inspect --help".
"migrate" brings a database of an earlier format to the current one; see "${NAME} migrate --help".
"mail" shows the mail a running sandbox captured; see "${NAME} mail --help".
"postgrest" serves a database to supabase-js clients (a PostgREST subset); see "${NAME} postgrest --help".
"diff-schema" says what differs between two schemas, without changing either; see "${NAME} diff-schema --help".
"plan-migration" says in which steps those differences would be carried out, without carrying them out; see "${NAME} plan-migration --help".
"generate-migration" writes those steps as SQL for PostgreSQL, without carrying them out; see "${NAME} generate-migration --help".
"simulate" runs a SQL script on a copy of a database, and leaves the database as it was; see "${NAME} simulate --help".
"studio" opens Local DB Studio, a page that shows and changes what is in a database; see "${NAME} studio --help".

Options:
  -p, --port <number>  Port to listen on (default: $config.server.port or ${DEFAULT_PORT}; 0 = any free port)
  -H, --host <name>    Host to bind (default: $config.server.host or 127.0.0.1)
      --max-file-size <MB>  Largest database to accept (default: 150; at most 250)
  -v, --verbose        Also log each local operation and CORS preflight requests
  -q, --quiet          Do not log requests
  -h, --help           Show this help
      --version        Show the version
`;

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** A readable stream the SQL console reads its input from; `process.stdin` when omitted. */
  stdin?: { on(event: string, listener: (...args: any[]) => void): unknown };
  /** Source of shutdown signals; `process` in the real CLI. */
  signals: {
    once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  };
}

function packageVersion(): string {
  // The package root is a different number of levels up in source and in the build output.
  let dir = import.meta.dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (manifest.name === NAME) {
        return String(manifest.version);
      }
    } catch {
      // No package.json at this level; keep walking up.
    }
    dir = dirname(dir);
  }
  return "unknown";
}

function describeError(error: unknown, port: number | undefined): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") {
    return `Port ${port ?? "from $config"} is already in use. Choose another with --port.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Lines for one request event. Formatting itself lives with the events. */
function requestLines(event: RequestEvent, verbose: boolean): string[] {
  if (!verbose) {
    return event.method === "OPTIONS" ? [] : [formatRequestEvent(event)];
  }
  return [formatRequestEvent(event), ...event.operations.map((operation) => `    ${formatOperationEvent(operation)}`)];
}

/**
 * Runs the CLI and resolves with the process exit code. When a server is
 * started, this resolves only after a shutdown signal and a clean stop.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "${NAME} --help" for usage.\n`);
    return 1;
  };

  if (argv[0] === "import-typeorm") {
    return runImportTypeorm(argv.slice(1), io);
  }
  if (argv[0] === "init-nest") {
    return runInitNest(argv.slice(1), io);
  }
  if (argv[0] === "init-pg") {
    return runInitPg(argv.slice(1), io);
  }
  if (argv[0] === "sql") {
    return runSql(argv.slice(1), io);
  }
  if (argv[0] === "convert") {
    return runConvert(argv.slice(1), io);
  }
  if (argv[0] === "inspect") {
    return runInspect(argv.slice(1), io);
  }
  if (argv[0] === "migrate") {
    return runMigrate(argv.slice(1), io);
  }
  if (argv[0] === "mail") {
    return runMail(argv.slice(1), io);
  }
  if (argv[0] === "postgrest") {
    return runPostgrest(argv.slice(1), io);
  }
  if (argv[0] === "init") {
    return runInit(argv.slice(1), io);
  }
  if (argv[0] === "diff-schema") {
    return runDiffSchema(argv.slice(1), io);
  }
  if (argv[0] === "plan-migration") {
    return runPlanMigration(argv.slice(1), io);
  }
  if (argv[0] === "generate-migration") {
    return runGenerateMigration(argv.slice(1), io);
  }
  if (argv[0] === "simulate") {
    return runSimulate(argv.slice(1), io);
  }
  if (argv[0] === "studio") {
    return runStudio(argv.slice(1), io);
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: "string", short: "p" },
        host: { type: "string", short: "H" },
        "max-file-size": { type: "string" },
        verbose: { type: "boolean", short: "v" },
        quiet: { type: "boolean", short: "q" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (error) {
    return fail(describeError(error, undefined));
  }
  const { values, positionals } = parsed;

  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    io.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (positionals.length !== 1) {
    return fail(positionals.length === 0 ? "Missing the JSON database: a file or a database directory." : "Expected exactly one JSON database.");
  }
  const file = positionals[0] as string;

  let port: number | undefined;
  if (values.port !== undefined) {
    port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN;
    if (!isPort(port)) {
      return fail("--port must be an integer from 0 to 65535.");
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
  if (values.host === "") {
    return fail("--host must not be empty.");
  }

  let sandbox;
  try {
    sandbox = await startSandbox({
      file,
      host: values.host,
      port,
      maxFileSizeMb,
      onSizeWarning: (warning) => io.stderr.write(`${formatSizeWarning(warning)}
`),
      onRequest: values.quiet
        ? undefined
        : (event) => {
            for (const line of requestLines(event, values.verbose === true)) {
              io.stdout.write(`${line}\n`);
            }
          },
    });
  } catch (error) {
    return fail(describeError(error, port));
  }

  if (sandbox.formatNotice !== undefined) {
    io.stderr.write(`Note: ${sandbox.formatNotice}\n`);
  }
  const collections = sandbox.database.listCollections();
  io.stdout.write(
    `Local DB Sandbox running at ${sandbox.url}\n` +
      `  ${sandbox.format === "directory" ? "directory:  " : "file:       "} ${file}\n` +
      `  collections: ${collections.length > 0 ? collections.join(", ") : "(none)"}\n` +
      (sandbox.saves ? "" : '  changes are not saved ("persistence": "memory" in manifest.json)\n') +
      "  Press Ctrl+C to stop.\n",
  );

  await new Promise<void>((resolve) => {
    const onSignal = (): void => {
      io.signals.off("SIGINT", onSignal);
      io.signals.off("SIGTERM", onSignal);
      resolve();
    };
    io.signals.once("SIGINT", onSignal);
    io.signals.once("SIGTERM", onSignal);
  });

  await sandbox.stop();
  io.stdout.write("Stopped.\n");
  return 0;
}
