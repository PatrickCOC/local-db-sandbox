import { closeSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseState, Row } from "../../core/src/index.ts";
import type { PersistenceMode, SchemaTypes, TableSchema } from "../../runtime/src/index.ts";
import type { DatabaseMetadata, DatabaseStorage, DatabaseStorageOptions } from "./database-storage.ts";
import {
  ABSENT,
  MANIFEST,
  MANIFEST_DRAFT,
  SCHEMA,
  SCHEMA_FILE,
  SaveInProgress,
  TABLES,
  VERSIONED_FILE,
  beginSave,
  documentText,
  fileIdentity,
  hashOf,
  parseJson,
  parseManifest,
  publishManifest,
  readGeneration,
  readText,
  refuseUnlistedTables,
  versionedFile,
  writeNewFile,
} from "./directory-files.ts";
import type { StoredFile } from "./directory-files.ts";
import { CURRENT_FORMAT_VERSION, DatabaseFormatError, assertReadableFormat, assertWritableFormat, manifestFormatStamp, migrateCommand } from "./format-version.ts";
import type { FormatStatus } from "./format-version.ts";
import { FORMAT_MIGRATIONS, formatStatusOf } from "./migration-registry.ts";
import { mergeSchemas, mergeTypes, readSchemaDocument, toSchemaDocument } from "./schema-document.ts";
import { BYTES_PER_MB, DEFAULT_MAX_FILE_SIZE_MB, SizeWatch, assertWithinSizeLimit, configuredLimitBytes, maxFileSizeMbProblem } from "./size-limits.ts";
import { JsonStorageError } from "./storage-error.ts";
import { assignTableFiles, tableFileStem } from "./table-files.ts";

/** `formatVersion` that a database directory is written with. See format-version.ts. */
export const DIRECTORY_FORMAT_VERSION = CURRENT_FORMAT_VERSION.directory;

/** How often a load starts over because the database was saved while it was read, before it gives up. */
const LOAD_ATTEMPTS = 20;
/** How long a file that is no longer part of the database is kept for readers that are still reading it. */
const DEFAULT_RETIRED_FILE_GRACE_MS = 1000;
/**
 * At most this many replaced files are kept, however recent. Saves that follow
 * each other within milliseconds would otherwise fill the directory with a
 * second's worth of copies of the tables they change.
 */
const RETIRED_FILE_LIMIT = 32;
/** A folder in which a save of directory format 2 staged its files. One that is still there was left by a save that did not commit. */
const STAGING_PREFIX = ".staging-";

export interface DirectoryStorageOptions extends DatabaseStorageOptions {
  /**
   * How long, in ms, a file that a save replaced is kept before it is deleted
   * (default 1000). A reader that is still reading the previous state needs
   * it for that long. `0` deletes it with the save that replaces it. Of files
   * that are waiting, only the 32 that were replaced last are kept.
   */
  retiredFileGraceMs?: number;
  /** Receives a report of every save: what was written, what was kept, and how long each step took. */
  onSave?: (report: DirectorySaveReport) => void;
}

/** What one save did. Times are local measurements of this process. */
export interface DirectorySaveReport {
  /** `complete`: the save was given every table. `tables`: only the tables that may have changed. */
  kind: "complete" | "tables";
  /** The generation that is the database's state after the save. */
  generation: number;
  /** Whether a new generation was published. `false` when what was given is what is stored already. */
  published: boolean;
  /** Tables whose rows were given and turned into text. */
  serializedTables: string[];
  /** Tables whose file was written: those whose text differs from the stored one. */
  writtenTables: string[];
  /** Tables whose stored file is part of the new generation as it is. */
  reusedTables: number;
  /** Tables that are no longer part of the database. */
  removedTables: string[];
  schemaWritten: boolean;
  /** Bytes written: table files, the schema, and the manifest. */
  bytesWritten: number;
  /** Size of the database after the save: the files of its current generation. */
  sizeBytes: number;
  /** Turning the given rows into text. */
  serializeMs: number;
  /** Writing and checking the files of the new generation. */
  writeMs: number;
  /** Writing the manifest and putting it in place. */
  publishMs: number;
  /** Removing files that are no longer needed. */
  cleanupMs: number;
  totalMs: number;
}

/** What deletes, at once, the files that an adapter is still keeping for readers. Run when the process ends: there is no later then. */
const pendingRemovals = new Set<() => void>();
let removesPendingAtExit = false;

