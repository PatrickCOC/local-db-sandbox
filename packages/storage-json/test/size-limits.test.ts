import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Database, SandboxError, SandboxLimitError } from "../../core/src/index.ts";
import {
  ABSOLUTE_MAX_FILE_SIZE_MB,
  DEFAULT_MAX_FILE_SIZE_MB,
  JsonStorageAdapter,
  JsonStorageError,
  STRONG_WARNING_SIZE_MB,
  WARNING_SIZE_MB,
  assertWithinSizeLimit,
  formatSizeWarning,
} from "../src/index.ts";
import type { SizeWarning } from "../src/index.ts";

const MB = 1024 * 1024;

/** Writes a valid database file of exactly `sizeBytes`, padded with one long string value. */
async function writePaddedDb(path: string, sizeBytes: number, config?: unknown): Promise<void> {
  const head = `{${config === undefined ? "" : `"$config":${JSON.stringify(config)},`}"data":{"users":[{"id":1,"pad":"`;
  const tail = `"}]}}`;
  const handle = await open(path, "w");
  try {
    await handle.write(head);
    await handle.write(Buffer.alloc(sizeBytes - head.length - tail.length, "x"));
    await handle.write(tail);
  } finally {
    await handle.close();
  }
}

/** Creates a file of `sizeBytes` zero bytes without writing them. It is not valid JSON. */
async function writeSparseFile(path: string, sizeBytes: number, head = ""): Promise<void> {
  await writeFile(path, head);
  await truncate(path, sizeBytes);
}

function limitError(expected: { sizeBytes: number; limitBytes: number }) {
  return (error: unknown) => {
    assert.ok(error instanceof SandboxLimitError, String(error));
    assert.ok(error instanceof SandboxError);
    assert.equal(error.code, "SANDBOX_SIZE_LIMIT");
    assert.equal(error.sizeBytes, expected.sizeBytes);
    assert.equal(error.limitBytes, expected.limitBytes);
    return true;
  };
}

