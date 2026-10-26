import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { convertDatabase, formatSizeWarning, maxFileSizeMbProblem } from "../../storage-json/src/index.ts";
import type { ConversionResult, DatabaseFormat } from "../../storage-json/src/index.ts";
import type { CliIo } from "./cli.ts";
import { entityTableSchemas, findSandboxProject } from "./project-entities.ts";

export const CONVERT_USAGE = `Usage: local-db-sandbox convert <database> --out <path> [options]

Copies a database into the other format. The original is not changed.

  local-db-sandbox convert sandbox.db.json --out sandbox.db     a single file into a directory
  local-db-sandbox convert sandbox.db --out sandbox.db.json     a directory into a single file

A path that ends in .json is a single file; any other path is a directory.
Rows, configuration, and table definitions are carried over.

Options:
  -o, --out <path>         Where to write the converted database (required)
      --force              Replace a database that is already at that path
      --entities <path>    Store the table definitions of the TypeORM entities in this file or folder
      --no-entities        Do not read TypeORM entities
      --max-file-size <MB> Largest database to accept (default: 150; at most 250)
  -h, --help               Show this help

When the database stores no table definitions and belongs to a project set up
with "init-nest", they are read from the project's TypeORM entities, so that
the converted database can be opened without them.
`;

const FORMAT_NAMES: Record<DatabaseFormat, string> = { file: "single file", directory: "directory" };

/** Runs `convert` and resolves with the process exit code. */
export async function runConvert(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox convert --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        force: { type: "boolean" },
        entities: { type: "string" },
        "no-entities": { type: "boolean" },
        "max-file-size": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(CONVERT_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    return fail(positionals.length === 0 ? "Missing the database to convert." : "Expected exactly one database to convert.");
  }
  if (values.out === undefined) {
    return fail("Missing --out: the path to write the converted database to.");
  }
  if (values.entities !== undefined && values["no-entities"]) {
    return fail("--entities and --no-entities cannot be used together.");
  }
  let maxFileSizeMb: number | undefined;
  if (values["max-file-size"] !== undefined) {
    maxFileSizeMb = /^\d+(\.\d+)?$/.test(values["max-file-size"]) ? Number(values["max-file-size"]) : Number.NaN;
    const problem = maxFileSizeMbProblem(maxFileSizeMb, "--max-file-size");
    if (problem !== undefined) {
      return fail(problem);
    }
  }
  const from = resolve(positionals[0] as string);
  const to = resolve(values.out);

  let result: ConversionResult;
  let project;
  // The entities that table definitions are read from: the ones named, or the project's when the database stores none.
  let entities: string | undefined;
  try {
    project = findSandboxProject(from);
    const explicit = values.entities === undefined ? undefined : resolve(values.entities);
    const fallback = explicit !== undefined || values["no-entities"] ? undefined : project?.entities;
    entities = explicit ?? fallback;
    result = await convertDatabase(from, to, {
      overwrite: values.force,
      maxFileSizeMb,
      onSizeWarning: (warning) => io.stderr.write(`${formatSizeWarning(warning)}\n`),
      ...(explicit !== undefined && { schema: entityTableSchemas(explicit) }),
      ...(fallback !== undefined && { fallbackSchema: () => entityTableSchemas(fallback) }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(/ already exists\.$/.test(message) ? `${message} Use --force to replace it.` : message);
  }

  const definitions =
    result.schemaSource === "none"
      ? "none stored; tables are described from their rows when the database is opened"
      : `${result.declaredTables}, ${result.schemaSource === "given" ? `from the TypeORM entities in ${entities}` : `as stored in ${from}`}`;
  const lines = [
    `Converted ${from} (${FORMAT_NAMES[result.from.format]}) to ${to} (${FORMAT_NAMES[result.to.format]}).`,
    `  tables: ${result.tables} (${result.rows} ${result.rows === 1 ? "row" : "rows"})`,
    `  table definitions: ${definitions}`,
    ...result.notes.map((note) => `  Note: ${note}`),
    "The original was not changed.",
  ];
  if (project !== undefined) {
    // Switching the project over is the user's decision; say how.
    const target = relative(dirname(project.configFile), to).replaceAll("\\", "/");
    lines.push(`${project.configFile} still names the original. To use the converted database, set "database" there to "${target}".`);
  }
  io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
