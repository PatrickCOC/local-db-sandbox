import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MigrationError } from "../src/index.ts";
import { collect, column, table } from "./support.ts";

/*
 * What the collector keeps of an index and of a constraint beyond its
 * columns (D-040): how an index is built and what its keys are, whether a
 * key or a foreign key is deferrable, and, for a clause the schema has no
 * place for, that the clause is there. Nothing of a definition is passed
 * over in silence: what is not kept as what it is, is kept as text
 * (`sourceClauses`), so that the object is not taken for one without it.
 *
 * Each behaviour here was tried on PostgreSQL 18.
 */

const refused = (sql: string, message: RegExp): Promise<void> => assert.rejects(collect({ "001.sql": sql }), (error) => error instanceof MigrationError && message.test(error.message));
const indexes = async (sql: string) => table(await collect({ "001.sql": sql }), "t").indexes ?? [];
const index = async (sql: string) => {
  const [only, ...more] = await indexes(sql);
  assert.ok(only !== undefined && more.length === 0, "one index");
  // What the text of an index names has tests of its own (expression-names.test.ts).
  const { origin, renames, names, ...rest } = only;
  return rest;
};

describe("an operator class or a collation whose name has a dot in it", () => {
  test("is not kept as a name, which a schema writes with dots between a schema and a name: the index says that there is more to it", async () => {
    const T = "create table t (id int, title text);\n";
    const dotted = await index(`${T}create index i on t (title "odd.ops", id);`);
    assert.deepEqual([dotted.keys, dotted.sourceClauses], [undefined, ['key 1: operator class "odd.ops"']]);
    const collated = await index(`${T}create index i on t (title collate public."my.coll" desc);`);
    assert.deepEqual([collated.keys, collated.sourceClauses], [[{ column: "title", order: "desc" }], ['key 1: collation public."my.coll"']]);
    // A name with a schema and no dot of its own is kept as it is.
    assert.deepEqual((await index(`${T}create index i on t (title public.my_ops);`)).keys, [{ column: "title", operatorClass: "public.my_ops" }]);
  });
});

describe("how an index is built", () => {
  const T = "create table t (id int, title text, tags jsonb, area point, n int);\n";

  test("is kept by the name PostgreSQL has for it: gin, gist, hash, brin", async () => {
    assert.deepEqual(await index(`${T}create index i on t using gin (tags);`), { name: "i", columns: ["tags"], method: "gin" });
    assert.deepEqual(await index(`${T}create index i on t using gist (area);`), { name: "i", columns: ["area"], method: "gist" });
    assert.deepEqual(await index(`${T}create index i on t using hash (title);`), { name: "i", columns: ["title"], method: "hash" });
    assert.deepEqual(await index(`${T}create index i on t using brin (n);`), { name: "i", columns: ["n"], method: "brin" });
    // A method of an extension is kept as it is named.
    assert.deepEqual(await index(`${T}create index i on t using hnsw (tags);`), { name: "i", columns: ["tags"], method: "hnsw" });
  });

  test("is not said for a B-tree, which is what an index is when nothing is said", async () => {
    assert.deepEqual(await index(`${T}create index i on t (n);`), { name: "i", columns: ["n"] });
    assert.deepEqual(await index(`${T}create index i on t using btree (n);`), { name: "i", columns: ["n"] });
    assert.deepEqual(await index(`${T}create index i on t using BTREE (n);`), { name: "i", columns: ["n"] });
  });

  test("is refused where PostgreSQL refuses it: a unique index, an order, or included columns on a method that has none", async () => {
    await refused(`${T}create unique index i on t using hash (title);`, /^001\.sql:2: access method "hash" does not support unique indexes\.$/);
    await refused(`${T}create unique index i on t using gin (tags);`, /access method "gin" does not support unique indexes/);
    await refused(`${T}create unique index i on t using gist (area);`, /access method "gist" does not support unique indexes/);
    await refused(`${T}create unique index i on t using brin (n);`, /access method "brin" does not support unique indexes/);
    await refused(`${T}create index i on t using gin (tags desc);`, /access method "gin" does not support ASC\/DESC options/);
    await refused(`${T}create index i on t using hash (title asc);`, /access method "hash" does not support ASC\/DESC options/);
    await refused(`${T}create index i on t using gin (tags nulls first);`, /access method "gin" does not support NULLS FIRST\/LAST options/);
    await refused(`${T}create index i on t using hash (title, n);`, /access method "hash" does not support multicolumn indexes/);
    await refused(`${T}create index i on t using hash (title) include (n);`, /access method "hash" does not support included columns/);
    await refused(`${T}create index i on t using gin (tags) include (n);`, /access method "gin" does not support included columns/);
    await refused(`${T}create index i on t using brin (n) include (id);`, /access method "brin" does not support included columns/);
    // A method the collector does not know may be anything: nothing is refused for it.
    assert.equal((await index(`${T}create unique index i on t using hnsw (tags desc) include (n);`)).method, "hnsw");
    // And after a statement whose effect is not known, nothing is refused on these grounds.
    assert.equal((await index(`${T}do $$ begin null; end $$;\ncreate unique index i on t using hash (title);`)).method, "hash");
  });
});

