import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHANGE_ORDER, diffSchemas, formatSchemaChange, formatSchemaDiff } from "../src/index.ts";
import type { RenameEvidence, SchemaChange } from "../src/index.ts";
import { exampleAfter, exampleBefore } from "./example.ts";
import { column, keyColumn, origin, renamed, schema, table } from "./support.ts";

describe("a schema diff as lines for people", () => {
  test("says that there are no differences", () => {
    assert.deepEqual(formatSchemaDiff(diffSchemas(exampleBefore(), exampleBefore())), ["No differences."]);
  });

  test("counts the changes, and gives one line to each: + added, - dropped, ~ changed", () => {
    assert.deepEqual(formatSchemaDiff(diffSchemas(exampleBefore(), exampleAfter())), [
      "29 changes:",
      "  - foreign key posts (author_id) -> users (id) on delete cascade [posts_author_id_fkey]",
      "  - check users (name <> '')",
      "  - check users (age > 0) [users_age_check]",
      "  - index users_age_idx on users",
      "  - column posts.title",
      "  - table old_logs",
      "  ~ enum status renamed to post_status (0002_rename.sql:3)",
      "  ~ enum post_status: value live renamed to public (0002_rename.sql:4)",
      "  ~ table users renamed to accounts (0002_rename.sql:1)",
      "  ~ column accounts.name renamed to full_name (0002_rename.sql:2)",
      "  ~ primary key posts_pkey of posts renamed to posts_key (0002_rename.sql:5)",
      "  + enum kind (a, b)",
      "  + enum mood: value great after meh",
      "  + enum post_status: value review after draft",
      "  + table audit (1 column, primary key (id))",
      "  + table comments (3 columns, primary key (id))",
      "  + column accounts.created_at timestamp with time zone not null default current_timestamp",
      "  + column accounts.kind enum kind",
      "  + column posts.slug text",
      "  ~ column accounts.age: type integer -> bigint",
      "  ~ column accounts.age: not null",
      "  - enum legacy",
      "  + unique accounts (full_name) [accounts_full_name_key]",
      "  + check accounts (full_name <> '')",
      "  + check accounts (age >= 0) [users_age_check]",
      "  + index accounts_created_idx on accounts (created_at)",
      "  + index comments_post_idx on comments (post_id)",
      "  + foreign key comments (post_id) -> posts (id) [comments_post_id_fkey]",
      "  + foreign key posts (author_id) -> accounts (id) on delete set null [posts_author_id_fkey]",
    ]);
  });

  test("says one change, not one changes", () => {
    const before = schema([table("t", [keyColumn("id")])]);
    const after = schema([table("t", [keyColumn("id"), column("n")])]);
    assert.deepEqual(formatSchemaDiff(diffSchemas(before, after)), ["1 change:", "  + column t.n integer"]);
  });

  const evidence: RenameEvidence = { origin: origin("old"), renames: [renamed("old", "mid", "0002.sql", 4), renamed("mid", "new", "0003.sql", 9)] };

  /** The kinds of change the example above does not have, and other shapes of some it has. */
  const LINES: [SchemaChange, string][] = [
    // A rename is shown with where the last rename was made.
    [{ op: "renameIndex", table: "t", index: "new", from: "old", evidence }, "~ index old of t renamed to new (0003.sql:9)"],
    [{ op: "renameConstraint", table: "t", kind: "unique", constraint: "new", from: "old", evidence }, "~ unique old of t renamed to new (0003.sql:9)"],
    [{ op: "renameConstraint", table: "t", kind: "foreignKey", constraint: "new", from: "old", evidence }, "~ foreign key old of t renamed to new (0003.sql:9)"],
    [{ op: "renameConstraint", table: "t", kind: "check", constraint: "new", from: "old", evidence }, "~ check old of t renamed to new (0003.sql:9)"],
    [{ op: "dropUnique", table: "t", constraint: "t_a_b_key", before: { name: "t_a_b_key", columns: ["a", "b"] } }, "- unique t (a, b) [t_a_b_key]"],
    [{ op: "dropUnique", table: "t", before: { columns: ["a"] } }, "- unique t (a)"],
    [{ op: "dropPrimaryKey", table: "t", constraint: "t_pkey", before: { name: "t_pkey", columns: ["a", "b"] } }, "- primary key t (a, b) [t_pkey]"],
    [{ op: "addPrimaryKey", table: "t", after: { columns: ["a"] } }, "+ primary key t (a)"],
    [{ op: "addEnumValue", enum: "e", value: "a", beforeValue: "b" }, "+ enum e: value a before b"],
    [{ op: "addEnumValue", enum: "e", value: "a" }, "+ enum e: value a"],
    [{ op: "removeEnumValue", enum: "e", value: "b" }, "- enum e: value b"],
    [{ op: "replaceEnumValues", enum: "e", before: ["a", "b"], after: ["b", "a"] }, "~ enum e: values (a, b) -> (b, a)"],
    [{ op: "addTable", table: "t", after: { name: "t", columns: [], uniques: [], checks: [] } }, "+ table t (0 columns)"],
    [{ op: "dropNotNull", table: "t", column: "c" }, "~ column t.c: nullable"],
    [{ op: "dropDefault", table: "t", column: "c", before: { kind: "value", value: 0 } }, "~ column t.c: default 0 dropped"],
    [{ op: "setDefault", table: "t", column: "c", after: { kind: "value", value: "x" } }, '~ column t.c: default none -> "x"'],
    [{ op: "setDefault", table: "t", column: "c", before: { kind: "increment" }, after: { kind: "function", function: "current_date" } }, "~ column t.c: default the next number -> current_date"],
    [
      { op: "setDefault", table: "t", column: "c", before: { kind: "generated", strategy: "uuid", expression: "gen_random_uuid()" }, after: { kind: "expression", expression: "upper('x')" } },
      "~ column t.c: default generated uuid (gen_random_uuid()) -> upper('x')",
    ],
    // Types that were compared as declared: the line says which of storage type, spelling, and enumerated type differ.
    [
      { op: "alterColumnType", table: "t", column: "c", before: { storage: "text", declared: "varchar(20)" }, after: { storage: "text", enum: "mood" }, comparedBy: "declared" },
      "~ column t.c: declared type varchar(20) -> none, enumerated type none -> mood (compared as declared)",
    ],
    [{ op: "alterColumnType", table: "t", column: "c", before: { storage: "integer" }, after: { storage: "text" }, comparedBy: "declared" }, "~ column t.c: storage type integer -> text (compared as declared)"],
    // One side says nothing about how the type was declared: that is what differs, not "boolean -> boolean".
    [
      { op: "alterColumnType", table: "t", column: "c", before: { storage: "boolean" }, after: { storage: "boolean", declared: "boolean" }, comparedBy: "declared" },
      "~ column t.c: declared type none -> boolean (compared as declared)",
    ],
    [
      { op: "alterColumnType", table: "t", column: "c", before: { storage: "integer", declared: "int" }, after: { storage: "integer", canonical: { kind: "integer", bits: 32 }, declared: "integer" }, comparedBy: "declared" },
      "~ column t.c: declared type int -> integer (compared as declared)",
    ],
    [
      { op: "alterColumnType", table: "t", column: "c", before: { storage: "text", enum: "mood" }, after: { storage: "text", canonical: { kind: "enum", name: "feeling" }, declared: "feeling" }, comparedBy: "declared" },
      "~ column t.c: declared type none -> feeling, enumerated type mood -> feeling (compared as declared)",
    ],
    // A column that is added or dropped is shown by the most that is known of its type.
    [{ op: "addColumn", table: "t", column: "c", after: { name: "c", type: { storage: "text", declared: "varchar(20)" }, nullable: true } }, "+ column t.c varchar(20)"],
    [{ op: "addColumn", table: "t", column: "c", after: { name: "c", type: { storage: "text", enum: "mood" }, nullable: true } }, "+ column t.c enum mood"],
    [{ op: "addColumn", table: "t", column: "c", after: { name: "c", type: { storage: "json" }, nullable: false, default: { kind: "value", value: { a: [1] } } } }, '+ column t.c json not null default {"a":[1]}'],
    [
      {
        op: "alterColumnType",
        table: "t",
        column: "c",
        before: { storage: "numeric", canonical: { kind: "decimal", precision: 12, scale: 2 } },
        after: { storage: "json", canonical: { kind: "array", element: { kind: "other", dialect: "postgresql", name: "geometry", modifiers: ["point", 4326] } } },
        comparedBy: "canonical",
      },
      "~ column t.c: type numeric(12,2) -> geometry(point,4326) (postgresql)[]",
    ],
    [
      { op: "addIndex", table: "t", index: "i", after: { name: "i", columns: ["a"], expressions: ["lower(b)"], unique: true, where: "c is null" } },
      "+ unique index i on t (a, lower(b)) where c is null",
    ],
    [
      { op: "addForeignKey", table: "t", after: { columns: ["a", "b"], references: { table: "pairs", columns: ["x", "y"] }, onDelete: "SET NULL", onUpdate: "CASCADE" } },
      "+ foreign key t (a, b) -> pairs (x, y) on delete set null, on update cascade",
    ],
  ];

  test("gives every kind of change a line that names what changed", () => {
    for (const [change, line] of LINES) {
      assert.equal(formatSchemaChange(change), line);
    }
  });

  test("has a line for each of the kinds there are", () => {
    const shown = new Set([...diffSchemas(exampleBefore(), exampleAfter()).changes, ...LINES.map(([change]) => change)].map((change) => change.op));
    assert.deepEqual(CHANGE_ORDER.filter((op) => !shown.has(op)), []);
  });
});
