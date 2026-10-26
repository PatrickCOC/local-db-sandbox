import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { RuntimeSchemaError, SqliteRuntime, UnkeptSchemaChangeError, leadingKeyword } from "../../runtime/src/index.ts";
import type { TableCatalog, TableSchema } from "../../runtime/src/index.ts";
import { SqlConsole, hasSql, renderText, splitStatements } from "../../sql-console/src/index.ts";
import type { ConsoleResult } from "../../sql-console/src/index.ts";
import { DatabaseOwnedError, canonicalDatabasePath, claimDatabase, createDatabase, databaseFormatFor, describeOwner, formatSizeWarning, inspectOwner } from "../../storage-json/src/index.ts";
import type { DatabaseClaim } from "../../storage-json/src/index.ts";
import type { CliIo } from "./cli.ts";
import { parseMaxFileSize } from "./inspect-command.ts";

export const SIMULATE_USAGE = `Usage: local-db-sandbox simulate <database> <script.sql> [options]

Runs a SQL script on a copy of a database, and leaves the database as it was.
The copy is a new database beside it (sandbox.db gives sandbox-preview.db),
in the same format. Look at it with "studio" or "sql", compare it with
"diff-schema", and delete it when you are done with it.

The script is run by the sandbox's SQLite, statement by statement, as
"sql --file" runs one, and stops at the first error. SQL is not translated:
what SQLite cannot run, such as syntax of PostgreSQL, is an error.

What the copy keeps of the script:
  rows       INSERT, UPDATE, DELETE
  tables     CREATE TABLE, DROP TABLE
  columns    ALTER TABLE ... ADD COLUMN, ALTER TABLE ... DROP COLUMN
Any other change of a table's definition (an index, a view, a trigger, a
renamed table or column, a CHECK constraint, a collation, a type SQLite gives
no meaning of its own, such as serial or timestamptz) fails its statement,
which then changes nothing. ATTACH, DETACH, and VACUUM are not run: nothing
but the copy is written.

When a statement fails, the copy is still written, with what the statements
before it changed, and the command says so and exits with 1. What a
transaction that was not committed changed is not in the copy.

Options:
      --out <path>         Where to write the copy (default: <name>-preview beside the database)
      --replace            Write over a database that is at --out already; refused while a process has it open
      --max-file-size <MB> Largest database to accept (default: 150; at most 250)
  -h, --help               Show this help
`;

/** Statements that write elsewhere than the database in memory: a simulation writes nothing but the copy. */
const NOT_RUN = new Set(["ATTACH", "DETACH", "VACUUM"]);

/** Statements that may change the definition of a table; each is followed in the catalog, and undone when it cannot be. */
const SCHEMA_STATEMENTS = new Set(["CREATE", "ALTER", "DROP"]);

/** The savepoint a statement that changes the schema runs in, so that it can be undone. */
const SAVEPOINT = "local_db_sandbox_simulate";

/** Where the copy of `database` goes when no --out is given: `<name>-preview`, beside it, in the same format (sandbox.db gives sandbox-preview.db). */
export function previewPathOf(database: string): string {
  const name = basename(database);
  const json = /\.json$/i.test(name) ? name.slice(-5) : "";
  const stem = json === "" ? name : name.slice(0, -5);
  const dot = stem.indexOf(".", 1);
  const path = join(dirname(database), `${dot === -1 ? `${stem}-preview` : `${stem.slice(0, dot)}-preview${stem.slice(dot)}`}${json}`);
  // Spelled as the database was: ./sandbox.db gives ./sandbox-preview.db.
  const here = /^\.[\\/]/.exec(database)?.[0];
  return here !== undefined && !path.startsWith(here) && dirname(path) === "." ? `${here}${path}` : path;
}

/** Whether `path` is inside `directory`; both canonical. */
function isInside(path: string, directory: string): boolean {
  const way = relative(directory, path);
  return way !== "" && !way.startsWith("..") && !isAbsolute(way);
}

