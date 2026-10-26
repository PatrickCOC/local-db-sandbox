import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { join } from "node:path";
import type { Row } from "../../core/src/index.ts";
import type { PersistenceMode, SchemaTypes, TableSchema } from "../../runtime/src/index.ts";
import { manifestFormatStamp } from "./format-version.ts";
import { readSchemaDocument } from "./schema-document.ts";
import { assertWithinSizeLimit, configuredLimitBytes } from "./size-limits.ts";
import { JsonStorageError } from "./storage-error.ts";
import { isSafeTableFile, tableFileStem } from "./table-files.ts";

/*
 * The files of a directory database, and the steps that reading one and
 * publishing a new state of one consist of. The storage adapter and the
 * format migrations are both made of these, so that a migration publishes
 * exactly as a save does.
 */

export const MANIFEST = "manifest.json";
export const SCHEMA = "schema.json";
export const TABLES = "tables";
/** The next manifest while a save is under way. Only one save can have it, so it also keeps two processes from saving at once. */
export const MANIFEST_DRAFT = "manifest.json.tmp";
export const MANIFEST_KEYS = ["formatVersion", "minimumReaderVersion", "database", "persistence", "config", "generation", "schema", "tables", "retired", "extra"];
/** A file written for one generation: `<stem>.g<generation>.json`. */
export const VERSIONED_FILE = /^(.+)\.g(\d+)\.json$/;
export const SCHEMA_FILE = /^schema(\.g\d+)?\.json$/;
export const ABSENT = "absent";
/** A draft that names no process and was not touched for this long was left by a save that did not end. */
const STALE_DRAFT_MS = 1000;
/** How often a save looks again, 5 ms apart, before it gives up because another process is saving. */
const SAVE_WAIT_ATTEMPTS = 40;
/** Errors of replacing a file that pass when whoever holds it open lets go. */
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

/** A file that is part of the database, as it was read or written. */
export interface StoredFile {
  /** Name within `tables/`, or within the directory for the schema. */
  file: string;
  bytes: number;
  /** Of the file's text, to tell whether new text differs from it. */
  hash: string;
}

export interface Manifest {
  formatVersion: number;
  minimumReaderVersion: number;
  name: string | undefined;
  persistence: PersistenceMode;
  config: unknown;
  extra: Record<string, unknown>;
  generation: number;
  schema: string | undefined;
  tables: { name: string; file: string }[];
  retired: string[];
}

/** One generation of a database, read from its files. */
export interface Generation {
  collections: Record<string, Row[]>;
  /** The file of each table, in the manifest's order. */
  tables: Map<string, StoredFile>;
  schema: TableSchema[];
  /** The enumerated types of the schema. */
  types: SchemaTypes;
  schemaFile: StoredFile | undefined;
  /** The size of the files the generation consists of: manifest, schema, and tables. */
  sizeBytes: number;
  /** The size limit in effect: the ceiling it was read with, lowered by the manifest's own configuration. */
  limitBytes: number;
}

