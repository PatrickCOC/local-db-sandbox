import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AccessError, DEFAULT_ACCESS_LIMITS, answerAccessRequest, hasToken, pathOf, readBody, sendJson } from "../../runtime-access/src/index.ts";
import type { SnapshotResult } from "../../runtime-access/src/index.ts";
import { ApiRequestError, apiDestination, sendApiRequest } from "./api-request.ts";
import type { ApiRequestErrorCode } from "./api-request.ts";
import { DiagramTooLargeError, checkDiagramSize, diagramOf, layoutDiagram } from "./diagram.ts";
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
 *   POST /api/export                the Export tab (D-050): { "request": { tables, mode, confirmData? } } -> { "result":
 *                                   { fileName, sql, tables, mode, rows, statements, warnings, bytes } } or { "error" }
 *   POST /api/diagram               the ER Diagram tab (D-053): { "request": { tables } } -> { "result": <ErDiagram> }, the
 *                                   tables' definitions as a snapshot without rows gives them, laid out (diagram.ts)
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

/** What an export writes: the definitions, the rows, or both. */
export type StudioExportMode = "schema" | "data" | "schema-and-data";
export const STUDIO_EXPORT_MODES: readonly StudioExportMode[] = ["schema", "data", "schema-and-data"];

/** What an export of tables gave: a whole script, or every reason there is none. */
export type StudioExportOutcome =
  | { status: "exported"; sql: string; tables: string[]; rows: number; statements: number; warnings: string[] }
  | { status: "refused"; refusals: { table?: string; column?: string; message: string }[] };

/**
 * Writes a snapshot of tables as a script. Studio knows no SQL dialect: whoever starts it gives it one (the CLI gives
 * PostgreSQL's, D-050). Without one, the Export tab says that there is none.
 */
export type StudioExporter = (snapshot: SnapshotResult, request: { tables: string[]; mode: StudioExportMode }) => Promise<StudioExportOutcome>;

export const EXPORT_DATA_UNCONFIRMED = "An export with data writes the rows of the tables, which may be data you entered, into a file: it is made only when that is confirmed (confirmData).";

export interface StudioServerOptions {
  session: StudioSession;
  /** What writes an export (the Export tab). */
  exporter?: StudioExporter;
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
  const limits = { maxRequestBytes: DEFAULT_ACCESS_LIMITS.maxRequestBytes, maxResponseBytes: DEFAULT_ACCESS_LIMITS.maxResponseBytes, maxSnapshotBytes: DEFAULT_ACCESS_LIMITS.maxSnapshotBytes };
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
    if (path === "/api/export") {
      if (method !== "POST") {
        refuse(405, "INVALID_REQUEST", "An export is asked for with POST.");
        return;
      }
      const text = await readBody(request, limits.maxRequestBytes);
      let given: { request?: { tables?: unknown; mode?: unknown; confirmData?: unknown } } | undefined;
      try {
        given = text === undefined ? undefined : JSON.parse(text);
      } catch {
        given = undefined;
      }
      const asked = given?.request;
      const tables = asked?.tables;
      const mode = asked?.mode as StudioExportMode;
      if (typeof asked !== "object" || asked === null || !Array.isArray(tables) || tables.length === 0 || !tables.every((name) => typeof name === "string") || !STUDIO_EXPORT_MODES.includes(mode)) {
        sendJson(response, 400, { error: { code: "INVALID_REQUEST", message: `An export is asked for with { "request": { "tables": [at least one table], "mode": one of ${STUDIO_EXPORT_MODES.join(", ")} } }.` } });
        return;
      }
      if (mode !== "schema" && asked.confirmData !== true) {
        sendJson(response, 400, { error: { code: "INVALID_REQUEST", message: EXPORT_DATA_UNCONFIRMED } });
        return;
      }
      if (options.exporter === undefined) {
        sendJson(response, 501, { error: { code: "NOT_AVAILABLE", message: "This Studio was started without a way to write SQL." } });
        return;
      }
      let snapshot: SnapshotResult;
      try {
        // Read whole, at one moment, and nothing of the database changed by it.
        snapshot = await session.access.snapshot({ tables: tables as string[], rows: mode !== "schema" });
      } catch (error) {
        if (!(error instanceof AccessError)) {
          throw error;
        }
        sendJson(response, error.status, { error: error.toJSON() });
        return;
      }
      const outcome = await options.exporter(snapshot, { tables: tables as string[], mode });
      if (outcome.status === "refused") {
        // Nothing is given when anything was refused: never a script that holds part of what was asked for.
        sendJson(response, 422, { error: { code: "EXPORT_REFUSED", message: `The export was not made: ${outcome.refusals.length === 1 ? "one reason" : `${outcome.refusals.length} reasons`}.`, refusals: outcome.refusals } });
        return;
      }
      // When it was made, in UTC: 20261026T072300Z. The file's name holds nothing of the database or of where it is.
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      sendJson(response, 200, {
        result: {
          fileName: `local-db-export-${mode}-${stamp}.sql`,
          sql: outcome.sql,
          tables: outcome.tables,
          mode,
          rows: outcome.rows,
          statements: outcome.statements,
          warnings: outcome.warnings,
          bytes: Buffer.byteLength(outcome.sql),
        },
      });
      return;
    }
    if (path === "/api/diagram") {
      if (method !== "POST") {
        refuse(405, "INVALID_REQUEST", "A diagram is asked for with POST.");
        return;
      }
      const text = await readBody(request, limits.maxRequestBytes);
      let given: { request?: { tables?: unknown } } | undefined;
      try {
        given = text === undefined ? undefined : JSON.parse(text);
      } catch {
        given = undefined;
      }
      const tables = given?.request?.tables;
      if (!Array.isArray(tables) || !tables.every((name) => typeof name === "string") || new Set(tables).size !== tables.length) {
        sendJson(response, 400, { error: { code: "INVALID_REQUEST", message: 'A diagram is asked for with { "request": { "tables": [the tables, each once] } }.' } });
        return;
      }
      try {
        // Refused before anything is read, when there are more tables than a diagram is made of.
        checkDiagramSize(tables.length, 0);
        // The definitions alone: no row is read for a diagram, and nothing is changed.
        const definitions = tables.length === 0 ? [] : (await session.access.snapshot({ tables: tables as string[], rows: false })).schema.tables;
        sendJson(response, 200, { result: await layoutDiagram(diagramOf(definitions)) });
      } catch (error) {
        if (error instanceof DiagramTooLargeError) {
          sendJson(response, 413, { error: { code: error.code, message: error.message } });
        } else if (error instanceof AccessError) {
          sendJson(response, error.status, { error: error.toJSON() });
        } else {
          throw error;
        }
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
