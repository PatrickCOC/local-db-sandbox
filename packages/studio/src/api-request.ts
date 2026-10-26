import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from "node:http";

/*
 * The request the API tab sends (Phase E3, D-046): one HTTP request to an
 * API that runs on this machine, sent by Studio's server for its page, and
 * its answer as text.
 *
 * Where it may go. The address is read as a URL, and its host is taken as
 * it is written: 127.0.0.1, localhost, or [::1], and nothing else. No name
 * is looked up: localhost is connected to at 127.0.0.1, and at ::1 when
 * nothing listens there, so that no resolver, hosts file, or DNS answer
 * decides where a request goes. Only http: is spoken. A redirect is shown
 * as the answer it is, and not followed. Studio's own port is not asked.
 *
 * What is kept. Nothing: no request, header, body, or answer is written to
 * a log or a file, or held after it was answered. A cookie the API sets is
 * shown as there, without its value.
 */

export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ApiMethod = (typeof API_METHODS)[number];

/** What the page asks for. */
export interface ApiRequest {
  method: string;
  url: string;
  /** One header per line, as `Name: value`. Empty lines are passed over. */
  headers?: string;
  /** JSON text, or nothing. */
  body?: string;
}

/** An answer of the API, as it came, but for what is cut and hidden. */
export interface ApiResponse {
  status: number;
  statusText: string;
  /** From sending the request until the answer was read, in milliseconds, on this machine. */
  durationMs: number;
  /** Name and value, in the order they came. A cookie that is set is shown without its value. */
  headers: [string, string][];
  /** The body as UTF-8 text: at most `maxResponseBytes` of it. */
  body: string;
  /** Bytes of the body that were read. */
  bodyBytes: number;
  /** The body was longer than `maxResponseBytes`, and was cut there. */
  truncated: boolean;
}

export type ApiRequestErrorCode = "INVALID_REQUEST" | "DESTINATION_REFUSED" | "CONNECTION_REFUSED" | "TIMEOUT" | "CONNECTION_FAILED";

/** A request that was not sent, or not answered: the message says which, and why. */
export class ApiRequestError extends Error {
  readonly code: ApiRequestErrorCode;

  constructor(code: ApiRequestErrorCode, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
  }
}

export interface ApiRequestOptions {
  /** How long a request may take, answer included. Default 10 s. */
  timeoutMs?: number;
  /** The most of a body that is read. Default 1 MiB. */
  maxResponseBytes?: number;
  /** Ports that are not asked: Studio's own. */
  refusedPorts?: readonly number[];
}

export const DEFAULT_API_TIMEOUT_MS = 10_000;
export const DEFAULT_API_RESPONSE_BYTES = 1_048_576;

/** The hosts that may be asked, as a URL has them, and the addresses each is connected to, in order. */
const LOOPBACK: Readonly<Record<string, readonly string[]>> = { "127.0.0.1": ["127.0.0.1"], localhost: ["127.0.0.1", "::1"], "[::1]": ["::1"] };

/** Headers that are the connection's, which Node sets itself, and which a request of the page does not. */
const NOT_GIVEN = new Set(["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "proxy-connection", "expect"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Where a request goes: the URL as it was read, and the addresses to connect to. Throws `ApiRequestError` for any other place. */
export function apiDestination(text: string, refusedPorts: readonly number[] = []): { url: URL; addresses: readonly string[]; port: number } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new ApiRequestError("INVALID_REQUEST", `${JSON.stringify(text)} is not a URL. Give the whole address of the API, such as http://127.0.0.1:3000/users.`);
  }
  if (url.protocol !== "http:") {
    throw new ApiRequestError("INVALID_REQUEST", `Only http: is sent, and the URL is ${url.protocol}. An API on this machine is asked over http://127.0.0.1:<port>/.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ApiRequestError("INVALID_REQUEST", "The URL carries a user name or a password. Give credentials as a header (Authorization: ...), which is not kept.");
  }
  const addresses = Object.hasOwn(LOOPBACK, url.hostname) ? LOOPBACK[url.hostname] : undefined;
  if (addresses === undefined) {
    throw new ApiRequestError(
      "DESTINATION_REFUSED",
      `${url.hostname} is not this machine: the API tab sends requests to 127.0.0.1, localhost, or [::1] only. Start the API locally, and give its local address.`,
    );
  }
  const port = url.port === "" ? 80 : Number(url.port);
  if (refusedPorts.includes(port)) {
    throw new ApiRequestError("DESTINATION_REFUSED", `Port ${port} is Local DB Studio's own. Give the port of the API.`);
  }
  return { url, addresses, port };
}

/** The headers of the page, as Node takes them. Throws `ApiRequestError` for a line that is no header, or a header that is the connection's. */
export function apiHeaders(text: string | undefined): [string, string][] {
  const headers: [string, string][] = [];
  for (const [index, line] of (text ?? "").split(/\r?\n/).entries()) {
    if (line.trim() === "") {
      continue;
    }
    const colon = line.indexOf(":");
    const name = colon === -1 ? "" : line.slice(0, colon).trim();
    if (!TOKEN.test(name)) {
      throw new ApiRequestError("INVALID_REQUEST", `Header line ${index + 1} is not "Name: value".`);
    }
    if (NOT_GIVEN.has(name.toLowerCase())) {
      throw new ApiRequestError("INVALID_REQUEST", `The header ${name} is the connection's, and is set by Studio: leave it out.`);
    }
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  return headers;
}

/** The value of a header that is not shown: a cookie the API sets. */
const HIDDEN = "(set; the value is not shown)";

function headersOf(response: IncomingMessage): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index] as string;
    pairs.push([name, name.toLowerCase() === "set-cookie" ? HIDDEN : (response.rawHeaders[index + 1] as string)]);
  }
  return pairs;
}

