import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { TypeormImportError, findEntityFiles, importTypeorm, looksLikeEntityFile } from "../../import-typeorm/src/index.ts";
import type { ImportResult } from "../../import-typeorm/src/index.ts";
import { NestSandboxError, SANDBOX_DIRECTORY, databaseSchema, defaultNestEntry, readNestSandboxConfig, tableSchemas } from "../../nest-typeorm/src/index.ts";
import type { DatabaseSchema, TableSchema } from "../../runtime/src/index.ts";
import { installNetworkHook } from "../../side-effects/src/index.ts";

export interface SandboxProject {
  /** The project's `.local-db-sandbox/sandbox.config.json`. */
  configFile: string;
  /** The folder its TypeORM entities are read from. */
  entities: string;
}

/**
 * The project, set up with "init-nest", whose sandbox configuration names
 * this database. It is looked for next to the database and in the current
 * working directory.
 */
export function findSandboxProject(database: string): SandboxProject | undefined {
  for (const directory of new Set([dirname(database), process.cwd()])) {
    const configFile = join(directory, ".local-db-sandbox", "sandbox.config.json");
    if (existsSync(configFile)) {
      const options = readNestSandboxConfig(configFile);
      if (options.file === database) {
        return { configFile, entities: dirname(options.entry) };
      }
    }
  }
  return undefined;
}

/** Table definitions of the TypeORM entities in a file or folder. */
export function entityTableSchemas(path: string): TableSchema[] {
  return tableSchemas(importTypeorm(path).collections);
}

/*
 * TypeORM entities as a schema to compare (Phase E2, D-044).
 *
 * Entities are read as "init-nest" reads them, by the collection there is:
 * the files that declare an entity are loaded, with what they import, and
 * TypeORM's own metadata of them is read. Nothing of an application is
 * started for it: no entry point, no module, no data source, no connection.
 * Where the entities are is found by reading files, and loading none.
 */

/** A source file, by its name; a declaration file has no code. */
const SOURCE_FILE = /\.[cm]?[jt]s$/i;
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;

/** Where the TypeORM entities of a path are. */
export type EntityLocation =
  /** `path`: the file or folder to read them from, as it was given. `within`: that folder inside the project, when a project was given. */
  | { found: true; path: string; within?: string }
  /**
   * `problem`: why what looks like a place for entities has none that can be
   * read, as a whole sentence. Absent when nothing there is of TypeORM; then
   * `none` says in a few words why it is not entities, for whoever lists what
   * the path is not.
   */
  | { found: false; problem?: string; none?: string };