function removePending(): void {
  for (const remove of pendingRemovals) {
    remove();
  }
}

/**
 * Stores the database as a directory:
 *
 *   sandbox.db/
 *     manifest.json           format version, name, persistence, configuration, the generation, and the file of every table
 *     schema.json             declared table definitions
 *     tables/<table>.json     the rows of one table, and nothing else
 *
 * The manifest names the file of every table. That is needed because a table
 * name is not always a usable file name (see table-files.ts), and it is what
 * makes a save one step:
 *
 * A file that is part of the database is never changed. A save writes a new
 * file for each table whose rows differ from the stored ones, named after the
 * save's generation (`tables/users.g7.json`), and then replaces
 * `manifest.json`, in one rename, by a manifest that names those files and,
 * for every other table, the file it already had. That rename is the save.
 * Before it, the database is the previous generation, whatever has been
 * written; after it, it is the new one, complete. The files of a new database
 * have plain names (`tables/users.json`).
 *
 * A reader reads the manifest and then the files it names, without a lock and
 * without checking anything afterwards: those files are one generation's and
 * cannot change. Files that a save replaced are deleted a little later
 * (`retiredFileGraceMs`, or sooner when more than a few dozen are waiting),
 * so that a reader that had already read the previous manifest still finds
 * them. One that comes too late for a file reads the manifest again and
 * starts over.
 *
 * Files that are in the directory and that the manifest does not name are not
 * part of the database, however they got there: an interrupted save leaves
 * such files, and the next save removes them.
 *
 * One process saves a database at a time; any number may read it. A second
 * process that tries to save is refused. So is a save from an adapter whose
 * database was saved by something else since it was loaded.
 *
 * The size limit is applied to the files of one generation, before anything
 * is read and before anything is written.
 *
 * This is the directory format of `DIRECTORY_FORMAT_VERSION`, and the only
 * one that is written. A directory in an earlier format that this build has
 * a migration from is read as it is, and never changed: a save to it is
 * refused until it has been migrated (see migrate.ts). Nothing here upgrades
 * a database as a side effect of opening or saving it.
 */
export class DirectoryStorageAdapter implements DatabaseStorage {
  readonly path: string;
  readonly format = "directory" as const;
  /** Limit known before anything is read; nothing inside the database can raise it. */
  readonly #ceilingBytes: number;
  readonly #sizes: SizeWatch;
  readonly #graceMs: number;
  readonly #onSave: ((report: DirectorySaveReport) => void) | undefined;
  #limitBytes: number;
  #name: string;
  #persistence: PersistenceMode = "json";
  #config: unknown;
  #extra: Record<string, unknown> = {};
  #schema: TableSchema[] = [];
  /** The schema's enumerated types; stored with the table definitions, in the schema file. */
  #types: SchemaTypes = { enums: [] };
  /** The file of each table of the generation that was last loaded or saved, in the manifest's order. */
  #tables = new Map<string, StoredFile>();
  #schemaFile: StoredFile | undefined;
  #schemaText: { of: TableSchema[]; types: SchemaTypes; text: string; bytes: number; hash: string } | undefined;
  /** The generation that was last loaded or saved; `0` for a database without one. */
  #generation = 0;
  /** The number last used to name files. Never used twice, also when a save fails. */
  #lastAttempt = 0;
  /** `manifest.json` as it was last loaded or saved; a different one was written by something else. */
  #manifestIdentity = ABSENT;
  /** What the stored manifest says apart from its generation, to tell whether a new one is needed. */
  #manifestHead = "";
  /** Plain-named files of `tables/` that are no longer part of the database and may still be there. The manifest lists them. */
  #retiredNames: string[] = [];
  /** Files to delete, relative to the directory, with the time from which they may be. */
  #retired: { file: string; from: number }[] = [];
  #retiredTimer: NodeJS.Timeout | undefined;
  /** Whether this adapter has made sure that it may save and has removed what interrupted saves left. */
  #prepared = false;
  #lastSave: DirectorySaveReport | undefined;
  /** The format of the database that was loaded; `undefined` for one that is written from here. */
  #format: FormatStatus | undefined;

