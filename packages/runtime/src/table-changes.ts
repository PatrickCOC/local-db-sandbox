import type { DatabaseSync } from "node:sqlite";
import type { TableSchema } from "./runtime.ts";

type Session = ReturnType<DatabaseSync["createSession"]>;

/**
 * Whether the engine's change tracking sees every row of the table. It goes
 * by primary key and passes over a row whose key is NULL, so a table has to
 * have a key that cannot be NULL: a single integer key, which is the row's
 * own id, or key columns that are all declared not nullable.
 */
function isObservable(table: TableSchema): boolean {
  const key = table.columns.filter((column) => column.primary);
  if (key.length === 1 && (key[0] as (typeof key)[number]).type === "integer") {
    return true;
  }
  return key.length > 0 && key.every((column) => !column.nullable);
}

/**
 * Tells which tables have rows that differ from an earlier moment, from what
 * SQLite itself records of the rows it changes (its session extension). No
 * statement is inspected: a row changed by a trigger or by a foreign key's
 * ON DELETE action counts like any other, and a change that was rolled back,
 * to a savepoint or altogether, or undone by a later change, does not count.
 */
export class TableChanges {
  readonly #database: DatabaseSync;
  readonly #sessions = new Map<string, Session>();
  /** Tables whose changes cannot be seen (see `isObservable`). */
  readonly #unobserved: string[];
  #failed = false;

  private constructor(database: DatabaseSync, schema: readonly TableSchema[]) {
    this.#database = database;
    this.#unobserved = schema.filter((table) => !isObservable(table)).map((table) => table.name);
    for (const table of schema) {
      if (isObservable(table)) {
        this.#sessions.set(table.name, database.createSession({ table: table.name }));
      }
    }
  }

  /** Starts tracking the tables of `schema`, which exist in `database`. `undefined` when this build of SQLite cannot track changes. */
  static attach(database: DatabaseSync, schema: readonly TableSchema[]): TableChanges | undefined {
    if (typeof database.createSession !== "function") {
      return undefined;
    }
    try {
      return new TableChanges(database, schema);
    } catch {
      return undefined;
    }
  }

  /**
   * The tables whose rows differ from what they were when they were last
   * settled, or when tracking started. `undefined` when that cannot be told:
   * a table of the schema cannot be observed, or tracking failed. The caller
   * then has to take every table as changed.
   */
  changed(): string[] | undefined {
    if (this.#failed || this.#unobserved.length > 0) {
      return undefined;
    }
    try {
      return [...this.#sessions].filter(([, session]) => session.patchset().byteLength > 0).map(([name]) => name);
    } catch {
      this.#failed = true;
      return undefined;
    }
  }

  /** Takes the tables' rows as they are now as what later changes are measured from. Call it outside a transaction. */
  settle(tables: readonly string[]): void {
    for (const name of tables) {
      const session = this.#sessions.get(name);
      if (session === undefined) {
        continue;
      }
      try {
        session.close();
        this.#sessions.set(name, this.#database.createSession({ table: name }));
      } catch {
        this.#failed = true;
      }
    }
  }

  close(): void {
    for (const session of this.#sessions.values()) {
      try {
        session.close();
      } catch {
        // Closed with the database.
      }
    }
    this.#sessions.clear();
  }
}
