import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CheckConstraint, ColumnSchema, DatabaseSchema, ExpressionName, IndexDefinition, TableSchema } from "../../runtime/src/index.ts";
import { INTEGER, TEXT, TIMESTAMPTZ, column, enumType, keyColumn, origin, renamed, schema, table } from "../../schema-diff/test/support.ts";
import { statementSql } from "../src/postgres/statements.ts";
import type { PostgresGeneration, StepAssessment } from "../src/postgres/index.ts";
import { arrives, generate, statementsOf } from "./support/postgres-round-trip.ts";

/*
 * The PostgreSQL generator on what the canonical schema holds since D-040:
 * how an index is built and what its keys are, what a key or a constraint is
 * beyond its columns, and what the text of an expression names. What the
 * schema holds is written; what it only says exists (`sourceClauses`) and a
 * text that a rename has left behind are refused, never written some other
 * way.
 */

const brief = (steps: readonly StepAssessment[]): string[] => steps.filter((step) => step.safety !== "safe").map((step) => `${step.step}. ${step.operation}: ${step.safety} (${step.reason})`);

function refusals(before: DatabaseSchema, after: DatabaseSchema): StepAssessment[] {
  const { generation } = generate(before, after);
  assert.equal(generation.status, "refused", "a migration was generated");
  return generation.status === "refused" ? generation.refusals : [];
}

const sqlOf = (generation: PostgresGeneration): string[] => (generation.status === "generated" ? statementsOf(generation.migration).map((statement) => statement.sql) : assert.fail(`refused: ${JSON.stringify(generation.refusals)}`));
const written = (before: DatabaseSchema, after: DatabaseSchema): string[] => sqlOf(generate(before, after).generation);

describe("PostgreSQL statements: an index with all that it is", () => {
  const index = (more: object): string => statementSql({ kind: "createIndex", index: "i", table: "t", unique: false, columns: ["a"], expressions: [], ...more });

  test("an index over columns alone, or over expressions alone, is written as it always was", () => {
    assert.equal(index({}), `CREATE INDEX "i" ON "t" ("a")`);
    assert.equal(index({ columns: [], expressions: ["lower(b)", "a + 1"], unique: true, where: "a > 0" }), `CREATE UNIQUE INDEX "i" ON "t" ((lower(b)), (a + 1)) WHERE (a > 0)`);
  });

  test("how it is built is said by the name PostgreSQL has for it", () => {
    assert.equal(index({ method: "gin" }), `CREATE INDEX "i" ON "t" USING "gin" ("a")`);
    assert.equal(index({ method: "hnsw" }), `CREATE INDEX "i" ON "t" USING "hnsw" ("a")`);
  });

  test("its keys stand in their order, each with its collation, its operator class, its direction, and where its NULLs stand", () => {
    assert.equal(
      index({
        columns: ["b", "a"],
        expressions: ["lower(c)"],
        keys: [{ column: "b", order: "desc", nulls: "last", operatorClass: "text_pattern_ops", collation: "C" }, { expression: "lower(c)", order: "desc" }, { column: "a", nulls: "first" }],
      }),
      `CREATE INDEX "i" ON "t" ("b" COLLATE "C" "text_pattern_ops" DESC NULLS LAST, (lower(c)) DESC, "a" NULLS FIRST)`,
    );
    // A name with a schema is two names.
    assert.equal(index({ keys: [{ column: "a", operatorClass: "public.my_ops", collation: "pg_catalog.C" }] }), `CREATE INDEX "i" ON "t" ("a" COLLATE "pg_catalog"."C" "public"."my_ops")`);
  });

  test("what it carries along, whether two NULLs are the same to it, and its condition, in the order PostgreSQL has them", () => {
    assert.equal(index({ unique: true, include: ["b", "c"], nullsNotDistinct: true, where: "d > 0", method: "btree_gist" }), `CREATE UNIQUE INDEX "i" ON "t" USING "btree_gist" ("a") INCLUDE ("b", "c") NULLS NOT DISTINCT WHERE (d > 0)`);
  });

  test("a name in it is a name, whatever it holds", () => {
    assert.equal(index({ method: 'gin"; drop table t; --', include: ['b") --'], keys: [{ column: "a", operatorClass: 'x" desc', collation: 'C"' }] }), `CREATE INDEX "i" ON "t" USING "gin""; drop table t; --" ("a" COLLATE "C""" "x"" desc") INCLUDE ("b"") --")`);
  });
});

