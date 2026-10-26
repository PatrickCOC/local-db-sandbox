export { DiffApplicationError, applyDiff } from "./apply-diff.ts";
export { MIGRATION_PLAN_VERSION, stringifyMigrationPlan } from "./plan.ts";
export type { MigrationPlan, MigrationStep, Operation, PlannedReason } from "./plan.ts";
export { planMigration } from "./planner.ts";
export { MigrationPlanError, applyPlan, validatePlan } from "./validate.ts";
