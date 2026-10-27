import type { DatabaseState, Row } from "../../core/src/index.ts";
import type { CanonicalType } from "./canonical-type.ts";
import type { Query } from "./query-ir.ts";

/*
 * The relational runtime: a disposable local relational database that is
 * created from a schema and a fixture, executes SQL, and can write its state
 * back as a fixture. ORM integrations translate into it; they do not
 * implement data access themselves.
 *
 * The JSON file is the portable fixture and snapshot. It is not the engine.
 */

/**
 * How a column's values are held in the runtime and in the fixture. This is
 * the storage type. What the values are to an application, and under which
 * name its ORM declared the column, is not known here: an ORM integration
 * maps its own types to these (see docs/COMPATIBILITY.md).
 *
 * - `integer`, `real`, `text`: stored as given. SQLite holds 64-bit
 *   integers; one that a JavaScript number cannot hold exactly is a string of
 *   its digits in results and in the fixture.
 * - `numeric`: decimals. SQLite has no exact decimal type; values are stored
 *   as floating point when they look like numbers.
 * - `boolean`: `true`/`false` in the fixture, `1`/`0` in the runtime.
 * - `datetime`: ISO 8601 text in the fixture, `YYYY-MM-DD HH:MM:SS.SSS` (UTC)
 *   text in the runtime, which is SQLite's own date-time format.
 * - `date`: `YYYY-MM-DD` text in both.
 * - `json`: any JSON value in the fixture, its JSON text in the runtime.
 * - `binary`: bytes. Base64 text in the fixture, a BLOB in the runtime.
 * - `any`: no declared type; scalars are stored as given.
 */
export type ColumnType = "integer" | "real" | "numeric" | "text" | "boolean" | "datetime" | "date" | "json" | "binary" | "any";

/**
 * Where something of a schema was written: which source, which file of it,
 * and which statement. A position means nothing once its file has changed,
 * so it carries the file's SHA-256.
 */
export interface SourcePosition {
  /** The collector that read the source, for example `postgresql-migrations`. */
  source: string;
  /** The file, relative to the source's directory, for example `0001_init.sql`. */
  file: string;
  sha256: string;
  /** 1-based number of the statement within the file. */
  statement: number;
  /** 1-based line of the statement. */
  line: number;
}

/**
 * The identity of a schema object: the statement that created it, and the
 * name it was created with. Two objects with the same origin are the same
 * object, whatever they are called now. It is provenance, not a property:
 * two definitions never differ because their origins do.
 */
export interface SchemaOrigin extends SourcePosition {
  /** The name the object was created with. */
  name: string;
  /**
   * The source did not name the object, and `name` is the one its database
   * gave it (for example PostgreSQL's `<table>_pkey`), as the collector
   * worked it out.
   */
  generatedName?: boolean;
}

/** A rename that the source states explicitly (for example `ALTER TABLE ... RENAME`). */
export interface SchemaRename {
  from: string;
  to: string;
  at: SourcePosition;
}

/** Where a schema object comes from, when its source says so. Information only (see `SchemaOrigin`). */
export interface ObjectProvenance {
  origin?: SchemaOrigin;
  /** Explicit renames since the object was created, oldest first. */
  renames?: SchemaRename[];
}

/**
 * A name in the text of an expression that a rename can reach. A schema
 * holds an expression (a check, an index's expression or condition, a
 * default) as the text its source wrote. The source's database holds what
 * the text meant: it follows a rename by itself, and the text does not. A
 * schema that knows what a text names therefore says, name by name, what
 * the thing is called now.
 *
 * A name with a `now` is stale: the text is no longer what its database has
 * there, and is not to be written into a database again. Where another
 * thing has taken the name, the text would be of that thing.
 *
 * A list of names says all that its text names of the columns of its table,
 * of the table itself, of enumerated types, and of values of them. A
 * function, or a type that is not enumerated, is listed when it was renamed
 * since: a schema keeps neither.
 *
 * This is information about the text, like provenance: two definitions
 * never differ because of it alone.
 */
export interface ExpressionName {
  /** What the name is of: a column of the table, the table itself, a type, a value of an enumerated type, or a function. */
  kind: "column" | "table" | "type" | "value" | "function";
  /** The name as the text has it. */
  name: string;
  /** What that thing is called now, when that is something else. */
  now?: string;
  /** Of a value: the enumerated type it is a value of, as that type is called now. */
  type?: string;
}

