import { SandboxError } from "./errors.ts";
import type { OperationEvent, OperationKind, OperationListener } from "./events.ts";
import { runQuery } from "./query.ts";
import type { QueryResult, QuerySpec } from "./query.ts";
import type { DatabaseState, Row, RowId } from "./state.ts";
import {
  deleteStatement,
  insertStatement,
  selectByIdStatement,
  selectStatement,
  updateStatement,
} from "./statement.ts";
import type { StorageAdapter } from "./storage.ts";

export interface DatabaseOptions {
  /** Monotonic clock in milliseconds used for timing. Defaults to `performance.now`. */
  now?: () => number;
  /**
   * Field that identifies rows, per collection name. Collections not listed
   * here are identified by `id`.
   */
  idFields?: Record<string, string>;
}

function isPlainObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRowId(value: unknown): value is RowId {
  return typeof value === "string" ? value !== "" : typeof value === "number" && Number.isFinite(value);
}

/** IDs match by string form, so `1` and `"1"` address the same row. */
function sameId(a: unknown, b: RowId): boolean {
  return isRowId(a) && String(a) === String(b);
}

/**
 * Headless CRUD over a database state.
 *
 * Every mutation is saved through the storage adapter before it becomes
 * visible in memory, so a failed save leaves the state unchanged.
 * Rows are copied on the way in and out; callers never hold live state.
 *
 * Each collection operation, successful or not, emits one structured
 * `OperationEvent` to subscribers.
 */
export class Database {
  readonly #storage: StorageAdapter;
  readonly #now: () => number;
  readonly #idFields: Record<string, string>;
  readonly #listeners = new Set<OperationListener>();
  #state: DatabaseState;
  #pending: Promise<unknown> = Promise.resolve();

  private constructor(storage: StorageAdapter, state: DatabaseState, options: DatabaseOptions) {
    this.#storage = storage;
    this.#state = state;
    this.#now = options.now ?? (() => performance.now());
    this.#idFields = { ...options.idFields };
  }

  static async open(storage: StorageAdapter, options: DatabaseOptions = {}): Promise<Database> {
    return new Database(storage, await storage.load(), options);
  }

  /** Registers a listener for operation events. Returns a function that removes it. */
  subscribe(listener: OperationListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  listCollections(): string[] {
    return Object.keys(this.#state.collections);
  }

  findAll(collection: string): Row[] {
    return this.#read(collection, selectStatement({ collection }), () => {
      const rows = structuredClone(this.#rows(collection));
      return { value: rows, rows: rows.length };
    });
  }

  /** Name of the field that identifies rows of `collection`. */
  idField(collection: string): string {
    return Object.hasOwn(this.#idFields, collection) ? (this.#idFields[collection] as string) : "id";
  }

  findById(collection: string, id: RowId): Row {
    const key = this.idField(collection);
    return this.#read(collection, selectByIdStatement(collection, id, key), () => {
      const rows = this.#rows(collection);
      const row = structuredClone(rows[this.#indexOf(collection, rows, id)] as Row);
      return { value: row, rows: 1, statement: selectByIdStatement(collection, row[key], key) };
    });
  }

  /** Reads rows using filters, sorting, and pagination. */
  query(spec: QuerySpec): QueryResult {
    return this.#read(spec.collection, selectStatement(spec), () => {
      const result = structuredClone(runQuery(this.#rows(spec.collection), spec));
      return { value: result, rows: result.rows.length };
    });
  }

  /** Inserts a row. When its ID field is absent, the next integer ID is assigned. */
  insert(collection: string, row: Row): Promise<Row> {
    const key = this.idField(collection);
    return this.#mutate("INSERT", collection, insertStatement(collection, row, undefined, key), (rows) => {
      const next = this.#copyRow(row);
      const id = next[key];
      if (id === undefined) {
        next[key] = nextId(rows, key);
      } else if (!isRowId(id)) {
        throw new SandboxError("INVALID_ROW", `Row "${key}" must be a non-empty string or a finite number.`);
      } else if (rows.some((existing) => sameId(existing[key], id))) {
        throw new SandboxError("DUPLICATE_ID", `Row with ${key} ${String(id)} already exists in "${collection}".`);
      }
      return { rows: [...rows, next], result: next, statement: insertStatement(collection, next, next[key], key) };
    });
  }

  /** Replaces every field of a row. The stored ID is kept. */
  replace(collection: string, id: RowId, row: Row): Promise<Row> {
    return this.#update(collection, id, row, (_current, changes) => changes);
  }

  /** Shallow-merges fields into a row. The stored ID is kept. */
  patch(collection: string, id: RowId, changes: Row): Promise<Row> {
    return this.#update(collection, id, changes, (current, next) => ({ ...current, ...next }));
  }