/**
 * Sends one request to an API on this machine and reads its answer. Throws
 * `ApiRequestError` when it is not sent (what the page gave, or where it
 * would go) or not answered (nothing listens, it took too long, the
 * connection broke).
 */
export async function sendApiRequest(given: ApiRequest, options: ApiRequestOptions = {}): Promise<ApiResponse> {
  const method = String(given.method ?? "").toUpperCase();
  if (!(API_METHODS as readonly string[]).includes(method)) {
    throw new ApiRequestError("INVALID_REQUEST", `The method is ${JSON.stringify(given.method)}; it is one of ${API_METHODS.join(", ")}.`);
  }
  if (typeof given.url !== "string") {
    throw new ApiRequestError("INVALID_REQUEST", "There is no URL.");
  }
  const { url, addresses, port } = apiDestination(given.url, options.refusedPorts);
  const headers = apiHeaders(given.headers);
  const body = typeof given.body === "string" && given.body.trim() !== "" ? given.body : undefined;
  if (body !== undefined) {
    if (method === "GET") {
      throw new ApiRequestError("INVALID_REQUEST", "A GET request sends no body. Leave the body empty, or choose another method.");
    }
    try {
      JSON.parse(body);
    } catch (error) {
      throw new ApiRequestError("INVALID_REQUEST", `The body is not JSON (${error instanceof Error ? error.message : String(error)}). Nothing was sent.`);
    }
    if (!headers.some(([name]) => name.toLowerCase() === "content-type")) {
      headers.push(["Content-Type", "application/json"]);
    }
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const most = options.maxResponseBytes ?? DEFAULT_API_RESPONSE_BYTES;
  const outgoing: OutgoingHttpHeaders = { host: url.host };
  for (const [name, value] of headers) {
    const before = outgoing[name.toLowerCase()];
    outgoing[name.toLowerCase()] = before === undefined ? value : [...(Array.isArray(before) ? before : [String(before)]), value];
  }
  const payload = body === undefined ? undefined : Buffer.from(body, "utf8");
  if (payload !== undefined) {
    outgoing["content-length"] = payload.byteLength;
  }

  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  const shown = `${url.protocol}//${url.host}`;
  const nothing = new ApiRequestError("CONNECTION_REFUSED", `Nothing listens at ${shown}. Start the API, or check its port.`);
  let refused = false;
  for (const [index, address] of addresses.entries()) {
    try {
      return await exchange(address, port, `${url.pathname}${url.search}`, method, outgoing, payload, Math.max(0, deadline - performance.now()), most, startedAt);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (error instanceof ApiRequestError) {
        throw new ApiRequestError("TIMEOUT", `${shown} did not answer within ${timeoutMs / 1000} s. The request was given up; what the API did with it is not known.`);
      }
      // localhost: nothing at 127.0.0.1 is no answer yet, while ::1 has not been asked; and a machine without IPv6 has nothing at ::1.
      if (code === "ECONNREFUSED" || (refused && (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT" || code === "ENETUNREACH"))) {
        refused = true;
        if (index + 1 < addresses.length) {
          continue;
        }
        throw nothing;
      }
      throw new ApiRequestError("CONNECTION_FAILED", `The request to ${shown} failed: ${error instanceof Error ? error.message : String(error)}. What the API did with it is not known.`);
    }
  }
  throw nothing;
}

/** One request on one connection, to one address. */
function exchange(
  address: string,
  port: number,
  path: string,
  method: string,
  headers: OutgoingHttpHeaders,
  payload: Buffer | undefined,
  timeoutMs: number,
  most: number,
  startedAt: number,
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    const finish = (outcome: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        outcome();
      }
    };
    const timer = setTimeout(() => {
      finish(() => reject(new ApiRequestError("TIMEOUT", "timeout")));
      request?.destroy();
    }, timeoutMs);
    // An address, not a name: nothing is looked up. `agent: false`: one connection, closed after it, and shared with nothing.
    request = httpRequest({ host: address, family: address.includes(":") ? 6 : 4, port, path, method, headers, agent: false, setHost: false });
    request.on("error", (error) => finish(() => reject(error)));
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const done = (): void =>
        finish(() =>
          resolve({
            status: response.statusCode ?? 0,
            statusText: response.statusMessage ?? "",
            durationMs: performance.now() - startedAt,
            headers: headersOf(response),
            body: Buffer.concat(chunks).toString("utf8"),
            bodyBytes: size,
            truncated,
          }),
        );
      response.on("data", (chunk: Buffer) => {
        if (truncated) {
          return;
        }
        const room = most - size;
        if (chunk.byteLength > room) {
          chunks.push(chunk.subarray(0, room));
          size = most;
          truncated = true;
          // What is over is not read: the connection is closed, and the answer is what came.
          done();
          response.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.byteLength;
      });
      response.on("end", done);
      response.on("error", (error) => finish(() => reject(error)));
      response.on("aborted", () => finish(() => reject(new Error("the connection was closed before the answer was complete"))));
    });
    request.end(payload);
  });
}
