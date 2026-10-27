import type { DatabaseSync, StatementSync } from "node:sqlite";
import { SandboxLimitError } from "../../core/src/index.ts";
import { exactInteger, fromStoredValue as fromStored, toDatetimeText, toStoredValue as toStored } from "./column-codec.ts";
import { registerCompatibilityFunctions } from "./compatibility-functions.ts";
import type { DatabaseState, Row } from "../../core/src/index.ts";
import { describeSql, leadingKeyword } from "./describe-sql.ts";
import type { SqlDescription } from "./describe-sql.ts";
import { rewritePositionalParameters } from "./positional-parameters.ts";
import { catalogOf, readTableCatalog } from "./sqlite-catalog.ts";
import type { CatalogQuery, TableCatalog } from "./sqlite-catalog.ts";
import { compileQuery, quoteIdentifier } from "./query-ir.ts";
import type { Query } from "./query-ir.ts";
import { RuntimeSchemaError, SandboxDialectUnsupportedError, SandboxParameterError, SandboxReadOnlyError } from "./runtime.ts";
import { TableChanges } from "./table-changes.ts";
import type {
  ColumnSchema,
  ColumnType,
  DefaultFunction,
  ExecuteOptions,
  ExecuteResult,
  PersistenceMode,
  PreparedStatement,
  RelationalRuntime,
  SnapshotSaveListener,
  SnapshotStorage,
  SqlEvent,
  SqlEventContext,
  SqlEventListener,
  SqlValue,
  TableSchema,
} from "./runtime.ts";

export interface SqliteRuntimeOptions {
  /** Tables to create. */
  schema: TableSchema[];
  /** Where the fixture is loaded from. Without it the tables start empty. */
  storage?: SnapshotStorage;
  /**
   * The fixture itself, from a caller that has already loaded it from the
   * storage, so that it is not read twice. Default: `storage.load()`.
   */
  state?: DatabaseState;
  /** Default: `json` when a storage is given, otherwise `memory`. */
  persistence?: PersistenceMode;
  /**
   * Refuse every statement that would change data or schema. SQLite itself
   * enforces this (`PRAGMA query_only`); statements are not inspected.
   */
  readOnly?: boolean;
  /** Monotonic clock in milliseconds used for timing. Defaults to `performance.now`. */
  now?: () => number;
  /**
   * Says what the current statement runs for, if anything. It is called once
   * for every statement that is reported, in the caller's own asynchronous
   * context, and the result is put on the event as `requestId` and
   * `sequence`.
   */
  context?: () => SqlEventContext | undefined;
  /**
   * Most returned rows to put on an event as `resultPreview` (default 20).
   * `0` puts none. Whole result sets are never copied onto events.
   */
  resultPreviewRows?: number;
  /** Receives one structured event for every save of the tables to the storage. */
  onSave?: SnapshotSaveListener;
}

const DECLARED_TYPES: Record<ColumnSchema["type"], string> = {
  integer: "INTEGER",
  real: "REAL",
  numeric: "NUMERIC",
  text: "TEXT",
  boolean: "BOOLEAN",
  datetime: "DATETIME",
  date: "DATE",
  // Declared as text so that JSON such as `12` is not turned into a number.
  json: "TEXT",
  binary: "BLOB",
  any: "",
};

/** Statements that must not be wrapped in a transaction of the runtime's own. */
const UNWRAPPED = new Set(["PRAGMA", "BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE", "VACUUM", "ATTACH", "DETACH"]);
const WRITE_KEYWORD = /\b(insert|update|delete|replace)\b/i;
// SQLITE_ERROR: the statement could not be compiled.
const SQLITE_ERROR = 1;
const SQLITE_READONLY = 8;
const DEFAULT_RESULT_PREVIEW_ROWS = 20;

function keyOf(column: ColumnSchema): string {
  return column.key ?? column.name;
}

/**
 * The rows a statement returns. SQLite's integers have 64 bits, and
 * `node:sqlite` refuses to return one that a number cannot hold exactly.
 * Such a result is read again with every integer as a BigInt, and those
 * integers are then given as text of their digits: exact, and safe to put in
 * JSON. `rereadable` says that running the statement twice changes nothing;
 * a statement that also writes is read that way from the start.
 */
function allRows(statement: StatementSync, bound: (null | number | bigint | string | Uint8Array)[], rereadable: boolean): Row[] {
  if (rereadable) {
    try {
      return statement.all(...bound) as Row[];
    } catch (error) {
      if ((error as { code?: string }).code !== "ERR_OUT_OF_RANGE") {
        throw error;
      }
    }
  }
  statement.setReadBigInts(true);
  try {
    const rows = statement.all(...bound) as Row[];
    for (const row of rows) {
      for (const [name, value] of Object.entries(row)) {
        if (typeof value === "bigint") {
          row[name] = exactInteger(value);
        }
      }
    }
    return rows;
  } finally {
    statement.setReadBigInts(false);
  }
}

