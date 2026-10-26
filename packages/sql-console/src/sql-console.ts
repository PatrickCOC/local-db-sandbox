import { SandboxLimitError } from "../../core/src/index.ts";
import type { Row } from "../../core/src/index.ts";
import { SqliteRuntime, describeSql } from "../../runtime/src/index.ts";
import type { RelationalRuntime, SqlEventListener, SqlOperation, TableSchema, TransactionBoundary } from "../../runtime/src/index.ts";
import { formatNotice, mergeSchemas, openDatabaseStorage, sameSchema } from "../../storage-json/src/index.ts";
import type { DatabaseMetadata, SizeWarningListener } from "../../storage-json/src/index.ts";
import { inferTableSchema } from "./infer-schema.ts";

export interface SqlConsoleOptions {
  /** The database: a JSON file or a database directory. */
  file: string;
  /**
   * Table definitions to use whatever the database stores, for example
   * freshly read from ORM entities. They apply to the tables they name; a
   * table that is not among them keeps its stored definition, or is described
   * from its rows when it has none.
   */
  schema?: TableSchema[];
  /**
   * Asked for table definitions when the database stores none and `schema`
   * is not given. Not called otherwise: a database that describes itself is
   * opened without looking anywhere else.
   */
  fallbackSchema?: () => TableSchema[] | undefined;
  /** Refuse every statement that would change data. */
  readOnly?: boolean;
  /**
   * Write committed changes back to the database. Default: yes, unless the
   * database declares "persistence": "memory". When false they are discarded
   * on close.
   */
  save?: boolean;
  /** Largest database to accept, in MB (default 150, at most 250). */
  maxFileSizeMb?: number;
  onSizeWarning?: SizeWarningListener;
  /** Receives one structured event per executed statement. */
  onSql?: SqlEventListener;
}

/**
 * Where a table's columns come from: `stored` with the database (schema.json
 * of a directory, `$tableSchema` of a single file), `given` to the console
 * (for example from ORM entities), or worked out from the `data`.
 */
export type TableDefinitionSource = "stored" | "given" | "data";

export interface ConsoleTable {
  name: string;
  rows: number;
  source: TableDefinitionSource;
}

/** What one statement or console command produced. */
export type ConsoleResult =
  | {
      kind: "rows";
      operation: SqlOperation;
      columns: string[];
      rows: Row[];
      /** Set when the statement also changed rows, as INSERT ... RETURNING does. */
      affectedRows?: number;
      localExecutionMs: number;
    }
  | { kind: "write"; operation: SqlOperation; affectedRows: number; lastInsertId?: number; localExecutionMs: number }
  | { kind: "ok"; operation: SqlOperation; transaction?: TransactionBoundary; localExecutionMs: number; notice?: string }
  | { kind: "tables"; tables: ConsoleTable[] }
  | { kind: "schema"; tables: { name: string; sql: string; source: TableDefinitionSource }[] }
  | { kind: "help"; text: string }
  | { kind: "exit" }
  | { kind: "error"; code: string; message: string; notice?: string };

export const CONSOLE_HELP = `Enter SQL ending with a semicolon; a statement may span several lines.
The SQL is executed by SQLite on a database built from the JSON database.

  .tables            list the tables and their row counts
  .schema [table]    show how a table (or every table) is defined
  .help              show this help
  .exit, .quit       leave

BEGIN, COMMIT, and ROLLBACK work as in SQLite. Outside a transaction each
statement is committed, and saved, on its own.`;

const SCHEMA_CHANGE = /^\s*(CREATE|ALTER|DROP)\b/i;

/**
 * A SQL console over a JSON database: a single file or a database directory.
 *
 * The database is loaded into the sandbox's relational runtime (SQLite in
 * memory) and statements are executed there. With saving on, the runtime
 * writes a snapshot back before each commit, under the same rules and size
 * limits as everywhere else: a change that cannot be saved is not committed.
 *
 * A table's definition is the one in `schema` when that is given and names
 * the table, otherwise the one stored with the database. `fallbackSchema` is
 * asked only when the database stores no definitions at all. A table that
 * none of them defines is described from its rows.
 *
 * This class has no input or output of its own; see the `sql` command.
 */
export class SqlConsole {
  readonly runtime: RelationalRuntime;
  readonly file: string;
  /**
   * Whether the console was given table definitions (`schema`) that differ
   * from the ones stored with the database. The stored ones are replaced by
   * the next save.
   */
  readonly replacesStoredSchema: boolean;
  /** Set when the database is not in the format this build writes and was opened without saving: what that means, in a line. */
  readonly formatNotice: string | undefined;
  /** What the database stored besides its rows when it was opened: what a copy of it carries (`simulate`, D-045). */
  readonly metadata: DatabaseMetadata;
  /** Tables that have a definition, and where it came from; the others were described from their rows. */
  readonly #defined: Map<string, TableDefinitionSource>;

  private constructor(
    file: string,
    runtime: RelationalRuntime,
    defined: Map<string, TableDefinitionSource>,
    replacesStoredSchema: boolean,
    notice: string | undefined,
    metadata: DatabaseMetadata,
  ) {
    this.file = file;
    this.runtime = runtime;
    this.replacesStoredSchema = replacesStoredSchema;
    this.formatNotice = notice;
    this.metadata = metadata;
    this.#defined = defined;
  }

