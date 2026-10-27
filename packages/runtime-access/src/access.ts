import type { Row } from "../../core/src/index.ts";
import type { ColumnType, EnumType, PersistenceMode, SqlOperation, TableSchema } from "../../runtime/src/index.ts";
import type { DatabaseFormat, OwnerKind } from "../../storage-json/src/index.ts";

/*
 * Access to a runtime that someone has open (D-042): what Local DB Studio
 * needs of it, and no more. There is one such access per runtime, in the
 * process that owns the runtime. Whoever else wants to look into the
 * database, or change it, asks that process (`control-server.ts`,
 * `control-client.ts`, and `attached-access.ts`, which finds the process
 * again after a restart) and never opens the database a second time.
 *
 * Everything here is data that goes through JSON as it is: a request, a
 * result, an error with a code. Nothing takes SQL fragments from a caller
 * but the console (`sql`), and that takes whole statements, which the
 * runtime carries out; rows are browsed and changed by table, column, and
 * value.
 */

export const ACCESS_PROTOCOL = 1;

/** What one request may ask for, and one answer hold. */
export interface AccessLimits {
  /** Rows of a page of a table: the most, and how many when none are asked for. */
  maxPageRows: number;
  defaultPageRows: number;
  /** Rows one statement of the console returns: the most, and how many when none are asked for. */
  maxResultRows: number;
  defaultResultRows: number;
  /** Statements in one request to the console. */
  maxStatements: number;
  /** Characters of SQL in one request to the console. */
  maxSqlLength: number;
  /** Characters of one value in a page or a result; a longer one is cut, and marked. */
  maxCellLength: number;
  /** Characters of one value of a row that is read to be edited; a longer one is left out, and named. */
  maxEditLength: number;
  /** Bytes of one request to the control server. */
  maxRequestBytes: number;
  /** Bytes of one answer, as JSON: of a page, of a row that is read to be edited, of the results of a request to the console. */
  maxResponseBytes: number;
  /** SQL events that are kept for whoever asks later. */
  maxEvents: number;
  /** Bytes, as JSON, of a snapshot of tables (`snapshot`): their definitions and, when asked for, all their rows. */
  maxSnapshotBytes: number;
}

export const DEFAULT_ACCESS_LIMITS: Readonly<AccessLimits> = Object.freeze({
  maxPageRows: 500,
  defaultPageRows: 50,
  maxResultRows: 1000,
  defaultResultRows: 200,
  maxStatements: 50,
  maxSqlLength: 100_000,
  maxCellLength: 2_000,
  maxEditLength: 200_000,
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 8_388_608,
  maxEvents: 200,
  maxSnapshotBytes: 33_554_432,
});

export type AccessErrorCode =
  /** The request does not say what it has to say, or says what cannot be. */
  | "INVALID_REQUEST"
  /** A table, a column, or a row that is not there. */
  | "NOT_FOUND"
  /** Nothing can be changed through this access. */
  | "READ_ONLY"
  /** The application has a transaction open on the runtime: nothing of another's is put into it. */
  | "BUSY"
  /** More than a request may ask for. */
  | "LIMIT_EXCEEDED"
  /** A statement the console does not carry out. */
  | "UNSUPPORTED_STATEMENT"
  /** A value that is none of its column's. */
  | "INVALID_VALUE"
  /** A constraint of the schema would not hold. */
  | "CONSTRAINT"
  /** The statement failed. */
  | "SQL_ERROR"
  /** What was changed could not be written to the database; it was taken back. */
  | "PERSISTENCE"
  /** The request carries no token, or not the owner's. */
  | "UNAUTHORIZED"
  /** The process that owns the runtime cannot be reached. */
  | "OWNER_UNREACHABLE"
  /** The runtime has another owner than the request was made for. */
  | "OWNER_CHANGED"
  /** The request was sent and no answer came: whether it was carried out is not known. */
  | "OUTCOME_UNKNOWN"
  | "INTERNAL";

const STATUS: Record<AccessErrorCode, number> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  READ_ONLY: 403,
  BUSY: 409,
  LIMIT_EXCEEDED: 413,
  UNSUPPORTED_STATEMENT: 400,
  INVALID_VALUE: 400,
  CONSTRAINT: 409,
  SQL_ERROR: 400,
  PERSISTENCE: 500,
  UNAUTHORIZED: 401,
  OWNER_UNREACHABLE: 503,
  OWNER_CHANGED: 409,
  OUTCOME_UNKNOWN: 504,
  INTERNAL: 500,
};

export function isAccessErrorCode(code: unknown): code is AccessErrorCode {
  return typeof code === "string" && Object.hasOwn(STATUS, code);
}

export class AccessError extends Error {
  readonly code: AccessErrorCode;

  constructor(code: AccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AccessError";
    this.code = code;
  }

