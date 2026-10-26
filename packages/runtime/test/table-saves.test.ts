import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { SandboxLimitError } from "../../core/src/index.ts";
import type { DatabaseState, Row } from "../../core/src/index.ts";
import { SqliteRuntime } from "../src/index.ts";
import type { SnapshotSaveEvent, SnapshotStorage, SqlEvent, TableSchema } from "../src/index.ts";

/*
 * Which tables the runtime saves at a commit. The storage here records what
 * it is given and stores nothing on disk: these tests are about the runtime
 * telling the changed tables from the others, for any schema.
 */

type Save = { kind: "complete" | "tables"; tables: string[] };

/** A storage that can store single tables, as a database directory can. */
class TableStorage implements SnapshotStorage {
  saves: Save[] = [];
  failNextSave: Error | undefined;
  collections: Record<string, Row[]>;

  constructor(collections: Record<string, Row[]>) {
    this.collections = structuredClone(collections);
  }

  async load(): Promise<DatabaseState> {
    return { meta: { version: 3 }, collections: structuredClone(this.collections) };
  }

  saveSync(state: DatabaseState): void {
    this.#failIfAsked();
    this.collections = structuredClone(state.collections);
    this.saves.push({ kind: "complete", tables: Object.keys(state.collections) });
  }

  saveTablesSync(tables: Record<string, Row[]>): void {
    this.#failIfAsked();
    this.collections = { ...this.collections, ...structuredClone(tables) };
    this.saves.push({ kind: "tables", tables: Object.keys(tables) });
  }

  #failIfAsked(): void {
    const error = this.failNextSave;
    this.failNextSave = undefined;
    if (error !== undefined) {
      throw error;
    }
  }
}

/** A storage that only takes the complete state, as a single JSON file does. */
class WholeStorage implements SnapshotStorage {
  saves: string[][] = [];
  #collections: Record<string, Row[]>;

  constructor(collections: Record<string, Row[]>) {
    this.#collections = structuredClone(collections);
  }

