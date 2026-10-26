import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { Socket, isIP } from "node:net";
import { isLoopbackHost } from "./smtp-server.ts";

/*
 * Looks at every TCP connection the process opens, before it is opened.
 *
 * `net.Socket.prototype.connect` is the one place every outgoing TCP
 * connection of Node's own modules goes through: `net`, `tls`, `http`,
 * `https`, `http2`, the built-in `fetch`, and the database, mail, cache, and
 * queue clients written on them. Replacing it lets the sandbox see where a
 * connection is going while it is still a call, and refuse it there, so that
 * nothing leaves the process.
 *
 * Some clients look a host name up themselves and connect to the address
 * they get (Nodemailer does). So the look-ups of `dns` (`lookup`, `resolve`,
 * `resolve4`, `resolve6`, and their promise forms) are followed as well: a
 * name that could not be connected to is not looked up either, and an
 * address is known by the name it was looked up for, which is what the allow
 * list and the reports go by.
 *
 * This is a guard for development, against a sandbox that reaches a real
 * service by accident. It is not a security boundary. It does not see UDP,
 * other DNS queries (other record types, or a resolver of the application's
 * own), worker threads, child processes, or native code that opens sockets
 * of its own, and code that wants to get around it can.
 */

/** `allow`: nothing is refused. `warn`: connections that leave this machine are reported. `block`: they are refused. */
export type NetworkGuardMode = "allow" | "warn" | "block";

export const NETWORK_GUARD_MODES: readonly NetworkGuardMode[] = ["allow", "warn", "block"];

/** One connection the process was about to open, or one host name it was about to look up. */
export interface NetworkEvent {
  kind: "network";
  /** `connect`: a TCP connection. `resolve`: the look-up of a host name; only one that was refused is reported. */
  operation: "connect" | "resolve";
  /** The host: the name that was given, or the name that the address that was given was looked up for. */
  host: string;
  /** The address the connection goes to, when it was made to an address and its name is known from a look-up. */
  address?: string;
  /** The port of a connection. A look-up has none. */
  port?: number;
  /** What usually speaks on that port (`smtp`, `https`, `postgres`, ...). A hint from the port number, not something that was observed. */
  protocol?: string;
  /** `loopback`: this machine. `listed`: named in the allow list. `external`: anything else. */
  scope: "loopback" | "listed" | "external";
  /** `allowed`: opened. `warned`: opened and reported, because it leaves this machine. `blocked`: refused before it was opened. */
  action: "allowed" | "warned" | "blocked";
  /** The HTTP request the application was handling, or `background`. */
  requestId: string;
  pid: number;
}

/**
 * A socket that is about to connect: a Node `net.Socket`, described by the
 * members that are used so that the published types do not depend on Node's.
 */
export interface ConnectingSocket {
  /** The port of this end of the connection, once it is connected. */
  readonly localPort?: number;
  once(event: string, listener: (...args: any[]) => void): unknown;
  write: (...args: any[]) => boolean;
}

export interface NetworkHookOptions {
  mode: NetworkGuardMode;
  /**
   * Hosts that are not this machine and may be connected to all the same:
   * `host`, `host:port`, or `*.domain`, each with an optional port.
   */
  allow?: readonly string[];
  /** The request the caller is running for; `background` when it returns nothing. */
  context?: () => string | undefined;
  /** Told about every connection that goes through the hook, and every look-up it refuses. */
  onEvent?: (event: NetworkEvent) => void;
  /** Told about every connection that is opened, with its socket, while it is connecting. */
  onConnection?: (target: { host: string; port: number }, socket: ConnectingSocket) => void;
}

export class NetworkGuardError extends Error {
  readonly code = "ESANDBOXNETWORK";
  readonly host: string;
  /** The port of the connection that was refused; absent when it was the look-up of the name. */
  readonly port: number | undefined;

  constructor(host: string, port?: number) {
    super(
      (port === undefined
        ? `local-db-sandbox network guard: the name ${host} was not looked up, because "network.mode" is "block" and a connection to it would be refused. `
        : `local-db-sandbox network guard: the connection to ${host}:${port} was refused before it was opened, because "network.mode" is "block". `) +
        'Connections to this machine are allowed, and so is what "network.allow" lists.',
    );
    this.name = "NetworkGuardError";
    this.host = host;
    this.port = port;
  }
}

