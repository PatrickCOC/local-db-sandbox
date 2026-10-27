import { request as httpRequest } from "node:http";
import { AccessError, DEFAULT_ACCESS_LIMITS, assertMadeFor, changesData, isAccessErrorCode } from "./access.ts";
import type { AccessInfo, AccessOperation, BrowseRequest, BrowseResult, ChangeResult, EventsResult, RequestOptions, RowKey, RowResult, RuntimeAccess, SchemaInfo, SnapshotRequest, SnapshotResult, SqlRequest, SqlResult, ClearRequest, ClearResult } from "./access.ts";
import { ACCESS_PATH, HEALTH_PATH } from "./control-server.ts";

/*
 * The client of a runtime's control (D-042): the access to a runtime that
 * another process has open. It is made for one owner, and says so with
 * every request, so that nothing it asks is carried out by another.
 *
 * It tells apart what did not happen from what may have happened:
 *
 * - nothing listens where the owner served: nothing was sent
 *   (`OWNER_UNREACHABLE`), whatever was asked;
 * - a request was sent and no answer came: for one that changes nothing,
 *   the owner is not there (`OWNER_UNREACHABLE`), and it can be asked again;
 *   for one that changes the database, the outcome is not known
 *   (`OUTCOME_UNKNOWN`), and it is no one's to send again but the person's
 *   who asked for it;
 * - something answers that is not the owner: another has taken its place
 *   (`OWNER_CHANGED`, or `UNAUTHORIZED` from an owner with another token).
 *
 * It sends nothing a second time, and it sends nothing to an address that
 * is not this machine's own, whatever a record says.
 */

/** Where an owner serves, as its record says it. */
const OWN_ADDRESS = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
export const OUTCOME_UNKNOWN_MESSAGE = "The change was sent to the process that has the database open, and no answer came: whether it was carried out is not known. Look at the data before doing it again.";

export interface ControlTarget {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  token: string;
  /** The owner that serves there: the one every request of this client is made for. */
  instance: string;
}

export interface ControlClientOptions {
  /** How long an answer may take, in ms (default 30000). */
  timeoutMs?: number;
  /** The most bytes of a request that are sent (default: what a request may have). */
  maxRequestBytes?: number;
  /** The most bytes of an answer that are read (default: four times what an answer may have). */
  maxResponseBytes?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ControlClient implements RuntimeAccess {
  readonly url: string;
  readonly instance: string;
  // Private, so that it is in nothing that prints this object.
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;

  constructor(target: ControlTarget, options: ControlClientOptions = {}) {
    if (typeof target.url !== "string" || !OWN_ADDRESS.test(target.url)) {
      throw new AccessError("OWNER_UNREACHABLE", `The owner's record names an address that is not this machine's own (${String(target.url)}): nothing is sent there.`);
    }
    this.url = target.url;
    this.instance = target.instance;
    this.#token = target.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRequestBytes = options.maxRequestBytes ?? DEFAULT_ACCESS_LIMITS.maxRequestBytes;
    // An answer may be a snapshot, which may be larger than any other (with what the answer says around it).
    this.#maxResponseBytes = options.maxResponseBytes ?? Math.max(4 * DEFAULT_ACCESS_LIMITS.maxResponseBytes, DEFAULT_ACCESS_LIMITS.maxSnapshotBytes + 1_048_576);
  }

  #stranger(): AccessError {
    return new AccessError("OWNER_CHANGED", `What answers at ${this.url} is not the process that had the database open.`);
  }