  constructor(path: string, options: DirectoryStorageOptions = {}) {
    if (options.maxFileSizeMb !== undefined) {
      const problem = maxFileSizeMbProblem(options.maxFileSizeMb, "maxFileSizeMb");
      if (problem !== undefined) {
        throw new JsonStorageError(problem);
      }
    }
    this.path = path;
    this.#sizes = new SizeWatch(options.onSizeWarning, "directory");
    this.#ceilingBytes = (options.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB) * BYTES_PER_MB;
    this.#limitBytes = this.#ceilingBytes;
    this.#graceMs = options.retiredFileGraceMs ?? DEFAULT_RETIRED_FILE_GRACE_MS;
    this.#onSave = options.onSave;
    this.#name = basename(path).replace(/\.db$/i, "") || "sandbox";
  }

  get config(): unknown {
    return this.#config;
  }

  get schema(): TableSchema[] | undefined {
    return this.#schema.length > 0 ? this.#schema : undefined;
  }

  get types(): SchemaTypes | undefined {
    return this.#types.enums.length > 0 ? this.#types : undefined;
  }

  get persistence(): PersistenceMode {
    return this.#persistence;
  }

  get maxFileSizeBytes(): number {
    return this.#limitBytes;
  }

  /** The generation that was last loaded or saved. */
  get generation(): number {
    return this.#generation;
  }

  get formatStatus(): FormatStatus | undefined {
    return this.#format;
  }