const PROTOCOLS: Record<number, string> = {
  21: "ftp",
  22: "ssh",
  25: "smtp",
  80: "http",
  443: "https",
  465: "smtp",
  587: "smtp",
  1433: "sqlserver",
  2525: "smtp",
  3306: "mysql",
  5432: "postgres",
  5672: "amqp",
  6379: "redis",
  9092: "kafka",
  11211: "memcached",
  27017: "mongodb",
};

const INSTALLED = Symbol.for("local-db-sandbox.network-hook");
/** The look-ups that are followed, in `dns` and in `dns.promises`. */
const LOOKUPS = ["lookup", "resolve", "resolve4", "resolve6"] as const;
/** How many addresses are remembered by the name they were looked up for. */
const REMEMBERED_ADDRESSES = 2000;
/** A client that tries several look-ups of one name in a row is reported once. */
const SAME_LOOKUP_MS = 2000;

type AnyFunction = (...args: any[]) => any;

/** Whether `host` is this machine: a loopback address, `localhost`, or the address that means "any address of this machine". */
function isLocal(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "");
  return isLoopbackHost(name) || name === "0.0.0.0" || name === "::";
}

/** Checks the entries of an allow list, and returns the reason the first unusable one is refused. */
export function allowListProblem(entries: readonly unknown[]): string | undefined {
  for (const entry of entries) {
    if (typeof entry !== "string" || !/^(\*\.)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(:\d{1,5})?$/.test(entry)) {
      return `${JSON.stringify(entry)} is not a host this can match: use "host", "host:port", or "*.domain".`;
    }
  }
  return undefined;
}

/** Whether the allow list names the host: for a connection, with its port; for a look-up (no port), with any. */
function isListed(host: string, port: number | undefined, allow: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return allow.some((entry) => {
    const match = /^((?:\*\.)?(?:\[[^\]]+\]|[^:]+))(?::(\d+))?$/.exec(entry.toLowerCase());
    if (match === null || (port !== undefined && match[2] !== undefined && Number(match[2]) !== port)) {
      return false;
    }
    const pattern = (match[1] as string).replace(/^\[|\]$/g, "");
    return pattern.startsWith("*.") ? name.endsWith(pattern.slice(1)) : name === pattern;
  });
}

/** Where a `socket.connect(...)` call is going, for each form of arguments Node accepts. `undefined` for a pipe or a Unix socket, which stays on this machine. */
function targetOf(args: unknown[]): { host: string; port: number } | undefined {
  let first = args[0];
  if (Array.isArray(first)) {
    // Node's own callers pass the arguments already normalized: [options, callback].
    [first] = first;
  }
  if (first !== null && typeof first === "object") {
    const options = first as { path?: unknown; host?: unknown; port?: unknown };
    // As `net` itself decides: a path that is set means a pipe. Node's HTTP client passes `path: null` for a TCP connection.
    return options.path ? undefined : { host: String(options.host ?? "localhost"), port: Number(options.port) };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) {
    return undefined;
  }
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: Number(first) };
}

/** The addresses in what a look-up gave: a string, a list of strings, or a list of objects with an `address`. */
function addressesIn(result: unknown): string[] {
  return (Array.isArray(result) ? result : [result])
    .map((item) => (typeof item === "string" ? item : (item as { address?: unknown } | null | undefined)?.address))
    .filter((address): address is string => typeof address === "string" && isIP(address) !== 0);
}

/**
 * Installs the hook in this process, and returns what removes it again. Only
 * one can be installed at a time.
 */