  /** Deletes a row and returns it. */
  remove(collection: string, id: RowId): Promise<Row> {
    const key = this.idField(collection);
    return this.#mutate("DELETE", collection, deleteStatement(collection, id, key), (rows) => {
      const index = this.#indexOf(collection, rows, id);
      const removed = rows[index] as Row;
      return {
        rows: rows.filter((_, i) => i !== index),
        result: removed,
        statement: deleteStatement(collection, removed[key], key),
      };
    });
  }

  #update(collection: string, id: RowId, input: Row, merge: (current: Row, input: Row) => Row): Promise<Row> {
    const key = this.idField(collection);
    return this.#mutate("UPDATE", collection, updateStatement(collection, id, input, key), (rows) => {
      const index = this.#indexOf(collection, rows, id);
      const changes = this.#copyRow(input);
      const current = rows[index] as Row;
      if (changes[key] !== undefined && !sameId(changes[key], id)) {
        throw new SandboxError("INVALID_ROW", `Row "${key}" cannot be changed (${String(id)}).`);
      }
      const updated = { ...merge(current, changes), [key]: current[key] };
      return {
        rows: rows.map((existing, i) => (i === index ? updated : existing)),
        result: updated,
        statement: updateStatement(collection, current[key], changes, key),
      };
    });
  }

  #rows(collection: string): Row[] {
    if (!Object.hasOwn(this.#state.collections, collection)) {
      throw new SandboxError("COLLECTION_NOT_FOUND", `Collection "${collection}" does not exist.`);
    }
    return this.#state.collections[collection] as Row[];
  }

  #indexOf(collection: string, rows: Row[], id: RowId): number {
    const key = this.idField(collection);
    const index = rows.findIndex((row) => sameId(row[key], id));
    if (index === -1) {
      throw new SandboxError("ROW_NOT_FOUND", `Row with ${key} ${String(id)} does not exist in "${collection}".`);
    }
    return index;
  }

  #copyRow(row: unknown): Row {
    if (!isPlainObject(row)) {
      throw new SandboxError("INVALID_ROW", "Row must be an object.");
    }
    return structuredClone(row);
  }

  /**
   * Runs a read and emits its event. `statement` describes the request as
   * given; the read may return a more precise one once rows are resolved.
   */
  #read<T>(collection: string, statement: string, read: () => { value: T; rows: number; statement?: string }): T {
    const startedAt = this.#now();
    try {
      const outcome = read();
      this.#emit("SELECT", collection, outcome.statement ?? statement, outcome.rows, startedAt);
      return outcome.value;
    } catch (error) {
      this.#emit("SELECT", collection, statement, 0, startedAt, error);
      throw error;
    }
  }

  /** Runs mutations one at a time so overlapping calls cannot lose updates. */
  #mutate(
    operation: OperationKind,
    collection: string,
    statement: string,
    change: (rows: Row[]) => { rows: Row[]; result: Row; statement: string },
  ): Promise<Row> {
    const run = async (): Promise<Row> => {
      // Timing starts here, so time spent queued behind other mutations is excluded.
      const startedAt = this.#now();
      let described = statement;
      try {
        const outcome = change(this.#rows(collection));
        described = outcome.statement;
        const next: DatabaseState = {
          ...this.#state,
          collections: { ...this.#state.collections, [collection]: outcome.rows },
        };
        await this.#storage.save(next);
        this.#state = next;
        this.#emit(operation, collection, described, 1, startedAt);
        return structuredClone(outcome.result);
      } catch (error) {
        this.#emit(operation, collection, described, 0, startedAt, error);
        throw error;
      }
    };
    const outcome = this.#pending.then(run);
    this.#pending = outcome.catch(() => undefined);
    return outcome;
  }

  #emit(
    operation: OperationKind,
    collection: string,
    statement: string,
    rows: number,
    startedAt: number,
    error?: unknown,
  ): void {
    if (this.#listeners.size === 0) {
      return;
    }
    const event: OperationEvent = {
      operation,
      collection,
      statement,
      rows,
      localExecutionMs: Math.max(0, this.#now() - startedAt),
    };
    if (error !== undefined) {
      event.errorCode = error instanceof SandboxError ? error.code : "STORAGE_ERROR";
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener({ ...event });
      } catch {
        // A failing listener must not change the outcome of the operation.
      }
    }
  }
}

function nextId(rows: Row[], key: string): number {
  let max = 0;
  for (const row of rows) {
    const value = Number(row[key]);
    if (isRowId(row[key]) && Number.isInteger(value) && value > max) {
      max = value;
    }
  }
  return max + 1;
}