/** Whether a constraint is checked at the end of a transaction instead of at each statement, and whether it starts out that way. Absent: it is not deferrable. */
export type Deferrable = "immediate" | "deferred";

export interface ColumnSchema extends ObjectProvenance {
  /** Column name in SQL. */
  name: string;
  /** Key of this column in fixture rows. Default: the column name. */
  key?: string;
  /** How the runtime stores the column's values. */
  type: ColumnType;
  /**
   * The column's type as the source of the schema declared it, as it was
   * written there (`integer`, `timestamp with time zone`, `varchar(20)`):
   * what the column is to the application. Information; `type` is how the
   * values are stored, and `canonicalType` is what the type is.
   */
  declaredType?: string;
  /**
   * What the type is, independent of its spelling (canonical-type.ts). Two
   * columns are of the same type when their canonical types are equal.
   * Absent when the source did not say (a schema written by hand, the
   * TypeORM integration).
   */
  canonicalType?: CanonicalType;
  /** The type as the source's dialect names it (`int4`, `varchar(20)`, `timestamptz`), when it is a database's. */
  sourceDialectType?: { dialect: string; type: string };
  nullable: boolean;
  primary: boolean;
  /** The database assigns the next integer when no value is given. Only for a single integer primary key. */
  autoIncrement?: boolean;
  /**
   * How values are generated when none is given, as the source of the schema
   * declared it: `increment` (the next integer), `uuid`, or another name.
   * This is kept as information. The runtime itself only generates values for
   * a column that is also marked `autoIncrement`.
   */
  generated?: string;
  /** Static default, as a fixture value. */
  default?: unknown;
  /**
   * A default the database computes when a row is written, by its SQL
   * standard name: the time of the write (`current_timestamp`, for a
   * `datetime` column) or its day (`current_date`, for a `date` column).
   * Enforced. Takes the place of `default`.
   */
  defaultFunction?: DefaultFunction;
  /**
   * The default as the source of the schema wrote it, for example `now()` or
   * `gen_random_uuid()`. Kept as information; only what `default` or
   * `defaultFunction` says is applied.
   */
  defaultExpression?: string;
  /** What `defaultExpression` names (see `ExpressionName`). Absent: the schema does not say. A default names no column. */
  defaultNames?: ExpressionName[];
  /** As `mayBeStale` of a check, for `defaultExpression`. */
  defaultMayBeStale?: boolean;
  /** The column holds the key of a row in another table. `name` is the constraint's name in the source. */
  references?: ColumnReference;
  /**
   * The enumerated type whose values the column takes. Enforced: another
   * value is refused. The type itself is the schema's
   * (`DatabaseSchema.types.enums`); `values` is resolved from it when the
   * schema is read, so that the runtime can create the table, and is never a
   * second definition of the type.
   */
  enum?: { name: string; values: string[] };
}

export type DefaultFunction = "current_timestamp" | "current_date";

/**
 * What a constraint or an index says in its source beyond what this schema
 * holds, clause by clause, as short text (`MATCH FULL`, `INCLUDE (b)`,
 * `WITH (fillfactor=70)`). The schema does not know what a clause means. It
 * keeps the clauses so that an object which has any is not taken for the one
 * without them, and is not written for another database as if it had none.
 */
export interface SourceClauses {
  sourceClauses?: string[];
}

export interface ColumnReference extends ObjectProvenance, SourceClauses {
  table: string;
  column: string;
  /** `CASCADE`, `SET NULL`, `SET DEFAULT`, `RESTRICT`, or `NO ACTION` (the default). */
  onDelete?: string;
  /** As `onDelete`, for a change of the referenced key. */
  onUpdate?: string;
  name?: string;
  /** Kept as information: the runtime checks every constraint at each statement. */
  deferrable?: Deferrable;
}

/**
 * The primary key as a constraint: its name and the order of its columns.
 * Optional: without it, the primary key is the columns marked `primary`, in
 * the table's order, and its name is not known. When it is given, its columns
 * are exactly the columns marked `primary`.
 */
export interface PrimaryKeyConstraint extends ObjectProvenance, SourceClauses {
  name?: string;
  columns: string[];
  /** Columns the key's index carries along without their being part of the key. Kept as information. */
  include?: string[];
  /** Kept as information (see `ColumnReference.deferrable`). */
  deferrable?: Deferrable;
}

