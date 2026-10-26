import assert from "node:assert/strict";
import { it } from "node:test";
import { typeormValuesSuite } from "./support/typeorm-values-suite.ts";

/*
 * Regression test for a failure seen in a real application on TypeORM 0.3.17
 * and PostgreSQL, when a user logged in:
 *
 *   QueryFailedError: TypeError: Provided value cannot be bound to SQLite parameter 3.
 *   INSERT INTO "auth_token"(...) VALUES (..., ?, ?, ?, ?, ?, ?, ?, ?)
 *   parameter 3: { "name": "Windows", "version": "10" }
 *
 * The entity declares `os`, `engine`, `device`, `browser`, and `location` as
 * `varchar(250)`, and the application saves the objects of a parsed user
 * agent to them. TypeORM does not convert a value for a text column. In
 * production the node-postgres driver sends an object bound to a parameter
 * as its JSON text, so the row is written, and read back as a string. On the
 * sandbox the object reached SQLite, which cannot bind one.
 *
 * This runs the suite against the real 0.3.17 package (installed under the
 * name `typeorm-0.3.17`, for development only), so that every value goes
 * through that version's own persistence and hydration code.
 */
const version = await typeormValuesSuite("typeorm-0.3.17");

it("ran against TypeORM 0.3.17 itself", () => {
  // If the `typeorm-0.3.17` package resolved to a later version, the suite above would not cover the version of the regression.
  assert.equal(version, "0.3.17");
});
