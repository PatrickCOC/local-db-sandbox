import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseContents, DatabaseFormat, DatabaseStorage, DatabaseStorageOptions } from "./database-storage.ts";
import { DirectoryStorageAdapter } from "./directory-storage-adapter.ts";
import { CURRENT_FORMAT_VERSION } from "./format-version.ts";
import { JsonStorageAdapter } from "./json-storage-adapter.ts";
import { JsonStorageError } from "./storage-error.ts";

const SINGLE_FILE = /\.json$/i;

/**
 * The format of the database at `path`: what is there decides, and for a
 * path that does not exist yet, its name does (`.json` is a single file,
 * anything else a directory).
 */
export function databaseFormatFor(path: string): DatabaseFormat {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return SINGLE_FILE.test(path) ? "file" : "directory";
  }
}

/** The storage for an existing database, whichever format it has. */
export function openDatabaseStorage(path: string, options: DatabaseStorageOptions = {}): DatabaseStorage {
  if (!existsSync(path) && !SINGLE_FILE.test(path)) {
    throw new JsonStorageError(`Database not found: ${path}`);
  }
  // A missing .json file is reported by the single-file adapter when it is loaded.
  return databaseFormatFor(path) === "directory" ? new DirectoryStorageAdapter(path, options) : new JsonStorageAdapter(path, options);
}

export interface CreateDatabaseOptions extends DatabaseStorageOptions {
  /** Default: decided by the path, as `databaseFormatFor` does. */
  format?: DatabaseFormat;
  /** Replace a database that is already there. Anything else in the way is never replaced. */
  overwrite?: boolean;
}

/** Writes a new database with the given rows and metadata, in the format this build writes, and returns its storage. */
export async function createDatabase(path: string, contents: DatabaseContents, options: CreateDatabaseOptions = {}): Promise<DatabaseStorage> {
  const format = options.format ?? databaseFormatFor(path);
  let replaces = false;
  if (existsSync(path)) {
    const found: DatabaseFormat = statSync(path).isDirectory() ? "directory" : "file";
    if (found !== format) {
      throw new JsonStorageError(`${path} is a ${found}, so a ${format === "directory" ? "directory" : "single-file"} database cannot be written there.`);
    }
    const isDatabase = format === "file" || existsSync(join(path, "manifest.json"));
    if (!isDatabase && readdirSync(path).length > 0) {
      throw new JsonStorageError(`${path} exists and is not a database directory. Choose a path that does not exist yet.`);
    }
    if (isDatabase && options.overwrite !== true) {
      throw new JsonStorageError(`${path} already exists.`);
    }
    replaces = isDatabase && format === "directory";
  }

  const { collections, ...metadata } = contents;
  const storage = format === "directory" ? new DirectoryStorageAdapter(path, options) : new JsonStorageAdapter(path, options);
  if (replaces) {
    // So that the files of tables that are not kept are removed with the save.
    await storage.load();
  }
  storage.initialize(metadata);
  await storage.save({ meta: { version: CURRENT_FORMAT_VERSION[format] }, collections });
  return storage;
}
