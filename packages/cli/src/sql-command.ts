import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createSqlLogger } from "../../runtime/src/index.ts";
import type { SqlLogMode } from "../../runtime/src/index.ts";
import { SqlConsole, hasSql, renderJson, renderText, splitStatements } from "../../sql-console/src/index.ts";
import type { ConsoleResult } from "../../sql-console/src/index.ts";
import { DatabaseOwnedError, claimDatabase, claimDatabaseIfThere, databaseFormatFor, formatSizeWarning, maxFileSizeMbProblem } from "../../storage-json/src/index.ts";
import type { DatabaseClaim } from "../../storage-json/src/index.ts";
import type { CliIo } from "./cli.ts";
import { entityTableSchemas, findSandboxProject } from "./project-entities.ts";

export const SQL_USAGE = `Usage: local-db-sandbox sql <database> [options]          interactive SQL console
       local-db-sandbox sql <database> "<SQL>" [options]  run SQL and exit
       local-db-sandbox sql <database> --file <file.sql>  run a file of SQL and exit

<database> is a JSON database: a single file (sandbox.db.json) or a
database directory (sandbox.db). It is loaded into SQLite (in memory) and the
SQL is executed there. Committed changes are written back to the database.
In the console, type .help.

Options:
  -f, --file <file>        Run the statements in this file
      --read-only          Refuse every statement that would change data
      --no-save            Allow changes, but discard them when the command ends
      --json               Print each result as one line of JSON
      --sql-log <mode>     Also log executed statements to stderr: off (default), summary, verbose
      --entities <path>    Take table definitions from the TypeORM entities in this file or folder
      --no-entities        Do not read TypeORM entities
      --max-file-size <MB> Largest database to accept (default: 150; at most 250)
  -h, --help               Show this help

Table definitions are the ones stored with the database (schema.json of a
directory). When it stores none, they come from the TypeORM entities of the
project it belongs to (one set up with "init-nest"), and otherwise from the
rows of each table. --entities reads them from entities whatever is stored.
With several statements, running stops at the first error.
`;

const SQL_LOG_MODES = ["off", "summary", "verbose"];

