import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CollectedSchema } from "../src/index.ts";
import { collect, table } from "./support.ts";

/*
 * The names of the objects that a statement does not name (D-036). The
 * expected names are PostgreSQL's (makeObjectName, ChooseRelationName,
 * ChooseConstraintName, ChooseIndexColumnNames), worked out by hand.
 */

interface Names {
  primaryKey: string | undefined;
  uniques: (string | undefined)[];
  /** Of single columns first, in the order of the columns; then of several columns. */
  foreignKeys: (string | undefined)[];
  checks: (string | undefined)[];
  indexes: string[];
}

function namesOf(result: CollectedSchema, tableName: string): Names {
  const found = table(result, tableName);
  return {
    primaryKey: found.primaryKey?.name,
    uniques: (found.uniques ?? []).map((entry) => entry.name),
    foreignKeys: [...found.columns.flatMap((entry) => (entry.references === undefined ? [] : [entry.references.name])), ...(found.foreignKeys ?? []).map((entry) => entry.name)],
    checks: (found.checks ?? []).map((entry) => entry.name),
    indexes: (found.indexes ?? []).map((entry) => entry.name),
  };
}

const bytes = (text: string | undefined): number => Buffer.byteLength(text ?? "", "utf8");

// Forty characters each.
const TABLE_40 = "aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd";
const COLUMN_40 = "eeeeeeeeeeffffffffffgggggggggghhhhhhhhhh";

