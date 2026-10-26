import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renameEvidence } from "../src/index.ts";
import type { SchemaOrigin, SchemaRename } from "../../runtime/src/index.ts";
import { origin, renamed } from "./support.ts";

/** An object as the diff sees one: a name, and maybe where it comes from. */
function named(name: string, from?: SchemaOrigin, renames?: SchemaRename[]): { name: string; origin?: SchemaOrigin; renames?: SchemaRename[] } {
  return { name, ...(from !== undefined && { origin: from }), ...(renames !== undefined && { renames }) };
}

describe("rename evidence", () => {
  const created = origin("a");

  test("is the same origin on both sides, and recorded renames from the one name to the other", () => {
    assert.deepEqual(renameEvidence(named("a", created), named("b", created, [renamed("a", "b")])), { origin: created, renames: [renamed("a", "b")] });
  });

  test("needs provenance on both sides", () => {
    assert.equal(renameEvidence(named("a"), named("b", created, [renamed("a", "b")])), undefined);
    assert.equal(renameEvidence(named("a", created), named("b")), undefined);
    assert.equal(renameEvidence(named("a"), named("b")), undefined);
  });

  test("needs the same origin: source, file, the file's hash, statement, and the name the object was created with", () => {
    const after = named("b", created, [renamed("a", "b")]);
    const others: SchemaOrigin[] = [
      { ...created, source: "other-collector" },
      { ...created, file: "0001_other.sql" },
      { ...created, sha256: "sha256-of-an-edited-file" },
      { ...created, statement: 2 },
    ];
    for (const other of others) {
      assert.equal(renameEvidence(named("a", other), after), undefined, JSON.stringify(other));
    }
    // Created under another name by the same statement: another object.
    assert.equal(renameEvidence(named("a", origin("z")), named("b", origin("a"), [renamed("a", "b")])), undefined);
  });

  test("needs a recorded rename: the same origin under two names says nothing by itself", () => {
    assert.equal(renameEvidence(named("a", created), named("b", created)), undefined);
    assert.equal(renameEvidence(named("a", created), named("b", created, [])), undefined);
  });

  test("is none for one name: an object is not renamed to the name it has", () => {
    assert.equal(renameEvidence(named("b", created, [renamed("a", "b")]), named("b", created, [renamed("a", "b")])), undefined);
  });

  test("is the renames since the before side's name, when the after side's history is longer", () => {
    const history = [renamed("a", "b", "0002.sql", 1), renamed("b", "c", "0003.sql", 1), renamed("c", "d", "0004.sql", 1)];
    assert.deepEqual(renameEvidence(named("a", created), named("d", created, history))?.renames, history);
    assert.deepEqual(renameEvidence(named("b", created, [history[0]!]), named("d", created, history))?.renames, [history[1], history[2]]);
    assert.deepEqual(renameEvidence(named("c", created, [history[0]!, history[1]!]), named("d", created, history))?.renames, [history[2]]);
  });

  test("is every rename the after side records beyond the before side's, also when the object had the before side's name again in between", () => {
    const history = [renamed("a", "b", "0002.sql", 1), renamed("b", "a", "0003.sql", 1), renamed("a", "c", "0004.sql", 1)];
    assert.deepEqual(renameEvidence(named("a", created), named("c", created, history))?.renames, history);
    assert.deepEqual(renameEvidence(named("a", created, [history[0]!, history[1]!]), named("c", created, history))?.renames, [history[2]]);
  });

  test("needs the before side's renames to be the start of the after side's", () => {
    const history = [renamed("a", "b", "0002.sql", 1), renamed("b", "c", "0003.sql", 1)];
    // Another rename, or the same one made by another statement.
    assert.equal(renameEvidence(named("b", created, [renamed("x", "b", "0002.sql", 1)]), named("c", created, history)), undefined);
    assert.equal(renameEvidence(named("b", created, [renamed("a", "b", "0002.sql", 7)]), named("c", created, history)), undefined);
    // The object is called as it was at that point of the history, but says nothing of how it came to be.
    assert.equal(renameEvidence(named("b", created), named("c", created, history)), undefined);
    assert.deepEqual(renameEvidence(named("b", created, [history[0]!]), named("c", created, history))?.renames, [history[1]]);
  });

  test("is none for a later state against an earlier one, also when the later state had the earlier name again", () => {
    // The before side went a -> b -> a; the after side only knows a -> b. It is the earlier state.
    const before = named("a", created, [renamed("a", "b", "0002.sql", 1), renamed("b", "a", "0003.sql", 1)]);
    assert.equal(renameEvidence(before, named("b", created, [renamed("a", "b", "0002.sql", 1)])), undefined);
  });

  test("is none when the history does not hang together or does not reach the two names", () => {
    // It does not end at the after side's name.
    assert.equal(renameEvidence(named("a", created), named("c", created, [renamed("a", "b")])), undefined);
    // It does not start at the name the object was created with.
    assert.equal(renameEvidence(named("a", created), named("c", created, [renamed("b", "c")])), undefined);
    // A link is missing.
    assert.equal(renameEvidence(named("a", created), named("d", created, [renamed("a", "b"), renamed("c", "d")])), undefined);
    // The object never had the before side's name.
    assert.equal(renameEvidence(named("x", created), named("b", created, [renamed("a", "b")])), undefined);
  });

  test("is none backwards: a later state's name is not a recorded rename of the earlier state", () => {
    assert.equal(renameEvidence(named("b", created, [renamed("a", "b")]), named("a", created)), undefined);
  });

  test("is a copy: changing it does not change the schema it was read from", () => {
    const after = named("b", created, [renamed("a", "b")]);
    const evidence = renameEvidence(named("a", created), after);
    assert.ok(evidence !== undefined);
    evidence.origin.name = "changed";
    (evidence.renames[0] as SchemaRename).at.file = "changed";
    assert.deepEqual(after, named("b", origin("a"), [renamed("a", "b")]));
  });
});
