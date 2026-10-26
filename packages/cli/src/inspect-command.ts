import { parseArgs } from "node:util";
import { inspectDatabase, maxFileSizeMbProblem, migrateCommand, readProblem } from "../../storage-json/src/index.ts";
import type { DatabaseFormat, DatabaseInspection } from "../../storage-json/src/index.ts";
import type { CliIo } from "./cli.ts";

export const INSPECT_USAGE = `Usage: local-db-sandbox inspect <database> [options]

Says what format a database is stored in, whether this build reads and writes
that format, and whether it has to be migrated. Nothing is changed, whatever
the format: of a database directory only manifest.json is read.

Options:
      --json               Print the result as JSON
      --max-file-size <MB> Largest database to accept (default: 150; at most 250)
  -h, --help               Show this help

The format version says how a database is laid out on disk. It is not the
version of this package. See "local-db-sandbox migrate --help".
`;

export const STORAGE_NAMES: Record<DatabaseFormat, string> = { file: "single file", directory: "directory" };

/** A size for people, with the exact number of bytes. */
export function formatBytes(bytes: number): string {
  const exact = `${bytes.toLocaleString("en-US")} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024) {
    return exact;
  }
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB (${exact})` : `${(bytes / (1024 * 1024)).toFixed(2)} MB (${exact})`;
}

/** `--max-file-size` as a number, or the reason it is not usable. */
export function parseMaxFileSize(value: string | undefined): { maxFileSizeMb?: number; problem?: string } {
  if (value === undefined) {
    return {};
  }
  const maxFileSizeMb = /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
  const problem = maxFileSizeMbProblem(maxFileSizeMb, "--max-file-size");
  return problem === undefined ? { maxFileSizeMb } : { problem };
}

/** The lines `inspect` prints. The inspection stays the source of truth; `--json` prints it. */
export function formatInspection(inspection: DatabaseInspection): string[] {
  const { path, formatVersion, minimumReaderVersion, currentVersion, compatibility } = inspection;
  const lines = [
    `Database: ${path}`,
    `Storage: ${STORAGE_NAMES[inspection.storage]}`,
    `Format version: ${formatVersion}${inspection.declared ? "" : " (not stated in the file)"}`,
    ...(minimumReaderVersion === formatVersion ? [] : [`Minimum reader version: ${minimumReaderVersion}`]),
    `Current supported version: ${currentVersion}`,
    `Migration required: ${inspection.migrationRequired ? "yes" : "no"}`,
  ];
  if (inspection.migrationRequired) {
    lines.push(`Migration path: ${inspection.migrationPath.length > 0 ? inspection.migrationPath.join(" -> ") : "none in this build"}`);
  }
  if (inspection.tables !== undefined) {
    lines.push(`Tables: ${inspection.tables}`);
  }
  if (inspection.logicalSizeBytes !== undefined) {
    lines.push(`Logical size: ${formatBytes(inspection.logicalSizeBytes)}`);
  }
  lines.push(...inspection.notes.map((note) => `Note: ${note}`));
  if (compatibility === "older") {
    lines.push(`This build reads the database as it is and does not change it. To bring it to format ${currentVersion}: ${migrateCommand(path)}`);
  } else if (compatibility === "newer") {
    lines.push(`Database format ${formatVersion} is newer than this build supports (max ${currentVersion}). It can be read by this build, and not changed. Upgrade local-db-sandbox.`);
  } else if (compatibility !== "current") {
    lines.push((readProblem(inspection) as { message: string }).message);
  }
  return lines;
}

/** Runs `inspect` and resolves with the process exit code. */
export async function runInspect(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox inspect --help" for usage.\n`);
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
    io.stdout.write(INSPECT_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    return fail(positionals.length === 0 ? "Missing the database to inspect." : "Expected exactly one database to inspect.");
  }
  const { maxFileSizeMb, problem } = parseMaxFileSize(values["max-file-size"]);
  if (problem !== undefined) {
    return fail(problem);
  }

  let inspection: DatabaseInspection;
  try {
    inspection = inspectDatabase(positionals[0] as string, { maxFileSizeMb });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (values.json) {
    const { path, storage, formatVersion, declared, notes, ...status } = inspection;
    io.stdout.write(`${JSON.stringify({ database: path, storage, formatVersion, versionDeclared: declared, ...status, notes }, null, 2)}\n`);
  } else {
    io.stdout.write(`${formatInspection(inspection).join("\n")}\n`);
  }
  return 0;
}
