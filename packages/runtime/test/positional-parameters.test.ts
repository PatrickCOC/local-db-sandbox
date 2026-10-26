import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewritePositionalParameters } from "../src/positional-parameters.ts";

const rewritten = (sql: string): string => rewritePositionalParameters(sql).sql;

describe("rewritePositionalParameters", () => {
  it("writes $N as SQLite's ?N, keeping the number", () => {
    assert.deepEqual(rewritePositionalParameters('SELECT * FROM "t" WHERE "a" = $1'), { sql: 'SELECT * FROM "t" WHERE "a" = ?1', numbers: [1], questionMarks: false });
    assert.deepEqual(rewritePositionalParameters("SELECT $2, $1, $2, $10"), { sql: "SELECT ?2, ?1, ?2, ?10", numbers: [1, 2, 10], questionMarks: false });
    assert.equal(rewritten("WHERE a=$1 AND b IN($2,$3)\nLIMIT $4"), "WHERE a=?1 AND b IN(?2,?3)\nLIMIT ?4");
    // What follows a placeholder is not translated: the cast is left for SQLite to refuse.
    assert.equal(rewritten("SELECT $1::int"), "SELECT ?1::int");
  });

  it("returns statements without $N exactly as they are", () => {
    for (const sql of [
      'SELECT "author"."id" AS "author_id" FROM "authors" "author" WHERE "author"."name" = ? LIMIT 1',
      'INSERT INTO "users"("name", "active") VALUES (?, ?)',
      "SELECT ?1, ?2",
      "SELECT :name, @name, $name",
      "BEGIN TRANSACTION",
      "",
    ]) {
      const result = rewritePositionalParameters(sql);
      assert.equal(result.sql, sql);
      assert.deepEqual(result.numbers, []);
    }
  });

  it("leaves $N alone inside string literals, quoted identifiers, and comments", () => {
    for (const sql of [
      "SELECT 'costs $1' AS text",
      "SELECT 'it''s $1 and ''$2''' AS text",
      'SELECT "price$1", "a ""$2"" b" FROM t',
      "SELECT `$1`, [$2] FROM t",
      "SELECT 1 -- not $1\n",
      "SELECT 1 -- not $1",
      "SELECT /* not $1\n nor $2 */ 1",
      "SELECT /* unfinished $1",
      "SELECT 'unfinished $1",
    ]) {
      assert.deepEqual(rewritePositionalParameters(sql), { sql, numbers: [], questionMarks: false }, sql);
    }
    assert.deepEqual(rewritePositionalParameters("SELECT '$1', \"$2\", $3 -- $4\n, $5 /* $6 */"), {
      sql: "SELECT '$1', \"$2\", ?3 -- $4\n, ?5 /* $6 */",
      numbers: [3, 5],
      questionMarks: false,
    });
    // A quote inside a comment does not open a string, and a comment marker inside a string does not open a comment.
    assert.equal(rewritten("SELECT $1 -- don't\n, $2"), "SELECT ?1 -- don't\n, ?2");
    assert.equal(rewritten("SELECT '--', $1, '/*', $2"), "SELECT '--', ?1, '/*', ?2");
  });

  it("leaves $N alone when it is part of a longer name", () => {
    for (const sql of ["SELECT a$1 FROM t", "SELECT $1abc", "SELECT $1$2", "SELECT $name1", "SELECT :p$1, @p$1", "SELECT 1$1", "SELECT $", "SELECT $$ $1 $$"]) {
      const result = rewritePositionalParameters(sql);
      // The last one is a PostgreSQL dollar-quoted string, which SQLite does not have: only the bare $1 inside is seen.
      assert.equal(result.sql, sql === "SELECT $$ $1 $$" ? "SELECT $$ ?1 $$" : sql, sql);
    }
  });

  it("reports $0, and ? placeholders next to $N, for the caller to refuse", () => {
    assert.deepEqual(rewritePositionalParameters("SELECT $0, $2").numbers, [0, 2]);
    assert.equal(rewritePositionalParameters("SELECT $1, ?").questionMarks, true);
    assert.equal(rewritePositionalParameters("SELECT ?2, $1").questionMarks, true);
    assert.equal(rewritePositionalParameters("SELECT $1, '?' -- ?").questionMarks, false);
  });
});