describe("the keys of an index", () => {
  const T = "create table t (a int, b text, c text, d int);\n";

  test("are its columns alone when they are plain, in ascending order", async () => {
    assert.deepEqual(await index(`${T}create index i on t (a, b);`), { name: "i", columns: ["a", "b"] });
    // Said or not, ascending with NULLs last is one order.
    assert.deepEqual(await index(`${T}create index i on t (a asc, b asc nulls last);`), { name: "i", columns: ["a", "b"] });
  });

  test("keep their order, and each key its own: descending, and where NULLs stand when that is not where the order puts them", async () => {
    assert.deepEqual(await index(`${T}create index i on t (b desc, a);`), { name: "i", columns: ["b", "a"], keys: [{ column: "b", order: "desc" }, { column: "a" }] });
    assert.deepEqual(await index(`${T}create index i on t (a nulls first, b desc nulls last, c desc nulls first, d asc nulls last);`), {
      name: "i",
      columns: ["a", "b", "c", "d"],
      keys: [{ column: "a", nulls: "first" }, { column: "b", order: "desc", nulls: "last" }, { column: "c", order: "desc" }, { column: "d" }],
    });
  });

  test("keep the operator class and the collation a key names", async () => {
    assert.deepEqual(await index(`${T}create index i on t (b text_pattern_ops, c collate "C");`), {
      name: "i",
      columns: ["b", "c"],
      keys: [{ column: "b", operatorClass: "text_pattern_ops" }, { column: "c", collation: "C" }],
    });
    assert.deepEqual(await index(`${T}create index i on t (b collate "C" public.my_ops desc nulls last);`), {
      name: "i",
      columns: ["b"],
      keys: [{ column: "b", order: "desc", nulls: "last", operatorClass: "public.my_ops", collation: "C" }],
    });
    // The collation every text has anyway is not one that is named.
    assert.deepEqual(await index(`${T}create index i on t (b collate "default", c collate pg_catalog."default");`), { name: "i", columns: ["b", "c"] });
  });

  test("keep the place of an expression among the columns", async () => {
    assert.deepEqual(await index(`${T}create index i on t (a, lower(b), d);`), {
      name: "i",
      columns: ["a", "d"],
      expressions: ["lower(b)"],
      keys: [{ column: "a" }, { expression: "lower(b)" }, { column: "d" }],
    });
    assert.deepEqual(await index(`${T}create index i on t ((a + d) desc, b);`), {
      name: "i",
      columns: ["b"],
      expressions: ["a + d"],
      keys: [{ expression: "a + d", order: "desc" }, { column: "b" }],
    });
    // Expressions alone are said as they always were.
    assert.deepEqual(await index(`${T}create index i on t (lower(b), upper(c));`), { name: "i", columns: [], expressions: ["lower(b)", "upper(c)"] });
  });

  test("an expression ends where it ends: what is said of the key after it is not part of its text", async () => {
    assert.deepEqual(await index(`${T}create index i on t (lower(b) text_pattern_ops desc nulls last, (a + d) collate "C" asc, upper(c) desc) where a > 0;`), {
      name: "i",
      columns: [],
      expressions: ["lower(b)", "a + d", "upper(c)"],
      where: "a > 0",
      keys: [
        { expression: "lower(b)", order: "desc", nulls: "last", operatorClass: "text_pattern_ops" },
        { expression: "a + d", collation: "C" },
        { expression: "upper(c)", order: "desc" },
      ],
    });
    // Parentheses within an expression that is in parentheses of its own stay part of it.
    assert.deepEqual((await index(`${T}create index i on t (((a + d) * 2) desc, coalesce(b, c) nulls first);`)).keys, [
      { expression: "(a + d) * 2", order: "desc" },
      { expression: "coalesce(b, c)", nulls: "first" },
    ]);
  });

  test("are apart from the columns the index only carries along, which are kept as that", async () => {
    assert.deepEqual(await index(`${T}create unique index i on t (a) include (b, c);`), { name: "i", columns: ["a"], unique: true, include: ["b", "c"] });
    assert.deepEqual(await index(`${T}create unique index i on t (a, d) nulls not distinct where d > 0;`), { name: "i", columns: ["a", "d"], unique: true, where: "d > 0", nullsNotDistinct: true });
  });

  test("follow a renamed column, in the keys and among the columns carried along", async () => {
    const renamed = await index(`${T}create index i on t (b desc, a) include (c);\nalter table t rename column b to title;\nalter table t rename column c to note;`);
    assert.deepEqual(renamed, { name: "i", columns: ["title", "a"], keys: [{ column: "title", order: "desc" }, { column: "a" }], include: ["note"] });
  });

  test("the index goes with a column of its key, of what it carries along, of an expression, or of its condition, as in PostgreSQL", async () => {
    const left = async (indexSql: string): Promise<string[]> => (await indexes(`${T}${indexSql}\ncreate index stays on t (a);\nalter table t drop column b;`)).map((entry) => entry.name);
    assert.deepEqual(await left("create index i on t (a, b);"), ["stays"]);
    assert.deepEqual(await left("create index i on t (a) include (b);"), ["stays"]);
    assert.deepEqual(await left("create index i on t (lower(b));"), ["stays"]);
    assert.deepEqual(await left("create index i on t (a) where b is not null;"), ["stays"]);
    assert.deepEqual(await left("create index i on t (a, (d + 1)) where c is not null;"), ["i", "stays"]);
    // The name of an index that went is free again.
    const reused = await collect({ "001.sql": `${T}create index i on t (lower(b));\nalter table t drop column b;\ncreate table i (id int);` });
    assert.deepEqual(reused.tables.map((entry) => entry.name), ["t", "i"]);
  });

  test("a key goes with a column its index carries along, and follows that column's new name", async () => {
    const base = "create table t (a int, b int, c int, constraint u unique (a) include (b), constraint k primary key (c) include (b));\n";
    const renamed = table(await collect({ "001.sql": `${base}alter table t rename column b to note;` }), "t");
    assert.deepEqual([renamed.uniques?.[0]?.include, renamed.primaryKey?.include], [["note"], ["note"]]);
    const dropped = table(await collect({ "001.sql": `${base}alter table t drop column b;` }), "t");
    assert.deepEqual([dropped.uniques, dropped.primaryKey, dropped.columns.map((entry) => [entry.name, entry.primary])], [undefined, undefined, [["a", false], ["c", false]]]);
  });
});

