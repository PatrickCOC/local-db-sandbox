import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SqliteRuntime } from "../../runtime/src/index.ts";
import type { RelationalRuntime, SqlEventContext, SqlEventListener } from "../../runtime/src/index.ts";
import { claimDatabase, claimDatabaseIfThere, formatNotice, openDatabaseStorage } from "../../storage-json/src/index.ts";
import type { DatabaseClaim, SizeWarningListener } from "../../storage-json/src/index.ts";
import { PostgrestError, unsupported } from "./errors.ts";
import { errorResponse, handlePostgrestRequest } from "./handler.ts";
import type { PostgrestResponse } from "./handler.ts";

/*
 * The HTTP side of the PostgREST endpoint. It serves `/rest/v1/<table>`, the
 * path supabase-js and other PostgREST clients use under a Supabase URL, so
 * an application is pointed at the sandbox by its Supabase URL alone
 * (`SUPABASE_URL=http://127.0.0.1:54321`). Its code is not changed.
 *
 * Other Supabase services under the same URL (Auth, Storage, Realtime,
 * Edge Functions, RPC) are answered with 501 and a message that names the
 * service: the sandbox does not provide them.
 */

export const DEFAULT_POSTGREST_HOST = "127.0.0.1";
/** The API port of a local Supabase stack, so that its usual URL works. */
export const DEFAULT_POSTGREST_PORT = 54321;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const REQUEST_ID = /^[\w.:@-]{1,128}$/;

/** One request to the endpoint. Header values are never part of it: the keys clients send are secrets. */
export interface PostgrestRequestEvent {
  requestId: string;
  method: string;
  /** Path and query string. The query holds filter values, which are application data. */
  path: string;
  status: number;
  /** PostgREST's or the sandbox's error code, for a failed request. */
  errorCode?: string;
  /** SQL statements the request ran; equal to the number of SQL events with its `requestId`. */
  sqlCount: number;
  /** Local time spent executing them. */
  sqlExecutionMs: number;
  totalMs: number;
}

/**
 * Tells the runtime which request a statement runs for. The runtime is
 * synchronous and a request is handled in one synchronous step, so the
 * request being handled is simply the current one.
 */
export class PostgrestRequestCorrelation {
  #current: { requestId: string; sequence: number; sqlExecutionMs: number } | undefined;

  /** For `SqliteRuntimeOptions.context`. Statements outside a request are `background`. */
  readonly context = (): SqlEventContext => {
    const current = this.#current;
    if (current === undefined) {
      return { requestId: "background" };
    }
    current.sequence += 1;
    return { requestId: current.requestId, sequence: current.sequence };
  };

  /** For `runtime.subscribe`: adds a statement's time to its request. */
  readonly onSql: SqlEventListener = (event) => {
    if (this.#current !== undefined && event.requestId === this.#current.requestId) {
      this.#current.sqlExecutionMs += event.localExecutionMs;
    }
  };

  run<T>(requestId: string, work: () => T): { result: T; sqlCount: number; sqlExecutionMs: number } {
    const record = { requestId, sequence: 0, sqlExecutionMs: 0 };
    this.#current = record;
    try {
      return { result: work(), sqlCount: record.sequence, sqlExecutionMs: record.sqlExecutionMs };
    } finally {
      this.#current = undefined;
    }
  }
}

export interface PostgrestServerOptions {
  runtime: RelationalRuntime;
  /** The correlation the runtime was opened with (`context`). Without one, statements carry no request. */
  correlation?: PostgrestRequestCorrelation;
  /** Default 127.0.0.1. */
  host?: string;
  /** Default 54321; 0 for any free port. */
  port?: number;
  /** PostgREST's `db-max-rows`; default 1000, as on Supabase. `null` for no cap. */
  maxRows?: number | null;
  /** Largest request body accepted. Default 64 MB. */
  maxBodyBytes?: number;
  onRequest?: (event: PostgrestRequestEvent) => void;
}