/**
 * The first `most` rows of a statement that changes nothing, and whether it
 * has more. The statement is not read beyond them. Integers that a number
 * cannot hold are given as `allRows` gives them.
 */
function firstRows(statement: StatementSync, bound: (null | number | bigint | string | Uint8Array)[], most: number): { rows: Row[]; more: boolean } {
  const read = (): { rows: Row[]; more: boolean } => {
    const rows: Row[] = [];
    for (const row of statement.iterate(...bound) as Iterable<Row>) {
      if (rows.length === most) {
        // Leaving the loop ends the statement where it stands.
        return { rows, more: true };
      }
      rows.push(row);
    }
    return { rows, more: false };
  };
  try {
    return read();
  } catch (error) {
    if ((error as { code?: string }).code !== "ERR_OUT_OF_RANGE") {
      throw error;
    }
  }
  statement.setReadBigInts(true);
  try {
    const result = read();
    for (const row of result.rows) {
      for (const [name, value] of Object.entries(row)) {
        if (typeof value === "bigint") {
          row[name] = exactInteger(value);
        }
      }
    }
    return result;
  } finally {
    statement.setReadBigInts(false);
  }
}

/**
 * A parameter as SQLite binds it. `index` is its position, for the message
 * when it cannot be bound.
 *
 * Nothing else is converted here: a value of another kind was not prepared
 * for the database by whoever produced the statement, and is refused rather
 * than given a form that nobody asked for.
 */
function bind(value: SqlValue, index = 0): null | number | bigint | string | Uint8Array {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return toDatetimeText(value);
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "string" || ArrayBuffer.isView(value)) {
    return value;
  }
  // node:sqlite would take an object in first position for named parameters, and bind nothing at all for an empty one.
  const kind = Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `a ${typeof value}`;
  throw new TypeError(
    `Parameter ${index + 1} is ${kind}, which SQLite cannot bind. Only null, numbers, bigints, strings, booleans, dates, and binary data are bound; ` +
      "any other value has to be converted before it reaches the runtime.",
  );
}

/** Why `given` parameters do not fit a statement whose highest `$N` placeholder is `$highest`. */
function placeholderMismatch(highest: number, given: number): string {
  const count = given === 0 ? "no parameters were" : given === 1 ? "1 parameter was" : `${given} parameters were`;
  return given < highest ? `The statement uses $${highest}, but ${count} given.` : `${count} given, but the statement uses none after $${highest}.`;
}

function literal(value: SqlValue): string {
  const bound = bind(value);
  if (bound === null) {
    return "NULL";
  }
  if (bound instanceof Uint8Array) {
    // Bytes are written as a blob literal: as text they would be whatever characters the bytes happen to be.
    return `X'${Buffer.from(bound.buffer, bound.byteOffset, bound.byteLength).toString("hex")}'`;
  }
  return typeof bound === "string" ? `'${bound.replaceAll("'", "''")}'` : String(bound);
}

const REFERENTIAL_ACTION = /^(CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION)$/;

/** SQLite's expression for a default the database computes, in the form the runtime stores the column's values. */
const DEFAULT_FUNCTIONS: Record<DefaultFunction, { type: ColumnType; sql: string }> = {
  current_timestamp: { type: "datetime", sql: "(strftime('%Y-%m-%d %H:%M:%f', 'now'))" },
  current_date: { type: "date", sql: "(date('now'))" },
};

function columnList(names: readonly string[]): string {
  return names.map(quoteIdentifier).join(", ");
}

function referentialActions(onDelete: string | undefined, onUpdate: string | undefined): string {
  return (onDelete !== undefined && REFERENTIAL_ACTION.test(onDelete) ? ` ON DELETE ${onDelete}` : "") + (onUpdate !== undefined && REFERENTIAL_ACTION.test(onUpdate) ? ` ON UPDATE ${onUpdate}` : "");
}

/** Refuses a constraint or index of `table` that names a column the table does not have. */
function assertColumns(table: TableSchema, columns: readonly string[], what: string): void {
  if (columns.length === 0) {
    throw new RuntimeSchemaError(`Table "${table.name}": ${what} names no column.`);
  }
  const missing = columns.find((name) => !table.columns.some((column) => column.name === name));
  if (missing !== undefined) {
    throw new RuntimeSchemaError(`Table "${table.name}": ${what} names the column "${missing}", which the table does not have.`);
  }
}

