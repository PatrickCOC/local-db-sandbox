import type { SqlEvent, SqlEventListener } from "./runtime.ts";

/**
 * - `off`: nothing is printed.
 * - `summary`: one short line per statement, without SQL text or values.
 * - `verbose`: a block per statement with the SQL text, the bound
 *   parameters, the row counts, the returned rows (up to a limit), the time,
 *   and the error. Parameters and rows are application data and may be
 *   sensitive.
 */
export type SqlLogMode = "off" | "summary" | "verbose";

export interface SqlFormatOptions {
  /** Default: `summary`. */
  mode?: Exclude<SqlLogMode, "off">;
  /**
   * Most returned rows to print per statement in verbose mode. The event
   * itself carries at most the runtime's own preview limit (20 by default);
   * this can only show fewer. `0` prints no row values.
   */
  previewRows?: number;
  /** Replaces the parameters before they are printed, for example to mask secrets. Nothing is redacted by default. */
  redact?: (parameters: unknown[], event: SqlEvent) => unknown[];
  /** Replaces the returned rows before they are printed. Nothing is redacted by default. */
  redactRows?: (rows: Record<string, unknown>[], event: SqlEvent) => unknown[];
}

const MAX_SQL_LENGTH = 4000;
const MAX_VALUE_LENGTH = 200;

/** Values as they can be printed: long text is shortened, and types JSON lacks are described. */
function printable(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value instanceof Uint8Array) {
    return `<${value.byteLength} bytes>`;
  }
  return typeof value === "string" && value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}... (${value.length} characters)` : value;
}

/** `[request #n]`, the statement's place in its request; empty when the event carries none. */
function origin(event: SqlEvent): string {
  if (event.requestId === undefined) {
    return "";
  }
  return `[${event.requestId}${event.sequence === undefined ? "" : ` #${event.sequence}`}] `;
}

function summary(event: SqlEvent): string {
  const parts = [`${event.localExecutionMs.toFixed(1)}ms`, event.transaction ?? event.operation];
  if (event.transaction === undefined) {
    if (event.tables !== undefined) {
      parts.push(event.tables.join(","));
    }
    parts.push(`rows=${event.rows}`);
  }
  if (event.errorCode !== undefined) {
    parts.push(event.errorCode);
  }
  return `${origin(event)}${parts.join(" ")}`;
}

function verbose(event: SqlEvent, options: SqlFormatOptions): string {
  const sql = event.sql.replace(/\s+/g, " ").trim();
  const heading = [event.transaction ?? event.operation, ...(event.transaction === undefined && event.tables !== undefined ? [event.tables.join(",")] : [])];
  const lines = [`${origin(event)}${heading.join(" ")}`, `sql: ${sql.length > MAX_SQL_LENGTH ? `${sql.slice(0, MAX_SQL_LENGTH)}...` : sql}`];
  if (event.transaction === undefined) {
    const parameters = options.redact === undefined ? event.parameters : options.redact([...event.parameters], event);
    lines.push(`params: ${JSON.stringify(parameters, printable)}`);
  }
  if (event.returnedRows !== undefined) {
    lines.push(`rows: ${event.returnedRows}`);
  }
  if (event.affectedRows !== undefined) {
    lines.push(`affected: ${event.affectedRows}`);
  }
  if (event.returnedRows !== undefined && event.resultPreview !== undefined) {
    const preview = event.resultPreview.slice(0, options.previewRows ?? event.resultPreview.length);
    if (preview.length < event.returnedRows) {
      lines.push(`showing: ${preview.length}`);
    }
    if (preview.length > 0) {
      lines.push(`result: ${JSON.stringify(options.redactRows === undefined ? preview : options.redactRows([...preview], event), printable)}`);
    }
  }
  lines.push(`time: ${event.localExecutionMs.toFixed(1)}ms`);
  if (event.errorCode !== undefined) {
    lines.push(`error: ${event.errorCode}: ${(event.errorMessage ?? "").split("\n")[0]}`);
  }
  return lines.join("\n");
}

/**
 * Terminal text for one executed statement: one line in summary mode, a
 * block of labelled lines in verbose mode. Every statement gets its own
 * entry; nothing is merged. Several tables on one entry mean one statement
 * that names them all, such as a join.
 *
 * The time is what the local SQLite runtime spent on the statement; it is
 * not a measure of production database speed.
 */
export function formatSqlEvent(event: SqlEvent, options: SqlFormatOptions = {}): string {
  return options.mode === "verbose" ? verbose(event, options) : summary(event);
}

/**
 * A listener that writes each event with `write`, or `undefined` when the
 * mode is `off`. The events themselves stay the source of truth; this only
 * formats them.
 */
export function createSqlLogger(mode: SqlLogMode, write: (text: string) => void, options: Omit<SqlFormatOptions, "mode"> = {}): SqlEventListener | undefined {
  if (mode !== "off" && mode !== "summary" && mode !== "verbose") {
    throw new TypeError('SQL log mode must be "off", "summary", or "verbose".');
  }
  return mode === "off" ? undefined : (event) => write(formatSqlEvent(event, { ...options, mode }));
}