export function installNetworkHook(options: NetworkHookOptions): () => void {
  const prototype = Socket.prototype as unknown as { connect: ((...args: unknown[]) => unknown) & { [INSTALLED]?: boolean } };
  if (prototype.connect[INSTALLED] === true) {
    throw new Error("The local-db-sandbox network hook is already installed in this process.");
  }
  const allow = options.allow ?? [];
  const connect = prototype.connect;
  /** The name each address was last looked up for. */
  const names = new Map<string, string>();
  let lastRefusedLookup = { key: "", at: 0 };

  const report = (event: Omit<NetworkEvent, "kind" | "requestId" | "pid">): void => {
    try {
      options.onEvent?.({ kind: "network", ...event, requestId: options.context?.() ?? "background", pid: process.pid });
    } catch {
      // A failing listener must not change what happens to the connection.
    }
  };

  const hooked = function (this: Socket, ...args: unknown[]): unknown {
    const target = targetOf(args);
    if (target === undefined) {
      return connect.apply(this, args);
    }
    // An address that a name was looked up for is judged, and reported, by that name.
    const name = isIP(target.host.replace(/^\[|\]$/g, "")) === 0 ? undefined : names.get(target.host.replace(/^\[|\]$/g, ""));
    const scope = isLocal(target.host) ? "loopback" : isListed(target.host, target.port, allow) || (name !== undefined && isListed(name, target.port, allow)) ? "listed" : "external";
    const action = scope !== "external" || options.mode === "allow" ? "allowed" : options.mode === "warn" ? "warned" : "blocked";
    const protocol = PROTOCOLS[target.port];
    report({ operation: "connect", host: name ?? target.host, ...(name !== undefined && { address: target.host }), port: target.port, ...(protocol !== undefined && { protocol }), scope, action });
    if (action === "blocked") {
      // Reported the way a connection that fails is: as the socket's error, after the call has returned.
      const error = new NetworkGuardError(name ?? target.host, target.port);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    // After the call, and before the connection is there: `connect` puts the socket's own methods back to Node's.
    const result = connect.apply(this, args);
    try {
      options.onConnection?.(target, this);
    } catch {
      // As above.
    }
    return result;
  };
  const installed = hooked as typeof prototype.connect;
  installed[INSTALLED] = true;
  prototype.connect = installed;

  /** Whether the look-up of a name is refused: in block mode, when nothing could connect to it anyway. */
  const refusesLookup = (hostname: string): boolean => {
    if (options.mode !== "block" || isIP(hostname) !== 0 || isLocal(hostname) || isListed(hostname, undefined, allow)) {
      return false;
    }
    const key = `${hostname}\n${options.context?.() ?? ""}`;
    if (lastRefusedLookup.key !== key || Date.now() - lastRefusedLookup.at > SAME_LOOKUP_MS) {
      report({ operation: "resolve", host: hostname, scope: "external", action: "blocked" });
    }
    lastRefusedLookup = { key, at: Date.now() };
    return true;
  };
  const remember = (hostname: string, result: unknown): void => {
    for (const address of addressesIn(result)) {
      names.delete(address);
      names.set(address, hostname);
    }
    while (names.size > REMEMBERED_ADDRESSES) {
      names.delete(names.keys().next().value as string);
    }
  };

  const restore: (() => void)[] = [];
  const callbacks = dns as unknown as Record<string, AnyFunction>;
  const promises = dns.promises as unknown as Record<string, AnyFunction>;
  for (const lookup of LOOKUPS) {
    const [original, originalPromise] = [callbacks[lookup] as AnyFunction, promises[lookup] as AnyFunction];
    const promised = function (this: unknown, hostname: unknown, ...rest: unknown[]): Promise<unknown> {
      if (typeof hostname !== "string") {
        return originalPromise.call(this, hostname, ...rest);
      }
      if (refusesLookup(hostname)) {
        return Promise.reject(new NetworkGuardError(hostname));
      }
      return originalPromise.call(this, hostname, ...rest).then((result: unknown) => {
        remember(hostname, result);
        return result;
      });
    };
    const called = function (this: unknown, hostname: unknown, ...rest: unknown[]): unknown {
      const callback = rest.at(-1);
      if (typeof hostname !== "string" || typeof callback !== "function") {
        return original.call(this, hostname, ...rest);
      }
      if (refusesLookup(hostname)) {
        process.nextTick(callback as AnyFunction, new NetworkGuardError(hostname));
        return {};
      }
      rest[rest.length - 1] = (error: unknown, result: unknown, ...more: unknown[]): void => {
        if (error === null || error === undefined) {
          remember(hostname, result);
        }
        (callback as AnyFunction)(error, result, ...more);
      };
      return original.call(this, hostname, ...rest);
    };
    // What Node keeps on the function itself, such as the names `util.promisify(dns.lookup)` gives its results, stays with it.
    for (const symbol of Object.getOwnPropertySymbols(original)) {
      Object.defineProperty(called, symbol, Object.getOwnPropertyDescriptor(original, symbol) as PropertyDescriptor);
    }
    callbacks[lookup] = called;
    promises[lookup] = promised;
    restore.push(() => {
      callbacks[lookup] = original;
      promises[lookup] = originalPromise;
    });
  }
  // So that `import { lookup } from "node:dns"` sees them too.
  syncBuiltinESMExports();

  return () => {
    if (prototype.connect === installed) {
      prototype.connect = connect;
    }
    for (const undo of restore.splice(0)) {
      undo();
    }
    syncBuiltinESMExports();
  };
}
