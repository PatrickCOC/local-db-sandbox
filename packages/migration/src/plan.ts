import { stableStringify } from "../../schema-diff/src/index.ts";
import type { RenameEvidence, SchemaChange } from "../../schema-diff/src/index.ts";

/*
 * The migration plan IR (D-038): how a schema diff is carried out, as data.
 *
 * A schema diff says what changed. Its list is in an order of kinds, and
 * within a kind in the order of names, which is not an order in which every
 * diff can be carried out: two tables may exchange their names, two tables
 * that are dropped may refer to each other. A plan is the same changes as
 * steps that can each be carried out when its turn comes, with the steps
 * added that this takes. It has no SQL and no dialect in it: a generator of
 * migrations for one database reads it.
 *
 * A step is a change in the diff's own vocabulary (`ir.ts` of the schema
 * diff), and says things as they are when the step is carried out:
 *
 * - names are the names things have at that step, which for a table that is
 *   on its way through a temporary name is that name;
 * - `before` is what the thing is at that step, and `after` what the step
 *   makes it.
 *
 * So a reader carries the steps out one after another and never has to work
 * out what a name means, or what has to come first.
 */

export const MIGRATION_PLAN_VERSION = 1;

type EvidenceOptional<T> = T extends { evidence: RenameEvidence } ? Omit<T, "evidence"> & { evidence?: RenameEvidence } : T;

/**
 * One thing done to a schema: a change of the schema diff. A rename has its
 * evidence only when it completes a rename of the diff; a rename to or from
 * a temporary name on the way there has none to give.
 */
export type Operation = EvidenceOptional<SchemaChange>;

/**
 * Why the planner added a step that the diff does not have as a change:
 *
 * - `rename-cycle`: renames take each other's names (`a` to `b` and `b` to
 *   `a`), so one of the objects is first renamed to a temporary name.
 * - `tables-dropped-together`: tables that are dropped refer to each other,
 *   so a foreign key between them is dropped on its own first.
 */
export type PlannedReason = "rename-cycle" | "tables-dropped-together";

export type MigrationStep = Operation & {
  /** The planner added this step; the diff has no change for it. */
  planned?: PlannedReason;
  /** The name this step gives is a temporary one, which a later step takes away again. */
  temporaryName?: true;
};

export interface MigrationPlan {
  version: typeof MIGRATION_PLAN_VERSION;
  /** In the order they are carried out. */
  steps: MigrationStep[];
}

/** The plan as JSON text: the same plan always gives the same bytes. */
export function stringifyMigrationPlan(plan: MigrationPlan, indent = 2): string {
  const steps = stableStringify(plan.steps, indent);
  if (indent <= 0) {
    return `{"version":${plan.version},"steps":${steps}}`;
  }
  const pad = " ".repeat(indent);
  // A line end within the text of the steps is layout: one within a value is written as an escape.
  return `{\n${pad}"version": ${plan.version},\n${pad}"steps": ${steps.replaceAll("\n", `\n${pad}`)}\n}`;
}