/** A path as a command line takes it. */
function argument(path: string): string {
  return /[\s"'$`]/.test(path) ? JSON.stringify(path) : path;
}

/** "statement 3", "statements 1-2", "statements 1-5". */
function statementsLabel(from: number, to: number): string {
  return from === to ? `statement ${from}` : `statements ${from}-${to}`;
}

/** The first line of a statement, short enough for a line of its own. */
function firstLine(sql: string): string {
  const line = sql.trim().split(/\r?\n/)[0] as string;
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** What the script did to the tables, in words: tables made and dropped, columns added and dropped. */
function schemaChanges(before: readonly TableSchema[], after: readonly TableSchema[]): string[] {
  const was = new Map(before.map((table) => [table.name, table]));
  const now = new Map(after.map((table) => [table.name, table]));
  const lines: string[] = [];
  for (const table of after) {
    const old = was.get(table.name);
    if (old === undefined) {
      lines.push(`table "${table.name}" made`);
    } else if (old !== table) {
      const names = new Set(old.columns.map((column) => column.name));
      const kept = new Set(table.columns.map((column) => column.name));
      lines.push(...table.columns.filter((column) => !names.has(column.name)).map((column) => `column "${table.name}"."${column.name}" added`));
      lines.push(...old.columns.filter((column) => !kept.has(column.name)).map((column) => `column "${table.name}"."${column.name}" dropped`));
    }
  }
  lines.push(...before.filter((table) => !now.has(table.name)).map((table) => `table "${table.name}" dropped`));
  return lines;
}

/** Runs `simulate` and resolves with the process exit code. */
export async function runSimulate(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox simulate --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string" },
        replace: { type: "boolean" },
        "max-file-size": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(SIMULATE_USAGE);
    return 0;
  }
  if (positionals.length !== 2) {
    return fail(positionals.length < 2 ? "Expected the database and the SQL script." : "Expected only the database and the SQL script.");
  }
  const { maxFileSizeMb, problem } = parseMaxFileSize(values["max-file-size"]);
  if (problem !== undefined) {
    return fail(problem);
  }
  const [database, scriptPath] = positionals as [string, string];
  const out = values.out ?? previewPathOf(database);

  // What is where. Nothing is read, claimed, or written until all of it is right.
  if (!existsSync(database)) {
    return fail(`Database not found: ${database}`);
  }
  const original = canonicalDatabasePath(database);
  const copy = canonicalDatabasePath(out);
  if (copy === original) {
    return fail(`The copy cannot be written to ${out}: that is the database itself. Give --out a path of its own.`);
  }
  if (isInside(copy, original) || isInside(original, copy)) {
    return fail(`The copy cannot be written to ${out}: it would be ${isInside(copy, original) ? "inside the database" : "a directory that holds the database"}. Give --out a path beside it.`);
  }
  const format = databaseFormatFor(database);
  if (databaseFormatFor(out) !== format) {
    return fail(
      format === "directory"
        ? `${database} is a database directory, and ${out} would be a single file. Give --out a path that does not end in .json; "convert" changes the format of a database.`
        : `${database} is a single-file database, and ${out} would be a directory. Give --out a path that ends in .json; "convert" changes the format of a database.`,
    );
  }
  let scriptStats;
  try {
    scriptStats = statSync(scriptPath);
  } catch {
    return fail(`SQL script not found: ${scriptPath}`);
  }
  if (!scriptStats.isFile()) {
    return fail(`${scriptPath} is not a file. Give the file of SQL to run.`);
  }
  const script = canonicalDatabasePath(scriptPath);
  if (isInside(script, original) || isInside(script, copy) || script === copy) {
    return fail(`${scriptPath} is inside ${isInside(script, original) ? database : out}. Keep the script outside the database and the copy.`);
  }
  if (existsSync(out) && !values.replace) {
    return fail(`${out} exists already, and a simulation does not write over it. Delete it if it is a copy you are done with, give another --out, or add --replace.`);
  }
  const text = readFileSync(scriptPath, "utf8");
  const { statements: complete, rest } = splitStatements(text);
  // The last statement of a script does not need a semicolon.
  const statements = hasSql(rest) ? [...complete, rest.trim()] : complete;
  if (statements.length === 0) {
    return fail(`${scriptPath} has no SQL statement.`);
  }

  let claim: DatabaseClaim | undefined;
  let sqlConsole: SqlConsole | undefined;
  try {
    if (values.replace && existsSync(out)) {
      // The database at --out is claimed for as long as it is replaced, as `init --force` claims the one it replaces (D-043).
      try {
        claim = await claimDatabase(out, { kind: "simulate" });
      } catch (error) {
        if (error instanceof DatabaseOwnedError) {
          return fail(`${error.message}\nNothing was run, and ${out} was not changed. Stop that process, or give another --out.`);
        }
        throw error;
      }
    }
    const owner = await inspectOwner(database);
    if (owner.state === "live") {
      io.stderr.write(`Note: ${database} is open in ${owner.record === undefined ? "another process" : describeOwner(owner.record)}. The copy starts from what is stored now; that process and its database are left alone.\n`);
    }

    // The database is read, and never opened to write: its changes stay in memory until the copy is written.
    try {
      sqlConsole = await SqlConsole.open({ file: database, save: false, maxFileSizeMb, onSizeWarning: (warning) => io.stderr.write(`${formatSizeWarning(warning)}\n`) });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const runtime = sqlConsole.runtime;
    if (!(runtime instanceof SqliteRuntime)) {
      throw new TypeError("The SQL console did not open the SQLite runtime.");
    }
    if (sqlConsole.formatNotice !== undefined) {
      io.stderr.write(`Note: ${sqlConsole.formatNotice}\n`);
    }

    /*
     * What the tables are, as definitions: read again after each statement that may change them. A statement whose
     * change cannot be described is undone. A transaction keeps the reading it began with, for when it is rolled back.
     */
    let accepted: TableCatalog = runtime.readCatalog();
    let transaction: { from: number; catalog: TableCatalog } | undefined;
    let failed: { index: number; unfollowed?: true } | undefined;
    const show = (result: ConsoleResult): void => {
      // The console's note that schema changes are not saved is about the console: here they are kept in the copy.
      const shown = result.kind === "ok" ? { ...result, notice: undefined } : result;
      (result.kind === "error" ? io.stderr : io.stdout).write(`${renderText(shown)}\n`);
    };

    for (const [index, sql] of statements.entries()) {
      const keyword = leadingKeyword(sql);
      if (NOT_RUN.has(keyword)) {
        show({ kind: "error", code: "SIMULATION_REFUSED", message: `${keyword} is not run in a simulation: it would write elsewhere than the copy.` });
        failed = { index };
        break;
      }
      const inTransaction = runtime.inTransaction;
      let result: ConsoleResult;
      if (SCHEMA_STATEMENTS.has(keyword)) {
        runtime.execute(`SAVEPOINT ${SAVEPOINT}`);
        result = sqlConsole.execute(sql);
        if (result.kind !== "error") {
          try {
            accepted = runtime.readCatalog(accepted);
          } catch (error) {
            if (!(error instanceof UnkeptSchemaChangeError)) {
              throw error;
            }
            result = { kind: "error", code: "SCHEMA_CHANGE_NOT_KEPT", message: `${error.message} The statement was undone.` };
          }
        }
        if (result.kind === "error") {
          runtime.execute(`ROLLBACK TO ${SAVEPOINT}`);
        }
        runtime.execute(`RELEASE ${SAVEPOINT}`);
      } else {
        result = sqlConsole.execute(sql);
      }
      show(result);
      if (result.kind === "error") {
        failed = { index };
        break;
      }
      if (!inTransaction && runtime.inTransaction) {
        transaction = { from: index, catalog: accepted };
      } else if (inTransaction && !runtime.inTransaction) {
        if (keyword === "ROLLBACK" && transaction !== undefined) {
          accepted = transaction.catalog;
        }
        transaction = undefined;
      } else if (inTransaction && keyword === "ROLLBACK") {
        // ROLLBACK TO a savepoint of the script's own: what it undid is read again.
        try {
          accepted = runtime.readCatalog(accepted);
        } catch (error) {
          if (!(error instanceof UnkeptSchemaChangeError)) {
            throw error;
          }
          io.stderr.write(`Error: after this statement the tables are not what the simulation can follow. ${error.message}\n`);
          failed = { index, unfollowed: true };
          break;
        }
      }
    }

    // A transaction that was not committed is not in the copy.
    const rolledBack = runtime.inTransaction ? transaction : undefined;
    if (runtime.inTransaction) {
      runtime.rollback();
      accepted = transaction?.catalog ?? accepted;
    }
    const summary: string[] = [];
    const total = statements.length;
    if (failed !== undefined) {
      const at = failed.index + 1;
      summary.push(`Simulation failed at statement ${at} of ${total}: ${firstLine(statements[failed.index] as string)}`);
      summary.push(
        [
          at > 1 ? `${statementsLabel(1, at - 1)} ran` : "",
          failed.unfollowed ? `statement ${at} ran` : `statement ${at} changed nothing`,
          at < total ? `${statementsLabel(at + 1, total)} did not run` : "",
        ]
          .filter((part) => part !== "")
          .join("; ")
          .replace(/^./, (first) => first.toUpperCase()) + ".",
      );
    }
    if (rolledBack !== undefined) {
      summary.push(
        `${failed === undefined ? "The script left a transaction open" : "A transaction was open"} from statement ${rolledBack.from + 1}, and it was rolled back: what ${statementsLabel(rolledBack.from + 1, failed?.index ?? total)} changed is not in the copy.`,
      );
    }
    const ok = failed === undefined && rolledBack === undefined;
    /** The summary: on stdout when the whole script is in the copy, on stderr when it is not. */
    const report = (lines: string[], success = ok): void => {
      (success ? io.stdout : io.stderr).write(`${lines.join("\n")}\n`);
    };
    const untouched = `${database} was not changed.`;

    let tables: readonly TableSchema[];
    let state;
    try {
      // Read once more: what no statement was followed for (a PRAGMA, say) is found here, and nothing of it is written.
      tables = runtime.readCatalog(accepted).tables;
      state = runtime.stateOf(tables);
      // What is written must open again: a row that the stored definitions refuse is found now, not by whoever opens the copy.
      const check = await SqliteRuntime.open({ schema: [...tables], state: structuredClone(state), persistence: "memory" });
      check.close();
    } catch (error) {
      if (!(error instanceof RuntimeSchemaError)) {
        throw error;
      }
      report([
        ...summary,
        `No copy was written: the tables the script left cannot be kept as a database of the sandbox. ${error.message}`,
        `${untouched}${claim === undefined ? "" : ` ${out} is as it was.`}`,
      ], false);
      return 1;
    }

    // The definitions to store: those that were stored, and those of tables that SQL made or changed. A table that was
    // described from its rows, and that SQL did not change, is described from its rows again by whoever opens the copy.
    const stored = new Set((sqlConsole.metadata.schema ?? []).map((table) => table.name));
    const unchanged = new Set(runtime.schema);
    const schema = tables.filter((table) => !unchanged.has(table) || stored.has(table.name));
    const { schema: _stored, ...metadata } = sqlConsole.metadata;
    try {
      await createDatabase(
        out,
        { ...metadata, ...((schema.length > 0 || sqlConsole.metadata.schema !== undefined) && { schema }), collections: state.collections },
        { format, overwrite: claim !== undefined, maxFileSizeMb, onSizeWarning: (warning) => io.stderr.write(`${formatSizeWarning(warning)}\n`) },
      );
    } catch (error) {
      report([...summary, `No copy was written: ${error instanceof Error ? error.message : String(error)}`, untouched], false);
      return 1;
    }

    const changes = schemaChanges(runtime.schema, tables);
    const kept = rolledBack?.from ?? failed?.index ?? total;
    const lines = ok
      ? [`Simulated: the ${total === 1 ? "statement" : `${total} statements`} of ${scriptPath} ran on a copy of ${database}. ${untouched}`, `Copy: ${out}`]
      : [
          ...summary,
          `${untouched}`,
          kept === 0
            ? `Copy: ${out}, with nothing the script changed: it holds the database as it was read.`
            : `Copy (partial): ${out}, with what ${statementsLabel(1, kept)} changed. It is not what the whole script would give.`,
        ];
    if (changes.length > 0) {
      lines.push(`Tables of the copy: ${changes.join("; ")}.`);
    }
    lines.push(
      `To look at it:   local-db-sandbox studio ${argument(out)}`,
      `                 local-db-sandbox sql ${argument(out)}`,
      `To compare:      local-db-sandbox diff-schema ${argument(database)} ${argument(out)}`,
      `To discard it:   delete ${out}`,
    );
    report(lines);
    return ok ? 0 : 1;
  } finally {
    sqlConsole?.close();
    claim?.release();
  }
}
