/*
 * What became of each statement of the migrations. The report is structured
 * data; the lines the CLI prints are formatted from it.
 *
 * Every statement gets at least one entry, so that nothing a migration says
 * is passed over in silence. An `ALTER TABLE` with several actions gets one
 * entry per action.
 */

/**
 * - `applied`: reproduced in the local schema, and enforced by the runtime.
 * - `seeded`: rows a migration inserts, loaded into the new database.
 * - `retained`: kept in the local schema as information, not enforced
 *   (a check constraint, a default the runtime does not compute, an index
 *   over expressions).
 * - `not-reproduced`: database behavior that the sandbox does not provide on
 *   purpose: row level security, permissions, extensions, functions,
 *   triggers, scheduling, objects of other schemas, temporary tables.
 * - `no-effect`: changes nothing a local database would hold (comments,
 *   transaction control, session settings).
 * - `unsupported`: changes the schema or data in a way the collector does not
 *   handle. The local schema may differ from PostgreSQL's there.
 */
export type ReportOutcome = "applied" | "seeded" | "retained" | "not-reproduced" | "no-effect" | "unsupported";

export type ReportCategory =
  | "table"
  | "column"
  | "constraint"
  | "index"
  | "type"
  | "data"
  | "row-level-security"
  | "permissions"
  | "extensions"
  | "functions"
  | "triggers"
  | "scheduling"
  | "replication"
  | "other-schemas"
  | "temporary-tables"
  | "views"
  | "sequences"
  | "comments"
  | "transactions"
  | "session"
  | "other";

export interface ReportEntry {
  /** The migration file, relative to the migrations directory. */
  file: string;
  /** 1-based line of the statement. */
  line: number;
  /** 1-based number of the statement in its file. */
  statement: number;
  /** PostgreSQL's node type, and the action of an `ALTER`: `AlterTableStmt/AT_AddColumn`. */
  kind: string;
  outcome: ReportOutcome;
  category: ReportCategory;
  /** What it concerns: `table`, `table.column`, a constraint, index, type, or function name. */
  object?: string;
  message: string;
  /** The statement, shortened. */
  sql: string;
}

export interface MigrationSummary {
  file: string;
  sha256: string;
  statements: number;
}

/** Entries by outcome, and the `not-reproduced` ones by category. */
export function summarizeReport(entries: readonly ReportEntry[]): { outcomes: Record<ReportOutcome, number>; notReproduced: Partial<Record<ReportCategory, number>> } {
  const outcomes: Record<ReportOutcome, number> = { applied: 0, seeded: 0, retained: 0, "not-reproduced": 0, "no-effect": 0, unsupported: 0 };
  const notReproduced: Partial<Record<ReportCategory, number>> = {};
  for (const entry of entries) {
    outcomes[entry.outcome] += 1;
    if (entry.outcome === "not-reproduced") {
      notReproduced[entry.category] = (notReproduced[entry.category] ?? 0) + 1;
    }
  }
  return { outcomes, notReproduced };
}

/** `file:line` and the statement's message, as a line of text. */
export function formatReportEntry(entry: ReportEntry): string {
  return `${entry.file}:${entry.line} ${entry.outcome}${entry.outcome === "not-reproduced" ? ` (${entry.category})` : ""}: ${entry.message}`;
}

/** A statement's text on one line, at most `length` characters. */
export function shorten(sql: string, length = 160): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}