function createTableSql(table: TableSchema, tables: TableSchema[]): string {
  if (table.columns.length === 0) {
    throw new RuntimeSchemaError(`Table "${table.name}" has no columns.`);
  }
  let primary = table.columns.filter((column) => column.primary);
  if (table.primaryKey !== undefined) {
    // The constraint gives the order of the key; the columns marked primary are the same set.
    const named = table.primaryKey.columns;
    if (named.length !== primary.length || new Set(named).size !== named.length || !primary.every((column) => named.includes(column.name))) {
      throw new RuntimeSchemaError(
        `Table "${table.name}": the primary key ${table.primaryKey.name === undefined ? "" : `"${table.primaryKey.name}" `}is on (${named.join(", ")}), but the columns marked primary are (${primary.map((column) => column.name).join(", ")}).`,
      );
    }
    primary = named.map((name) => primary.find((column) => column.name === name) as ColumnSchema);
  }
  const definitions = table.columns.map((column) => {
    let sql = `${quoteIdentifier(column.name)} ${DECLARED_TYPES[column.type]}`.trimEnd();
    if (column.autoIncrement) {
      if (primary.length !== 1 || !column.primary || column.type !== "integer") {
        throw new RuntimeSchemaError(`"${table.name}"."${column.name}": only a single integer primary key can be generated by the database.`);
      }
      // AUTOINCREMENT never reuses the key of a deleted row.
      return `${sql} PRIMARY KEY AUTOINCREMENT`;
    }
    if (primary.length === 1 && column.primary) {
      sql += " PRIMARY KEY";
    }
    if (!column.nullable) {
      sql += " NOT NULL";
    }
    if (column.defaultFunction !== undefined) {
      const computed = Object.hasOwn(DEFAULT_FUNCTIONS, column.defaultFunction) ? DEFAULT_FUNCTIONS[column.defaultFunction] : undefined;
      if (computed === undefined || computed.type !== column.type) {
        throw new RuntimeSchemaError(
          `"${table.name}"."${column.name}": the default ${JSON.stringify(column.defaultFunction)} is not one the runtime computes for a ${column.type} column ` +
            `(current_timestamp for datetime, current_date for date).`,
        );
      }
      sql += ` DEFAULT ${computed.sql}`;
    } else if (column.default !== undefined) {
      sql += ` DEFAULT ${literal(toStored(column, column.default))}`;
    }
    if (column.enum !== undefined) {
      // A type without values (PostgreSQL allows one) leaves the column nothing but NULL.
      sql +=
        column.enum.values.length === 0
          ? ` CHECK (${quoteIdentifier(column.name)} IS NULL)`
          : ` CHECK (${quoteIdentifier(column.name)} IN (${column.enum.values.map((value) => literal(value)).join(", ")}))`;
    }
    const target = column.references;
    if (target !== undefined && tables.some((other) => other.name === target.table && other.columns.some((candidate) => candidate.name === target.column))) {
      sql += ` REFERENCES ${quoteIdentifier(target.table)} (${quoteIdentifier(target.column)})${referentialActions(target.onDelete, target.onUpdate)}`;
    }
    return sql;
  });
  if (primary.length > 1) {
    definitions.push(`PRIMARY KEY (${columnList(primary.map((column) => column.name))})`);
  }
  for (const unique of table.uniques ?? []) {
    assertColumns(table, unique.columns, `the unique constraint ${unique.name ?? `on (${unique.columns.join(", ")})`}`);
    definitions.push(`UNIQUE (${columnList(unique.columns)})`);
  }
  for (const key of table.foreignKeys ?? []) {
    const what = `the foreign key ${key.name ?? `on (${key.columns.join(", ")})`}`;
    assertColumns(table, key.columns, what);
    if (key.columns.length !== key.references.columns.length) {
      throw new RuntimeSchemaError(`Table "${table.name}": ${what} has ${key.columns.length} columns and refers to ${key.references.columns.length}.`);
    }
    const referenced = tables.find((other) => other.name === key.references.table);
    // As for a column's reference: a key into a table the schema does not have is kept as information.
    if (referenced !== undefined && key.references.columns.every((name) => referenced.columns.some((column) => column.name === name))) {
      definitions.push(
        `FOREIGN KEY (${columnList(key.columns)}) REFERENCES ${quoteIdentifier(key.references.table)} (${columnList(key.references.columns)})${referentialActions(key.onDelete, key.onUpdate)}`,
      );
    }
  }
  return `CREATE TABLE ${quoteIdentifier(table.name)} (${definitions.join(", ")})`;
}

/** The indexes of a table that are created: those over plain columns, without a condition. */
function createIndexSql(table: TableSchema): string[] {
  return (table.indexes ?? []).flatMap((index) => {
    if ((index.expressions?.length ?? 0) > 0 || index.where !== undefined) {
      return [];
    }
    assertColumns(table, index.columns, `the index "${index.name}"`);
    return [`CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(index.name)} ON ${quoteIdentifier(table.name)} (${columnList(index.columns)})`];
  });
}