/** A unique constraint over one or more columns. Enforced. */
export interface UniqueConstraint extends ObjectProvenance, SourceClauses {
  name?: string;
  columns: string[];
  /** Columns the constraint's index carries along without their being part of the key. Kept as information. */
  include?: string[];
  /** Kept as information (see `ColumnReference.deferrable`). */
  deferrable?: Deferrable;
  /** Two rows that hold NULL in the columns are the same to the constraint. Kept as information: locally several rows may hold NULL. */
  nullsNotDistinct?: boolean;
}

/**
 * A foreign key over several columns. One over a single column is that
 * column's `references`. Enforced when the referenced table exists.
 */
export interface ForeignKeyConstraint extends ObjectProvenance, SourceClauses {
  name?: string;
  columns: string[];
  references: { table: string; columns: string[] };
  onDelete?: string;
  onUpdate?: string;
  /** Kept as information (see `ColumnReference.deferrable`). */
  deferrable?: Deferrable;
}

/**
 * One key of an index, in the index's order: a column of the table, or an
 * expression as the source wrote it. Exactly one of the two.
 */
export interface IndexKey {
  column?: string;
  expression?: string;
  /** `desc`: from the largest value to the smallest. Ascending is said by saying nothing. */
  order?: "desc";
  /** Where NULLs stand, when that is not where the order puts them by itself (last when ascending, first when descending). */
  nulls?: "first" | "last";
  /** The operator class the key is indexed by, when the source names one (`text_pattern_ops`). A name of the source's dialect. */
  operatorClass?: string;
  /** The collation the key is ordered by, when the source names one. A name of the source's dialect. */
  collation?: string;
}

/**
 * An index. One over plain columns is created; one with `expressions` or a
 * `where` condition, which are SQL of the schema's source, is kept as
 * information and not created. A `unique` index that is created is enforced.
 * The order of `columns` is the index's order.
 *
 * `columns` and `expressions` say an index over columns alone, or over
 * expressions alone, each key in ascending order. Whatever they do not say
 * is in `keys`: the keys in their order when columns and expressions are
 * mixed, and a key's order, place of NULLs, operator class, and collation.
 * When `keys` is given it is the index's keys, and `columns` and
 * `expressions` are its columns and its expressions in that order. An index
 * with both columns and expressions and without `keys` does not say in which
 * order they stand.
 *
 * What the runtime creates is an ordinary index over `columns`, whatever
 * `method` and `keys` say: those are kept as information.
 */
export interface IndexDefinition extends ObjectProvenance, SourceClauses {
  name: string;
  columns: string[];
  unique?: boolean;
  /** Indexed expressions, as the source wrote them. */
  expressions?: string[];
  /** The condition of a partial index, as the source wrote it. */
  where?: string;
  /** How the index is built, by the name its source's database has for it (`gin`, `gist`, `hash`, `brin`). Absent: the ordinary one, a B-tree. */
  method?: string;
  /** The keys in their order, with what `columns` and `expressions` cannot say of them. */
  keys?: IndexKey[];
  /** Columns the index carries along without their being part of its key. */
  include?: string[];
  /** For a unique index: two rows that hold NULL in the keys are the same to it. */
  nullsNotDistinct?: boolean;
  /** What `expressions`, the expressions of `keys`, and `where` name (see `ExpressionName`). Absent: the schema does not say. */
  names?: ExpressionName[];
  /** As `mayBeStale` of a check, for the index's expressions and its condition. */
  mayBeStale?: boolean;
}

/** A check constraint, as the source wrote it. Kept as information; not enforced. */
export interface CheckConstraint extends ObjectProvenance, SourceClauses {
  name?: string;
  expression: string;
  /** What `expression` names (see `ExpressionName`). Absent: the schema does not say, and the text is taken to be written in the names the schema has. */
  names?: ExpressionName[];
  /**
   * The schema does not say what `expression` names, and something that it
   * may name has been renamed since it was written: the text may be stale,
   * and nothing says by which name. Never together with `names`.
   */
  mayBeStale?: boolean;
}

export interface TableSchema extends ObjectProvenance {
  /** Table name in SQL, and the collection name in the fixture. */
  name: string;
  columns: ColumnSchema[];
  /** The primary key's name and column order, when the source says (see `PrimaryKeyConstraint`). */
  primaryKey?: PrimaryKeyConstraint;
  uniques?: UniqueConstraint[];
  /** Foreign keys over several columns. */
  foreignKeys?: ForeignKeyConstraint[];
  indexes?: IndexDefinition[];
  checks?: CheckConstraint[];
}

