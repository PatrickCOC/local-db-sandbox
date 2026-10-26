import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { DATA, SCHEMA } from "../../runtime-access/test/support/fixture.ts";
import { ownDatabase } from "../../runtime-access/test/support/owner-process.ts";
import type { OwnerProcess } from "../../runtime-access/test/support/owner-process.ts";
import { createDatabase } from "../../storage-json/src/index.ts";
import { allFiles } from "../../storage-json/test/support/database-files.ts";
import { runCli } from "../../cli/src/index.ts";
import { ApiRequestError, apiDestination, sendApiRequest, startStudio } from "../src/index.ts";
import type { RunningStudio } from "../src/index.ts";
import { EventEmitter } from "node:events";

/*
 * The API tab (Phase E3, D-046): Studio's server sends one request to an
 * API on this machine for its page, and answers with what came back. Only
 * 127.0.0.1, localhost, and [::1] are asked; no name is looked up; nothing
 * is followed, logged, or kept.
 */

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** A small API on this machine, which says what it was sent. */
async function localApi(handle?: (seen: Seen, response: ServerResponse) => Promise<boolean> | boolean): Promise<{ server: Server; url: string; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const entry = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      if (handle !== undefined && (await handle(entry, response))) {
        return;
      }
      const send = (status: number, body: unknown, headers: Record<string, string | string[]> = {}): void => {
        const text = typeof body === "string" ? body : JSON.stringify(body);
        response.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json", ...headers });
        response.end(text);
      };
      if (entry.url === "/items" && entry.method === "GET") {
        send(200, [{ id: 1, name: "one" }]);
      } else if (entry.url.startsWith("/items") && entry.method === "POST") {
        send(201, { received: JSON.parse(entry.body), authorization: entry.headers.authorization ?? null, test: entry.headers["x-test"] ?? null, type: entry.headers["content-type"] ?? null });
      } else if (entry.url === "/away") {
        send(302, "", { location: "http://example.com/stolen" });
      } else if (entry.url === "/cookie") {
        send(200, { ok: true }, { "set-cookie": ["session=very-secret-cookie; HttpOnly"] });
      } else if (entry.url === "/big") {
        send(200, "x".repeat(1_048_576 + 50_000));
      } else if (entry.url === "/slow") {
        // Never answered.
      } else {
        send(404, { error: "not found" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, port, seen };
}

/** A port that nothing listens on: one that was free a moment ago. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Answer {
  status: number;
  json: any;
}

/** What the page sends: to Studio's own address, with the session's key unless told otherwise. */
function post(studio: RunningStudio, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${studio.key}` }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const request = httpRequest(`${studio.url}/api/request`, { method: "POST", agent: false, headers: { "content-type": "application/json", connection: "close", ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
    request.end(text);
  });
}

describe("Studio's API tab: one request to an API on this machine", { timeout: 120_000 }, () => {
  let root: string;
  let directory: string;
  const running: RunningStudio[] = [];
  const servers: Server[] = [];
  const owners: OwnerProcess[] = [];
  const start = async (options: { api?: string } = {}): Promise<RunningStudio> => {
    const studio = await startStudio({ database: directory, port: 0, ...options });
    running.push(studio);
    return studio;
  };
  const api = async (handle?: Parameters<typeof localApi>[0]): Promise<Awaited<ReturnType<typeof localApi>>> => {
    const made = await localApi(handle);
    servers.push(made.server);
    return made;
  };
  const send = (studio: RunningStudio, request: Record<string, unknown>): Promise<Answer> => post(studio, { request });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "local-db-sandbox-studio-api-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  beforeEach(async () => {
    directory = join(root, `db-${Math.random().toString(16).slice(2)}`, "sandbox.db");
    await createDatabase(directory, { collections: DATA(), schema: SCHEMA });
  });
  afterEach(async () => {
    for (const studio of running.splice(0)) {
      await studio.stop();
    }
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const owner of owners.splice(0)) {
      await owner.kill();
    }
  });

  it("sends GET and POST with JSON and the headers given, and answers with the status, the time, the headers, and the body", async () => {
    const target = await api();
    const studio = await start();

    const got = await send(studio, { method: "GET", url: `${target.url}/items` });
    assert.equal(got.status, 200);
    assert.deepEqual([got.json.result.status, got.json.result.statusText, JSON.parse(got.json.result.body), got.json.result.truncated], [200, "OK", [{ id: 1, name: "one" }], false]);
    assert.equal(typeof got.json.result.durationMs, "number");
    assert.ok(got.json.result.headers.some(([name, value]: [string, string]) => name.toLowerCase() === "content-type" && value === "application/json"));

    const posted = await send(studio, { method: "POST", url: `${target.url}/items?draft=1`, headers: "Authorization: Bearer local-token\nX-Test: yes\n\n", body: '{ "name": "two", "tags": ["a"] }' });
    assert.deepEqual([posted.json.result.status, posted.json.result.statusText], [201, "Created"]);
    assert.deepEqual(JSON.parse(posted.json.result.body), { received: { name: "two", tags: ["a"] }, authorization: "Bearer local-token", test: "yes", type: "application/json" });
    const [, sent] = target.seen as [Seen, Seen];
    // As written: the body is sent as it was typed, and the host is the one of the URL.
    assert.deepEqual([sent.method, sent.url, sent.body, sent.headers.host], ["POST", "/items?draft=1", '{ "name": "two", "tags": ["a"] }', `127.0.0.1:${target.port}`]);

    // localhost is this machine too: it is connected to at 127.0.0.1, and nothing is looked up for it.
    const local = await send(studio, { method: "GET", url: `http://localhost:${target.port}/items` });
    assert.deepEqual([local.json.result.status, target.seen.at(-1)?.headers.host], [200, `localhost:${target.port}`]);
    // An answer that is no success is an answer like any other: what it means is for the person to say.
    const missing = await send(studio, { method: "DELETE", url: `${target.url}/nothing` });
    assert.deepEqual([missing.status, missing.json.result.status, JSON.parse(missing.json.result.body)], [200, 404, { error: "not found" }]);
  });

  it("sends nothing for a body that is no JSON, a GET with a body, a header that is no header or the connection's, or an unknown method", async () => {
    const target = await api();
    const studio = await start();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ method: "POST", url: `${target.url}/items`, body: "{ name: two }" }, /^The body is not JSON \(.+\)\. Nothing was sent\.$/],
      [{ method: "GET", url: `${target.url}/items`, body: "{}" }, /^A GET request sends no body\./],
      [{ method: "GET", url: `${target.url}/items`, headers: "no colon here" }, /^Header line 1 is not "Name: value"\.$/],
      [{ method: "GET", url: `${target.url}/items`, headers: "Host: example.com" }, /^The header Host is the connection's, and is set by Studio/],
      [{ method: "GET", url: `${target.url}/items`, headers: "X-Ok: 1\nTransfer-Encoding: chunked" }, /^The header Transfer-Encoding is the connection's/],
      [{ method: "TRACE", url: `${target.url}/items` }, /^The method is "TRACE"; it is one of GET, POST, PUT, PATCH, DELETE\.$/],
      [{ method: "GET", url: "not a url" }, /^"not a url" is not a URL\./],
    ];
    for (const [request, message] of cases) {
      const answer = await send(studio, request);
      assert.deepEqual([answer.status, answer.json.error.code], [400, "INVALID_REQUEST"], JSON.stringify(request));
      assert.match(answer.json.error.message, message);
    }
    const malformed = await post(studio, "{ not json");
    assert.deepEqual([malformed.status, malformed.json.error.code], [400, "INVALID_REQUEST"]);
    assert.equal(target.seen.length, 0);
  });

  it("asks this machine alone: another host, address, protocol, or Studio's own port is refused, and nothing is sent", async () => {
    const studio = await start();
    const refused = [
      "http://example.com/",
      "http://10.0.0.1:3000/",
      "http://192.168.1.10/",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost.example.com/",
      "http://127.0.0.1.nip.io/",
      "http://127.0.0.2/",
      "http://0.0.0.0:3000/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fe80::1]/",
    ];
    for (const url of refused) {
      const answer = await send(studio, { method: "GET", url });
      assert.deepEqual([answer.status, answer.json.error.code], [403, "DESTINATION_REFUSED"], url);
      assert.match(answer.json.error.message, /is not this machine: the API tab sends requests to 127\.0\.0\.1, localhost, or \[::1\] only\./);
    }
    for (const url of ["https://127.0.0.1/", "ftp://127.0.0.1/", "file:///etc/passwd", "javascript:alert(1)", "http://user:secret@127.0.0.1:3000/"]) {
      const answer = await send(studio, { method: "GET", url });
      assert.deepEqual([answer.status, answer.json.error.code], [400, "INVALID_REQUEST"], url);
    }
    const own = await send(studio, { method: "GET", url: `${studio.url}/api/status` });
    assert.deepEqual([own.status, own.json.error.code], [403, "DESTINATION_REFUSED"]);
    assert.match(own.json.error.message, /is Local DB Studio's own/);
  });

  it("shows a redirect as the answer it is, and follows it nowhere: not off this machine, and not to another port of it", async () => {
    const elsewhere = await api();
    const target = await api((seen, response) => {
      if (seen.url === "/local-hop") {
        response.writeHead(307, { location: `${elsewhere.url}/items` });
        response.end();
        return true;
      }
      return false;
    });
    const studio = await start();
    const away = await send(studio, { method: "GET", url: `${target.url}/away` });
    assert.deepEqual([away.status, away.json.result.status], [200, 302]);
    assert.ok(away.json.result.headers.some(([name, value]: [string, string]) => name.toLowerCase() === "location" && value === "http://example.com/stolen"));
    const hop = await send(studio, { method: "POST", url: `${target.url}/local-hop`, body: "{}" });
    assert.equal(hop.json.result.status, 307);
    assert.equal(elsewhere.seen.length, 0);
  });

  it("says when nothing listens, when the API takes too long, and cuts an answer that is too long", async () => {
    const target = await api();
    const studio = await start();
    const port = await closedPort();
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`]) {
      const answer = await send(studio, { method: "GET", url });
      assert.deepEqual([answer.status, answer.json.error.code], [502, "CONNECTION_REFUSED"], url);
      assert.match(answer.json.error.message, /^Nothing listens at http:\/\/.+\. Start the API, or check its port\.$/);
    }

    const big = await send(studio, { method: "GET", url: `${target.url}/big` });
    assert.deepEqual([big.status, big.json.result.status, big.json.result.truncated, big.json.result.bodyBytes, big.json.result.body.length], [200, 200, true, 1_048_576, 1_048_576]);

    // The time limit, shorter than Studio's ten seconds, on the function the server calls.
    await assert.rejects(sendApiRequest({ method: "GET", url: `${target.url}/slow` }, { timeoutMs: 300 }), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.code, "TIMEOUT");
      assert.match(error.message, /did not answer within 0\.3 s\. The request was given up; what the API did with it is not known\.$/);
      return true;
    });
    const short = await sendApiRequest({ method: "GET", url: `${target.url}/items` }, { maxResponseBytes: 5 });
    assert.deepEqual([short.body, short.truncated], ['[{"id', true]);
  });

  it("answers only the page of the session: without its key, from another name, or from another site, nothing is sent", async () => {
    const target = await api();
    const studio = await start();
    const request = { request: { method: "GET", url: `${target.url}/items` } };
    const cases: [Record<string, string>, number][] = [
      [{}, 401],
      [{ authorization: "Bearer not-the-key" }, 401],
      [{ authorization: `Bearer ${studio.key}`, host: "evil.example" }, 403],
      [{ authorization: `Bearer ${studio.key}`, origin: "https://evil.example" }, 403],
    ];
    for (const [headers, status] of cases) {
      assert.equal((await post(studio, request, headers)).status, status, JSON.stringify(headers));
    }
    assert.equal(target.seen.length, 0);
  });

  it("writes no credential, header, or body to a log or a file, and shows a cookie the API sets without its value", async () => {
    const target = await api();
    const studio = await start();
    const before = await allFiles(directory);
    const written: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => (written.push(String(chunk)), (out as any)(chunk, ...rest))) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => (written.push(String(chunk)), (err as any)(chunk, ...rest))) as typeof process.stderr.write;
    let cookie: Answer;
    try {
      const sent = await send(studio, { method: "POST", url: `${target.url}/items`, headers: "Authorization: Bearer secret-token-123\nCookie: sid=secret-cookie-456", body: '{ "password": "secret-body-789" }' });
      assert.equal(sent.json.result.status, 201);
      cookie = await send(studio, { method: "GET", url: `${target.url}/cookie` });
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    assert.deepEqual(
      cookie.json.result.headers.filter(([name]: [string, string]) => name.toLowerCase() === "set-cookie"),
      // The name as the API sent it.
      [["set-cookie", "(set; the value is not shown)"]],
    );
    assert.doesNotMatch(JSON.stringify(cookie.json), /very-secret-cookie/);
    const secrets = /secret-token-123|secret-cookie-456|secret-body-789|very-secret-cookie/;
    assert.doesNotMatch(written.join(""), secrets);
    assert.deepEqual(await allFiles(directory), before);
    for (const name of await readdir(root, { recursive: true })) {
      const path = join(root, String(name));
      const text = await readFile(path, "utf8").catch(() => "");
      assert.doesNotMatch(text, secrets, path);
    }
  });

  it("starts from the API it was started with, which must be this machine's", async () => {
    const target = await api();
    const studio = await start({ api: `${target.url}/items` });
    const status = await new Promise<Answer>((resolve, reject) => {
      const request = httpRequest(`${studio.url}/api/status`, { agent: false, headers: { authorization: `Bearer ${studio.key}` } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status.json.api, `${target.url}/items`);
    await assert.rejects(startStudio({ database: directory, port: 0, api: "http://example.com/" }), (error: unknown) => error instanceof ApiRequestError && error.code === "DESTINATION_REFUSED");
    assert.throws(() => apiDestination("https://localhost:3000/"), /Only http: is sent/);

    // The command says so, and starts nothing.
    let stderr = "";
    const code = await runCli(["studio", directory, "--port", "0", "--api", "http://10.1.2.3:3000/"], { stdout: { write: () => true }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    assert.equal(code, 1);
    assert.match(stderr, /^Error: 10\.1\.2\.3 is not this machine: the API tab sends requests to 127\.0\.0\.1, localhost, or \[::1\] only\./);
  });

  it("attached to a sandbox: what a request of the API tab changes through the application is what Rows shows", async () => {
    const owner = await ownDatabase(directory, "nest");
    owners.push(owner);
    // The application: its API writes through its own runtime, as a backend on the sandbox does.
    const target = await api(async (seen, response) => {
      if (seen.method === "POST" && seen.url === "/notes") {
        const { text } = JSON.parse(seen.body) as { text: string };
        await owner.sql(`INSERT INTO notes (text) VALUES ('${text.replaceAll("'", "''")}')`);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ created: text }));
        return true;
      }
      return false;
    });
    const studio = await start({ api: target.url });
    assert.equal(studio.mode, "attached");
    const sent = await send(studio, { method: "POST", url: `${target.url}/notes`, body: JSON.stringify({ text: "from the API tab" }) });
    assert.deepEqual([sent.json.result.status, JSON.parse(sent.json.result.body)], [201, { created: "from the API tab" }]);
    // Rows, as the page asks for them.
    const rows = await new Promise<Answer>((resolve, reject) => {
      const request = httpRequest(
        `${studio.url}/api/access/browse`,
        { method: "POST", agent: false, headers: { authorization: `Bearer ${studio.key}`, "content-type": "application/json" } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ request: { table: "notes" } }));
    });
    assert.deepEqual(rows.json.result.rows.at(-1), ["from the API tab"]);
  });
});
