import { createRequire } from "node:module";
import { join } from "node:path";
import { importFromMetadata } from "../../import-typeorm/src/index.ts";
import type { ImportIssue, ImportedCollection, ImportedField } from "../../import-typeorm/src/index.ts";
import { SandboxDialectUnsupportedError, SqliteRuntime } from "../../runtime/src/index.ts";
import type { ColumnSchema, ColumnType, DatabaseSchema, EnumType, PersistenceMode, RelationalRuntime, SqlEventContext, SqlEventListener, SqlValue, TableSchema } from "../../runtime/src/index.ts";
import { formatNotice, openDatabaseStorage } from "../../storage-json/src/index.ts";
import type { SizeWarningListener } from "../../storage-json/src/index.ts";
import { canonicalTypeOf } from "./canonical-types.ts";
import { logicalTypeOf, sqliteDeclaration, storageTypeOf } from "./column-semantics.ts";
import type { ColumnDeclaration } from "./column-semantics.ts";

/*
 * TypeORM on the relational runtime.
 *
 * Nothing of TypeORM is re-implemented here. A real TypeORM DataSource is
 * created with TypeORM's own SQLite dialect, and its connection is the
 * runtime: repositories, the entity manager, transactions, and QueryBuilder
 * generate SQLite SQL themselves, and the runtime executes it.
 *
 * This file only translates at the edges: entity metadata to the runtime's
 * table schema, column types of other databases to ones the SQLite dialect
 * accepts, and the runtime to the connection object TypeORM's driver expects.
 * Which type a column gets at each of those edges, and what its values are to
 * the application, is decided in column-semantics.ts.
 */

/** Raised when the sandbox cannot be set up for an application's TypeORM entities. */
export class TypeormSandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TypeormSandboxError";
  }
}

/** An entity class, as passed to `TypeOrmModule.forFeature`. */
export type EntityClass<Entity = any> = (abstract new (...args: any[]) => Entity) & { name: string };

export interface SandboxStorageOptions {
  /** Path to the database the runtime is created from: a JSON file or a database directory. */
  file: string;
  /**
   * The application's `typeorm` module. When omitted it is loaded from the
   * current working directory, so the sandbox reads the same decorator
   * metadata as the application.
   */
  typeorm?: Record<string, any>;
  /**
   * `json` writes committed changes back to the database; `memory` discards
   * them. Default: what a directory database declares in its manifest,
   * otherwise `json`.
   */
  persistence?: PersistenceMode;
  /** Largest database to accept, in MB (default 150, at most 250). */
  maxFileSizeMb?: number;
  /** Receives a structured warning when the database is large. */
  onSizeWarning?: SizeWarningListener;
  /** Receives one structured event per SQL statement executed on the runtime. */
  onSql?: SqlEventListener;
  /** Says what the current statement runs for; it becomes `requestId` and `sequence` on SQL events. */
  sqlContext?: () => SqlEventContext | undefined;
  /** Most returned rows to put on a SQL event as its result preview (default 20; 0 for none). */
  sqlPreviewRows?: number;
}

export interface TypeormSandboxOptions extends SandboxStorageOptions {
  /** Entity classes to create tables for. Default: every entity class loaded so far in this process. */
  entities?: EntityClass[];
}

export interface TypeormSandbox {
  /** An initialized TypeORM `DataSource` whose connection is the runtime. */
  dataSource: any;
  runtime: RelationalRuntime;
  /** What the application's entities need that the runtime's schema does not have. */
  warnings: string[];
}

const INTEGER_STRATEGIES = new Set(["increment", "identity", "rowid"]);

const sandboxDataSources = new WeakSet<object>();

/** Whether a DataSource was created by the sandbox, and so connects to the runtime rather than a database server. */
export function isSandboxDataSource(dataSource: unknown): boolean {
  return typeof dataSource === "object" && dataSource !== null && sandboxDataSources.has(dataSource);
}

/** Every entity class whose decorators have run so far in this process. */
export function loadedEntities(typeorm: Record<string, any>): EntityClass[] {
  const tables: { target: unknown }[] = typeorm.getMetadataArgsStorage().tables;
  return [...new Set(tables.map((table) => table.target))].filter((target): target is EntityClass => typeof target === "function");
}

/** How the runtime stores an imported field: its storage type, as distinct from what the application declared. */
function columnType(field: ImportedField): ColumnType {
  switch (field.type) {
    case "boolean":
      return "boolean";
    case "date":
      // "date" is the declared type of a day; "Date" is a property's type, which is a date-time.
      return field.sourceType === "date" ? "date" : "datetime";
    case "json":
    case "array":
      return "json";
    case "binary":
      return "binary";
    case "unknown":
      return "any";
    case "number":
    case "string": {
      // The importer calls 64-bit integers and decimals strings, as their drivers return them. They are stored as numbers.
      const logical = field.sourceType === undefined ? undefined : logicalTypeOf(field.sourceType);
      return logical === "bigint" || logical === "decimal" || logical === "float" ? storageTypeOf(logical) : field.type === "number" ? "integer" : "text";
    }
  }
}