describe("what an index says that the schema has no place for", () => {
  const T = "create table t (a int, b text, tags jsonb);\n";

  test("is kept as the clause it is, so that the index is not taken for one without it", async () => {
    assert.deepEqual(await index(`${T}create index i on t (a) with (fillfactor = 70);`), { name: "i", columns: ["a"], sourceClauses: ["WITH (fillfactor=70)"] });
    assert.deepEqual(await index(`${T}create index i on t using gin (tags) with (fastupdate = off, gin_pending_list_limit = 64) tablespace fast;`), {
      name: "i",
      columns: ["tags"],
      method: "gin",
      sourceClauses: ["WITH (fastupdate=off, gin_pending_list_limit=64)", "TABLESPACE fast"],
    });
    // The parameters of an operator class go with the key they are of.
    assert.deepEqual(await index(`${T}create index i on t using gist (b gist_trgm_ops (siglen = 32));`), {
      name: "i",
      columns: ["b"],
      method: "gist",
      keys: [{ column: "b", operatorClass: "gist_trgm_ops" }],
      sourceClauses: ["key 1: operator class parameters (siglen=32)"],
    });
  });

  test("is reported, and an index that says nothing of the kind has no such list", async () => {
    const result = await collect({ "001.sql": `${T}create index i on t (a) with (fillfactor = 70);\ncreate index plain on t (a);` });
    assert.equal((table(result, "t").indexes ?? [])[1]?.sourceClauses, undefined);
    const note = result.report.find((entry) => entry.object === "i" && /WITH \(fillfactor=70\)/.test(entry.message));
    assert.equal(note?.outcome, "retained");
    assert.match(note?.message ?? "", /is kept as text, and is not what the schema holds of the index/);
  });
});