  static async open(options: SqlConsoleOptions): Promise<SqlConsole> {
    const storage = openDatabaseStorage(options.file, { maxFileSizeMb: options.maxFileSizeMb, onSizeWarning: options.onSizeWarning });
    const state = await storage.load();
    const metadata = storage.metadata();

    const stored = storage.schema;
    const given = options.schema ?? (stored === undefined ? options.fallbackSchema?.() : undefined);
    // Given definitions apply to the tables they name; other tables keep their stored definition.
    const declared = given === undefined ? (stored ?? []) : mergeSchemas(stored, given);
    const givenNames = new Set(given?.map((table) => table.name));
    const defined = new Map<string, TableDefinitionSource>(declared.map((table) => [table.name, givenNames.has(table.name) ? "given" : "stored"]));
    const schema = [...declared, ...Object.entries(state.collections).filter(([name]) => !defined.has(name)).map(([name, rows]) => inferTableSchema(name, rows))];
    if (given !== undefined) {
      // Rows are saved in the shape these definitions give them, so the definitions are saved with
      // them. What was only worked out from the rows is never stored as a definition.
      storage.describe(given);
    }

    const persistence = options.readOnly === true || options.save === false ? "memory" : options.save === true ? "json" : (storage.persistence ?? "json");
    if (persistence === "json") {
      // A database in another format is refused now, with what to do about it, and not at the first commit.
      storage.assertWritable();
    }
    const runtime = await SqliteRuntime.open({ schema, storage, state, persistence, readOnly: options.readOnly });
    if (options.onSql !== undefined) {
      runtime.subscribe(options.onSql);
    }
    const notice = storage.formatStatus === undefined ? undefined : formatNotice(storage.formatStatus, options.file);
    return new SqlConsole(options.file, runtime, defined, given !== undefined && stored !== undefined && !sameSchema(declared, stored), notice, metadata);
  }

  get inTransaction(): boolean {
    return this.runtime.inTransaction;
  }

  tables(): ConsoleTable[] {
    return this.runtime.schema.map((table) => ({
      name: table.name,
      rows: Number(this.runtime.execute(`SELECT COUNT(*) AS n FROM "${table.name.replaceAll('"', '""')}"`).rows[0]?.n ?? 0),
      source: this.#defined.get(table.name) ?? "data",
    }));
  }

  /** Executes one SQL statement. A failure is returned, not thrown. */
  execute(sql: string): ConsoleResult {
    const { operation, transaction } = describeSql(sql, []);
    let localExecutionMs = 0;
    const stop = this.runtime.subscribe((event) => (localExecutionMs = event.localExecutionMs));
    try {
      const statement = this.runtime.prepare(sql);
      const result = statement.execute();
      const changesData = operation === "INSERT" || operation === "UPDATE" || operation === "DELETE";
      if (statement.returnsRows) {
        return { kind: "rows", operation, columns: [...statement.columns], rows: result.rows, ...(changesData && { affectedRows: result.affectedRows }), localExecutionMs };
      }
      if (changesData) {
        return { kind: "write", operation, affectedRows: result.affectedRows, ...(result.lastInsertId !== undefined && operation === "INSERT" && { lastInsertId: Number(result.lastInsertId) }), localExecutionMs };
      }
      return {
        kind: "ok",
        operation,
        ...(transaction !== undefined && { transaction }),
        localExecutionMs,
        ...(SCHEMA_CHANGE.test(sql) && { notice: "Schema changes last until the console closes. Only the rows of the tables that were loaded are saved." }),
      };
    } catch (error) {
      const failure: ConsoleResult = {
        kind: "error",
        code: error instanceof SandboxLimitError ? error.code : ((error as { code?: unknown }).code as string | undefined)?.startsWith("SANDBOX_") ? String((error as { code: unknown }).code) : "SQL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      };
      // A commit that could not be saved leaves its transaction open; nothing of it may stay.
      if (transaction === "COMMIT" && this.runtime.inTransaction) {
        this.runtime.rollback();
        failure.notice = "The transaction was rolled back.";
      }
      return failure;
    } finally {
      stop();
    }
  }

  /** Runs a console command, a line that starts with a dot. */
  command(line: string): ConsoleResult {
    const [name = "", ...args] = line.trim().split(/\s+/);
    switch (name.toLowerCase()) {
      case ".help":
        return { kind: "help", text: CONSOLE_HELP };
      case ".exit":
      case ".quit":
        return { kind: "exit" };
      case ".tables":
        return { kind: "tables", tables: this.tables() };
      case ".schema": {
        const wanted = args[0]?.replace(/;$/, "");
        const tables = this.runtime.schema.filter((table) => wanted === undefined || table.name.toLowerCase() === wanted.toLowerCase());
        if (tables.length === 0) {
          return { kind: "error", code: "UNKNOWN_TABLE", message: `There is no table "${wanted}". Use .tables to list them.` };
        }
        return {
          kind: "schema",
          tables: tables.map((table) => ({
            name: table.name,
            sql: String(this.runtime.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table.name]).rows[0]?.sql ?? ""),
            source: this.#defined.get(table.name) ?? "data",
          })),
        };
      }
      default:
        return { kind: "error", code: "UNKNOWN_COMMAND", message: `Unknown command ${name}. Use .help to list the commands.` };
    }
  }

  /** Ends the session. An open transaction is rolled back; returns whether there was one. */
  close(): boolean {
    const open = this.runtime.inTransaction;
    if (open) {
      this.runtime.rollback();
    }
    this.runtime.close();
    return open;
  }
}