describe("PostgreSQL statements: a key and a constraint with all that they are", () => {
  const added = (constraint: object): string => statementSql({ kind: "addConstraint", table: "t", constraint: constraint as never });

  test("a primary key and a unique constraint: what they carry along, whether two NULLs are the same, and whether they are deferrable", () => {
    assert.equal(added({ kind: "primaryKey", name: "t_pkey", columns: ["id"], include: ["a", "b"], deferrable: "deferred" }), `ALTER TABLE "t" ADD CONSTRAINT "t_pkey" PRIMARY KEY ("id") INCLUDE ("a", "b") DEFERRABLE INITIALLY DEFERRED`);
    assert.equal(added({ kind: "unique", name: "u", columns: ["a"], include: ["b"], nullsNotDistinct: true, deferrable: "immediate" }), `ALTER TABLE "t" ADD CONSTRAINT "u" UNIQUE NULLS NOT DISTINCT ("a") INCLUDE ("b") DEFERRABLE`);
    assert.equal(added({ kind: "unique", columns: ["a"] }), `ALTER TABLE "t" ADD UNIQUE ("a")`);
  });

  test("a foreign key that is deferrable says so after its actions", () => {
    const key = { kind: "foreignKey", name: "f", columns: ["p_id"], references: { table: "p", columns: ["id"] }, onDelete: "CASCADE", onUpdate: "NO ACTION" };
    assert.equal(added({ ...key, deferrable: "deferred" }), `ALTER TABLE "t" ADD CONSTRAINT "f" FOREIGN KEY ("p_id") REFERENCES "p" ("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`);
    assert.equal(added({ ...key, deferrable: "immediate" }), `ALTER TABLE "t" ADD CONSTRAINT "f" FOREIGN KEY ("p_id") REFERENCES "p" ("id") ON DELETE CASCADE DEFERRABLE`);
  });
});

const COLUMNS = (): ColumnSchema[] => [keyColumn("id"), column("a"), column("b", TEXT), column("tags", TEXT)];
/** The same columns of a table that has no key yet. */
const KEYLESS = (): ColumnSchema[] => [column("id", INTEGER, { nullable: false }), ...COLUMNS().slice(1)];
const bare = (): DatabaseSchema => schema([table("p", [keyColumn("id")], { primaryKey: { name: "p_pkey", columns: ["id"] } }), table("t", COLUMNS(), { primaryKey: { name: "t_pkey", columns: ["id"] } })]);
const withT = (more: Partial<TableSchema>, columns: ColumnSchema[] = COLUMNS()): DatabaseSchema => schema([table("p", [keyColumn("id")], { primaryKey: { name: "p_pkey", columns: ["id"] } }), table("t", columns, { primaryKey: { name: "t_pkey", columns: ["id"] }, ...more })]);

