import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MIGRATION_DIRECTORIES, MigrationError, MigrationSourceError, MigrationSyntaxError, collectPostgresMigrations, findMigrationsDirectory } from "../../import-postgres/src/index.ts";
import type { DatabaseSchema } from "../../runtime/src/index.ts";
import { diffSchemas, formatSchemaDiff, stringifySchemaDiff } from "../../schema-diff/src/index.ts";
import type { SchemaChange } from "../../schema-diff/src/index.ts";
import { DEFAULT_MAX_FILE_SIZE_MB, formatNotice, formatSizeWarning, openDatabaseStorage, readSchemaDocument } from "../../storage-json/src/index.ts";
import type { CliIo } from "./cli.ts";
import { formatBytes, parseMaxFileSize } from "./inspect-command.ts";
import { EntitySourceError, locateEntities, readEntitySchema } from "./project-entities.ts";
import type { EntityOmissions } from "./project-entities.ts";
import { unsaidChanges, unsaidSentence } from "./unsaid-changes.ts";

export const DIFF_SCHEMA_USAGE = `Usage: local-db-sandbox diff-schema <before> <after> [options]

Says what differs between two schemas: tables, columns, types, defaults,
keys, constraints, indexes, and enumerated types. Nothing is changed: both
sides are only read, and no SQL is generated.

<before> and <after> are each one of:
  a database directory     its stored table definitions
  a single-file database   its stored table definitions
  a schema file            a schema document, such as the schema.json of a database directory
  PostgreSQL migrations    a directory of .sql files, or a project that keeps them where
                           "init" looks for them (supabase/migrations, migrations, ...)
  TypeORM entities         a NestJS project (its entities are read from the folder of its entry point),
                           a folder of entity files, or one entity file

Entities are read as "init-nest" reads them, and nothing of the application is
started. Only files that declare an entity are loaded, with what they import;
a connection that leaves this machine is refused while they are, and fails
the command. A project that has migrations and entities both is asked which:
give the folder of the one to compare. Entities say no indexes and no unique
or check constraints: where the other side has them, they are listed as
differences, with a note that they may only be what entities do not say.

Types are compared by what they are, not by how they are spelled (integer and
int4 are one type). A different name is a rename only when the schemas say so:
a migration renamed the object, and both sides know the statement that created
it. Otherwise it is a drop and an add. Nothing is matched by similarity.

Changes are listed in an order they can be carried out in: what is dropped
(named as <before> names it), then the renames, then what is added or changed
(named as <after> names it).

Options:
      --json               Print the diff as JSON, and nothing else: the same bytes
                           for the same two schemas
      --max-file-size <MB> Largest database or schema file to read (default: 150; at most 250)
  -h, --help               Show this help

Exits with 0 when the two were compared, with or without differences, and
with 1 when one of them could not be read.
`;

/** Something that was given to compare and cannot be: the message says what and why. */
class SchemaSourceError extends Error {}

