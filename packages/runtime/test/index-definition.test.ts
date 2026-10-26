import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { indexKeyHasOptions, indexKeyLists, indexKeys, indexKeysProblem } from "../src/index-definition.ts";

/*
 * The keys of an index (D-040): `columns` and `expressions` say an index
 * over columns alone or over expressions alone, each key ascending; `keys`
 * says everything else, and is there only when it is needed.
 */

describe("the keys of an index", () => {
  it("are its columns in order, or its expressions, when that is all it says", () => {
    assert.deepEqual(indexKeys({ columns: ["a", "b"] }), [{ column: "a" }, { column: "b" }]);
    assert.deepEqual(indexKeys({ columns: [], expressions: ["lower(a)", "b + 1"] }), [{ expression: "lower(a)" }, { expression: "b + 1" }]);
    assert.deepEqual(indexKeys({ columns: [], expressions: [] }), []);
  });

  it("are `keys` when the index has them, whatever else it lists", () => {
    const keys = [{ expression: "lower(b)" }, { column: "a", order: "desc" as const }];
    assert.deepEqual(indexKeys({ columns: ["a"], expressions: ["lower(b)"], keys }), keys);
    // A copy: what is given is not what is handed out.
    assert.notEqual(indexKeys({ columns: ["a"], expressions: ["lower(b)"], keys })?.[0], keys[0]);
  });

  it("are not known when columns and expressions are listed apart: the two lists do not say in which order they stand", () => {
    assert.equal(indexKeys({ columns: ["a"], expressions: ["lower(b)"] }), undefined);
  });

  it("have options when a key says its order, the place of its NULLs, its operator class, or its collation", () => {
    assert.equal(indexKeyHasOptions({ column: "a" }), false);
    assert.equal(indexKeyHasOptions({ expression: "lower(a)" }), false);
    for (const key of [{ column: "a", order: "desc" as const }, { column: "a", nulls: "first" as const }, { column: "a", operatorClass: "text_pattern_ops" }, { column: "a", collation: "C" }]) {
      assert.equal(indexKeyHasOptions(key), true, JSON.stringify(key));
    }
  });
});

describe("the keys of an index, as the index holds them", () => {
  it("are `columns` alone for plain columns, and `expressions` alone for plain expressions", () => {
    assert.deepEqual(indexKeyLists([{ column: "a" }, { column: "b" }]), { columns: ["a", "b"] });
    assert.deepEqual(indexKeyLists([{ expression: "lower(a)" }]), { columns: [], expressions: ["lower(a)"] });
  });

  it("are `keys` as well when a key has an option, with the columns and expressions in the keys' order beside it", () => {
    assert.deepEqual(indexKeyLists([{ column: "b", order: "desc" }, { column: "a" }]), { columns: ["b", "a"], keys: [{ column: "b", order: "desc" }, { column: "a" }] });
    assert.deepEqual(indexKeyLists([{ column: "a", collation: "C", operatorClass: "text_pattern_ops", nulls: "first" }]), {
      columns: ["a"],
      keys: [{ column: "a", nulls: "first", operatorClass: "text_pattern_ops", collation: "C" }],
    });
  });

  it("are `keys` as well when columns and expressions are mixed, which is what says their order", () => {
    assert.deepEqual(indexKeyLists([{ column: "a" }, { expression: "lower(b)" }, { column: "c" }]), {
      columns: ["a", "c"],
      expressions: ["lower(b)"],
      keys: [{ column: "a" }, { expression: "lower(b)" }, { column: "c" }],
    });
  });

  it("come back as they went in", () => {
    for (const keys of [[{ column: "a" }], [{ expression: "x + 1" }, { column: "a" }], [{ column: "a", order: "desc" as const, nulls: "last" as const }], [{ expression: "lower(a)", collation: "C" }]]) {
      assert.deepEqual(indexKeys(indexKeyLists(keys)), keys);
    }
  });
});

describe("what is wrong with the keys of an index", () => {
  const problem = (keys: unknown, columns: string[] = ["a"], expressions?: string[]): string | undefined =>
    indexKeysProblem({ columns, ...(expressions !== undefined && { expressions }), keys: keys as never });

  it("is nothing for an index without `keys`, and for keys that the lists agree with", () => {
    assert.equal(indexKeysProblem({ columns: ["a"] }), undefined);
    assert.equal(problem([{ column: "a", order: "desc" }]), undefined);
    assert.equal(problem([{ column: "a" }, { expression: "lower(b)" }], ["a"], ["lower(b)"]), undefined);
    assert.equal(problem([{ column: "a", order: "desc", nulls: "last" }]), undefined);
    assert.equal(problem([{ column: "a", nulls: "first" }]), undefined);
  });

  it("is a key that is neither a column nor an expression, or both", () => {
    assert.match(problem([{}]) ?? "", /key 1 must be a "column" or an "expression", and not both/);
    assert.match(problem([{ column: "a", order: "desc" }, { column: "b", expression: "b" }]) ?? "", /key 2 must be a "column" or an "expression"/);
    assert.match(problem([]) ?? "", /"keys" has no key/);
  });

  it("is an option that is not one, or that says what the order says anyway", () => {
    assert.match(problem([{ column: "a", order: "asc" }]) ?? "", /"order" of key 1 must be "desc"; ascending is said by leaving it out/);
    assert.match(problem([{ column: "a", nulls: "middle" }]) ?? "", /"nulls" of key 1 must be "first" or "last"/);
    assert.match(problem([{ column: "a", nulls: "last" }]) ?? "", /"nulls" of key 1 says where NULLs stand anyway in ascending order/);
    assert.match(problem([{ column: "a", order: "desc", nulls: "first" }]) ?? "", /"nulls" of key 1 says where NULLs stand anyway in descending order/);
  });

  it("is `columns` or `expressions` that are not the keys' own, and `keys` that says nothing the lists do not", () => {
    assert.match(problem([{ column: "b", order: "desc" }, { column: "a" }], ["a", "b"]) ?? "", /"columns" must be the columns of "keys" in their order \(b, a\)/);
    assert.match(problem([{ column: "a" }, { expression: "lower(b)" }], ["a"]) ?? "", /"expressions" must be the expressions of "keys" in their order/);
    assert.match(problem([{ column: "a" }]) ?? "", /"keys" says nothing that "columns" and "expressions" do not say; it is left out then/);
  });
});