/** An enumerated type of the schema: its values, in their order. */
export interface EnumType extends ObjectProvenance {
  name: string;
  values: string[];
  /** The type as the source's dialect names it, for example `{ dialect: "postgresql", type: "public.mood" }`. */
  sourceDialectType?: { dialect: string; type: string };
  /** Explicit renames of values (for example `ALTER TYPE ... RENAME VALUE`), oldest first. */
  valueRenames?: SchemaRename[];
}

/** Types of the schema that columns refer to by name. */
export interface SchemaTypes {
  enums: EnumType[];
}

/** The canonical schema of a database: its tables and the types they use. */
export interface DatabaseSchema {
  tables: TableSchema[];
  types: SchemaTypes;
}

/** A value that can be bound to a statement. Booleans, dates, and `undefined` are converted. */
export type SqlValue = null | undefined | number | bigint | string | boolean | Date | Uint8Array;

export interface ExecuteResult {
  /** Rows returned by the statement; empty when it returns none. */
  rows: Row[];
  /** Rows changed by an INSERT, UPDATE, or DELETE. */
  affectedRows: number;
  /** Row id of the last inserted row, when the statement inserted one. */
  lastInsertId?: number | bigint;
  /** The statement had more rows than the call asked for (`maxRows`): these are the first of them. */
  truncated?: true;
}

/**
 * What one call asks of a runtime that others use too (D-042). Nothing here
 * outlasts the call.
 */
export interface ExecuteOptions {
  /**
   * The statement must change neither data nor schema. SQLite itself decides
   * (`PRAGMA query_only`, for this call); the statement is not inspected.
   */
  readOnly?: boolean;
  /**
   * The most rows to return. A statement that changes nothing is not read
   * beyond them; one that writes is carried out whole, and its first rows
   * are returned. `truncated` on the result says that there were more.
   */
  maxRows?: number;
  /** What the statement runs for, in place of what the runtime's own `context` would say. */
  context?: SqlEventContext;
}

export interface PreparedStatement {
  /** Whether the statement produces a result set. */
  readonly returnsRows: boolean;
  /** Names of the result set's columns, in order; empty when the statement returns none. */
  readonly columns: readonly string[];
  execute(parameters?: SqlValue[], options?: ExecuteOptions): ExecuteResult;
}

/**
 * One statement executed on the local runtime. `localExecutionMs` is the time
 * the local engine spent on it, including saving the snapshot when the
 * statement committed changes. It says nothing about how a production
 * database would perform.
 */
export interface SqlEvent {
  /** The SQL text that was executed, as received. */
  sql: string;
  /** The values bound to the statement. They are application data and may be sensitive. */
  parameters: unknown[];
  operation: SqlOperation;
  /** Which transaction boundary the statement is; set when `operation` is `TRANSACTION`. */
  transaction?: TransactionBoundary;
  /**
   * Tables of the runtime's schema that the statement names after FROM, JOIN,
   * INTO, or UPDATE. Found by pattern, not by parsing; absent when none was
   * recognized.
   */
  tables?: string[];
  /** Rows affected by a write, otherwise rows returned; `0` on failure. */
  rows: number;
  /** Rows the statement returned; set when it produces a result set and succeeded. */
  returnedRows?: number;
  /** Rows changed; set for INSERT, UPDATE, and DELETE. */
  affectedRows?: number;
  localExecutionMs: number;
  /**
   * The part of `localExecutionMs` that went into saving the snapshot. Set on
   * the statement that committed changes, when a snapshot was saved for it.
   */
  snapshotSaveMs?: number;
  /**
   * Up to the runtime's preview limit of the rows the statement returned, as
   * SQLite returned them. Set when rows were returned and the limit is not 0.
   * These are application data and may be sensitive.
   */
  resultPreview?: Row[];
  /** What the statement ran for, usually an HTTP request, when the runtime was given a way to know. */
  requestId?: string;
  /** Position of the statement among those with the same `requestId`, starting at 1. */
  sequence?: number;
  /** Set when the statement failed. */
  errorCode?: "SANDBOX_DIALECT_UNSUPPORTED" | "SANDBOX_PARAMETER" | "SANDBOX_SIZE_LIMIT" | "SANDBOX_READ_ONLY" | "SQL_ERROR";
  /** The engine's or the runtime's message; set when the statement failed. */
  errorMessage?: string;
}

