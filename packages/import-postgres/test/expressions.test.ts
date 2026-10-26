import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collect, column, table } from "./support.ts";

/*
 * An expression that the collector keeps as text (a check, a default, an
 * index expression or condition) is the whole expression as the migration
 * wrote it. Parentheses around all of it say nothing and are left out, so
 * `((a > 0))` and `a > 0` are one text; parentheses around its start are
 * part of it. A migration generator writes these texts back into SQL (D-039),
 * so a text that is cut short is a wrong constraint there.
 */

describe("expressions kept as text", () => {
  test("a check that starts with a parenthesis is kept whole", async () => {
    const result = await collect({
      "001.sql": `
        create table t (
          a int,
          b int,
          constraint c1 check ((a > 0) and (b > 0)),
          constraint c2 check (a > 0 and (b > 0)),
          constraint c3 check (((a + b)) > 0),
          constraint c4 check ((a, b) in ((1, 2), (3, 4))),
          constraint c5 check ((a) > (b))
        );`,
    });
    assert.deepEqual(
      table(result, "t").checks?.map((check) => [check.name, check.expression]),
      [
        ["c1", "(a > 0) and (b > 0)"],
        ["c2", "a > 0 and (b > 0)"],
        ["c3", "((a + b)) > 0"],
        ["c4", "(a, b) in ((1, 2), (3, 4))"],
        ["c5", "(a) > (b)"],
      ],
    );
  });

  test("parentheses around the whole of an expression are not part of its text", async () => {
    const result = await collect({
      "001.sql": `
        create table t (a int, b int, constraint c1 check (((a > 0))), constraint c2 check (a > 0));
        create index i1 on t ((a + b));
        create index i2 on t (((a + b)));
        create index i3 on t (a) where ((b > 0));
        create index i4 on t (a) where b > 0;`,
    });
    const t = table(result, "t");
    assert.deepEqual(t.checks?.map((check) => check.expression), ["a > 0", "a > 0"]);
    assert.deepEqual(t.indexes?.map((index) => [index.name, index.expressions ?? [], index.where ?? null]), [
      ["i1", ["a + b"], null],
      ["i2", ["a + b"], null],
      ["i3", [], "b > 0"],
      ["i4", [], "b > 0"],
    ]);
  });

  test("an index expression and a condition that start with a parenthesis", async () => {
    const result = await collect({
      "001.sql": `
        create table t (a text, b int);
        create index i1 on t (((b + 1) * 2), lower(a));
        create index i2 on t (b) where (b > 0) and (b < 9);
        create index i3 on t (b) where ((b > 0) and (b < 9));`,
    });
    assert.deepEqual(table(result, "t").indexes?.map((index) => [index.name, index.expressions ?? [], index.where ?? null]), [
      ["i1", ["(b + 1) * 2", "lower(a)"], null],
      ["i2", [], "(b > 0) and (b < 9)"],
      ["i3", [], "(b > 0) and (b < 9)"],
    ]);
  });

  test("an index's elements are told apart, whichever of them starts with a parenthesis", async () => {
    const result = await collect({
      "001.sql": `
        create table t (a text, b int);
        create index i1 on t (lower(a), b);
        create index i2 on t (b, (b + 1), ((b) * 2));
        create index i3 on t (((b)), a);
        create index i4 on t ((b + 1), (lower(a)));`,
    });
    assert.deepEqual(table(result, "t").indexes?.map((index) => [index.name, index.columns, index.expressions ?? []]), [
      ["i1", ["b"], ["lower(a)"]],
      ["i2", ["b"], ["b + 1", "(b) * 2"]],
      ["i3", ["a"], ["b"]],
      ["i4", [], ["b + 1", "lower(a)"]],
    ]);
  });

  test("an index's last element ends where the list of elements ends, whatever follows the list", async () => {
    const result = await collect({
      "001.sql": `
        create table t (a text, b int);
        create index i1 on t (lower(a)) where b > 0;
        create index i2 on t ((lower(a))) where (b > 0);
        create index i3 on t (((b) + 1)) include (a) where b > 0;
        create index i4 on t (b, (lower(a))) with (fillfactor = 70) where (b > 0) and (b < 9);`,
    });
    assert.deepEqual(table(result, "t").indexes?.map((index) => [index.name, index.expressions ?? [], index.where]), [
      ["i1", ["lower(a)"], "b > 0"],
      ["i2", ["lower(a)"], "b > 0"],
      ["i3", ["(b) + 1"], "b > 0"],
      ["i4", ["lower(a)"], "(b > 0) and (b < 9)"],
    ]);
  });

  test("a default in parentheses, and one that starts with them", async () => {
    const result = await collect({
      "001.sql": `
        create table t (
          a int default (1 + 2),
          b int default ((1) + (2)) not null,
          c int default (1) + 2 not null,
          d boolean default (1 is not null),
          e text default ('x' || 'y') collate "C",
          f int
        );
        alter table t alter column f set default ((3) * (4));`,
    });
    assert.deepEqual(
      ["a", "b", "c", "d", "e", "f"].map((name) => [name, column(result, "t", name).defaultExpression, column(result, "t", name).nullable]),
      [
        ["a", "1 + 2", true],
        ["b", "(1) + (2)", false],
        ["c", "(1) + 2", false],
        ["d", "1 is not null", true],
        ["e", "'x' || 'y'", true],
        ["f", "(3) * (4)", true],
      ],
    );
  });

  test("the time of the write is still told when it is written in parentheses", async () => {
    const result = await collect({ "001.sql": "create table t (at timestamptz default (now()), day date default (current_date));" });
    assert.deepEqual([column(result, "t", "at").defaultFunction, column(result, "t", "at").defaultExpression], ["current_timestamp", "now()"]);
    assert.deepEqual([column(result, "t", "day").defaultFunction, column(result, "t", "day").defaultExpression], ["current_date", "current_date"]);
  });

  test("a comment after an expression is not part of it; one within it stays, with its line end", async () => {
    const result = await collect({
      "001.sql": ["create table t (", "  a int,", "  b int,", "  constraint c1 check (a > 0 -- more than nothing", "  ),", "  constraint c2 check (a > 0 /* and */ and -- also", "    b > 0)", ");"].join("\n"),
    });
    assert.deepEqual(table(result, "t").checks?.map((check) => check.expression), ["a > 0", "a > 0 /* and */ and -- also\n    b > 0"]);
  });

  test("a parenthesis or a word that ends an expression does not end it within a text or a name", async () => {
    const result = await collect({
      "001.sql": `
        create table t (
          "not" text default ('a)' || ')') not null,
          b text,
          constraint c1 check (("not" <> ')') and (b <> 'not null, check'))
        );`,
    });
    assert.deepEqual([column(result, "t", "not").defaultExpression, column(result, "t", "not").nullable], ["'a)' || ')'", false]);
    assert.deepEqual(table(result, "t").checks?.map((check) => check.expression), [`("not" <> ')') and (b <> 'not null, check')`]);
  });
});
