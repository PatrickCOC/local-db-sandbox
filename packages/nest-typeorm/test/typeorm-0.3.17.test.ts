import assert from "node:assert/strict";
import { it } from "node:test";
import { typeormRuntimeSuite } from "./support/typeorm-runtime-suite.ts";

/*
 * Regression test for a failure seen in a real application on TypeORM 0.3.17:
 *
 *   TypeError: Class constructor SandboxSqliteConnection cannot be invoked without 'new'
 *       at BetterSqlite3Driver.createDatabaseConnection (typeorm/driver/better-sqlite3/BetterSqlite3Driver.js:88)
 *       at BetterSqlite3Driver.connect (typeorm/driver/sqlite-abstract/AbstractSqliteDriver.js:171)
 *       at DataSource.initialize (typeorm/data-source/DataSource.js:133)
 *
 * TypeORM 0.3.0 to 0.3.27 create the better-sqlite3 connection by calling the
 * value of the `driver` option as a plain function, `this.sqlite(database,
 * options)`, the way the `better-sqlite3` module export allows; 0.3.28 and
 * later use `new`. The repository's own TypeORM is a later version, so only
 * the `new` style was exercised before.
 *
 * This runs the whole TypeORM-on-runtime suite against the real 0.3.17
 * package (installed under the name `typeorm-0.3.17`, for development only),
 * so that initialization goes through that version's own driver code,
 * followed by its query runner, transactions, and QueryBuilder.
 */
const version = await typeormRuntimeSuite("typeorm-0.3.17");

it("ran against TypeORM 0.3.17 itself, which calls the driver without new", () => {
  // If the `typeorm-0.3.17` package resolved to a later version, the suite above would no longer cover the plain call.
  assert.equal(version, "0.3.17");
});