/** What a statement ran for, as told by the adapter that opened the runtime. */
export interface SqlEventContext {
  requestId: string;
  sequence?: number;
}

export type SqlOperation = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "TRANSACTION" | "OTHER";

export type TransactionBoundary = "BEGIN" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "ROLLBACK TO SAVEPOINT";

export type SqlEventListener = (event: SqlEvent) => void;

/**
 * - `memory`: changes are discarded when the runtime is closed.
 * - `json`: every committed change is written back to the fixture.
 *
 * A `sqlite-file` mode, keeping the SQLite database itself, can be added here
 * without changing the rest of the interface.
 */
export type PersistenceMode = "memory" | "json";

/** Where the fixture is read from and, with `json` persistence, written back to. */
export interface SnapshotStorage {
  load(): Promise<DatabaseState>;
  /** Must not return before the snapshot is stored: the runtime saves, then commits. */
  saveSync(state: DatabaseState): void;
  /**
   * Stores the rows of the given tables and keeps every other table as this
   * storage last loaded or saved it. Like `saveSync`, it must store all of
   * them or nothing, and must not return before that is done.
   *
   * Only a storage that does this without rewriting the other tables offers
   * it. The runtime then saves the tables a commit changed, and falls back to
   * `saveSync` with the complete state when it cannot tell which those are.
   */
  saveTablesSync?(tables: Record<string, Row[]>): void;
}

/** One save of the runtime's tables to its storage, made for a commit. Times are local measurements. */
export interface SnapshotSaveEvent {
  /** `tables`: the tables that the commit changed were saved. `complete`: the whole state was. */
  kind: "tables" | "complete";
  /** The tables whose rows were read from the engine and given to the storage. */
  tables: string[];
  /** Reading those rows from the engine. */
  extractionMs: number;
  /** The storage's part: turning the rows into its format and writing them. */
  storageMs: number;
}

export type SnapshotSaveListener = (event: SnapshotSaveEvent) => void;

export interface RelationalRuntime {
  readonly schema: readonly TableSchema[];
  readonly persistence: PersistenceMode;
  /** Whether a transaction is open. */
  readonly inTransaction: boolean;

  /** Executes one SQL statement. */
  execute(sql: string, parameters?: SqlValue[], options?: ExecuteOptions): ExecuteResult;
  /** Compiles one SQL statement for repeated execution. */
  prepare(sql: string, options?: ExecuteOptions): PreparedStatement;
  /** Executes a query given in the shared Query IR. */
  run(query: Query, options?: ExecuteOptions): ExecuteResult;

  begin(): void;
  commit(): void;
  rollback(): void;

  /** Registers a listener for executed statements. Returns a function that removes it. */
  subscribe(listener: SqlEventListener): () => void;
  /** The current state of the schema's tables, as a fixture; of those named alone, when `tables` is given. */
  snapshot(tables?: readonly string[]): DatabaseState;
  close(): void;
}

/**
 * Raised when a statement cannot be compiled by the runtime's engine: syntax
 * or functions of another SQL dialect, or tables and columns the runtime's
 * schema does not have. The runtime does not translate SQL.
 */
export class SandboxDialectUnsupportedError extends Error {
  readonly code = "SANDBOX_DIALECT_UNSUPPORTED";
  readonly sql: string | undefined;

  constructor(message: string, options?: ErrorOptions & { sql?: string }) {
    super(message, options);
    this.name = "SandboxDialectUnsupportedError";
    this.sql = options?.sql;
  }
}

/**
 * Raised when the parameters given with a statement do not fit its
 * PostgreSQL-style `$N` placeholders: a placeholder has no parameter, there
 * are parameters after the last placeholder, or the statement also has `?`
 * placeholders.
 */
export class SandboxParameterError extends Error {
  readonly code = "SANDBOX_PARAMETER";
  readonly sql: string | undefined;

  constructor(message: string, options?: ErrorOptions & { sql?: string }) {
    super(message, options);
    this.name = "SandboxParameterError";
    this.sql = options?.sql;
  }
}

/** Raised when a statement would change a runtime that was opened read-only. */
export class SandboxReadOnlyError extends Error {
  readonly code = "SANDBOX_READ_ONLY";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxReadOnlyError";
  }
}

/** Raised when a schema or a fixture cannot be loaded into the runtime. */
export class RuntimeSchemaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeSchemaError";
  }
}