describe("PostgreSQL generator: indexes", () => {
  test("an index is written with how it is built, its keys in their order, and what it carries along; the migration arrives", async () => {
    const indexes: IndexDefinition[] = [
      { name: "by_tags", columns: ["tags"], method: "gin", keys: [{ column: "tags", operatorClass: "gin_trgm_ops" }] },
      { name: "ordered", columns: ["a", "b"], unique: true, keys: [{ column: "a", order: "desc", nulls: "last" }, { column: "b", collation: "C" }], include: ["tags"], nullsNotDistinct: true, where: "a > 0", names: [{ kind: "column", name: "a" }] },
      { name: "mixed", columns: ["a"], expressions: ["lower(b)"], keys: [{ expression: "lower(b)" }, { column: "a" }], names: [{ kind: "column", name: "b" }] },
      { name: "hashed", columns: ["b"], method: "hash" },
    ];
    const { sql } = await arrives(bare(), withT({ indexes }));
    assert.deepEqual(sql, [
      `CREATE INDEX "by_tags" ON "t" USING "gin" ("tags" "gin_trgm_ops")`,
      `CREATE INDEX "hashed" ON "t" USING "hash" ("b")`,
      `CREATE INDEX "mixed" ON "t" ((lower(b)), "a")`,
      `CREATE UNIQUE INDEX "ordered" ON "t" ("a" DESC NULLS LAST, "b" COLLATE "C") INCLUDE ("tags") NULLS NOT DISTINCT WHERE (a > 0)`,
    ]);
    // And back: an index is dropped by its name, whatever it is.
    assert.deepEqual((await arrives(withT({ indexes }), bare())).sql, [`DROP INDEX "by_tags"`, `DROP INDEX "hashed"`, `DROP INDEX "mixed"`, `DROP INDEX "ordered"`]);
  });

  test("an index that is another index of the same name goes and comes: it is not changed in place", async () => {
    const one = (index: Partial<IndexDefinition>): DatabaseSchema => withT({ indexes: [{ name: "i", columns: ["tags"], ...index }] });
    assert.deepEqual((await arrives(one({}), one({ method: "gin" }))).sql, [`DROP INDEX "i"`, `CREATE INDEX "i" ON "t" USING "gin" ("tags")`]);
    assert.deepEqual((await arrives(one({ columns: ["a", "b"] }), one({ columns: ["a", "b"], keys: [{ column: "a" }, { column: "b", order: "desc" }] }))).sql, [`DROP INDEX "i"`, `CREATE INDEX "i" ON "t" ("a", "b" DESC)`]);
  });

  test("an index over columns and expressions that does not say in which order they stand is refused, as it was", () => {
    const refused = refusals(bare(), withT({ indexes: [{ name: "i", columns: ["a"], expressions: ["lower(b)"] }] }));
    assert.deepEqual(brief(refused), ['1. addIndex "i" of table "t": unsupported (index-elements-order-unknown)']);
  });

  test("an index of which the schema only says that there is more to it is refused: written from the rest, it would be another index", () => {
    const refused = refusals(bare(), withT({ indexes: [{ name: "i", columns: ["a"], sourceClauses: ["WITH (fillfactor=70)", "TABLESPACE fast"] }] }));
    assert.deepEqual(brief(refused), ['1. addIndex "i" of table "t": unsupported (index-not-representable)']);
    assert.equal(refused[0]?.detail, 'The index "i" of table "t" says what the schema has no place for: WITH (fillfactor=70), TABLESPACE fast. Written from the rest, it would be another index.');
    // One that only goes is dropped by its name.
    assert.deepEqual(written(withT({ indexes: [{ name: "i", columns: ["a"], sourceClauses: ["WITH (fillfactor=70)"] }] }), bare()), [`DROP INDEX "i"`]);
  });
});