/** Whether TypeORM is installed for the project in `directory`. */
function hasTypeorm(directory: string): boolean {
  try {
    createRequire(join(resolve(directory), "package.json")).resolve("typeorm");
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the entities of what is at `path` are: a file that declares them, a
 * folder of entity files, or a NestJS project, whose entities are in the
 * folder of its entry point, as "init-nest" has it. Files are read to find
 * that out, and none is loaded.
 */
export function locateEntities(path: string, isDirectory: boolean): EntityLocation {
  if (!isDirectory) {
    if (!SOURCE_FILE.test(path) || DECLARATION_FILE.test(path)) {
      return { found: false };
    }
    // A file that was named is loaded only as a file of a folder would be: the entry point of an application is not run to see what it declares.
    return looksLikeEntityFile(path)
      ? { found: true, path }
      : {
          found: false,
          problem:
            `${path} declares no TypeORM entity, and was not loaded: a source file is read for entities only when it imports "typeorm" and names an entity's decorator (@Entity). ` +
            "Give a file that declares entities, the folder that holds the entity files, or the project.",
        };
  }

  const root = resolve(path);
  let folder = root;
  const configFile = join(root, SANDBOX_DIRECTORY, "sandbox.config.json");
  if (existsSync(configFile)) {
    try {
      folder = dirname(readNestSandboxConfig(configFile).entry);
    } catch (error) {
      if (error instanceof NestSandboxError) {
        return { found: false, problem: `${path} is a project that "init-nest" set up, and where its entities are cannot be read from its configuration: ${error.message}` };
      }
      throw error;
    }
  } else if (existsSync(join(root, "package.json"))) {
    if (!hasTypeorm(root)) {
      // A project that has no TypeORM, or one whose packages are not installed: nothing of it is looked through.
      return { found: false, none: "TypeORM is not installed for this project: install its packages, and its entities can be read" };
    }
    const entry = defaultNestEntry(root);
    if (!existsSync(entry)) {
      return {
        found: false,
        problem:
          `${path} is a project with TypeORM whose entities are not found: it has no ${SANDBOX_DIRECTORY}/sandbox.config.json (which "init-nest" writes), and no entry point at ${relative(root, entry)}. ` +
          "Give the folder that holds its entity files.",
      };
    }
    folder = dirname(entry);
  }

  // The folder in the spelling the path was given in.
  const within = relative(root, folder);
  const inside = within !== "" && !within.startsWith("..") && resolve(root, within) === folder;
  const shown = folder === root ? path : inside ? join(path, within) : folder;
  if (!existsSync(folder) || findEntityFiles(folder).length === 0) {
    return folder === root ? { found: false } : { found: false, problem: `${path} has no TypeORM entity: no file in ${shown} declares one, so there is nothing to compare.` };
  }
  return { found: true, path: shown, ...(folder !== root && { within: (inside ? within : folder).replaceAll("\\", "/") }) };
}

/** What a schema that was read from entities does not say, of what the entities declare. */
export interface EntityOmissions {
  /** The tables it has. */
  has: ReadonlySet<string>;
  /** A table the entities declare is not among them: a join table, or the table of an entity that was skipped. */
  tables: boolean;
  /** Tables of which a column was not read. */
  columns: ReadonlySet<string>;
  /** Tables of which a key was not read: those of `columns`, and those with a key whose target is not known. */
  keys: ReadonlySet<string>;
  /** Columns, as `table.column`, whose default was not read. */
  defaults: ReadonlySet<string>;
}

function omissionsOf(result: ImportResult, schema: DatabaseSchema): EntityOmissions {
  const columns = new Set<string>();
  const keys = new Set<string>();
  const defaults = new Set<string>();
  let tables = false;
  for (const issue of result.issues) {
    if (issue.omits === "table") {
      tables = true;
    }
    // An issue is about an entity by the name of its class.
    for (const collection of result.collections.filter((candidate) => candidate.source === issue.entity)) {
      if (issue.omits === "column") {
        columns.add(collection.name);
      }
      if (issue.omits === "column" || issue.omits === "key") {
        keys.add(collection.name);
      }
      const field = collection.fields.find((candidate) => candidate.name === issue.property);
      if (issue.omits === "default" && field !== undefined) {
        defaults.add(`${collection.name}.${field.column ?? field.name}`);
      }
    }
  }
  return { has: new Set(schema.tables.map((table) => table.name)), tables, columns, keys, defaults };
}

/** The most places that are named for one thing that was not read. */
const PLACES_NAMED = 5;

/** What the collection left out of the tables, their columns, and their keys: one note for each thing it says, with where. */
function omissionNotes(result: ImportResult): string[] {
  const places = new Map<string, string[]>();
  for (const issue of result.issues) {
    if (issue.omits === "table" || issue.omits === "column" || issue.omits === "key") {
      places.set(issue.message, [...(places.get(issue.message) ?? []), `${issue.entity ?? "an entity"}${issue.property === undefined ? "" : `.${issue.property}`}`]);
    }
  }
  return [...places].map(([message, at]) => {
    const named = at.length > PLACES_NAMED ? `${at.slice(0, PLACES_NAMED).join(", ")}, and ${at.length - PLACES_NAMED} more` : at.join(", ");
    return `not read from the entities, and not part of what is compared: ${message} (${named})`;
  });
}

/** Entities that could not be read as a schema: the message says what and why. */
export class EntitySourceError extends Error {}

export interface EntitySchema {
  /** What it was read as, for the line that names it. */
  description: string;
  schema: DatabaseSchema;
  notes: string[];
  unsaid: EntityOmissions;
}

/**
 * Refuses connections that leave this machine for as long as entity files
 * are loaded, and notes where one was to go. Reading entities needs none: a
 * file that opens one when it is loaded is not what is read here. It is the
 * guard of the sandbox, a development aid and no security boundary.
 */
function refuseConnections(tried: Set<string>): () => void {
  try {
    return installNetworkHook({
      mode: "block",
      onEvent: (event) => {
        if (event.action === "blocked") {
          tried.add(event.port === undefined ? event.host : `${event.host}:${event.port}`);
        }
      },
    });
  } catch {
    // A guard is installed in this process already: what leaves it is that guard's to say.
    return () => undefined;
  }
}

/**
 * The schema of the entities at a place that `locateEntities` found: the
 * canonical schema that "init-nest" stores for them (D-040), so that a
 * database and the entities it was made from do not differ.
 */
export async function readEntitySchema(location: { path: string; within?: string }): Promise<EntitySchema> {
  const tried = new Set<string>();
  const allowAgain = refuseConnections(tried);
  let result: ImportResult;
  try {
    result = importTypeorm(location.path);
    // What loading set off shows by the next turn of the loop: a connection is opened, and refused, there at the latest.
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  } catch (error) {
    if (!(error instanceof TypeormImportError)) {
      throw error;
    }
    // No entity is another matter than a file that could not be loaded: it is not made into a schema without tables.
    throw new EntitySourceError(error.reason === "no-entities" ? `There is nothing to compare: ${error.message}` : `The TypeORM entities in ${location.path} were not collected: ${error.message}`);
  } finally {
    allowAgain();
  }
  if (tried.size > 0) {
    throw new EntitySourceError(
      `The TypeORM entities in ${location.path} were not collected: loading the entity files tried to reach ${[...tried].join(", ")}, which was refused. ` +
        "Reading entities connects to nothing outside this machine: an entity file, or a file it imports, does that when it is loaded.",
    );
  }
  const schema = databaseSchema(result.collections);
  const count = schema.tables.length;
  return {
    description: `TypeORM entities${location.within === undefined ? "" : ` in ${location.within}`}, ${count} table${count === 1 ? "" : "s"}`,
    schema,
    notes: omissionNotes(result),
    unsaid: omissionsOf(result, schema),
  };
}
