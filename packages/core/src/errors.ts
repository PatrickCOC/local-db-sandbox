export type SandboxErrorCode =
  | "COLLECTION_NOT_FOUND"
  | "ROW_NOT_FOUND"
  | "DUPLICATE_ID"
  | "INVALID_ROW"
  | "INVALID_QUERY"
  | "SANDBOX_SIZE_LIMIT";

/**
 * Error raised by core operations. Adapters map `code` to their own
 * representation (for example an HTTP status); the core does not.
 */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, message: string) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

/**
 * Raised by a storage adapter when the stored database is, or would become,
 * larger than its size limit. The core never checks sizes itself; it only
 * lets this error pass through like any other failed save.
 */
export class SandboxLimitError extends SandboxError {
  /** Size that was found, or that the rejected write would have produced. */
  readonly sizeBytes: number;
  readonly limitBytes: number;

  constructor(message: string, sizeBytes: number, limitBytes: number) {
    super("SANDBOX_SIZE_LIMIT", message);
    this.name = "SandboxLimitError";
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}