describe("a key from an index (ADD CONSTRAINT ... USING INDEX)", () => {
  const T = "create table t (a int not null, b text);\n";

  test("is refused, as in PostgreSQL, for an index whose keys are not in the order every key has by itself", async () => {
    await refused(`${T}create unique index i on t (a desc);\nalter table t add constraint k unique using index i;`, /^001\.sql:3: index "i" column number 1 does not have default sorting behavior\.$/);
    await refused(`${T}create unique index i on t (a, b text_pattern_ops);\nalter table t add constraint k unique using index i;`, /index "i" column number 2 does not have default sorting behavior/);
    await refused(`${T}create unique index i on t (b collate "C");\nalter table t add constraint k unique using index i;`, /index "i" column number 1 does not have default sorting behavior/);
  });

  test("takes what the index carries along, and what the index said beyond what the schema holds", async () => {
    const result = await collect({ "001.sql": `${T}create unique index i on t (a) include (b) with (fillfactor = 70);\nalter table t add constraint k unique using index i deferrable initially deferred;` });
    const [key] = table(result, "t").uniques ?? [];
    assert.deepEqual([key?.name, key?.columns, key?.include, key?.deferrable, key?.sourceClauses], ["k", ["a"], ["b"], "deferred", ["WITH (fillfactor=70)"]]);
    assert.equal(table(result, "t").indexes, undefined);
    // An index that takes two NULLs for the same makes a constraint that does.
    const distinct = await collect({ "001.sql": `${T}create unique index i on t (a) nulls not distinct;\nalter table t add constraint k unique using index i;` });
    assert.equal(table(distinct, "t").uniques?.[0]?.nullsNotDistinct, true);
  });

  test("is refused for an index that is no B-tree", async () => {
    // A unique index is a B-tree in PostgreSQL, so this is an index that is not unique.
    await refused(`${T}create index i on t using hash (a);\nalter table t add constraint k unique using index i;`, /"i" is not a unique index/);
  });
});

