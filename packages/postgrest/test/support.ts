import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Row } from "../../core/src/index.ts";
import type { SqlEvent, TableSchema } from "../../runtime/src/index.ts";
import { createDatabase } from "../../storage-json/src/index.ts";
import { startPostgrestSandbox } from "../src/index.ts";
import type { PostgrestRequestEvent, PostgrestSandboxOptions, RunningPostgrestSandbox } from "../src/index.ts";

/*
 * A synthetic schema that has a column of every storage type, a composite
 * primary key, and a foreign key. It belongs to no application.
 */
export const SCHEMA: TableSchema[] = [
  {
    name: "teams",
    columns: [
      { name: "id", type: "integer", declaredType: "int4", nullable: false, primary: true },
      { name: "name", type: "text", nullable: false, primary: false },
      { name: "active", type: "boolean", nullable: false, primary: false, default: true },
      { name: "founded", type: "date", nullable: true, primary: false },
      { name: "meta", type: "json", declaredType: "jsonb", nullable: true, primary: false },
      { name: "budget", type: "numeric", declaredType: "numeric(12,2)", nullable: true, primary: false },
      { name: "big", type: "integer", declaredType: "int8", nullable: true, primary: false },
      { name: "logo", type: "binary", declaredType: "bytea", nullable: true, primary: false },
      { name: "seen_at", type: "datetime", declaredType: "timestamptz", nullable: true, primary: false },
    ],
  },
  {
    name: "readings",
    columns: [
      { name: "taken_at", type: "datetime", declaredType: "timestamptz", nullable: false, primary: true },
      { name: "sensor", type: "text", nullable: false, primary: true },
      { name: "value", type: "real", declaredType: "float8", nullable: false, primary: false },
      { name: "team_id", type: "integer", nullable: true, primary: false, references: { table: "teams", column: "id", onDelete: "CASCADE" } },
    ],
  },
];

export function fixture(): Record<string, Row[]> {
  return {
    teams: [
      { id: 1, name: "Alpha", active: true, founded: "2001-02-03", meta: { tags: ["a"] }, budget: 12.5, big: 7, logo: null, seen_at: "2026-10-06T09:00:00.000Z" },
      { id: 2, name: "Beta", active: false, founded: null, meta: null, budget: null, big: null, logo: null, seen_at: null },
      { id: 3, name: "Gamma", active: true, founded: null, meta: null, budget: null, big: null, logo: null, seen_at: null },
      { id: 4, name: "Delta", active: true, founded: null, meta: null, budget: null, big: null, logo: null, seen_at: null },
      { id: 5, name: "Epsilon", active: false, founded: null, meta: null, budget: null, big: null, logo: null, seen_at: null },
    ],
    readings: [
      { taken_at: "2026-10-06T08:00:00.000Z", sensor: "s1", value: 1, team_id: 1 },
      { taken_at: "2026-10-06T12:00:00.000Z", sensor: "s1", value: 2, team_id: 1 },
      { taken_at: "2026-10-06T18:30:00.000Z", sensor: "s1", value: 3, team_id: 2 },
      { taken_at: "2026-10-07T01:00:00.000Z", sensor: "s2", value: 4, team_id: 2 },
    ],
  };
}

export interface Harness {
  directory: string;
  database: string;
  sandbox: RunningPostgrestSandbox;
  client: SupabaseClient;
  sql: SqlEvent[];
  requests: PostgrestRequestEvent[];
  /** Stops the sandbox and opens the same database again. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

/** A database directory with the synthetic schema, served on a free loopback port, and a supabase-js client for it. */
export async function startHarness(options: Partial<PostgrestSandboxOptions> & { rows?: Record<string, Row[]> } = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "postgrest-"));
  const database = join(directory, "sandbox.db");
  await createDatabase(database, { collections: options.rows ?? fixture(), schema: SCHEMA }, { format: "directory" });
  const sql: SqlEvent[] = [];
  const requests: PostgrestRequestEvent[] = [];
  const open = (): Promise<RunningPostgrestSandbox> =>
    startPostgrestSandbox({ port: 0, ...options, database, onSql: (event) => sql.push(event), onRequest: (event) => requests.push(event) });
  const harness: Harness = {
    directory,
    database,
    sandbox: await open(),
    client: undefined as unknown as SupabaseClient,
    sql,
    requests,
    async restart() {
      await harness.sandbox.stop();
      harness.sandbox = await open();
      harness.client = clientFor(harness.sandbox.url);
    },
    async close() {
      await harness.sandbox.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  harness.client = clientFor(harness.sandbox.url);
  return harness;
}

/** A client created the way an application creates one: a URL and a key, nothing else. */
export function clientFor(url: string, headers?: Record<string, string>): SupabaseClient {
  return createClient(url, "local-anon-key", headers === undefined ? undefined : { global: { headers } });
}