/**
 * The runtime's tables for imported TypeORM entities: one table per entity,
 * named after its table, with one column per imported field. Fixture rows
 * are keyed by entity property name; SQL uses the database column name.
 */
export function tableSchemas(collections: ImportedCollection[]): TableSchema[] {
  const columnName = (field: ImportedField): string => field.column ?? field.name;
  return collections.map((collection) => {
    const primaryCount = collection.fields.filter((field) => field.primary).length;
    const columns = collection.fields.map((field) => {
      const type = columnType(field);
      const column: ColumnSchema = { name: columnName(field), type, nullable: field.nullable, primary: field.primary };
      if (field.column !== undefined) {
        column.key = field.name;
      }
      if (field.sourceType !== undefined) {
        // What the application declared, next to how the runtime stores it.
        column.declaredType = field.sourceType;
      }
      if (field.generated !== undefined) {
        // TypeORM's names for "the database assigns the next integer" are one strategy here.
        column.generated = INTEGER_STRATEGIES.has(field.generated) ? "increment" : field.generated;
      }
      if (field.primary && primaryCount === 1 && type === "integer" && column.generated === "increment") {
        column.autoIncrement = true;
      }
      if (field.default !== undefined) {
        column.default = field.default;
      }
      const target = field.references;
      const targetField = collections.find((other) => other.name === target?.collection)?.fields.find((other) => other.name === target?.field);
      if (target !== undefined && targetField !== undefined) {
        column.references = { table: target.collection, column: columnName(targetField), ...(target.onDelete !== undefined && { onDelete: target.onDelete }) };
      }
      return column;
    });
    return { name: collection.name, columns };
  });
}

/**
 * The canonical schema of imported TypeORM entities (D-040): the tables of
 * `tableSchemas`, each column with its canonical type where its declared
 * type is one PostgreSQL has (`canonical-types.ts`), and the enumerated
 * types those columns are of.
 *
 * An enumerated column names its type and does not carry the values: the
 * runtime checks the values of a column that carries them, and for an
 * entity's column it never has. Of two columns that give one name to
 * different values, the first by the order of the entities has the type,
 * and the other is given none.
 */
export function databaseSchema(collections: ImportedCollection[]): DatabaseSchema {
  const tables = tableSchemas(collections);
  const enums = new Map<string, EnumType>();
  for (const [at, collection] of collections.entries()) {
    for (const [position, field] of collection.fields.entries()) {
      const canonical = canonicalTypeOf(field, collection.name);
      const column = tables[at]?.columns[position];
      if (canonical === undefined || column === undefined) {
        continue;
      }
      if (canonical.enumType !== undefined) {
        const known = enums.get(canonical.enumType.name);
        if (known !== undefined && JSON.stringify(known.values) !== JSON.stringify(canonical.enumType.values)) {
          continue;
        }
        enums.set(canonical.enumType.name, known ?? canonical.enumType);
      }
      column.canonicalType = canonical.type;
    }
  }
  return { tables, types: { enums: [...enums.values()] } };
}

/**
 * Gives TypeORM's SQLite dialect, in place of the column types that loaded
 * entities declare, types it accepts and converts values for as the
 * application's own database does (see column-semantics.ts), so that
 * entities written for PostgreSQL or MySQL can be used. A declaration that
 * is not recognized is left alone and is rejected by TypeORM when the
 * DataSource starts.
 *
 * This is TypeORM's decorator metadata, which is the application's and is
 * shared by the whole process. It is changed for as long as a DataSource
 * takes to build its own metadata from it, and the function that is returned
 * puts every declaration back as it was. What the application declared stays
 * readable afterwards; what TypeORM's SQLite dialect was given is in the
 * DataSource's column metadata.
 */
export function adaptColumnTypes(typeorm: Record<string, any>, supportedTypes: string[]): () => void {
  const supported = new Set(supportedTypes);
  const restores: (() => void)[] = [];
  const columns: { mode: string; options: ColumnDeclaration }[] = typeorm.getMetadataArgsStorage().columns;
  for (const { options, mode } of columns) {
    const adapted = sqliteDeclaration(typeorm, options, mode, supported);
    if (adapted === undefined) {
      continue;
    }
    const changes: Record<string, unknown> = {
      ...adapted.set,
      // After the application's own transformers, as the driver comes after TypeORM.
      ...(adapted.transformer !== undefined && { transformer: [options.transformer ?? [], adapted.transformer].flat() }),
    };
    const declared = Object.keys(changes).map((key): [string, boolean, unknown] => [key, Object.hasOwn(options, key), options[key]]);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) {
        delete options[key];
      } else {
        options[key] = value;
      }
    }
    restores.push(() => {
      for (const [key, had, value] of declared) {
        if (had) {
          options[key] = value;
        } else {
          delete options[key];
        }
      }
    });
  }
  return () => {
    for (const restore of restores) {
      restore();
    }
  };
}

