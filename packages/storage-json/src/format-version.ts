import type { DatabaseFormat } from "./database-storage.ts";
import { JsonStorageError } from "./storage-error.ts";

/*
 * The format of a stored database has a version.
 *
 * It is a whole number that says how the database is laid out on disk, and it
 * is counted per kind of storage: a single file has had one format (1), a
 * directory four (2, 3, 4, and 5). It is not the package's version. A package release
 * that does not change how databases are stored does not change it, and one
 * build reads and migrates several of them.
 *
 * A database states two numbers:
 *
 *   formatVersion          the format it was written in
 *   minimumReaderVersion   the oldest format whose readers read it correctly;
 *                          equal to formatVersion unless a format was made so
 *                          that readers of an earlier one still can
 *
 * and a build has one number per kind of storage, the format it writes
 * (`CURRENT_FORMAT_VERSION`). From those, `assessFormat` decides what the
 * build may do with the database. Nothing else in the storage code decides it.
 */

/** The format this build writes, per kind of storage. It writes no other. */
export const CURRENT_FORMAT_VERSION: Readonly<Record<DatabaseFormat, number>> = { file: 1, directory: 5 };

export interface FormatDescription {
  version: number;
  summary: string;
}

/** Every format a database of each kind has had, oldest first. */
export const FORMAT_HISTORY: Readonly<Record<DatabaseFormat, readonly FormatDescription[]>> = {
  file: [{ version: 1, summary: 'One JSON document: "$meta", "$config", "$tableSchema" (optional), and "data". Written as a whole.' }],
  directory: [
    { version: 2, summary: "manifest.json, schema.json, and one plain-named file per table. A save staged its files and moved them into place." },
    { version: 3, summary: "Table files are never changed: a save writes new files, named after its generation, and replaces manifest.json." },
    { version: 4, summary: "As format 3; the schema file may also hold constraints and indexes with their names, enumerated types, computed defaults, canonical types, and provenance." },
    { version: 5, summary: "As format 4; the schema file may also hold how an index is built and what its keys are, deferrable constraints, clauses of the source that the schema has no place for, and what the text of an expression names." },
  ],
};

/** What a stored database says about its own format. */
export interface FormatStamp {
  formatVersion: number;
  minimumReaderVersion: number;
  /** False when the database states no version and is read by the rule for such databases. */
  declared: boolean;
}

/** A migration, as far as versions go. */
export interface MigrationEdge {
  storage: DatabaseFormat;
  from: number;
  to: number;
}

/**
 * - `current`: the format this build writes.
 * - `older`: an earlier format that this build reads and can migrate.
 * - `newer`: a later format that says readers of this build's format can read it.
 * - `unsupported-old`: an earlier format from which no migration of this build leads.
 * - `unsupported-new`: a later format that this build cannot read.
 */
export type FormatCompatibility = "current" | "older" | "newer" | "unsupported-old" | "unsupported-new";

/** A database's format, and what this build may do with it. */
export interface FormatStatus extends FormatStamp {
  storage: DatabaseFormat;
  /** The format this build writes for this kind of storage. */
  currentVersion: number;
  /** The oldest format this build reads and migrates. */
  oldestSupportedVersion: number;
  compatibility: FormatCompatibility;
  /** Whether this build reads the database. Reading never changes it. */
  readable: boolean;
  /** Whether this build saves to the database. Only a database of the current format is written to. */
  writable: boolean;
  /** Whether the database has to be migrated before this build saves to it. */
  migrationRequired: boolean;
  /** The formats a migration to the current one passes through, both ends included. Empty when none is needed or none exists. */
  migrationPath: number[];
}

/**
 * The formats a migration from `from` to `to` passes through, both ends
 * included, by the fewest steps; `undefined` when the migrations do not lead
 * there.
 */