/** Runs `sql` and resolves with the process exit code. */
export async function runSql(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox sql --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        file: { type: "string", short: "f" },
        "read-only": { type: "boolean" },
        "no-save": { type: "boolean" },
        json: { type: "boolean" },
        "sql-log": { type: "string" },
        entities: { type: "string" },
        "no-entities": { type: "boolean" },
        "max-file-size": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(SQL_USAGE);
    return 0;
  }
  if (positionals.length === 0 || positionals.length > 2) {
    return fail(positionals.length === 0 ? "Missing the database." : "Expected the database and at most one SQL argument.");
  }
  if (positionals.length === 2 && values.file !== undefined) {
    return fail("Give SQL as an argument or with --file, not both.");
  }
  if (values.entities !== undefined && values["no-entities"]) {
    return fail("--entities and --no-entities cannot be used together.");
  }
  const sqlLog = values["sql-log"] ?? "off";
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
  const file = resolve(positionals[0] as string);

  let script: string | undefined = positionals[1];
  let sqlConsole: SqlConsole;
  let opened: SqlConsole | undefined;
  // A console that may save has the database to itself while it is open (D-042). One that writes nothing to it,
  // with --read-only or --no-save, asks no one: it reads what is stored. Whether a database declares that it is
  // never written to is known once it is loaded, so a refusal is kept until then.
  let claim: DatabaseClaim | undefined;
  let refusal: DatabaseOwnedError | undefined;
  try {
    if (values.file !== undefined) {
      script = readFileSync(values.file, "utf8");
    }
    if (!values["read-only"] && !values["no-save"]) {
      try {
        claim = await claimDatabaseIfThere(file, { kind: "sql" });
      } catch (error) {
        if (!(error instanceof DatabaseOwnedError)) {
          throw error;
        }
        refusal = error;
      }
    }
    // Entities named on the command line are always read. The entities of the database's project
    // are read only when the database does not store its table definitions.
    const explicit = values.entities === undefined ? undefined : resolve(values.entities);
    const project = explicit !== undefined || values["no-entities"] ? undefined : findSandboxProject(file)?.entities;
    opened = sqlConsole = await SqlConsole.open({
      file,
      ...(explicit !== undefined && { schema: entityTableSchemas(explicit) }),
      ...(project !== undefined && { fallbackSchema: () => entityTableSchemas(project) }),
      readOnly: values["read-only"],
      // Without --no-save, the database decides: a directory may declare that it is never written to.
      ...(values["no-save"] && { save: false }),
      maxFileSizeMb,
      onSizeWarning: (warning) => io.stderr.write(`${formatSizeWarning(warning)}\n`),
      onSql: createSqlLogger(sqlLog as SqlLogMode, (line) => io.stderr.write(`${line}\n`)),
    });
    if (sqlConsole.runtime.persistence !== "json") {
      claim?.release();
      claim = undefined;
    } else if (refusal !== undefined) {
      throw refusal;
    } else if (!values["read-only"] && !values["no-save"]) {
      // A database that was not there a moment ago, and is now, is claimed like any other.
      claim ??= await claimDatabase(file, { kind: "sql" });
    }
  } catch (error) {
    opened?.close();
    claim?.release();
    const message = error instanceof Error ? error.message : String(error);
    return fail(
      error instanceof DatabaseOwnedError
        ? `${message}\nTo look at the database as it is stored, without changing it, add --read-only. To look into the database of a running sandbox, and change it there, use "local-db-sandbox studio <database>".`
        : message,
    );
  }
  const saves = sqlConsole.runtime.persistence === "json";
  const discardsByDeclaration = !saves && !values["no-save"] && !values["read-only"];
  if (discardsByDeclaration) {
    io.stderr.write(`Note: ${file} declares "persistence": "memory"; changes are not saved.\n`);
  }
  if (sqlConsole.formatNotice !== undefined) {
    io.stderr.write(`Note: ${sqlConsole.formatNotice}\n`);
  }
  if (sqlConsole.replacesStoredSchema) {
    io.stderr.write(`Note: the table definitions of the entities differ from the ones stored in ${file}${saves ? "; the stored ones are replaced when a change is saved" : ""}.\n`);
  }

  const batch = script !== undefined;
  let failed = false;
  const show = (result: ConsoleResult): void => {
    if (result.kind === "exit") {
      return;
    }
    if (result.kind === "error") {
      failed = true;
    }
    if (values.json) {
      io.stdout.write(`${renderJson(result)}\n`);
    } else {
      (result.kind === "error" ? io.stderr : io.stdout).write(`${renderText(result)}\n`);
    }
  };

  // Text that has been entered but does not yet end a statement.
  let pending = "";
  /** Takes one line of input. Returns false when input should stop. */
  const feed = (line: string): boolean => {
    if (!hasSql(pending) && line.trim().startsWith(".")) {
      pending = "";
      const result = sqlConsole.command(line);
      show(result);
      return result.kind !== "exit" && !(batch && result.kind === "error");
    }
    const { statements, rest } = splitStatements(`${pending}${line}\n`);
    pending = rest;
    for (const statement of statements) {
      const result = sqlConsole.execute(statement);
      show(result);
      if (batch && result.kind === "error") {
        pending = "";
        return false;
      }
    }
    return true;
  };

  if (script !== undefined) {
    const complete = script.split(/\r?\n/).every(feed);
    // The last statement of a script does not need a semicolon.
    if (complete && hasSql(pending)) {
      show(sqlConsole.execute(pending.trim()));
    }
  } else {
    const stdin = (io.stdin ?? process.stdin) as NodeJS.ReadableStream;
    const terminal = stdin === process.stdin && process.stdin.isTTY === true;
    const lines = createInterface({ input: stdin, crlfDelay: Infinity, ...(terminal && { output: process.stdout, terminal: true }) });
    const prompt = (): void => {
      if (terminal) {
        lines.setPrompt(hasSql(pending) ? "...> " : "sql> ");
        lines.prompt();
      }
    };
    if (terminal) {
      const kind = databaseFormatFor(file) === "directory" ? "directory" : "file";
      const mode = values["read-only"]
        ? "Read-only: statements that change data are refused."
        : values["no-save"]
          ? "Changes are not saved (--no-save)."
          : discardsByDeclaration
            ? "Changes are not saved."
            : `Committed changes are saved to the ${kind}.`;
      const tables = sqlConsole.tables();
      const definitions = tables.some((table) => table.source === "given") ? " (from the TypeORM entities)" : tables.some((table) => table.source === "stored") ? " (from the stored schema)" : "";
      io.stdout.write(
        `Local DB Sandbox SQL console: ${file}\n` +
          `SQLite in memory, loaded from the ${kind}. ${mode}\n` +
          `Tables${definitions}: ${tables.length > 0 ? tables.map((table) => `${table.name} (${table.rows})`).join(", ") : "(none)"}\n` +
          "Type .help for commands, .exit to leave.\n",
      );
    }
    prompt();
    for await (const line of lines) {
      if (!feed(line)) {
        break;
      }
      prompt();
    }
    lines.close();
    if (hasSql(pending)) {
      io.stderr.write("The last statement was not finished with a semicolon and was not executed.\n");
    }
  }

  try {
    if (sqlConsole.close()) {
      io.stderr.write("A transaction was still open and was rolled back.\n");
      failed = true;
    }
  } finally {
    claim?.release();
  }
  return batch && failed ? 1 : 0;
}
