import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_ACCESS_LIMITS, answerAccessRequest, hasToken, pathOf, readBody, sendJson } from "../../runtime-access/src/index.ts";
import { ApiRequestError, apiDestination, sendApiRequest } from "./api-request.ts";
import type { ApiRequestErrorCode } from "./api-request.ts";
import { studioPage } from "./page.ts";
import type { StudioSession } from "./session.ts";

/*
 * Studio's page, and what the page asks (D-042):
 *
 *   GET  /                          the page: one document, the same for every database
 *   GET  /api/status                how things are (`StudioStatus`)
 *   POST /api/access/<operation>    an operation of the runtime's access, in the form the control has it:
 *                                   { "for"?: <owner>, "request"?: ... } -> { "result" } or { "error": { "code", "message" } }
 *   POST /api/request               the API tab (D-046): { "request": { method, url, headers?, body? } }, sent to an
 *                                   API on this machine (api-request.ts) -> { "result": <its answer> } or { "error" }
 *
 * Behind the database's part of the API is the access to the runtime
 * (`answerAccessRequest`, which the control answers with too): Studio has no
 * operations of its own on a database. The API tab is the one thing Studio
 * sends itself, and only to this machine.
 *
 * Who is answered. The server listens on 127.0.0.1 alone; that is not a
 * setting. A browser on this machine can still be led here by a page of
 * another site, so:
 *
 * - everything under /api needs the key of the session, which is random, is
 *   printed once by whoever started Studio, behind a `#` in the address to
 *   open (where a browser sends it to no server), and is in no page;
 * - a request has to name this machine's own address as its host, so that a
 *   name that was pointed at this machine reaches nothing;
 * - a request that says which page it comes from has to come from Studio's;
 * - no answer says that another site may read it.
 *
 * The page runs one script, the one this server wrote into it, and loads
 * nothing: the browser is told so (`Content-Security-Policy`), and that the
 * page is to be shown in no frame.
 */

export const DEFAULT_STUDIO_PORT = 4583;
const UNAUTHORIZED = 'The key of this Studio session is required: open the address that "local-db-sandbox studio" printed.';
const ACCESS = "/api/access/";
/** The status of an answer that says why a request of the API tab was not sent, or not answered. */
const API_ERROR_STATUS: Record<ApiRequestErrorCode, number> = { INVALID_REQUEST: 400, DESTINATION_REFUSED: 403, CONNECTION_REFUSED: 502, CONNECTION_FAILED: 502, TIMEOUT: 504 };

export interface StudioServerOptions {
  session: StudioSession;
  /** Default 4583; 0 for any free port. The host is this machine's own address, always. */
  port?: number;
  /** The address of a local API that the API tab starts from (`--api`). Only a loopback address is taken. */
  api?: string;
}

export interface StudioServer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  /** The key of this session: what the page sends with everything it asks. */
  readonly key: string;
  /** The address to open: the page, with the key behind a `#`. */
  readonly address: string;
  /** Stops serving. The session is whoever's it is. Harmless when done twice. */
  stop(): Promise<void>;
}