describe("whether a constraint is deferrable", () => {
  test("is kept for a primary key, a unique constraint, and a foreign key, written with the table", async () => {
    const result = await collect({
      "001.sql": `
        create table p (id int, code text, a int, b int,
          constraint p_pkey primary key (id) deferrable,
          constraint p_code unique (code) deferrable initially deferred,
          constraint p_ab unique (a, b) not deferrable initially immediate);
        create table q (id int primary key, a int, b int, unique (a, b));
        create table c (x int, a int, b int,
          constraint c_x foreign key (x) references q (id) deferrable initially deferred,
          constraint c_pair foreign key (a, b) references q (a, b) on delete cascade initially deferred,
          constraint c_plain foreign key (x) references q (id) deferrable initially immediate);`,
    });
    const p = table(result, "p");
    assert.equal(p.primaryKey?.deferrable, "immediate");
    assert.deepEqual(p.uniques?.map((unique) => [unique.name, unique.deferrable]), [["p_code", "deferred"], ["p_ab", undefined]]);
    const c = table(result, "c");
    // A foreign key over one column is with its column; a second one over the same column is with the table.
    assert.deepEqual([column(result, "c", "x").references?.name, column(result, "c", "x").references?.deferrable], ["c_x", "deferred"]);
    assert.deepEqual(c.foreignKeys?.map((key) => [key.name, key.deferrable, key.onDelete]), [
      // INITIALLY DEFERRED says DEFERRABLE.
      ["c_pair", "deferred", "CASCADE"],
      ["c_plain", "immediate", undefined],
    ]);
  });

  test("is kept when it is written after a column's constraint, of which it is then", async () => {
    const result = await collect({
      "001.sql": `
        create table q (id int primary key);
        create table c (
          id int primary key initially deferred,
          code text unique deferrable not null,
          plain text unique not deferrable,
          q1 int references q (id) deferrable initially deferred,
          q2 int references q (id) on delete set null deferrable,
          q3 int references q (id) not deferrable initially immediate,
          q4 int default 1 references q (id) initially deferred);`,
    });
    const c = table(result, "c");
    assert.equal(c.primaryKey?.deferrable, "deferred");
    assert.deepEqual(c.uniques?.map((unique) => [unique.columns, unique.deferrable]), [[["code"], "immediate"], [["plain"], undefined]]);
    assert.equal(column(result, "c", "code").nullable, false);
    assert.deepEqual(["q1", "q2", "q3", "q4"].map((name) => [column(result, "c", name).references?.deferrable, column(result, "c", name).references?.onDelete]), [
      ["deferred", undefined],
      ["immediate", "SET NULL"],
      [undefined, undefined],
      ["deferred", undefined],
    ]);
  });

  test("is refused where PostgreSQL refuses the clause", async () => {
    await refused("create table t (a int check (a > 0) deferrable);", /^001\.sql:1: misplaced DEFERRABLE clause\.$/);
    await refused("create table t (a int not null deferrable);", /misplaced DEFERRABLE clause/);
    await refused("create table t (a int default 1 deferrable);", /misplaced DEFERRABLE clause/);
    await refused("create table t (a int deferrable unique);", /misplaced DEFERRABLE clause/);
    await refused("create table t (a int check (a > 0) not deferrable);", /misplaced NOT DEFERRABLE clause/);
    await refused("create table t (a int not null initially deferred);", /misplaced INITIALLY DEFERRED clause/);
    await refused("create table t (a int check (a > 0) initially immediate);", /misplaced INITIALLY IMMEDIATE clause/);
    await refused("create table t (a int unique deferrable deferrable);", /multiple DEFERRABLE\/NOT DEFERRABLE clauses not allowed/);
    await refused("create table t (a int unique deferrable not deferrable);", /multiple DEFERRABLE\/NOT DEFERRABLE clauses not allowed/);
    await refused("create table t (a int unique initially deferred initially immediate);", /multiple INITIALLY IMMEDIATE\/DEFERRED clauses not allowed/);
    await refused("create table t (a int unique not deferrable initially deferred);", /constraint declared INITIALLY DEFERRED must be DEFERRABLE/);
  });

  test("a foreign key does not rest on a key that is deferrable", async () => {
    await refused("create table p (id int primary key deferrable);\ncreate table c (p_id int references p (id));", /^001\.sql:2: cannot use a deferrable unique constraint for referenced table "p"\.$/);
    await refused("create table p (id int, constraint u unique (id) initially deferred);\ncreate table c (p_id int);\nalter table c add foreign key (p_id) references p (id);", /cannot use a deferrable unique constraint for referenced table "p"/);
    // Another key over the same columns that is not deferrable is one to rest on.
    const result = await collect({ "001.sql": "create table p (id int, constraint u unique (id) deferrable);\ncreate unique index p_id on p (id);\ncreate table c (p_id int references p (id));" });
    assert.equal(column(result, "c", "p_id").references?.table, "p");
    // After a statement whose effect is not known, it is not refused.
    assert.equal((await collect({ "001.sql": "create table p (id int primary key deferrable);\ndo $$ begin null; end $$;\ncreate table c (p_id int references p (id));" })).tables.length, 2);
  });

  test("a foreign key that names no columns rests on the primary key, and not on one that is deferrable", async () => {
    await refused("create table p (id int primary key deferrable);\ncreate table c (p_id int references p);", /^001\.sql:2: cannot use a deferrable primary key for referenced table "p"\.$/);
    await refused("create table p (id int, primary key (id) initially deferred);\ncreate table c (p_id int, foreign key (p_id) references p);", /cannot use a deferrable primary key for referenced table "p"/);
  });

  test("a check is never deferrable: as a constraint of the table, the clause is refused as PostgreSQL's grammar refuses it", async () => {
    // It is PostgreSQL's parser that refuses it, at the place of the clause: no statement is made of the text.
    await assert.rejects(collect({ "001.sql": "create table t (a int, constraint c check (a > 0) deferrable);" }), /^MigrationSyntaxError: 001\.sql:1:51: CHECK constraints cannot be marked DEFERRABLE$/);
    await assert.rejects(collect({ "001.sql": "create table t (a int);\nalter table t add constraint c check (a > 0) initially deferred;" }), /001\.sql:2:46: CHECK constraints cannot be marked DEFERRABLE$/);
  });

  test("a constraint that is not enforced is kept with that said: the schema has no place for it, and the constraint is not one that is", async () => {
    const result = await collect({ "001.sql": "create table p (id int primary key);\ncreate table t (a int, p_id int, constraint c check (a > 0) not enforced, constraint f foreign key (p_id) references p (id) not enforced);" });
    assert.deepEqual(table(result, "t").checks?.[0]?.sourceClauses, ["NOT ENFORCED"]);
    assert.deepEqual(column(result, "t", "p_id").references?.sourceClauses, ["NOT ENFORCED"]);
    // A foreign key is enforced again by ALTER CONSTRAINT.
    const enforced = await collect({ "001.sql": "create table p (id int primary key);\ncreate table t (p_id int, constraint f foreign key (p_id) references p (id) not enforced);\nalter table t alter constraint f enforced;" });
    assert.equal(column(enforced, "t", "p_id").references?.sourceClauses, undefined);
  });

  test("is changed by ALTER CONSTRAINT, which PostgreSQL has for foreign keys", async () => {
    const base = "create table p (id int primary key, a int, b int, unique (a, b));\ncreate table c (x int references p (id), a int, b int, constraint pair foreign key (a, b) references p (a, b) deferrable initially deferred);\n";
    const result = await collect({ "001.sql": `${base}alter table c alter constraint c_x_fkey deferrable initially deferred;\nalter table c alter constraint pair not deferrable;` });
    assert.equal(column(result, "c", "x").references?.deferrable, "deferred");
    assert.equal(table(result, "c").foreignKeys?.[0]?.deferrable, undefined);
    assert.equal((await collect({ "001.sql": `${base}alter table c alter constraint c_x_fkey initially deferred;\nalter table c alter constraint pair deferrable;` })).tables[1]?.foreignKeys?.[0]?.deferrable, "immediate");
    await refused(`${base}alter table p alter constraint p_pkey deferrable;`, /^001\.sql:3: constraint "p_pkey" of relation "p" is not a foreign key constraint\.$/);
    await refused(`${base}alter table p alter constraint p_a_b_key deferrable;`, /constraint "p_a_b_key" of relation "p" is not a foreign key constraint/);
    await refused(`${base}alter table c alter constraint nope deferrable;`, /constraint "nope" of relation "c" does not exist/);
  });
});

