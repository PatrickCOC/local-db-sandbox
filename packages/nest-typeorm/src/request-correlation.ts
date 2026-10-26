import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SqlEvent, SqlEventContext } from "../../runtime/src/index.ts";

/** The `requestId` of SQL that was not executed while handling an HTTP request, such as startup queries and scheduled jobs. */
export const BACKGROUND_REQUEST_ID = "background";

/**
 * One HTTP request served by the application in sandbox mode. `totalMs` is
 * the whole request; `sqlExecutionMs` is the part spent executing SQL on the
 * local runtime. Neither says anything about production performance.
 */
export interface SandboxRequestEvent {
  /** Also found as `requestId` on the SQL events of this request. */
  requestId: string;
  method: string;
  path: string;
  status: number;
  totalMs: number;
  /** Number of SQL statements executed for the request: its SQL events are numbered 1 to `sqlCount`. */
  sqlCount: number;
  /** Sum of those statements' local execution time. */
  sqlExecutionMs: number;
}

export type SandboxRequestListener = (event: SandboxRequestEvent) => void;

interface RequestContext {
  requestId: string;
  sqlCount: number;
  sqlExecutionMs: number;
}

/** A Node `http.Server`, described by the one member this needs so that the published types do not depend on Node's. */
export interface HttpServerLike {
  emit(event: string, ...args: any[]): boolean;
}

export interface RequestCorrelation {
  /** Gives every request of `server` (a Node `http.Server`) an ID that the code handling it, however asynchronous, runs under. */
  attach(server: HttpServerLike): void;
  /** The ID of the request the caller is running for, if any. */
  requestId(): string | undefined;
  /**
   * The request the caller is running for and the number of the statement
   * within it. To be called once per executed statement: each call counts.
   * Outside any request, the request is `background`.
   */
  sqlContext(): SqlEventContext;
  /** Adds a statement's execution time to the request it ran for. */
  record(event: SqlEvent): void;
}

const MAX_ID_LENGTH = 100;

/** The ID a client sent as `x-request-id`, or a new short one. */
function idFor(request: IncomingMessage): string {
  const given = request.headers["x-request-id"];
  return typeof given === "string" && given !== "" && given !== BACKGROUND_REQUEST_ID && given.length <= MAX_ID_LENGTH ? given : randomUUID().slice(0, 8);
}

/**
 * Request correlation for an HTTP server the sandbox did not create.
 *
 * It works on Node's own `http.Server`, below any web framework: the
 * `request` event is emitted inside an `AsyncLocalStorage` context, as the
 * standalone sandbox server does for its own requests. The response is not
 * changed and not read.
 */
export function createRequestCorrelation(options: { onRequest?: SandboxRequestListener; now?: () => number } = {}): RequestCorrelation {
  const storage = new AsyncLocalStorage<RequestContext>();
  const background: RequestContext = { requestId: BACKGROUND_REQUEST_ID, sqlCount: 0, sqlExecutionMs: 0 };
  const now = options.now ?? (() => performance.now());

  return {
    attach(server) {
      const emit = server.emit;
      server.emit = function emitInRequestContext(this: HttpServerLike, event: string, ...args: unknown[]): boolean {
        if (event !== "request") {
          return emit.call(this, event, ...args);
        }
        const [request, response] = args as [IncomingMessage, ServerResponse];
        const context: RequestContext = { requestId: idFor(request), sqlCount: 0, sqlExecutionMs: 0 };
        const startedAt = now();
        if (options.onRequest !== undefined) {
          const report = options.onRequest;
          response.once("finish", () => {
            try {
              report({
                requestId: context.requestId,
                method: request.method ?? "",
                path: request.url ?? "",
                status: response.statusCode,
                totalMs: Math.max(0, now() - startedAt),
                sqlCount: context.sqlCount,
                sqlExecutionMs: context.sqlExecutionMs,
              });
            } catch {
              // A failing listener must not affect the application.
            }
          });
        }
        return storage.run(context, () => emit.call(this, event, ...args));
      };
    },
    requestId: () => storage.getStore()?.requestId,
    sqlContext() {
      const context = storage.getStore() ?? background;
      context.sqlCount += 1;
      return { requestId: context.requestId, sequence: context.sqlCount };
    },
    record(event) {
      (storage.getStore() ?? background).sqlExecutionMs += event.localExecutionMs;
    },
  };
}

/** One terminal line for a finished request; its SQL entries carry the same ID, numbered 1 to `sqlCount`. */
export function formatSandboxRequestEvent(event: SandboxRequestEvent): string {
  return `[${event.requestId}] ${event.method} ${event.path} ${event.status} sqlCount=${event.sqlCount} sqlTime=${event.sqlExecutionMs.toFixed(1)}ms total=${event.totalMs.toFixed(1)}ms`;
}
