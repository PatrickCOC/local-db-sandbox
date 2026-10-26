import type { OperationEvent } from "../../core/src/index.ts";
import type { RequestEvent } from "./events.ts";

/*
 * Human-readable log lines. These only consume structured events; nothing
 * reads the lines back. Timing labels are "local", "delay", and "total".
 */

function ms(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function rowCount(rows: number): string {
  return `${rows} ${rows === 1 ? "row" : "rows"}`;
}

function clock(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

/** Example: `12:41:03 GET   /users?active=true  200  18 rows  local=2.4ms total=6.8ms` */
export function formatRequestEvent(event: RequestEvent): string {
  const parts = [`${clock(event.timestamp)} ${event.method.padEnd(5)} ${event.path}`, String(event.status)];
  if (event.rows !== undefined) {
    parts.push(rowCount(event.rows));
  }
  const timings: string[] = [];
  if (event.localExecutionMs !== undefined) {
    timings.push(`local=${ms(event.localExecutionMs)}`);
  }
  if (event.simulatedDelayMs > 0) {
    timings.push(`delay=${ms(event.simulatedDelayMs)}`);
  }
  timings.push(`total=${ms(event.totalMs)}`);
  parts.push(timings.join(" "));
  if (event.errorCode !== undefined) {
    parts.push(event.errorCode);
  }
  if (event.simulated.length > 0) {
    parts.push(`simulated=${event.simulated.join(",")}`);
  }
  return parts.join("  ");
}

/** Example: `SELECT  2 rows  local=0.3ms  SELECT * FROM users WHERE active = 'true'` */
export function formatOperationEvent(event: OperationEvent): string {
  const parts = [event.operation.padEnd(6), rowCount(event.rows), `local=${ms(event.localExecutionMs)}`];
  if (event.errorCode !== undefined) {
    parts.push(event.errorCode);
  }
  parts.push(event.statement ?? event.collection);
  return parts.join("  ");
}