  assertWritable(): void {
    if (this.#format !== undefined) {
      assertWritableFormat(this.#format, this.path);
    }
  }

  /** What the last save of this adapter did, if it has saved. */
  get lastSave(): DirectorySaveReport | undefined {
    return this.#lastSave;
  }

  readonly storesCanonicalSchema = true;

  describe(schema: readonly TableSchema[], types?: SchemaTypes): void {
    this.#schema = mergeSchemas(this.#schema, schema);
    if (types !== undefined && types.enums.length > 0) {
      this.#types = mergeTypes(this.#types, types);
    }
  }

  metadata(): DatabaseMetadata {
    return {
      ...(this.#config !== undefined && { config: this.#config }),
      ...(this.#schema.length > 0 && { schema: this.#schema }),
      ...(this.#types.enums.length > 0 && { types: this.#types }),
      persistence: this.#persistence,
      name: this.#name,
      ...(Object.keys(this.#extra).length > 0 && { extra: this.#extra }),
    };
  }

  initialize(metadata: DatabaseMetadata): void {
    this.#config = metadata.config;
    this.#schema = [...(metadata.schema ?? [])];
    this.#types = { enums: [...(metadata.types?.enums ?? [])] };
    this.#persistence = metadata.persistence ?? "json";
    this.#name = metadata.name ?? this.#name;
    this.#extra = { ...metadata.extra };
    this.#limitBytes = configuredLimitBytes(metadata.config, this.#ceilingBytes);
    // What is saved from here is a new database, whatever was at the path: it gets this build's format.
    this.#format = undefined;
  }

  /**
   * Loads every table of the current generation. The total size of its files
   * is checked first, from their sizes on disk, so that a database above the
   * limit is refused before its tables are read. A lower limit in the
   * manifest's configuration is applied as well.
   */
  async load(): Promise<DatabaseState> {
    let isDirectory: boolean;
    try {
      isDirectory = statSync(this.path).isDirectory();
    } catch (cause) {
      throw new JsonStorageError(`Cannot read database directory: ${this.path}`, { cause });
    }
    if (!isDirectory) {
      throw new JsonStorageError(`${this.path} is not a directory.`);
    }

    // Another process may be saving. A read that came too late for a file of the generation it was reading is started over.
    let cause: unknown;
    for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt += 1) {
      const outcome = this.#loadOnce();
      if ("state" in outcome) {
        return outcome.state;
      }
      cause = outcome.interrupted;
      if (attempt < LOAD_ATTEMPTS) {
        await delay(Math.min(2 ** attempt, 32));
      }
    }
    throw new JsonStorageError(
      `${this.path} changed while it was read: another process was saving it each of the ${LOAD_ATTEMPTS} times this was tried. Try again when that process is not saving.`,
      { cause },
    );
  }

  /**
   * Reads one generation: the manifest, and then the files it names. The
   * result is `interrupted` when something is wrong with one of those files
   * and the manifest has been replaced since it was read. The files of the
   * generation that was being read may then be gone, so the failure says
   * nothing about the database.
   */
  #loadOnce(): { state: DatabaseState } | { interrupted: unknown } {
    const manifestPath = join(this.path, MANIFEST);
    let manifestIdentity = fileIdentity(manifestPath);
    try {
      if (!existsSync(manifestPath)) {
        throw new JsonStorageError(`${this.path} is not a database directory: it has no ${MANIFEST}.`);
      }
      assertWithinSizeLimit(statSync(manifestPath).size, this.#ceilingBytes, "load", "directory");
      const read = readText(manifestPath, manifestPath);
      manifestIdentity = read.identity;
      const document = parseJson(read.text, manifestPath);
      // The format decides whether anything else of the manifest is looked at.
      const format = formatStatusOf("directory", manifestFormatStamp(document, manifestPath));
      assertReadableFormat(format, this.path);
      const manifest = parseManifest(document, manifestPath);
      this.#refuseUnfinished(format);
      const generation = readGeneration(this.path, manifest, read.bytes, this.#ceilingBytes);
      refuseUnlistedTables(this.path, manifest);

      this.#name = manifest.name ?? this.#name;
      this.#persistence = manifest.persistence;
      this.#config = manifest.config;
      this.#extra = manifest.extra;
      this.#schema = generation.schema;
      this.#types = generation.types;
      this.#tables = generation.tables;
      this.#schemaFile = generation.schemaFile;
      this.#generation = manifest.generation;
      this.#lastAttempt = Math.max(this.#lastAttempt, manifest.generation);
      this.#manifestIdentity = manifestIdentity;
      this.#manifestHead = this.#headOf(manifest.formatVersion, generation.schemaFile?.file, generation.tables);
      this.#retiredNames = manifest.retired;
      this.#limitBytes = generation.limitBytes;
      this.#format = format;
      this.#sizes.reset();
      this.#sizes.report(generation.sizeBytes, generation.limitBytes, "load");
      return { state: { meta: { version: manifest.formatVersion }, collections: generation.collections } };
    } catch (error) {
      // The error is the database's own only when the manifest that was read is still the database's manifest.
      if (fileIdentity(manifestPath) !== manifestIdentity) {
        return { interrupted: error };
      }
      throw error;
    }
  }

  /**
   * An earlier format may leave a database in a state that its own readers
   * complete before they read, such as a save that was committed and not put
   * in place. Completing it would change the database, which reading never
   * does, so such a database is refused, and its migration completes it.
   */
  #refuseUnfinished(format: FormatStatus): void {
    const pending = FORMAT_MIGRATIONS.find((migration) => migration.storage === "directory" && migration.from === format.formatVersion)?.pending?.(this.path);
    if (pending !== undefined) {
      throw new DatabaseFormatError(
        `${this.path} holds ${pending}, so it cannot be read as it is. Migrating it finishes that save: ${migrateCommand(this.path)}`,
        "DATABASE_MIGRATION_REQUIRED",
        format,
      );
    }
  }

  async save(state: DatabaseState): Promise<void> {
    this.saveSync(state);
  }

  /**
   * Makes `state` the stored state: its tables are the database's tables, in
   * its order. Only the files of tables whose rows differ from the stored
   * ones are written. Nothing is written when the new state is above the size
   * limit, and nothing of the stored state changes unless the save as a whole
   * is published (see the class description).
   */
  saveSync(state: DatabaseState): void {
    this.#publish("complete", state.collections);
  }

  /**
   * Stores the rows of the given tables and keeps every other table as it is
   * stored. A table that is not stored yet is added after the others.
   */
  saveTablesSync(tables: Record<string, Row[]>): void {
    this.#publish("tables", tables);
  }

  #publish(kind: DirectorySaveReport["kind"], given: Record<string, Row[]>): void {
    const startedAt = performance.now();
    const manifestPath = join(this.path, MANIFEST);
    const creating = !existsSync(manifestPath) && this.#manifestIdentity === ABSENT;
    // Only a database of the format this build writes is saved to. One of another format is migrated first, and not by a save.
    this.assertWritable();
    this.#refuseForeignManifest(manifestPath);

    // What the new generation consists of.
    const givenNames = Object.keys(given);
    const names = kind === "complete" ? givenNames : [...this.#tables.keys(), ...givenNames.filter((name) => !this.#tables.has(name))];
    const documents = new Map(givenNames.map((name) => [name, documentText(given[name])]));
    const changed = new Map<string, { text: string; bytes: number; hash: string }>();
    for (const [name, text] of documents) {
      const stored = this.#tables.get(name);
      const bytes = Buffer.byteLength(text, "utf8");
      const hash = hashOf(text);
      if (stored === undefined || stored.bytes !== bytes || stored.hash !== hash) {
        changed.set(name, { text, bytes, hash });
      }
    }
    const schemaChange = this.#schemaDocument();
    const schemaChanged = this.#schemaFile === undefined || this.#schemaFile.bytes !== schemaChange.bytes || this.#schemaFile.hash !== schemaChange.hash;
    const kept = new Set(names);
    const removed = [...this.#tables.keys()].filter((name) => !kept.has(name));
    const serializedAt = performance.now();

    const generation = this.#lastAttempt + 1;
    // A new database's files have plain names. Every later file is named after its generation, so that no name is ever used for two contents.
    const stems = assignTableFiles(names, new Map([...this.#tables].map(([name, stored]) => [name, `${tableFileStem(stored.file)}.json`])));
    const tables = new Map<string, StoredFile>();
    for (const name of names) {
      const change = changed.get(name);
      const stem = tableFileStem(stems.get(name) as string);
      tables.set(name, change === undefined ? (this.#tables.get(name) as StoredFile) : { file: creating ? `${stem}.json` : versionedFile(stem, generation), bytes: change.bytes, hash: change.hash });
    }
    const schemaFile: StoredFile = schemaChanged ? { file: creating ? SCHEMA : versionedFile("schema", generation), bytes: schemaChange.bytes, hash: schemaChange.hash } : (this.#schemaFile as StoredFile);

    // Plain-named files that leave the database with this save are listed in its manifest until they are deleted.
    const replaced = [...changed.keys(), ...removed].flatMap((name) => (this.#tables.has(name) ? [(this.#tables.get(name) as StoredFile).file] : []));
    const retiredNames = [...new Set([...this.#retiredNames, ...replaced.filter((file) => !VERSIONED_FILE.test(file))])];
    const head = this.#headOf(DIRECTORY_FORMAT_VERSION, schemaFile.file, tables);
    const manifestText = documentText({
      formatVersion: DIRECTORY_FORMAT_VERSION,
      // A reader of an earlier format cannot read this one.
      minimumReaderVersion: DIRECTORY_FORMAT_VERSION,
      database: this.#name,
      persistence: this.#persistence,
      ...(this.#config !== undefined && { config: this.#config }),
      generation,
      schema: schemaFile.file,
      tables: names.map((name) => ({ name, file: (tables.get(name) as StoredFile).file })),
      ...(retiredNames.length > 0 && { retired: retiredNames }),
      ...(Object.keys(this.#extra).length > 0 && { extra: this.#extra }),
    });
    const manifestBytes = Buffer.byteLength(manifestText, "utf8");

    // The size of the generation that would be published: the files of earlier generations are not part of it.
    const sizeBytes = manifestBytes + schemaFile.bytes + [...tables.values()].reduce((total, stored) => total + stored.bytes, 0);
    assertWithinSizeLimit(sizeBytes, this.#limitBytes, "save", "directory");

    const report: DirectorySaveReport = {
      kind,
      generation: this.#generation,
      published: false,
      serializedTables: givenNames,
      writtenTables: [...changed.keys()],
      reusedTables: names.length - changed.size,
      removedTables: removed,
      schemaWritten: schemaChanged,
      bytesWritten: 0,
      sizeBytes,
      serializeMs: serializedAt - startedAt,
      writeMs: 0,
      publishMs: 0,
      cleanupMs: 0,
      totalMs: 0,
    };
    if (!creating && changed.size === 0 && removed.length === 0 && !schemaChanged && head === this.#manifestHead) {
      // What was given is what is stored.
      this.#finishReport(report, startedAt);
      return;
    }
    // Used up whether or not the save succeeds, so that no file name is ever written twice.
    this.#lastAttempt = generation;

    const written: string[] = [];
    const draftPath = join(this.path, MANIFEST_DRAFT);
    const isNewDirectory = !existsSync(this.path);
    let writtenAt = serializedAt;
    let draft: number | undefined;
    try {
      if (!this.#prepared) {
        mkdirSync(join(this.path, TABLES), { recursive: true });
      }
      // From here until the manifest is in place, no other process saves this database.
      draft = beginSave(this.path);
      this.#refuseForeignManifest(manifestPath);
      this.#removeLeftovers();
      const write = (path: string, text: string, bytes: number): void => {
        // Only once it is created is the file this save's, to remove if the save fails.
        writeNewFile(path, text, bytes, () => written.push(path));
        report.bytesWritten += bytes;
      };
      for (const [name, change] of changed) {
        write(join(this.path, TABLES, (tables.get(name) as StoredFile).file), change.text, change.bytes);
      }
      if (schemaChanged) {
        write(join(this.path, schemaFile.file), schemaChange.text, schemaChange.bytes);
      }
      writtenAt = performance.now();
      const held = draft;
      draft = undefined;
      // Putting the manifest in place is the save.
      publishManifest(this.path, held, manifestText, manifestBytes);
      report.bytesWritten += manifestBytes;
    } catch (cause) {
      if (draft !== undefined) {
        closeSync(draft);
      }
      // Without the draft, which this save holds, another save's draft would be removed.
      for (const leftover of [...(cause instanceof SaveInProgress ? [] : [draftPath]), ...written, ...(isNewDirectory ? [this.path] : [])]) {
        try {
          rmSync(leftover, { recursive: true, force: true });
        } catch {
          // Whatever stays is not part of the database, and is removed by a later save.
        }
      }
      if (cause instanceof JsonStorageError) {
        throw cause;
      }
      const taken = (cause as NodeJS.ErrnoException).code === "EEXIST" ? " A file of the new generation was already there: another process may be saving this database." : "";
      throw new JsonStorageError(`Cannot write database directory: ${this.path}.${taken}`, { cause });
    }
    const publishedAt = performance.now();
    this.#manifestIdentity = fileIdentity(manifestPath);

    const from = Date.now() + this.#graceMs;
    this.#retired.push(
      ...replaced.map((file) => ({ file: `${TABLES}/${file}`, from })),
      ...(schemaChanged && this.#schemaFile !== undefined ? [{ file: this.#schemaFile.file, from }] : []),
    );
    this.#tables = tables;
    this.#schemaFile = schemaFile;
    this.#generation = generation;
    this.#manifestHead = head;
    this.#retiredNames = retiredNames;
    this.#removeRetired();

    report.generation = generation;
    report.published = true;
    report.writeMs = writtenAt - serializedAt;
    report.publishMs = publishedAt - writtenAt;
    report.cleanupMs = performance.now() - publishedAt;
    this.#finishReport(report, startedAt);
    this.#sizes.report(sizeBytes, this.#limitBytes, "save");
  }

  /**
   * The schema as the text of its file. Made once for each set of definitions
   * and types, not for each save. Definitions that this build could not read
   * back are refused here, before anything is written: whatever handed them
   * over has a defect, and a database that cannot be opened again is worse
   * than a save that fails.
   */
  #schemaDocument(): { text: string; bytes: number; hash: string } {
    if (this.#schemaText?.of !== this.#schema || this.#schemaText.types !== this.#types) {
      const text = documentText(toSchemaDocument(this.#schema, this.#types));
      try {
        readSchemaDocument(JSON.parse(text), "The schema that would be written");
      } catch (cause) {
        throw new JsonStorageError(`${this.path} cannot store these table definitions, because it could not read them back. ${cause instanceof Error ? cause.message : String(cause)} Nothing was written.`, { cause });
      }
      this.#schemaText = { of: this.#schema, types: this.#types, text, bytes: Buffer.byteLength(text, "utf8"), hash: hashOf(text) };
    }
    return this.#schemaText;
  }

  #finishReport(report: DirectorySaveReport, startedAt: number): void {
    report.totalMs = performance.now() - startedAt;
    this.#lastSave = report;
    try {
      this.#onSave?.({ ...report });
    } catch {
      // A failing listener must not change the outcome of the save.
    }
  }

  /** What a manifest says apart from its generation and the files awaiting deletion. */
  #headOf(formatVersion: number, schemaFile: string | undefined, tables: ReadonlyMap<string, StoredFile>): string {
    return JSON.stringify([formatVersion, this.#name, this.#persistence, this.#config, schemaFile, [...tables].map(([name, stored]) => [name, stored.file]), this.#extra]);
  }

  /** Refuses to save over a manifest that is not the one this adapter loaded or saved last. */
  #refuseForeignManifest(manifestPath: string): void {
    const found = fileIdentity(manifestPath);
    if (found !== ABSENT && this.#manifestIdentity === ABSENT) {
      throw new JsonStorageError(`${this.path} holds a database that was not loaded here. Load it before saving to it.`);
    }
    if (found !== this.#manifestIdentity) {
      throw new JsonStorageError(
        `${this.path} was saved by something else since it was loaded here: its ${MANIFEST} is not the one this process read or wrote last. ` +
          "One process saves a database at a time. Load the database again; a running sandbox has to be restarted.",
      );
    }
  }

  /**
   * Once, during this adapter's first save: removes what interrupted saves
   * left behind, those of an earlier format included. None of it is part of the database, and
   * no other save is under way that it could belong to.
   */
  #removeLeftovers(): void {
    if (this.#prepared) {
      return;
    }
    this.#prepared = true;
    const active = new Set([...this.#tables.values()].map((stored) => stored.file.toLowerCase()));
    const leftovers: string[] = [];
    for (const entry of readdirSync(this.path)) {
      if (entry.startsWith(STAGING_PREFIX) || (this.#schemaFile !== undefined && SCHEMA_FILE.test(entry) && entry !== this.#schemaFile.file)) {
        leftovers.push(entry);
      }
    }
    for (const entry of readdirSync(join(this.path, TABLES))) {
      if (VERSIONED_FILE.test(entry) && !active.has(entry.toLowerCase())) {
        leftovers.push(`${TABLES}/${entry}`);
      }
    }
    // Plain-named files that an earlier save retired and did not get to delete.
    leftovers.push(...this.#retiredNames.filter((file) => !active.has(file.toLowerCase())).map((file) => `${TABLES}/${file}`));
    this.#retired.push(...leftovers.map((file) => ({ file, from: 0 })));
    this.#removeRetired();
  }

  /** Deletes the retired files whose time has come, and comes back for the others when theirs has. */
  #removeRetired(): void {
    clearTimeout(this.#retiredTimer);
    this.#retiredTimer = undefined;
    this.#forgetRetiredOfAnotherDatabase();
    const now = Date.now();
    const kept: { file: string; from: number }[] = [];
    let next = Number.POSITIVE_INFINITY;
    // The oldest first: those beyond the number that is kept are due whatever their time.
    const excess = this.#retired.length - RETIRED_FILE_LIMIT;
    for (const [index, entry] of this.#retired.entries()) {
      if (entry.from > now && index >= excess) {
        kept.push(entry);
        next = Math.min(next, entry.from);
        continue;
      }
      try {
        rmSync(join(this.path, entry.file), { recursive: true, force: true });
        const name = entry.file.startsWith(`${TABLES}/`) ? entry.file.slice(TABLES.length + 1) : undefined;
        this.#retiredNames = this.#retiredNames.filter((file) => file !== name);
      } catch {
        // Held open by something: tried again whenever files are removed next.
        kept.push({ file: entry.file, from: 0 });
      }
    }
    this.#retired = kept;
    if (Number.isFinite(next)) {
      this.#retiredTimer = setTimeout(() => this.#removeRetired(), next - now + 1);
      // Deleting old files is not a reason to keep the process running.
      this.#retiredTimer.unref();
    }
    if (kept.length === 0) {
      pendingRemovals.delete(this.#removeRetiredNow);
    } else {
      if (!removesPendingAtExit) {
        removesPendingAtExit = true;
        process.once("exit", removePending);
      }
      pendingRemovals.add(this.#removeRetiredNow);
    }
  }

  /**
   * The files to delete are known by name. They are this database's only
   * while its manifest is the one this adapter read or wrote last: the
   * directory may since have been replaced by another database, whose files
   * have the same names.
   */
  #forgetRetiredOfAnotherDatabase(): void {
    if (this.#retired.length > 0 && fileIdentity(join(this.path, MANIFEST)) !== this.#manifestIdentity) {
      this.#retired = [];
    }
  }

  readonly #removeRetiredNow = (): void => {
    this.#forgetRetiredOfAnotherDatabase();
    for (const entry of this.#retired) {
      try {
        rmSync(join(this.path, entry.file), { recursive: true, force: true });
      } catch {
        // Not part of the database; the next process that saves removes it.
      }
    }
    this.#retired = [];
  };
}
