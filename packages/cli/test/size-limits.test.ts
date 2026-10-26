import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ConfigError, parseSandboxConfig, runCli, startSandbox } from "../src/index.ts";
import type { RequestEvent, SizeWarning } from "../src/index.ts";

const MB = 1024 * 1024;

describe("size limits through the CLI and library", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-cli-size-"));
    dbPath = join(dir, "db.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeDb(sizeBytes: number, config?: unknown): Promise<void> {
    const head = `{${config === undefined ? "" : `"$config":${JSON.stringify(config)},`}"data":{"users":[{"id":1,"pad":"`;
    const tail = `"}]}}`;
    await writeFile(dbPath, head + "x".repeat(sizeBytes - head.length - tail.length) + tail);
  }

  /** Runs the CLI until it either exits or reports that it is running, then stops it. */
  async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string; started: boolean }> {
    let stdout = "";
    let stderr = "";
    let started = false;
    const signals = new EventEmitter();
    const code = await runCli(argv, {
      stdout: {
        write: (text) => {
          stdout += text;
          if (!started && stdout.includes("Press Ctrl+C")) {
            started = true;
            setImmediate(() => signals.emit("SIGTERM"));
          }
        },
      },
      stderr: { write: (text) => (stderr += text) },
      signals,
    });
    return { code, stdout, stderr, started };
  }

  describe("CLI", () => {
    it("starts a small database with no size output", async () => {
      await writeDb(2000);
      const { code, stderr, started } = await run(dbPath, "--port", "0");
      assert.equal(code, 0);
      assert.equal(started, true);
      assert.equal(stderr, "");
    });

    it("refuses a file above the limit and explains why", async () => {
      await writeFile(dbPath, "");
      await truncate(dbPath, 180 * MB);

      const { code, stdout, stderr, started } = await run(dbPath, "--port", "0");
      assert.equal(code, 1);
      assert.equal(started, false);
      assert.equal(stdout, "");
      assert.equal(
        stderr,
        "Error: The database file is 180 MB, above the limit of 150 MB, and was not loaded. " +
          "Local DB Sandbox is intended for small development fixtures; " +
          "reduce the dataset or split it into multiple sandbox databases.\n" +
          'Run "local-db-sandbox --help" for usage.\n',
      );
    });

    it("refuses a file above a lowered limit, naming that limit", async () => {
      await writeDb(2 * MB, { limits: { maxFileSizeMb: 1 } });
      const { code, stderr } = await run(dbPath, "--port", "0");
      assert.equal(code, 1);
      assert.match(stderr, /^Error: The database file is 2 MB, above the limit of 1 MB, and was not loaded\./);
    });

    for (const value of [251, 0, "100"]) {
      it(`fails at startup for maxFileSizeMb ${JSON.stringify(value)}`, async () => {
        await writeDb(2000, { limits: { maxFileSizeMb: value } });
        const { code, stderr, started } = await run(dbPath, "--port", "0");
        assert.equal(code, 1);
        assert.equal(started, false);
        assert.match(stderr, /^Error: "\$config\.limits\.maxFileSizeMb" must be a number greater than 0 and at most 250\./);
      });
    }

    it("does not let $config alone admit a file above 150 MB", async () => {
      await writeDb(151 * MB, { limits: { maxFileSizeMb: 200 } });
      const { code, stderr, started } = await run(dbPath, "--port", "0");
      assert.equal(code, 1);
      assert.equal(started, false);
      assert.match(stderr, /^Error: The database file is 151 MB, above the limit of 150 MB, and was not loaded\./);
    });

    it("starts a valid 151 MB file with --max-file-size 200", async () => {
      await writeDb(151 * MB);
      const { code, stderr, started } = await run(dbPath, "--port", "0", "--quiet", "--max-file-size", "200");
      assert.equal(code, 0);
      assert.equal(started, true);
      assert.match(stderr, /^Strong warning: the database file is 151 MB \(limit 200 MB\)\./);
    });

    it("still refuses a file above the size given with --max-file-size", async () => {
      await writeFile(dbPath, "");
      await truncate(dbPath, 201 * MB);
      const { code, stderr } = await run(dbPath, "--port", "0", "--max-file-size", "200");
      assert.equal(code, 1);
      assert.match(stderr, /^Error: The database file is 201 MB, above the limit of 200 MB, and was not loaded\./);
    });

    it("lets $config lower the size given with --max-file-size", async () => {
      await writeDb(2 * MB, { limits: { maxFileSizeMb: 1 } });
      const { code, stderr } = await run(dbPath, "--port", "0", "--max-file-size", "200");
      assert.equal(code, 1);
      assert.match(stderr, /^Error: The database file is 2 MB, above the limit of 1 MB, and was not loaded\./);
    });

    for (const value of ["251", "250.5", "0", "abc", "-5", ""]) {
      it(`rejects --max-file-size ${JSON.stringify(value)}`, async () => {
        await writeDb(2000);
        const { code, stdout, stderr, started } = await run(dbPath, "--port", "0", `--max-file-size=${value}`);
        assert.equal(code, 1);
        assert.equal(started, false);
        assert.equal(stdout, "");
        assert.match(stderr, /^Error: --max-file-size must be a number greater than 0 and at most 250\./);
      });
    }

    it("accepts --max-file-size 250 and values below the default", async () => {
      await writeDb(2000);
      assert.equal((await run(dbPath, "--port", "0", "--max-file-size", "250")).code, 0);

      await writeDb(2 * MB);
      const lowered = await run(dbPath, "--port", "0", "--max-file-size", "1.5");
      assert.equal(lowered.code, 1);
      assert.match(lowered.stderr, /above the limit of 1\.50 MB/);
    });

    it("fails at startup for an unknown key in $config.limits", async () => {
      await writeDb(2000, { limits: { maxRows: 10 } });
      const { code, stderr } = await run(dbPath, "--port", "0");
      assert.equal(code, 1);
      assert.match(stderr, /Unknown key "maxRows" in "\$config\.limits"/);
    });

    it("prints a warning for a large file and still starts", async () => {
      await writeDb(26 * MB);
      const { code, stderr, started } = await run(dbPath, "--port", "0", "--quiet");
      assert.equal(code, 0);
      assert.equal(started, true);
      assert.match(stderr, /^Warning: the database file is 26 MB \(limit 150 MB\)\. .*small development fixtures.*\n$/);
    });

    it("prints a strong warning for a very large file and still starts", async () => {
      await writeDb(76 * MB);
      const { code, stderr, started } = await run(dbPath, "--port", "0", "--quiet");
      assert.equal(code, 0);
      assert.equal(started, true);
      assert.match(stderr, /^Strong warning: the database file is 76 MB \(limit 150 MB\)\./);
    });
  });

  describe("library and HTTP", () => {
    it("delivers size warnings as structured values", async () => {
      await writeDb(26 * MB);
      const warnings: SizeWarning[] = [];
      const sandbox = await startSandbox({ file: dbPath, port: 0, onSizeWarning: (warning) => warnings.push(warning) });
      await sandbox.stop();
      assert.deepEqual(warnings, [
        { level: "warning", phase: "load", sizeBytes: 26 * MB, thresholdBytes: 25 * MB, limitBytes: 150 * MB },
      ]);
    });

    it("rejects with a structured error for a file above the limit", async () => {
      await writeFile(dbPath, "");
      await truncate(dbPath, 151 * MB);
      await assert.rejects(startSandbox({ file: dbPath, port: 0 }), {
        name: "SandboxLimitError",
        code: "SANDBOX_SIZE_LIMIT",
        sizeBytes: 151 * MB,
        limitBytes: 150 * MB,
      });
    });

    it("takes an explicit maxFileSizeMb, which $config can lower but not raise", async () => {
      await writeDb(2000, { limits: { maxFileSizeMb: 240 } });
      await assert.rejects(startSandbox({ file: dbPath, port: 0, maxFileSizeMb: 251 }), /maxFileSizeMb must be a number greater than 0 and at most 250/);

      await writeDb(2 * MB, { limits: { maxFileSizeMb: 240 } });
      await assert.rejects(startSandbox({ file: dbPath, port: 0, maxFileSizeMb: 1 }), {
        code: "SANDBOX_SIZE_LIMIT",
        limitBytes: MB,
      });

      await writeDb(2 * MB, { limits: { maxFileSizeMb: 1 } });
      await assert.rejects(startSandbox({ file: dbPath, port: 0, maxFileSizeMb: 200 }), {
        code: "SANDBOX_SIZE_LIMIT",
        limitBytes: MB,
      });
    });

    it("answers 507 for a request that would cross the limit and keeps the file intact", async () => {
      await writeDb(2000, { limits: { maxFileSizeMb: 0.25 } });
      const events: RequestEvent[] = [];
      const sandbox = await startSandbox({ file: dbPath, port: 0, onRequest: (event) => events.push(event) });
      try {
        const ok = await fetch(`${sandbox.url}/users`, { method: "POST", body: JSON.stringify({ name: "Sam" }) });
        assert.equal(ok.status, 201);
        const before = await readFile(dbPath);

        const tooBig = await fetch(`${sandbox.url}/users`, {
          method: "POST",
          body: JSON.stringify({ pad: "x".repeat(MB / 4) }),
        });
        assert.equal(tooBig.status, 507);
        const body = (await tooBig.json()) as { error: { code: string; message: string } };
        assert.equal(body.error.code, "SANDBOX_SIZE_LIMIT");
        assert.match(body.error.message, /above the limit of 0\.25 MB, and was not saved/);

        assert.ok(before.equals(await readFile(dbPath)));
        // Nothing of the save that was refused is left: the folder holds the database, and the record that the running sandbox has it (D-042).
        assert.deepEqual(await readdir(dir), ["db.json", "db.json.owner.json"]);
        assert.equal(((await (await fetch(`${sandbox.url}/users`)).json()) as unknown[]).length, 2);

        const failed = events[1] as RequestEvent;
        assert.equal(failed.status, 507);
        assert.equal(failed.errorCode, "SANDBOX_SIZE_LIMIT");
        assert.equal(failed.rows, 0);
        assert.equal(failed.operations[0]?.errorCode, "SANDBOX_SIZE_LIMIT");
      } finally {
        await sandbox.stop();
      }
    });
  });

  describe("parseSandboxConfig", () => {
    it("accepts a valid limit", () => {
      assert.equal(parseSandboxConfig({ limits: { maxFileSizeMb: 40 } }).maxFileSizeMb, 40);
      assert.equal(parseSandboxConfig({ limits: { maxFileSizeMb: 250 } }).maxFileSizeMb, 250);
      assert.equal(parseSandboxConfig({ limits: {} }).maxFileSizeMb, undefined);
    });

    it("rejects invalid limits", () => {
      for (const limits of [{ maxFileSizeMb: 250.1 }, { maxFileSizeMb: 0 }, { maxFileSizeMb: -1 }, { maxFileSizeMb: "1" }, { warnMb: 1 }, 5]) {
        assert.throws(() => parseSandboxConfig({ limits }), ConfigError, JSON.stringify(limits));
      }
    });
  });
});