/** Another process is saving the database right now. */
export class SaveInProgress extends JsonStorageError {}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What tells a file apart from another one that takes its place under the same name. */
function identityOf(stats: BigIntStats): string {
  return `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
}

export function fileIdentity(path: string): string {
  try {
    return identityOf(statSync(path, { bigint: true }));
  } catch {
    return ABSENT;
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Not allowed to signal it: it exists.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function documentText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** The name a file has when it is written for a generation: `users.json` becomes `users.g7.json`. */
export function versionedFile(stem: string, generation: number): string {
  return `${stem}.g${generation}.json`;
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Puts `from` in the place of `to` in one step. A file that something holds open for a moment is tried again. */
function replaceFile(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt === 8 || !BUSY.has((error as NodeJS.ErrnoException).code ?? "")) {
        throw error;
      }
      pause(attempt * 2);
    }
  }
}

/** Reads a file as text, with the identity and the size of the file that was read. */
export function readText(path: string, shownAs: string): { text: string; bytes: number; identity: string } {
  try {
    const file = openSync(path, "r");
    try {
      // From the open file, so that they are those of what is read and not of a file that replaces it.
      const stats = fstatSync(file, { bigint: true });
      return { text: readFileSync(file, "utf8"), bytes: Number(stats.size), identity: identityOf(stats) };
    } finally {
      closeSync(file);
    }
  } catch (cause) {
    throw new JsonStorageError(`Cannot read ${shownAs}`, { cause });
  }
}

export function parseJson(text: string, shownAs: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new JsonStorageError(`${shownAs} is not valid JSON.`, { cause });
  }
}

/**
 * Writes a file that does not exist yet, and checks that all of it was
 * written. A name is never used for two contents, so a file that is already
 * there is an error (`EEXIST`). `onCreated` is told once the file is this
 * caller's to remove.
 */
export function writeNewFile(path: string, text: string, bytes: number, onCreated: () => void): void {
  const file = openSync(path, "wx");
  onCreated();
  let size: number;
  try {
    writeFileSync(file, text, "utf8");
    size = fstatSync(file).size;
  } finally {
    closeSync(file);
  }
  // Check what was written before it is declared part of the database.
  if (size !== bytes) {
    throw new Error(`${path} was not written completely.`);
  }
}

/**
 * Starts a save of the database in `directory`: creates the manifest's draft,
 * which only one save can have at a time, and returns it open. It is the next
 * manifest in the making, and until it is put in place it holds the id of the
 * process that is saving. Throws when another running process is saving right
 * now.
 */
export function beginSave(directory: string): number {
  const draftPath = join(directory, MANIFEST_DRAFT);
  for (let waited = 0; ; ) {
    try {
      const draft = openSync(draftPath, "wx");
      writeSync(draft, String(process.pid));
      return draft;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
    }
    let holder = Number.NaN;
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      ageMs = Date.now() - statSync(draftPath).mtimeMs;
      holder = Number(readFileSync(draftPath, "utf8").trim() || Number.NaN);
    } catch {
      // Gone since it was found: that save has ended.
      continue;
    }
    const named = Number.isInteger(holder) && holder > 0;
    if (named && holder !== process.pid && isRunning(holder)) {
      if ((waited += 1) >= SAVE_WAIT_ATTEMPTS) {
        throw new SaveInProgress(
          `${directory} is being saved by another process (pid ${holder}). One process saves a database at a time; stop that process, or open the database read-only.`,
        );
      }
    } else if (named || ageMs > STALE_DRAFT_MS) {
      // Left by a save that did not end: its process is gone, or the draft has not been touched for too long to be in use.
      rmSync(draftPath, { force: true });
      continue;
    }
    // Otherwise it names no process: a save is putting its manifest in place this moment, or was stopped while it did. Time tells.
    pause(5);
  }
}

/**
 * Ends a save: fills the draft that `beginSave` returned with the new
 * manifest and puts it in the place of `manifest.json`, in one rename. That
 * rename is the save. Before it, the database is what it was, whatever has
 * been written; after it, it is the new state, complete. The draft is closed
 * either way; when this throws, it is the caller's to remove.
 */
export function publishManifest(directory: string, draft: number, manifestText: string, manifestBytes: number): void {
  try {
    ftruncateSync(draft, 0);
    writeSync(draft, manifestText, 0, "utf8");
    if (fstatSync(draft).size !== manifestBytes) {
      throw new Error(`${MANIFEST} was not written completely.`);
    }
  } finally {
    closeSync(draft);
  }
  replaceFile(join(directory, MANIFEST_DRAFT), join(directory, MANIFEST));
}

/**
 * The content of a manifest, checked. Which formats are read is not decided
 * here (see format-version.ts): the manifests of every format this build
 * reads have these keys, and those that an earlier format did not have yet
 * are optional.
 */
export function parseManifest(manifest: unknown, path: string): Manifest {
  const stamp = manifestFormatStamp(manifest, path);
  if (!isPlainObject(manifest)) {
    throw new JsonStorageError(`${path} must contain a JSON object.`);
  }
  const unknown = Object.keys(manifest).find((key) => !MANIFEST_KEYS.includes(key));
  if (unknown !== undefined) {
    throw new JsonStorageError(`${path} has the unknown key "${unknown}". Its keys are ${MANIFEST_KEYS.join(", ")}; keep anything else under "extra".`);
  }
  if (manifest.database !== undefined && typeof manifest.database !== "string") {
    throw new JsonStorageError(`"database" in ${path} must be a name.`);
  }
  const persistence = manifest.persistence ?? "json";
  if (persistence !== "json" && persistence !== "memory") {
    throw new JsonStorageError(`"persistence" in ${path} must be "json" or "memory".`);
  }
  if (manifest.extra !== undefined && !isPlainObject(manifest.extra)) {
    throw new JsonStorageError(`"extra" in ${path} must be an object.`);
  }
  const generation = manifest.generation ?? 0;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
    throw new JsonStorageError(`"generation" in ${path} must be a whole number, 0 or more.`);
  }
  if (manifest.schema !== undefined && (typeof manifest.schema !== "string" || !SCHEMA_FILE.test(manifest.schema))) {
    throw new JsonStorageError(`"schema" in ${path} must be the name of the schema file: schema.json, or schema.g<generation>.json.`);
  }
  const retired = manifest.retired ?? [];
  if (!Array.isArray(retired) || retired.some((file) => typeof file !== "string" || !isSafeTableFile(file))) {
    throw new JsonStorageError(`"retired" in ${path} must be a list of file names in ${TABLES}/.`);
  }
  if (!Array.isArray(manifest.tables)) {
    throw new JsonStorageError(`"tables" in ${path} must be a list of tables, each with a "name" and a "file".`);
  }

  const names = new Set<string>();
  const stems = new Set<string>();
  const tables = manifest.tables.map((entry: unknown) => {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || typeof entry.file !== "string") {
      throw new JsonStorageError(`"tables" in ${path} must be a list of tables, each with a "name" and a "file".`);
    }
    if (!isSafeTableFile(entry.file)) {
      throw new JsonStorageError(
        `${path}: ${JSON.stringify(entry.file)} is not a usable file name for table "${entry.name}". Use letters, digits, "_", "-", "%", and "~", ending in ".json".`,
      );
    }
    if (names.has(entry.name)) {
      throw new JsonStorageError(`${path} lists the table "${entry.name}" more than once.`);
    }
    // Some file systems ignore case, so two tables must not differ only in that. Their later files are named after the same stem.
    const stem = tableFileStem(entry.file).toLowerCase();
    if (stems.has(stem)) {
      throw new JsonStorageError(`${path} uses the file "${entry.file}" for more than one table.`);
    }
    names.add(entry.name);
    stems.add(stem);
    return { name: entry.name, file: entry.file };
  });
  return {
    formatVersion: stamp.formatVersion,
    minimumReaderVersion: stamp.minimumReaderVersion,
    name: manifest.database as string | undefined,
    persistence,
    config: manifest.config,
    extra: { ...(manifest.extra as Record<string, unknown> | undefined) },
    generation,
    schema: manifest.schema as string | undefined,
    tables,
    retired: retired as string[],
  };
}

/** The file that holds the table definitions of a manifest's generation, if it has one. */
function schemaFileOf(directory: string, manifest: Manifest): string | undefined {
  return manifest.schema ?? (existsSync(join(directory, SCHEMA)) ? SCHEMA : undefined);
}

/**
 * The size of the generation a manifest names, from the sizes of its files
 * on disk; none of them is read. `manifestBytes` is the size of the manifest
 * itself. A file that the manifest names and that is not there is an error.
 */
export function measureGeneration(directory: string, manifest: Manifest, manifestBytes: number): number {
  let sizeBytes = manifestBytes;
  const schemaName = schemaFileOf(directory, manifest);
  if (schemaName !== undefined) {
    if (!existsSync(join(directory, schemaName))) {
      throw new JsonStorageError(`${schemaName} is named in ${MANIFEST} but does not exist in ${directory}.`);
    }
    sizeBytes += statSync(join(directory, schemaName)).size;
  }
  for (const { name, file } of manifest.tables) {
    const path = join(directory, TABLES, file);
    if (!existsSync(path)) {
      throw new JsonStorageError(`Table "${name}" has no file: ${TABLES}/${file} is listed in ${MANIFEST} but does not exist in ${directory}.`);
    }
    sizeBytes += statSync(path).size;
  }
  return sizeBytes;
}

/**
 * Reads the generation a manifest names: its table definitions and the rows
 * of every table. The total size of its files is checked first, from their
 * sizes on disk, so that a database above `ceilingBytes` is refused before
 * its tables are read. A lower limit in the manifest's configuration is
 * applied as well.
 */
export function readGeneration(directory: string, manifest: Manifest, manifestBytes: number, ceilingBytes: number): Generation {
  const sizeBytes = measureGeneration(directory, manifest, manifestBytes);
  assertWithinSizeLimit(sizeBytes, ceilingBytes, "load", "directory");
  const limitBytes = configuredLimitBytes(manifest.config, ceilingBytes);
  // A lower limit from the database's own configuration is only known now.
  assertWithinSizeLimit(sizeBytes, limitBytes, "load", "directory");

  let schema: TableSchema[] = [];
  let types: SchemaTypes = { enums: [] };
  let schemaFile: StoredFile | undefined;
  const schemaName = schemaFileOf(directory, manifest);
  if (schemaName !== undefined) {
    const shownAs = join(directory, schemaName);
    const stored = readText(shownAs, shownAs);
    ({ tables: schema, types } = readSchemaDocument(parseJson(stored.text, shownAs), shownAs));
    schemaFile = { file: schemaName, bytes: stored.bytes, hash: hashOf(stored.text) };
  }

  const collections: Record<string, Row[]> = {};
  const tables = new Map<string, StoredFile>();
  for (const { name, file } of manifest.tables) {
    const shownAs = `${directory}: ${TABLES}/${file}`;
    const stored = readText(join(directory, TABLES, file), shownAs);
    const rows = parseJson(stored.text, shownAs);
    if (!Array.isArray(rows) || !rows.every(isPlainObject)) {
      throw new JsonStorageError(`Table "${name}" (${TABLES}/${file}) must be an array of objects.`);
    }
    collections[name] = rows;
    tables.set(name, { file, bytes: stored.bytes, hash: hashOf(stored.text) });
  }
  return { collections, tables, schema, types, schemaFile, sizeBytes, limitBytes };
}

/**
 * A `.json` file in `tables/` that the manifest does not list is most likely
 * a table someone meant to add. Not so a file named after a generation, or
 * one that the manifest says is awaiting deletion: those are what saves leave.
 */
export function refuseUnlistedTables(directory: string, manifest: Manifest): void {
  const tables = join(directory, TABLES);
  if (!existsSync(tables)) {
    return;
  }
  const known = new Set([...manifest.tables.map(({ file }) => file.toLowerCase()), ...manifest.retired.map((file) => file.toLowerCase())]);
  const stray = readdirSync(tables, { withFileTypes: true }).find(
    (entry) => entry.isFile() && /\.json$/i.test(entry.name) && !VERSIONED_FILE.test(entry.name) && !known.has(entry.name.toLowerCase()),
  );
  if (stray !== undefined) {
    throw new JsonStorageError(`${directory}: ${TABLES}/${stray.name} is not listed in ${MANIFEST}. Add it to "tables" there to make it a table, or move the file away.`);
  }
}
