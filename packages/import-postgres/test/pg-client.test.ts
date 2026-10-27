import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PostgresConnectionError, describeTarget, parseConnectionUrl } from "../src/index.ts";
import { withReadOnlyCatalog } from "../src/pg-client.ts";
import { closedPort, startDisposablePostgres, startProxy, startRefusingServer } from "./support/disposable-postgres.ts";
import type { DisposablePostgres } from "./support/disposable-postgres.ts";

/*
 * The connection that init-pg reads a server's catalog through (D-049): how a
 * connection string is taken apart, what it may do once connected, and what
 * it says when it cannot connect or a query does not finish. The servers are
 * PGlite, served on a port of 127.0.0.1 (support/disposable-postgres.ts), and
 * small servers of the test's own that refuse a login or stop answering.
 */

const PASSWORD = "Pa55-w0rd!secret";

/** What a call rejected with, asserted to be a connection error that never holds the password or the connection string. */
async function refused(call: Promise<unknown>, url: string): Promise<PostgresConnectionError> {
  const error = await call.then(
    () => assert.fail("expected the call to fail"),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof PostgresConnectionError, String(error));
  for (const secret of [PASSWORD, encodeURIComponent(PASSWORD), url]) {
    assert.equal(error.message.includes(secret), false, error.message);
  }
  return error;
}

describe("PostgreSQL connection strings", () => {
  it("are taken apart into what a message may show and the password, which it may not", () => {
    assert.deepEqual(parseConnectionUrl(`postgresql://reader:${encodeURIComponent(PASSWORD)}@db.example.test:6543/app_dev?sslmode=require`), {
      target: { host: "db.example.test", port: 6543, database: "app_dev", user: "reader", sslMode: "require" },
      password: PASSWORD,
    });
    assert.deepEqual(parseConnectionUrl("postgres://reader@127.0.0.1/app"), { target: { host: "127.0.0.1", port: 5432, database: "app", user: "reader", sslMode: "prefer" } });
    assert.deepEqual(parseConnectionUrl("postgresql://us%20er@[::1]:5433/my%20db?sslmode=verify-ca").target, { host: "::1", port: 5433, database: "my db", user: "us er", sslMode: "verify-full" });
    assert.equal(describeTarget(parseConnectionUrl("postgresql://reader@[::1]:5433/app").target), '[::1]:5433 (database "app", user "reader")');
    assert.equal(describeTarget(parseConnectionUrl(`postgresql://reader:${PASSWORD}@127.0.0.1/app`).target).includes(PASSWORD), false);
  });

  it("that are wrong are refused with what is wrong, without being repeated", () => {
    const cases: [string, RegExp][] = [
      [`mysql://reader:${PASSWORD}@127.0.0.1/app`, /is not a postgresql:\/\/ URL/],
      [`postgresql://reader:${PASSWORD}@/app`, /cannot be read as a URL/],
      [`postgresql://:${PASSWORD}@127.0.0.1/app`, /names no user/],
      [`postgresql://reader:${PASSWORD}@127.0.0.1`, /names no database/],
      [`postgresql://reader:${PASSWORD}@127.0.0.1/app/more`, /names no database/],
      [`postgresql://reader:${PASSWORD}@127.0.0.1/app?options=-c%20x%3D1`, /the parameter "options", which is not supported here; only sslmode is/],
      [`postgresql://reader:${PASSWORD}@127.0.0.1/app?sslmode=sometimes`, /an sslmode that is not one of disable, prefer, require, verify-ca, verify-full/],
      [`postgresql://reader:%E0%A4%A@127.0.0.1/app`, /a password that is not properly percent-encoded/],
      [`postgresql://reader:${PASSWORD}@127.0.0.1:99999/app`, /cannot be read as a URL/],
    ];
    for (const [url, message] of cases) {
      assert.throws(
        () => parseConnectionUrl(url),
        (error: unknown) => {
          assert.ok(error instanceof PostgresConnectionError);
          assert.equal(error.code, "invalid-url");
          assert.match(error.message, message, url);
          assert.match(error.message, /It must look like postgresql:\/\/reader@127\.0\.0\.1:5432\/app\.$/);
          assert.equal(error.message.includes(PASSWORD), false, url);
          assert.equal(error.message.includes(url), false, url);
          return true;
        },
      );
    }
  });
});

