import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database, OperationEvent } from "../../core/src/index.ts";
import type { RequestEvent, RequestListener, SimulationEffect } from "./events.ts";
import { HttpError, errorResponse, handleRest, splitPath } from "./rest.ts";
import type { RestResponse } from "./rest.ts";
import { compileSimulation } from "./simulation.ts";
import type { ResolvedSimulation, SimulationConfig } from "./simulation.ts";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4783;

const MAX_BODY_BYTES = 1024 * 1024;

export interface SandboxServerOptions {
  database: Database;
  /** Defaults to 127.0.0.1. */
  host?: string;
  /** Defaults to 4783. Use 0 to let the operating system pick a free port. */
  port?: number;
  /** Optional latency, status, error, and empty-result simulation. */
  simulation?: SimulationConfig;
  /** Receives one structured event per request, after the response is written. */
  onRequest?: RequestListener;
}

export interface ServerAddress {
  host: string;
  port: number;
  url: string;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // An oversized body is still drained so the error response can be delivered.
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on("error", reject);
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "BODY_TOO_LARGE", `Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "INVALID_JSON", "Request body is not valid JSON."));
      }
    });
  });
}

/** Path segments for route matching; an undecodable path matches no route. */
function safeSegments(pathname: string): string[] | undefined {
  try {
    return splitPath(pathname);
  } catch {
    return undefined;
  }
}

/** Local HTTP adapter that exposes a core `Database` as REST routes. */
export class SandboxServer {
  readonly #database: Database;
  readonly #host: string;
  readonly #port: number;
  readonly #simulate: (method: string, segments: string[] | undefined) => ResolvedSimulation;
  readonly #onRequest: RequestListener | undefined;
  // Carries the current request's operation list across async core calls.
  readonly #operations = new AsyncLocalStorage<OperationEvent[]>();
  #server: Server | undefined;

  constructor(options: SandboxServerOptions) {
    this.#onRequest = options.onRequest;
    this.#simulate = compileSimulation(options.simulation);
    this.#database = options.database;
    this.#host = options.host ?? DEFAULT_HOST;
    this.#port = options.port ?? DEFAULT_PORT;
  }

  start(): Promise<ServerAddress> {
    if (this.#server !== undefined) {
      return Promise.reject(new Error("Server is already started."));
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;
    const unsubscribe = this.#database.subscribe((event) => this.#operations.getStore()?.push(event));
    server.once("close", unsubscribe);

    return new Promise((resolve, reject) => {
      server.once("error", (error) => {
        this.#server = undefined;
        unsubscribe();
        reject(error);
      });
      server.listen(this.#port, this.#host, () => {
        const { address, port, family } = server.address() as AddressInfo;
        const urlHost = family === "IPv6" ? `[${address}]` : address;
        resolve({ host: address, port, url: `http://${urlHost}:${port}` });
      });
    });
  }

  /** Stops accepting connections and resolves once in-flight requests finish. */
  stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) {
      return Promise.resolve();
    }
    this.#server = undefined;
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = performance.now();
    const timestamp = Date.now();
    const method = request.method ?? "GET";
    const operations: OperationEvent[] = [];
    const simulated: SimulationEffect[] = [];
    let simulatedDelayMs = 0;
    let emptied = false;

    // Permissive CORS: the sandbox is a local tool called from any dev origin.
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-expose-headers", "x-total-count");

    let result: RestResponse;
    if (method === "OPTIONS") {
      result = {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "access-control-allow-headers": request.headers["access-control-request-headers"] ?? "content-type",
        },
      };
    } else {
      const url = new URL(request.url ?? "/", "http://sandbox.local");
      const simulation = this.#simulate(method, safeSegments(url.pathname));
      if (simulation.delayMs > 0) {
        const delayStartedAt = performance.now();
        await new Promise((resolve) => setTimeout(resolve, simulation.delayMs));
        simulatedDelayMs = performance.now() - delayStartedAt;
        simulated.push("delay");
      }

      if (simulation.error !== undefined) {
        const { status, code, message } = simulation.error;
        result = errorResponse(new HttpError(status, code, message));
        simulated.push("error");
      } else {
        try {
          result = await this.#operations.run(operations, () =>
            handleRest(this.#database, method, url, () => readJsonBody(request)),
          );
        } catch (error) {
          result = errorResponse(error);
        }
        if (simulation.empty && result.status < 300 && Array.isArray(result.body)) {
          result = { ...result, headers: { ...result.headers, "x-total-count": "0" }, body: [] };
          emptied = true;
          simulated.push("empty");
        }
        if (simulation.status !== undefined) {
          result = { ...result, status: simulation.status };
          simulated.push("status");
        }
      }
    }

    // 204 and 304 responses must not carry a body.
    if (result.status === 204 || result.status === 304 || result.body === undefined) {
      response.writeHead(result.status, result.headers);
      response.end();
    } else {
      const payload = JSON.stringify(result.body);
      response.writeHead(result.status, {
        ...result.headers,
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
      });
      response.end(payload);
    }

    if (this.#onRequest === undefined) {
      return;
    }
    const event: RequestEvent = {
      timestamp,
      method,
      path: request.url ?? "/",
      status: result.status,
      simulatedDelayMs,
      totalMs: performance.now() - startedAt,
      simulated,
      operations,
    };
    if (operations.length > 0) {
      event.rows = emptied ? 0 : operations.reduce((sum, operation) => sum + operation.rows, 0);
      event.localExecutionMs = operations.reduce((sum, operation) => sum + operation.localExecutionMs, 0);
    }
    const errorCode = (result.body as { error?: { code?: unknown } } | undefined)?.error?.code;
    if (typeof errorCode === "string") {
      event.errorCode = errorCode;
    }
    try {
      this.#onRequest(event);
    } catch {
      // A failing listener must not affect request handling.
    }
  }
}
