import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SCRIPT = join(import.meta.dirname, "own-database.ts");

/** Another process that has a database open, and serves its runtime (`own-database.ts`). */
export interface OwnerProcess {
  child: ChildProcess;
  instance: string;
  pid: number;
  startedAt: string;
  url: string;
  /** Has the owner run a statement on its own runtime, as an application does. */
  sql(statement: string): Promise<Record<string, unknown>[]>;
  begin(): Promise<void>;
  rollback(): Promise<void>;
  /** Ends it the way a sandbox that is stopped ends: it lets go of the database. */
  stop(): Promise<void>;
  /** Ends it the way a sandbox that is killed ends: its record stays behind. */
  kill(): Promise<void>;
  exited: Promise<void>;
}

/** Starts such a process and resolves once it serves. Rejects when it did not get the database. */
export async function ownDatabase(database: string, kind = "postgrest"): Promise<OwnerProcess> {
  const child = spawn(process.execPath, [SCRIPT, database, kind], { stdio: ["pipe", "pipe", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const waiting: ((line: Record<string, unknown>) => void)[] = [];
  const lines: Record<string, unknown>[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim().startsWith("{")) {
      return;
    }
    const said = JSON.parse(line) as Record<string, unknown>;
    const next = waiting.shift();
    if (next === undefined) {
      lines.push(said);
    } else {
      next(said);
    }
  });
  const answer = (): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const ready = lines.shift();
      if (ready !== undefined) {
        resolve(ready);
        return;
      }
      waiting.push(resolve);
      void exited.then(() => reject(new Error(`the owner process ended without an answer:\n${errors}`)));
    });
  const tell = async (what: Record<string, unknown>): Promise<Record<string, unknown>> => {
    child.stdin.write(`${JSON.stringify(what)}\n`);
    const said = await answer();
    if (typeof said.error === "string") {
      throw new Error(said.error);
    }
    return said;
  };

  const first = await answer();
  if (first.ready !== true) {
    await exited;
    throw new Error(String(first.message));
  }
  return {
    child,
    instance: first.instance as string,
    pid: first.pid as number,
    startedAt: first.startedAt as string,
    url: first.url as string,
    sql: async (statement) => (await tell({ sql: statement })).rows as Record<string, unknown>[],
    begin: async () => void (await tell({ begin: true })),
    rollback: async () => void (await tell({ rollback: true })),
    async stop() {
      child.stdin.write(`${JSON.stringify({ stop: true })}\n`);
      await exited;
    },
    async kill() {
      child.kill("SIGKILL");
      await exited;
    },
    exited,
  };
}
