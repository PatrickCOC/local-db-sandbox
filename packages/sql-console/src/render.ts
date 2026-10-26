import type { ConsoleResult, TableDefinitionSource } from "./sql-console.ts";

/** How `.tables` names where a table's columns come from. */
const COLUMNS_FROM: Record<TableDefinitionSource, string> = { stored: "stored schema", given: "entities", data: "the data" };

function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (value instanceof Uint8Array) {
    return `<${value.byteLength} bytes>`;
  }
  // One line per row: line breaks inside a value are shown escaped.
  return String(value).replace(/\r?\n/g, "\\n");
}

function time(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function table(columns: string[], rows: string[][]): string[] {
  const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => (row[index] as string).length)));
  const line = (cells: string[]): string => cells.map((text, index) => text.padEnd(widths[index] as number)).join("  ").trimEnd();
  return [line(columns), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

/**
 * Terminal text for a result. Values are shown as SQLite holds them, which
 * is what SQL sees: booleans as 1 and 0, dates as text, JSON as text. Times
 * are local SQLite execution times, not production database performance.
 */
export function renderText(result: ConsoleResult): string {
  switch (result.kind) {
    case "rows": {
      const lines = table(result.columns, result.rows.map((row) => result.columns.map((column) => cell(row[column]))));
      const affected = result.affectedRows === undefined ? "" : `, ${count(result.affectedRows, "row")} affected`;
      return [...lines, `(${count(result.rows.length, "row")}${affected}, ${time(result.localExecutionMs)})`].join("\n");
    }
    case "write":
      return `${count(result.affectedRows, "row")} affected (${time(result.localExecutionMs)})`;
    case "ok":
      return [`${result.transaction ?? "OK"} (${time(result.localExecutionMs)})`, ...(result.notice === undefined ? [] : [`Note: ${result.notice}`])].join("\n");
    case "tables":
      return result.tables.length === 0
        ? "(no tables)"
        : table(["table", "rows", "columns from"], result.tables.map((entry) => [entry.name, String(entry.rows), COLUMNS_FROM[entry.source]])).join("\n");
    case "schema":
      return result.tables.map((entry) => `${entry.sql};${entry.source === "data" ? "\n-- columns and types were worked out from the table's rows" : ""}`).join("\n\n");
    case "help":
      return result.text;
    case "exit":
      return "";
    case "error":
      return [`Error: ${result.message}`, ...(result.notice === undefined ? [] : [result.notice])].join("\n");
  }
}

/** One line of JSON for a result, for scripts. */
export function renderJson(result: ConsoleResult): string {
  if (result.kind === "error") {
    return JSON.stringify({ error: { code: result.code, message: result.message }, ...(result.notice !== undefined && { notice: result.notice }) });
  }
  if (result.kind === "rows") {
    const { kind: _kind, rows, ...rest } = result;
    return JSON.stringify({ ...rest, rowCount: rows.length, rows }, (_key, value: unknown) => (typeof value === "bigint" ? Number(value) : value));
  }
  const { kind: _kind, ...rest } = result;
  return JSON.stringify(rest);
}
