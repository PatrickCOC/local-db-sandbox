import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tableFileStem } from "../../src/index.ts";

/*
 * A database directory names the file of every table in its manifest, and a
 * table that was saved again has a file named after that save's generation
 * (`tables/users.g7.json`). Tests look at a directory through these helpers,
 * so that they say which table they mean and not which generation.
 */

interface ManifestFiles {
  schema?: string;
  tables: { name: string; file: string }[];
}

function manifestOf(directory: string): ManifestFiles {
  return JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
}

/** The path of the file that holds a table's rows now. */
export function tableFile(directory: string, table: string): string {
  const entry = manifestOf(directory).tables.find(({ name }) => name === table);
  if (entry === undefined) {
    throw new Error(`${directory} has no table "${table}".`);
  }
  return join(directory, "tables", entry.file);
}

/** The path of the file that holds the table definitions now. */
export function schemaFile(directory: string): string {
  return join(directory, manifestOf(directory).schema ?? "schema.json");
}

/** The rows a table's file holds now. */
export async function storedRows(directory: string, table: string): Promise<Record<string, any>[]> {
  return JSON.parse(await readFile(tableFile(directory, table), "utf8"));
}

/**
 * The files the database consists of now, with their text, under the names
 * they have in a new database: `manifest.json`, `schema.json`, and
 * `tables/<table>.json`. Files of earlier saves that are still in the
 * directory are not part of it.
 */
export async function databaseFiles(directory: string): Promise<Record<string, string>> {
  const manifest = manifestOf(directory);
  const found: Record<string, string> = { "manifest.json": await readFile(join(directory, "manifest.json"), "utf8") };
  if (existsSync(schemaFile(directory))) {
    found["schema.json"] = await readFile(schemaFile(directory), "utf8");
  }
  for (const { file } of manifest.tables) {
    found[`tables/${tableFileStem(file)}.json`] = await readFile(join(directory, "tables", file), "utf8");
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

/** Every file under a directory, whatever it is, by relative path with forward slashes. */
export async function allFiles(directory: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const entry of (await readdir(directory, { recursive: true, withFileTypes: true })).filter((candidate) => candidate.isFile())) {
    const path = join(entry.parentPath, entry.name);
    found[path.slice(directory.length + 1).replaceAll("\\", "/")] = await readFile(path, "utf8");
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}