describe("database size limits", () => {
  let dir: string;
  let dbPath: string;
  let warnings: SizeWarning[];
  const adapter = () => new JsonStorageAdapter(dbPath, { onSizeWarning: (warning) => warnings.push(warning) });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-size-"));
    dbPath = join(dir, "db.json");
    warnings = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the documented thresholds", () => {
    assert.deepEqual(
      [WARNING_SIZE_MB, STRONG_WARNING_SIZE_MB, DEFAULT_MAX_FILE_SIZE_MB, ABSOLUTE_MAX_FILE_SIZE_MB],
      [25, 75, 150, 250],
    );
  });

  describe("loading", () => {
    it("loads a small file without warnings", async () => {
      await writePaddedDb(dbPath, 2000);
      const storage = adapter();
      const state = await storage.load();
      assert.equal(state.collections.users?.length, 1);
      assert.deepEqual(warnings, []);
      assert.equal(storage.maxFileSizeBytes, 150 * MB);
    });

    it("does not warn just below 25 MB", async () => {
      await writePaddedDb(dbPath, 25 * MB - 1);
      await adapter().load();
      assert.deepEqual(warnings, []);
    });

    it("reports a warning from 25 MB", async () => {
      await writePaddedDb(dbPath, 25 * MB);
      await adapter().load();
      assert.deepEqual(warnings, [
        { level: "warning", phase: "load", sizeBytes: 25 * MB, thresholdBytes: 25 * MB, limitBytes: 150 * MB },
      ]);
    });

    it("still reports a normal warning just below 75 MB", async () => {
      await writePaddedDb(dbPath, 75 * MB - 1);
      await adapter().load();
      assert.deepEqual(warnings.map((warning) => warning.level), ["warning"]);
    });

    it("reports a strong warning from 75 MB", async () => {
      await writePaddedDb(dbPath, 75 * MB);
      await adapter().load();
      assert.deepEqual(warnings, [
        { level: "strong", phase: "load", sizeBytes: 75 * MB, thresholdBytes: 75 * MB, limitBytes: 150 * MB },
      ]);
    });

    it("rejects a file above 150 MB before reading or parsing it", async (t) => {
      await writeSparseFile(dbPath, 150 * MB + 1);
      const parse = t.mock.method(JSON, "parse");

      await assert.rejects(adapter().load(), limitError({ sizeBytes: 150 * MB + 1, limitBytes: 150 * MB }));
      assert.equal(parse.mock.callCount(), 0);
      assert.deepEqual(warnings, []);
    });

    it("accepts a file of exactly 150 MB, which then goes on to parsing", async () => {
      await writeSparseFile(dbPath, 150 * MB);
      // The content is not JSON, so reaching the parser shows the size check passed.
      await assert.rejects(adapter().load(), (error) => error instanceof JsonStorageError && /not valid JSON/.test(error.message));
    });

    it("explains the size, the limit, and what to do", async () => {
      await writeSparseFile(dbPath, 180 * MB);
      await assert.rejects(adapter().load(), (error: Error) => {
        assert.match(error.message, /The database file is 180 MB, above the limit of 150 MB, and was not loaded\./);
        assert.match(error.message, /intended for small development fixtures/);
        assert.match(error.message, /reduce the dataset or split it into multiple sandbox databases/);
        return true;
      });
    });
  });

  describe("configured limit", () => {
    it("applies a lower limit from $config.limits.maxFileSizeMb", async () => {
      await writePaddedDb(dbPath, 3 * MB, { limits: { maxFileSizeMb: 2 } });
      await assert.rejects(adapter().load(), limitError({ sizeBytes: 3 * MB, limitBytes: 2 * MB }));

      await writePaddedDb(dbPath, 2 * MB, { limits: { maxFileSizeMb: 2 } });
      const storage = adapter();
      await storage.load();
      assert.equal(storage.maxFileSizeBytes, 2 * MB);
    });

    it("accepts fractional limits", async () => {
      await writePaddedDb(dbPath, 2000, { limits: { maxFileSizeMb: 0.5 } });
      const storage = adapter();
      await storage.load();
      assert.equal(storage.maxFileSizeBytes, MB / 2);
    });

    it("cannot raise the limit: a valid file above 150 MB that declares 200 is not parsed", async (t) => {
      await writePaddedDb(dbPath, 151 * MB, { limits: { maxFileSizeMb: 200 } });
      const parse = t.mock.method(JSON, "parse");
      await assert.rejects(adapter().load(), limitError({ sizeBytes: 151 * MB, limitBytes: 150 * MB }));
      assert.equal(parse.mock.callCount(), 0);
      assert.deepEqual(warnings, []);
    });

    it("does not raise the limit for a small file either", async () => {
      await writePaddedDb(dbPath, 2000, { limits: { maxFileSizeMb: 200 } });
      const storage = adapter();
      await storage.load();
      assert.equal(storage.maxFileSizeBytes, 150 * MB);
    });
  });

  describe("explicit limit", () => {
    const withLimit = (maxFileSizeMb: number) =>
      new JsonStorageAdapter(dbPath, { maxFileSizeMb, onSizeWarning: (warning) => warnings.push(warning) });

    it("loads a valid file between 150 and 200 MB when created with a 200 MB limit", async () => {
      await writePaddedDb(dbPath, 151 * MB);
      const storage = withLimit(200);
      const state = await storage.load();
      assert.equal(state.collections.users?.length, 1);
      assert.equal(storage.maxFileSizeBytes, 200 * MB);
      assert.deepEqual(warnings.map((warning) => [warning.level, warning.limitBytes]), [["strong", 200 * MB]]);
    });

    it("rejects a file above the explicit limit before parsing", async (t) => {
      await writeSparseFile(dbPath, 201 * MB);
      const parse = t.mock.method(JSON, "parse");
      await assert.rejects(withLimit(200).load(), limitError({ sizeBytes: 201 * MB, limitBytes: 200 * MB }));
      assert.equal(parse.mock.callCount(), 0);
    });

    it("never parses a file above 250 MB", async (t) => {
      await writeSparseFile(dbPath, 250 * MB + 1, '{"$config":{"limits":{"maxFileSizeMb":250}},');
      const parse = t.mock.method(JSON, "parse");
      await assert.rejects(withLimit(250).load(), limitError({ sizeBytes: 250 * MB + 1, limitBytes: 250 * MB }));
      assert.equal(parse.mock.callCount(), 0);
    });

    it("can be lowered by $config, after parsing", async () => {
      await writePaddedDb(dbPath, 3 * MB, { limits: { maxFileSizeMb: 2 } });
      await assert.rejects(withLimit(200).load(), limitError({ sizeBytes: 3 * MB, limitBytes: 2 * MB }));

      await writePaddedDb(dbPath, 2000, { limits: { maxFileSizeMb: 2 } });
      const storage = withLimit(200);
      await storage.load();
      assert.equal(storage.maxFileSizeBytes, 2 * MB);
    });

    it("can itself be below the default, and $config cannot raise it back", async () => {
      await writePaddedDb(dbPath, 2 * MB, { limits: { maxFileSizeMb: 100 } });
      await assert.rejects(withLimit(1).load(), limitError({ sizeBytes: 2 * MB, limitBytes: MB }));
    });

    it("applies to saves", async () => {
      await writePaddedDb(dbPath, 2000);
      const db = await Database.open(withLimit(0.5));
      await assert.rejects(db.insert("users", { pad: "x".repeat(MB / 2) }), SandboxLimitError);
      assert.equal((await db.insert("users", { name: "ok" })).id, 2);
    });

    for (const value of [250.5, 251, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "200"]) {
      it(`rejects an explicit limit of ${String(value)}`, () => {
        assert.throws(() => withLimit(value as number), (error) => {
          assert.ok(error instanceof JsonStorageError);
          assert.equal(error.message, "maxFileSizeMb must be a number greater than 0 and at most 250.");
          return true;
        });
      });
    }
  });

  describe("invalid $config limit", () => {

    const invalid: Record<string, unknown> = {
      "a value above 250": 251,
      zero: 0,
      "a negative value": -5,
      "a string": "100",
      null: null,
      "a boolean": true,
    };
    for (const [label, value] of Object.entries(invalid)) {
      it(`rejects ${label} at load`, async () => {
        await writePaddedDb(dbPath, 2000, { limits: { maxFileSizeMb: value } });
        await assert.rejects(adapter().load(), (error) => {
          assert.ok(error instanceof JsonStorageError);
          assert.match(error.message, /"\$config\.limits\.maxFileSizeMb" must be a number greater than 0 and at most 250\./);
          return true;
        });
      });
    }
  });

  describe("saving", () => {
    const LIMIT = MB / 2;
    let db: Database;

    beforeEach(async () => {
      await writeFile(
        dbPath,
        JSON.stringify({ $config: { limits: { maxFileSizeMb: 0.5 }, routes: {} }, data: { users: [{ id: 1, name: "Patrick" }] } }),
      );
      db = await Database.open(adapter());
    });

    it("saves a mutation that stays below the limit", async () => {
      const row = await db.insert("users", { name: "Sam", pad: "x".repeat(100_000) });
      assert.equal(row.id, 2);

      const stored = JSON.parse(await readFile(dbPath, "utf8"));
      assert.equal(stored.data.users.length, 2);
      assert.deepEqual(stored.$config.limits, { maxFileSizeMb: 0.5 });
      assert.deepEqual(await readdir(dir), ["db.json"]);
    });

    it("rejects a mutation that would cross the limit and leaves everything as it was", async () => {
      await db.insert("users", { name: "Sam" });
      const before = await readFile(dbPath);

      await assert.rejects(db.insert("users", { name: "Big", pad: "x".repeat(LIMIT) }), (error) => {
        assert.ok(error instanceof SandboxLimitError);
        assert.equal(error.code, "SANDBOX_SIZE_LIMIT");
        assert.equal(error.limitBytes, LIMIT);
        assert.ok(error.sizeBytes > LIMIT);
        assert.match(error.message, /This change would make the database file 0\.5\d MB, above the limit of 0\.50 MB, and was not saved\./);
        assert.match(error.message, /small development fixtures/);
        return true;
      });

      assert.ok(before.equals(await readFile(dbPath)), "file is byte-for-byte unchanged");
      assert.deepEqual(await readdir(dir), ["db.json"], "no temporary file is left");
      assert.deepEqual(db.findAll("users").map((row) => row.name), ["Patrick", "Sam"]);

      // The database keeps working, and IDs continue as if the rejected insert never happened.
      assert.equal((await db.insert("users", { name: "Kim" })).id, 3);
      assert.equal(JSON.parse(await readFile(dbPath, "utf8")).data.users.length, 3);
    });

    it("rejects an oversized replace and patch the same way", async () => {
      const before = await readFile(dbPath);
      await assert.rejects(db.patch("users", 1, { pad: "x".repeat(LIMIT) }), SandboxLimitError);
      await assert.rejects(db.replace("users", 1, { pad: "x".repeat(LIMIT) }), SandboxLimitError);
      assert.ok(before.equals(await readFile(dbPath)));
      assert.deepEqual(db.findById("users", 1), { id: 1, name: "Patrick" });
    });

    it("reports the failed operation with the size-limit code", async () => {
      const codes: (string | undefined)[] = [];
      db.subscribe((event) => codes.push(event.errorCode));
      await assert.rejects(db.insert("users", { pad: "x".repeat(LIMIT) }));
      assert.deepEqual(codes, ["SANDBOX_SIZE_LIMIT"]);
    });

    it("applies the default limit when saving without loading first", async () => {
      const fresh = join(dir, "fresh.json");
      const storage = new JsonStorageAdapter(fresh);
      await storage.save({ meta: { version: 1 }, collections: { users: [] } });
      assert.equal(storage.maxFileSizeBytes, 150 * MB);
      assert.deepEqual((await readdir(dir)).sort(), ["db.json", "fresh.json"]);
    });

    it("removes the temporary file when writing fails", async () => {
      // A directory in place of the target makes the final rename fail after the temp file is written.
      const blocked = join(dir, "blocked.json");
      await mkdir(blocked);
      await writeFile(join(blocked, "keep"), "");

      await assert.rejects(new JsonStorageAdapter(blocked).save({ meta: { version: 1 }, collections: {} }), JsonStorageError);
      assert.deepEqual((await readdir(dir)).sort(), ["blocked.json", "db.json"]);
    });
  });

  describe("warnings while saving", () => {
    let storage: JsonStorageAdapter;
    let db: Database;

    it("reports a warning when a save first reaches 25 MB, and not again while it stays there", async () => {
      await writePaddedDb(dbPath, 25 * MB - 2000);
      storage = adapter();
      db = await Database.open(storage);
      assert.deepEqual(warnings, []);

      await db.insert("users", { pad: "x".repeat(4000) });
      const [first] = warnings as SizeWarning[];
      assert.equal(warnings.length, 1);
      assert.equal(first?.level, "warning");
      assert.equal(first?.phase, "save");
      assert.ok((first?.sizeBytes as number) >= 25 * MB);

      await db.insert("users", { name: "again" });
      assert.equal(warnings.length, 1);
    });

    it("reports a strong warning when a save first reaches 75 MB", async () => {
      await writePaddedDb(dbPath, 75 * MB - 2000);
      db = await Database.open(adapter());
      assert.deepEqual(warnings.map((warning) => [warning.level, warning.phase]), [["warning", "load"]]);

      await db.insert("users", { pad: "x".repeat(4000) });
      assert.deepEqual(warnings.map((warning) => [warning.level, warning.phase]), [
        ["warning", "load"],
        ["strong", "save"],
      ]);
    });
  });

  describe("helpers", () => {
    it("assertWithinSizeLimit allows the limit itself and rejects one byte more", () => {
      assert.doesNotThrow(() => assertWithinSizeLimit(MB, MB, "save"));
      assert.throws(() => assertWithinSizeLimit(MB + 1, MB, "save"), SandboxLimitError);
    });

    it("formats warnings from the structured value", () => {
      const base = { phase: "load", sizeBytes: 30 * MB, thresholdBytes: 25 * MB, limitBytes: 150 * MB } as const;
      assert.match(formatSizeWarning({ ...base, level: "warning" }), /^Warning: the database file is 30 MB \(limit 150 MB\)\. .*small development fixtures/);
      assert.match(
        formatSizeWarning({ ...base, level: "strong", sizeBytes: 80.5 * MB, thresholdBytes: 75 * MB }),
        /^Strong warning: the database file is 80\.5 MB \(limit 150 MB\)\. .*split it into multiple sandbox databases/,
      );
    });
  });
});
