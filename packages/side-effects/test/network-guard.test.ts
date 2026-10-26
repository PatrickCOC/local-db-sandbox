import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns";
import { promises as dnsPromises } from "node:dns";
import http from "node:http";
import { Socket, connect, createServer } from "node:net";
import type { Server } from "node:net";
import { hostname } from "node:os";
import { after, afterEach, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { NetworkGuardError, installNetworkHook, parseNetworkConfig } from "../src/index.ts";
import type { NetworkEvent, NetworkHookOptions } from "../src/index.ts";

/*
 * The network guard. No test here reaches another machine: a connection that
 * is to be seen as leaving this one names a host that is not this machine and
 * is resolved, by the test's own lookup, to a server on 127.0.0.1.
 */

/** Resolves any name to this machine, in both forms Node asks for an address in. */
const toLoopback = (_hostname: string, options: { all?: boolean }, callback: (...result: unknown[]) => void): void =>
  options.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4);

describe("network guard", () => {
  let server: Server;
  let port: number;
  /** Connections that reached the server. */
  let reached = 0;
  let remove: (() => void) | undefined;
  const accepted = new Set<Socket>();
  const events: NetworkEvent[] = [];
  const original = Socket.prototype.connect;
  const originalLookups = [dns.lookup, dns.resolve4, dns.promises.lookup];

  const install = (options: Partial<NetworkHookOptions> & Pick<NetworkHookOptions, "mode">): void => {
    events.length = 0;
    reached = 0;
    remove = installNetworkHook({ onEvent: (event) => events.push(event), ...options });
  };
  /** Opens a connection and says how it ended: `connected`, or the code of its error. */
  const open = (options: Record<string, unknown> | [number, string?]): Promise<string> =>
    new Promise((resolve) => {
      const socket = Array.isArray(options) ? connect(options[0], options[1] as string) : connect({ lookup: toLoopback, ...options } as never);
      socket.once("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    });
  const seen = (): string[] => events.map(({ host, port: to, scope, action }) => `${host}:${to === port ? "server" : to} ${scope} ${action}`);
  /** What tells a look-up that failed because it was refused from one that failed for any other reason. */
  const lookupCode = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

  before(async () => {
    server = createServer((socket) => {
      reached += 1;
      accepted.add(socket);
      socket.on("error", () => undefined);
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });
  after(async () => {
    // A client may keep its end open; the server does not wait for it.
    for (const socket of accepted) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  });
  afterEach(() => {
    remove?.();
    remove = undefined;
    assert.equal(Socket.prototype.connect, original, "the hook was not removed");
    assert.deepEqual([dns.lookup, dns.resolve4, dns.promises.lookup], originalLookups, "the look-ups of dns were not put back");
  });

  it("allow: every connection is opened, and can be listened for", async () => {
    install({ mode: "allow" });
    assert.equal(await open({ host: "api.example.com", port }), "connected");
    assert.equal(await open({ host: "127.0.0.1", port }), "connected");
    assert.deepEqual(seen(), ["api.example.com:server external allowed", "127.0.0.1:server loopback allowed"]);
    assert.equal(reached, 2);
  });

  it("warn: a connection that leaves this machine is opened and reported", async () => {
    install({ mode: "warn" });
    assert.equal(await open({ host: "api.example.com", port }), "connected");
    assert.equal(await open({ host: "localhost", port }), "connected");
    assert.deepEqual(seen(), ["api.example.com:server external warned", "localhost:server loopback allowed"]);
    assert.equal(reached, 2);
  });

  it("block: a connection that leaves this machine is refused before it is opened", async () => {
    install({ mode: "block" });
    assert.equal(await open({ host: "api.example.com", port }), "ESANDBOXNETWORK");
    // Also without the test's lookup: the host is never resolved, so there is no DNS query either.
    const refused = await new Promise<NetworkGuardError>((resolve) => connect({ host: "smtp.gmail.com", port: 587 }).once("error", resolve as (error: Error) => void));
    assert.ok(refused instanceof NetworkGuardError);
    assert.deepEqual([refused.code, refused.host, refused.port], ["ESANDBOXNETWORK", "smtp.gmail.com", 587]);
    assert.equal(
      refused.message,
      'local-db-sandbox network guard: the connection to smtp.gmail.com:587 was refused before it was opened, because "network.mode" is "block". Connections to this machine are allowed, and so is what "network.allow" lists.',
    );
    assert.deepEqual(seen(), ["api.example.com:server external blocked", "smtp.gmail.com:587 external blocked"]);
    assert.equal(reached, 0);
  });

  it("block: connections to this machine are opened, by any of its names", async () => {
    install({ mode: "block" });
    assert.equal(await open({ host: "127.0.0.1", port }), "connected");
    assert.equal(await open({ host: "localhost", port }), "connected");
    assert.equal(await open({ host: "LocalHost.", port }), "connected");
    // The forms of arguments without options: a port alone is this machine, a port and a host is that host.
    assert.equal(await open([port]), "connected");
    assert.equal(await open([port, "127.0.0.1"]), "connected");
    assert.equal(await open([port, "203.0.113.7"]), "ESANDBOXNETWORK");
    assert.ok(events.filter((event) => event.scope === "loopback").every((event) => event.action === "allowed"));
    assert.equal(events.at(-1)?.action, "blocked");
  });

  it("block: what the allow list names is opened, and nothing else", async () => {
    install({ mode: "block", allow: ["db.internal:" + port, "*.services.example", "cache.example"] });
    assert.equal(await open({ host: "db.internal", port }), "connected");
    assert.equal(await open({ host: "DB.internal", port }), "connected");
    assert.equal(await open({ host: "search.services.example", port }), "connected");
    assert.equal(await open({ host: "cache.example", port }), "connected");
    // Another port of a host that is listed with one, a host that only ends like a listed one, and the bare domain of a wildcard.
    assert.equal(await open({ host: "db.internal", port: 9 }), "ESANDBOXNETWORK");
    assert.equal(await open({ host: "notcache.example", port }), "ESANDBOXNETWORK");
    assert.equal(await open({ host: "services.example", port }), "ESANDBOXNETWORK");
    assert.deepEqual(events.map((event) => `${event.scope} ${event.action}`), ["listed allowed", "listed allowed", "listed allowed", "listed allowed", "external blocked", "external blocked", "external blocked"]);
    assert.equal(reached, 4);
  });

  it("block: a name that nothing could connect to is not looked up either", async () => {
    install({ mode: "block", allow: ["listed.example:5432"], context: () => "req-abc" });
    // The four look-ups a client may make itself, in both forms. None of them leaves the process.
    for (const lookup of ["lookup", "resolve", "resolve4", "resolve6"] as const) {
      const viaCallback = await new Promise((resolve) => (dns[lookup] as (hostname: string, callback: (error: unknown) => void) => void)("smtp.mail-provider.example", resolve));
      assert.ok(viaCallback instanceof NetworkGuardError, lookup);
      assert.deepEqual([viaCallback.code, viaCallback.host, viaCallback.port], ["ESANDBOXNETWORK", "smtp.mail-provider.example", undefined]);
      assert.equal(lookupCode(await (dns.promises[lookup] as (hostname: string) => Promise<unknown>)("smtp.mail-provider.example").catch((error: unknown) => error)), "ESANDBOXNETWORK", lookup);
    }
    assert.equal(lookupCode(await promisify(dns.lookup)("smtp.mail-provider.example").catch((error: unknown) => error)), "ESANDBOXNETWORK");
    assert.match(
      await dnsPromises.lookup("api.example.net").then(() => "looked up", (error: Error) => error.message),
      /^local-db-sandbox network guard: the name api\.example\.net was not looked up, because "network\.mode" is "block" and a connection to it would be refused\./,
    );
    // Several look-ups of one name in a row, as a client that tries one after the other makes, are one report.
    assert.deepEqual(
      events.map(({ operation, host, port: to, scope, action, requestId }) => ({ operation, host, port: to, scope, action, requestId })),
      [
        { operation: "resolve", host: "smtp.mail-provider.example", port: undefined, scope: "external", action: "blocked", requestId: "req-abc" },
        { operation: "resolve", host: "api.example.net", port: undefined, scope: "external", action: "blocked", requestId: "req-abc" },
      ],
    );

    // This machine's names are looked up as always, and so is a name of the allow list (which does not exist: the look-up itself fails).
    assert.deepEqual(await dnsPromises.lookup("localhost", { family: 4 }), { address: "127.0.0.1", family: 4 });
    assert.deepEqual(await promisify(dns.lookup)("localhost", { family: 4 }), { address: "127.0.0.1", family: 4 });
    assert.deepEqual(await dnsPromises.lookup("127.0.0.1"), { address: "127.0.0.1", family: 4 });
    assert.notEqual(lookupCode(await dnsPromises.lookup("listed.example").catch((error: unknown) => error)), "ESANDBOXNETWORK");
    assert.equal(events.length, 2);
  });

  it("knows an address by the name it was looked up for: in the allow list, and in what it reports", async (t) => {
    // A name of this machine that is not "localhost": looking it up asks nothing outside it.
    const name = hostname();
    install({ mode: "block", allow: [`${name}:${port}`] });
    // A client that looks the name up itself and connects to the address it gets, as Nodemailer does.
    const address = await dnsPromises.lookup(name, { family: 4 }).then((found) => found.address, () => undefined);
    if (address === undefined || address.startsWith("127.")) {
      t.skip("this machine's name has no address of its own to look up");
      return;
    }
    // The address is on no list, but the name it was looked up for is: the connection is opened (to a port nothing listens on there).
    assert.notEqual(await open({ host: address, port, lookup: undefined }), "ESANDBOXNETWORK");
    assert.deepEqual(events.map(({ operation, host, address: at, scope, action }) => ({ operation, host, address: at, scope, action })), [{ operation: "connect", host: name, address, scope: "listed", action: "allowed" }]);
    // Another port of it is not listed, and the refusal names the host, not just the address.
    const refused = await new Promise<NetworkGuardError>((resolve) => connect({ host: address, port: 9 }).once("error", resolve as (error: Error) => void));
    assert.deepEqual([refused.code, refused.host, refused.port], ["ESANDBOXNETWORK", name, 9]);
    // An address that no name was looked up for is just an address.
    assert.equal(await open({ host: "203.0.113.9", port, lookup: undefined }), "ESANDBOXNETWORK");
    assert.deepEqual([events.at(-1)?.host, events.at(-1)?.address], ["203.0.113.9", undefined]);

    // What was learnt belongs to the hook: a new one knows the address by nothing, and refuses it.
    remove?.();
    install({ mode: "block" });
    assert.equal(await open({ host: address, port, lookup: undefined }), "ESANDBOXNETWORK");
  });

  it("covers what is built on TCP: HTTP requests and fetch", async () => {
    install({ mode: "block" });
    const viaHttp = await new Promise<string>((resolve) => {
      http.get({ host: "api.example.com", port, path: "/", lookup: toLoopback as never }, () => resolve("answered")).once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    });
    assert.equal(viaHttp, "ESANDBOXNETWORK");
    const viaFetch = await fetch(`http://api.example.com:${port}/`).then(
      () => "answered",
      (error: { cause?: { code?: string } }) => error.cause?.code,
    );
    assert.equal(viaFetch, "ESANDBOXNETWORK");
    assert.equal(reached, 0);
    // To this machine, both go through.
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
    assert.equal(reached, 1);
  });

  it("says what the connection was for: the request, and what usually speaks on the port", async () => {
    const requests = new AsyncLocalStorage<string>();
    install({ mode: "block", context: () => requests.getStore() });
    await requests.run("req-abc", () => open({ host: "smtp.example.com", port: 587 }));
    await open({ host: "db.example.com", port: 5432 });
    await open({ host: "odd.example.com", port: 4711 });
    assert.deepEqual(
      events.map(({ kind, requestId, protocol, pid }) => ({ kind, requestId, protocol, pid })),
      [
        { kind: "network", requestId: "req-abc", protocol: "smtp", pid: process.pid },
        { kind: "network", requestId: "background", protocol: "postgres", pid: process.pid },
        { kind: "network", requestId: "background", protocol: undefined, pid: process.pid },
      ],
    );
  });

  it("is not disturbed by a failing listener, and is installed once", async () => {
    install({
      mode: "warn",
      onEvent: () => {
        throw new Error("listener");
      },
      onConnection: () => {
        throw new Error("listener");
      },
    });
    assert.equal(await open({ host: "api.example.com", port }), "connected");
    assert.throws(() => installNetworkHook({ mode: "allow" }), /already installed in this process/);
  });

  it("checks its configuration", () => {
    assert.deepEqual(parseNetworkConfig({ mode: "block", allow: ["db.internal:5432", "*.example", "[::1]:80"] }, '"network"'), { mode: "block", allow: ["db.internal:5432", "*.example", "[::1]:80"] });
    assert.deepEqual(parseNetworkConfig({ mode: "allow" }, '"network"'), { mode: "allow" });
    const problems: [unknown, RegExp][] = [
      ["block", /"network" must be an object, such as \{ "mode": "block" \}/],
      [{}, /"mode" in "network" must be "allow", "warn", or "block"/],
      [{ mode: "deny" }, /"mode" in "network" must be "allow", "warn", or "block"/],
      [{ mode: "block", allow: "db.internal" }, /"allow" in "network": it must be a list of hosts/],
      [{ mode: "block", allow: ["http://db.internal"] }, /"allow" in "network": "http:\/\/db\.internal" is not a host this can match/],
      [{ mode: "block", allow: [5432] }, /"allow" in "network": 5432 is not a host/],
      [{ mode: "block", hosts: [] }, /"network" has the unknown key "hosts"/],
    ];
    for (const [value, message] of problems) {
      assert.throws(() => parseNetworkConfig(value, '"network"'), message);
    }
  });
});
