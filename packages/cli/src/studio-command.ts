import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { describeOwnerKind, formatSizeWarning, maxFileSizeMbProblem } from "../../storage-json/src/index.ts";
import { DEFAULT_STUDIO_PORT, startStudio } from "../../studio/src/index.ts";
import type { StudioStatus } from "../../studio/src/index.ts";
import type { CliIo } from "./cli.ts";
import { isPort } from "./config.ts";
import { findProjectDatabase, shownPath } from "./project-paths.ts";
import { exportSqlForStudio } from "./sql-export.ts";

export const STUDIO_USAGE = `Usage: local-db-sandbox studio [database] [options]

Opens Local DB Studio on a JSON database: a page in your browser that shows
the tables and their rows, adds, changes, and removes rows, and runs SQL.
[database] is a database directory (sandbox.db) or a single file
(sandbox.db.json). Without it, Studio opens the project's database: the one
.local-db-sandbox/sandbox.config.json names (init-nest), or
.local-db-sandbox/sandbox.db (init, init-pg), found from the current
directory or above, and says which; when the project has both, name one. With
the configuration of init-nest, the API tab starts from the sandbox's address. Everything is carried out by the sandbox's relational
runtime (SQLite in memory); a change is saved as a sandbox saves it.

How the database is opened follows from what it is and from who has it open:

  A directory that no process has open   Studio has it to itself, and may
                                         change it. Changes are saved.
  A database that a sandbox has open     Studio looks into the runtime of that
  ("npm run sandbox", "postgrest")       process, and changes it there: one
                                         runtime, one writer. When the sandbox
                                         restarts, Studio finds it again.
  A single file                          Read-only, always. Convert it into a
                                         directory to change it in Studio.

One process has a database open to write at a time. Studio is never a second
one: a directory that a process has open which serves no runtime (the REST
sandbox, the SQL console) is refused, unless Studio is started to look only.

While Studio has a directory to itself, a sandbox that is started on it is
refused. To use the database with an application: stop Studio (Ctrl+C), start
the sandbox, and start Studio again. It then attaches to the sandbox.

The page is served on this machine only (127.0.0.1), and what it asks is
answered only with the key that is in the address this command prints.

The API tab sends one HTTP request at a time to an API that runs on this
machine (http://127.0.0.1, localhost, or [::1]; no other host), and shows
its status, duration, headers, and body. Studio does not start the API:
start it as you do, against the sandbox's database, and give its address in
the tab, or with --api. Redirects are shown, not followed. Nothing of a
request or its answer is logged or kept.

The Export tab writes the tables you choose as an SQL script for PostgreSQL,
which the page offers as a .sql file: the schema only, the data only, or
both. It reads the database and changes nothing. An export with data holds
the rows as they are, which may be data you entered, and is made only when
you confirm that. What cannot be written as it is refuses the export.

Options:
  -p, --port <number>      Port of the page (default: ${DEFAULT_STUDIO_PORT}; 0 = any free port)
      --read-only          Change nothing: browse, and run statements that read
      --api <url>          Address of a local API the API tab starts from (http://127.0.0.1:<port>/...)
      --max-file-size <MB> Largest database to accept (default: 150; at most 250)
  -h, --help               Show this help
`;

/** The lines that say how the database is open. They are formatted from the session's status, which stays the source of truth. */
export function formatStudioStatus(status: StudioStatus): string[] {
  const info = status.info;
  const mode =
    status.mode === "attached"
      ? `attached to ${info === undefined ? "the process that has the database open" : `${describeOwnerKind(info.kind)} (pid ${info.pid})`}: Studio looks into its runtime, and does not open the database`
      : info?.readOnly === undefined
        ? "standalone: Studio has the database to itself"
        : "standalone: Studio reads the database as it is stored";
  const access = info === undefined ? "not connected" : info.readOnly !== undefined ? `read-only: ${info.readOnly}` : info.persistence === "memory" ? "read/write, kept in memory and not saved" : "read/write";
  return [
    `  database:  ${status.database} (${status.format === "directory" ? "database directory" : "single file"})`,
    `  mode:      ${mode}`,
    `  access:    ${access}`,
    ...(info === undefined ? [] : [`  tables:    ${info.tables}`]),
  ];
}

/** Runs `studio` and resolves with the process exit code once Studio has stopped. */
export async function runStudio(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox studio --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: "string", short: "p" },
        "read-only": { type: "boolean" },
        api: { type: "string" },
        "max-file-size": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(STUDIO_USAGE);
    return 0;
  }
  if (positionals.length > 1) {
    return fail("Expected one database at most.");
  }
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
  let database: string;
  let api = values.api;
  if (positionals[0] !== undefined) {
    database = resolve(positionals[0]);
  } else {
    const found = findProjectDatabase();
    if (found.status !== "found") {
      return fail(found.message);
    }
    database = found.database;
    // The sandbox of init-nest listens where its configuration says: the API tab starts there.
    api ??= found.port === undefined || found.port === 0 ? undefined : `http://127.0.0.1:${found.port}/`;
    io.stdout.write(`Opening ${shownPath(database)} (from ${found.source}).\n`);
  }

  let studio;
  try {
    studio = await startStudio({
      database,
      ...(port !== undefined && { port }),
      ...(values["read-only"] && { readOnly: true }),
      ...(api !== undefined && { api }),
      ...(maxFileSizeMb !== undefined && { maxFileSizeMb }),
      onSizeWarning: (warning) => io.stderr.write(`${formatSizeWarning(warning)}\n`),
      exporter: exportSqlForStudio,
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return fail(code === "EADDRINUSE" ? `Port ${port ?? DEFAULT_STUDIO_PORT} is already in use. Choose another with --port.` : error instanceof Error ? error.message : String(error));
  }

  for (const notice of studio.notices) {
    io.stderr.write(`Note: ${notice}\n`);
  }
  io.stdout.write(
    // The one place the key is printed: it is what the page needs, and whoever started Studio is whom it is for.
    `Local DB Studio at ${studio.address}\n` +
      `${formatStudioStatus(await studio.status()).join("\n")}\n` +
      (values.api === undefined ? "" : `  api:       ${values.api} (the API tab starts from it; Studio does not start the API)\n`) +
      "  The address holds the key of this session. The page is served to this machine only.\n" +
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
  await studio.stop();
  io.stdout.write("Stopped.\n");
  return 0;
}
