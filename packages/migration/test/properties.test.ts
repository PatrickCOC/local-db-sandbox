import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DatabaseSchema } from "../../runtime/src/index.ts";
import { CHANGE_ORDER, diffSchemas } from "../../schema-diff/src/index.ts";
import type { SchemaDiff } from "../../schema-diff/src/index.ts";
import type { MigrationStep } from "../src/index.ts";
import { inCanonicalOrder } from "../src/apply-diff.ts";
import { MigrationPlanError, applyDiff, applyPlan, planMigration, stringifyMigrationPlan, validatePlan } from "../src/index.ts";
import { historyPair, listedDifferently, sequence, without } from "./support/history-generator.ts";
import type { HistoryOptions } from "./support/history-generator.ts";
import { assertSameSchema, deepFreeze } from "./support/semantic-form.ts";
import type { FormOptions } from "./support/semantic-form.ts";

/*
 * The properties the migration package stands on (D-038), over generated
 * migration histories. For the schema at two moments of a history, A and B,
 * whatever happened in between:
 *
 *   applyDiff(A, diffSchemas(A, B)) means B
 *   applyPlan(A, planMigration(A, diffSchemas(A, B))) means B
 *
 * The second says more than it seems to: a plan is carried out one step at
 * a time, and a step is refused when a database would refuse it on the way
 * (a name that is still taken, a table that a foreign key still refers to).
 * So it also says that every step of every plan can be taken when its turn
 * comes.
 *
 * The histories are made from seeds, so every run tries the same ones; a
 * failure names its seed and says what the history did.
 */

interface Run {
  title: string;
  options: HistoryOptions;
  /** The first seed, and how many. */
  from: number;
  count: number;
}

const RUNS: Run[] = [
  { title: "histories in which every name is new", options: { reuse: false, handEdits: false }, from: 1, count: 300 },
  { title: "histories in which names are used again", options: { reuse: true, handEdits: false }, from: 1, count: 1000 },
  { title: "histories in which names are used again, with changes that migrations cannot make", options: { reuse: true, handEdits: true }, from: 5001, count: 600 },
  { title: "histories in which tables, types, constraints, and indexes share their names", options: { reuse: true, handEdits: false, oneNamespace: true }, from: 9001, count: 600 },
];

/** A pair of schemas as other sources than a collector give them. */
interface Variant {
  title: string;
  of(before: DatabaseSchema, after: DatabaseSchema): [DatabaseSchema, DatabaseSchema];
  /** How the result is compared, when not by everything. */
  form?: FormOptions;
}

const VARIANTS: Variant[] = [
  { title: "without provenance", of: (before, after) => [without(before, ["provenance"]), without(after, ["provenance"])] },
  { title: "without provenance on the before side", of: (before, after) => [without(before, ["provenance"]), after] },
  { title: "without provenance on the after side", of: (before, after) => [before, without(after, ["provenance"])] },
  { title: "without canonical types", of: (before, after) => [without(before, ["canonical"]), without(after, ["canonical"])], form: { types: "declared" } },
  { title: "without canonical types on the before side", of: (before, after) => [without(before, ["canonical"]), after], form: { types: "declared" } },
  { title: "without the names of keys and constraints", of: (before, after) => [without(before, ["names"]), without(after, ["names"])] },
  { title: "without names on the after side", of: (before, after) => [before, without(after, ["names"])], form: { names: false } },
  { title: "written by hand: no provenance, names, or canonical types", of: (before, after) => [without(before, ["provenance", "names", "canonical"]), without(after, ["provenance", "names", "canonical"])], form: { types: "declared" } },
  // One side from a collector, the other written by hand.
  { title: "without canonical types on the after side", of: (before, after) => [before, without(after, ["canonical"])], form: { types: "declared" } },
  { title: "without provenance or names on the before side", of: (before, after) => [without(before, ["provenance", "names"]), after], form: { names: false } },
  { title: "the after side written by hand", of: (before, after) => [before, without(after, ["provenance", "names", "canonical"])], form: { types: "declared", names: false } },
  { title: "the before side written by hand", of: (before, after) => [without(before, ["provenance", "names", "canonical"]), after], form: { types: "declared", names: false } },
  // Enumerated types that only the columns of them give: the schema's list of types does not have them.
  { title: "with the types that columns give left out of the list of types", of: (before, after) => [without(before, ["types"]), without(after, ["types"])] },
  { title: "with the types that columns give left out of the list on the before side", of: (before, after) => [without(before, ["types"]), after] },
  { title: "with the types that columns give left out of the list on the after side", of: (before, after) => [before, without(after, ["types"])] },
  { title: "written by hand, with the types that columns give left out of the list", of: (before, after) => [without(before, ["provenance", "names", "canonical", "types"]), without(after, ["provenance", "names", "canonical", "types"])], form: { types: "declared" } },
];