export interface SchemaSource {
  /** What it was read as, for the line that names it. */
  description: string;
  schema: DatabaseSchema;
  /** What is worth knowing about how it was read. */
  notes: string[];
  /** For a schema that was read from TypeORM entities: what it does not say, of what the entities declare. */
  entities?: EntityOmissions;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The stored table definitions of a database, in either kind of storage. Reading a database does not change it. */
async function readDatabase(path: string, description: string, maxFileSizeMb: number | undefined): Promise<SchemaSource> {
  const notes: string[] = [];
  const storage = openDatabaseStorage(path, { ...(maxFileSizeMb !== undefined && { maxFileSizeMb }), onSizeWarning: (warning) => notes.push(formatSizeWarning(warning)) });
  await storage.load();
  const notice = storage.formatStatus === undefined ? undefined : formatNotice(storage.formatStatus, path);
  if (notice !== undefined) {
    notes.push(notice);
  }
  const types = storage.types ?? { enums: [] };
  // Enumerated types are definitions too: a database may hold them and no table yet.
  if (storage.schema === undefined && types.enums.length === 0) {
    throw new SchemaSourceError(`${path} stores no table definitions, so there is nothing to compare. A schema diff reads declared definitions; it does not work them out from rows.`);
  }
  return { description, schema: { tables: storage.schema ?? [], types }, notes };
}

const NO_MIGRATIONS = `it has no .sql files, and neither has ${MIGRATION_DIRECTORIES.join(", ")} under it`;

/** The migrations directory of a path, or `undefined` when it has none. */
function migrationsDirectoryOf(path: string): string | undefined {
  try {
    return findMigrationsDirectory(path);
  } catch (error) {
    if (error instanceof MigrationSourceError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Whether the `manifest.json` of a directory is a database's: one states its
 * format. A project may have a `manifest.json` of its own (a web
 * application's, a browser extension's). `undefined`: it cannot be read as
 * JSON, so it may be a damaged database's.
 */
function isDatabaseManifest(path: string): boolean | undefined {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(manifest) && manifest.formatVersion !== undefined;
  } catch {
    return undefined;
  }
}

/** The schema that PostgreSQL migrations leave, collected as `init` collects it. `directory`: the migrations directory of `path`. */
async function readMigrations(path: string, directory: string): Promise<SchemaSource> {
  let collected;
  try {
    collected = await collectPostgresMigrations(directory);
  } catch (error) {
    // A migration is named by where its file is: two sides may both have a 0002_change.sql.
    if (error instanceof MigrationSyntaxError) {
      throw new SchemaSourceError(`${join(directory, error.file)}:${error.line}:${error.column}: PostgreSQL cannot parse this migration: ${error.message.replace(/^.*?: /, "")}.`);
    }
    if (error instanceof MigrationError) {
      // The message starts with the file's name and line; only the name is made a path.
      const position = `${error.file}:${error.line}: `;
      throw new SchemaSourceError(`${join(directory, error.file)}:${error.line}: ${error.message.startsWith(position) ? error.message.slice(position.length) : error.message}`);
    }
    if (error instanceof MigrationSourceError) {
      throw new SchemaSourceError(error.message);
    }
    throw error;
  }
  const unsupported = collected.report.filter((entry) => entry.outcome === "unsupported").length;
  return {
    description: `PostgreSQL migrations, ${plural(collected.migrations.length, "file")}`,
    schema: { tables: collected.tables, types: collected.types },
    notes:
      unsupported === 0
        ? []
        : [`${path}: ${plural(unsupported, "statement")} of these migrations ${unsupported === 1 ? "is" : "are"} unsupported by the collector, so the schema it collected may differ from PostgreSQL's there. "local-db-sandbox init" lists them.`],
  };
}

/** The schema of TypeORM entities, collected as `init-nest` collects it, from where `locateEntities` found them. */
async function readEntities(location: { path: string; within?: string }): Promise<SchemaSource> {
  try {
    const { description, schema, notes, unsaid } = await readEntitySchema(location);
    return { description, schema, notes, entities: unsaid };
  } catch (error) {
    if (error instanceof EntitySourceError) {
      throw new SchemaSourceError(error.message);
    }
    throw error;
  }
}

/**
 * A schema to compare, from what is at `path`: a database's stored
 * definitions, a schema document, migrations, or TypeORM entities. What it
 * is is decided by what is there, not by its name. A database is that and
 * nothing else; migrations and entities are found by looking, and a project
 * that has both is not guessed at.
 */
async function readSchemaSource(path: string, maxFileSizeMb: number | undefined): Promise<SchemaSource> {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new SchemaSourceError(`${path} does not exist.`);
  }
  if (stats.isDirectory()) {
    const manifest = join(path, "manifest.json");
    const database = existsSync(manifest) ? isDatabaseManifest(manifest) : false;
    if (database === true) {
      return readDatabase(path, "database directory", maxFileSizeMb);
    }
    const directory = migrationsDirectoryOf(path);
    if (directory !== undefined && directory === resolve(path)) {
      // A directory that holds the migrations itself is that, as it always was, and is looked through for nothing else.
      return readMigrations(path, directory);
    }
    const entities = locateEntities(path, true);
    if (directory !== undefined) {
      // A project that keeps migrations in a folder of their own and has entities too is two schemas: which is meant is said by whoever asks.
      if (entities.found) {
        throw new SchemaSourceError(`${path} has PostgreSQL migrations (${join(path, relative(resolve(path), directory))}) and TypeORM entities (${entities.path}) both. Give the one to compare.`);
      }
      return readMigrations(path, directory);
    }
    if (entities.found) {
      return readEntities(entities);
    }
    if (database === undefined) {
      // The storage says what is wrong with the manifest.
      return readDatabase(path, "database directory", maxFileSizeMb);
    }
    if (entities.problem !== undefined) {
      throw new SchemaSourceError(entities.problem);
    }
    const why = existsSync(manifest) ? 'its manifest.json states no "formatVersion", so it is not a database\'s' : "it has no manifest.json";
    throw new SchemaSourceError(`${path} is neither a database directory (${why}), nor PostgreSQL migrations (${NO_MIGRATIONS}), nor TypeORM entities (${entities.none ?? "no file in it declares one"}).`);
  }
  if (/\.sql$/i.test(path)) {
    throw new SchemaSourceError(`${path} is one migration file. Migrations are read as a whole: give the directory that holds them (${dirname(path)}).`);
  }

  // A file is looked into to tell what it is, so the size limit comes first, as for a database.
  const limitMb = maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB;
  if (stats.size > limitMb * 1024 * 1024) {
    throw new SchemaSourceError(`${path} is ${formatBytes(stats.size)}, above the limit of ${limitMb} MB, and was not read.`);
  }
  // A source file is entities or nothing: one that declares none is not loaded to see what else it is.
  const entities = locateEntities(path, false);
  if (entities.found) {
    return readEntities(entities);
  }
  if (entities.problem !== undefined) {
    throw new SchemaSourceError(entities.problem);
  }
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SchemaSourceError(`${path} is not valid JSON. A file to compare is a single-file database, a schema file, or a file of TypeORM entities.`);
  }
  if (isPlainObject(document) && document.data !== undefined) {
    return readDatabase(path, "single-file database", maxFileSizeMb);
  }
  if (isPlainObject(document) && Array.isArray(document.tables)) {
    return { description: "schema file", schema: readSchemaDocument(document, path), notes: [] };
  }
  throw new SchemaSourceError(`${path} is neither a single-file database (an object with "data") nor a schema file (an object with a "tables" list).`);
}

/**
 * Reads the two schemas of a command that compares two: `<before>` and
 * `<after>`. What is worth knowing about how each was read goes to stderr as
 * a note. A side that cannot be read gives the `problem` to report. What is
 * said about one of the two says which, by the name the usage gives it, and
 * where it is.
 */
export async function readBeforeAndAfter(beforePath: string, afterPath: string, maxFileSizeMb: number | undefined, io: CliIo): Promise<{ before: SchemaSource; after: SchemaSource } | { problem: string }> {
  // The path is put before a message that does not have it, in the spelling it was given or the one paths are joined in.
  const about = (side: string, path: string, message: string): string => `${side}: ${message.includes(path) || message.includes(normalize(path)) ? message : `${path}: ${message}`}`;
  const sources: SchemaSource[] = [];
  for (const [side, path] of [
    ["<before>", beforePath],
    ["<after>", afterPath],
  ] as const) {
    try {
      sources.push(await readSchemaSource(path, maxFileSizeMb));
    } catch (error) {
      return { problem: about(side, path, error instanceof Error ? error.message : String(error)) };
    }
  }
  const [before, after] = sources as [SchemaSource, SchemaSource];
  for (const [side, path, source] of [
    ["<before>", beforePath, before],
    ["<after>", afterPath, after],
  ] as const) {
    for (const note of source.notes) {
      io.stderr.write(`Note: ${about(side, path, note)}\n`);
    }
  }
  return { before, after };
}

/**
 * Notes, on stderr, how many of the changes of a diff, or of the steps of a
 * plan, are of what a side does not say because it was read from TypeORM
 * entities. Such a change is shown as any other; that it may only be what
 * the entities do not say is for whoever reads it to know.
 */
export function noteUnsaid(changes: readonly SchemaChange[], sources: { before: SchemaSource; after: SchemaSource }, what: "change" | "step", io: CliIo): void {
  for (const side of ["before", "after"] as const) {
    const unsaid = unsaidChanges(changes, sources[side].entities, side);
    if (unsaid.length > 0) {
      io.stderr.write(`Note: ${unsaidSentence(unsaid.length, what, side)}\n`);
    }
  }
}

/** Runs `diff-schema` and resolves with the process exit code. */
export async function runDiffSchema(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox diff-schema --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        "max-file-size": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(DIFF_SCHEMA_USAGE);
    return 0;
  }
  if (positionals.length !== 2) {
    return fail(
      positionals.length === 0
        ? "Missing the two schemas to compare: <before> and <after>."
        : positionals.length === 1
          ? "Missing the schema to compare with: <after>."
          : "Expected exactly two schemas to compare: <before> and <after>.",
    );
  }
  const { maxFileSizeMb, problem } = parseMaxFileSize(values["max-file-size"]);
  if (problem !== undefined) {
    return fail(problem);
  }

  const [beforePath, afterPath] = positionals as [string, string];
  const read = await readBeforeAndAfter(beforePath, afterPath, maxFileSizeMb, io);
  if ("problem" in read) {
    return fail(read.problem);
  }
  const { before, after } = read;

  const diff = diffSchemas(before.schema, after.schema);
  noteUnsaid(diff.changes, read, "change", io);
  if (values.json) {
    io.stdout.write(`${stringifySchemaDiff(diff)}\n`);
  } else {
    io.stdout.write(`${[`Before: ${beforePath} (${before.description})`, `After:  ${afterPath} (${after.description})`, ...formatSchemaDiff(diff)].join("\n")}\n`);
  }
  return 0;
}
