import { connect } from "node:net";

/*
 * A connection to a running PostgreSQL server, for reading its catalog
 * (D-049). The client is `postgres` (postgres.js), the package's second
 * runtime dependency; it is loaded only here, on first use, so that no
 * other command pays for it.
 *
 * What a connection here may do is narrow on purpose:
 *
 * - Everything runs in one transaction that is `READ ONLY`, which PostgreSQL
 *   itself enforces, and that is rolled back at the end.
 * - Every query has a time limit on the server (`statement_timeout`,
 *   `lock_timeout`) and on the client, which closes the connection when the
 *   server does not answer in time. Connecting has a limit of its own.
 * - The connection string is taken apart here, and the client is given its
 *   parts: the string itself, and the password, are never put into a message,
 *   a report, or a database.
 */

/** Why a connection or a query to PostgreSQL did not succeed. `code` says which way. */
export type PostgresConnectionErrorCode =
  | "invalid-url"
  | "connection-failed"
  | "authentication-failed"
  | "database-not-found"
  | "permission-denied"
  | "tls-not-offered"
  | "timeout"
  | "server-error";

export class PostgresConnectionError extends Error {
  readonly code: PostgresConnectionErrorCode;
  /** PostgreSQL's SQLSTATE, or the system's error code, when there is one. */
  readonly causeCode: string | undefined;

  constructor(code: PostgresConnectionErrorCode, message: string, causeCode?: string) {
    super(message);
    this.name = "PostgresConnectionError";
    this.code = code;
    this.causeCode = causeCode;
  }
}

/** Where a connection goes. Nothing of it is secret: the password is apart. */
export interface PostgresTarget {
  host: string;
  port: number;
  database: string;
  user: string;
  /** `sslmode` as libpq names it; `prefer` when the string does not say. */
  sslMode: "disable" | "prefer" | "require" | "verify-full";
}

