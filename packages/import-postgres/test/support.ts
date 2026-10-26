import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { collectPostgresMigrations } from "../src/index.ts";
import type { CollectedSchema } from "../src/index.ts";
import type { ColumnSchema, TableSchema } from "../../runtime/src/index.ts";

/*
 * What the collector's tests share: migrations written into a temporary
 * directory, collected at a fixed time, and looked up by name.
 */

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A directory of migration files, by name. It is removed when the test file ends. */
export function migrations(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pg-migrations-"));
  roots.push(root);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(root, name), sql);
  }
  return root;
}

export const NOW = (): Date => new Date("2026-10-07T08:00:00.000Z");

export function collect(files: Record<string, string>): Promise<CollectedSchema> {
  return collectPostgresMigrations(migrations(files), { now: NOW });
}

export function table(result: CollectedSchema, name: string): TableSchema {
  const found = result.tables.find((candidate) => candidate.name === name);
  assert.ok(found, `table ${name}`);
  return found;
}

export function column(result: CollectedSchema, tableName: string, name: string): ColumnSchema {
  const found = table(result, tableName).columns.find((candidate) => candidate.name === name);
  assert.ok(found, `column ${tableName}.${name}`);
  return found;
}
