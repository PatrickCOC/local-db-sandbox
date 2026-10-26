import type { Row } from "../../core/src/index.ts";
import { SqliteRuntime } from "../../runtime/src/index.ts";
import type { SchemaTypes, TableSchema } from "../../runtime/src/index.ts";
import { createDatabase } from "../../storage-json/src/index.ts";

/*
 * Creates a sandbox database from table definitions and initial rows, with
 * the relational runtime. It knows nothing about where the definitions came
 * from: the PostgreSQL migration collector is its first source.
 *
 * The rows are inserted into the runtime first, in memory: SQLite creates
 * the tables (so a definition it cannot create fails here, before anything
 * is written), fills in the defaults it computes (`current_timestamp`), and
 * checks keys and foreign keys. What the runtime then holds is written as a
 * new database directory. So a computed default is computed once, when the
 * database is created, and not again at every start.
 */

export interface BootstrapOptions {
  /** The database directory to create. */
  database: string;
  tables: TableSchema[];
  /** The schema's types (enumerated types), including any no column uses yet. */
  types?: SchemaTypes;
  /** Initial rows by table, as fixture values. Columns they leave out take their defaults. */
  rows?: Record<string, Row[]>;
  /** Replace a database that is there already. */
  overwrite?: boolean;
  maxFileSizeMb?: number;
}

export interface BootstrapResult {
  database: string;
  /** Rows written per table, in the schema's order. */
  rows: Record<string, number>;
}

export async function bootstrapDatabase(options: BootstrapOptions): Promise<BootstrapResult> {
  const runtime = await SqliteRuntime.open({ schema: options.tables, state: { meta: { version: 1 }, collections: options.rows ?? {} }, persistence: "memory" });
  let collections: Record<string, Row[]>;
  try {
    collections = runtime.snapshot().collections;
  } finally {
    runtime.close();
  }
  await createDatabase(
    options.database,
    { collections, schema: options.tables, ...(options.types !== undefined && options.types.enums.length > 0 && { types: options.types }) },
    { format: "directory", ...(options.overwrite === true && { overwrite: true }), ...(options.maxFileSizeMb !== undefined && { maxFileSizeMb: options.maxFileSizeMb }) },
  );
  return { database: options.database, rows: Object.fromEntries(options.tables.map((table) => [table.name, collections[table.name]?.length ?? 0])) };
}
