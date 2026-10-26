import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_MAX_ROWS, DEFAULT_POSTGREST_PORT, startPostgrestSandbox } from "../../postgrest/src/index.ts";
import type { PostgrestRequestEvent } from "../../postgrest/src/index.ts";
import { createSqlLogger } from "../../runtime/src/index.ts";
import type { SqlLogMode } from "../../runtime/src/index.ts";
import { serveRuntime } from "../../runtime-access/src/index.ts";
import { databaseFormatFor, formatSizeWarning, maxFileSizeMbProblem } from "../../storage-json/src/index.ts";
import type { CliIo } from "./cli.ts";
import { isPort } from "./config.ts";

export const POSTGREST_USAGE = `Usage: local-db-sandbox postgrest <database> [options]

Serves the tables of a JSON database through a local endpoint that speaks a
subset of PostgREST, the API behind Supabase's database client. An
application that uses supabase-js (or another PostgREST client) is pointed at
it by its Supabase URL alone, for example:

  VITE_SUPABASE_URL=http://127.0.0.1:${DEFAULT_POSTGREST_PORT}   (browser)
  SUPABASE_URL=http://127.0.0.1:${DEFAULT_POSTGREST_PORT}        (server, Deno)

Any key is accepted. <database> must store its table definitions (schema.json
of a database directory). Committed changes are written back to it.

Supported: select=<columns>, the filters eq, gte, lt, range (offset/limit),
.single(), .maybeSingle(), .upsert() on the primary key, .delete() with
filters. Everything else is refused with SANDBOX_POSTGREST_UNSUPPORTED.
Not provided: Row Level Security, Auth, Storage, Realtime, RPC, Edge
Functions. Without RLS every client can read and write every table, so
authorization bugs of the real project do not show here.

Options:
  -p, --port <number>    Port to listen on (default: ${DEFAULT_POSTGREST_PORT}; 0 = any free port)
  -H, --host <name>      Host to bind (default: 127.0.0.1)
      --max-rows <n>     Most rows one read returns, as Supabase's db-max-rows (default: ${DEFAULT_MAX_ROWS}; 0 = no cap)
      --no-save          Discard changes when the endpoint stops
      --sql-log <mode>   Log executed statements: off, summary (default), verbose
  -q, --quiet            Do not log requests
      --max-file-size <MB> Largest database to accept (default: 150; at most 250)
  -h, --help             Show this help
`;

const SQL_LOG_MODES = ["off", "summary", "verbose"];
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/i;

/** One line per request. Header values are never printed: they hold the client's keys. */
export function formatPostgrestRequest(event: PostgrestRequestEvent): string {
  const error = event.errorCode === undefined ? "" : ` ${event.errorCode}`;
  return `[${event.requestId}] ${event.method} ${event.path} -> ${event.status}${error} (sql ${event.sqlCount}, ${event.sqlExecutionMs.toFixed(1)} ms; total ${event.totalMs.toFixed(1)} ms)`;
}

/** Runs `postgrest` and resolves with the process exit code once the endpoint has stopped. */
export async function runPostgrest(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox postgrest --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: "string", short: "p" },
        host: { type: "string", short: "H" },
        "max-rows": { type: "string" },
        "no-save": { type: "boolean" },
        "sql-log": { type: "string" },
        quiet: { type: "boolean", short: "q" },
        "max-file-size": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(POSTGREST_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    return fail(positionals.length === 0 ? "Missing the database." : "Expected exactly one database.");
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN;
    if (!isPort(port)) {
      return fail("--port must be an integer from 0 to 65535.");
    }
  }
  if (values.host === "") {
    return fail("--host must not be empty.");
  }
  let maxRows: number | null | undefined;
  if (values["max-rows"] !== undefined) {
    if (!/^\d+$/.test(values["max-rows"])) {
      return fail("--max-rows must be a non-negative integer.");
    }
    maxRows = Number(values["max-rows"]) === 0 ? null : Number(values["max-rows"]);
  }
  const sqlLog = values["sql-log"] ?? "summary";
  if (!SQL_LOG_MODES.includes(sqlLog)) {
    return fail('--sql-log must be "off", "summary", or "verbose".');
  }
  let maxFileSizeMb: number | undefined;
  if (values["max-file-size"] !== undefined) {
    maxFileSizeMb = /^\d+(\.\d+)?$/.test(values["max-file-size"]) ? Number(values["max-file-size"]) : Number.NaN;
    const problem = maxFileSizeMbProblem(maxFileSizeMb, "--max-file-size");
    if (problem !== undefined) {
      return fail(problem);
    }
  }
  const database = resolve(positionals[0] as string);

  let sandbox;
  let served;
  try {
    sandbox = await startPostgrestSandbox({
      database,
      ...(values.host !== undefined && { host: values.host }),
      ...(port !== undefined && { port }),
      ...(maxRows !== undefined && { maxRows }),
      ...(values["no-save"] && { save: false }),
      maxFileSizeMb,
      onSizeWarning: (warning) => io.stderr.write(`${formatSizeWarning(warning)}\n`),
      ...(sqlLog !== "off" && { onSql: createSqlLogger(sqlLog as SqlLogMode, (line) => io.stdout.write(`${line}\n`)) }),
      ...(!values.quiet && { onRequest: (event: PostgrestRequestEvent) => io.stdout.write(`${formatPostgrestRequest(event)}\n`) }),
    });
    // The endpoint has the database to itself (D-042). Whoever else wants to look into it, Studio for one, asks this
    // process, which serves its runtime to this machine for that.
    served = await serveRuntime({ claim: sandbox.claim, runtime: sandbox.runtime, format: databaseFormatFor(database) });
  } catch (error) {
    await sandbox?.stop();
    const code = (error as { code?: unknown } | null)?.code;
    return fail(code === "EADDRINUSE" ? `Port ${port ?? DEFAULT_POSTGREST_PORT} is already in use. Choose another with --port.` : error instanceof Error ? error.message : String(error));
  }

  if (sandbox.formatNotice !== undefined) {
    io.stderr.write(`Note: ${sandbox.formatNotice}\n`);
  }
  if (!LOOPBACK.test(sandbox.host)) {
    io.stderr.write(`Warning: listening on ${sandbox.host}, not only on this machine. The endpoint has no authentication: anyone who reaches it can read and change every table.\n`);
  }
  io.stdout.write(
    `Local DB Sandbox PostgREST endpoint (subset) at ${sandbox.url}/rest/v1\n` +
      `  database:    ${database}\n` +
      `  tables:      ${sandbox.tables.join(", ")}\n` +
      (sandbox.unservedTables.length > 0 ? `  not served:  ${sandbox.unservedTables.join(", ")} (no stored table definition)\n` : "") +
      (sandbox.saves ? "" : "  changes are not saved\n") +
      `  Supabase URL for clients: ${sandbox.url} (any key is accepted)\n` +
      "  No Row Level Security, Auth, Storage, Realtime, RPC, or Edge Functions: every client can read and write every table.\n" +
      "  Press Ctrl+C to stop.\n",
  );

  await new Promise<void>((resolveStop) => {
    const onSignal = (): void => {
      io.signals.off("SIGINT", onSignal);
      io.signals.off("SIGTERM", onSignal);
      resolveStop();
    };
    io.signals.once("SIGINT", onSignal);
    io.signals.once("SIGTERM", onSignal);
  });
  // No one is sent to a runtime that is about to close; the database is let go of last, by the endpoint.
  await served.close();
  await sandbox.stop();
  io.stdout.write("Stopped.\n");
  return 0;
}
