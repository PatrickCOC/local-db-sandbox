import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ACCESS_PROTOCOL, AccessError, carryOut, changesData, isAccessOperation } from "./access.ts";
import type { AccessLimits, RuntimeAccess } from "./access.ts";
import { hasToken, pathOf, readBody, sendJson } from "./http-json.ts";

/*
 * The control of a runtime (D-042): the process that has a database open
 * serves the access to its runtime to other processes of this machine.
 *
 *   GET  /health               -> { "protocol", "instance" }
 *   POST /access/<operation>   { "for"?: <instance>, "request"?: ... }
 *                              -> { "result": ... }  or  { "error": { "code", "message" } }
 *
 * It listens on 127.0.0.1 alone, on a port of its own, and answers only
 * whoever has its token, which the owner puts into its record next to the
 * database (`writer-owner.ts`) and nowhere else: nothing is printed, and
 * nothing is logged. The token keeps a page that is open in a browser on
 * this machine out, as it does for the mailbox (D-029).
 *
 * The operations are those of `RuntimeAccess`, and there is nothing else to
 * ask for: no statement but through the console of the access, no file, no
 * command. This is not a public API; its client is `ControlClient`.
 */

export const HEALTH_PATH = "/health";
export const ACCESS_PATH = "/access/";
const UNAUTHORIZED_MESSAGE = "The token of the database's owner is required.";

/** What a request to an access is answered with: a status, and JSON. */
export interface AccessAnswer {
  status: number;
  body: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusal(error: AccessError): AccessAnswer {
  return { status: error.status, body: JSON.stringify({ error: error.toJSON() }) };
}

/**
 * Answers one request to an access. `body` is the text that was sent, or
 * `undefined` when it was more than a request may have.
 *
 * An answer that is larger than an answer may be is not given, and whoever
 * asked is told so, unless the request changed the database: what was
 * changed is always said. The access has bounded such an answer itself,
 * before anything was committed.
 */
export async function answerAccessRequest(
  access: RuntimeAccess,
  operation: string,
  body: string | undefined,
  limits: Pick<AccessLimits, "maxRequestBytes" | "maxResponseBytes" | "maxSnapshotBytes">,
): Promise<AccessAnswer> {
  if (!isAccessOperation(operation)) {
    return refusal(new AccessError("NOT_FOUND", `There is no operation ${JSON.stringify(operation)}.`));
  }
  if (body === undefined) {
    return refusal(new AccessError("LIMIT_EXCEEDED", `A request may have ${limits.maxRequestBytes} bytes; this one has more.`));
  }
  let envelope: unknown = {};
  if (body.trim() !== "") {
    try {
      envelope = JSON.parse(body);
    } catch {
      return refusal(new AccessError("INVALID_REQUEST", "The request is not JSON."));
    }
  }
  if (!isPlainObject(envelope)) {
    return refusal(new AccessError("INVALID_REQUEST", 'A request is an object: { "for": the owner it is made for, "request": what is asked }.'));
  }
  if (envelope.for !== undefined && typeof envelope.for !== "string") {
    return refusal(new AccessError("INVALID_REQUEST", '"for" must be the name of an owner.'));
  }
  try {
    const result = await carryOut(access, operation, envelope.request, envelope.for === undefined ? undefined : { owner: envelope.for });
    const text = JSON.stringify({ result });
    const bytes = Buffer.byteLength(text);
    // A snapshot is bounded by an access itself, and gives tables whole or not at all.
    const most = operation === "snapshot" ? limits.maxSnapshotBytes + 1_048_576 : limits.maxResponseBytes;
    if (bytes > most && !changesData(operation, envelope.request)) {
      return refusal(new AccessError("LIMIT_EXCEEDED", `The answer has ${bytes} bytes, and an answer may have ${most}.`));
    }
    return { status: 200, body: text };
  } catch (error) {
    return refusal(error instanceof AccessError ? error : new AccessError("INTERNAL", error instanceof Error ? error.message : String(error)));
  }
}

export interface ControlServerOptions {
  /** The access to serve. Who it is of (`instance`) and what a request may ask for (`limits`) are what it says of itself. */
  access: RuntimeAccess;
}

export interface ControlServer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** What every request has to carry. It is the owner's to put into its record, and no one's to print. */
  readonly token: string;
  /** Stops serving. Harmless when done twice. */
  close(): Promise<void>;
}

/** Serves an access on this machine, to whoever has the token. */
export async function startControlServer(options: ControlServerOptions): Promise<ControlServer> {
  const { access } = options;
  const { instance, limits } = await access.info();
  const token = randomBytes(24).toString("hex");

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const refuse = (status: number, code: "UNAUTHORIZED" | "NOT_FOUND" | "INVALID_REQUEST", message: string): void => {
      // Whatever was sent with it is not read.
      request.resume();
      sendJson(response, status, { error: { code, message } });
    };
    if (!hasToken(request, token)) {
      refuse(401, "UNAUTHORIZED", UNAUTHORIZED_MESSAGE);
      return;
    }
    const method = request.method ?? "GET";
    const path = pathOf(request);
    if (path === HEALTH_PATH) {
      if (method !== "GET") {
        refuse(405, "INVALID_REQUEST", `${HEALTH_PATH} is asked with GET.`);
        return;
      }
      request.resume();
      sendJson(response, 200, { protocol: ACCESS_PROTOCOL, instance });
      return;
    }
    const operation = path?.startsWith(ACCESS_PATH) === true ? path.slice(ACCESS_PATH.length) : undefined;
    if (!isAccessOperation(operation)) {
      refuse(404, "NOT_FOUND", "There is nothing here but the operations of an access.");
      return;
    }
    if (method !== "POST") {
      refuse(405, "INVALID_REQUEST", "An operation is asked for with POST.");
      return;
    }
    const answer = await answerAccessRequest(access, operation, await readBody(request, limits.maxRequestBytes), limits);
    sendJson(response, answer.status, undefined, answer.body);
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      // The connection went away, or the request could not be read: there is no one to tell, or nothing to say but this.
      if (response.headersSent) {
        response.destroy();
      } else {
        sendJson(response, 500, { error: { code: "INTERNAL", message: "The request could not be answered." } });
      }
    });
  });
  // Serving a runtime is no reason for a process to keep running: what it serves the runtime for is.
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // This machine's own address, and no other: no other machine has a reason to ask.
    server.listen(0, "127.0.0.1", () => resolve());
  });

  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    close() {
      closed ??= new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
