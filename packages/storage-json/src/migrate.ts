import { closeSync, rmSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SandboxLimitError } from "../../core/src/index.ts";
import type { DatabaseContents, DatabaseFormat, DatabaseStorageOptions } from "./database-storage.ts";
import { MANIFEST, MANIFEST_DRAFT, TABLES, beginSave, documentText, fileIdentity, isPlainObject, parseJson, parseManifest, publishManifest, readGeneration, readText, writeNewFile } from "./directory-files.ts";
import type { Generation, Manifest } from "./directory-files.ts";
import type { DirectoryMigrationOutput, FormatMigration } from "./format-migration.ts";
import { DatabaseFormatError, findMigrationPath, manifestFormatStamp, readProblem } from "./format-version.ts";
import { inspectDatabase } from "./inspect.ts";
import type { DatabaseInspection } from "./inspect.ts";
import { FORMAT_MIGRATIONS } from "./migration-registry.ts";
import { sameDatabaseSchema } from "./schema-document.ts";
import { BYTES_PER_MB, DEFAULT_MAX_FILE_SIZE_MB, formatMb } from "./size-limits.ts";
import { JsonStorageError } from "./storage-error.ts";

/*
 * The migration engine: works out which migrations lead from a database's
 * format to the one asked for, and runs them.
 *
 * Each step is published the way a save is: by replacing manifest.json, in
 * one rename, while holding the lock that keeps two processes from saving.
 * Until that rename the database is its old format, complete and unchanged;
 * after it, it is the new format, complete. There is no state in between, so
 * a migration that fails or is killed leaves one or the other, and a process
 * that reads the database meanwhile gets one or the other.
 *
 * A path of several steps is several such publications. Stopped between two
 * of them, the database is in the format of the step that was reached, which
 * is a format in its own right and from which a later run goes on.
 */

export interface MigrationStepReport {
  from: number;
  to: number;
  /** What the step is, whatever the database. */
  summary: string;
  /**
   * What the step changes in this database. Known for a step that was run,
   * and for the first step of a plan; a later step of a plan starts from a
   * state that does not exist yet, and has none.
   */
  changes: string[];
  status: "planned" | "applied";
}

export interface MigrationReport {
  path: string;
  storage: DatabaseFormat;
  /** The format the database had before. */
  formatVersion: number;
  /** The format that was asked for: the current one unless `to` was given. */
  targetVersion: number;
  /** The format this build writes. */
  currentVersion: number;
  /** The formats the migration passes through, both ends included. Empty when the database has the target format already. */
  migrationPath: number[];
  steps: MigrationStepReport[];
  dryRun: boolean;
  /** Whether the database was changed. */
  migrated: boolean;
  /** Tables and rows that were read back from the result and compared with the source. Only after a migration that ran. */
  tables?: number;
  rows?: number;
}

/** `prepared`: the result is written and checked, and is published next. `published`: it is the database; what remains is removing what is no longer part of it. */
export interface MigrationProgress {
  from: number;
  to: number;
  phase: "prepared" | "published";
}