describe("PostgreSQL generator: keys and constraints", () => {
  test("a key carries columns along, and a key, a unique constraint, and a foreign key are deferrable, added to a table and created with one", async () => {
    const more: Partial<TableSchema> = {
      primaryKey: { name: "t_pkey", columns: ["id"], include: ["a"], deferrable: "deferred" },
      uniques: [
        { name: "t_b", columns: ["b"], include: ["tags"], nullsNotDistinct: true, deferrable: "immediate" },
        { name: "t_tags", columns: ["tags"] },
      ],
    };
    const columns = [...COLUMNS(), column("p_id", INTEGER, { references: { table: "p", column: "id", name: "t_p", onDelete: "CASCADE", deferrable: "deferred" } })];
    const before = schema([table("p", [keyColumn("id")], { primaryKey: { name: "p_pkey", columns: ["id"] } }), table("t", [...KEYLESS(), column("p_id")])]);
    const after = withT(more, columns);
    assert.deepEqual((await arrives(before, after)).sql, [
      `ALTER TABLE "t" ADD CONSTRAINT "t_pkey" PRIMARY KEY ("id") INCLUDE ("a") DEFERRABLE INITIALLY DEFERRED`,
      `ALTER TABLE "t" ADD CONSTRAINT "t_b" UNIQUE NULLS NOT DISTINCT ("b") INCLUDE ("tags") DEFERRABLE`,
      `ALTER TABLE "t" ADD CONSTRAINT "t_tags" UNIQUE ("tags")`,
      `ALTER TABLE "t" ADD CONSTRAINT "t_p" FOREIGN KEY ("p_id") REFERENCES "p" ("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`,
    ]);
    const created = (await arrives(schema([after.tables[0] as TableSchema]), after)).sql;
    assert.deepEqual(created, [
      [
        `CREATE TABLE "t" (`,
        `  "id" integer NOT NULL,`,
        `  "a" integer,`,
        `  "b" text,`,
        `  "tags" text,`,
        `  "p_id" integer,`,
        `  CONSTRAINT "t_pkey" PRIMARY KEY ("id") INCLUDE ("a") DEFERRABLE INITIALLY DEFERRED,`,
        `  CONSTRAINT "t_b" UNIQUE NULLS NOT DISTINCT ("b") INCLUDE ("tags") DEFERRABLE,`,
        `  CONSTRAINT "t_tags" UNIQUE ("tags")`,
        `)`,
      ].join("\n"),
      `ALTER TABLE "t" ADD CONSTRAINT "t_p" FOREIGN KEY ("p_id") REFERENCES "p" ("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED`,
    ]);
  });

  test("a constraint that becomes deferrable, or stops being it, goes and comes", async () => {
    const one = (deferrable?: "immediate" | "deferred"): DatabaseSchema => withT({ uniques: [{ name: "t_b", columns: ["b"], ...(deferrable !== undefined && { deferrable }) }] });
    assert.deepEqual((await arrives(one(), one("deferred"))).sql, [`ALTER TABLE "t" DROP CONSTRAINT "t_b"`, `ALTER TABLE "t" ADD CONSTRAINT "t_b" UNIQUE ("b") DEFERRABLE INITIALLY DEFERRED`]);
    assert.deepEqual((await arrives(one("deferred"), one("immediate"))).sql, [`ALTER TABLE "t" DROP CONSTRAINT "t_b"`, `ALTER TABLE "t" ADD CONSTRAINT "t_b" UNIQUE ("b") DEFERRABLE`]);
  });

  test("a foreign key does not rest on a deferrable key: PostgreSQL makes none with one", () => {
    const target = (deferrable: boolean): TableSchema => table("p", [keyColumn("id"), column("code", TEXT)], { primaryKey: { name: "p_pkey", columns: ["id"] }, uniques: [{ name: "p_code", columns: ["code"], ...(deferrable && { deferrable: "immediate" as const }) }] });
    const referring = (reference: boolean): TableSchema => table("c", [keyColumn("id"), column("code", TEXT, reference ? { references: { table: "p", column: "code", name: "c_code" } } : {})], { primaryKey: { name: "c_pkey", columns: ["id"] } });
    const refused = refusals(schema([target(true), referring(false)]), schema([target(true), referring(true)]));
    assert.deepEqual(brief(refused), ['1. addForeignKey "c_code" of table "c": unsupported (foreign-key-without-key)']);
    assert.equal(
      refused[0]?.detail,
      'The foreign key "c_code" of table "c" refers to "p" (code), and no primary key, unique constraint, or unique index is over exactly those columns at this step. PostgreSQL makes a foreign key with one. (The unique constraint "p_code" is over them and is deferrable: PostgreSQL rests no foreign key on a deferrable key.)',
    );
    assert.deepEqual(written(schema([target(false), referring(false)]), schema([target(false), referring(true)])), [`ALTER TABLE "c" ADD CONSTRAINT "c_code" FOREIGN KEY ("code") REFERENCES "p" ("code")`]);
    // The same of a primary key: PostgreSQL says "cannot use a deferrable primary key for referenced table".
    const keyed = (deferrable: boolean): TableSchema => table("p", [keyColumn("id")], { primaryKey: { name: "p_pkey", columns: ["id"], ...(deferrable && { deferrable: "deferred" as const }) } });
    const child = (reference: boolean): TableSchema => table("c", [keyColumn("id"), column("p_id", INTEGER, reference ? { references: { table: "p", column: "id", name: "c_p" } } : {})], { primaryKey: { name: "c_pkey", columns: ["id"] } });
    const byKey = refusals(schema([keyed(true), child(false)]), schema([keyed(true), child(true)]));
    assert.deepEqual(brief(byKey), ['1. addForeignKey "c_p" of table "c": unsupported (foreign-key-without-key)']);
    assert.match(byKey[0]?.detail ?? "", / \(The primary key "p_pkey" is over them and is deferrable: PostgreSQL rests no foreign key on a deferrable key\.\)$/);
    assert.deepEqual(written(schema([keyed(false), child(false)]), schema([keyed(false), child(true)])), [`ALTER TABLE "c" ADD CONSTRAINT "c_p" FOREIGN KEY ("p_id") REFERENCES "p" ("id")`]);
  });

  test("a constraint of which the schema only says that there is more to it is refused, wherever it would be written", () => {
    const reference = { table: "p", column: "id", name: "t_p", sourceClauses: ["MATCH FULL"] };
    const columns = [...COLUMNS(), column("p_id", INTEGER, { references: reference })];
    const after = withT(
      {
        primaryKey: { name: "t_pkey", columns: ["id"], sourceClauses: ["USING INDEX TABLESPACE fast"] },
        uniques: [{ name: "t_b", columns: ["b"], sourceClauses: ["WITH (fillfactor=70)"] }],
        checks: [{ name: "t_a", expression: "a > 0", names: [{ kind: "column", name: "a" }], sourceClauses: ["NO INHERIT"] }],
      },
      columns,
    );
    const before = schema([table("p", [keyColumn("id")], { primaryKey: { name: "p_pkey", columns: ["id"] } }), table("t", [...KEYLESS(), column("p_id")])]);
    const refused = refusals(before, after);
    assert.deepEqual(brief(refused), [
      '1. addPrimaryKey "t_pkey" of table "t": unsupported (constraint-not-representable)',
      '2. addUnique "t_b" of table "t": unsupported (constraint-not-representable)',
      '3. addCheck "t_a" of table "t": unsupported (constraint-not-representable)',
      '4. addForeignKey "t_p" of table "t": unsupported (constraint-not-representable)',
    ]);
    assert.equal(refused[3]?.detail, 'The foreign key "t_p" of table "t" says what the schema has no place for: MATCH FULL. Written from the rest, it would be another constraint.');
    // In a table that is created, too.
    assert.deepEqual(brief(refusals(schema([after.tables[0] as TableSchema]), after)), ['1. addTable "t": unsupported (constraint-not-representable)', '2. addForeignKey "t_p" of table "t": unsupported (constraint-not-representable)']);
    // What only goes is dropped by its name.
    assert.deepEqual(written(after, before), [`ALTER TABLE "t" DROP CONSTRAINT "t_p"`, `ALTER TABLE "t" DROP CONSTRAINT "t_a"`, `ALTER TABLE "t" DROP CONSTRAINT "t_b"`, `ALTER TABLE "t" DROP CONSTRAINT "t_pkey"`]);
  });

  test("a foreign key that has to go for a step and come back is not written back when there is more to it than the schema holds", () => {
    const users = (key: "primary" | "unique"): TableSchema =>
      table("p", [column("id", INTEGER, { nullable: false, primary: key === "primary" })], key === "primary" ? { primaryKey: { name: "p_pkey", columns: ["id"] } } : { uniques: [{ name: "p_id_key", columns: ["id"] }] });
    const referring = (clauses: string[]): TableSchema => table("c", [column("p_id", INTEGER, { references: { table: "p", column: "id", name: "c_p", ...(clauses.length > 0 && { sourceClauses: clauses }) } })]);
    const refused = refusals(schema([users("primary"), referring(["MATCH FULL"])]), schema([users("unique"), referring(["MATCH FULL"])]));
    assert.deepEqual(brief(refused), ['1. dropPrimaryKey "p_pkey" of table "p": unsupported (constraint-not-representable)']);
    // One that the schema holds all of comes back as it was, deferrable too.
    const deferred = (key: "primary" | "unique"): DatabaseSchema => schema([users(key), table("c", [column("p_id", INTEGER, { references: { table: "p", column: "id", name: "c_p", deferrable: "deferred" } })])]);
    assert.deepEqual(written(deferred("primary"), deferred("unique")), [
      `ALTER TABLE "c" DROP CONSTRAINT "c_p"`,
      `ALTER TABLE "p" DROP CONSTRAINT "p_pkey"`,
      `ALTER TABLE "p" ADD CONSTRAINT "p_id_key" UNIQUE ("id")`,
      `ALTER TABLE "c" ADD CONSTRAINT "c_p" FOREIGN KEY ("p_id") REFERENCES "p" ("id") DEFERRABLE INITIALLY DEFERRED`,
    ]);
  });
});