/**
 * The relational runtime on embedded SQLite (`node:sqlite`, in memory).
 *
 * Opening creates the schema's tables and inserts the fixture's rows. From
 * then on SQLite is the only engine: statements run on it, and transactions
 * are SQLite transactions.
 *
 * With `json` persistence, the tables are saved just before each commit that
 * changed data. If saving fails, for example because the snapshot is above
 * the size limit, the commit does not happen. A statement outside a
 * transaction is its own commit and is rolled back in that case.
 *
 * A storage that can store single tables (`saveTablesSync`) is given the
 * tables whose rows the commit changed, and no others. Which tables those are
 * is taken from SQLite's own record of the rows it changed (see
 * table-changes.ts), not from the statements. When it cannot be told, the
 * complete state is saved, as it is for a storage that only takes that.
 */
export class SqliteRuntime implements RelationalRuntime {
  readonly schema: readonly TableSchema[];
  readonly persistence: PersistenceMode;
  readonly #database: DatabaseSync;
  readonly #storage: SnapshotStorage | undefined;
  readonly #now: () => number;
  readonly #context: (() => SqlEventContext | undefined) | undefined;
  readonly #previewRows: number;
  readonly #readOnly: boolean;
  readonly #tableNames: string[];
  readonly #listeners = new Set<SqlEventListener>();
  readonly #internal = new Map<string, StatementSync>();
  #meta: DatabaseState["meta"] = { version: 1 };
  /** Collections of the fixture that are not tables of the schema; they are saved back unchanged. */
  #otherCollections: Record<string, Row[]> = {};
  #collectionOrder: string[] = [];
  /** Value of total_changes() when the saved snapshot last matched the database. */
  #savedAt = 0;
  /** Which tables changed since they were saved. Absent when the storage only takes the complete state, or the engine cannot tell. */
  #changes: TableChanges | undefined;
  /** The next save has to be of the complete state, whatever is known of the changes. */
  #completeSaveDue = false;
  /** What was saved for a commit that has not happened yet. */
  #unsettled: { tables: readonly string[]; complete: boolean } | undefined;
  /** Time spent saving while the current statement runs. */
  #saveMs = 0;
  readonly #onSave: SnapshotSaveListener | undefined;
  /** The catalog as the runtime created it: where `readCatalog` starts from. */
  #createdCatalog: TableCatalog | undefined;
  #closed = false;

  private constructor(database: DatabaseSync, options: SqliteRuntimeOptions, persistence: PersistenceMode) {
    this.#database = database;
    this.schema = options.schema;
    this.persistence = persistence;
    this.#storage = options.storage;
    this.#now = options.now ?? (() => performance.now());
    this.#context = options.context;
    this.#previewRows = options.resultPreviewRows ?? DEFAULT_RESULT_PREVIEW_ROWS;
    this.#readOnly = options.readOnly === true;
    this.#tableNames = options.schema.map((table) => table.name);
    this.#onSave = options.onSave;
  }

