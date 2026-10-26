import type { DatabaseState } from "../../../core/src/index.ts";
import { SqliteRuntime } from "../../../runtime/src/index.ts";
import type { SnapshotStorage, SqlEvent, TableSchema } from "../../../runtime/src/index.ts";
import { LocalRuntimeAccess } from "../../src/index.ts";
import type { AccessLimits } from "../../src/index.ts";

/** A storage in memory that says what was saved, and can be told to refuse the next save. */
export class MemoryStorage implements SnapshotStorage {
  saved: DatabaseState[] = [];
  failNextSave: Error | undefined;
  #state: DatabaseState;

  constructor(collections: DatabaseState["collections"] = {}) {
    this.#state = { meta: { version: 1 }, collections };
  }

  async load(): Promise<DatabaseState> {
    return structuredClone(this.#state);
  }

  saveSync(state: DatabaseState): void {
    if (this.failNextSave !== undefined) {
      const error = this.failNextSave;
      this.failNextSave = undefined;
      throw error;
    }
    this.#state = structuredClone(state);
    this.saved.push(this.#state);
  }

  /** The rows of a table as they were last saved; as loaded, when nothing was saved since. */
  rows(table: string): Record<string, unknown>[] {
    return (this.saved.at(-1) ?? this.#state).collections[table] ?? [];
  }
}

export const SCHEMA: TableSchema[] = [
  {
    name: "users",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true, generated: "increment" },
      { name: "name", type: "text", declaredType: "varchar(40)", canonicalType: { kind: "varchar", length: 40 }, nullable: false, primary: false },
      { name: "active", type: "boolean", nullable: false, primary: false, default: true },
      { name: "score", type: "real", nullable: true, primary: false },
      { name: "joined", type: "datetime", nullable: true, primary: false },
      { name: "settings", type: "json", nullable: true, primary: false },
      { name: "role", type: "text", nullable: false, primary: false, default: "reader", enum: { name: "role", values: ["admin", "reader"] } },
    ],
    uniques: [{ name: "users_name_key", columns: ["name"] }],
  },
  {
    name: "orders",
    columns: [
      { name: "number", type: "text", nullable: false, primary: true },
      { name: "userId", type: "integer", nullable: true, primary: false, references: { table: "users", column: "id" } },
      { name: "total", type: "integer", nullable: false, primary: false, default: 0 },
    ],
  },
  {
    name: "memberships",
    columns: [
      { name: "userId", type: "integer", nullable: false, primary: true },
      { name: "team", type: "text", nullable: false, primary: true },
      { name: "since", type: "date", nullable: true, primary: false },
    ],
  },
  { name: "notes", columns: [{ name: "text", type: "text", nullable: true, primary: false }] },
];

/** Twenty-five users: every second one active, every fifth without a score, the first three admins. */
export const USERS = Array.from({ length: 25 }, (_unused, index) => {
  const id = index + 1;
  return {
    id,
    name: `user ${String(id).padStart(2, "0")}`,
    active: id % 2 === 1,
    score: id % 5 === 0 ? null : id * 1.5,
    joined: `2026-01-${String(id).padStart(2, "0")}T08:00:00.000Z`,
    settings: id === 1 ? { theme: "dark", tags: ["a", "b"] } : null,
    role: id <= 3 ? "admin" : "reader",
  };
});

export const DATA = (): DatabaseState["collections"] => ({
  users: structuredClone(USERS),
  orders: [
    { number: "A-1", userId: 1, total: 100 },
    { number: "A-2", userId: 2, total: 250 },
  ],
  memberships: [
    { userId: 1, team: "red", since: "2026-02-01" },
    { userId: 1, team: "blue", since: null },
    { userId: 2, team: "red", since: "2026-03-01" },
  ],
  notes: [{ text: "first" }, { text: "50% off_all" }, { text: null }],
});

export interface Opened {
  access: LocalRuntimeAccess;
  runtime: SqliteRuntime;
  storage: MemoryStorage;
  /** Every statement the runtime carried out, whoever asked. */
  events: SqlEvent[];
}

export const IDENTITY = { instance: "i".repeat(48), pid: 4242, kind: "postgrest" as const, database: "C:\\data\\sandbox.db", format: "directory" as const };

/** A runtime on the data above, as an application has it open, and the access to it. */
export async function open(options: { readOnly?: string; limits?: Partial<AccessLimits>; format?: "directory" | "file"; persistence?: "json" | "memory" } = {}): Promise<Opened> {
  const storage = new MemoryStorage(DATA());
  const runtime = await SqliteRuntime.open({ schema: SCHEMA, storage, context: () => ({ requestId: "application" }), ...(options.persistence !== undefined && { persistence: options.persistence }) });
  const events: SqlEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  let tick = Date.parse("2026-10-08T10:00:00.000Z");
  const access = new LocalRuntimeAccess({
    runtime,
    identity: { ...IDENTITY, ...(options.format !== undefined && { format: options.format }) },
    ...(options.readOnly !== undefined && { readOnly: options.readOnly }),
    ...(options.limits !== undefined && { limits: options.limits }),
    now: () => new Date((tick += 1000)),
  });
  return { access, runtime, storage, events };
}