  async load(): Promise<DatabaseState> {
    return { meta: { version: 1 }, collections: structuredClone(this.#collections) };
  }

  saveSync(state: DatabaseState): void {
    this.#collections = structuredClone(state.collections);
    this.saves.push(Object.keys(state.collections));
  }
}

const id = { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true } as const;
const SCHEMA: TableSchema[] = [
  { name: "authors", columns: [id, { name: "name", type: "text", nullable: false, primary: false }] },
  {
    name: "books",
    columns: [
      id,
      { name: "authorId", type: "integer", nullable: false, primary: false, references: { table: "authors", column: "id", onDelete: "CASCADE" } },
      { name: "title", type: "text", nullable: false, primary: false },
    ],
  },
  {
    name: "reviews",
    columns: [
      id,
      { name: "bookId", type: "integer", nullable: true, primary: false, references: { table: "books", column: "id", onDelete: "SET NULL" } },
      { name: "stars", type: "integer", nullable: false, primary: false },
    ],
  },
  // A key that is text, and a key of two columns.
  { name: "tags", columns: [{ name: "code", type: "text", nullable: false, primary: true }, { name: "label", type: "text", nullable: true, primary: false }] },
  {
    name: "book_tags",
    columns: [
      { name: "bookId", type: "integer", nullable: false, primary: true },
      { name: "tagCode", type: "text", nullable: false, primary: true },
    ],
  },
  { name: "audit", columns: [id, { name: "what", type: "text", nullable: false, primary: false }] },
];
const DATA: Record<string, Row[]> = {
  authors: [{ id: 1, name: "Ada" }, { id: 2, name: "Bo" }],
  books: [{ id: 1, authorId: 1, title: "One" }, { id: 2, authorId: 2, title: "Two" }],
  reviews: [{ id: 1, bookId: 1, stars: 5 }, { id: 2, bookId: 2, stars: 3 }],
  tags: [{ code: "new", label: "New" }],
  book_tags: [{ bookId: 1, tagCode: "new" }],
  audit: [],
};

describe("the tables that are saved at a commit", () => {
  let storage: TableStorage;
  let runtime: SqliteRuntime;
  let saved: SnapshotSaveEvent[];

  const open = async (schema: TableSchema[] = SCHEMA, collections: Record<string, Row[]> = DATA): Promise<void> => {
    storage = new TableStorage(collections);
    saved = [];
    runtime = await SqliteRuntime.open({ schema, storage, onSave: (event) => saved.push(event) });
    runtime.execute("PRAGMA foreign_keys = ON");
  };
  const run = (...statements: string[]): void => {
    for (const sql of statements) {
      runtime.execute(sql);
    }
  };
  /** What the storage was given since it was last asked. */
  const saves = (): Save[] => storage.saves.splice(0);

  beforeEach(() => open());

  describe("a statement outside a transaction", () => {
    const cases: [string, string, string][] = [
      ["INSERT", "INSERT INTO authors (name) VALUES ('Cy')", "authors"],
      ["UPDATE", "UPDATE books SET title = 'First' WHERE id = 1", "books"],
      ["DELETE", "DELETE FROM reviews WHERE id = 2", "reviews"],
      ["REPLACE", "REPLACE INTO tags (code, label) VALUES ('new', 'Newer')", "tags"],
      ["INSERT OR REPLACE", "INSERT OR REPLACE INTO tags (code, label) VALUES ('old', 'Old')", "tags"],
      ["INSERT ... SELECT from another table", "INSERT INTO audit (what) SELECT name FROM authors", "audit"],
      ["UPDATE with a subquery on another table", "UPDATE reviews SET stars = (SELECT COUNT(*) FROM books)", "reviews"],
      ["a table with a text key", "UPDATE tags SET label = NULL WHERE code = 'new'", "tags"],
      ["a table with a key of two columns", "INSERT INTO book_tags (bookId, tagCode) VALUES (2, 'new')", "book_tags"],
      ["a statement that also returns rows", "INSERT INTO authors (name) VALUES ('Di') RETURNING id", "authors"],
    ];
    for (const [what, sql, table] of cases) {
      it(`saves only the table it changed: ${what}`, () => {
        runtime.execute(sql);
        assert.deepEqual(saves(), [{ kind: "tables", tables: [table] }]);
        assert.deepEqual(storage.collections[table], runtime.snapshot().collections[table]);
      });
    }

    it("saves nothing for a statement that reads", () => {
      run("SELECT * FROM authors", "SELECT COUNT(*) FROM books JOIN authors ON authors.id = books.authorId", "PRAGMA table_info(authors)");
      assert.deepEqual(saves(), []);
    });

    it("saves nothing for a write that changed no row, or left every row as it was", () => {
      run("DELETE FROM authors WHERE id = 99", "UPDATE books SET title = 'Other' WHERE id = 99", "UPDATE authors SET name = 'Ada' WHERE id = 1");
      assert.deepEqual(saves(), []);
    });
  });

  describe("a transaction", () => {
    it("saves the tables it changed, once, at its commit", () => {
      run("BEGIN", "INSERT INTO authors (name) VALUES ('Cy')", "UPDATE tags SET label = 'Fresh'", "INSERT INTO authors (name) VALUES ('Di')");
      assert.deepEqual(saves(), []);
      run("COMMIT");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["authors", "tags"] }]);
      assert.deepEqual(storage.collections, runtime.snapshot().collections);
    });

    it("saves nothing when it is rolled back, and nothing of it later", () => {
      run("BEGIN", "DELETE FROM reviews", "UPDATE authors SET name = 'X'", "ROLLBACK");
      assert.deepEqual(saves(), []);
      // The tables it touched are not taken as changed by the next commit either.
      run("INSERT INTO tags (code) VALUES ('later')");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["tags"] }]);
      assert.deepEqual(storage.collections, DATA_WITH({ tags: [...(DATA.tags as Row[]), { code: "later", label: null }] }));
    });

    it("saves nothing when it only reads", () => {
      run("BEGIN", "SELECT * FROM authors", "SELECT * FROM books", "COMMIT");
      assert.deepEqual(saves(), []);
    });

    it("saves nothing when it leaves every row as it found it", () => {
      run("BEGIN", "INSERT INTO authors (id, name) VALUES (9, 'Gone')", "UPDATE tags SET label = 'Changed'", "DELETE FROM authors WHERE id = 9", "UPDATE tags SET label = 'New'", "COMMIT");
      assert.deepEqual(saves(), []);
    });

    it("counts a table once however many statements changed it, and a table for another statement of the same transaction", () => {
      run("BEGIN");
      for (let index = 0; index < 5; index += 1) {
        run(`INSERT INTO audit (what) VALUES ('step ${index}')`);
      }
      run("UPDATE reviews SET stars = 1", "COMMIT");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["reviews", "audit"] }]);
    });
  });

  describe("savepoints", () => {
    it("drops the tables that were only changed after a savepoint that is rolled back to", () => {
      run("BEGIN", "INSERT INTO authors (name) VALUES ('Cy')", "SAVEPOINT s", "INSERT INTO tags (code) VALUES ('undone')", "DELETE FROM reviews", "ROLLBACK TO s", "COMMIT");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["authors"] }]);
      assert.deepEqual(storage.collections, runtime.snapshot().collections);
    });

    it("keeps the tables that were changed before the savepoint, and those changed after the rollback", () => {
      run(
        "BEGIN",
        "UPDATE tags SET label = 'Kept'",
        "SAVEPOINT s",
        "UPDATE tags SET label = 'Undone'",
        "INSERT INTO audit (what) VALUES ('undone')",
        "ROLLBACK TO s",
        "INSERT INTO book_tags (bookId, tagCode) VALUES (2, 'new')",
        "RELEASE s",
        "COMMIT",
      );
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["tags", "book_tags"] }]);
      assert.deepEqual(storage.collections.tags, [{ code: "new", label: "Kept" }]);
    });

    it("follows savepoints inside savepoints", () => {
      run(
        "BEGIN",
        "SAVEPOINT outer",
        "INSERT INTO authors (name) VALUES ('Cy')",
        "SAVEPOINT inner",
        "INSERT INTO audit (what) VALUES ('undone')",
        "ROLLBACK TO inner",
        "RELEASE inner",
        "SAVEPOINT again",
        "UPDATE reviews SET stars = 4",
        "RELEASE again",
        "RELEASE outer",
        "COMMIT",
      );
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["authors", "reviews"] }]);

      // Rolling back to the outer one undoes what the inner one had released.
      run("BEGIN", "SAVEPOINT outer", "SAVEPOINT inner", "DELETE FROM book_tags", "RELEASE inner", "ROLLBACK TO outer", "INSERT INTO tags (code) VALUES ('x')", "COMMIT");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["tags"] }]);
      assert.deepEqual(storage.collections.book_tags, DATA.book_tags);
    });

    it("saves at the release of an outermost savepoint, which is a commit", () => {
      run("SAVEPOINT s", "INSERT INTO authors (name) VALUES ('Cy')", "SAVEPOINT t", "DELETE FROM tags", "ROLLBACK TO t");
      assert.deepEqual(saves(), []);
      run("RELEASE s");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["authors"] }]);
    });
  });

  describe("rows that a statement changes without naming their table", () => {
    it("saves the tables that a foreign key's ON DELETE action changed", () => {
      // Deleting the author deletes the book (CASCADE), which clears the review's reference (SET NULL).
      run("DELETE FROM authors WHERE id = 1");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["authors", "books", "reviews"] }]);
      assert.deepEqual(storage.collections.books, [{ id: 2, authorId: 2, title: "Two" }]);
      assert.deepEqual(storage.collections.reviews, [{ id: 1, bookId: null, stars: 5 }, { id: 2, bookId: 2, stars: 3 }]);
    });

    it("saves the tables that a trigger changed", () => {
      run("CREATE TRIGGER authors_audit AFTER UPDATE ON authors BEGIN INSERT INTO audit (what) VALUES ('author ' || NEW.id); END");
      assert.deepEqual(saves(), []);
      run("UPDATE authors SET name = 'Adah' WHERE id = 1");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["authors", "audit"] }]);
      assert.deepEqual(storage.collections.audit, [{ id: 1, what: "author 1" }]);
    });
  });

  describe("when the changed tables cannot be told", () => {
    const keyless: TableSchema = { name: "notes", columns: [{ name: "text", type: "text", nullable: true, primary: false }] };
    const nullableKey: TableSchema = { name: "labels", columns: [{ name: "code", type: "text", nullable: true, primary: true }, { name: "label", type: "text", nullable: true, primary: false }] };

    for (const [what, table, write] of [
      ["a table without a primary key", keyless, "INSERT INTO notes (text) VALUES ('second')"],
      ["a table whose key can be NULL", nullableKey, "INSERT INTO labels (code, label) VALUES (NULL, 'no key')"],
    ] as const) {
      it(`saves the complete state for every commit of a schema that has ${what}`, async () => {
        const collections = { ...DATA, [table.name]: [] };
        await open([...SCHEMA, table], collections);

        // The row that was written is one that the engine's record of changes does not show.
        run(write);
        assert.deepEqual(saves(), [{ kind: "complete", tables: Object.keys(collections) }]);
        assert.equal(storage.collections[table.name]?.length, 1);
        // So is a write to any other table: it cannot be told that the unseen table did not change with it.
        run("BEGIN", "UPDATE authors SET name = 'Adah' WHERE id = 1", write, "COMMIT");
        assert.deepEqual(saves(), [{ kind: "complete", tables: Object.keys(collections) }]);
        assert.deepEqual(storage.collections, runtime.snapshot().collections);
        assert.deepEqual(saved.map((event) => event.kind), ["complete", "complete"]);
        // Reads and rollbacks still save nothing.
        run("SELECT * FROM authors", "BEGIN", write, "ROLLBACK");
        assert.deepEqual(saves(), []);
      });
    }

    it("saves the complete state first when the storage does not hold every table yet, and single tables from then on", async () => {
      const { tags: _tags, audit: _audit, ...stored } = DATA;
      await open(SCHEMA, stored);
      run("INSERT INTO authors (name) VALUES ('Cy')");
      // In the schema's order, after the tables the storage was loaded with.
      assert.deepEqual(saves(), [{ kind: "complete", tables: ["authors", "books", "reviews", "book_tags", "tags", "audit"] }]);
      run("INSERT INTO tags (code) VALUES ('first')");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["tags"] }]);
    });

    it("gives a storage that only takes the complete state the complete state at every commit", async () => {
      const whole = new WholeStorage(DATA);
      const events: SnapshotSaveEvent[] = [];
      const single = await SqliteRuntime.open({ schema: SCHEMA, storage: whole, onSave: (event) => events.push(event) });
      single.execute("INSERT INTO authors (name) VALUES ('Cy')");
      single.execute("BEGIN");
      single.execute("UPDATE tags SET label = 'x'");
      single.execute("ROLLBACK");
      single.execute("UPDATE authors SET name = 'Ada' WHERE id = 1");
      assert.deepEqual(whole.saves, [Object.keys(DATA), Object.keys(DATA)]);
      assert.deepEqual(events.map((event) => [event.kind, event.tables]), [["complete", Object.keys(DATA)], ["complete", Object.keys(DATA)]]);
    });
  });

  describe("a save that fails", () => {
    const tooBig = (): Error => new SandboxLimitError("above the limit", 2, 1);

    it("leaves a statement uncommitted, and its table as unchanged as the database", () => {
      storage.failNextSave = tooBig();
      assert.throws(() => runtime.execute("INSERT INTO authors (name) VALUES ('Cy')"), SandboxLimitError);
      assert.deepEqual(saves(), []);
      assert.deepEqual(runtime.snapshot().collections, DATA);

      // The table the failed statement had changed is not saved with the next commit.
      run("UPDATE tags SET label = 'Later'");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["tags"] }]);
      assert.deepEqual(storage.collections, DATA_WITH({ tags: [{ code: "new", label: "Later" }] }));
    });

    it("leaves a transaction open for the caller to roll back, and saves all of it when the commit is tried again", () => {
      run("BEGIN", "INSERT INTO authors (name) VALUES ('Cy')", "DELETE FROM book_tags");
      storage.failNextSave = tooBig();
      assert.throws(() => runtime.execute("COMMIT"), SandboxLimitError);
      assert.equal(runtime.inTransaction, true);
      assert.deepEqual(saves(), []);

      run("INSERT INTO audit (what) VALUES ('second try')", "COMMIT");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["authors", "book_tags", "audit"] }]);
      assert.deepEqual(storage.collections, runtime.snapshot().collections);
    });
  });

  describe("a commit that fails after its tables were saved", () => {
    it("has the storage hold what the database holds again once the transaction is rolled back", () => {
      // The check of the foreign key is put off to the commit, which is after the save.
      run("BEGIN", "PRAGMA defer_foreign_keys = ON", "INSERT INTO books (authorId, title) VALUES (99, 'Nobody wrote this')", "UPDATE tags SET label = 'Never'");
      assert.throws(() => runtime.execute("COMMIT"), /FOREIGN KEY constraint failed/);
      assert.equal(runtime.inTransaction, true);
      // The storage is ahead of the database for the moment: it was given the tables for a commit that did not happen.
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["books", "tags"] }]);
      assert.equal(storage.collections.books?.length, 3);

      run("ROLLBACK");
      assert.deepEqual(saves(), [{ kind: "complete", tables: Object.keys(DATA) }]);
      assert.deepEqual(storage.collections, DATA);
      assert.deepEqual(runtime.snapshot().collections, DATA);

      // From there on, single tables again.
      run("INSERT INTO authors (name) VALUES ('Cy')");
      assert.deepEqual(saves(), [{ kind: "tables", tables: ["authors"] }]);
    });

    it("does so with the next commit when it cannot at the rollback", () => {
      run("BEGIN", "PRAGMA defer_foreign_keys = ON", "INSERT INTO books (authorId, title) VALUES (99, 'Nobody wrote this')");
      assert.throws(() => runtime.execute("COMMIT"), /FOREIGN KEY constraint failed/);
      saves();
      storage.failNextSave = new Error("the disk is full");
      run("ROLLBACK");
      assert.deepEqual(saves(), []);
      assert.equal(storage.collections.books?.length, 3);

      run("INSERT INTO tags (code) VALUES ('next')");
      assert.deepEqual(saves(), [{ kind: "complete", tables: Object.keys(DATA) }]);
      assert.deepEqual(storage.collections, runtime.snapshot().collections);
      assert.equal(storage.collections.books?.length, 2);
    });
  });

  describe("what is reported", () => {
    it("reports each save with the tables that were read for it and the time its two parts took", () => {
      run("INSERT INTO authors (name) VALUES ('Cy')", "SELECT * FROM authors", "BEGIN", "UPDATE tags SET label = 'x'", "DELETE FROM reviews", "COMMIT");
      assert.deepEqual(saved.map((event) => [event.kind, event.tables]), [["tables", ["authors"]], ["tables", ["reviews", "tags"]]]);
      for (const event of saved) {
        assert.ok(event.extractionMs >= 0 && event.storageMs >= 0 && Number.isFinite(event.extractionMs + event.storageMs), JSON.stringify(event));
      }
    });

    it("says on the statement that committed how much of its time was saving", () => {
      const events: SqlEvent[] = [];
      runtime.subscribe((event) => events.push(event));
      run("INSERT INTO authors (name) VALUES ('Cy')", "SELECT * FROM authors", "BEGIN", "UPDATE tags SET label = 'x'", "COMMIT", "BEGIN", "SELECT 1", "COMMIT");

      const saving = events.map((event) => [event.sql.split(" ")[0], event.snapshotSaveMs !== undefined]);
      assert.deepEqual(saving, [["INSERT", true], ["SELECT", false], ["BEGIN", false], ["UPDATE", false], ["COMMIT", true], ["BEGIN", false], ["SELECT", false], ["COMMIT", false]]);
      for (const event of events.filter((candidate) => candidate.snapshotSaveMs !== undefined)) {
        assert.ok((event.snapshotSaveMs as number) > 0 && (event.snapshotSaveMs as number) <= event.localExecutionMs, JSON.stringify(event));
      }
    });

    it("saves nothing, and reports nothing, in memory mode", async () => {
      storage = new TableStorage(DATA);
      const memory = await SqliteRuntime.open({ schema: SCHEMA, storage, persistence: "memory", onSave: (event) => saved.push(event) });
      memory.execute("INSERT INTO authors (name) VALUES ('Cy')");
      memory.execute("BEGIN");
      memory.execute("DELETE FROM tags");
      memory.execute("COMMIT");
      assert.deepEqual([saves(), saved], [[], []]);
    });
  });
});

function DATA_WITH(changes: Record<string, Row[]>): Record<string, Row[]> {
  return { ...DATA, ...changes };
}
