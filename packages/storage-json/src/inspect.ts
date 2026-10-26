import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseStorageOptions } from "./database-storage.ts";
import { MANIFEST, isPlainObject, measureGeneration, parseJson, parseManifest, readText } from "./directory-files.ts";
import type { FormatMigration } from "./format-migration.ts";
import { assessFormat, fileFormatStamp, manifestFormatStamp } from "./format-version.ts";
import type { FormatStatus } from "./format-version.ts";
import { FORMAT_MIGRATIONS } from "./migration-registry.ts";
import { BYTES_PER_MB, DEFAULT_MAX_FILE_SIZE_MB, assertWithinSizeLimit, maxFileSizeMbProblem } from "./size-limits.ts";
import { JsonStorageError } from "./storage-error.ts";

/** What a database is stored as, found without loading its tables and without changing anything. */
export interface DatabaseInspection extends FormatStatus {
  /** The file or directory. */
  path: string;
  /** How many tables the database has. Not known for a format this build does not read. */
  tables?: number;
  /** The size of the files the database consists of now: what the size limit applies to. Not known for a format this build does not read. */
  logicalSizeBytes?: number;
  /** A directory's generation: how many times its state was published. */
  generation?: number;
  /** Other things worth knowing, such as a save that a migration would have to finish first. */
  notes: string[];
}

export interface InspectOptions extends Pick<DatabaseStorageOptions, "maxFileSizeMb"> {
  /** The migrations to plan with. Default: the ones this build has. */
  migrations?: readonly FormatMigration[];
}

/**
 * Says what format the database at `path` has and what this build may do
 * with it. Nothing is written, whatever the format, and of a directory only
 * the manifest is read: the sizes of the other files are taken from the file
 * system. A single file has to be read to find its version, so the size limit
 * applies to it as it does when it is loaded.
 *
 * A database in a format this build does not read is still described, as far
 * as its two version numbers go. Only something that is not a database at
 * all is an error.
 */
export function inspectDatabase(path: string, options: InspectOptions = {}): DatabaseInspection {
  if (options.maxFileSizeMb !== undefined) {
    const problem = maxFileSizeMbProblem(options.maxFileSizeMb, "maxFileSizeMb");
    if (problem !== undefined) {
      throw new JsonStorageError(problem);
    }
  }
  const ceilingBytes = (options.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB) * BYTES_PER_MB;
  const migrations = options.migrations ?? FORMAT_MIGRATIONS;
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    throw new JsonStorageError(`Database not found: ${path}`, { cause });
  }
  return stats.isDirectory() ? inspectDirectory(path, ceilingBytes, migrations) : inspectFile(path, stats.size, ceilingBytes, migrations);
}

function inspectDirectory(path: string, ceilingBytes: number, migrations: readonly FormatMigration[]): DatabaseInspection {
  const manifestPath = join(path, MANIFEST);
  let manifestSize: number;
  try {
    manifestSize = statSync(manifestPath).size;
  } catch (cause) {
    throw new JsonStorageError(`${path} is not a database directory: it has no ${MANIFEST}.`, { cause });
  }
  assertWithinSizeLimit(manifestSize, ceilingBytes, "load", "directory");
  const stored = readText(manifestPath, manifestPath);
  const document = parseJson(stored.text, manifestPath);
  const status = assessFormat("directory", manifestFormatStamp(document, manifestPath), migrations);
  const inspection: DatabaseInspection = { path, ...status, notes: [] };
  if (!status.readable) {
    // What the manifest of such a format means is not known here, and is not guessed.
    return inspection;
  }

  const manifest = parseManifest(document, manifestPath);
  inspection.tables = manifest.tables.length;
  inspection.generation = manifest.generation;
  try {
    inspection.logicalSizeBytes = measureGeneration(path, manifest, stored.bytes);
  } catch (error) {
    inspection.notes.push(error instanceof Error ? error.message : String(error));
  }
  const pending = migrations.find((migration) => migration.storage === "directory" && migration.from === status.formatVersion)?.pending?.(path);
  if (pending !== undefined) {
    inspection.notes.push(`The directory holds ${pending}. It cannot be read until that is finished, which a migration does first.`);
  }
  return inspection;
}

function inspectFile(path: string, sizeBytes: number, ceilingBytes: number, migrations: readonly FormatMigration[]): DatabaseInspection {
  assertWithinSizeLimit(sizeBytes, ceilingBytes, "load");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new JsonStorageError(`Cannot read database file: ${path}`, { cause });
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new JsonStorageError(`Database file is not valid JSON: ${path}`, { cause });
  }
  if (!isPlainObject(document)) {
    throw new JsonStorageError("Database file must contain a JSON object.");
  }
  const status = assessFormat("file", fileFormatStamp(document.$meta), migrations);
  const inspection: DatabaseInspection = { path, ...status, logicalSizeBytes: sizeBytes, notes: [] };
  if (!status.declared) {
    inspection.notes.push('The file states no version ("$meta"). A single-file database without one has format 1, and states it from its next save on.');
  }
  if (status.readable) {
    if (!isPlainObject(document.data)) {
      throw new JsonStorageError('"data" must be an object mapping collection names to arrays.');
    }
    inspection.tables = Object.keys(document.data).length;
  }
  return inspection;
}
