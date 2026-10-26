import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/*
 * What the two local HTTP servers of D-042 share: the control of a runtime
 * and Studio's own page. Both speak JSON, read no more of a request than a
 * request may have, and answer only whoever has their token.
 */

/** Whether a request carries that token, as `Authorization: Bearer <token>`. Compared in constant time. */
export function hasToken(request: IncomingMessage, token: string): boolean {
  const [given, expected] = [Buffer.from(request.headers.authorization ?? ""), Buffer.from(`Bearer ${token}`)];
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The text of a request's body. `undefined` when it has more than `most`
 * bytes: what is over is read and dropped, not kept, so that whoever sent
 * it still gets to read the answer.
 */
export function readBody(request: IncomingMessage, most: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const announced = Number(request.headers["content-length"]);
    let over = Number.isFinite(announced) && announced > most;
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (over || size > most) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(over ? undefined : Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** Answers with JSON that is never kept by whoever receives it. `text`: the JSON itself, when it is there already. */
export function sendJson(response: ServerResponse, status: number, body: unknown, text: string = JSON.stringify(body)): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

/** The path of a request, without what follows a question mark. `undefined` for an address that cannot be read. */
export function pathOf(request: IncomingMessage): string | undefined {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return undefined;
  }
}