/** Which Supabase service a path belongs to, when it is one the sandbox does not provide. */
function otherService(segments: string[]): string | undefined {
  const [first, second, third] = segments;
  if (second !== "v1") {
    return undefined;
  }
  switch (first) {
    case "auth":
      return "Supabase Auth (/auth/v1)";
    case "storage":
      return "Supabase Storage (/storage/v1)";
    case "realtime":
      return "Supabase Realtime (/realtime/v1)";
    case "functions":
      return "Edge Functions (/functions/v1)";
    case "graphql":
      return "GraphQL (/graphql/v1)";
    case "rest":
      if (third === undefined) {
        return "The OpenAPI description (GET /rest/v1/)";
      }
      return third === "rpc" ? "Calling database functions (/rest/v1/rpc, supabase-js: .rpc())" : undefined;
    default:
      return undefined;
  }
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        reject(new PostgrestError(413, "PGRST413", `The request body is larger than ${limit} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function headerValues(request: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

export class PostgrestServer {
  readonly #options: PostgrestServerOptions;
  #server: Server | undefined;
  #requests = 0;
  #unsubscribe: (() => void) | undefined;

  constructor(options: PostgrestServerOptions) {
    this.#options = options;
  }

  start(): Promise<{ host: string; port: number; url: string }> {
    if (this.#server !== undefined) {
      return Promise.reject(new Error("Server is already started."));
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;
    const correlation = this.#options.correlation;
    if (correlation !== undefined) {
      this.#unsubscribe = this.#options.runtime.subscribe(correlation.onSql);
    }
    return new Promise((resolve, reject) => {
      server.once("error", (error) => {
        this.#server = undefined;
        this.#unsubscribe?.();
        reject(error);
      });
      server.listen(this.#options.port ?? DEFAULT_POSTGREST_PORT, this.#options.host ?? DEFAULT_POSTGREST_HOST, () => {
        const { address, port, family } = server.address() as AddressInfo;
        resolve({ host: address, port, url: `http://${family === "IPv6" ? `[${address}]` : address}:${port}` });
      });
    });
  }

  stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) {
      return Promise.resolve();
    }
    this.#server = undefined;
    this.#unsubscribe?.();
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = performance.now();
    const method = request.method ?? "GET";
    const given = request.headers["x-request-id"];
    this.#requests += 1;
    const requestId = typeof given === "string" && REQUEST_ID.test(given) ? given : `req-${this.#requests}`;

    // Any origin may call: the endpoint is a local development tool, bound to loopback.
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-expose-headers", "content-range, preference-applied, x-request-id");
    response.setHeader("x-request-id", requestId);

    if (method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS",
        "access-control-allow-headers": request.headers["access-control-request-headers"] ?? "*",
        "access-control-max-age": "86400",
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://sandbox.local");
    let result: PostgrestResponse;
    let sqlCount = 0;
    let sqlExecutionMs = 0;
    try {
      let segments: string[];
      try {
        segments = url.pathname.split("/").filter((segment) => segment !== "").map(decodeURIComponent);
      } catch {
        throw new PostgrestError(400, "PGRST100", "The request path is not valid.");
      }
      const service = otherService(segments);
      if (service !== undefined) {
        throw unsupported(service, "The sandbox provides PostgREST table access only. Auth, Storage, Realtime, RPC, and Edge Functions are not emulated.");
      }
      const [rest, version, table, ...more] = segments;
      if (rest !== "rest" || version !== "v1" || table === undefined || more.length > 0) {
        throw new PostgrestError(404, "PGRST125", `Invalid path: ${url.pathname}`, "The sandbox serves tables at /rest/v1/<table>.");
      }
      const body = method === "POST" || method === "PATCH" || method === "PUT" ? await readBody(request, this.#options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES) : undefined;
      const handled = (): PostgrestResponse =>
        handlePostgrestRequest(
          this.#options.runtime,
          { method, table, query: url.searchParams, headers: headerValues(request), ...(body !== undefined && { body }) },
          { ...(this.#options.maxRows !== undefined && { maxRows: this.#options.maxRows }) },
        );
      if (this.#options.correlation === undefined) {
        result = handled();
      } else {
        ({ result, sqlCount, sqlExecutionMs } = this.#options.correlation.run(requestId, handled));
      }
    } catch (error) {
      result = errorResponse(error instanceof PostgrestError ? error : new PostgrestError(500, "SANDBOX_RUNTIME_ERROR", error instanceof Error ? error.message : String(error)));
    }

    response.writeHead(result.status, result.headers);
    response.end(result.body === "" || method === "HEAD" ? undefined : result.body);

    if (this.#options.onRequest !== undefined) {
      let errorCode: string | undefined;
      if (result.status >= 400) {
        try {
          errorCode = (JSON.parse(result.body) as { code?: string }).code;
        } catch {
          // Not a PostgREST error body.
        }
      }
      try {
        this.#options.onRequest({
          requestId,
          method,
          path: `${url.pathname}${url.search}`,
          status: result.status,
          ...(errorCode !== undefined && { errorCode }),
          sqlCount,
          sqlExecutionMs,
          totalMs: performance.now() - startedAt,
        });
      } catch {
        // A failing listener must not change the response.
      }
    }
  }
}

export interface PostgrestSandboxOptions {
  /** A database directory or file that stores its table definitions (schema.json). */
  database: string;
  host?: string;
  port?: number;
  maxRows?: number | null;
  /** Write committed changes back. Default: yes, unless the database declares "persistence": "memory". */
  save?: boolean;
  maxFileSizeMb?: number;
  onSizeWarning?: SizeWarningListener;
  onSql?: SqlEventListener;
  onRequest?: (event: PostgrestRequestEvent) => void;
  /** Most returned rows put on a SQL event (default 20). */
  resultPreviewRows?: number;
}

export interface RunningPostgrestSandbox {
  /** The base URL to give a Supabase client, e.g. `http://127.0.0.1:54321`. */
  url: string;
  host: string;
  port: number;
  runtime: RelationalRuntime;
  /** Tables served at /rest/v1/<table>. */
  tables: string[];
  /** Collections of the database without a stored definition; they are not served. */
  unservedTables: string[];
  /** Whether committed changes are written back to the database. */
  saves: boolean;
  formatNotice: string | undefined;
  /**
   * The claim the endpoint has on its database while it runs (D-042). Whoever
   * composes the endpoint with something that serves its runtime to other
   * processes says where in this claim's record; `stop()` lets go of it.
   */
  claim: DatabaseClaim;
  stop(): Promise<void>;
}

/**
 * Opens a database on the relational runtime and serves its tables through
 * the PostgREST endpoint. Only tables with a stored definition (schema.json
 * of a directory, `$tableSchema` of a file) are served: PostgREST's types,
 * keys, and conversions depend on them, and they are not guessed from rows.
 */
export async function startPostgrestSandbox(options: PostgrestSandboxOptions): Promise<RunningPostgrestSandbox> {
  // The database is this process's before it is read (D-042): an endpoint that saves would otherwise write over
  // what another process saved meanwhile, and one that does not save has the rows that are served, which are not
  // the files'. What is known of saving before the database is read is what was asked for.
  const owner = { kind: "postgrest" as const, ...(options.save !== undefined && { persistence: options.save ? ("json" as const) : ("memory" as const) }) };
  let claim = await claimDatabaseIfThere(options.database, owner);
  let runtime: RelationalRuntime | undefined;
  try {
    const storage = openDatabaseStorage(options.database, { maxFileSizeMb: options.maxFileSizeMb, onSizeWarning: options.onSizeWarning });
    const state = await storage.load();
    // A database that was not there a moment ago, and is now, is claimed like any other.
    claim ??= await claimDatabase(options.database, owner);
    const schema = storage.schema;
    if (schema === undefined || schema.length === 0) {
      throw new Error(
        `${options.database} stores no table definitions. The PostgREST endpoint serves tables with a declared definition only (schema.json in a database directory); ` +
          "write one, or create the database with import-typeorm.",
      );
    }
    const persistence = options.save === false ? "memory" : options.save === true ? "json" : (storage.persistence ?? "json");
    if (persistence === "json") {
      storage.assertWritable();
    }
    const correlation = new PostgrestRequestCorrelation();
    const opened = await SqliteRuntime.open({
      schema,
      storage,
      state,
      persistence,
      context: correlation.context,
      ...(options.resultPreviewRows !== undefined && { resultPreviewRows: options.resultPreviewRows }),
    });
    runtime = opened;
    if (options.onSql !== undefined) {
      opened.subscribe(options.onSql);
    }
    const server = new PostgrestServer({
      runtime: opened,
      correlation,
      ...(options.host !== undefined && { host: options.host }),
      ...(options.port !== undefined && { port: options.port }),
      ...(options.maxRows !== undefined && { maxRows: options.maxRows }),
      ...(options.onRequest !== undefined && { onRequest: options.onRequest }),
    });
    const address = await server.start();
    const served = new Set(schema.map((table) => table.name));
    const held = claim;
    return {
      ...address,
      runtime: opened,
      tables: schema.map((table) => table.name),
      unservedTables: Object.keys(state.collections).filter((name) => !served.has(name)),
      saves: persistence === "json",
      formatNotice: storage.formatStatus === undefined ? undefined : formatNotice(storage.formatStatus, options.database),
      claim: held,
      async stop() {
        try {
          await server.stop();
          opened.close();
        } finally {
          // Last: the database is this process's for as long as anything of it may still be written.
          held.release();
        }
      },
    };
  } catch (error) {
    runtime?.close();
    claim?.release();
    throw error;
  }
}
