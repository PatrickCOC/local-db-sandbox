import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DatabaseSchema, TableSchema } from "../../runtime/src/index.ts";
import { diffSchemas } from "../../schema-diff/src/index.ts";
import { INTEGER, column, enumType, keyColumn, schema, table } from "../../schema-diff/test/support.ts";
import { MigrationPlanError, applyPlan, planMigration, validatePlan } from "../src/index.ts";
import type { MigrationPlan, MigrationStep } from "../src/index.ts";
import { deepFreeze } from "./support/semantic-form.ts";

/*
 * The validator of plans (D-038): a plan is carried out step by step, each
 * step on the schema as the steps before it have left it, under the rules a
 * database has on the way. A plan that cannot be carried out is refused at
 * the step that cannot be, with what the step is and why. The plans here are
 * written by hand: the planner does not make such plans.
 */

const users = (): TableSchema =>
  table("users", [keyColumn("id"), column("name"), column("state", enumType("status"), { enum: { name: "status", values: ["draft", "live"] }, default: "draft" })], {
    primaryKey: { name: "users_pkey", columns: ["id"] },
    uniques: [{ name: "users_name_key", columns: ["name"] }],
    indexes: [{ name: "users_name_idx", columns: ["name"] }],
  });
const posts = (): TableSchema =>
  table("posts", [keyColumn("id"), column("author", INTEGER, { references: { table: "users", column: "id", name: "posts_author_fkey" } })], { primaryKey: { name: "posts_pkey", columns: ["id"] }, indexes: [{ name: "posts_author_idx", columns: ["author"] }] });
const base = (): DatabaseSchema => schema([users(), posts()], [{ name: "status", values: ["draft", "live"] }]);

const plan = (...steps: MigrationStep[]): MigrationPlan => ({ version: 1, steps });

function refused(steps: MigrationStep[], message: string, step?: number, before: DatabaseSchema = base()): void {
  assert.throws(
    () => validatePlan(deepFreeze(before), plan(...steps)),
    (error: unknown) => {
      assert.ok(error instanceof MigrationPlanError, String(error));
      assert.equal(error.message, message);
      assert.equal(error.step, step);
      return true;
    },
  );
}

