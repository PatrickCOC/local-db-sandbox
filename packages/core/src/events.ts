export type OperationKind = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

/**
 * Structured record of one local operation. Human-readable logs are derived
 * from this; it is never built from formatted strings.
 */
export interface OperationEvent {
  operation: OperationKind;
  collection: string;
  /** SQL-like diagnostic text only. No SQL is parsed or executed. */
  statement?: string;
  /** Rows returned by a read or affected by a write; 0 when the operation failed. */
  rows: number;
  /**
   * Time spent running this operation in the local sandbox, including saving
   * through the storage adapter. Not a database performance figure.
   */
  localExecutionMs: number;
  /** Set when the operation failed. */
  errorCode?: string;
}

export type OperationListener = (event: OperationEvent) => void;