  /** Sends one request, once, and resolves with the status and the text of the answer. `write`: it may change the database. */
  #send(method: "GET" | "POST", path: string, payload: string | undefined, write: boolean): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      // Whether a connection was made: from then on, what was sent may have arrived.
      let connected = false;
      let settled = false;
      const fail = (error: AccessError): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      };
      const noAnswer = (why: string): AccessError =>
        write && connected ? new AccessError("OUTCOME_UNKNOWN", OUTCOME_UNKNOWN_MESSAGE) : new AccessError("OWNER_UNREACHABLE", `The process that has the database open does not answer (${this.url}): ${why}${connected ? "" : " Nothing was sent, and nothing was done."}`);

      const request = httpRequest(
        `${this.url}${path}`,
        {
          method,
          // A connection of its own for every request: none is sent on one that the owner has closed meanwhile.
          agent: false,
          headers: {
            authorization: `Bearer ${this.#token}`,
            connection: "close",
            ...(payload !== undefined && { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > this.#maxResponseBytes) {
              // Not the owner's doing: it gives no answer that large. What a change did cannot be read from it.
              fail(write ? new AccessError("OUTCOME_UNKNOWN", OUTCOME_UNKNOWN_MESSAGE) : new AccessError("LIMIT_EXCEEDED", `The answer from ${this.url} has more than ${this.#maxResponseBytes} bytes, which is what an answer may have.`));
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (!response.complete) {
              fail(noAnswer("the connection ended before an answer came."));
            } else if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
            }
          });
          response.on("error", () => fail(noAnswer("the connection ended before an answer came.")));
          response.on("close", () => fail(noAnswer("the connection ended before an answer came.")));
        },
      );
      const timer = setTimeout(() => {
        fail(noAnswer(connected ? `no answer came in ${this.#timeoutMs} ms.` : `no connection was made in ${this.#timeoutMs} ms.`));
        request.destroy();
      }, this.#timeoutMs);
      request.on("socket", (socket) => {
        if (socket.connecting) {
          socket.once("connect", () => (connected = true));
        } else {
          connected = true;
        }
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        fail(noAnswer(connected ? "the connection ended before an answer came." : error.code === "ECONNREFUSED" ? "nothing listens there." : `no connection could be made (${error.code ?? error.message}).`));
      });
      request.end(payload);
    });
  }

  /** What an answer says: the result, or the refusal as the owner gave it. Anything else is not an owner's answer. */
  #read(status: number, text: string): unknown {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw this.#stranger();
    }
    if (isPlainObject(body)) {
      if (status >= 200 && status < 300 && Object.hasOwn(body, "result")) {
        return body.result;
      }
      const error = body.error;
      if (status >= 400 && isPlainObject(error) && isAccessErrorCode(error.code) && typeof error.message === "string") {
        throw new AccessError(error.code, error.message);
      }
    }
    throw this.#stranger();
  }

  async #ask(operation: AccessOperation, request: unknown, options: RequestOptions | undefined): Promise<unknown> {
    // Whoever asks for another owner than this client's is told so here: nothing is sent.
    assertMadeFor(this.instance, options);
    const payload = JSON.stringify({ for: this.instance, ...(request !== undefined && { request }) });
    if (Buffer.byteLength(payload) > this.#maxRequestBytes) {
      throw new AccessError("LIMIT_EXCEEDED", `A request may have ${this.#maxRequestBytes} bytes; this one has more.`);
    }
    const { status, text } = await this.#send("POST", `${ACCESS_PATH}${operation}`, payload, changesData(operation, request));
    return this.#read(status, text);
  }

  /** Resolves when the owner this client was made for answers there. Rejects with why not. */
  async health(): Promise<void> {
    const { status, text } = await this.#send("GET", HEALTH_PATH, undefined, false);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw this.#stranger();
    }
    if (status === 200 && isPlainObject(body) && body.instance === this.instance) {
      return;
    }
    if (status === 401) {
      // An owner, with another token: another one than this client's.
      this.#read(status, text);
    }
    throw this.#stranger();
  }

  info(options?: RequestOptions): Promise<AccessInfo> {
    return this.#ask("info", undefined, options) as Promise<AccessInfo>;
  }

  schema(options?: RequestOptions): Promise<SchemaInfo> {
    return this.#ask("schema", undefined, options) as Promise<SchemaInfo>;
  }

  browse(request: BrowseRequest, options?: RequestOptions): Promise<BrowseResult> {
    return this.#ask("browse", request, options) as Promise<BrowseResult>;
  }

  row(request: { table: string; key: RowKey }, options?: RequestOptions): Promise<RowResult> {
    return this.#ask("row", request, options) as Promise<RowResult>;
  }

  insert(request: { table: string; values: Record<string, unknown> }, options?: RequestOptions): Promise<ChangeResult> {
    return this.#ask("insert", request, options) as Promise<ChangeResult>;
  }

  update(request: { table: string; key: RowKey; values: Record<string, unknown> }, options?: RequestOptions): Promise<ChangeResult> {
    return this.#ask("update", request, options) as Promise<ChangeResult>;
  }

  delete(request: { table: string; key: RowKey }, options?: RequestOptions): Promise<ChangeResult> {
    return this.#ask("delete", request, options) as Promise<ChangeResult>;
  }

  sql(request: SqlRequest, options?: RequestOptions): Promise<SqlResult> {
    return this.#ask("sql", request, options) as Promise<SqlResult>;
  }

  events(request?: { after?: number }, options?: RequestOptions): Promise<EventsResult> {
    return this.#ask("events", request, options) as Promise<EventsResult>;
  }

  snapshot(request: SnapshotRequest, options?: RequestOptions): Promise<SnapshotResult> {
    return this.#ask("snapshot", request, options) as Promise<SnapshotResult>;
  }

  clear(request: ClearRequest, options?: RequestOptions): Promise<ClearResult> {
    return this.#ask("clear", request, options) as Promise<ClearResult>;
  }
}
