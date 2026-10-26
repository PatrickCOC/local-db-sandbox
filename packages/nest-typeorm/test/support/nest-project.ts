import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repository = join(import.meta.dirname, "../../../..");
const fixture = join(import.meta.dirname, "..", "fixtures", "nest-project");

/**
 * Copies fixtures/nest-project to a temporary folder and gives it what
 * `npm install` would: the project's packages, and this package under its
 * own name (pointing at the sources of this repository).
 */
export async function createNestProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-nest-watch-"));
  await cp(fixture, dir, { recursive: true });
  await mkdir(join(dir, "node_modules", "local-db-sandbox"), { recursive: true });
  for (const name of ["@nestjs", "typeorm", "typescript", "reflect-metadata", "rxjs", "nodemailer"]) {
    await symlink(join(repository, "node_modules", name), join(dir, "node_modules", name), "junction");
  }
  const entryPoint = pathToFileURL(join(repository, "packages/cli/src/index.ts")).href;
  await writeFile(join(dir, "node_modules/local-db-sandbox/package.json"), JSON.stringify({ name: "local-db-sandbox", type: "module", exports: "./index.js" }));
  await writeFile(join(dir, "node_modules/local-db-sandbox/index.js"), `export * from ${JSON.stringify(entryPoint)};\n`);
  return dir;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Whether nothing is listening on the port, checked by listening on it. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until `condition` holds; fails with `describe()` when it does not within the time. */
export async function until(condition: () => boolean | Promise<boolean>, describe: () => string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await condition()) {
        return;
      }
    } catch {
      // Not yet.
    }
    if (Date.now() > deadline) {
      assert.fail(describe());
    }
    await delay(50);
  }
}

export interface Running {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

export function start(cwd: string, args: string[], env: Record<string, string> = {}): Running {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, output: () => output, exited };
}

// The files a database directory consists of now, and the rows of one of its tables (see the helper for why not by file name).
export { databaseFiles, storedRows, tableFile } from "../../../storage-json/test/support/database-files.ts";