describe("PostgreSQL generator: an expression whose text a rename has left behind", () => {
  const STALE: ExpressionName[] = [
    { kind: "column", name: "a", now: "amount" },
    { kind: "column", name: "id" },
  ];
  const renamedT = (more: Partial<TableSchema>, columns: ColumnSchema[] = []): DatabaseSchema => schema([table("t", [keyColumn("id"), column("amount"), column("a", TEXT), ...columns], { primaryKey: { name: "t_pkey", columns: ["id"] }, ...more })]);
  const DETAIL = (what: string, text: string): string =>
    `${what} was written as (${text}) when things had other names: column "a" is "amount" now. PostgreSQL has what the text meant, and the schema has the text as it was written: written into a database again, it would be refused, or be of whatever has that name by now.`;

  test("a check, an index, and a default that are stale are refused, each with the names it is stale by", () => {
    const stale: ExpressionName[] = [{ kind: "function", name: "slug", now: "make_slug" }];
    const after = renamedT({ checks: [{ name: "k", expression: "a > id", names: STALE }], indexes: [{ name: "i", columns: [], expressions: ["a + id"], where: "a > 0", names: STALE }] }, [column("code", TEXT, { defaultExpression: "slug('x')", defaultNames: stale })]);
    const refused = refusals(renamedT({}), after);
    assert.deepEqual(brief(refused), ['1. addColumn "t"."code": unsupported (stale-expression-after-rename)', '2. addCheck "k" of table "t": unsupported (stale-expression-after-rename)', '3. addIndex "i" of table "t": unsupported (stale-expression-after-rename)']);
    assert.equal(refused[1]?.detail, DETAIL('The check "k" of table "t"', "a > id"));
    assert.equal(refused[2]?.detail, DETAIL('The index "i" of table "t"', "a + id; a > 0"));
    assert.match(refused[0]?.detail ?? "", /^The default of the column "t"\."code" was written as \(slug\('x'\)\) when things had other names: function "slug" is "make_slug" now\./);
  });

  test("a table that is created with one, and a default that is set to one, are refused", () => {
    const after = renamedT({ checks: [{ name: "k", expression: "a > id", names: STALE }] });
    assert.deepEqual(brief(refusals(schema([]), after)), ['1. addTable "t": unsupported (stale-expression-after-rename)']);
    const defaulted = (names: ExpressionName[], expression = "pick('x')"): DatabaseSchema => renamedT({}, [column("code", TEXT, { defaultExpression: expression, defaultNames: names })]);
    assert.deepEqual(brief(refusals(defaulted([], "other('x')"), defaulted([{ kind: "function", name: "pick", now: "choose" }]))), ['1. setDefault "t"."code": unsupported (stale-expression-after-rename)']);
  });

  test("a text of which the schema does not say what it names, and that a rename may have reached, is refused too", () => {
    const refused = refusals(renamedT({}), renamedT({ checks: [{ name: "k", expression: "a > id", mayBeStale: true }] }, [column("code", TEXT, { defaultExpression: "slug('x')", defaultMayBeStale: true })]));
    assert.deepEqual(brief(refused), ['1. addColumn "t"."code": unsupported (stale-expression-after-rename)', '2. addCheck "k" of table "t": unsupported (stale-expression-after-rename)']);
    assert.equal(
      refused[1]?.detail,
      'The check "k" of table "t" has the text (a > id), and the schema does not say what that names, while a rename may have reached it since it was written. It is not written into a database from that: collected again from its migrations, the schema says what each text names.',
    );
  });

  test("a text that names nothing that was renamed, and one of which nothing is known and nothing was renamed, are written", () => {
    const current: ExpressionName[] = [{ kind: "column", name: "amount" }];
    const after = renamedT({ checks: [{ name: "k", expression: "amount > 0", names: current }, { name: "m", expression: "id > 0" }] }, [column("code", TEXT, { defaultExpression: "slug('x')", defaultNames: [] })]);
    assert.deepEqual(written(renamedT({}), after), [`ALTER TABLE "t" ADD COLUMN "code" text DEFAULT (slug('x'))`, `ALTER TABLE "t" ADD CONSTRAINT "k" CHECK (amount > 0)`, `ALTER TABLE "t" ADD CONSTRAINT "m" CHECK (id > 0)`]);
  });

  test("a default that PostgreSQL computes by a name of its own is written by that name when its text is stale: what it is does not rest on the text", () => {
    const stale: ExpressionName[] = [{ kind: "function", name: "my_now", now: "our_now" }];
    const after = renamedT({}, [
      column("at", TIMESTAMPTZ, { defaultFunction: "current_timestamp", defaultExpression: "my_now()", defaultNames: stale }),
      column("uid", { type: "text", canonicalType: { kind: "uuid" }, declaredType: "uuid" }, { generated: "uuid", defaultExpression: "my_uuid()", defaultMayBeStale: true }),
      column("on", TIMESTAMPTZ, { defaultFunction: "current_timestamp", defaultExpression: "timezone('utc', now())", defaultNames: [] }),
    ]);
    assert.deepEqual(written(renamedT({}), after), [
      `ALTER TABLE "t" ADD COLUMN "at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP`,
      `ALTER TABLE "t" ADD COLUMN "on" timestamp with time zone DEFAULT (timezone('utc', now()))`,
      `ALTER TABLE "t" ADD COLUMN "uid" uuid DEFAULT gen_random_uuid()`,
    ]);
  });

  test("a rename by itself is written, and nothing of the texts it leaves behind: PostgreSQL has those under the new name", () => {
    const A = origin("a", "0001_init.sql", 2);
    const of = (name: string): DatabaseSchema =>
      schema([
        table("t", [keyColumn("id"), column(name, INTEGER, { origin: A, ...(name !== "a" && { renames: [renamed("a", name)] }) }), ...(name !== "a" ? [column("a", TEXT, { origin: origin("a", "0003_more.sql") })] : [])], {
          primaryKey: { name: "t_pkey", columns: ["id"] },
          checks: [{ name: "k", expression: "a > 0", names: [{ kind: "column", name: "a", ...(name !== "a" && { now: name }) }], origin: origin("k", "0001_init.sql", 3) }],
        }),
      ]);
    assert.deepEqual(written(of("a"), of("amount")), [`ALTER TABLE "t" RENAME COLUMN "a" TO "amount"`, `ALTER TABLE "t" ADD COLUMN "a" text`]);
  });

  test("a check that is written again over the column that took the name is dropped before the rename and added after it", () => {
    const A = origin("a", "0001_init.sql", 2);
    const check = (again: boolean): CheckConstraint => ({ name: "k", expression: "a > 0", names: [{ kind: "column", name: "a" }], origin: origin("k", again ? "0003_more.sql" : "0001_init.sql", 3) });
    const before = schema([table("t", [keyColumn("id"), column("a", INTEGER, { origin: A })], { primaryKey: { name: "t_pkey", columns: ["id"] }, checks: [check(false)] })]);
    const after = schema([table("t", [keyColumn("id"), column("amount", INTEGER, { origin: A, renames: [renamed("a", "amount")] }), column("a", INTEGER, { origin: origin("a", "0003_more.sql") })], { primaryKey: { name: "t_pkey", columns: ["id"] }, checks: [check(true)] })]);
    assert.deepEqual(written(before, after), [`ALTER TABLE "t" DROP CONSTRAINT "k"`, `ALTER TABLE "t" RENAME COLUMN "a" TO "amount"`, `ALTER TABLE "t" ADD COLUMN "a" integer`, `ALTER TABLE "t" ADD CONSTRAINT "k" CHECK (a > 0)`]);
  });

  test("a default that has to be put back after its column's type was made again is not written back when a rename of the plan has left its text behind", () => {
    const FEELING = origin("feeling", "0001_init.sql", 1);
    const TEXT_OF = "lower('SAD')::feeling";
    const of = (type: string, values: string[], names: ExpressionName[]): DatabaseSchema =>
      schema(
        [table("t", [keyColumn("id"), column("m", enumType(type), { defaultExpression: TEXT_OF, defaultNames: names, origin: origin("m", "0001_init.sql", 3) })], { primaryKey: { name: "t_pkey", columns: ["id"] } })],
        [{ name: type, values, origin: FEELING, ...(type !== "feeling" && { renames: [renamed("feeling", type)] }) }],
      );
    const current: ExpressionName[] = [{ kind: "type", name: "feeling" }];
    // The type is made again under its own name: the text names the new one, and is put back as it is.
    const kept = sqlOf(generate(of("feeling", ["sad", "glad", "mad"], current), of("feeling", ["sad", "glad"], current), { assumeValidData: true }).generation);
    assert.deepEqual(kept.slice(-1), [`ALTER TABLE "t" ALTER COLUMN "m" SET DEFAULT (lower('SAD')::feeling)`]);
    // The plan renames the type too: the text still says the old name, and is not written.
    const { generation } = generate(of("feeling", ["sad", "glad", "mad"], current), of("mood", ["sad", "glad"], [{ kind: "type", name: "feeling", now: "mood" }]), { assumeValidData: true });
    assert.equal(generation.status, "refused");
    assert.deepEqual(brief(generation.status === "refused" ? generation.refusals : []), ['2. removeEnumValue "mad" of enumerated type "mood": unsupported (stale-expression-after-rename)']);
  });
});