  /** The HTTP status an answer with this error has. */
  get status(): number {
    return STATUS[this.code] ?? 500;
  }

  toJSON(): { code: AccessErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

/** Who answers, and what can be done there. */
export interface AccessInfo {
  protocol: typeof ACCESS_PROTOCOL;
  /** The owner's name for this one time it has the database open; another run has another. */
  instance: string;
  pid: number;
  kind: OwnerKind;
  /** The database, by its canonical path. */
  database: string;
  format: DatabaseFormat;
  /** Whether what is committed is written to the database, or kept in the owner's memory. */
  persistence: PersistenceMode;
  /** Why nothing can be changed through this access; absent when it can. */
  readOnly?: string;
  tables: number;
  limits: AccessLimits;
}

export interface ColumnInfo {
  name: string;
  /** How the runtime stores it. */
  type: ColumnType;
  /** As its source declared it, when that is known. */
  declaredType?: string;
  /** What it is in the database the schema describes, in words. */
  canonicalType?: string;
  nullable: boolean;
  primaryKey: boolean;
  /**
   * Filled when a row is written without it: by the runtime (`increment`, `uuid`, ...), or, by `insert` of the access,
   * with the time of the insert (`insert time`), for a column that the application's ORM fills and the database does not (D-047).
   */
  generated?: string;
  /** What a row gets that is written without it: a constant, or what the schema says is computed. */
  default?: unknown;
  defaultExpression?: string;
  /** The only values it takes, when the schema says them. */
  enum?: string[];
  references?: { table: string; column: string };
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  /** The columns a row is found by; none when the table has no primary key. */
  primaryKey: string[];
  rows: number;
}

export interface SchemaInfo {
  tables: TableInfo[];
}

export type FilterOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "null" | "notnull";

export interface RowFilter {
  column: string;
  op: FilterOperator;
  /** Not given for `null` and `notnull`. */
  value?: unknown;
}

export interface BrowseRequest {
  table: string;
  limit?: number;
  offset?: number;
  orderBy?: { column: string; direction: "asc" | "desc" }[];
  /** All of them have to hold. */
  filters?: RowFilter[];
}

/** Rows as lists of values, in the order of `columns`. `cut` names the values that were too long to give whole: row, then column. */
export interface RowPage {
  columns: string[];
  rows: unknown[][];
  cut: [row: number, column: number][];
}

export interface BrowseResult extends RowPage {
  table: string;
  /** Rows that match, of which these are some. */
  total: number;
  limit: number;
  offset: number;
}

/** The values of a row's primary key, by column. */
export type RowKey = Record<string, unknown>;

export interface RowResult {
  table: string;
  row: Record<string, unknown>;
  /** Columns whose value is too long to be read for editing: they are not in `row`. */
  tooLong: string[];
}

export interface ChangeResult {
  affectedRows: number;
  /** Of an inserted row whose key the runtime numbers. */
  lastInsertId?: number | string;
}

export interface SqlRequest {
  sql: string;
  /** `read`: every statement must change nothing. `write`: SELECT, INSERT, UPDATE, and DELETE, all in one transaction. */
  mode: "read" | "write";
  /** Rows to return per statement. */
  maxRows?: number;
}

export interface StatementResult extends RowPage {
  sql: string;
  operation: SqlOperation;
  /** Rows the statement returned, of which `rows` holds the first. */
  truncated: boolean;
  affectedRows: number;
  localExecutionMs: number;
}

export interface SqlResult {
  /** One per statement that was carried out, in order. */
  results: StatementResult[];
  /** The statement that failed, by its place among the statements; nothing after it was carried out. */
  error?: { statement: number; sql: string; code: AccessErrorCode; message: string };
  /** In `write` mode: a statement failed, and what the ones before it changed was taken back. */
  rolledBack?: true;
}

export interface AccessEvent {
  /** Its place among the events of this runtime's access, from 1. */
  seq: number;
  /** When it was carried out. */
  at: string;
  sql: string;
  operation: SqlOperation;
  tables?: string[];
  rows: number;
  localExecutionMs: number;
  requestId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface EventsResult {
  events: AccessEvent[];
  /** The `seq` of the newest event there is; give it as `after` to get what comes later. */
  last: number;
}

/** Tables whose definitions, and rows when `rows` is set, are asked for whole: what an export is made from. */
export interface SnapshotRequest {
  /** By name; at least one, each once. */
  tables: string[];
  rows: boolean;
}

/**
 * The tables asked for as they are at one moment: their definitions as the
 * runtime has them (the canonical schema, D-036), the enumerated types their
 * columns take, and, when asked for, every row, whole, as fixture values.
 * Nothing is cut short: a snapshot that would be larger than an access gives
 * (`maxSnapshotBytes`) is refused as a whole.
 */
export interface SnapshotResult {
  /** In the order the runtime has the tables. */
  schema: { tables: TableSchema[]; types: { enums: EnumType[] } };
  /** By table; only when rows were asked for. */
  rows?: Record<string, Row[]>;
}

/** Tables whose rows are all to be deleted, their definitions kept. */
export interface ClearRequest {
  /** By name; at least one, each once. */
  tables: string[];
}

/** How many rows each table had, which are gone; all of them in one transaction. */
export interface ClearResult {
  /** In the order the runtime has the tables. */
  tables: { table: string; rows: number }[];
  rows: number;
}

/** What a request says beside what it asks. */
export interface RequestOptions {
  /**
   * The owner the request was made for (`AccessInfo.instance`): whoever asks
   * has seen that owner's data. Another owner carries nothing of it out
   * (`OWNER_CHANGED`), so that what was meant for one runtime never reaches
   * another, which a restart may have put in its place.
   */
  owner?: string;
}

/** What Studio asks of a runtime, whether the runtime is in this process or in another. */
export interface RuntimeAccess {
  info(options?: RequestOptions): Promise<AccessInfo>;
  schema(options?: RequestOptions): Promise<SchemaInfo>;
  browse(request: BrowseRequest, options?: RequestOptions): Promise<BrowseResult>;
  row(request: { table: string; key: RowKey }, options?: RequestOptions): Promise<RowResult>;
  insert(request: { table: string; values: Record<string, unknown> }, options?: RequestOptions): Promise<ChangeResult>;
  update(request: { table: string; key: RowKey; values: Record<string, unknown> }, options?: RequestOptions): Promise<ChangeResult>;
  delete(request: { table: string; key: RowKey }, options?: RequestOptions): Promise<ChangeResult>;
  sql(request: SqlRequest, options?: RequestOptions): Promise<SqlResult>;
  events(request?: { after?: number }, options?: RequestOptions): Promise<EventsResult>;
  /** Reads, and changes nothing. */
  snapshot(request: SnapshotRequest, options?: RequestOptions): Promise<SnapshotResult>;
  /** Deletes every row of the tables named, in one transaction; the tables, their definitions, and the numbering stay. */
  clear(request: ClearRequest, options?: RequestOptions): Promise<ClearResult>;
}

/** The operations of an access, by name: what the control server serves and the client asks for. */
export const ACCESS_OPERATIONS = ["info", "schema", "browse", "row", "insert", "update", "delete", "sql", "events", "snapshot", "clear"] as const;
export type AccessOperation = (typeof ACCESS_OPERATIONS)[number];
/** The operations that change the database. */
export const WRITE_OPERATIONS: ReadonlySet<AccessOperation> = new Set(["insert", "update", "delete", "clear"]);

export function isAccessOperation(name: unknown): name is AccessOperation {
  return typeof name === "string" && (ACCESS_OPERATIONS as readonly string[]).includes(name);
}

/** Whether a request may change the database: one of the operations that do, or a request to the console that is allowed to. */
export function changesData(operation: AccessOperation, request: unknown): boolean {
  return WRITE_OPERATIONS.has(operation) || (operation === "sql" && (request as { mode?: unknown } | null | undefined)?.mode === "write");
}

/**
 * Carries out one operation of an access, by its name. This is what every
 * way of asking an access from outside its process ends in: the control,
 * and Studio's own page. Neither has operations of its own.
 */
export function carryOut(access: RuntimeAccess, operation: AccessOperation, request: unknown, options?: RequestOptions): Promise<unknown> {
  switch (operation) {
    case "info":
      return access.info(options);
    case "schema":
      return access.schema(options);
    case "browse":
      return access.browse(request as BrowseRequest, options);
    case "row":
      return access.row(request as { table: string; key: RowKey }, options);
    case "insert":
      return access.insert(request as { table: string; values: Record<string, unknown> }, options);
    case "update":
      return access.update(request as { table: string; key: RowKey; values: Record<string, unknown> }, options);
    case "delete":
      return access.delete(request as { table: string; key: RowKey }, options);
    case "sql":
      return access.sql(request as SqlRequest, options);
    case "events":
      return access.events(request as { after?: number } | undefined, options);
    case "snapshot":
      return access.snapshot(request as SnapshotRequest, options);
    case "clear":
      return access.clear(request as ClearRequest, options);
  }
}

export const OWNER_CHANGED_MESSAGE = "The database is open in another process than the one this was asked of. Nothing was done. Look at the data as it is now before doing it again.";

/** Refuses a request that was made for another owner than `instance`. */
export function assertMadeFor(instance: string, options: RequestOptions | undefined): void {
  if (options?.owner !== undefined && options.owner !== instance) {
    throw new AccessError("OWNER_CHANGED", OWNER_CHANGED_MESSAGE);
  }
}
