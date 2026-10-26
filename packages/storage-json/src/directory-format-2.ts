import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST, SCHEMA, TABLES, isPlainObject, isRunning, parseJson, readText } from "./directory-files.ts";
import type { FormatMigration } from "./format-migration.ts";
import { JsonStorageError } from "./storage-error.ts";

/*
 * Directory format 2, and the migration from it to format 3. Everything this
 * build knows about format 2 that format 3 does not share is in this file.
 *
 * Format 2 was a manifest, a schema, and one plain-named file per table:
 *
 *   { "formatVersion": 2, "database", "persistence", "config", "tables": [{ "name", "file" }], "extra" }
 *
 * A save replaced files in place. It staged its files in `.staging-<pid>-<n>/`,
 * committed by writing `.commit.json` (which lists the staged files to move
 * and the files to remove), moved them into place, and removed the record.
 * A reader that found the record finished the move first.
 *
 * Format 3 keeps the same files and changes how they are replaced: a table
 * file is never changed again, and a save is the replacement of the manifest.
 * So the migration writes a manifest and nothing else.
 */

/** Present from the moment a format 2 save was committed until all of its files were in place. */
const COMMIT_MARKER = ".commit.json";
/** Held the files of such a save until they were put in place. */
const STAGING_PREFIX = ".staging-";
const MANAGED_FILE = /^(manifest\.json|schema\.json|tables\/[A-Za-z0-9_%~-]+\.json)$/;

interface Commit {
  staging: string;
  files: string[];
  remove: string[];
}

function readCommit(directory: string): Commit | undefined {
  const markerPath = join(directory, COMMIT_MARKER);
  if (!existsSync(markerPath)) {
    return undefined;
  }
  let marker: Partial<Commit>;
  try {
    marker = parseJson(readText(markerPath, markerPath).text, markerPath) as Partial<Commit>;
  } catch (error) {
    // Removed since it was looked for: its save has been finished.
    if (!existsSync(markerPath)) {
      return undefined;
    }
    throw error;
  }
  const paths = [...(Array.isArray(marker.files) ? marker.files : [null]), ...(Array.isArray(marker.remove) ? marker.remove : [null])];
  if (typeof marker.staging !== "string" || !/^\.staging-[\w-]+$/.test(marker.staging) || paths.some((path) => typeof path !== "string" || !MANAGED_FILE.test(path))) {
    throw new JsonStorageError(`${markerPath} is not a commit record this version can read. The database directory may be damaged.`);
  }
  return marker as Commit;
}

/** The process that made a commit, when it is another one and still runs: the save is its own to finish. */
function runningOwner(commit: Commit): number | undefined {
  const pid = Number(commit.staging.slice(STAGING_PREFIX.length).split("-")[0]);
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isRunning(pid) ? pid : undefined;
}

/** Describes a save that was committed and whose files are not all in place; `undefined` when there is none. */
function pendingSave(directory: string): string | undefined {
  const commit = readCommit(directory);
  if (commit === undefined) {
    return undefined;
  }
  const count = (items: string[], noun: string): string => `${items.length} ${noun}${items.length === 1 ? "" : "s"}`;
  return `a save that a format 2 build committed and did not finish putting in place (${count(commit.files, "file")} to move, ${count(commit.remove, "file")} to remove)`;
}

/**
 * Puts the files of a committed save in place. This is format 2's own way of
 * completing a save, not a change to the database: the save has happened,
 * and the files are what it consists of.
 */
function finishSave(directory: string): void {
  const commit = readCommit(directory);
  if (commit === undefined) {
    return;
  }
  const owner = runningOwner(commit);
  if (owner !== undefined) {
    throw new JsonStorageError(`${directory} is being saved by a format 2 build right now (pid ${owner}). Stop that process, then migrate.`);
  }

  let finished = true;
  try {
    mkdirSync(join(directory, TABLES), { recursive: true });
  } catch {
    finished = false;
  }
  for (const file of commit.files) {
    const staged = join(directory, commit.staging, file);
    try {
      renameSync(staged, join(directory, file));
    } catch {
      // A file that is no longer staged is already in place; anything else is still to do.
      if (existsSync(staged)) {
        finished = false;
      }
    }
  }
  for (const file of commit.remove) {
    try {
      rmSync(join(directory, file), { force: true });
    } catch {
      finished = false;
    }
  }
  if (!finished) {
    throw new JsonStorageError(
      `The last save of ${directory}, made by a format 2 build, is not finished: one of its files could not be put in place. Close whatever holds the database's files open, then migrate again.`,
    );
  }
  rmSync(join(directory, COMMIT_MARKER), { force: true });
  rmSync(join(directory, commit.staging), { recursive: true, force: true });
}

export const directoryFormat2To3: FormatMigration = {
  storage: "directory",
  from: 2,
  to: 3,
  summary: "The manifest gains a generation and names the schema file. Table files stay where they are and are never changed again: a later save writes a new file for each table it changes and replaces the manifest.",
  pending: pendingSave,
  recover: finishSave,

  transform({ directory, manifest }) {
    // The keys of a format 2 manifest; `parseManifest` checks their values when the engine reads the result.
    const { formatVersion, database, persistence, config, tables, extra, ...unknown } = manifest;
    const unexpected = Object.keys(unknown)[0];
    if (formatVersion !== 2 || unexpected !== undefined) {
      throw new JsonStorageError(
        formatVersion !== 2
          ? `${join(directory, MANIFEST)} is not a format 2 manifest.`
          : `${join(directory, MANIFEST)} has the key "${unexpected}", which a format 2 manifest does not have. It is not migrated, because what the key means is not known.`,
      );
    }
    const tableCount = Array.isArray(tables) ? tables.length : 0;
    const hasSchema = existsSync(join(directory, SCHEMA));
    // What an interrupted save staged and did not commit. It was never part of the database.
    const leftovers = readdirSync(directory).filter((entry) => entry.startsWith(STAGING_PREFIX));
    return {
      manifest: {
        formatVersion: 3,
        minimumReaderVersion: 3,
        ...(database !== undefined && { database }),
        persistence: persistence ?? "json",
        ...(config !== undefined && { config }),
        generation: 1,
        ...(hasSchema && { schema: SCHEMA }),
        tables,
        ...(isPlainObject(extra) && Object.keys(extra).length > 0 && { extra }),
      },
      write: {},
      remove: leftovers,
      changes: [
        `${MANIFEST}: formatVersion 2 -> 3; adds minimumReaderVersion 3, generation 1${hasSchema ? `, and schema "${SCHEMA}"` : ""}`,
        hasSchema ? `${SCHEMA}: kept as it is` : `${SCHEMA}: there is none; the table definitions are written with the next save that has any`,
        `${TABLES}/: ${tableCount} table ${tableCount === 1 ? "file" : "files"} kept as ${tableCount === 1 ? "it is" : "they are"}`,
        ...(leftovers.length > 0 ? [`removed: ${leftovers.join(", ")} (left by a save that was interrupted before it committed; never part of the database)`] : []),
      ],
    };
  },
};