/** Serves Studio's page for a session, on this machine. */
export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const { session } = options;
  if (options.api !== undefined) {
    // Refused now, where it was given, and not when the page first sends to it.
    apiDestination(options.api);
  }
  const key = randomBytes(24).toString("hex");
  const nonce = randomBytes(18).toString("base64url");
  const page = studioPage(nonce);
  // `img-src`: the icon a browser asks its server for by itself. The page has no image.
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  const limits = { maxRequestBytes: DEFAULT_ACCESS_LIMITS.maxRequestBytes, maxResponseBytes: DEFAULT_ACCESS_LIMITS.maxResponseBytes };
  let port = 0;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const refuse = (status: number, code: "UNAUTHORIZED" | "NOT_FOUND" | "INVALID_REQUEST", message: string): void => {
      // Whatever was sent with it is not read.
      request.resume();
      sendJson(response, status, { error: { code, message } });
    };
    // Before anything else: who is asking. A name that leads here and is not this machine's own is a stranger's.
    const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    if (!origins.includes(`http://${request.headers.host ?? ""}`)) {
      refuse(403, "UNAUTHORIZED", `Local DB Studio is this machine's own: open it at ${origins[0]}.`);
      return;
    }
    if (request.headers.origin !== undefined && !origins.includes(request.headers.origin)) {
      refuse(403, "UNAUTHORIZED", "Local DB Studio answers its own page, and no other.");
      return;
    }
    const method = request.method ?? "GET";
    const path = pathOf(request);

    if (path === undefined || !path.startsWith("/api/")) {
      if (path === "/") {
        if (method !== "GET") {
          refuse(405, "INVALID_REQUEST", "The page is asked for with GET.");
          return;
        }
        request.resume();
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": policy,
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
          "content-length": Buffer.byteLength(page),
        });
        response.end(page);
      } else if (path === "/favicon.ico") {
        request.resume();
        response.writeHead(204, { "cache-control": "max-age=86400" });
        response.end();
      } else {
        refuse(404, "NOT_FOUND", "There is nothing here but Studio's page.");
      }
      return;
    }

    if (!hasToken(request, key)) {
      refuse(401, "UNAUTHORIZED", UNAUTHORIZED);
      return;
    }
    if (path === "/api/status") {
      if (method !== "GET") {
        refuse(405, "INVALID_REQUEST", "The status is asked for with GET.");
        return;
      }
      request.resume();
      sendJson(response, 200, { ...(await session.status()), ...(options.api !== undefined && { api: options.api }) });
      return;
    }
    if (path === "/api/request") {
      if (method !== "POST") {
        refuse(405, "INVALID_REQUEST", "A request of the API tab is sent with POST.");
        return;
      }
      const text = await readBody(request, limits.maxRequestBytes);
      let given: { request?: unknown } | undefined;
      try {
        given = text === undefined ? undefined : JSON.parse(text);
      } catch {
        given = undefined;
      }
      if (given === undefined || given === null || typeof given !== "object" || typeof given.request !== "object" || given.request === null) {
        sendJson(response, 400, { error: { code: "INVALID_REQUEST", message: text === undefined ? `The request is larger than ${limits.maxRequestBytes} bytes.` : 'The API tab sends { "request": { "method", "url", "headers", "body" } }.' } });
        return;
      }
      try {
        // Nothing of it is logged or kept: it is answered, and gone.
        sendJson(response, 200, { result: await sendApiRequest(given.request as never, { refusedPorts: [port] }) });
      } catch (error) {
        if (!(error instanceof ApiRequestError)) {
          throw error;
        }
        sendJson(response, API_ERROR_STATUS[error.code], { error: { code: error.code, message: error.message } });
      }
      return;
    }
    const operation = path.startsWith(ACCESS) ? path.slice(ACCESS.length) : undefined;
    if (operation === undefined || operation === "" || operation.includes("/")) {
      refuse(404, "NOT_FOUND", "There is nothing here but the status and the operations of an access.");
      return;
    }
    if (method !== "POST") {
      refuse(405, "INVALID_REQUEST", "An operation is asked for with POST.");
      return;
    }
    const answer = await answerAccessRequest(session.access, operation, await readBody(request, limits.maxRequestBytes), limits);
    sendJson(response, answer.status, undefined, answer.body);
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) {
        response.destroy();
      } else {
        sendJson(response, 500, { error: { code: "INTERNAL", message: "The request could not be answered." } });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // This machine's own address, and no other. There is no option for another one.
    server.listen(options.port ?? DEFAULT_STUDIO_PORT, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  let stopped: Promise<void> | undefined;
  return {
    url,
    port,
    key,
    address: `${url}/#key=${key}`,
    stop() {
      stopped ??= new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return stopped;
    },
  };
}