describe("names of objects that a statement does not name", () => {
  test("keys, constraints, and indexes are named after their table and columns", async () => {
    const result = await collect({
      "1.sql": `
        create table parents (id int primary key, code text unique);
        create table t (
          id int primary key,
          a int unique,
          b int,
          c int references parents,
          unique (a, b),
          foreign key (b, c) references t (a, b)
        );
        create index on t (a);
        create index on t (a, b);
        create unique index on t (b);`,
    });
    assert.deepEqual(namesOf(result, "parents"), { primaryKey: "parents_pkey", uniques: ["parents_code_key"], foreignKeys: [], checks: [], indexes: [] });
    assert.deepEqual(namesOf(result, "t"), {
      primaryKey: "t_pkey",
      uniques: ["t_a_key", "t_a_b_key"],
      foreignKeys: ["t_c_fkey", "t_b_c_fkey"],
      checks: [],
      // A unique index that is not a constraint is an index: "idx", not "key".
      indexes: ["t_a_idx", "t_a_b_idx", "t_b_idx"],
    });
  });

  test("an index over an expression is named after the expression's function or column, else expr", async () => {
    const result = await collect({
      "1.sql": `
        create table t (a int, b int, c text);
        create index on t (lower(c));
        create index on t ((a + b));
        create index on t ((c::int));
        create index on t (coalesce(a, 0));
        create index on t (a, (b * 2), lower(c));
        create index on t ((a + 1), (b + 1));`,
    });
    assert.deepEqual(namesOf(result, "t").indexes, ["t_lower_idx", "t_expr_idx", "t_c_idx", "t_coalesce_idx", "t_a_expr_lower_idx", "t_expr_expr1_idx"]);
  });

  test("the columns an index only carries along (INCLUDE) are part of its name, though not of its key", async () => {
    const result = await collect({
      "1.sql": `
        create table tbl (c1 int, c2 int, c3 int, c4 int, unique (c1, c2) include (c3, c4));
        create index on tbl (c1) include (c2);
        alter table tbl add unique (c3) include (c4);
        create table keyed (id int, extra int, primary key (id) include (extra));`,
    });
    const found = table(result, "tbl");
    assert.deepEqual(found.uniques?.map((entry) => [entry.name, entry.columns]), [
      ["tbl_c1_c2_c3_c4_key", ["c1", "c2"]],
      ["tbl_c3_c4_key", ["c3"]],
    ]);
    assert.deepEqual(found.indexes?.map((entry) => [entry.name, entry.columns]), [["tbl_c1_c2_idx", ["c1"]]]);
    // A primary key's name does not depend on its columns.
    assert.deepEqual([table(result, "keyed").primaryKey?.name, table(result, "keyed").primaryKey?.columns], ["keyed_pkey", ["id"]]);
    // So a later statement that names the constraint as PostgreSQL named it finds it.
    const dropped = await collect({ "1.sql": "create table tbl (c1 int, c2 int, unique (c1) include (c2));\nalter table tbl drop constraint tbl_c1_c2_key;" });
    assert.equal(table(dropped, "tbl").uniques, undefined);
  });

  test("a name is cut to 63 bytes, from the longer of the table's and the columns' part", async () => {
    const result = await collect({
      "1.sql": `
        create table ${TABLE_40} (${COLUMN_40} int unique, id int primary key);
        create index on ${TABLE_40} (${COLUMN_40});
        alter table ${TABLE_40} add foreign key (${COLUMN_40}) references ${TABLE_40} (id);
        create table short (${COLUMN_40}eeeeeeeeeeffffffffff int, x int, unique (${COLUMN_40}eeeeeeeeeeffffffffff, x));`,
    });
    const long = namesOf(result, TABLE_40);
    // 40 + "_pkey" fits. With "_key" and "_idx" (5 bytes with the "_" between the parts) 58 bytes are left: 29 for each part.
    assert.deepEqual(long, {
      primaryKey: "aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd_pkey",
      uniques: ["aaaaaaaaaabbbbbbbbbbccccccccc_eeeeeeeeeeffffffffffggggggggg_key"],
      // "_fkey" leaves 57: the parts are equally long, so the second one gives way first.
      foreignKeys: ["aaaaaaaaaabbbbbbbbbbccccccccc_eeeeeeeeeeffffffffffgggggggg_fkey"],
      checks: [],
      indexes: ["aaaaaaaaaabbbbbbbbbbccccccccc_eeeeeeeeeeffffffffffggggggggg_idx"],
    });
    assert.deepEqual([bytes(long.uniques[0]), bytes(long.foreignKeys[0]), bytes(long.indexes[0])], [63, 63, 63]);
    // A short table name stays whole; the columns' part (60 + "_x") is cut to 53.
    assert.deepEqual(namesOf(result, "short").uniques, ["short_eeeeeeeeeeffffffffffgggggggggghhhhhhhhhheeeeeeeeeefff_key"]);
  });

  test("a cut never splits a character", async () => {
    // 1 + 31 * 2 = 63 bytes, and 20 * 2 = 40 bytes.
    const tableName = `x${"é".repeat(31)}`;
    const columnName = "ü".repeat(20);
    const result = await collect({ "1.sql": `create table "${tableName}" (id int primary key, "${columnName}" int unique);` });
    const names = namesOf(result, tableName);
    // 58 bytes are left for the table's part: "x" and 28 two-byte characters are 57; one more would be 59.
    assert.equal(names.primaryKey, `x${"é".repeat(28)}_pkey`);
    // 29 bytes for each part: "x" and 14 characters are 29; 14 characters of the column are 28, and 15 would be 30.
    assert.deepEqual(names.uniques, [`x${"é".repeat(14)}_${"ü".repeat(14)}_key`]);
    assert.deepEqual([bytes(names.primaryKey), bytes(names.uniques[0])], [62, 62]);
  });

  test("a name that is in use is tried again with a number after its label", async () => {
    const result = await collect({
      "1.sql": `
        create table t_pkey (x int);
        create table t (id int primary key, a int, b int);
        alter table t add unique (a);
        alter table t add unique (a);
        create index on t (a);
        create index on t (a);
        create index t_b_idx on t (a);
        create index on t (b);
        alter table t add foreign key (a) references t (id), add foreign key (a) references t (id), add foreign key (a) references t (id);`,
    });
    assert.deepEqual(namesOf(result, "t"), {
      // The table t_pkey has the name.
      primaryKey: "t_pkey1",
      uniques: ["t_a_key", "t_a_key1"],
      foreignKeys: ["t_a_fkey", "t_a_fkey1", "t_a_fkey2"],
      checks: [],
      // t_b_idx was given to an index by its statement, so the index on b is t_b_idx1.
      indexes: ["t_a_idx", "t_a_idx1", "t_b_idx", "t_b_idx1"],
    });
  });

  test("a key's name must be free as a constraint's name too; an index's only as a relation's", async () => {
    const result = await collect({
      "1.sql": `
        create table t (a int, b int);
        alter table t add constraint t_a_key check (a > 0);
        alter table t add constraint t_b_idx check (b > 0);
        alter table t add unique (a);
        create index on t (b);`,
    });
    assert.deepEqual([namesOf(result, "t").uniques, namesOf(result, "t").indexes], [["t_a_key1"], ["t_b_idx"]]);
  });

  test("the number makes the label longer, so a cut name is cut further", async () => {
    const result = await collect({
      "1.sql": `
        create table ${TABLE_40} (${COLUMN_40} int);
        alter table ${TABLE_40} add unique (${COLUMN_40});
        alter table ${TABLE_40} add unique (${COLUMN_40});`,
    });
    const names = namesOf(result, TABLE_40).uniques;
    assert.deepEqual(names, [
      "aaaaaaaaaabbbbbbbbbbccccccccc_eeeeeeeeeeffffffffffggggggggg_key",
      // "_key1" leaves 57 bytes: 29 and 28.
      "aaaaaaaaaabbbbbbbbbbccccccccc_eeeeeeeeeeffffffffffgggggggg_key1",
    ]);
    assert.deepEqual(names.map(bytes), [63, 63]);
  });

  test("index and constraint names are in use across the schema, not per table", async () => {
    const result = await collect({
      "1.sql": `
        create table a_b (c int, check (c > 0));
        create table a (b_c int, check (b_c > 0));
        create index on a_b (c);
        create index on a (b_c);`,
    });
    assert.deepEqual([namesOf(result, "a_b").indexes, namesOf(result, "a").indexes], [["a_b_c_idx"], ["a_b_c_idx1"]]);
    assert.deepEqual([namesOf(result, "a_b").checks, namesOf(result, "a").checks], [["a_b_c_check"], ["a_b_c_check1"]]);
  });

  test("a name is free again when its object is dropped, and stays taken when its table is renamed", async () => {
    const result = await collect({
      "1.sql": `
        create table t (id int primary key, a int);
        create index on t (a);
        drop index t_a_idx;
        create index on t (a);
        alter table t add unique (a);
        alter table t drop constraint t_a_key;
        alter table t add unique (a);
        alter table t rename to u;
        create table t (id int primary key, a int unique);
        create index on t (a);`,
    });
    // PostgreSQL does not rename a table's constraints and indexes with the table.
    assert.deepEqual(namesOf(result, "u"), { primaryKey: "t_pkey", uniques: ["t_a_key"], foreignKeys: [], checks: [], indexes: ["t_a_idx"] });
    assert.deepEqual(namesOf(result, "t"), { primaryKey: "t_pkey1", uniques: ["t_a_key1"], foreignKeys: [], checks: [], indexes: ["t_a_idx1"] });
  });

  test("a check is named after the one column it uses, wherever it is written, and after the table alone otherwise", async () => {
    const result = await collect({
      "1.sql": `
        create table t (
          a int check (a > 0),
          b int check (b > a),
          c int check (c > 0 and c < 10),
          d int constraint d_positive check (d > 0),
          check (a > 0),
          check (a + b + c > 0),
          check (1 = 1)
        );
        alter table t add column e int check (e > 0);
        alter table t add check (e < 100);
        alter table t add check (a < e), add check (upper('x') = 'X');
        alter table t add constraint named_one check (a < e);`,
    });
    assert.deepEqual(namesOf(result, "t").checks, [
      "t_a_check",
      // Written with the column b, but it uses two columns.
      "t_check",
      // One column, used twice.
      "t_c_check",
      "d_positive",
      // Written for the table, but it uses one column; t_a_check is taken.
      "t_a_check1",
      "t_check1",
      // No column at all.
      "t_check2",
      "t_e_check",
      "t_e_check1",
      "t_check3",
      "t_check4",
      "named_one",
    ]);
  });

  test("a name the collector worked out is marked as generated; a name the statement gives is not", async () => {
    const result = await collect({
      "1.sql": `
        create table parents (id int, constraint parents_key primary key (id));
        create table t (
          id int primary key,
          a int constraint a_once unique,
          b int unique,
          c int constraint c_parent references parents,
          d int references parents,
          constraint ab_positive check (a + b > 0),
          check (a + b < 100)
        );
        create index t_named on t (a);
        create index on t (b);`,
    });
    const found = table(result, "t");
    const generated = (entry: { name?: string; origin?: { generatedName?: boolean } } | undefined): [string | undefined, boolean] => [entry?.name, entry?.origin?.generatedName === true];
    assert.deepEqual(generated(table(result, "parents").primaryKey), ["parents_key", false]);
    assert.deepEqual(generated(found.primaryKey), ["t_pkey", true]);
    assert.deepEqual((found.uniques ?? []).map(generated), [["a_once", false], ["t_b_key", true]]);
    assert.deepEqual(found.columns.filter((entry) => entry.references !== undefined).map((entry) => generated(entry.references)), [["c_parent", false], ["t_d_fkey", true]]);
    assert.deepEqual((found.checks ?? []).map(generated), [["ab_positive", false], ["t_check", true]]);
    assert.deepEqual((found.indexes ?? []).map(generated), [["t_named", false], ["t_b_idx", true]]);
  });
});