/**
 * Gives TypeORM SQL text for column defaults that are declared as objects or
 * arrays. TypeORM's SQLite dialect writes a column's default into an INSERT
 * that leaves the column out, and has no text for such a value; its
 * PostgreSQL dialect writes the JSON text.
 *
 * This is done on the DataSource's own metadata, so that the decorator
 * metadata still holds the default as the application declared it.
 */
function adaptJsonDefaults(dataSource: any): void {
  for (const metadata of dataSource.entityMetadatas as { columns: { default?: unknown }[] }[]) {
    for (const column of metadata.columns) {
      if (typeof column.default === "object" && column.default !== null) {
        const text = JSON.stringify(column.default).replaceAll("'", "''");
        column.default = () => `'${text}'`;
      }
    }
  }
}

/*
 * The bridge between TypeORM's `better-sqlite3` driver and the runtime.
 *
 * That driver takes, as its `driver` option, a stand-in for what
 * `require("better-sqlite3")` returns, and uses this much of it (checked
 * against every stable TypeORM release from 0.3.0 to 1.1.1):
 *
 * - creating the connection, synchronously and without a callback:
 *   `driver(database, options)` in TypeORM 0.3.0 to 0.3.27, and
 *   `new driver(database, options)` from 0.3.28 on. better-sqlite3's export
 *   accepts both, so the stand-in must too;
 * - on the connection: `prepare(sql)`, `exec(sql)` (connection setup up to
 *   0.3.27), `pragma(text)` (connection setup and schema reads from 0.3.28
 *   on), and `close()`;
 * - on a prepared statement: `reader`, `all(...parameters)`, and
 *   `run(...parameters)`, which returns `changes` and `lastInsertRowid`.
 *   Up to 0.3.25 these are invoked as `all.apply(statement, parameters)`,
 *   where `parameters` is `undefined` for a query without parameters.
 */

/** The part of a better-sqlite3 statement that TypeORM's query runner uses. */
interface SqliteStatement {
  /** Whether the statement returns rows: TypeORM calls `all` when it does and `run` when it does not. */
  readonly reader: boolean;
  all(...parameters: SqlValue[]): unknown[];
  run(...parameters: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
}

/** The part of a better-sqlite3 connection that TypeORM's driver and query runner use. */
interface SqliteConnection {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(text: string): unknown[];
  close(): void;
}

/** What TypeORM calls, or constructs, to get its connection. */
interface SqliteDriver {
  (database?: string, options?: object): SqliteConnection;
  new (database?: string, options?: object): SqliteConnection;
}

/** A connection of TypeORM's driver that executes on the runtime. */
class SandboxSqliteConnection implements SqliteConnection {
  readonly #runtime: RelationalRuntime;

  constructor(runtime: RelationalRuntime) {
    this.#runtime = runtime;
  }

  prepare(sql: string): SqliteStatement {
    const statement = this.#runtime.prepare(sql);
    return {
      reader: statement.returnsRows,
      all: (...parameters) => statement.execute(parameters).rows,
      run: (...parameters) => {
        const result = statement.execute(parameters);
        return { changes: result.affectedRows, lastInsertRowid: result.lastInsertId ?? 0 };
      },
    };
  }

  exec(sql: string): void {
    this.#runtime.execute(sql);
  }

  pragma(text: string): unknown[] {
    return this.#runtime.execute(`PRAGMA ${text}`).rows;
  }