  static async open(options: SqliteRuntimeOptions): Promise<SqliteRuntime> {
    const persistence = options.persistence ?? (options.storage === undefined ? "memory" : "json");
    if (persistence === "json" && options.storage === undefined) {
      throw new RuntimeSchemaError('Persistence mode "json" needs a storage to save to.');
    }
    const names = options.schema.map((table) => table.name);
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    if (repeated !== undefined) {
      throw new RuntimeSchemaError(`Table "${repeated}" is defined more than once.`);
    }
    const state = options.state ?? (await options.storage?.load()) ?? { meta: { version: 1 }, collections: {} };

    // Loaded on demand: the standalone JSON mode does not need SQLite.
    const { DatabaseSync } = await import("node:sqlite");
    const runtime = new SqliteRuntime(new DatabaseSync(":memory:"), options, persistence);
    try {
      // The few functions of other databases that the runtime provides itself; SQL is not rewritten for them.
      registerCompatibilityFunctions(runtime.#database);
      runtime.#create();
      runtime.#load(state);
      runtime.#createdCatalog = catalogOf(runtime.#catalogQuery, options.schema);
      if (persistence === "json" && options.storage?.saveTablesSync !== undefined) {
        // After the fixture is in: its rows are what the storage holds, not changes.
        runtime.#changes = TableChanges.attach(runtime.#database, options.schema);
        // A table that the storage does not hold yet is first stored with all the others, in the schema's order.
        runtime.#completeSaveDue = options.schema.some((table) => !Object.hasOwn(state.collections, table.name));
      }
      if (runtime.#readOnly) {
        runtime.#database.exec("PRAGMA query_only = ON");
      }
    } catch (error) {
      runtime.close();
      throw error;
    }
    return runtime;
  }

  get inTransaction(): boolean {
    return this.#database.isTransaction;
  }

  execute(sql: string, parameters: SqlValue[] = [], options?: ExecuteOptions): ExecuteResult {
    return this.#prepare(sql, options).execute(parameters, options);
  }

  prepare(sql: string, options?: ExecuteOptions): PreparedStatement {
    return this.#prepare(sql, options);
  }

  /** `options`: of the call that prepares the statement to execute it at once; a failure to compile is reported as that call's. */
  #prepare(sql: string, options: ExecuteOptions | undefined): PreparedStatement {
    let statement: StatementSync;
    const startedAt = this.#now();
    const description = describeSql(sql, this.#tableNames);
    // SQLite is given `?N` for `$N`. Events and errors keep the statement as it was received.
    const positional = rewritePositionalParameters(sql);
    const switchesReadOnly = leadingKeyword(sql) === "PRAGMA" && /\bquery_only\b/i.test(sql);
    try {
      if (this.#readOnly && switchesReadOnly) {
        throw new SandboxReadOnlyError("The runtime is read-only; that cannot be changed with PRAGMA query_only.");
      }
      if (positional.numbers[0] === 0) {
        throw new SandboxParameterError(`$0 is not a parameter: they are numbered from $1.\n  SQL: ${sql}`, { sql });
      }
      statement = this.#database.prepare(positional.sql);
      // Compiled first, so that a `?` that is an operator of another dialect is reported as that.
      if (positional.numbers.length > 0 && positional.questionMarks) {
        throw new SandboxParameterError(`The statement mixes $N and ? placeholders, which leaves open which parameter each ? takes. Use one style.\n  SQL: ${sql}`, { sql });
      }
    } catch (error) {
      const failure = this.#compileFailure(sql, error, positional.sql !== sql);
      this.#emit(sql, [], description, undefined, startedAt, failure, options?.context);
      throw failure;
    }
    const highestPlaceholder = positional.numbers.at(-1) ?? 0;
    const columns = statement.columns().map((column) => column.name);
    const returnsRows = columns.length > 0;
    const keyword = leadingKeyword(sql);
    const changesRows = WRITE_KEYWORD.test(sql);
    return {
      returnsRows,
      columns,
      execute: (parameters: SqlValue[] = [], call?: ExecuteOptions) =>
        this.#execute(statement, sql, keyword, description, returnsRows, changesRows, highestPlaceholder, parameters, { ...call, switchesReadOnly }),
    };
  }

  run(query: Query, options?: ExecuteOptions): ExecuteResult {
    const { sql, parameters } = compileQuery(query);
    return this.execute(sql, parameters, options);
  }

  begin(): void {
    this.execute("BEGIN");
  }

  commit(): void {
    try {
      this.execute("COMMIT");
    } catch (error) {
      // A commit that could not be saved leaves the transaction open; end it.
      if (this.inTransaction) {
        this.execute("ROLLBACK");
      }
      throw error;
    }
  }

  rollback(): void {
    this.execute("ROLLBACK");
  }

  subscribe(listener: SqlEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  snapshot(only?: readonly string[]): DatabaseState {
    const collections: Record<string, Row[]> = {};
    const tables = new Map(this.schema.map((table) => [table.name, table]));
    const wanted = only === undefined ? undefined : new Set(only);
    for (const name of [...this.#collectionOrder, ...this.schema.map((table) => table.name)]) {
      if (Object.hasOwn(collections, name) || (wanted !== undefined && !wanted.has(name))) {
        continue;
      }
      const table = tables.get(name);
      collections[name] = table === undefined ? structuredClone(this.#otherCollections[name] as Row[]) : this.#rowsOf(table);
    }
    return { meta: { ...this.#meta }, collections };
  }

  /**
   * The tables as they are now, as table definitions, starting from a reading
   * of them (`from`), or from the tables as the runtime created them. A table
   * that SQL did not change keeps its definition; one that SQL made, or whose
   * columns it added or dropped, is described from SQLite's catalog
   * (sqlite-catalog.ts). Throws `UnkeptSchemaChangeError` for a change that
   * cannot be described. `schema`, and what is saved, are not changed by it.
   */
  readCatalog(from?: TableCatalog): TableCatalog {
    return readTableCatalog(this.#catalogQuery, from ?? (this.#createdCatalog as TableCatalog));
  }

  /**
   * The rows of the given tables, as `snapshot` gives those of the schema's:
   * for tables as `readCatalog` describes them. Collections that are not
   * tables are carried as they were loaded.
   */
  stateOf(tables: readonly TableSchema[]): DatabaseState {
    const byName = new Map(tables.map((table) => [table.name, table]));
    const collections: Record<string, Row[]> = {};
    for (const name of [...this.#collectionOrder, ...tables.map((table) => table.name)]) {
      const table = byName.get(name);
      if (Object.hasOwn(collections, name) || (table === undefined && !Object.hasOwn(this.#otherCollections, name))) {
        continue;
      }
      collections[name] = table === undefined ? structuredClone(this.#otherCollections[name] as Row[]) : this.#rowsOf(table);
    }
    return { meta: { ...this.#meta }, collections };
  }

  readonly #catalogQuery: CatalogQuery = (sql) => this.#database.prepare(sql).all() as Record<string, unknown>[];

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#changes?.close();
      this.#database.close();
    }
  }

  /** The rows of one table, as they appear in the fixture. */
  #rowsOf(table: TableSchema): Row[] {
    const rows = allRows(this.#internalStatement(compileQuery({ kind: "select", table: table.name }).sql), [], true);
    return rows.map((row) => Object.fromEntries(table.columns.map((column) => [keyOf(column), fromStored(column, row[column.name])])));
  }

  #create(): void {
    for (const table of this.schema) {
      this.#database.exec(createTableSql(table, [...this.schema]));
    }
    for (const table of this.schema) {
      for (const sql of createIndexSql(table)) {
        try {
          this.#database.exec(sql);
        } catch (cause) {
          throw new RuntimeSchemaError(`Cannot create an index of "${table.name}": ${(cause as Error).message}`, { cause });
        }
      }
    }
  }

  /** Inserts the fixture's rows. Foreign keys are checked once every row is in. */
  #load(state: DatabaseState): void {
    this.#meta = { ...state.meta };
    this.#collectionOrder = Object.keys(state.collections);
    const tableNames = new Set(this.schema.map((table) => table.name));
    this.#otherCollections = Object.fromEntries(Object.entries(state.collections).filter(([name]) => !tableNames.has(name)));

    this.#database.exec("BEGIN");
    try {
      this.#database.exec("PRAGMA defer_foreign_keys = ON");
      for (const table of this.schema) {
        const columns = new Map(table.columns.map((column) => [keyOf(column), column]));
        (state.collections[table.name] ?? []).forEach((row, index) => {
          try {
            const values: Record<string, SqlValue> = {};
            for (const [key, value] of Object.entries(row)) {
              const column = columns.get(key);
              if (column === undefined) {
                throw new TypeError(`it has the field "${key}", which is not a column of the table (columns: ${[...columns.keys()].join(", ")}).`);
              }
              values[column.name] = toStored(column, value);
            }
            const { sql, parameters } = compileQuery({ kind: "insert", table: table.name, values });
            this.#internalStatement(sql).run(...parameters.map(bind));
          } catch (cause) {
            throw new RuntimeSchemaError(`Cannot load row ${index + 1} of "${table.name}": ${(cause as Error).message}`, { cause });
          }
        });
      }
      try {
        this.#database.exec("COMMIT");
      } catch (cause) {
        throw new RuntimeSchemaError(`Cannot load the fixture: a row refers to a row that does not exist (${(cause as Error).message}).`, { cause });
      }
    } catch (error) {
      if (this.#database.isTransaction) {
        this.#database.exec("ROLLBACK");
      }
      throw error;
    }
    this.#savedAt = this.#totalChanges();
  }

  #internalStatement(sql: string): StatementSync {
    let statement = this.#internal.get(sql);
    if (statement === undefined) {
      statement = this.#database.prepare(sql);
      this.#internal.set(sql, statement);
    }
    return statement;
  }

  #totalChanges(): number {
    return Number((this.#internalStatement("SELECT total_changes() AS n").get() as { n: number | bigint }).n);
  }

  /**
   * Saves what differs from the stored state: the tables whose rows changed,
   * or the complete state when those cannot be told. Called just before a
   * commit, so what it saved counts only once `#settle` is told that the
   * commit happened.
   */
  #save(): void {
    const total = this.#totalChanges();
    if (this.persistence !== "json" || total === this.#savedAt) {
      return;
    }
    const storage = this.#storage as SnapshotStorage;
    const startedAt = this.#now();
    const changed = this.#completeSaveDue ? undefined : this.#changes?.changed();
    let extractedAt = startedAt;
    try {
      if (changed === undefined || storage.saveTablesSync === undefined) {
        const state = this.snapshot();
        extractedAt = this.#now();
        storage.saveSync(state);
      } else if (changed.length > 0) {
        const tables = new Map(this.schema.map((table) => [table.name, table]));
        const rows = Object.fromEntries(changed.map((name) => [name, this.#rowsOf(tables.get(name) as TableSchema)]));
        extractedAt = this.#now();
        storage.saveTablesSync(rows);
      }
    } finally {
      this.#saveMs += this.#now() - startedAt;
    }
    this.#savedAt = total;
    this.#unsettled = { tables: changed ?? this.#tableNames, complete: changed === undefined };
    if (this.#onSave !== undefined && (changed === undefined || changed.length > 0)) {
      try {
        this.#onSave({
          kind: changed === undefined ? "complete" : "tables",
          tables: [...(changed ?? this.#tableNames)],
          extractionMs: Math.max(0, extractedAt - startedAt),
          storageMs: Math.max(0, this.#now() - extractedAt),
        });
      } catch {
        // A failing listener must not change the outcome of the commit.
      }
    }
  }

  /** The commit that the last save was made for has happened: later changes are measured from here. */
  #settle(): void {
    const saved = this.#unsettled;
    if (saved === undefined) {
      return;
    }
    this.#unsettled = undefined;
    this.#changes?.settle(saved.tables);
    if (saved.complete) {
      this.#completeSaveDue = false;
    }
  }

  /**
   * The transaction was rolled back. If a save had been made for its commit,
   * which then failed, the storage holds rows that the database no longer
   * has: the complete state is saved again, now or with the next commit.
   */
  #rolledBack(): void {
    this.#savedAt = this.#totalChanges();
    if (this.#unsettled === undefined) {
      return;
    }
    this.#unsettled = undefined;
    this.#completeSaveDue = true;
    this.#savedAt = -1;
    try {
      this.#save();
      this.#settle();
    } catch {
      // Left for the next commit, which saves the complete state whatever it changed.
    }
  }

  #execute(
    statement: StatementSync,
    sql: string,
    keyword: string,
    description: SqlDescription,
    returnsRows: boolean,
    changesRows: boolean,
    /** The highest N of the statement's `$N` placeholders; `0` when it has none. */
    highestPlaceholder: number,
    parameters: SqlValue[],
    /** What this one call asks for; `switchesReadOnly`: the statement is a `PRAGMA query_only`. */
    call: ExecuteOptions & { switchesReadOnly: boolean },
  ): ExecuteResult {
    const startedAt = this.#now();
    this.#saveMs = 0;
    // Anything that is not a plain query may change the database.
    const writes = !returnsRows || changesRows;
    const { maxRows } = call;
    const step = (): ExecuteResult => {
      const bound = parameters.map(bind);
      if (returnsRows) {
        if (maxRows !== undefined && !changesRows) {
          const { rows, more } = firstRows(statement, bound, maxRows);
          return { rows: rows.map((row) => ({ ...row })), affectedRows: 0, ...(more && { truncated: true as const }) };
        }
        const rows = allRows(statement, bound, !changesRows).map((row) => ({ ...row }));
        const affectedRows = changesRows ? rows.length : 0;
        // A statement that writes is carried out whole; only what it returns is cut.
        return maxRows !== undefined && rows.length > maxRows ? { rows: rows.slice(0, maxRows), affectedRows, truncated: true } : { rows, affectedRows };
      }
      const { changes, lastInsertRowid } = statement.run(...bound);
      // For other statements SQLite still reports the count of the previous write.
      return changesRows ? { rows: [], affectedRows: Number(changes), lastInsertId: lastInsertRowid } : { rows: [], affectedRows: 0 };
    };

    // A call that must change nothing: SQLite refuses whatever would, for as long as the call lasts. The runtime is
    // synchronous, so nothing else runs meanwhile; a transaction that is open stays as it is.
    const readOnlyCall = call.readOnly === true && !this.#readOnly;
    if (readOnlyCall) {
      this.#database.exec("PRAGMA query_only = ON");
    }
    try {
      if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows < 0)) {
        throw new RangeError("maxRows must be a whole number, 0 or more.");
      }
      if (call.readOnly === true && call.switchesReadOnly) {
        throw new SandboxReadOnlyError("The call is read-only; that cannot be changed with PRAGMA query_only.");
      }
      // SQLite would bind NULL to a placeholder that has no parameter, and says only "column index out of range" for a parameter too many.
      if (highestPlaceholder > 0 && parameters.length !== highestPlaceholder) {
        throw new SandboxParameterError(`${placeholderMismatch(highestPlaceholder, parameters.length)} $N is bound to the Nth parameter.\n  SQL: ${sql}`, { sql });
      }
      let result: ExecuteResult;
      const saving = this.persistence === "json";
      if (saving && (keyword === "COMMIT" || keyword === "END") && this.inTransaction) {
        // Save first: if the snapshot cannot be saved, the transaction stays open for the caller to roll back.
        this.#save();
        result = step();
        this.#settle();
      } else if (saving && writes && !this.inTransaction && !UNWRAPPED.has(keyword)) {
        // A statement outside a transaction commits by itself; give it the same save-then-commit order.
        this.#database.exec("BEGIN");
        try {
          result = step();
          this.#save();
          this.#database.exec("COMMIT");
          this.#settle();
        } catch (error) {
          if (this.inTransaction) {
            this.#database.exec("ROLLBACK");
          }
          this.#rolledBack();
          throw error;
        }
      } else {
        result = step();
        if (!this.inTransaction) {
          if (keyword === "ROLLBACK") {
            // The database is back at the last commit, which was saved.
            this.#rolledBack();
          } else {
            // A commit that did not arrive as COMMIT, such as releasing an outermost savepoint.
            this.#save();
            this.#settle();
          }
        }
      }
      this.#emit(sql, parameters, description, { returned: returnsRows ? result.rows : undefined, affected: result.affectedRows }, startedAt, undefined, call.context);
      return result;
    } catch (error) {
      const failure = this.#readOnlyFailure(error, readOnlyCall);
      this.#emit(sql, parameters, description, undefined, startedAt, failure, call.context);
      throw failure;
    } finally {
      if (readOnlyCall) {
        this.#database.exec("PRAGMA query_only = OFF");
      }
    }
  }

  /** SQLite's "attempt to write a readonly database", said in the sandbox's terms. `call`: it is this one call that is read-only. */
  #readOnlyFailure(error: unknown, call: boolean): unknown {
    return (this.#readOnly || call) && (error as { errcode?: number }).errcode === SQLITE_READONLY
      ? new SandboxReadOnlyError(`${call ? "The call" : "The runtime"} is read-only: the statement would change data or schema.`, { cause: error })
      : error;
  }

  /** `rewritten` says that SQLite was given `?N` for the statement's `$N` placeholders. */
  #compileFailure(sql: string, error: unknown, rewritten: boolean): unknown {
    const { errcode, message } = error as { errcode?: number; message: string };
    if (errcode !== SQLITE_ERROR) {
      return error;
    }
    // SQLite's message quotes what it was given, which the SQL below does not show.
    const spelling = rewritten && message.includes("?") ? " The statement's $N placeholders are given to SQLite as ?N." : "";
    const why = /no such (table|column)/.test(message)
      ? "The sandbox's SQLite schema, which is created from the imported entities, has no such table or column."
      : "The sandbox runs SQL on embedded SQLite and does not translate the syntax or functions of other databases.";
    return new SandboxDialectUnsupportedError(`SQLite cannot run this statement: ${message}.${spelling} ${why}\n  SQL: ${sql}`, { cause: error, sql });
  }

  /** Reports one statement. `counts` is absent when the statement failed. */
  #emit(
    sql: string,
    parameters: unknown[],
    description: SqlDescription,
    counts: { returned: Row[] | undefined; affected: number } | undefined,
    startedAt: number,
    error?: unknown,
    /** What the call says the statement runs for; without it, what the runtime says. */
    said?: SqlEventContext,
  ): void {
    if (this.#listeners.size === 0) {
      return;
    }
    const changesData = description.operation === "INSERT" || description.operation === "UPDATE" || description.operation === "DELETE";
    const event: SqlEvent = {
      sql,
      parameters: [...parameters],
      ...description,
      rows: changesData ? (counts?.affected ?? 0) : (counts?.returned?.length ?? 0),
      localExecutionMs: Math.max(0, this.#now() - startedAt),
    };
    if (this.#saveMs > 0) {
      event.snapshotSaveMs = this.#saveMs;
    }
    if (counts?.returned !== undefined) {
      event.returnedRows = counts.returned.length;
      if (this.#previewRows > 0 && counts.returned.length > 0) {
        event.resultPreview = counts.returned.slice(0, this.#previewRows).map((row) => ({ ...row }));
      }
    }
    if (changesData) {
      event.affectedRows = counts?.affected ?? 0;
    }
    let context: SqlEventContext | undefined = said;
    try {
      context ??= this.#context?.();
    } catch {
      // Not knowing the request must not change the outcome of the statement.
    }
    if (context !== undefined) {
      event.requestId = context.requestId;
      if (context.sequence !== undefined) {
        event.sequence = context.sequence;
      }
    }
    if (error !== undefined) {
      event.errorCode =
        error instanceof SandboxDialectUnsupportedError
          ? "SANDBOX_DIALECT_UNSUPPORTED"
          : error instanceof SandboxLimitError
            ? "SANDBOX_SIZE_LIMIT"
            : error instanceof SandboxReadOnlyError
              ? "SANDBOX_READ_ONLY"
              : error instanceof SandboxParameterError
                ? "SANDBOX_PARAMETER"
                : "SQL_ERROR";
      event.errorMessage = error instanceof Error ? error.message : String(error);
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener({ ...event });
      } catch {
        // A failing listener must not change the outcome of the statement.
      }
    }
  }
}
