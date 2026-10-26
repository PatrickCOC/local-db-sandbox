import type { OperationEvent } from "../../core/src/index.ts";

export type SimulationEffect = "delay" | "error" | "status" | "empty";

/**
 * Structured record of one HTTP request. Log lines are derived from this.
 *
 * All timings describe the local sandbox process only. None of them is a
 * measure of how a real database or backend would perform.
 */
export interface RequestEvent {
  /** When the request arrived, as epoch milliseconds. */
  timestamp: number;
  method: string;
  /** Path and query string as requested. */
  path: string;
  /** Status code that was sent. */
  status: number;
  /** Rows in the response as sent; absent when no core operation ran. */
  rows?: number;
  /** Sum of `localExecutionMs` of the operations below; absent when none ran. */
  localExecutionMs?: number;
  /** Time actually spent waiting in artificial latency; 0 when none was configured. */
  simulatedDelayMs: number;
  /** Wall time from receiving the request to finishing the response, including simulated delay. */
  totalMs: number;
  /** Error code in the response body, real or simulated. */
  errorCode?: string;
  /** Simulation effects that changed this response. */
  simulated: SimulationEffect[];
  /** Core operations run for this request, in order. */
  operations: OperationEvent[];
}

export type RequestListener = (event: RequestEvent) => void;
