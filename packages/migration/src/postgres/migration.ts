import { compareText } from "../../../schema-diff/src/stable-json.ts";
import type { PostgresStatement, StatementReason } from "./statements.ts";

/*
 * A PostgreSQL migration (D-039): the statements that carry a migration plan
 * out on PostgreSQL, in segments.
 *
 *   SchemaDiff          what changed
 *   MigrationPlan       in which steps it is carried out, in any database
 *   PostgresMigration   in which statements and transactions PostgreSQL does it
 *
 * A segment says how its statements are run, because PostgreSQL does not
 * take every statement in a transaction with every other:
 *
 * - `transaction`: the statements are one transaction: all of them, or none.
 * - `autocommit`: each statement is run on its own, outside a transaction
 *   block, and stays when a later one fails.
 *
 * A segment is carried out, and committed, before the next one begins. So a
 * migration of one segment is one transaction, and one of several is not:
 * what a segment did stays when a later segment fails.
 *
 * The one reason for a segment of its own so far: a value added to an
 * enumerated type (`ALTER TYPE ... ADD VALUE`) cannot be used before it is
 * committed. What uses it stands in a later segment.
 */

export const POSTGRES_MIGRATION_VERSION = 1;

/** Why statements are a segment of their own, which no transaction holds together. */
export type SegmentReason = "enum-value-added";

export interface PostgresSegment {
  mode: "transaction" | "autocommit";
  /** On an `autocommit` segment. */
  reason?: SegmentReason;
  /** In the order they are run. */
  statements: PostgresStatement[];
}

export interface PostgresMigration {
  version: typeof POSTGRES_MIGRATION_VERSION;
  dialect: "postgresql";
  /** In the order they are carried out. */
  segments: PostgresSegment[];
}

/** The statements of a migration in their segments: a value added to an enumerated type on its own, the others in transactions around it. */
export function inSegments(statements: readonly PostgresStatement[]): PostgresSegment[] {
  const segments: PostgresSegment[] = [];
  for (const statement of statements) {
    const mode = statement.kind === "addEnumValue" ? "autocommit" : "transaction";
    const last = segments.at(-1);
    if (last !== undefined && last.mode === mode) {
      last.statements.push(statement);
    } else {
      segments.push({ mode, ...(mode === "autocommit" && { reason: "enum-value-added" as const }), statements: [statement] });
    }
  }
  return segments;
}

/** Keys written first, in this order; the others follow by code point. A constant's own keys are data, and are in code point order throughout. */
const LEADING_KEYS = [
  "status",
  "refusals",
  "steps",
  "migration",
  "version",
  "dialect",
  "segments",
  "mode",
  "step",
  "operation",
  "kind",
  "sql",
  "because",
  "safety",
  "reason",
  "detail",
  "assumes",
  "dropsData",
  "expressions",
  "statements",
  "table",
  "index",
  "column",
  "constraint",
  "name",
  "type",
  "to",
];
const RANK = new Map(LEADING_KEYS.map((key, index) => [key, index]));

/** The migration as JSON text: the same migration always gives the same bytes. */
export function stringifyPostgresMigration(migration: PostgresMigration, indent = 2): string {
  return stableJson(migration, indent);
}

/**
 * JSON text of a migration, or of what a generator gives with or instead of
 * one: every object's keys in one order, whatever order they were set in.
 */
export function stableJson(value: unknown, indent: number): string {
  const line = (depth: number): string => (indent > 0 ? `\n${" ".repeat(indent * depth)}` : "");
  const write = (item: unknown, depth: number, data: boolean): string => {
    if (Array.isArray(item)) {
      return item.length === 0 ? "[]" : `[${item.map((entry) => `${line(depth + 1)}${write(entry, depth + 1, data)}`).join(",")}${line(depth)}]`;
    }
    if (typeof item === "object" && item !== null) {
      const members = item as Record<string, unknown>;
      const rank = (key: string): number => (data ? LEADING_KEYS.length : (RANK.get(key) ?? LEADING_KEYS.length));
      const keys = Object.keys(members)
        .filter((key) => members[key] !== undefined)
        .sort((a, b) => rank(a) - rank(b) || compareText(a, b));
      // The value of a constant is what a schema holds, with keys of its own.
      return keys.length === 0 ? "{}" : `{${keys.map((key) => `${line(depth + 1)}${JSON.stringify(key)}:${indent > 0 ? " " : ""}${write(members[key], depth + 1, data || key === "value")}`).join(",")}${line(depth)}}`;
    }
    return JSON.stringify(item) ?? "null";
  };
  return write(value, 0, false);
}

