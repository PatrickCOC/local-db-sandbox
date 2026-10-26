import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkSqlStatements } from "../src/sql-check.ts";

/*
 * What PostgreSQL's own parser says of SQL that was written for it (D-039):
 * every statement is one statement, and every expression that was copied
 * into one from a schema is one expression. A text that is more than that
 * would end the place it was written into, and make another statement of
 * what follows.
 */

const check = async (sql: string, expressions?: string[]): Promise<{ kind?: string; problem?: string }> => (await checkSqlStatements([{ sql, ...(expressions !== undefined && { expressions }) }]))[0] as { kind?: string; problem?: string };

describe("checking generated SQL with PostgreSQL's parser", () => {
  test("a statement is told by what PostgreSQL parses it as", async () => {
    assert.deepEqual(
      await checkSqlStatements([{ sql: 'CREATE TABLE "t" ("id" integer NOT NULL)' }, { sql: 'ALTER TABLE "t" ADD COLUMN "note" text' }, { sql: 'ALTER TABLE "t" RENAME TO "u"' }, { sql: "ALTER TYPE \"mood\" ADD VALUE 'ok'" }, { sql: 'DROP INDEX "i"' }]),
      [{ kind: "CreateStmt" }, { kind: "AlterTableStmt" }, { kind: "RenameStmt" }, { kind: "AlterEnumStmt" }, { kind: "DropStmt" }],
    );
    assert.deepEqual(await checkSqlStatements([]), []);
  });

  test("what PostgreSQL cannot parse is a problem, with what it says", async () => {
    const { kind, problem } = await check('ALTER TABLE "t" ADD COLUMN');
    assert.equal(kind, undefined);
    assert.match(problem ?? "", /^PostgreSQL cannot parse it: syntax error at end of input/);
  });

  test("a text that is two statements, or none, is a problem", async () => {
    assert.match((await check('DROP TABLE "a"; DROP TABLE "b"')).problem ?? "", /^It is 2 statements to PostgreSQL, not one\.$/);
    assert.match((await check("-- nothing")).problem ?? "", /^It is no statement to PostgreSQL\.$/);
    // One statement with a semicolon after it is one statement.
    assert.deepEqual(await check('DROP TABLE "a";'), { kind: "DropStmt" });
  });

  test("an expression that was copied in is one expression", async () => {
    assert.deepEqual(await check('ALTER TABLE "t" ADD CONSTRAINT "c" CHECK ((a > 0) and (b <> \'x)\'))', ["(a > 0) and (b <> 'x)')"]), { kind: "AlterTableStmt" });
    assert.deepEqual(await check('CREATE INDEX "i" ON "t" ((lower(a))) WHERE (b > 0)', ["lower(a)", "b > 0"]), { kind: "IndexStmt" });
    assert.deepEqual(await check('ALTER TABLE "t" ALTER COLUMN "c" SET DEFAULT (now())', ["now()"]), { kind: "AlterTableStmt" });
    // A row of values and a query in parentheses are expressions too.
    assert.deepEqual(await check("SELECT 1", ["(a, b) in ((1, 2))", "select max(id) from t"]), { kind: "SelectStmt" });
  });

  test("a text that ends its parentheses, and goes on, is not one expression", async () => {
    const problem = async (expression: string): Promise<string> => (await check("SELECT 1", [expression])).problem ?? "";
    const notOne = (expression: string): RegExp => new RegExp(`^The expression ${JSON.stringify(expression).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not one expression to PostgreSQL`);
    for (const expression of [
      'true), ADD COLUMN "x" integer, ADD CHECK (true',
      "true); DROP TABLE users; --",
      "1) FROM secrets WHERE (true",
      "1), (2",
      '1) AS "x" --',
      "1) UNION SELECT (2",
      "1) INTO stolen FROM (SELECT 1",
      "a > 0 -- and nothing closes it",
      "a > 0 /* nor this",
      "'a",
      "",
      "   ",
      "1 2",
    ]) {
      assert.match(await problem(expression), notOne(expression), expression);
    }
  });

  test("every statement of a list is checked, and a problem says nothing of the others", async () => {
    const checks = await checkSqlStatements([{ sql: 'DROP TABLE "a"' }, { sql: "DROP TABLE" }, { sql: 'DROP TABLE "c"', expressions: ["1) + (2", "1, 2"] }]);
    assert.deepEqual(checks[0], { kind: "DropStmt" });
    assert.match(checks[1]?.problem ?? "", /^PostgreSQL cannot parse it/);
    // Two that are each one expression: a sum, and a row of two values.
    assert.deepEqual(checks[2], { kind: "DropStmt" });
  });
});
