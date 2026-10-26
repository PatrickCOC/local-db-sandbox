import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { CapturedMail, MailCapture } from "./mail-capture.ts";

/*
 * Captured mail is kept in the memory of the process that captures it. So
 * that another process, the `mail` command, can show it, the capturing
 * process serves it on a local HTTP endpoint, and writes where that is to a
 * small file next to the sandbox configuration:
 *
 *   .local-db-sandbox/sandbox.runtime.json
 *   { "pid", "startedAt", "smtp": { "host", "port" }, "control": { "url", "token" } }
 *
 * The endpoint listens on 127.0.0.1 on a port of its own, and every request
 * needs the token of the file, so that a web page open in a browser on the
 * same machine cannot read or clear the mailbox. This is not a public API:
 * its only client is `MailClient` below.
 */

export interface SandboxRuntime {
  pid: number;
  startedAt: string;
  smtp: { host: string; port: number };
  control: { url: string; token: string };
}

export class MailControlError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MailControlError";
  }
}

export interface MailControl {
  runtime: SandboxRuntime;
  /** Stops the endpoint and removes the runtime file. */
  close(): Promise<void>;
}

function matches(given: string | undefined, token: string): boolean {
  const [a, b] = [Buffer.from(given ?? ""), Buffer.from(`Bearer ${token}`)];
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Serves the mailbox of `capture` to the `mail` command, and writes `runtimeFile` so that the command finds it. */
export async function startMailControl(capture: MailCapture, runtimeFile: string): Promise<MailControl> {
  const token = randomBytes(24).toString("hex");
  const server: Server = createServer((request, response) => {
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    if (!matches(request.headers.authorization, token)) {
      send(401, { error: "The token of the sandbox's runtime file is required." });
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const id = /^\/mail\/([^/]+)$/.exec(path)?.[1];
    if (request.method === "GET" && path === "/mail") {
      send(200, { messages: capture.list() });
    } else if (request.method === "GET" && id !== undefined) {
      const mail = capture.get(decodeURIComponent(id));
      send(mail === undefined ? 404 : 200, mail === undefined ? { error: "No such message." } : { message: mail });
    } else if (request.method === "DELETE" && path === "/mail") {
      send(200, { removed: capture.clear() });
    } else {
      send(404, { error: "Not found." });
    }
  });
  // Like the SMTP server: not a reason to keep a process running.
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const bound = server.address();
  const runtime: SandboxRuntime = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    smtp: { host: capture.host, port: capture.port },
    control: { url: `http://127.0.0.1:${typeof bound === "object" && bound !== null ? bound.port : 0}`, token },
  };
  try {
    // Readable by its owner only, where the file system knows such a thing.
    writeFileSync(runtimeFile, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
  } catch (cause) {
    server.close();
    throw new MailControlError(`Cannot write ${runtimeFile}, which tells the "mail" command where the captured mail is.`, { cause });
  }

  const remove = (): void => {
    try {
      // Only the file this process wrote: another sandbox may have started on the same configuration since.
      if ((JSON.parse(readFileSync(runtimeFile, "utf8")) as Partial<SandboxRuntime>).control?.token === token) {
        rmSync(runtimeFile, { force: true });
      }
    } catch {
      // Gone already, or not readable: nothing to remove.
    }
  };
  // The mailbox ends with the process, however it ends; the file that points to it should not stay.
  process.once("exit", remove);
  return {
    runtime,
    close: () =>
      new Promise((resolve) => {
        process.off("exit", remove);
        remove();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The client of a running sandbox's mailbox. Used by the `mail` command. */
export class MailClient {
  readonly runtime: SandboxRuntime;

  private constructor(runtime: SandboxRuntime) {
    this.runtime = runtime;
  }

  /** Reads `runtimeFile`. Throws when there is none: no sandbox with mail capture is running on that configuration. */
  static open(runtimeFile: string): MailClient {
    let runtime: Partial<SandboxRuntime>;
    try {
      runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
    } catch (cause) {
      throw new MailControlError(notRunning(runtimeFile), { cause });
    }
    if (typeof runtime.control?.url !== "string" || typeof runtime.control.token !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.control.url)) {
      throw new MailControlError(`${runtimeFile} is not a runtime file of this version of local-db-sandbox.`);
    }
    return new MailClient(runtime as SandboxRuntime);
  }

  async list(): Promise<CapturedMail[]> {
    return ((await this.#request("GET", "/mail")) as { messages: CapturedMail[] }).messages;
  }

  /** The message with this id, or `undefined` when there is none. */
  async get(id: string): Promise<CapturedMail | undefined> {
    return ((await this.#request("GET", `/mail/${encodeURIComponent(id)}`, [404])) as { message?: CapturedMail }).message;
  }

  /** Forgets every captured message, and returns how many there were. */
  async clear(): Promise<number> {
    return ((await this.#request("DELETE", "/mail")) as { removed: number }).removed;
  }

  async #request(method: string, path: string, alsoAccepted: number[] = []): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.runtime.control.url}${path}`, { method, headers: { authorization: `Bearer ${this.runtime.control.token}` } });
    } catch (cause) {
      throw new MailControlError(`The sandbox that wrote its runtime file (process ${this.runtime.pid}) does not answer: it has stopped, and its captured mail went with it.`, { cause });
    }
    if (!response.ok && !alsoAccepted.includes(response.status)) {
      throw new MailControlError(`The sandbox answered ${response.status} to the "mail" command.`);
    }
    return response.json();
  }
}

function notRunning(runtimeFile: string): string {
  return (
    `No sandbox with mail capture is running here (${runtimeFile} does not exist). ` +
    'Captured mail is kept in memory by the running sandbox ("npm run sandbox") and is gone when it stops. ' +
    'Mail is captured when the sandbox configuration has "smtp": { "mode": "capture" }.'
  );
}
