import { SandboxLimitError } from "../../core/src/index.ts";
import { RuntimeSchemaError, SandboxDialectUnsupportedError, SandboxParameterError, SandboxReadOnlyError, describeSql, exactInteger, formatCanonicalType, fromStoredValue, leadingKeyword, toStoredValue } from "../../runtime/src/index.ts";
import type { ColumnSchema, Condition, ExecuteOptions, ExecuteResult, RelationalRuntime, SqlEvent, SqlEventContext, SqlValue, TableSchema } from "../../runtime/src/index.ts";
import { hasSql, splitStatements } from "../../sql-console/src/index.ts";
import type { DatabaseFormat, OwnerKind } from "../../storage-json/src/index.ts";
import { ACCESS_PROTOCOL, AccessError, DEFAULT_ACCESS_LIMITS, assertMadeFor } from "./access.ts";
import type {
  AccessEvent,
  AccessInfo,
  AccessLimits,
  BrowseRequest,
  BrowseResult,
  ChangeResult,
  ColumnInfo,
  EventsResult,
  FilterOperator,
  RequestOptions,
  RowFilter,
  RowKey,
  RowPage,
  RowResult,
  RuntimeAccess,
  SchemaInfo,
  SqlRequest,
  SqlResult,
  StatementResult,
} from "./access.ts";

/** Who an access is of: the owner's record says the same of it. */
export interface AccessIdentity {
  instance: string;
  pid?: number;
  kind: OwnerKind;
  /** The database, by its canonical path. */
  database: string;
  format: DatabaseFormat;
}

export interface LocalAccessOptions {
  runtime: RelationalRuntime;
  identity: AccessIdentity;
  /** Why nothing may be changed through this access, when that is so. A single-file database is never changed through one. */
  readOnly?: string;
  limits?: Partial<AccessLimits>;
  /** The time, for the events. */
  now?: () => Date;
}

/** What marks a statement as Studio's in the events of a runtime that an application uses too. */
export const STUDIO_REQUEST_ID = "studio";

export const SINGLE_FILE_READ_ONLY = "A single-file database is not changed through Studio: convert it into a database directory to change it.";

const COMPARISONS: Record<Exclude<FilterOperator, "contains" | "null" | "notnull">, Condition["op"]> = { eq: "eq", neq: "neq", gt: "gt", gte: "gte", lt: "lt", lte: "lte" };
/** Statements the console carries out. A statement behind WITH is one of these, and SQLite says which. */
const CARRIED_OUT = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "VALUES"]);
const TRANSACTION_CONTROL = new Set(["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"]);
/** The low byte of SQLite's result code when a constraint failed. */
const SQLITE_CONSTRAINT = 19;

/**
 * Columns that the application's ORM fills with the time a row is written,
 * and that have no default in the database (D-047): the TypeORM integration
 * marks them with their decorator as `declaredType` (`tableSchemas`). A row
 * added through the access without a value for such a column gets the time of
 * the insert, as the application would give it. No other column is filled:
 * a column whose meaning the schema does not say is left to be given.
 */
const FILLED_WITH_INSERT_TIME: ReadonlySet<string> = new Set(["@CreateDateColumn", "@UpdateDateColumn"]);

/** How `ColumnInfo.generated` names what the access fills in such a column. */
export const INSERT_TIME = "insert time";

/** Whether the access fills a column with the time of the insert: one the ORM fills, that holds a time or a day. */
function filledWithInsertTime(column: ColumnSchema): boolean {
  return column.declaredType !== undefined && FILLED_WITH_INSERT_TIME.has(column.declaredType) && (column.type === "datetime" || column.type === "date");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AccessError("INVALID_REQUEST", `"${name}" must be a whole number, 0 or more.`);
  }
  return value;
}

