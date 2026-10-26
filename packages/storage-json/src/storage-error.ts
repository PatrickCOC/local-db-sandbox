/** Raised when a JSON database, a single file or a directory, cannot be read or written. */
export class JsonStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JsonStorageError";
  }
}