describe("what a constraint says that the schema has no place for", () => {
  test("is kept as the clause it is: how a foreign key matches, what it sets to NULL, and what a key carries along", async () => {
    const result = await collect({
      "001.sql": `
        create table p (id int primary key, a int, b int, unique (a, b));
        create table c (x int references p (id) match full, a int, b int,
          constraint full_fk foreign key (a, b) references p (a, b) match full on delete set null (a),
          constraint plain_fk foreign key (a, b) references p (a, b) match simple on delete set null,
          constraint k unique (x) include (a) with (fillfactor = 70) using index tablespace fast,
          constraint pk primary key (a, b) include (x),
          constraint ck check (x > 0) no inherit);`,
    });
    const c = table(result, "c");
    assert.deepEqual(column(result, "c", "x").references?.sourceClauses, ["MATCH FULL"]);
    assert.deepEqual(c.foreignKeys?.map((key) => [key.name, key.onDelete, key.sourceClauses]), [
      ["full_fk", "SET NULL", ["MATCH FULL", "ON DELETE SET NULL (a)"]],
      ["plain_fk", "SET NULL", undefined],
    ]);
    // What a key carries along is kept as what it is, not as a clause.
    assert.deepEqual(c.uniques?.map((unique) => [unique.name, unique.include, unique.sourceClauses]), [["k", ["a"], ["WITH (fillfactor=70)", "USING INDEX TABLESPACE fast"]]]);
    assert.deepEqual([c.primaryKey?.include, c.primaryKey?.sourceClauses], [["x"], undefined]);
    assert.deepEqual(c.checks?.map((check) => [check.name, check.sourceClauses]), [["ck", ["NO INHERIT"]]]);
  });

  test("a unique constraint that takes two NULLs for the same is kept as that", async () => {
    const result = await collect({ "001.sql": "create table t (a int, b int, constraint u unique nulls not distinct (a, b), constraint v unique (a));" });
    assert.deepEqual(table(result, "t").uniques?.map((unique) => [unique.name, unique.nullsNotDistinct]), [["u", true], ["v", undefined]]);
  });

  test("a constraint that was added without being checked is NOT VALID until it is validated; one made with its table is valid from the start", async () => {
    const base = "create table p (id int primary key);\ncreate table c (x int, constraint made_with_table check (x < 100) not valid);\nalter table c add constraint fk foreign key (x) references p (id) not valid;\nalter table c add constraint ck check (x > 0) not valid;\n";
    const pending = table(await collect({ "001.sql": base }), "c");
    assert.deepEqual(pending.checks?.map((check) => [check.name, check.sourceClauses]), [["made_with_table", undefined], ["ck", ["NOT VALID"]]]);
    assert.deepEqual(column(await collect({ "001.sql": base }), "c", "x").references?.sourceClauses, ["NOT VALID"]);
    const validated = await collect({ "001.sql": `${base}alter table c validate constraint fk;\nalter table c validate constraint ck;` });
    assert.equal(table(validated, "c").checks?.[1]?.sourceClauses, undefined);
    assert.equal(column(validated, "c", "x").references?.sourceClauses, undefined);
  });
});
