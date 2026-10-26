import type { DatabaseState, Row, StorageAdapter } from "../../core/src/index.ts";
import type { PersistenceMode, SchemaTypes, TableSchema } from "../../runtime/src/index.ts";
import type { FormatStatus } from "./format-version.ts";
import type { SizeWarningListener } from "./size-limits.ts";

/*
 * A JSON database is stored either as a single file (`sandbox.db.json`) or as
 * a directory (`sandbox.db/`). Both hold the same things and are read into,
 * and written from, the same representation: the core's `DatabaseState` for
 * the rows, and `DatabaseMetadata` for everything else.
 */

/** `file`: one JSON document. `directory`: a manifest, a schema, and one file per table. */
export type DatabaseFormat = "file" | "directory";

export interface DatabaseStorageOptions {
  /**
   * Largest database to read or write, in MB: the size of the file, or of all
   * the files a directory database consists of. Defaults to 150 and may be
   * raised up to 250. The database's own configuration
   * (`limits.maxFileSizeMb`) can lower it but never raise it.
   */
  maxFileSizeMb?: number;
  /** Receives a structured warning when the database is large (see size-limits.ts). */
  onSizeWarning?: SizeWarningListener;
}

/** What a database stores besides its rows. */
export interface DatabaseMetadata {
  /** Sandbox configuration: `$config` in a single file, `config` in a manifest. */
  config?: unknown;
  /** Declared table definitions. Tables without one are described from their rows by whoever opens the database. */
  schema?: TableSchema[];
  /** Types of the schema that columns name: its enumerated types. Only a directory stores them. */
  types?: SchemaTypes;
  /** Whether committed changes are meant to be written back (`json`) or discarded (`memory`). Only a directory stores this. */
  persistence?: PersistenceMode;
  /** A name for the database. Only a directory stores this. */
  name?: string;
  /** Other top-level keys of a single-file database; kept under `extra` in a manifest. */
  extra?: Record<string, unknown>;
}

/** Rows and everything else: what one database can be copied to another from. */
export interface DatabaseContents extends DatabaseMetadata {
  collections: Record<string, Row[]>;
}

/**
 * Persistence for a JSON database in either format.
 *
 * It serves the core (`load` / `save`) and the relational runtime
 * (`load` / `saveSync` / `saveTablesSync`). A save takes effect as a whole,
 * or not at all.
 */
export interface DatabaseStorage extends StorageAdapter {
  /** The file or directory. */
  readonly path: string;
  readonly format: DatabaseFormat;
  /*
   * `config`, `schema`, `types`, and `persistence` are what the database stored when it
   * was last loaded. Before the first `load` they say nothing about it.
   */
  /** Raw sandbox configuration; the layer that starts the sandbox interprets it. */
  readonly config: unknown;
  /** Declared table definitions stored with the database, or `undefined` when it stores none. */
  readonly schema: TableSchema[] | undefined;
  /**
   * The schema's enumerated types, which columns name (`DatabaseSchema.types`),
   * or `undefined` when the database stores none. A column's `enum` in
   * `schema` is resolved from them.
   */
  readonly types: SchemaTypes | undefined;
  /** The persistence mode the database declares, if it declares one. Callers decide; the storage saves whenever it is asked to. */
  readonly persistence: PersistenceMode | undefined;
  /** Hard size limit in effect, in bytes. */
  readonly maxFileSizeBytes: number;
  /**
   * The format the database was stored in when it was last loaded, and what
   * this build may do with it (see format-version.ts). `undefined` before the
   * first `load`, and for a database that is written anew.
   */
  readonly formatStatus: FormatStatus | undefined;
  /**
   * Throws when this build does not save to the database as it was loaded:
   * it is stored in an earlier format, which is migrated first, or in a later
   * one. Every save checks this. Whoever opens a database in order to change
   * it calls it once after loading, so that it is refused then and not at the
   * first change.
   */
  assertWritable(): void;
  /** `save` without yielding, for callers that must finish the write inside a synchronous step. */
  saveSync(state: DatabaseState): void;
  /**
   * Stores the rows of the given tables and keeps every other table as it is
   * stored. Offered by a format that keeps a file per table (a directory); a
   * single file is always written as a whole and does not offer it.
   */
  saveTablesSync?(tables: Record<string, Row[]>): void;
  /**
   * Gives table definitions to store from the next save on. They replace the
   * stored definitions of the same tables; the definitions of tables that are
   * not given are kept (see `mergeSchemas`). A directory always stores them.
   * A single file stores them only when it already carries definitions, so
   * that files of earlier versions keep their shape.
   *
   * `types`: enumerated types of the schema that the definitions name
   * (D-040). One of a name that is stored already replaces it; the others
   * that are stored are kept.
   */
  describe(schema: readonly TableSchema[], types?: SchemaTypes): void;
  /**
   * Whether the format stores what a canonical schema says beyond the
   * runtime's own types: canonical types, and the schema's enumerated types.
   * A directory does. A single file does not, and refuses to be saved with
   * definitions that have them: who describes tables to it leaves them out.
   */
  readonly storesCanonicalSchema: boolean;
  /** What is stored besides the rows, as of the last load. */
  metadata(): DatabaseMetadata;
  /** For a database that does not exist yet: what to store besides the rows. */
  initialize(metadata: DatabaseMetadata): void;
}