/** In words, for a message. */
function shown(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** What a value takes of an answer: the bytes of its JSON text. */
function weight(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Access to a runtime in this process: the one implementation of what
 * Studio does to a database. Everything is carried out by the runtime that
 * is given, which stays whoever's it is.
 */
export class LocalRuntimeAccess implements RuntimeAccess {
  readonly #runtime: RelationalRuntime;
  readonly #identity: AccessIdentity;
  readonly #readOnly: string | undefined;
  readonly #limits: AccessLimits;
  readonly #now: () => Date;
  readonly #events: AccessEvent[] = [];
  #seq = 0;
  readonly #unsubscribe: () => void;

  constructor(options: LocalAccessOptions) {
    this.#runtime = options.runtime;
    this.#identity = options.identity;
    this.#readOnly = options.readOnly ?? (options.identity.format === "file" ? SINGLE_FILE_READ_ONLY : undefined);
    this.#limits = { ...DEFAULT_ACCESS_LIMITS, ...options.limits };
    this.#now = options.now ?? (() => new Date());
    this.#unsubscribe = this.#runtime.subscribe((event) => this.#record(event));
  }

  /** Stops listening to the runtime. The runtime itself is not this access's to close. */
  close(): void {
    this.#unsubscribe();
  }

  // --- what every operation rests on -----------------------------------------------------------------

  /** A request that was made for another owner is not this runtime's to carry out. Looked at before anything else. */
  #for(options: RequestOptions | undefined): void {
    assertMadeFor(this.#identity.instance, options);
  }

  #record(event: SqlEvent): void {
    this.#seq += 1;
    // What a statement was given and what it returned are not kept: the events say what ran, not what is in the database.
    this.#events.push({
      seq: this.#seq,
      at: this.#now().toISOString(),
      sql: event.sql.slice(0, this.#limits.maxCellLength),
      operation: event.operation,
      ...(event.tables !== undefined && { tables: [...event.tables] }),
      rows: event.rows,
      localExecutionMs: event.localExecutionMs,
      ...(event.requestId !== undefined && { requestId: event.requestId }),
      ...(event.errorCode !== undefined && { errorCode: event.errorCode }),
      ...(event.errorMessage !== undefined && { errorMessage: event.errorMessage.slice(0, this.#limits.maxCellLength) }),
    });
    if (this.#events.length > this.#limits.maxEvents) {
      this.#events.splice(0, this.#events.length - this.#limits.maxEvents);
    }
  }

  /** What the statements of one operation are said to run for: Studio, numbered within the operation. */
  #statements(): () => SqlEventContext {
    let sequence = 0;
    return () => ({ requestId: STUDIO_REQUEST_ID, sequence: (sequence += 1) });
  }

  /**
   * The runtime has one connection, which the application uses too. While the
   * application has a transaction open, a statement of Studio's would be part
   * of it: read what is not committed, or be committed or taken back with it.
   */
  #idle(): void {
    if (this.#runtime.inTransaction) {
      throw new AccessError("BUSY", "The application has a transaction open on the runtime. Nothing was done; try again.");
    }
  }

  #writable(): void {
    if (this.#readOnly !== undefined) {
      throw new AccessError("READ_ONLY", this.#readOnly);
    }
  }

  #table(name: unknown): TableSchema {
    const table = typeof name === "string" ? this.#runtime.schema.find((candidate) => candidate.name === name) : undefined;
    if (table === undefined) {
      throw new AccessError("NOT_FOUND", `There is no table ${shown(name)}.`);
    }
    return table;
  }

  #column(table: TableSchema, name: unknown): ColumnSchema {
    const column = typeof name === "string" ? table.columns.find((candidate) => candidate.name === name) : undefined;
    if (column === undefined) {
      throw new AccessError("NOT_FOUND", `Table "${table.name}" has no column ${shown(name)}.`);
    }
    return column;
  }

  #primaryKey(table: TableSchema): string[] {
    return table.primaryKey?.columns ?? table.columns.filter((column) => column.primary).map((column) => column.name);
  }

  /** A value as the runtime stores it in that column. */
  #stored(column: ColumnSchema, value: unknown): SqlValue {
    try {
      return toStoredValue(column, value);
    } catch (error) {
      throw new AccessError("INVALID_VALUE", error instanceof Error ? error.message : String(error), { cause: error });
    }
  }

  /** What a statement failed with, as an error of the access. `writes`: the statement was to change the database. */
  #failure(error: unknown, writes: boolean): AccessError {
    if (error instanceof AccessError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SandboxReadOnlyError) {
      return new AccessError("READ_ONLY", this.#readOnly ?? message, { cause: error });
    }
    if (error instanceof SandboxDialectUnsupportedError || error instanceof SandboxParameterError || error instanceof RuntimeSchemaError) {
      return new AccessError("SQL_ERROR", message, { cause: error });
    }
    const sqlite = error as { code?: unknown; errcode?: unknown };
    if (sqlite?.code === "ERR_SQLITE_ERROR") {
      return new AccessError(typeof sqlite.errcode === "number" && (sqlite.errcode & 0xff) === SQLITE_CONSTRAINT ? "CONSTRAINT" : "SQL_ERROR", message, { cause: error });
    }
    if (writes || error instanceof SandboxLimitError) {
      // Not SQLite's: the storage refused what was to be saved. The runtime has taken the change back.
      return new AccessError("PERSISTENCE", `The change could not be written to the database, and was taken back: ${message}`, { cause: error });
    }
    return new AccessError("INTERNAL", message, { cause: error });
  }

  /** One value of a page or a result, cut when it is too long. */
  #cell(value: unknown): { value: unknown; cut: boolean } {
    const most = this.#limits.maxCellLength;
    if (typeof value === "bigint") {
      return { value: exactInteger(value), cut: false };
    }
    if (value instanceof Uint8Array) {
      const hex = `\\x${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}`;
      return hex.length > most ? { value: hex.slice(0, most), cut: true } : { value: hex, cut: false };
    }
    if (typeof value === "string") {
      return value.length > most ? { value: value.slice(0, most), cut: true } : { value, cut: false };
    }
    if (typeof value === "object" && value !== null) {
      // A JSON value that is too long is given as the beginning of its text.
      const text = JSON.stringify(value);
      return text.length > most ? { value: text.slice(0, most), cut: true } : { value, cut: false };
    }
    return { value: value ?? null, cut: false };
  }

  #page(columns: string[], rows: unknown[][]): RowPage {
    const cut: [number, number][] = [];
    const given = rows.map((row, rowIndex) =>
      row.map((value, columnIndex) => {
        const cell = this.#cell(value);
        if (cell.cut) {
          cut.push([rowIndex, columnIndex]);
        }
        return cell.value;
      }),
    );
    return { columns, rows: given, cut };
  }

  #conditions(table: TableSchema, filters: RowFilter[] | undefined): Condition[] {
    if (filters === undefined) {
      return [];
    }
    if (!Array.isArray(filters)) {
      throw new AccessError("INVALID_REQUEST", '"filters" must be a list.');
    }
    return filters.map((filter): Condition => {
      const column = this.#column(table, filter?.column);
      const op = filter.op;
      if (op === "null") {
        return { column: column.name, op: "eq", value: null };
      }
      if (op === "notnull") {
        return { column: column.name, op: "neq", value: null };
      }
      if (op !== "contains" && !Object.hasOwn(COMPARISONS, op)) {
        throw new AccessError("INVALID_REQUEST", `${shown(op)} is no comparison; one of eq, neq, gt, gte, lt, lte, contains, null, notnull is.`);
      }
      if (filter.value === undefined || filter.value === null) {
        throw new AccessError("INVALID_REQUEST", `"${op}" needs a value to compare "${column.name}" with; "null" and "notnull" ask whether it has one.`);
      }
      if (op === "contains") {
        // The text itself: what LIKE would take for a wildcard is escaped.
        return { column: column.name, op: "like", value: `%${String(filter.value).replace(/[\\%_]/g, "\\$&")}%` };
      }
      return { column: column.name, op: COMPARISONS[op], value: this.#stored(column, filter.value) };
    });
  }

  /** The conditions that find the row with that key. */
  #key(table: TableSchema, key: RowKey): Condition[] {
    const columns = this.#primaryKey(table);
    if (columns.length === 0) {
      throw new AccessError("INVALID_REQUEST", `Table "${table.name}" has no primary key, so a row of it cannot be told from another: change it with SQL.`);
    }
    const given = isPlainObject(key) ? Object.keys(key) : [];
    if (given.length !== columns.length || columns.some((name) => !given.includes(name) || key[name] === undefined || key[name] === null)) {
      throw new AccessError("INVALID_REQUEST", `A row of "${table.name}" is found by ${columns.join(", ")}; the request gives ${given.length === 0 ? "nothing" : given.join(", ")}.`);
    }
    return columns.map((name) => ({ column: name, op: "eq", value: this.#stored(this.#column(table, name), key[name]) }));
  }

  #noRow(table: TableSchema, key: RowKey): AccessError {
    return new AccessError("NOT_FOUND", `Table "${table.name}" has no row with ${this.#primaryKey(table).map((name) => `${name} = ${shown(key[name])}`).join(", ")}.`);
  }

  #values(table: TableSchema, values: unknown): Record<string, SqlValue> {
    if (!isPlainObject(values)) {
      throw new AccessError("INVALID_REQUEST", '"values" must be an object of columns and their values.');
    }
    return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, this.#stored(this.#column(table, name), value)]));
  }

  // --- the operations ------------------------------------------------------------------------------------

  async info(options?: RequestOptions): Promise<AccessInfo> {
    this.#for(options);
    return {
      protocol: ACCESS_PROTOCOL,
      instance: this.#identity.instance,
      pid: this.#identity.pid ?? process.pid,
      kind: this.#identity.kind,
      database: this.#identity.database,
      format: this.#identity.format,
      persistence: this.#runtime.persistence,
      ...(this.#readOnly !== undefined && { readOnly: this.#readOnly }),
      tables: this.#runtime.schema.length,
      limits: { ...this.#limits },
    };
  }

  async schema(options?: RequestOptions): Promise<SchemaInfo> {
    this.#for(options);
    this.#idle();
    const next = this.#statements();
    return {
      tables: this.#runtime.schema.map((table) => ({
        name: table.name,
        columns: table.columns.map((column): ColumnInfo => {
          const generated = column.generated ?? (column.autoIncrement === true ? "increment" : filledWithInsertTime(column) ? INSERT_TIME : undefined);
          const computed = column.defaultExpression ?? column.defaultFunction;
          return {
            name: column.name,
            type: column.type,
            ...(column.declaredType !== undefined && { declaredType: column.declaredType }),
            ...(column.canonicalType !== undefined && { canonicalType: formatCanonicalType(column.canonicalType) }),
            nullable: column.nullable,
            primaryKey: column.primary,
            ...(generated !== undefined && { generated }),
            ...(column.default !== undefined && { default: column.default }),
            ...(computed !== undefined && { defaultExpression: computed }),
            ...(column.enum !== undefined && { enum: [...column.enum.values] }),
            ...(column.references !== undefined && { references: { table: column.references.table, column: column.references.column } }),
          };
        }),
        primaryKey: this.#primaryKey(table),
        rows: Number(this.#runtime.run({ kind: "count", table: table.name }, { readOnly: true, context: next() }).rows[0]?.count ?? 0),
      })),
    };
  }

  async browse(request: BrowseRequest, options?: RequestOptions): Promise<BrowseResult> {
    this.#for(options);
    this.#idle();
    const table = this.#table(request?.table);
    const limit = Math.min(count(request.limit, "limit") ?? this.#limits.defaultPageRows, this.#limits.maxPageRows);
    const offset = count(request.offset, "offset") ?? 0;
    const where = this.#conditions(table, request.filters);
    if (request.orderBy !== undefined && !Array.isArray(request.orderBy)) {
      throw new AccessError("INVALID_REQUEST", '"orderBy" must be a list.');
    }
    // Without an order of its own, a page is in the order of the table's key, so that the next page is the next rows.
    const orderBy = (request.orderBy ?? this.#primaryKey(table).map((column) => ({ column, direction: "asc" as const }))).map((entry) => {
      if (entry?.direction !== "asc" && entry?.direction !== "desc") {
        throw new AccessError("INVALID_REQUEST", `The direction of an order is "asc" or "desc", not ${shown(entry?.direction)}.`);
      }
      return { column: this.#column(table, entry.column).name, direction: entry.direction };
    });
    const next = this.#statements();
    let total: number;
    let found: ExecuteResult;
    try {
      total = Number(this.#runtime.run({ kind: "count", table: table.name, ...(where.length > 0 && { where }) }, { readOnly: true, context: next() }).rows[0]?.count ?? 0);
      found = this.#runtime.run({ kind: "select", table: table.name, ...(where.length > 0 && { where }), ...(orderBy.length > 0 && { orderBy }), limit, offset }, { readOnly: true, context: next() });
    } catch (error) {
      throw this.#failure(error, false);
    }
    const columns = table.columns.map((column) => column.name);
    // As the application has them, not as SQLite stores them.
    const rows = found.rows.map((row) => table.columns.map((column) => fromStoredValue(column, row[column.name])));
    const page: BrowseResult = { table: table.name, ...this.#page(columns, rows), total, limit, offset };
    const bytes = weight(page);
    if (bytes > this.#limits.maxResponseBytes) {
      throw new AccessError("LIMIT_EXCEEDED", `A page of ${page.rows.length} rows of "${table.name}" has ${bytes} bytes, and an answer may have ${this.#limits.maxResponseBytes}. Ask for fewer rows.`);
    }
    return page;
  }

  async row(request: { table: string; key: RowKey }, options?: RequestOptions): Promise<RowResult> {
    this.#for(options);
    this.#idle();
    const table = this.#table(request?.table);
    const where = this.#key(table, request.key);
    let found: ExecuteResult;
    try {
      found = this.#runtime.run({ kind: "select", table: table.name, where, limit: 1 }, { readOnly: true, context: this.#statements()() });
    } catch (error) {
      throw this.#failure(error, false);
    }
    const stored = found.rows[0];
    if (stored === undefined) {
      throw this.#noRow(table, request.key);
    }
    const row: Record<string, unknown> = {};
    const tooLong: string[] = [];
    // What the answer takes whichever values it holds: every column may have to be named as left out.
    let bytes = weight({ table: table.name, row: {}, tooLong: table.columns.map((column) => column.name) });
    for (const column of table.columns) {
      const value = fromStoredValue(column, stored[column.name]);
      const length = typeof value === "string" ? value.length : typeof value === "object" && value !== null ? JSON.stringify(value).length : 0;
      // The name, the value, and what stands between and after them.
      const takes = weight(column.name) + weight(value) + 2;
      if (length > this.#limits.maxEditLength || bytes + takes > this.#limits.maxResponseBytes) {
        tooLong.push(column.name);
      } else {
        row[column.name] = value;
        bytes += takes;
      }
    }
    return { table: table.name, row, tooLong };
  }

  async insert(request: { table: string; values: Record<string, unknown> }, options?: RequestOptions): Promise<ChangeResult> {
    this.#for(options);
    this.#writable();
    this.#idle();
    const table = this.#table(request?.table);
    const values = this.#values(table, request.values);
    // A value that was given, NULL included, is kept as it was given.
    // As a value of the application: an ISO date-time, or its day (UTC) for a column of days.
    const now = this.#now().toISOString();
    for (const column of table.columns) {
      if (filledWithInsertTime(column) && !Object.hasOwn(values, column.name)) {
        values[column.name] = this.#stored(column, column.type === "date" ? now.slice(0, 10) : now);
      }
    }
    let result: ExecuteResult;
    try {
      result = this.#runtime.run({ kind: "insert", table: table.name, values }, { context: this.#statements()() });
    } catch (error) {
      throw this.#failure(error, true);
    }
    // The number the runtime gave the row, when it is the runtime that numbers the table's rows.
    const key = this.#primaryKey(table);
    const numbered = key.length === 1 ? table.columns.find((column) => column.name === key[0] && (column.autoIncrement === true || column.generated === "increment")) : undefined;
    const lastInsertId = numbered !== undefined && values[numbered.name] === undefined && result.lastInsertId !== undefined ? result.lastInsertId : undefined;
    return { affectedRows: result.affectedRows, ...(lastInsertId !== undefined && { lastInsertId: typeof lastInsertId === "bigint" ? exactInteger(lastInsertId) : lastInsertId }) };
  }

  async update(request: { table: string; key: RowKey; values: Record<string, unknown> }, options?: RequestOptions): Promise<ChangeResult> {
    this.#for(options);
    this.#writable();
    this.#idle();
    const table = this.#table(request?.table);
    const where = this.#key(table, request.key);
    const set = this.#values(table, request.values);
    if (Object.keys(set).length === 0) {
      throw new AccessError("INVALID_REQUEST", "The change names no column to set.");
    }
    let result: ExecuteResult;
    try {
      result = this.#runtime.run({ kind: "update", table: table.name, set, where }, { context: this.#statements()() });
    } catch (error) {
      throw this.#failure(error, true);
    }
    if (result.affectedRows === 0) {
      throw this.#noRow(table, request.key);
    }
    return { affectedRows: result.affectedRows };
  }

  async delete(request: { table: string; key: RowKey }, options?: RequestOptions): Promise<ChangeResult> {
    this.#for(options);
    this.#writable();
    this.#idle();
    const table = this.#table(request?.table);
    const where = this.#key(table, request.key);
    let result: ExecuteResult;
    try {
      result = this.#runtime.run({ kind: "delete", table: table.name, where }, { context: this.#statements()() });
    } catch (error) {
      throw this.#failure(error, true);
    }
    if (result.affectedRows === 0) {
      throw this.#noRow(table, request.key);
    }
    return { affectedRows: result.affectedRows };
  }

  async sql(request: SqlRequest, options?: RequestOptions): Promise<SqlResult> {
    this.#for(options);
    if (typeof request?.sql !== "string") {
      throw new AccessError("INVALID_REQUEST", '"sql" must be text.');
    }
    if (request.mode !== "read" && request.mode !== "write") {
      throw new AccessError("INVALID_REQUEST", '"mode" must be "read" or "write".');
    }
    const maxRows = Math.min(count(request.maxRows, "maxRows") ?? this.#limits.defaultResultRows, this.#limits.maxResultRows);
    if (request.sql.length > this.#limits.maxSqlLength) {
      throw new AccessError("LIMIT_EXCEEDED", `A request may have ${this.#limits.maxSqlLength} characters of SQL; this one has ${request.sql.length}.`);
    }
    const split = splitStatements(request.sql);
    const statements = hasSql(split.rest) ? [...split.statements, split.rest.trim()] : split.statements;
    if (statements.length === 0) {
      throw new AccessError("INVALID_REQUEST", "The request has no statement.");
    }
    if (statements.length > this.#limits.maxStatements) {
      throw new AccessError("LIMIT_EXCEEDED", `A request may have ${this.#limits.maxStatements} statements; this one has ${statements.length}.`);
    }
    if (request.mode === "write") {
      this.#writable();
    }
    this.#idle();

    const failed = (index: number, error: AccessError): NonNullable<SqlResult["error"]> => ({ statement: index + 1, sql: statements[index] as string, code: error.code, message: error.message });
    // Every statement is looked at before any is carried out: a request is not carried out by halves because of a statement it should not have had.
    for (const [index, statement] of statements.entries()) {
      const keyword = leadingKeyword(statement);
      if (TRANSACTION_CONTROL.has(keyword)) {
        return { results: [], error: failed(index, new AccessError("UNSUPPORTED_STATEMENT", `${keyword} is not carried out here. A request is one transaction already: it is committed when every statement went well, and taken back when one did not.`)) };
      }
      if (!CARRIED_OUT.has(keyword)) {
        return {
          results: [],
          error: failed(index, new AccessError("UNSUPPORTED_STATEMENT", `${keyword === "" ? "This" : keyword} is not carried out here. The console carries out SELECT, INSERT, UPDATE, and DELETE. The tables are the application's: they are changed where it defines them.`)),
        };
      }
    }

    const next = this.#statements();
    const tables = this.#runtime.schema.map((table) => table.name);
    const results: StatementResult[] = [];
    // What the results take of the answer so far. A statement whose result does not fit is one that failed: in `write` mode before anything is committed.
    let bytes = 0;
    const carryOut = (statement: string, call: ExecuteOptions): void => {
      const startedAt = performance.now();
      const prepared = this.#runtime.prepare(statement, call);
      const result = prepared.execute([], call);
      const columns = [...prepared.columns];
      const given: StatementResult = {
        sql: statement,
        operation: describeSql(statement, tables).operation,
        ...this.#page(columns, result.rows.map((row) => columns.map((column) => row[column]))),
        truncated: result.truncated === true,
        affectedRows: result.affectedRows,
        localExecutionMs: Math.max(0, performance.now() - startedAt),
      };
      bytes += weight(given);
      if (bytes > this.#limits.maxResponseBytes) {
        throw new AccessError("LIMIT_EXCEEDED", `The results of this request have more than ${this.#limits.maxResponseBytes} bytes, which is what an answer may have. Ask for fewer rows.`);
      }
      results.push(given);
    };

    if (request.mode === "read") {
      for (const [index, statement] of statements.entries()) {
        try {
          carryOut(statement, { readOnly: true, maxRows, context: next() });
        } catch (error) {
          return { results, error: failed(index, this.#failure(error, false)) };
        }
      }
      return { results };
    }

    // One request, one transaction: what its statements change is committed together, or not at all.
    const rollback = (): void => {
      if (this.#runtime.inTransaction) {
        this.#runtime.execute("ROLLBACK", [], { context: next() });
      }
    };
    this.#runtime.execute("BEGIN", [], { context: next() });
    for (const [index, statement] of statements.entries()) {
      try {
        carryOut(statement, { maxRows, context: next() });
      } catch (error) {
        rollback();
        return { results, error: failed(index, this.#failure(error, false)), rolledBack: true };
      }
    }
    try {
      this.#runtime.execute("COMMIT", [], { context: next() });
    } catch (error) {
      // What could not be saved is not committed: the transaction is still open, and is taken back.
      rollback();
      return { results, error: failed(statements.length - 1, this.#failure(error, true)), rolledBack: true };
    }
    return { results };
  }

  async events(request: { after?: number } = {}, options?: RequestOptions): Promise<EventsResult> {
    this.#for(options);
    const after = count(request?.after, "after") ?? 0;
    return { events: this.#events.filter((event) => event.seq > after).map((event) => ({ ...event })), last: this.#seq };
  }
}
