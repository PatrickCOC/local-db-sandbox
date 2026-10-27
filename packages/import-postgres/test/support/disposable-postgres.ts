import { mkdtemp, rm } from "node:fs/promises";
import { createServer, connect } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/*
 * A disposable PostgreSQL for the tests of the catalog scan: PGlite
 * (PostgreSQL 18 compiled to WebAssembly, in memory), served on a port of
 * 127.0.0.1 with PostgreSQL's own wire protocol, so the scan connects to it
 * as it connects to any server. Nothing outside the test's process is
 * started, and no database of this machine is reached.
 *
 * PGlite has one user, `postgres`, and takes any password.
 */

export interface DisposablePostgres {
  db: PGlite;
  port: number;
  /** `postgresql://postgres@127.0.0.1:<port>/postgres`. */
  url: string;
  stop: () => Promise<void>;
}

/**
 * Starts a server whose database holds what `setup` makes, as `postgres`.
 * With `role`, the server then runs everything as that role, which `setup`
 * creates: what the role may not read is refused by PostgreSQL itself.
 */
export async function startDisposablePostgres(setup: string, options: { role?: string } = {}): Promise<DisposablePostgres> {
  let db: PGlite;
  let directory: string | undefined;
  if (options.role === undefined) {
    db = await PGlite.create();
    if (setup !== "") {
      await db.exec(setup);
    }
  } else {
    // A role is chosen when a database is opened, so the database is made, closed, and opened again as that role.
    directory = await mkdtemp(join(tmpdir(), "local-db-sandbox-pglite-"));
    const owner = await PGlite.create(directory);
    await owner.exec(setup);
    await owner.close();
    db = await PGlite.create(directory, { username: options.role });
  }
  const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" });
  await server.start();
  const port = ((server as unknown as { server: Server }).server.address() as AddressInfo).port;
  return {
    db,
    port,
    url: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
    stop: async () => {
      await server.stop();
      await db.close();
      if (directory !== undefined) {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  };
}

const SSL_REQUEST = 80877103;

/** What a client sends, read message by message as it arrives: the untyped ones of the start, then typed ones. */
function messageReader(onMessage: (type: string | undefined, body: Buffer, raw: Buffer) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  let started = false;
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const typed = started;
      const header = typed ? 5 : 4;
      if (pending.length < header) {
        return;
      }
      const length = pending.readUInt32BE(typed ? 1 : 0);
      const total = (typed ? 1 : 0) + length;
      if (pending.length < total) {
        return;
      }
      const raw = pending.subarray(0, total);
      pending = pending.subarray(total);
      const body = raw.subarray(header);
      // An SSL request comes before the startup message; the startup message is the last untyped one.
      if (!typed && !(length === 8 && body.readUInt32BE(0) === SSL_REQUEST)) {
        started = true;
      }
      onMessage(typed ? String.fromCharCode(raw[0] as number) : undefined, body, raw);
    }
  };
}

/** The text of a query that a client sends: a simple query ('Q') or the parse of an extended one ('P'). */
function queryText(type: string | undefined, body: Buffer): string | undefined {
  if (type === "Q") {
    return body.subarray(0, body.indexOf(0)).toString("utf8");
  }
  if (type === "P") {
    const nameEnd = body.indexOf(0);
    return body.subarray(nameEnd + 1, body.indexOf(0, nameEnd + 1)).toString("utf8");
  }
  return undefined;
}

export interface Proxy {
  port: number;
  /** Every query a client sent through it, in order. */
  queries: string[];
  stop: () => Promise<void>;
}

/**
 * A server in front of another, on a port of its own, that passes everything
 * on and records the text of every query. With `answered`, it passes the
 * login and the first `answered` queries on, and then answers nothing more:
 * it keeps the connection open and says nothing, as a server does that
 * hangs. With `answered: -1` it says nothing at all, not even to the login.
 */
export async function startProxy(port: number, options: { answered?: number } = {}): Promise<Proxy> {
  const sockets = new Set<Socket>();
  const queries: string[] = [];
  const answered = options.answered ?? Number.POSITIVE_INFINITY;
  const server = createServer((client) => {
    sockets.add(client);
    client.on("error", () => {});
    if (answered < 0) {
      client.on("data", () => {});
      return;
    }
    const upstream = connect(port, "127.0.0.1");
    sockets.add(upstream);
    let stalled = false;
    let count = 0;
    client.on(
      "data",
      messageReader((type, body, raw) => {
        if (stalled) {
          return;
        }
        const text = queryText(type, body);
        if (text !== undefined) {
          queries.push(text);
          count += 1;
          if (count > answered) {
            stalled = true;
            return;
          }
        }
        upstream.write(raw);
      }),
    );
    upstream.on("data", (chunk) => {
      if (!stalled) {
        client.write(chunk);
      }
    });
    const close = (): void => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    queries,
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A message of the server, typed. */
function serverMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

/**
 * A server that speaks only as much of PostgreSQL's protocol as a login
 * takes: it answers an SSL request with "no", asks for the password in
 * plain text when `askPassword` is set, records it, and then refuses the
 * login with `error` (a SQLSTATE and PostgreSQL's message).
 */
export async function startRefusingServer(error: { code: string; message: string }, options: { askPassword?: boolean } = {}): Promise<{ port: number; passwords: string[]; stop: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const passwords: string[] = [];
  const refuse = (client: Socket): void => {
    const fields = Buffer.from(`SFATAL\0VFATAL\0C${error.code}\0M${error.message}\0\0`, "utf8");
    client.end(serverMessage("E", fields));
  };
  const server = createServer((client) => {
    sockets.add(client);
    client.on("error", () => {});
    client.on(
      "data",
      messageReader((type, body) => {
        if (type === undefined && body.length === 4 && body.readUInt32BE(0) === SSL_REQUEST) {
          client.write("N");
        } else if (type === undefined) {
          if (options.askPassword === true) {
            const request = Buffer.alloc(4);
            request.writeUInt32BE(3);
            client.write(serverMessage("R", request));
          } else {
            refuse(client);
          }
        } else if (type === "p") {
          passwords.push(body.subarray(0, body.indexOf(0)).toString("utf8"));
          refuse(client);
        }
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    passwords,
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port of 127.0.0.1 on which nothing listens. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