const postsState = { name: "posts", columns: [], uniques: [], checks: [] };
const fkState = { name: "posts_author_fkey", columns: ["author"], references: { table: "users", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" };
const dropAuthorKey: MigrationStep = { op: "dropForeignKey", table: "posts", constraint: "posts_author_fkey", before: fkState };

describe("validatePlan: a plan that can be carried out", () => {
  test("is carried out, and gives the schema it leads to; the schema it starts from is not changed", () => {
    const before = deepFreeze(base());
    const result = applyPlan(
      before,
      plan(
        dropAuthorKey,
        { op: "renameTable", table: "migration_tmp_1", from: "users", planned: "rename-cycle", temporaryName: true },
        { op: "renameTable", table: "users", from: "posts" },
        { op: "renameTable", table: "posts", from: "migration_tmp_1" },
        { op: "addEnumValue", enum: "status", value: "archived", afterValue: "live" },
        { op: "setDefault", table: "posts", column: "state", before: { kind: "value", value: "draft" }, after: { kind: "value", value: "archived" } },
        { op: "setDefault", table: "posts", column: "id", after: { kind: "increment" } },
      ),
    );
    assert.deepEqual(result.tables.map((entry) => [entry.name, entry.columns.map((entry2) => entry2.name)]), [["posts", ["id", "name", "state"]], ["users", ["id", "author"]]]);
    assert.equal(result.tables[0]?.columns[2]?.default, "archived");
    // What only the whole says is settled at the end, as when a diff is applied: a numbered single integer key is numbered by the runtime.
    assert.deepEqual([result.tables[0]?.columns[0]?.generated, result.tables[0]?.columns[0]?.autoIncrement], ["increment", true]);
    assert.equal(validatePlan(before, plan()), undefined);
  });
});

describe("validatePlan: a plan that cannot be carried out is refused at the step that cannot be", () => {
  test("a plan of another version, and a step of a kind that is not known", () => {
    assert.throws(() => validatePlan(base(), { version: 2, steps: [] } as unknown as MigrationPlan), (error: unknown) => error instanceof MigrationPlanError && error.message === "This is a migration plan of version 2; version 1 is the one that can be carried out.");
    refused([{ op: "truncateTable", table: "users" } as unknown as MigrationStep], "Step 1, truncateTable: this kind of operation is not known.", 1);
  });

  test("what a step drops or renames must be there when its turn comes", () => {
    refused([{ op: "dropTable", table: "ghost", before: { ...postsState, name: "ghost" } }], 'Step 1, dropTable "ghost": there is no table "ghost".', 1);
    refused([dropAuthorKey, dropAuthorKey], 'Step 2, dropForeignKey "posts_author_fkey" of table "posts": table "posts" has no foreign key "posts_author_fkey".', 2);
    refused([{ op: "renameTable", table: "accounts", from: "members" }], 'Step 1, renameTable "members" to "accounts": there is no table "members".', 1);
    refused([{ op: "renameColumn", table: "users", column: "label", from: "title" }], 'Step 1, renameColumn "users"."title" to "label": table "users" has no column "title".', 1);
    refused([{ op: "renameConstraint", table: "users", kind: "unique", constraint: "u", from: "users_pkey" }], 'Step 1, renameConstraint "users_pkey" of table "users" to "u": table "users" has no unique constraint "users_pkey".', 1);
    refused([{ op: "renameIndex", table: "posts", index: "i", from: "users_name_idx" }], 'Step 1, renameIndex "users_name_idx" of table "posts" to "i": table "posts" has no index "users_name_idx".', 1);
    refused([{ op: "renameEnumType", enum: "state", from: "mood" }], 'Step 1, renameEnumType "mood" to "state": there is no enumerated type "mood".', 1);
  });

  test("what a step adds or names must not be there: a name is free when its turn comes, or the step waits for nothing", () => {
    refused([{ op: "addTable", table: "users", after: { name: "users", columns: [], uniques: [], checks: [] } }], 'Step 1, addTable "users": there is a table "users" already.', 1);
    // Two tables exchange their names without a name in between.
    refused([dropAuthorKey, { op: "renameTable", table: "posts", from: "users" }, { op: "renameTable", table: "users", from: "posts" }], 'Step 2, renameTable "users" to "posts": there is a table "posts" already.', 2);
    refused([{ op: "renameColumn", table: "users", column: "name", from: "id" }], 'Step 1, renameColumn "users"."id" to "name": table "users" has a column "name" already.', 1);
    // A constraint's name is one constraint's in its table, of whatever kind; an index's is one index's in the schema.
    refused([{ op: "addCheck", table: "users", constraint: "users_name_key", after: { name: "users_name_key", expression: "id > 0" } }], 'Step 1, addCheck "users_name_key" of table "users": table "users" has a constraint "users_name_key" already.', 1);
    refused([{ op: "renameConstraint", table: "users", kind: "unique", constraint: "users_pkey", from: "users_name_key" }], 'Step 1, renameConstraint "users_name_key" of table "users" to "users_pkey": table "users" has a constraint "users_pkey" already.', 1);
    // Of whatever kind the new constraint is: a key, a unique constraint, a foreign key.
    refused(
      [{ op: "dropPrimaryKey", table: "users", constraint: "users_pkey", before: { name: "users_pkey", columns: ["id"] } }, { op: "addPrimaryKey", table: "users", constraint: "users_name_key", after: { name: "users_name_key", columns: ["id"] } }],
      'Step 2, addPrimaryKey "users_name_key" of table "users": table "users" has a constraint "users_name_key" already.',
      2,
    );
    refused([{ op: "addUnique", table: "users", constraint: "users_pkey", after: { name: "users_pkey", columns: ["name"] } }], 'Step 1, addUnique "users_pkey" of table "users": table "users" has a constraint "users_pkey" already.', 1);
    refused(
      [{ op: "addForeignKey", table: "users", constraint: "users_pkey", after: { name: "users_pkey", columns: ["name"], references: { table: "posts", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" } }],
      'Step 1, addForeignKey "users_pkey" of table "users": table "users" has a constraint "users_pkey" already.',
      1,
    );
    // A table that comes with two constraints of one name.
    refused(
      [{ op: "addTable", table: "v", after: { name: "v", columns: [{ name: "id", type: { storage: "integer" }, nullable: false }], primaryKey: { name: "same", columns: ["id"] }, uniques: [{ name: "same", columns: ["id"] }], checks: [] } }],
      'Step 1, addTable "v": it would have two constraints "same".',
      1,
    );
    refused([{ op: "addIndex", table: "posts", index: "users_name_idx", after: { name: "users_name_idx", columns: ["id"], unique: false } }], 'Step 1, addIndex "users_name_idx" of table "posts": there is an index "users_name_idx" already, of table "users".', 1);
    refused([{ op: "renameIndex", table: "posts", index: "users_name_idx", from: "posts_author_idx" }], 'Step 1, renameIndex "posts_author_idx" of table "posts" to "users_name_idx": there is an index "users_name_idx" already, of table "users".', 1);
  });

  test("a table or a column is not dropped while a foreign key refers to it, and a column not while a key or an index is over it", () => {
    const usersState = { name: "users", columns: [], uniques: [], checks: [] };
    refused([{ op: "dropTable", table: "users", before: usersState }], 'Step 1, dropTable "users": the foreign key "posts_author_fkey" of table "posts" refers to it.', 1);
    const idState = { name: "id", type: { storage: "integer" as const, canonical: { kind: "integer" as const, bits: 32 as const }, declared: "integer" }, nullable: false };
    refused([{ op: "dropColumn", table: "users", column: "id", before: idState }], 'Step 1, dropColumn "users"."id": the primary key "users_pkey" is over it.', 1);
    const nameState = { name: "name", type: idState.type, nullable: true };
    refused([{ op: "dropColumn", table: "users", column: "name", before: nameState }], 'Step 1, dropColumn "users"."name": the unique constraint "users_name_key" is over it.', 1);
    refused(
      [{ op: "dropUnique", table: "users", constraint: "users_name_key", before: { name: "users_name_key", columns: ["name"] } }, { op: "dropColumn", table: "users", column: "name", before: nameState }],
      'Step 2, dropColumn "users"."name": the index "users_name_idx" is over it.',
      2,
    );
    refused(
      [{ op: "dropPrimaryKey", table: "users", constraint: "users_pkey", before: { name: "users_pkey", columns: ["id"] } }, { op: "dropColumn", table: "users", column: "id", before: idState }],
      'Step 2, dropColumn "users"."id": the foreign key "posts_author_fkey" of table "posts" refers to it.',
      2,
    );
    const authorState = { name: "author", type: idState.type, nullable: true };
    refused([{ op: "dropIndex", table: "posts", index: "posts_author_idx", before: { name: "posts_author_idx", columns: ["author"], unique: false } }, { op: "dropColumn", table: "posts", column: "author", before: authorState }], 'Step 2, dropColumn "posts"."author": the foreign key "posts_author_fkey" is over it.', 2);
  });

  test("a foreign key is added when what it refers to is there", () => {
    const toGhost = { name: "users_ghost_fkey", columns: ["name"], references: { table: "ghost", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" };
    refused([{ op: "addForeignKey", table: "users", constraint: "users_ghost_fkey", after: toGhost }], 'Step 1, addForeignKey "users_ghost_fkey" of table "users": there is no table "ghost" for it to refer to.', 1);
    refused([{ op: "addForeignKey", table: "users", constraint: "f", after: { ...toGhost, name: "f", references: { table: "posts", columns: ["nope"] } } }], 'Step 1, addForeignKey "f" of table "users": table "posts" has no column "nope" for it to refer to.', 1);
    refused([{ op: "addForeignKey", table: "users", constraint: "f", after: { ...toGhost, name: "f", references: { table: "posts", columns: ["id", "author"] } } }], 'Step 1, addForeignKey "f" of table "users": it has 1 column and refers to 2.', 1);
  });

  test("a foreign key that refers to nothing at the end of the plan, also one the plan did not touch", () => {
    const dangling = schema([table("orders", [keyColumn("id"), column("customer", INTEGER, { references: { table: "customers", column: "id", name: "orders_customer_fkey" } })])]);
    refused([], 'After the last step the schema does not hold together: the foreign key "orders_customer_fkey" of table "orders" refers to the table "customers", which the schema does not have.', undefined, dangling);
    const wrongColumn = schema([table("customers", [keyColumn("id")]), table("orders", [keyColumn("id"), column("customer", INTEGER, { references: { table: "customers", column: "code", name: "orders_customer_fkey" } })])]);
    refused([], 'After the last step the schema does not hold together: the foreign key "orders_customer_fkey" of table "orders" refers to the column "customers"."code", which the table does not have.', undefined, wrongColumn);
  });

  test("what is no plan, and what is no step, is said to be none", () => {
    const of = (value: unknown, message: string): void => {
      assert.throws(
        () => validatePlan(base(), value as MigrationPlan),
        (error: unknown) => {
          assert.ok(error instanceof MigrationPlanError, String(error));
          assert.equal(error.message, message);
          return true;
        },
      );
    };
    of(null, "This is not a migration plan.");
    of({ version: 1 }, "This migration plan has no list of steps.");
    of({ version: 1, steps: {} }, "This migration plan has no list of steps.");
    of({ version: 1, steps: [null] }, "Step 1 is not a step.");
    of({ version: 1, steps: [dropAuthorKey, 3] }, "Step 2 is not a step.");
  });

  test("a step that is not all there, or says two things, is refused as that step", () => {
    refused([{ op: "addTable", table: "v" } as unknown as MigrationStep], 'Step 1, addTable "v": the change has no "after".', 1);
    refused([dropAuthorKey, { op: "dropColumn", table: "posts" } as unknown as MigrationStep], 'Step 2, dropColumn "posts".<none>: the change has no "column".', 2);
    refused([{ op: "addColumn", table: "users", column: "b", after: { name: "c", type: { storage: "integer" }, nullable: true } }], 'Step 1, addColumn "users"."b": the change is of "b", and what it describes is called "c".', 1);
    // A table comes with its own columns and keys; what it gets later is not there yet.
    refused(
      [
        { op: "addTable", table: "v", after: { name: "v", columns: [{ name: "id", type: { storage: "integer" }, nullable: false }], primaryKey: { columns: ["later"] }, uniques: [], checks: [] } },
        { op: "addColumn", table: "v", column: "later", after: { name: "later", type: { storage: "integer" }, nullable: false } },
      ],
      'Step 1, addTable "v": its primary key is over the column "later", which it does not have.',
      1,
    );
    refused(
      [{ op: "addTable", table: "v", after: { name: "v", columns: [{ name: "id", type: { storage: "integer" }, nullable: false }], uniques: [], checks: [], foreignKeys: [{ columns: ["id"], references: { table: "ghost", columns: ["id"] }, onDelete: "NO ACTION", onUpdate: "NO ACTION" }] } }],
      'Step 1, addTable "v": an added table\'s foreign keys are changes of their own; this one lists 1.',
      1,
    );
  });

  test("what no schema can have, and a foreign key with another number of columns than it refers to, at the end", () => {
    const end = (before: DatabaseSchema, problem: string): void => refused([], `After the last step the schema does not hold together: ${problem}`, undefined, before);
    end(schema([table("t", [keyColumn("id")]), table("t", [keyColumn("id")])]), 'there are two tables "t".');
    end(schema([], [{ name: "e", values: ["a"] }, { name: "e", values: ["b"] }]), 'there are two enumerated types "e".');
    end(schema([], [{ name: "e", values: ["a", "b", "a"] }]), 'the enumerated type "e" has the value "a" twice.');
    end(schema([table("t", [keyColumn("id"), column("x"), column("x")])]), 'table "t" has two columns "x".');
    end(schema([table("target", [keyColumn("id")]), table("t", [keyColumn("id"), column("a"), column("b")], { foreignKeys: [{ name: "f", columns: ["a", "b"], references: { table: "target", columns: ["id"] } }] })]), 'the foreign key "f" of table "t" has 2 columns and refers to 1.');
  });

  test("a plan that is carried out and does not arrive at the schema it is for", () => {
    const of = (values: string[], columns: string[] = []): DatabaseSchema => schema([table("t", [keyColumn("id"), ...columns.map((name) => column(name))])], [{ name: "status", values }]);
    const before = of(["a"]);
    // Each step can be taken, and the values end up in another order than the one that was asked for.
    const wrongOrder = plan({ op: "addEnumValue", enum: "status", value: "y", afterValue: "a" }, { op: "addEnumValue", enum: "status", value: "x", afterValue: "y" });
    assert.equal(validatePlan(before, wrongOrder), undefined);
    assert.equal(validatePlan(before, wrongOrder, of(["a", "y", "x"])), undefined);
    const misses = (steps: MigrationPlan, target: DatabaseSchema, message: string): void => {
      assert.throws(
        () => validatePlan(before, steps, target),
        (error: unknown) => {
          assert.ok(error instanceof MigrationPlanError, String(error));
          assert.equal(error.message, message);
          return true;
        },
      );
    };
    misses(wrongOrder, of(["a", "x", "y"]), 'The plan does not arrive at the schema it is for: replaceEnumValues of enumerated type "status" is still to do.');
    misses(plan(), of(["a"], ["note", "other"]), 'The plan does not arrive at the schema it is for: addColumn "t"."note" is still to do, and 1 more change.');
    // The plan of a diff arrives.
    const target = of(["b", "a", "c"], ["note"]);
    assert.equal(validatePlan(before, planMigration(before, diffSchemas(before, target)), target), undefined);
  });

  test("names that two things have at the end", () => {
    const twoIndexes = schema([table("a", [keyColumn("id")], { indexes: [{ name: "idx", columns: ["id"] }] }), table("b", [keyColumn("id")], { indexes: [{ name: "idx", columns: ["id"] }] })]);
    refused([], 'After the last step the schema does not hold together: there are two indexes "idx".', undefined, twoIndexes);
    const twoConstraints = schema([table("a", [keyColumn("id"), column("x")], { uniques: [{ name: "same", columns: ["x"] }], checks: [{ name: "same", expression: "x > 0" }] })]);
    refused([], 'After the last step the schema does not hold together: table "a" has two constraints "same".', undefined, twoConstraints);
  });

  test("enumerated types: a step that cannot be taken on the type as it then is, and a default that is left without its value", () => {
    refused([{ op: "addEnumValue", enum: "status", value: "c", afterValue: "b" }, { op: "addEnumValue", enum: "status", value: "b", afterValue: "live" }], 'Step 1, addEnumValue "c" of enumerated type "status": the type has no value "b" to put it after.', 1);
    refused([{ op: "addEnumValue", enum: "status", value: "live" }], 'Step 1, addEnumValue "live" of enumerated type "status": the type has the value "live" already.', 1);
    refused([{ op: "removeEnumValue", enum: "status", value: "gone" }], 'Step 1, removeEnumValue "gone" of enumerated type "status": the type has no value "gone".', 1);
    refused([{ op: "renameEnumValue", enum: "status", from: "draft", to: "live" }], 'Step 1, renameEnumValue "draft" of enumerated type "status" to "live": the type has the value "live" already.', 1);
    refused([{ op: "replaceEnumValues", enum: "status", before: ["live", "draft"], after: ["draft"] }], 'Step 1, replaceEnumValues of enumerated type "status": the type\'s values are not what the change says they were. The schema has ["draft","live"]; the change says ["live","draft"].', 1);
    refused([{ op: "dropEnumType", enum: "status", before: { name: "status", values: ["draft", "live"] } }], 'Step 1, dropEnumType "status": the column "users"."state" is of this type.', 1);
    refused([{ op: "addColumn", table: "posts", column: "mood", after: { name: "mood", type: { storage: "text", canonical: { kind: "enum", name: "mood" } }, nullable: true } }], 'Step 1, addColumn "posts"."mood": there is no enumerated type "mood" for the column "mood" to be of.', 1);
    const moodColumn = { name: "feeling", type: { storage: "json" as const, canonical: { kind: "array" as const, element: { kind: "enum" as const, name: "mood" } } }, nullable: true };
    refused(
      [
        { op: "addTable", table: "diary", after: { name: "diary", columns: [moodColumn], uniques: [], checks: [] } },
        { op: "addEnumType", enum: "mood", after: { name: "mood", values: ["ok"] } },
      ],
      'Step 1, addTable "diary": there is no enumerated type "mood" for the column "feeling" to be of.',
      1,
    );
    refused([{ op: "alterColumnType", table: "users", column: "name", before: { storage: "integer", canonical: { kind: "integer", bits: 32 }, declared: "integer" }, after: { storage: "text", enum: "mood" }, comparedBy: "declared" }], 'Step 1, alterColumnType "users"."name": there is no enumerated type "mood" for the column "name" to be of.', 1);
    // A value goes while a column's default is that value: the plan leaves a default that is no value of its type.
    refused([{ op: "removeEnumValue", enum: "status", value: "draft" }], 'After the last step the schema does not hold together: the default of the column "users"."state" is "draft", which is not a value of the enumerated type "status".');
  });

  test("a temporary name that no later step takes away, of whatever kind of thing", () => {
    const left = (step: MigrationStep, what: string, label: string): void => refused([{ ...step, planned: "rename-cycle", temporaryName: true } as MigrationStep], `Step 1, ${label}: the name it gives is a temporary one, and ${what} still has it after the last step.`, 1);
    left({ op: "renameTable", table: "tmp", from: "users" }, 'the table "tmp"', 'renameTable "users" to "tmp"');
    left({ op: "renameColumn", table: "users", column: "tmp", from: "name" }, 'the column "users"."tmp"', 'renameColumn "users"."name" to "tmp"');
    left({ op: "renameConstraint", table: "users", kind: "unique", constraint: "tmp", from: "users_name_key" }, 'the constraint "tmp" of table "users"', 'renameConstraint "users_name_key" of table "users" to "tmp"');
    left({ op: "renameIndex", table: "users", index: "tmp", from: "users_name_idx" }, 'the index "tmp" of table "users"', 'renameIndex "users_name_idx" of table "users" to "tmp"');
    left({ op: "renameEnumType", enum: "tmp", from: "status" }, 'the enumerated type "tmp"', 'renameEnumType "status" to "tmp"');
    left({ op: "renameEnumValue", enum: "status", from: "live", to: "tmp" }, 'the value "tmp" of the enumerated type "status"', 'renameEnumValue "live" of enumerated type "status" to "tmp"');
  });

  test("a temporary name that is taken away again is not held against the plan because something else is called the same", () => {
    // Another table has a column of the name that this column passes through.
    const before = schema([table("a", [keyColumn("id"), column("x"), column("y")]), table("b", [keyColumn("id"), column("tmp")])]);
    const result = applyPlan(
      before,
      plan(
        { op: "renameColumn", table: "a", column: "tmp", from: "x", planned: "rename-cycle", temporaryName: true },
        { op: "renameColumn", table: "a", column: "x", from: "y" },
        { op: "renameColumn", table: "a", column: "y", from: "tmp" },
      ),
    );
    assert.deepEqual(result.tables.map((entry) => entry.columns.map((entry2) => entry2.name)), [["id", "y", "x"], ["id", "tmp"]]);
  });

  test("what a step says a thing was must be what it is at that step", () => {
    refused([{ ...dropAuthorKey, before: { ...fkState, onDelete: "CASCADE" } }], 'Step 1, dropForeignKey "posts_author_fkey" of table "posts": the foreign key is not what the change says it was. The schema has {"name":"posts_author_fkey","columns":["author"],"references":{"table":"users","columns":["id"]},"onDelete":"NO ACTION","onUpdate":"NO ACTION"}; the change says {"name":"posts_author_fkey","columns":["author"],"references":{"table":"users","columns":["id"]},"onDelete":"CASCADE","onUpdate":"NO ACTION"}.', 1);
    refused([{ op: "setNotNull", table: "users", column: "id" }], 'Step 1, setNotNull "users"."id": the column is not null already.', 1);
  });
});
