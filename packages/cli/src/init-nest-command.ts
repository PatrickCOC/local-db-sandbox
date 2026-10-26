import { parseArgs } from "node:util";
import { DEFAULT_NEST_SANDBOX_PORT, initNest } from "../../nest-typeorm/src/index.ts";
import type { CliIo } from "./cli.ts";
import { isPort } from "./config.ts";
import { describeCollection, describeIssue } from "./import-command.ts";

export const INIT_NEST_USAGE = `Usage: local-db-sandbox init-nest [entry] [options]

Prepares an existing NestJS + TypeORM project to run a second server in
sandbox mode: the same application, with TypeORM's default data source
replaced by a JSON database, on its own port. [entry] is the file that starts
the application (default: the one named by nest-cli.json, or src/main.ts).

The application's sources are not changed. This writes the database,
.local-db-sandbox/sandbox.server.ts, .local-db-sandbox/sandbox.config.json,
and a "sandbox" script in package.json. Run it again after adding entities.

A new project gets a database directory, sandbox.db: one JSON file per table,
and the table definitions of the entities. A project that already has a
database keeps it as it is, including a single-file sandbox.db.json;
"local-db-sandbox convert" copies a database into the other format.

Options:
  -p, --port <number>    Sandbox port (default: ${DEFAULT_NEST_SANDBOX_PORT}, or the port chosen before)
  -o, --out <path>       Database: a directory, or a single file when the path ends in .json
                         (default: the project's database, or sandbox.db in the project root)
      --entities <path>  File or folder to read TypeORM entities from (default: the entry's folder)
  -h, --help             Show this help
`;

/** Runs `init-nest` and resolves with the process exit code. */
export async function runInitNest(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox init-nest --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: "string", short: "p" },
        out: { type: "string", short: "o" },
        entities: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(INIT_NEST_USAGE);
    return 0;
  }
  if (positionals.length > 1) {
    return fail("Expected at most one entry point.");
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN;
    if (!isPort(port) || port === 0) {
      return fail("--port must be an integer from 1 to 65535.");
    }
  }

  let result;
  try {
    result = await initNest({ entry: positionals[0], port, database: values.out, entities: values.entities });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const count = result.import.collections.length;
  const { database, script } = result;
  const lines = [
    `Nest entry point: ${result.entry}`,
    `  root module: ${result.rootModule.name}${result.rootModule.from === undefined ? "" : ` (${result.rootModule.from})`}`,
    `  TypeORM root: ${result.typeormRoots.join(", ")}`,
    `Imported ${count} TypeORM ${count === 1 ? "entity" : "entities"} from ${result.entities}`,
    ...result.import.collections.map(describeCollection),
  ];
  if (result.import.issues.length > 0) {
    lines.push(`Not imported exactly (${result.import.issues.length}):`, ...result.import.issues.map(describeIssue));
  }
  lines.push(
    database.created
      ? database.format === "directory"
        ? `Wrote ${database.file} (database directory: an empty file per table, and their definitions).`
        : `Wrote ${database.file} (empty collections).`
      : database.addedCollections.length > 0
        ? `Updated ${database.file} (added: ${database.addedCollections.join(", ")}); existing data was kept.`
        : database.definitionsUpdated
          ? `Updated the table definitions in ${database.file}; existing data was kept.`
          : `${database.file} already has every collection; it was not changed.`,
    ...result.generated.map((entry) => `${entry.changed ? "Wrote" : "Unchanged:"} ${entry.file}`),
    `Sandbox port: ${result.port}`,
  );
  if (script.status === "added" || script.status === "updated") {
    lines.push(`${script.status === "added" ? "Added" : "Updated"} the "${script.name}" script ${script.status === "added" ? "to" : "in"} package.json.`);
  }
  lines.push(...result.warnings.map((warning) => `Warning: ${warning}`));
  lines.push(
    script.status === "different"
      ? `package.json already has a different "${script.name}" script; start the sandbox with: ${script.command}`
      : `Start the sandbox with: npm run ${script.name}   (restarts when the application's sources change)`,
    `Start it once, without watching: ${script.runCommand}`,
    "The application's own sources and start command are unchanged.",
  );
  io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
