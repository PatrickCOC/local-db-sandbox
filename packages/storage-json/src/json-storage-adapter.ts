import { renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { DatabaseState, Row } from "../../core/src/index.ts";
import type { SchemaTypes, TableSchema } from "../../runtime/src/index.ts";
import type { DatabaseMetadata, DatabaseStorage, DatabaseStorageOptions } from "./database-storage.ts";
import { CURRENT_FORMAT_VERSION, assertReadableFormat, assertWritableFormat, fileFormatStamp } from "./format-version.ts";
import type { FormatStatus } from "./format-version.ts";
import { formatStatusOf } from "./migration-registry.ts";
import { beyondFileFormat, mergeSchemas, mergeTypes, readSchemaDocument, toFileSchemaDocument } from "./schema-document.ts";
import { BYTES_PER_MB, DEFAULT_MAX_FILE_SIZE_MB, SizeWatch, assertWithinSizeLimit, configuredLimitBytes, maxFileSizeMbProblem } from "./size-limits.ts";
import { JsonStorageError } from "./storage-error.ts";

export { JsonStorageError };

export type JsonStorageOptions = DatabaseStorageOptions;

/** Top-level key of a single-file database that holds declared table definitions. */
const TABLE_SCHEMA_KEY = "$tableSchema";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stores the database as a single JSON document:
 *
 *   { "$meta": { "version": 1 }, "$config": { ... }, "data": { "users": [] } }
 *
 * Only `$meta` and `data` map into the core state. Any other top-level keys
 * (such as `$config`) are kept from the last load and written back unchanged.
 *
 * `$meta.version` is the format version (see format-version.ts): 1, the only
 * format a single file has had. A file without `$meta` is read as format 1,
 * and every save states the version. A file that states a later format is
 * not written to.
 *
 * A file may also carry declared table definitions under `$tableSchema`, in
 * the form a directory database keeps in `schema.json`. A file that has none
 * is never given one by a save, so files of earlier versions keep their shape.
 *
 * The file size is checked before the file is read and before it is
 * replaced; see `load` and `save`.
 */
export class JsonStorageAdapter implements DatabaseStorage {
  readonly path: string;
  readonly format = "file" as const;
  /** A single file has no place for a persistence mode. */
  readonly persistence = undefined;
  readonly #sizes: SizeWatch;
  /** Limit known before the file is read; nothing inside the file can raise it. */
  readonly #ceilingBytes: number;
  #extraKeys: Record<string, unknown> = {};
  /** Declared table definitions; `undefined` when the file carries none. */
  #schema: TableSchema[] | undefined;
  /** Enumerated types given to be stored. A single file has no place for them: a save that would hold any is refused. */
  #types: SchemaTypes | undefined;
  #limitBytes: number;
  /** The format of the file that was loaded; `undefined` for one that is written from here. */
  #format: FormatStatus | undefined;

  constructor(filePath: string, options: JsonStorageOptions = {}) {
    if (options.maxFileSizeMb !== undefined) {
      const problem = maxFileSizeMbProblem(options.maxFileSizeMb, "maxFileSizeMb");
      if (problem !== undefined) {
        throw new JsonStorageError(problem);
      }
    }
    this.path = filePath;
    this.#sizes = new SizeWatch(options.onSizeWarning);
    this.#ceilingBytes = (options.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB) * BYTES_PER_MB;
    this.#limitBytes = this.#ceilingBytes;
  }

  /**
   * Raw `$config` value from the last load, or `undefined`. The adapter only
   * reads `limits.maxFileSizeMb` from it; the layer that starts the sandbox
   * interprets the rest.
   */
  get config(): unknown {
    return this.#extraKeys.$config;
  }

  get schema(): TableSchema[] | undefined {
    return this.#schema !== undefined && this.#schema.length > 0 ? this.#schema : undefined;
  }

  get types(): SchemaTypes | undefined {
    return this.#types !== undefined && this.#types.enums.length > 0 ? this.#types : undefined;
  }

  /** Hard size limit in effect, in bytes. */
  get maxFileSizeBytes(): number {
    return this.#limitBytes;
  }

  get formatStatus(): FormatStatus | undefined {
    return this.#format;
  }

  assertWritable(): void {
    if (this.#format !== undefined) {
      assertWritableFormat(this.#format, this.path);
    }
  }

  readonly storesCanonicalSchema = false;

  describe(schema: readonly TableSchema[], types?: SchemaTypes): void {
    if (this.#schema !== undefined) {
      this.#schema = mergeSchemas(this.#schema, schema);
      // A file stores no such types: given all the same, they are what the next save is refused for, by name.
      if (types !== undefined && types.enums.length > 0) {
        this.#types = mergeTypes(this.#types, types);
      }
    }
  }

  metadata(): DatabaseMetadata {
    const { $config, ...extra } = this.#extraKeys;
    return {
      ...($config !== undefined && { config: $config }),
      ...(this.schema !== undefined && { schema: this.schema }),
      ...(this.types !== undefined && { types: this.types }),
      ...(Object.keys(extra).length > 0 && { extra }),
    };
  }

  initialize(metadata: DatabaseMetadata): void {
    this.#extraKeys = { ...(metadata.config !== undefined && { $config: metadata.config }), ...metadata.extra };
    this.#schema = metadata.schema === undefined ? undefined : [...metadata.schema];
    this.#types = metadata.types === undefined ? undefined : { enums: [...metadata.types.enums] };
    this.#limitBytes = configuredLimitBytes(metadata.config, this.#ceilingBytes);
    // What is saved from here is a new database, whatever was at the path: it gets this build's format.
    this.#format = undefined;
  }

  /**
   * Loads the file. Its size is checked first against the limit this adapter
   * was created with, so a file above it is rejected without being opened.
   * A lower limit in the file's `$config` is applied after parsing.
   */
  async load(): Promise<DatabaseState> {
    let sizeBytes: number;
    try {
      sizeBytes = (await stat(this.path)).size;
    } catch (cause) {
      throw new JsonStorageError(`Cannot read database file: ${this.path}`, { cause });
    }
    assertWithinSizeLimit(sizeBytes, this.#ceilingBytes, "load");

    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (cause) {
      throw new JsonStorageError(`Cannot read database file: ${this.path}`, { cause });
    }

    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (cause) {
      throw new JsonStorageError(`Database file is not valid JSON: ${this.path}`, { cause });
    }

    if (!isPlainObject(document)) {
      throw new JsonStorageError("Database file must contain a JSON object.");
    }

    const { $meta, data, [TABLE_SCHEMA_KEY]: tableSchema, ...extraKeys } = document;
    // The format decides whether anything else of the file is looked at.
    const format = formatStatusOf("file", fileFormatStamp($meta));
    assertReadableFormat(format, this.path);
    const limitBytes = configuredLimitBytes(extraKeys.$config, this.#ceilingBytes);
    // A lower limit from the file's own config is only known now.
    assertWithinSizeLimit(sizeBytes, limitBytes, "load");

    const state: DatabaseState = {
      meta: { version: format.formatVersion },
      collections: this.#parseCollections(data),
    };
    const stored = tableSchema === undefined ? undefined : readSchemaDocument(tableSchema, `"${TABLE_SCHEMA_KEY}" in ${this.path}`);
    if (stored !== undefined) {
      this.#refuseBeyondFormat(stored.tables, stored.types, "holds");
    }
    this.#schema = stored?.tables;
    this.#types = undefined;
    this.#extraKeys = extraKeys;
    this.#limitBytes = limitBytes;
    this.#format = format;
    this.#sizes.reset();
    this.#sizes.report(sizeBytes, limitBytes, "load");
    return state;
  }

  /**
   * Replaces the file. The serialized size is checked first; a state above
   * the limit is rejected before anything is written, so the existing file
   * stays as it was.
   */
  async save(state: DatabaseState): Promise<void> {
    const { text, sizeBytes } = this.#serialize(state);

    // Write to a sibling file first so a failed write cannot truncate the database.
    const tempPath = `${this.path}.tmp`;
    try {
      await writeFile(tempPath, text, "utf8");
      await rename(tempPath, this.path);
    } catch (cause) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new JsonStorageError(`Cannot write database file: ${this.path}`, { cause });
    }
    this.#sizes.report(sizeBytes, this.#limitBytes, "save");
  }

  /**
   * `save` without yielding, for callers that must finish the write inside a
   * synchronous step (the relational runtime saves before it commits).
   */
  saveSync(state: DatabaseState): void {
    const { text, sizeBytes } = this.#serialize(state);
    const tempPath = `${this.path}.tmp`;
    try {
      writeFileSync(tempPath, text, "utf8");
      renameSync(tempPath, this.path);
    } catch (cause) {
      rmSync(tempPath, { force: true });
      throw new JsonStorageError(`Cannot write database file: ${this.path}`, { cause });
    }
    this.#sizes.report(sizeBytes, this.#limitBytes, "save");
  }

  /** The document text for a state; fails when it is above the size limit. */
  #serialize(state: DatabaseState): { text: string; sizeBytes: number } {
    // Only a file of the format this build writes is saved to.
    this.assertWritable();
    this.#refuseBeyondFormat(this.#schema ?? [], this.#types, "would hold");
    const document = {
      // The format the file is written in, which is this build's; not a number the caller carries.
      $meta: { version: CURRENT_FORMAT_VERSION.file },
      ...this.#extraKeys,
      ...(this.#schema !== undefined && { [TABLE_SCHEMA_KEY]: toFileSchemaDocument(this.#schema) }),
      data: state.collections,
    };
    const text = `${JSON.stringify(document, null, 2)}\n`;
    const sizeBytes = Buffer.byteLength(text, "utf8");
    assertWithinSizeLimit(sizeBytes, this.#limitBytes, "save");
    return { text, sizeBytes };
  }

  /**
   * Definitions that only a database directory stores (D-033, D-036) are
   * refused rather than dropped: a single file of format 1 has no place for
   * them, and its readers would not know them.
   */
  #refuseBeyondFormat(schema: readonly TableSchema[], types: SchemaTypes | undefined, verb: string): void {
    const beyond = beyondFileFormat(schema, types);
    if (beyond.length > 0) {
      throw new JsonStorageError(
        `${this.path} ${verb} table definitions that a single-file database cannot store (${beyond.join("; ")}). Use a database directory, for example with "local-db-sandbox convert".`,
      );
    }
  }

  #parseCollections(data: unknown): Record<string, Row[]> {
    if (!isPlainObject(data)) {
      throw new JsonStorageError('"data" must be an object mapping collection names to arrays.');
    }
    const collections: Record<string, Row[]> = {};
    for (const [name, rows] of Object.entries(data)) {
      if (!Array.isArray(rows) || !rows.every(isPlainObject)) {
        throw new JsonStorageError(`Collection "${name}" must be an array of objects.`);
      }
      collections[name] = rows;
    }
    return collections;
  }
}