const BECAUSE: Record<StatementReason, string> = {
  "foreign-key-rests-on-dropped-key": "PostgreSQL does not drop a key that a foreign key rests on: the foreign key goes first, and is added again after the last step.",
  "type-name-taken-by-table": "A table has a type of its own name: the enumerated type of that name, which is dropped later, is renamed out of its way.",
  "enum-type-made-again": "PostgreSQL takes no value out of an enumerated type and does not reorder its values: the type is made again, and its columns are given the new one.",
  "foreign-key-across-type-change": "PostgreSQL keeps no foreign key between columns of types it does not compare: while one side has its new type and the other not yet, the foreign key goes, and is added again after the last step.",
  "enum-default-across-type-change": "PostgreSQL leaves a default as the value of the enumerated type it was when its column's type changes: it is taken off before, and put back as a constant of the new type.",
  "numbering-kind-unknown": "The schema does not say whether the column is numbered as an identity or by a default: both are taken off.",
  "key-over-the-same-columns": "PostgreSQL leaves a unique constraint out of CREATE TABLE when another key is over the same columns: it is added on its own.",
};

/** A line of comment. What it says may hold a name, and a name may hold a line end, which would end the comment. */
const comment = (text: string): string => `-- ${text.replace(/[\r\n]+/g, " ")}`;

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The migration as an SQL script: every statement with its semicolon, and
 * `BEGIN` and `COMMIT` around every segment that is a transaction. The
 * script is for a client that sends one statement at a time and adds no
 * transaction of its own, as `psql -f` does. A statement that PostgreSQL
 * needs beyond its step, one that rests on what the rows are, and one that
 * loses rows each have a comment that says so.
 */
export function renderPostgresMigration(migration: PostgresMigration): string {
  const count = migration.segments.reduce((total, segment) => total + segment.statements.length, 0);
  if (count === 0) {
    return `${comment("PostgreSQL migration: no statements.")}\n`;
  }
  const several = migration.segments.length > 1;
  const lines: string[] = [comment(`PostgreSQL migration: ${plural(count, "statement")} in ${several ? `${migration.segments.length} segments` : migration.segments[0]?.mode === "transaction" ? "one transaction" : "one segment"}.`)];
  if (several) {
    lines.push(comment("It is not one transaction: what a segment did stays when a later segment fails."));
    lines.push(comment("Run it with a client that sends each statement on its own and adds no transaction of its own (psql -f)."));
  }
  for (const [index, segment] of migration.segments.entries()) {
    lines.push("");
    if (several || segment.mode === "autocommit") {
      lines.push(comment(`Segment ${index + 1} of ${migration.segments.length}: ${segment.mode === "transaction" ? "one transaction." : "outside a transaction, each statement on its own."}`));
    }
    if (segment.reason === "enum-value-added") {
      lines.push(comment("A value added to an enumerated type cannot be used before it is committed."));
    }
    if (segment.mode === "transaction") {
      lines.push("BEGIN;", "");
    }
    let said: string | undefined;
    for (const statement of segment.statements) {
      // What PostgreSQL needs for a step is said once, before the first of the statements it takes.
      const reason = statement.because === undefined ? undefined : `${statement.step} ${statement.because}`;
      if (statement.because !== undefined && reason !== said) {
        lines.push(comment(`Step ${statement.step}. ${BECAUSE[statement.because]}`));
      }
      said = reason;
      if (statement.assumes !== undefined) {
        lines.push(comment(`Step ${statement.step}. Assumes what the rows are: ${statement.assumes.detail}`));
      }
      if (statement.dropsData === true) {
        lines.push(comment(`Step ${statement.step}. The rows it holds are lost.`));
      }
      lines.push(`${statement.sql};`);
    }
    if (segment.mode === "transaction") {
      lines.push("", "COMMIT;");
    }
  }
  return `${lines.join("\n")}\n`;
}