describe("PostgreSQL connections", { timeout: 120_000 }, () => {
  let server: DisposablePostgres;

  before(async () => {
    server = await startDisposablePostgres("create table notes (id integer primary key, body text); insert into notes values (1, 'kept');");
  });
  after(async () => {
    await server.stop();
  });

  const urlOf = (port: number): string => `postgresql://postgres:${encodeURIComponent(PASSWORD)}@127.0.0.1:${port}/postgres?sslmode=disable`;

  it("read in one read-only transaction, which PostgreSQL itself keeps from writing, and which is rolled back", async () => {
    const proxy = await startProxy(server.port);
    try {
      const url = urlOf(proxy.port);
      const seen = await withReadOnlyCatalog({ url }, async (query, target) => {
        assert.deepEqual(target, { host: "127.0.0.1", port: proxy.port, database: "postgres", user: "postgres", sslMode: "disable" });
        const [settings] = await query("SELECT current_setting('transaction_read_only') AS read_only, current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout");
        return settings;
      });
      assert.deepEqual(seen, { read_only: "on", statement_timeout: "30s", lock_timeout: "30s" });
      assert.deepEqual(proxy.queries.slice(0, 2), ["BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)"]);
      assert.equal(proxy.queries.at(-1), "ROLLBACK");

      // Whatever is asked: a statement that would write is refused by the server, and the transaction is rolled back.
      for (const statement of ["CREATE TABLE intruder (id integer)", "INSERT INTO notes VALUES (2, 'x')", "UPDATE notes SET body = 'changed'", "DROP TABLE notes"]) {
        const error = await refused(
          withReadOnlyCatalog({ url }, (query) => query(statement)),
          url,
        );
        assert.deepEqual([error.code, error.causeCode], ["server-error", "25006"], statement);
        assert.match(error.message, /cannot execute .* in a read-only transaction \(SQLSTATE 25006\)\.$/);
      }
      // Each of the five transactions ended in a rollback, the failed ones too.
      assert.equal(proxy.queries.filter((text) => text === "ROLLBACK").length, 5);
      assert.equal(proxy.queries.filter((text) => text.startsWith("BEGIN")).length, 5);
    } finally {
      await proxy.stop();
    }
    assert.deepEqual((await server.db.query("SELECT id, body FROM notes")).rows, [{ id: 1, body: "kept" }]);
    assert.deepEqual((await server.db.query("SELECT count(*)::int AS count FROM pg_class WHERE relname = 'intruder'")).rows, [{ count: 0 }]);
  });

  it("takes the password apart from the string, and connects with SSL when the server has it, without it when not", async () => {
    // PGlite has no SSL, and answers an SSL request with no: "prefer", the default, goes on without it.
    const url = `postgresql://postgres@127.0.0.1:${server.port}/postgres`;
    assert.deepEqual(await withReadOnlyCatalog({ url, password: PASSWORD }, async (query) => (await query("SELECT 1 AS one"))[0]), { one: 1 });
  });

  it("says that a server has no TLS when sslmode requires it, and never goes on without it", async () => {
    // A server that answers the request for TLS with no, as PostgreSQL without TLS does. It then says nothing more, as
    // PGlite does; PostgreSQL itself closes the connection at once (checked on PostgreSQL 18.6, D-049).
    const plain = await startRefusingServer({ code: "28P01", message: "never reached" });
    try {
      for (const mode of ["require", "verify-full"]) {
        const url = `postgresql://postgres@127.0.0.1:${plain.port}/postgres?sslmode=${mode}`;
        const error = await refused(withReadOnlyCatalog({ url, password: PASSWORD, connectTimeoutMs: 300, queryTimeoutMs: 300 }, (query) => query("SELECT 1")), url);
        assert.equal(
          error.message,
          `PostgreSQL at 127.0.0.1:${plain.port} (database "postgres", user "postgres") does not offer TLS (it answered the request for it with no), and sslmode=${mode} requires it. Connect to a server that has TLS, or use sslmode=prefer or sslmode=disable for a server on this machine.`,
        );
        assert.equal(error.code, "tls-not-offered");
      }
      assert.deepEqual(plain.passwords, []);
    } finally {
      await plain.stop();
    }
  });

  it("does not take a server that closes the connection for one without TLS", async () => {
    // A connection refused, with sslmode=require: there is no answer to the request for TLS, so the failure is said as it is.
    const port = await closedPort();
    const url = `${urlOf(port).replace("?sslmode=disable", "")}?sslmode=require`;
    const error = await refused(withReadOnlyCatalog({ url }, (query) => query("SELECT 1")), url);
    assert.deepEqual([error.code, error.causeCode], ["connection-failed", "ECONNREFUSED"]);
  });

  it("says that a connection was refused, where to, and that nothing listens there", async () => {
    const port = await closedPort();
    const url = urlOf(port);
    const error = await refused(withReadOnlyCatalog({ url }, (query) => query("SELECT 1")), url);
    assert.deepEqual([error.code, error.causeCode], ["connection-failed", "ECONNREFUSED"]);
    assert.equal(error.message, `Could not connect to PostgreSQL at 127.0.0.1:${port} (database "postgres", user "postgres"): the connection was refused (is PostgreSQL running there, on that port?).`);
  });

  it("says that a login was refused, with PostgreSQL's own words, and the password is sent and never shown", async () => {
    const refusing = await startRefusingServer({ code: "28P01", message: 'password authentication failed for user "postgres"' }, { askPassword: true });
    try {
      const url = `postgresql://postgres@127.0.0.1:${refusing.port}/postgres?sslmode=disable`;
      const error = await refused(withReadOnlyCatalog({ url, password: PASSWORD }, (query) => query("SELECT 1")), url);
      assert.deepEqual([error.code, error.causeCode], ["authentication-failed", "28P01"]);
      assert.equal(error.message, `PostgreSQL at 127.0.0.1:${refusing.port} (database "postgres", user "postgres") refused the login: password authentication failed for user "postgres".`);
      // The password went to the server, which is where it belongs, and nowhere else.
      assert.deepEqual(refusing.passwords, [PASSWORD]);
    } finally {
      await refusing.stop();
    }
  });

  it("says that a database is not there, or that the role may not connect", async () => {
    for (const [code, message, kind] of [
      ["3D000", 'database "nope" does not exist', "database-not-found"],
      ["42501", 'permission denied for database "postgres"', "permission-denied"],
    ] as const) {
      const refusing = await startRefusingServer({ code, message });
      try {
        const url = urlOf(refusing.port);
        const error = await refused(withReadOnlyCatalog({ url }, (query) => query("SELECT 1")), url);
        assert.deepEqual([error.code, error.causeCode], [kind, code]);
        assert.ok(error.message.includes(message), error.message);
      } finally {
        await refusing.stop();
      }
    }
  });

  it("gives up on a server that accepts the connection and never answers, after the connect timeout", async () => {
    const silent = await startProxy(server.port, { answered: -1 });
    try {
      const url = urlOf(silent.port);
      const started = Date.now();
      const error = await refused(withReadOnlyCatalog({ url, connectTimeoutMs: 300, queryTimeoutMs: 300 }, (query) => query("SELECT 1")), url);
      assert.equal(error.code, "timeout");
      assert.match(error.message, /^(Could not connect to PostgreSQL at 127\.0\.0\.1:\d+ \(database "postgres", user "postgres"\): no answer within the connect timeout\.|PostgreSQL at .* did not answer within 0\.6 s; the connection was closed\.)$/);
      assert.ok(Date.now() - started < 5_000);
    } finally {
      await silent.stop();
    }
  });

  it("gives up on a query that does not finish, closes the connection, and says how long it waited", async () => {
    // The login, the transaction, and the time limits pass; the first query of the catalog is never answered.
    const stalling = await startProxy(server.port, { answered: 2 });
    try {
      const url = urlOf(stalling.port);
      const started = Date.now();
      const error = await refused(withReadOnlyCatalog({ url, queryTimeoutMs: 400 }, (query) => query("SELECT 1")), url);
      assert.equal(error.code, "timeout");
      assert.equal(error.message, `A query to PostgreSQL at 127.0.0.1:${stalling.port} (database "postgres", user "postgres") did not finish within 0.4 s; the connection was closed.`);
      assert.ok(Date.now() - started < 5_000);
      assert.equal(stalling.queries[2], "SELECT 1");
    } finally {
      await stalling.stop();
    }
  });
});
