import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { importTypeorm, toDatabaseDocument } from "../../import-typeorm/src/index.ts";
import type { ImportIssue, ImportedCollection } from "../../import-typeorm/src/index.ts";
import { SandboxLimitError } from "../../core/src/index.ts";
import { DEFAULT_MAX_FILE_SIZE_MB, assertWithinSizeLimit } from "../../storage-json/src/index.ts";
import type { CliIo } from "./cli.ts";

export const IMPORT_TYPEORM_USAGE = `Usage: local-db-sandbox import-typeorm <path> [options]

Creates a sandbox database file from the TypeORM entity classes in <path>
(a file or a folder). Run it inside the project that has TypeORM installed.

Options:
  -o, --out <file>   File to write (default: db.json)
      --sample-rows  Add one fixed placeholder row per collection (default: empty collections)
      --force        Overwrite the output file if it exists
  -h, --help         Show this help
`;

export function describeCollection(collection: ImportedCollection): string {
  const fields = collection.fields.map((field) =>
    field.references === undefined ? field.name : `${field.name} -> ${field.references.collection}.${field.references.field}`,
  );
  return `  ${collection.name} (${collection.source}): ${fields.join(", ")}`;
}

export function describeIssue(issue: ImportIssue): string {
  const where = [issue.entity, issue.property].filter((part) => part !== undefined).join(".");
  return `  [${issue.kind}] ${where === "" ? "" : `${where}: `}${issue.message}`;
}

/** Runs `import-typeorm` and resolves with the process exit code. */
export function runImportTypeorm(argv: string[], io: CliIo): number {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox import-typeorm --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        "sample-rows": { type: "boolean" },
        force: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout.write(IMPORT_TYPEORM_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    return fail("Expected exactly one path to TypeORM entities.");
  }
  const path = positionals[0] as string;
  const out = values.out ?? "db.json";

  let result;
  try {
    result = importTypeorm(path);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  const document = toDatabaseDocument(result, { sampleRows: values["sample-rows"] === true });
  const text = `${JSON.stringify(document, null, 2)}\n`;
  try {
    // The generated file must be one the sandbox will accept.
    assertWithinSizeLimit(Buffer.byteLength(text), DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024, "save");
    // "wx" refuses to replace an existing file.
    writeFileSync(out, text, { flag: values.force ? "w" : "wx" });
  } catch (error) {
    if (error instanceof SandboxLimitError) {
      return fail(error.message);
    }
    if ((error as { code?: unknown }).code === "EEXIST") {
      return fail(`${out} already exists. Use --force to overwrite it or --out to write elsewhere.`);
    }
    return fail(`Cannot write ${out}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const count = result.collections.length;
  const lines = [
    `Imported ${count} TypeORM ${count === 1 ? "entity" : "entities"} from ${path}`,
    ...result.collections.map(describeCollection),
  ];
  if (result.issues.length > 0) {
    lines.push(`Not imported exactly (${result.issues.length}):`, ...result.issues.map(describeIssue));
  }
  lines.push(
    `Wrote ${out} (${values["sample-rows"] ? "one placeholder row per collection" : "empty collections"}).`,
    `Start it with: local-db-sandbox ${out}`,
  );
  io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
