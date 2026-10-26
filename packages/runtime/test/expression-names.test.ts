import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { copyExpressionName, namedNow, namesAfterRename, staleNamesOf } from "../src/index.ts";
import type { ExpressionName } from "../src/index.ts";

/*
 * What the text of an expression names (D-040). A schema keeps an expression
 * as text, and its database keeps what the text meant: a rename is followed
 * there, and the text stays. So the schema says what each name in the text
 * is called now.
 */

const NAMES: ExpressionName[] = [
  { kind: "column", name: "a" },
  { kind: "column", name: "b", now: "amount" },
  { kind: "table", name: "t" },
  { kind: "type", name: "mood" },
  { kind: "value", name: "sad", type: "mood" },
  { kind: "value", name: "sad", type: "weather" },
  { kind: "function", name: "slug", now: "make_slug" },
];

describe("the names of an expression", () => {
  test("are copied with their keys in one order, and without a name for now that is the text's own", () => {
    assert.equal(JSON.stringify(copyExpressionName({ type: "mood", now: "blue", name: "sad", kind: "value" })), '{"kind":"value","name":"sad","now":"blue","type":"mood"}');
    assert.deepEqual(copyExpressionName({ kind: "column", name: "a", now: "a" }), { kind: "column", name: "a" });
    const entry: ExpressionName = { kind: "column", name: "a", now: "b" };
    assert.notEqual(copyExpressionName(entry), entry);
  });

  test("are stale where the thing is called something else now", () => {
    assert.deepEqual(staleNamesOf(NAMES), [
      { kind: "column", name: "b", now: "amount" },
      { kind: "function", name: "slug", now: "make_slug" },
    ]);
    assert.deepEqual(staleNamesOf(undefined), []);
    assert.deepEqual(staleNamesOf([{ kind: "column", name: "a" }]), []);
  });

  test("say whether the text names a thing, by what the thing is called now", () => {
    assert.equal(namedNow(NAMES, "column", "a"), true);
    // The text says `b`; the column is `amount`.
    assert.equal(namedNow(NAMES, "column", "amount"), true);
    assert.equal(namedNow(NAMES, "column", "b"), false);
    assert.equal(namedNow(NAMES, "table", "a"), false);
    assert.equal(namedNow(NAMES, "value", "sad", "mood"), true);
    assert.equal(namedNow(NAMES, "value", "sad", "colour"), false);
    assert.equal(namedNow(undefined, "column", "a"), false);
  });
});

describe("the names of an expression after a rename", () => {
  const column = (names: ExpressionName[], from: string, to: string): ExpressionName[] => namesAfterRename(names, { kind: "column", from, to });

  test("a name of the renamed thing is stale by it, and the others are as they were", () => {
    assert.deepEqual(column(NAMES, "a", "first"), [{ kind: "column", name: "a", now: "first" }, ...NAMES.slice(1)]);
    // Not the name the text has, but the thing: `b` is the column `amount`, and no column `b` is named.
    assert.deepEqual(column(NAMES, "b", "other"), NAMES);
    assert.deepEqual(column(NAMES, "amount", "total")[1], { kind: "column", name: "b", now: "total" });
  });

  test("through several renames, the text's name stays and what it is called now follows", () => {
    const twice = column(column([{ kind: "column", name: "a" }], "a", "x"), "x", "y");
    assert.deepEqual(twice, [{ kind: "column", name: "a", now: "y" }]);
  });

  test("a thing that has the text's name again is not stale", () => {
    assert.deepEqual(column(column([{ kind: "column", name: "a" }], "a", "x"), "x", "a"), [{ kind: "column", name: "a" }]);
  });

  test("two things that exchange their names are each stale by the other's", () => {
    const names: ExpressionName[] = [
      { kind: "column", name: "a" },
      { kind: "column", name: "b" },
    ];
    const exchanged = column(column(column(names, "a", "tmp"), "b", "a"), "tmp", "b");
    assert.deepEqual(exchanged, [
      { kind: "column", name: "a", now: "b" },
      { kind: "column", name: "b", now: "a" },
    ]);
  });

  test("a rename is of one kind of thing: a table of the same name is another thing", () => {
    assert.deepEqual(namesAfterRename(NAMES, { kind: "table", from: "a", to: "z" }), NAMES);
    assert.deepEqual(namesAfterRename(NAMES, { kind: "table", from: "t", to: "u" })[2], { kind: "table", name: "t", now: "u" });
  });

  test("a value is its type's: a value of that name of another type is not renamed with it", () => {
    const renamed = namesAfterRename(NAMES, { kind: "value", type: "mood", from: "sad", to: "blue" });
    assert.deepEqual(renamed.slice(4, 6), [
      { kind: "value", name: "sad", now: "blue", type: "mood" },
      { kind: "value", name: "sad", type: "weather" },
    ]);
  });

  test("a type that is renamed takes its values along", () => {
    const renamed = namesAfterRename(NAMES, { kind: "type", from: "mood", to: "feeling" });
    assert.deepEqual(renamed.slice(3, 6), [
      { kind: "type", name: "mood", now: "feeling" },
      { kind: "value", name: "sad", type: "feeling" },
      { kind: "value", name: "sad", type: "weather" },
    ]);
    // And the value is found by its type's new name afterwards.
    assert.deepEqual(namesAfterRename(renamed, { kind: "value", type: "feeling", from: "sad", to: "blue" })[4], { kind: "value", name: "sad", now: "blue", type: "feeling" });
  });

  test("the list that is given is not changed", () => {
    const names: ExpressionName[] = [{ kind: "column", name: "a" }];
    const renamed = column(names, "a", "b");
    assert.deepEqual(names, [{ kind: "column", name: "a" }]);
    assert.notEqual(renamed[0], names[0]);
  });
});