  close(): void {
    this.#runtime.close();
  }
}

/**
 * The value for the `driver` option of a TypeORM `better-sqlite3` DataSource:
 * every connection it hands out executes on `runtime`.
 *
 * The database name and the open options TypeORM passes are not used: the
 * database is the runtime, which is already open.
 */
function sqliteDriver(runtime: RelationalRuntime): SqliteDriver {
  // An ordinary function, because it has to work both called and constructed:
  // a class cannot be called without `new`, and an arrow function cannot be
  // constructed. When it is constructed, the connection it returns replaces
  // the object `new` created.
  function SandboxSqliteDriver(): SqliteConnection {
    return new SandboxSqliteConnection(runtime);
  }
  return SandboxSqliteDriver as unknown as SqliteDriver;
}

/** The `typeorm` module of the project in the current working directory. */
export function loadTypeorm(): Record<string, any> {
  try {
    return createRequire(join(process.cwd(), "package.json"))("typeorm");
  } catch (cause) {
    throw new TypeormSandboxError(
      'Cannot load "typeorm" from the current working directory. Pass the application\'s module as the "typeorm" option.',
      { cause },
    );
  }
}

/** Compares what TypeORM will address with the tables the runtime created. */
function schemaWarnings(dataSource: any, schema: TableSchema[], issues: ImportIssue[]): string[] {
  const warnings: string[] = [];
  for (const metadata of dataSource.entityMetadatas as { name: string; tableName: string; tableType: string; columns: { databaseName: string }[] }[]) {
    const table = schema.find((candidate) => candidate.name === metadata.tableName);
    if (table === undefined) {
      const reason = issues.find((issue) => issue.entity === metadata.name && issue.property === undefined && issue.kind === "unsupported")?.message;
      warnings.push(
        `${metadata.name}: the sandbox has no table "${metadata.tableName}"${metadata.tableType === "junction" ? " (many-to-many join tables are not created)" : ""}. ${reason ?? ""}`.trim(),
      );
      continue;
    }
    const missing = metadata.columns.map((column) => column.databaseName).filter((name) => !table.columns.some((column) => column.name === name));
    if (missing.length > 0) {
      warnings.push(`${metadata.name}: table "${table.name}" in the sandbox has no column ${missing.map((name) => `"${name}"`).join(", ")}.`);
    }
  }
  return warnings;
}

/**
 * Creates the runtime from the entities' metadata and the database (a JSON
 * file or a database directory), and a TypeORM DataSource connected to it.
 */
export async function openTypeormSandbox(options: TypeormSandboxOptions): Promise<TypeormSandbox> {
  const typeorm = options.typeorm ?? loadTypeorm();
  const entities = options.entities ?? loadedEntities(typeorm);
  if (!Array.isArray(entities) || entities.length === 0 || entities.some((entity) => typeof entity !== "function")) {
    throw new TypeormSandboxError("The sandbox needs at least one TypeORM entity class.");
  }

  // The metadata as the application declared it.
  const imported = importFromMetadata(typeorm, new Set(entities));
  const storage = openDatabaseStorage(options.file, { maxFileSizeMb: options.maxFileSizeMb, onSizeWarning: options.onSizeWarning });
  // What the columns are in the database the entities were written for (D-040) is recorded where the format holds it: a directory. A single file takes the tables as the runtime has them.
  const described = storage.storesCanonicalSchema ? databaseSchema(imported.collections) : { tables: tableSchemas(imported.collections), types: undefined };
  const schema = described.tables;
  const state = await storage.load();
  // The application's entities decide what its tables are. The database records them with each
  // save, so that it can be opened later without the application (a single file only if it already carries definitions).
  storage.describe(schema, described.types);
  const persistence = options.persistence ?? storage.persistence ?? "json";
  if (persistence === "json") {
    // A database in another format is refused now, with what to do about it, and not at the first commit.
    storage.assertWritable();
  }
  const runtime = await SqliteRuntime.open({ schema, storage, state, persistence, context: options.sqlContext, resultPreviewRows: options.sqlPreviewRows });
  // Subscribed before TypeORM connects, so that the statements of its connection setup are reported too.
  if (options.onSql !== undefined) {
    runtime.subscribe(options.onSql);
  }

  try {
    const dataSource = new typeorm.DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      driver: sqliteDriver(runtime),
      entities,
      // The runtime owns the schema; TypeORM must not create or alter tables.
      synchronize: false,
    });
    sandboxDataSources.add(dataSource);
    // The DataSource builds its metadata from the declarations as TypeORM's SQLite dialect needs them. The application's declarations are put back.
    const restoreDeclarations = adaptColumnTypes(typeorm, dataSource.driver.supportedDataTypes);
    try {
      await dataSource.initialize();
    } catch (error) {
      if ((error as Error).name === "DataTypeNotSupportedError") {
        throw new SandboxDialectUnsupportedError(
          `${(error as Error).message} The sandbox maps common PostgreSQL and MySQL column types to SQLite ones, but has no mapping for this one.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      restoreDeclarations();
    }
    adaptJsonDefaults(dataSource);
    const warnings = schemaWarnings(dataSource, schema, imported.issues);
    if (options.persistence === undefined && storage.persistence === "memory") {
      warnings.unshift(`${options.file} declares "persistence": "memory": changes are not saved.`);
    }
    const notice = storage.formatStatus === undefined ? undefined : formatNotice(storage.formatStatus, options.file);
    if (notice !== undefined) {
      warnings.unshift(notice);
    }
    return { dataSource, runtime, warnings };
  } catch (error) {
    runtime.close();
    throw error;
  }
}
