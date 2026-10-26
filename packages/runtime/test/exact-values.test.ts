import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DatabaseState } from "../../core/src/index.ts";
import { RuntimeSchemaError, SqliteRuntime } from "../src/index.ts";
import type { SnapshotStorage, TableSchema } from "../src/index.ts";

/*
 * Values that SQLite holds and a JavaScript number, or JSON, does not:
 * 64-bit integers and bytes. What the runtime returns for them, and what it
 * writes to and reads from the fixture, without any ORM.
 */

class MemoryStorage implements SnapshotStorage {
  state: DatabaseState;

  constructor(collections: DatabaseState["collections"]) {
    this.state = { meta: { version: 1 }, collections };
  }

  async load(): Promise<DatabaseState> {
    return structuredClone(this.state);
  }

  saveSync(state: DatabaseState): void {
    this.state = structuredClone(state);
  }
}

const SCHEMA: TableSchema[] = [
  {
    name: "counters",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "total", type: "integer", nullable: true, primary: false },
    ],
  },
  {
    name: "files",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "content", type: "binary", nullable: true, primary: false },
    ],
  },
];
/** One more than the largest integer a JavaScript number holds exactly, and the smallest 64-bit integer. */
const BEYOND = "9007199254740993";
const LOWEST = "-9223372036854775808";

describe("integers beyond what a number holds exactly", () => {
  it("are returned as text of their digits, and smaller ones as numbers", async () => {
    const runtime = await SqliteRuntime.open({ schema: SCHEMA });
    runtime.execute("INSERT INTO counters (total) VALUES (?), (?), (?), (?)", [BEYOND, 9007199254740991, LOWEST, null]);
    assert.deepEqual(runtime.execute("SELECT total FROM counters ORDER BY id").rows, [{ total: BEYOND }, { total: 9007199254740991 }, { total: LOWEST }, { total: null }]);
    // They are integers to SQLite, whatever they were bound as.
    assert.deepEqual(runtime.execute("SELECT typeof(total) AS type, total - 3 AS less, total - 1 AS edge FROM counters WHERE id = 1").rows, [{ type: "integer", less: 9007199254740990, edge: "9007199254740992" }]);
    assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM counters WHERE total > ?", ["9007199254740992"]).rows, [{ n: 1 }]);
  });

  it("are exact in what a statement that writes returns, which is run only once", async () => {
    const runtime = await SqliteRuntime.open({ schema: SCHEMA });
    const result = runtime.execute("INSERT INTO counters (total) VALUES (?) RETURNING id, total", [BigInt(BEYOND)]);
    assert.deepEqual(result.rows, [{ id: 1, total: BEYOND }]);
    assert.deepEqual(runtime.execute("SELECT COUNT(*) AS n FROM counters").rows, [{ n: 1 }]);
    assert.deepEqual(runtime.execute("UPDATE counters SET total = total + 2 RETURNING total").rows, [{ total: "9007199254740995" }]);
  });

  it("are text of their digits in the fixture, and are loaded from there exactly", async () => {
    const storage = new MemoryStorage({ counters: [{ id: 1, total: BEYOND }, { id: 2, total: 5 }] });
    const runtime = await SqliteRuntime.open({ schema: SCHEMA, storage });
    assert.deepEqual(runtime.execute("SELECT typeof(total) AS type FROM counters").rows, [{ type: "integer" }, { type: "integer" }]);
    runtime.execute("UPDATE counters SET total = total + 1");
    assert.deepEqual(storage.state.collections.counters, [{ id: 1, total: "9007199254740994" }, { id: 2, total: 6 }]);
    assert.deepEqual(runtime.snapshot().collections.counters, storage.state.collections.counters);
  });

  it("are reported on SQL events as they were returned, and can be put in JSON", async () => {
    const runtime = await SqliteRuntime.open({ schema: SCHEMA });
    runtime.execute("INSERT INTO counters (total) VALUES (?)", [BEYOND]);
    const previews: unknown[] = [];
    runtime.subscribe((event) => previews.push(event.resultPreview));
    runtime.execute("SELECT total FROM counters");
    assert.equal(JSON.stringify(previews), `[[{"total":"${BEYOND}"}]]`);
  });
});

describe("binary columns", () => {
  it("hold bytes: a BLOB in SQLite, Base64 text in the fixture", async () => {
    const storage = new MemoryStorage({ files: [{ id: 1, content: "AAEC/w==" }, { id: 2, content: null }, { id: 3, content: "" }] });
    const runtime = await SqliteRuntime.open({ schema: SCHEMA, storage });
    assert.deepEqual(runtime.execute("SELECT typeof(content) AS type, length(content) AS length, hex(content) AS hex FROM files ORDER BY id").rows, [
      { type: "blob", length: 4, hex: "000102FF" },
      { type: "null", length: null, hex: "" },
      { type: "blob", length: 0, hex: "" },
    ]);

    runtime.execute("INSERT INTO files (content) VALUES (?)", [Buffer.from("héllo", "utf8")]);
    const [row] = runtime.execute("SELECT content FROM files WHERE id = 4").rows;
    assert.ok(row?.content instanceof Uint8Array);
    assert.equal(Buffer.from(row.content as Uint8Array).toString("utf8"), "héllo");
    assert.deepEqual(storage.state.collections.files, [
      { id: 1, content: "AAEC/w==" },
      { id: 2, content: null },
      { id: 3, content: "" },
      { id: 4, content: Buffer.from("héllo", "utf8").toString("base64") },
    ]);
  });

  it("refuse a fixture value that is not Base64 text, naming the row", async () => {
    for (const [content, message] of [
      ["not base64!", /Cannot load row 1 of "files": "content" holds text that is not Base64/],
      [[1, 2], /Cannot load row 1 of "files": "content" holds an array, but its column type is binary/],
      [12, /Cannot load row 1 of "files": "content" holds a number, but its column type is binary/],
    ] as const) {
      await assert.rejects(SqliteRuntime.open({ schema: SCHEMA, storage: new MemoryStorage({ files: [{ id: 1, content }] }) }), (error) => error instanceof RuntimeSchemaError && message.test(error.message));
    }
  });
});