function shuffled<T>(list: readonly T[], seed: number): T[] {
  const next = sequence(seed);
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

/** What was seen over all the runs, so that a property is not trusted for cases it never met. */
const seen = {
  ops: new Set<string>(),
  pairs: 0,
  changes: 0,
  steps: 0,
  /** Plans with a step by way of a temporary name, and with a foreign key dropped ahead of tables that go together. */
  renameCycles: 0,
  tablesDroppedTogether: 0,
  /** Diffs whose changes cannot be carried out in the order of their list: the plan of one is another order, or has more steps. */
  notInListOrder: 0,
  /** Plans that are their diff's changes in the planner's own order, because that order can be carried out as it stands. */
  plansInTheirOwnOrder: 0,
  /** Plans with a temporary name for a ring of names that goes through things of different kinds. */
  ringsAcrossKinds: 0,
  /** Pairs in which one side lists an enumerated type that the other has only on its columns. */
  typesListedOnOneSide: 0,
  /** Diffs that drop something and give its name to something else: by a rename, or to a new object. */
  namesTakenAgain: 0,
};

/** The name a change gives up or takes, with the kind of thing it is a name of. */
function nameOf(change: SchemaDiff["changes"][number], side: "gives up" | "takes"): string | undefined {
  switch (change.op) {
    case "dropTable":
      return side === "gives up" ? `table ${change.table}` : undefined;
    case "dropColumn":
      return side === "gives up" ? `column ${change.table}.${change.column}` : undefined;
    case "renameTable":
    case "addTable":
      return side === "takes" ? `table ${change.table}` : undefined;
    case "renameColumn":
    case "addColumn":
      return side === "takes" ? `column ${change.table}.${change.column}` : undefined;
    default:
      return undefined;
  }
}

/** Whether a temporary name of the plan is taken by a thing of one kind and then given to a thing of another: a ring through several kinds. */
function crossesKinds(steps: readonly MigrationStep[]): boolean {
  const target = (step: MigrationStep): string | undefined => (step.op === "renameTable" ? step.table : step.op === "renameEnumType" ? step.enum : step.op === "renameConstraint" ? step.constraint : step.op === "renameIndex" ? step.index : undefined);
  const source = (step: MigrationStep): string | undefined => (step.op === "renameTable" || step.op === "renameEnumType" || step.op === "renameConstraint" || step.op === "renameIndex" ? step.from : undefined);
  // The name that the object which moved out of the way had is taken, later, by a thing of another kind.
  return steps.some((away, index) => away.planned === "rename-cycle" && steps.slice(index + 1).some((later) => later.op !== away.op && target(later) !== undefined && target(later) === source(away)));
}

function holds(before: DatabaseSchema, after: DatabaseSchema, seed: number, form: FormOptions | undefined, context: string): SchemaDiff {
  const diff = diffSchemas(before, after);
  // The schema that is given is not changed: it is frozen, and a write to it throws.
  const result = applyDiff(deepFreeze(structuredClone(before)), deepFreeze(structuredClone(diff)));
  assertSameSchema(result, after, form, context);
  // The result can stand for the after side in a later diff: read with all that the two say of where things come from, nothing differs either.
  assert.deepEqual(diffSchemas(result, after).changes, [], `${context} (with provenance)`);
  // Nor does anything depend on the order of the lists: of the schema's, or of the diff's changes.
  const again = applyDiff(listedDifferently(before, seed), { ...diff, changes: shuffled(diff.changes, seed) });
  assertSameSchema(again, after, form, `${context} (listed in another order)`);
  // The plan: carried out step by step, under the rules of the way, it arrives at the same schema.
  const plan = planMigration(deepFreeze(structuredClone(before)), diff);
  const arrived = applyPlan(deepFreeze(structuredClone(before)), deepFreeze(structuredClone(plan)));
  assertSameSchema(arrived, after, form, `${context} (the plan)`);
  assert.deepEqual(diffSchemas(arrived, after).changes, [], `${context} (the plan, with provenance)`);
  assert.equal(validatePlan(before, plan, after), undefined);
  // One diff has one plan, to the byte, whatever is listed in whatever order.
  const text = stringifyMigrationPlan(plan);
  assert.equal(stringifyMigrationPlan(planMigration(listedDifferently(before, seed), { ...diff, changes: shuffled(diff.changes, seed) })), text, `${context} (the plan of the same things listed in another order)`);

  seen.pairs += 1;
  seen.changes += diff.changes.length;
  seen.steps += plan.steps.length;
  diff.changes.forEach((change) => seen.ops.add(change.op));
  seen.renameCycles += plan.steps.some((step) => step.planned === "rename-cycle") ? 1 : 0;
  seen.tablesDroppedTogether += plan.steps.some((step) => step.planned === "tables-dropped-together") ? 1 : 0;
  // The diff's own list, taken for a plan: can it be carried out as it stands?
  const asItStands = (steps: readonly SchemaDiff["changes"][number][]): boolean => {
    try {
      validatePlan(before, { version: 1, steps: [...steps] });
      return true;
    } catch (error) {
      assert.ok(error instanceof MigrationPlanError, String(error));
      return false;
    }
  };
  seen.notInListOrder += asItStands(diff.changes) ? 0 : 1;
  /*
   * The planner changes nothing without need. Its own order of the changes
   * (by kind, then by all a change says) is what it takes them in where it
   * can: when that order can be carried out as it stands, it is the plan.
   * (Renames are left out of this: the plan gives a name up before it is
   * taken across kinds and tables, which is more than a step needs.)
   */
  const ordered = inCanonicalOrder(diff.changes);
  if (!diff.changes.some((change) => change.op.startsWith("rename")) && asItStands(ordered)) {
    assert.deepEqual(plan.steps, ordered, `${context} (an order that can be carried out as it stands)`);
    seen.plansInTheirOwnOrder += 1;
  }
  const ring = plan.steps.findIndex((step) => step.planned === "rename-cycle");
  seen.ringsAcrossKinds += ring >= 0 && new Set(plan.steps.filter((step) => step.op.startsWith("rename")).map((step) => step.op)).size > 1 && crossesKinds(plan.steps) ? 1 : 0;
  const listed = (schema: DatabaseSchema): Set<string> => new Set(schema.types.enums.map((type) => type.name));
  const given = (schema: DatabaseSchema): string[] => schema.tables.flatMap((table) => table.columns.flatMap((column) => (column.enum === undefined ? [] : [column.enum.name])));
  seen.typesListedOnOneSide += given(before).some((name) => !listed(before).has(name) && listed(after).has(name)) || given(after).some((name) => !listed(after).has(name) && listed(before).has(name)) ? 1 : 0;
  const givenUp = new Set(diff.changes.map((change) => nameOf(change, "gives up")));
  seen.namesTakenAgain += diff.changes.some((change) => nameOf(change, "takes") !== undefined && givenUp.has(nameOf(change, "takes"))) ? 1 : 0;
  return diff;
}

describe("applyDiff(A, diff(A, B)) and the plan of that diff both mean B, over generated histories", () => {
  for (const run of RUNS) {
    test(`${run.title}: ${run.count} histories`, () => {
      for (let seed = run.from; seed < run.from + run.count; seed += 1) {
        const { before, after, log } = historyPair(seed, run.options);
        const context = (variant: string): string => `seed ${seed} (${variant}), names used again: ${run.options.reuse}, by hand: ${run.options.handEdits}\n${log.join("\n")}`;
        holds(before, after, seed, undefined, context("as collected"));
        // And the other way: from the later schema back to the earlier one.
        holds(after, before, seed, undefined, context("backwards"));
        // Two of the other ways a pair of schemas is written, by turns.
        for (const index of [seed % VARIANTS.length, (seed * 7 + 3) % VARIANTS.length]) {
          const variant = VARIANTS[index] as Variant;
          const [variantBefore, variantAfter] = variant.of(before, after);
          holds(variantBefore, variantAfter, seed, variant.form, context(variant.title));
        }
      }
    });
  }

  test("the histories met every kind of change, in thousands of pairs of schemas", () => {
    assert.deepEqual(
      CHANGE_ORDER.filter((op) => !seen.ops.has(op)),
      [],
    );
    assert.equal(seen.pairs, RUNS.reduce((total, run) => total + run.count, 0) * 4);
  });

  test("the histories met what a plan has to work for: names that go round, tables that go together, and names taken again", () => {
    /*
     * The seeds are fixed, so these are counts, not chances, and they are the
     * numbers D-038 states. A change of the generator, of the diff, or of the
     * planner that moves one shows here: then the decision's numbers are to
     * be stated again with these.
     */
    const { ops: _ops, ...counts } = seen;
    assert.deepEqual(counts, {
      pairs: 10000,
      changes: 45268,
      steps: 45592,
      renameCycles: 231,
      tablesDroppedTogether: 78,
      notInListOrder: 419,
      plansInTheirOwnOrder: 7211,
      ringsAcrossKinds: 25,
      typesListedOnOneSide: 180,
      namesTakenAgain: 55,
    });
  });
});