export interface MigrationOptions extends Pick<DatabaseStorageOptions, "maxFileSizeMb"> {
  /** The format to migrate to. Default: the current one. */
  to?: number;
  /** Work out and report what would be done, and change nothing. */
  dryRun?: boolean;
  /** The migrations to use. Default: the ones this build has. */
  migrations?: readonly FormatMigration[];
  /** Told as each step reaches the points between which it is published. */
  onProgress?: (progress: MigrationProgress) => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The steps from the database's format to the target, or the reason why there are none. */
function stepsFor(inspection: DatabaseInspection, to: number | undefined, migrations: readonly FormatMigration[]): { target: number; path: number[]; steps: FormatMigration[] } {
  const { path, storage, formatVersion, currentVersion } = inspection;
  const target = to ?? currentVersion;
  if (!Number.isSafeInteger(target) || target < 1) {
    throw new JsonStorageError("The format to migrate to must be a whole number, 1 or more.");
  }
  if (target > currentVersion) {
    throw new JsonStorageError(`This build migrates a ${storage === "directory" ? "database directory" : "single-file database"} up to format ${currentVersion}; it does not know format ${target}.`);
  }
  if (formatVersion > currentVersion) {
    throw new DatabaseFormatError(`${path}: Database format ${formatVersion} is newer than this build supports (max ${currentVersion}). Upgrade local-db-sandbox.`, "DATABASE_FORMAT_TOO_NEW", inspection);
  }
  if (target === formatVersion) {
    return { target, path: [], steps: [] };
  }
  if (target < formatVersion) {
    throw new JsonStorageError(`${path} has format ${formatVersion}. A database is not taken back to an earlier format (${target}).`);
  }
  const problem = readProblem(inspection);
  if (problem !== undefined) {
    throw new DatabaseFormatError(`${path}: ${problem.message}`, problem.code, inspection);
  }
  const versions = findMigrationPath(migrations, storage, formatVersion, target);
  if (versions === undefined) {
    throw new JsonStorageError(`${path}: no migration of this build leads from format ${formatVersion} to format ${target}.`);
  }
  const steps = versions.slice(1).map((version, index) => migrations.find((migration) => migration.storage === storage && migration.from === versions[index] && migration.to === version) as FormatMigration);
  return { target, path: versions, steps };
}

/** What a step would change in the database as it is stored now. Reads, and changes nothing. */
function plannedChanges(directory: string, migration: FormatMigration): string[] {
  const pending = migration.pending?.(directory);
  if (pending !== undefined) {
    // What the step starts from is only there once this is finished.
    return [`first, ${pending} is finished`, `then: ${migration.summary}`];
  }
  const manifestPath = join(directory, MANIFEST);
  const manifest = parseJson(readText(manifestPath, manifestPath).text, manifestPath);
  try {
    return isPlainObject(manifest) ? migration.transform({ directory, manifest }).changes : [];
  } catch (cause) {
    throw new JsonStorageError(`${directory} cannot be migrated from format ${migration.from} to format ${migration.to}: ${describe(cause)}`, { cause });
  }
}

function contentsOf(manifest: Manifest, generation: Generation): DatabaseContents {
  return {
    collections: generation.collections,
    ...(generation.schema.length > 0 && { schema: generation.schema }),
    ...(generation.types.enums.length > 0 && { types: generation.types }),
    ...(manifest.config !== undefined && { config: manifest.config }),
    persistence: manifest.persistence,
    ...(manifest.name !== undefined && { name: manifest.name }),
    ...(Object.keys(manifest.extra).length > 0 && { extra: manifest.extra }),
  };
}

/** The check of a step that changes how a database is stored and nothing of what it stores. */
function assertSameContents(before: DatabaseContents, after: DatabaseContents): void {
  const [tablesBefore, tablesAfter] = [Object.keys(before.collections), Object.keys(after.collections)];
  if (!isDeepStrictEqual(tablesBefore, tablesAfter)) {
    throw new JsonStorageError(`the result has the tables ${tablesAfter.join(", ") || "(none)"} where the database has ${tablesBefore.join(", ") || "(none)"}`);
  }
  const differing = tablesBefore.find((name) => !isDeepStrictEqual(before.collections[name], after.collections[name]));
  if (differing !== undefined) {
    throw new JsonStorageError(`the rows of table "${differing}" are not the same in the result`);
  }
  if (!sameDatabaseSchema({ tables: before.schema, types: before.types }, { tables: after.schema, types: after.types })) {
    throw new JsonStorageError("the table definitions are not the same in the result");
  }
  for (const key of ["config", "persistence", "name", "extra"] as const) {
    if (!isDeepStrictEqual(before[key], after[key])) {
      throw new JsonStorageError(`"${key}" is not the same in the result`);
    }
  }
}

/** The place of a file a migration writes or removes: inside the directory, and not one of the two files the engine itself puts in place. */
function placeWithin(directory: string, file: string): string {
  const relative = normalize(file);
  if (isAbsolute(relative) || relative === "." || relative.split(sep).includes("..") || relative === MANIFEST || relative === MANIFEST_DRAFT) {
    throw new JsonStorageError(`a migration may not write or remove ${JSON.stringify(file)}`);
  }
  return join(directory, relative);
}

/** Runs one step on a directory database and publishes it. Returns what it changed and what was read back. */
function applyStep(directory: string, migration: FormatMigration, ceilingBytes: number, onProgress: MigrationOptions["onProgress"]): { changes: string[]; tables: number; rows: number } {
  const manifestPath = join(directory, MANIFEST);
  const step = { from: migration.from, to: migration.to };
  // From here until the manifest is in place, nothing else saves this database.
  let draft: number | undefined = beginSave(directory);
  const written: string[] = [];
  let output: DirectoryMigrationOutput;
  let after: Generation;
  try {
    migration.recover?.(directory);
    const stored = readText(manifestPath, manifestPath);
    const document = parseJson(stored.text, manifestPath);
    if (!isPlainObject(document) || manifestFormatStamp(document, manifestPath).formatVersion !== migration.from) {
      throw new JsonStorageError(`its ${MANIFEST} no longer says format ${migration.from}: something else changed it`);
    }
    const sourceManifest = parseManifest(document, manifestPath);
    const before = readGeneration(directory, sourceManifest, stored.bytes, ceilingBytes);

    output = migration.transform({ directory, manifest: document });
    const removals = output.remove.map((file) => placeWithin(directory, file));
    for (const [file, text] of Object.entries(output.write)) {
      const path = placeWithin(directory, file);
      writeNewFile(path, text, Buffer.byteLength(text, "utf8"), () => written.push(path));
    }

    // Read the result back as a reader of the target format will, before it is the database.
    const manifestText = documentText(output.manifest);
    const manifestBytes = Buffer.byteLength(manifestText, "utf8");
    const resultName = `the format ${migration.to} manifest`;
    const targetManifest = parseManifest(output.manifest, resultName);
    if (targetManifest.formatVersion !== migration.to) {
      throw new JsonStorageError(`${resultName} says format ${targetManifest.formatVersion}`);
    }
    try {
      after = readGeneration(directory, targetManifest, manifestBytes, ceilingBytes);
    } catch (error) {
      // The size limit is part of this: a result that could not be loaded is not published.
      if (error instanceof SandboxLimitError) {
        throw new SandboxLimitError(
          `In format ${migration.to}, ${directory} would be ${formatMb(error.sizeBytes)}, above its limit of ${formatMb(error.limitBytes)}. It was not migrated, and is still format ${migration.from}. Raise the limit, or reduce the database.`,
          error.sizeBytes,
          error.limitBytes,
        );
      }
      throw error;
    }
    (migration.verify ?? assertSameContents)(contentsOf(sourceManifest, before), contentsOf(targetManifest, after));
    const stillNeeded = removals.find((path) => [...after.tables.values()].some((stored) => join(directory, TABLES, stored.file) === path) || (after.schemaFile !== undefined && join(directory, after.schemaFile.file) === path));
    if (stillNeeded !== undefined) {
      throw new JsonStorageError(`the migration would remove ${stillNeeded}, which the result consists of`);
    }
    if (fileIdentity(manifestPath) !== stored.identity) {
      throw new JsonStorageError(`its ${MANIFEST} was replaced while the migration was prepared: something else is saving it`);
    }

    onProgress?.({ ...step, phase: "prepared" });
    const held = draft;
    draft = undefined;
    // This rename is the migration.
    publishManifest(directory, held, manifestText, manifestBytes);
  } catch (cause) {
    if (draft !== undefined) {
      closeSync(draft);
    }
    for (const leftover of [join(directory, MANIFEST_DRAFT), ...written]) {
      try {
        rmSync(leftover, { force: true });
      } catch {
        // Whatever stays is not part of the database, and is removed by a later save.
      }
    }
    if (cause instanceof DatabaseFormatError || cause instanceof SandboxLimitError) {
      throw cause;
    }
    throw new JsonStorageError(`${directory} was not migrated from format ${migration.from} to format ${migration.to}: ${describe(cause).replace(/\.$/, "")}. It is still format ${migration.from}.`, { cause });
  }
  onProgress?.({ ...step, phase: "published" });

  for (const file of output.remove) {
    try {
      rmSync(placeWithin(directory, file), { recursive: true, force: true });
    } catch {
      // Not part of the database; the next save that finds it removes it.
    }
  }
  return { changes: output.changes, tables: after.tables.size, rows: Object.values(after.collections).reduce((total, rows) => total + rows.length, 0) };
}

/** What migrating the database at `path` would do. Reads the database's format and changes nothing. */
export function planMigration(path: string, options: Omit<MigrationOptions, "dryRun" | "onProgress"> = {}): MigrationReport {
  return plan(path, options, true);
}

/** The plan, with or without what its first step would change. A migration that is about to run finds that out by running. */
function plan(path: string, options: Omit<MigrationOptions, "dryRun" | "onProgress">, withChanges: boolean): MigrationReport {
  const migrations = options.migrations ?? FORMAT_MIGRATIONS;
  const inspection = inspectDatabase(path, { maxFileSizeMb: options.maxFileSizeMb, migrations });
  const { target, path: migrationPath, steps } = stepsFor(inspection, options.to, migrations);
  return {
    path,
    storage: inspection.storage,
    formatVersion: inspection.formatVersion,
    targetVersion: target,
    currentVersion: inspection.currentVersion,
    migrationPath,
    steps: steps.map((migration, index) => ({
      from: migration.from,
      to: migration.to,
      summary: migration.summary,
      changes: withChanges && index === 0 ? plannedChanges(path, migration) : [],
      status: "planned",
    })),
    dryRun: true,
    migrated: false,
  };
}

/**
 * Brings the database at `path` to the current format, or to `to`. A
 * database that has that format already is left alone, so running this
 * again does nothing. With `dryRun`, reports what would be done.
 *
 * No copy of the database is made. A step that would lose something that
 * the files it keeps do not hold would have to say so and keep it; none does.
 */
export function migrateDatabase(path: string, options: MigrationOptions = {}): MigrationReport {
  const planned = plan(path, options, options.dryRun === true);
  if (options.dryRun === true || planned.steps.length === 0) {
    return { ...planned, dryRun: options.dryRun === true };
  }
  const migrations = options.migrations ?? FORMAT_MIGRATIONS;
  const ceilingBytes = (options.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB) * BYTES_PER_MB;
  const report: MigrationReport = { ...planned, dryRun: false, steps: planned.steps.map((step) => ({ ...step })) };
  for (const step of report.steps) {
    const migration = migrations.find((candidate) => candidate.storage === planned.storage && candidate.from === step.from && candidate.to === step.to) as FormatMigration;
    const applied = applyStep(path, migration, ceilingBytes, options.onProgress);
    Object.assign(step, { changes: applied.changes, status: "applied" });
    report.migrated = true;
    report.tables = applied.tables;
    report.rows = applied.rows;
  }
  return report;
}