export interface PostgresConnectionOptions {
  /** `postgresql://<user>[:<password>]@<host>[:<port>]/<database>[?sslmode=...]`. */
  url: string;
  /** The password, when the string does not hold one (for example from `PGPASSWORD`). */
  password?: string;
  /** How long connecting may take, in milliseconds (default 10 000). */
  connectTimeoutMs?: number;
  /** How long each query may take, in milliseconds (default 30 000). */
  queryTimeoutMs?: number;
  /** The name the server shows for the connection (`application_name`). */
  applicationName?: string;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

const SSL_MODES: Record<string, PostgresTarget["sslMode"]> = {
  disable: "disable",
  prefer: "prefer",
  require: "require",
  "verify-ca": "verify-full",
  "verify-full": "verify-full",
};

const EXAMPLE = "postgresql://reader@127.0.0.1:5432/app";

/**
 * The parts of a connection string. A message about a string that is wrong
 * names what is wrong and never repeats the string, which may hold a password.
 */
export function parseConnectionUrl(url: string): { target: PostgresTarget; password?: string } {
  const invalid = (problem: string): never => {
    throw new PostgresConnectionError("invalid-url", `The connection string ${problem} It must look like ${EXAMPLE}.`);
  };
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    invalid("is not a postgresql:// URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid("cannot be read as a URL.");
  }
  const decode = (text: string, what: string): string => {
    try {
      return decodeURIComponent(text);
    } catch {
      return invalid(`has a ${what} that is not properly percent-encoded.`);
    }
  };
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host === "") {
    invalid("names no host.");
  }
  if (host.includes(",")) {
    invalid("names several hosts; give one.");
  }
  const port = parsed.port === "" ? 5432 : Number(parsed.port);
  const user = decode(parsed.username, "user name");
  if (user === "") {
    invalid("names no user.");
  }
  const database = decode(parsed.pathname.replace(/^\//, ""), "database name");
  if (database === "" || database.includes("/")) {
    invalid("names no database (the path after the host).");
  }
  let sslMode: PostgresTarget["sslMode"] = "prefer";
  for (const [name, value] of parsed.searchParams) {
    if (name !== "sslmode") {
      invalid(`has the parameter "${name}", which is not supported here; only sslmode is.`);
    }
    const mode = SSL_MODES[value];
    if (mode === undefined) {
      invalid(`has an sslmode that is not one of ${Object.keys(SSL_MODES).join(", ")}.`);
    }
    sslMode = mode as PostgresTarget["sslMode"];
  }
  const password = parsed.password === "" ? undefined : decode(parsed.password, "password");
  return { target: { host, port, database, user, sslMode }, ...(password !== undefined && { password }) };
}

/** A target as messages show it: never with a password. */
export function describeTarget(target: PostgresTarget): string {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${host}:${target.port} (database "${target.database}", user "${target.user}")`;
}

/** A row of a result, as the client gives it: column names to values. */
export type CatalogRow = Record<string, unknown>;

/** Runs one query of the catalog, with parameters as text. */
export type CatalogQuery = (text: string, parameters?: string[]) => Promise<CatalogRow[]>;

interface SqlClient {
  unsafe(query: string, parameters?: unknown[]): Promise<CatalogRow[]>;
  end(options?: { timeout?: number }): Promise<void>;
}

type PostgresFactory = (options: Record<string, unknown>) => SqlClient;

let loading: Promise<PostgresFactory> | undefined;

/** The client, loaded once. */
function loadClient(): Promise<PostgresFactory> {
  loading ??= (async () => {
    const module = (await import("postgres")) as unknown as { default: PostgresFactory };
    return module.default;
  })();
  return loading;
}

const SYSTEM_ERRORS: Record<string, string> = {
  ECONNREFUSED: "the connection was refused (is PostgreSQL running there, on that port?)",
  ENOTFOUND: "the host name was not found",
  EAI_AGAIN: "the host name could not be looked up",
  EHOSTUNREACH: "the host cannot be reached",
  ENETUNREACH: "the network cannot be reached",
  ECONNRESET: "the server closed the connection",
  ETIMEDOUT: "the connection timed out",
};

/**
 * Turns what the client threw into an error that says what happened, in
 * words of this tool. Only PostgreSQL's own message, a system error code, or
 * the client's error code is taken over, and any text that holds the password
 * is cut out of it.
 */
function explain(error: unknown, target: PostgresTarget, secrets: readonly string[], stage: "connect" | "query"): PostgresConnectionError {
  const where = describeTarget(target);
  const record = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : undefined;
  const redact = (text: string): string => secrets.filter((secret) => secret !== "").reduce((result, secret) => result.split(secret).join("***"), text);
  const serverMessage = typeof record.message === "string" ? redact(record.message) : String(error);
  if (record.name === "PostgresError" && code !== undefined) {
    if (code === "28P01" || code === "28000") {
      return new PostgresConnectionError("authentication-failed", `PostgreSQL at ${where} refused the login: ${serverMessage}.`, code);
    }
    if (code === "3D000") {
      return new PostgresConnectionError("database-not-found", `PostgreSQL at ${where}: ${serverMessage}.`, code);
    }
    if (code === "42501") {
      return new PostgresConnectionError(
        "permission-denied",
        `The user "${target.user}" may not read what the scan needs at ${where}: ${serverMessage}. The scan reads the system catalog (pg_catalog) only; a read-only role with CONNECT on the database is enough where the catalog has not been restricted.`,
        code,
      );
    }
    if (code === "57014" || code === "55P03") {
      return new PostgresConnectionError("timeout", `A query to PostgreSQL at ${where} took longer than allowed and was cancelled by the server: ${serverMessage}.`, code);
    }
    return new PostgresConnectionError("server-error", `PostgreSQL at ${where} answered with an error: ${serverMessage} (SQLSTATE ${code}).`, code);
  }
  if (code === "CONNECT_TIMEOUT") {
    return new PostgresConnectionError("timeout", `Could not connect to PostgreSQL at ${where}: no answer within the connect timeout.`, code);
  }
  if (code !== undefined && SYSTEM_ERRORS[code] !== undefined) {
    return new PostgresConnectionError("connection-failed", `Could not connect to PostgreSQL at ${where}: ${SYSTEM_ERRORS[code]}.`, code);
  }
  if (code !== undefined && /^SASL_|^AUTH_TYPE_NOT_IMPLEMENTED$|^MESSAGE_NOT_SUPPORTED$/.test(code)) {
    return new PostgresConnectionError("authentication-failed", `Could not log in to PostgreSQL at ${where}: ${redact(serverMessage)}.`, code);
  }
  const what = stage === "connect" ? `Could not connect to PostgreSQL at ${where}` : `The connection to PostgreSQL at ${where} failed`;
  return new PostgresConnectionError("connection-failed", `${what}: ${serverMessage}${code === undefined ? "" : ` (${code})`}.`, code);
}

class QueryTimeout extends Error {}

/** PostgreSQL's SSLRequest: the length, 8, and the request code 80877103. */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

/**
 * Whether the server offers TLS, as it answers PostgreSQL's request for it
 * ('S' or 'N'); `undefined` when it gives no such answer in time. Nothing
 * else is sent: the connection is closed after the one byte.
 */
function offersTls(target: PostgresTarget, timeoutMs: number): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const socket = connect({ host: target.host, port: target.port });
    const done = (answer: boolean | undefined): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    socket.once("connect", () => socket.write(SSL_REQUEST));
    socket.once("data", (chunk: Buffer) => done(chunk[0] === 0x53 ? true : chunk[0] === 0x4e ? false : undefined));
    socket.once("error", () => done(undefined));
    socket.once("close", () => done(undefined));
  });
}

/**
 * Connects, opens a read-only transaction, and runs `read` with a function
 * that queries in it. The transaction is rolled back and the connection
 * closed afterwards, whatever happened.
 */
export async function withReadOnlyCatalog<T>(options: PostgresConnectionOptions, read: (query: CatalogQuery, target: PostgresTarget) => Promise<T>): Promise<T> {
  const { target, password: inUrl } = parseConnectionUrl(options.url);
  const password = inUrl ?? options.password;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const secrets = [options.url, ...(password === undefined ? [] : [password, encodeURIComponent(password)])];
  const factory = await loadClient();
  const sql = factory({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    // Given even when empty, so that the client does not look for one elsewhere on its own.
    pass: password ?? "",
    ssl: target.sslMode === "disable" ? false : target.sslMode,
    max: 1,
    connect_timeout: connectTimeoutMs / 1000,
    idle_timeout: 0,
    max_lifetime: null,
    // Unnamed statements: no state is left on the server, and poolers in transaction mode take them.
    prepare: false,
    // The client would otherwise ask the server for its array types when it connects: only the queries below are sent.
    fetch_types: false,
    onnotice: () => {},
    connection: { application_name: options.applicationName ?? "local-db-sandbox" },
  });
  let connected = false;
  let timedOut = false;
  const run = async (text: string, parameters: string[] = []): Promise<CatalogRow[]> => {
    const limit = connected ? queryTimeoutMs : connectTimeoutMs + queryTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const pending = sql.unsafe(text, parameters);
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new QueryTimeout());
        // The server did not answer: the connection is closed under the query, which then fails too.
        void sql.end({ timeout: 0 }).catch(() => {});
      }, limit);
    });
    pending.catch(() => {});
    try {
      const rows = await Promise.race([pending, expired]);
      connected = true;
      return [...rows];
    } catch (error) {
      const failure =
        error instanceof QueryTimeout || timedOut
          ? new PostgresConnectionError(
              "timeout",
              connected
                ? `A query to PostgreSQL at ${describeTarget(target)} did not finish within ${queryTimeoutMs / 1000} s; the connection was closed.`
                : `PostgreSQL at ${describeTarget(target)} did not answer within ${(connectTimeoutMs + queryTimeoutMs) / 1000} s; the connection was closed.`,
            )
          : explain(error, target, secrets, connected ? "query" : "connect");
      // A connection that requires TLS and failed before it was made: the server may have said that it has none,
      // which the client does not report. Asked once more, the answer is plain.
      if (!connected && (target.sslMode === "require" || target.sslMode === "verify-full") && (failure.code === "connection-failed" || failure.code === "timeout")) {
        // The attempt that failed is closed first: a server may serve one connection at a time.
        await sql.end({ timeout: 0 }).catch(() => {});
        if ((await offersTls(target, Math.min(connectTimeoutMs, 5_000))) === false) {
          throw new PostgresConnectionError(
            "tls-not-offered",
            `PostgreSQL at ${describeTarget(target)} does not offer TLS (it answered the request for it with no), and sslmode=${target.sslMode} requires it. Connect to a server that has TLS, or use sslmode=prefer or sslmode=disable for a server on this machine.`,
          );
        }
      }
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  };
  let begun = false;
  try {
    await run("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    begun = true;
    // In this transaction alone: the server stops a statement, or a wait for a lock, that runs over the limit.
    await run("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [String(queryTimeoutMs)]);
    return await read((text, parameters) => run(text, parameters), target);
  } finally {
    // Rolled back whatever happened, so that nothing of the transaction outlives it, also where the connection is
    // handed on by a pooler. A server that stopped answering is not asked again: its connection is closed already.
    if (begun && !timedOut) {
      await run("ROLLBACK").catch(() => {});
    }
    await sql.end({ timeout: timedOut ? 0 : 1 }).catch(() => {});
  }
}