export function findMigrationPath(migrations: readonly MigrationEdge[], storage: DatabaseFormat, from: number, to: number): number[] | undefined {
  const paths = new Map<number, number[]>([[from, [from]]]);
  for (const queue = [from]; queue.length > 0; ) {
    const version = queue.shift() as number;
    const path = paths.get(version) as number[];
    if (version === to) {
      return path;
    }
    for (const migration of migrations) {
      if (migration.storage === storage && migration.from === version && !paths.has(migration.to)) {
        paths.set(migration.to, [...path, migration.to]);
        queue.push(migration.to);
      }
    }
  }
  return undefined;
}

/** The oldest format from which the migrations lead to the current one. */
function oldestSupported(migrations: readonly MigrationEdge[], storage: DatabaseFormat): number {
  const current = CURRENT_FORMAT_VERSION[storage];
  const sources = migrations.filter((migration) => migration.storage === storage).map((migration) => migration.from);
  return Math.min(current, ...sources.filter((version) => findMigrationPath(migrations, storage, version, current) !== undefined));
}

/** What this build may do with a database of the given format, with the given migrations at hand. */
export function assessFormat(storage: DatabaseFormat, stamp: FormatStamp, migrations: readonly MigrationEdge[]): FormatStatus {
  const currentVersion = CURRENT_FORMAT_VERSION[storage];
  const status = { ...stamp, storage, currentVersion, oldestSupportedVersion: oldestSupported(migrations, storage) };
  if (stamp.formatVersion === currentVersion) {
    return { ...status, compatibility: "current", readable: true, writable: true, migrationRequired: false, migrationPath: [] };
  }
  if (stamp.formatVersion > currentVersion) {
    // Whether a later format can be read is for the database to say; it is never worked out here.
    const readable = stamp.minimumReaderVersion <= currentVersion;
    return { ...status, compatibility: readable ? "newer" : "unsupported-new", readable, writable: false, migrationRequired: false, migrationPath: [] };
  }
  const migrationPath = findMigrationPath(migrations, storage, stamp.formatVersion, currentVersion);
  return migrationPath === undefined
    ? { ...status, compatibility: "unsupported-old", readable: false, writable: false, migrationRequired: true, migrationPath: [] }
    : { ...status, compatibility: "older", readable: true, writable: false, migrationRequired: true, migrationPath };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function minimumReaderOf(value: unknown, formatVersion: number, where: string): number {
  if (value === undefined) {
    return formatVersion;
  }
  if (!isVersion(value) || value > formatVersion) {
    throw new JsonStorageError(`"minimumReaderVersion" in ${where} must be a whole number from 1 to the format version (${formatVersion}).`);
  }
  return value;
}

/** What a directory's manifest says about its format. Only these two keys are looked at, so that it can be asked of any manifest. */
export function manifestFormatStamp(manifest: unknown, where: string): FormatStamp {
  if (!isPlainObject(manifest)) {
    throw new JsonStorageError(`${where} must contain a JSON object.`);
  }
  if (!isVersion(manifest.formatVersion)) {
    throw new JsonStorageError(`${where} has no usable "formatVersion" (${JSON.stringify(manifest.formatVersion) ?? "none"}): it must be a whole number, 1 or more.`);
  }
  return { formatVersion: manifest.formatVersion, minimumReaderVersion: minimumReaderOf(manifest.minimumReaderVersion, manifest.formatVersion, where), declared: true };
}

/**
 * What the `$meta` of a single-file database says about its format.
 *
 * The rule for files that state no version: a single-file database without
 * `$meta` has format 1. Format 1 is the only format that was ever written
 * without one, so there is nothing else such a file could be.
 */
export function fileFormatStamp($meta: unknown): FormatStamp {
  if ($meta === undefined) {
    return { formatVersion: 1, minimumReaderVersion: 1, declared: false };
  }
  if (!isPlainObject($meta) || typeof $meta.version !== "number") {
    throw new JsonStorageError('"$meta" must be an object with a numeric "version".');
  }
  if (!isVersion($meta.version)) {
    throw new JsonStorageError('"version" in "$meta" must be a whole number, 1 or more.');
  }
  return { formatVersion: $meta.version, minimumReaderVersion: minimumReaderOf($meta.minimumReaderVersion, $meta.version, '"$meta"'), declared: true };
}

export type DatabaseFormatErrorCode = "DATABASE_FORMAT_TOO_NEW" | "DATABASE_FORMAT_TOO_OLD" | "DATABASE_MIGRATION_REQUIRED" | "DATABASE_FORMAT_READ_ONLY";

/** Raised when a database's format does not allow what was asked of it. Nothing was changed. */
export class DatabaseFormatError extends JsonStorageError {
  readonly code: DatabaseFormatErrorCode;
  readonly status: FormatStatus;

  constructor(message: string, code: DatabaseFormatErrorCode, status: FormatStatus) {
    super(message);
    this.name = "DatabaseFormatError";
    this.code = code;
    this.status = status;
  }
}

const UPGRADE = "Upgrade local-db-sandbox.";

/** How to bring the database at `path` to the current format. */
export function migrateCommand(path: string): string {
  return `local-db-sandbox migrate ${/\s/.test(path) ? JSON.stringify(path) : path}`;
}

/** Why this build does not read a database of this format; `undefined` when it does. */
export function readProblem(status: FormatStatus): { code: DatabaseFormatErrorCode; message: string } | undefined {
  if (status.compatibility === "unsupported-new") {
    return { code: "DATABASE_FORMAT_TOO_NEW", message: `Database format ${status.formatVersion} is newer than this build supports (max ${status.currentVersion}). ${UPGRADE}` };
  }
  if (status.compatibility === "unsupported-old") {
    return {
      code: "DATABASE_FORMAT_TOO_OLD",
      message:
        `Database format ${status.formatVersion} is older than this build supports (oldest: ${status.oldestSupportedVersion}). ` +
        `Migrate it with an earlier version of local-db-sandbox, one that reads format ${status.formatVersion}, and then with this one.`,
    };
  }
  return undefined;
}

/** Why this build does not save to the database at `path`; `undefined` when it does. */
export function writeProblem(status: FormatStatus, path: string): { code: DatabaseFormatErrorCode; message: string } | undefined {
  if (status.compatibility === "older") {
    return {
      code: "DATABASE_MIGRATION_REQUIRED",
      message:
        `Database format ${status.formatVersion} is older than the format this build writes (${status.currentVersion}). ` +
        `It can be read as it is, and was not changed. To change it, migrate it first: ${migrateCommand(path)}`,
    };
  }
  if (status.compatibility === "newer") {
    return {
      code: "DATABASE_FORMAT_READ_ONLY",
      message:
        `Database format ${status.formatVersion} is newer than this build supports (max ${status.currentVersion}). ` +
        `It says that a reader of format ${status.minimumReaderVersion} can read it, so it was read, but it cannot be changed by this build. ${UPGRADE}`,
    };
  }
  return readProblem(status);
}

/** Throws when this build does not read a database of this format. */
export function assertReadableFormat(status: FormatStatus, path: string): void {
  const problem = readProblem(status);
  if (problem !== undefined) {
    throw new DatabaseFormatError(`${path}: ${problem.message}`, problem.code, status);
  }
}

/** Throws when this build does not save to a database of this format. */
export function assertWritableFormat(status: FormatStatus, path: string): void {
  const problem = writeProblem(status, path);
  if (problem !== undefined) {
    throw new DatabaseFormatError(`${path}: ${problem.message}`, problem.code, status);
  }
}

/**
 * One line for whoever opened a database without saving to it, when this
 * build would not save to it; `undefined` for a database of the current format.
 */
export function formatNotice(status: FormatStatus, path: string): string | undefined {
  if (status.compatibility === "older") {
    return `${path} has database format ${status.formatVersion}; this build writes format ${status.currentVersion}. It is read as it is and not changed. To bring it up to date: ${migrateCommand(path)}`;
  }
  if (status.compatibility === "newer") {
    return `${path} has database format ${status.formatVersion}, which is newer than this build supports (max ${status.currentVersion}). It is read, and cannot be changed by this build. ${UPGRADE}`;
  }
  return undefined;
}
