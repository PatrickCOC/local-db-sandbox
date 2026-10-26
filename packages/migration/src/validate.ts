import type { DatabaseSchema } from "../../runtime/src/index.ts";
import { CHANGE_ORDER, diffSchemas } from "../../schema-diff/src/index.ts";
import { SchemaModel } from "./model.ts";
import { OperationProblem, Session, checkOperation, describeOperation, schemaProblems } from "./operations.ts";
import { MIGRATION_PLAN_VERSION } from "./plan.ts";
import type { MigrationPlan, MigrationStep, Operation } from "./plan.ts";
import { blockers } from "./rules.ts";

/*
 * A plan carried out on a schema, step by step, under the rules a database
 * has on the way (`rules.ts`), and checked as a whole at the end (D-038).
 * This is the validator of plans: a plan that it carries out to the end can
 * be carried out, and a plan that it refuses says at which step and why.
 */

/** A plan that cannot be made, or cannot be carried out. The message says at which step, with which operation, and why. */
export class MigrationPlanError extends Error {
  /** 1-based number of the step, when it is one step. */
  readonly step?: number;
  readonly operation?: Operation;

  constructor(message: string, operation?: Operation, step?: number) {
    super(message);
    this.name = "MigrationPlanError";
    if (operation !== undefined) {
      this.operation = operation;
    }
    if (step !== undefined) {
      this.step = step;
    }
  }
}

const KNOWN = new Set<string>(CHANGE_ORDER);

/** What is wrong with the schema a plan leaves: what no schema can have, and what a database refuses. */
export function finalProblem(model: SchemaModel): string | undefined {
  return schemaProblems(model, true)[0];
}

/**
 * The object that a step has just given a temporary name, as a question to
 * ask at the end: is it still called that? It answers with what still has
 * the name, or `undefined`. It is the object itself that is asked, not the
 * name: something else may be called the same.
 */
function watchTemporaryName(model: SchemaModel, step: MigrationStep): () => string | undefined {
  const nowhere = (): undefined => undefined;
  switch (step.op) {
    case "renameTable": {
      const table = model.table(step.table);
      return table === undefined ? nowhere : () => (model.tables.includes(table) && table.name === step.table ? `the table "${table.name}"` : undefined);
    }
    case "renameEnumType": {
      const type = model.enumType(step.enum);
      return type === undefined ? nowhere : () => (model.enums.includes(type) && type.name === step.enum ? `the enumerated type "${type.name}"` : undefined);
    }
    case "renameEnumValue": {
      const type = model.enumType(step.enum);
      return type === undefined ? nowhere : () => (model.enums.includes(type) && type.values.includes(step.to) ? `the value "${step.to}" of the enumerated type "${type.name}"` : undefined);
    }
    case "renameColumn": {
      const table = model.table(step.table);
      const column = table?.columns.find((candidate) => candidate.name === step.column);
      return table === undefined || column === undefined ? nowhere : () => (model.tables.includes(table) && table.columns.includes(column) && column.name === step.column ? `the column "${table.name}"."${column.name}"` : undefined);
    }
    case "renameConstraint": {
      const table = model.table(step.table);
      const constraints = (): ({ name?: string } | undefined)[] => (table === undefined ? [] : [table.primaryKey, ...table.uniques, ...table.foreignKeys, ...table.checks]);
      const constraint = constraints().find((candidate) => candidate?.name === step.constraint);
      return table === undefined || constraint === undefined ? nowhere : () => (model.tables.includes(table) && constraints().includes(constraint) && constraint.name === step.constraint ? `the constraint "${step.constraint}" of table "${table.name}"` : undefined);
    }
    case "renameIndex": {
      const table = model.table(step.table);
      const index = table?.indexes.find((candidate) => candidate.name === step.index);
      return table === undefined || index === undefined ? nowhere : () => (model.tables.includes(table) && table.indexes.includes(index) && index.name === step.index ? `the index "${index.name}" of table "${table.name}"` : undefined);
    }
    default:
      return nowhere;
  }
}

/** The plan carried out on a model of the schema. */
export function applyPlanTo(model: SchemaModel, plan: MigrationPlan): void {
  if (typeof plan !== "object" || plan === null) {
    throw new MigrationPlanError("This is not a migration plan.");
  }
  if ((plan.version as number) !== MIGRATION_PLAN_VERSION) {
    throw new MigrationPlanError(`This is a migration plan of version ${String(plan.version)}; version ${MIGRATION_PLAN_VERSION} is the one that can be carried out.`);
  }
  if (!Array.isArray(plan.steps)) {
    throw new MigrationPlanError("This migration plan has no list of steps.");
  }
  for (const [index, step] of (plan.steps as unknown[]).entries()) {
    if (typeof step !== "object" || step === null) {
      throw new MigrationPlanError(`Step ${index + 1} is not a step.`);
    }
  }
  const session = new Session(model);
  const temporary: { step: MigrationStep; number: number; left: () => string | undefined }[] = [];
  for (const [index, step] of plan.steps.entries()) {
    const number = index + 1;
    const refuse = (problem: string): never => {
      throw new MigrationPlanError(`Step ${number}, ${describeOperation(step)}: ${problem}`, step, number);
    };
    if (!KNOWN.has(step.op)) {
      refuse("this kind of operation is not known.");
    }
    try {
      // First that the step is whole: the rules, and carrying it out, read it without looking.
      checkOperation(step);
      const [reason] = blockers(model, step);
      if (reason !== undefined) {
        refuse(reason);
      }
      session.apply(step);
    } catch (error) {
      if (error instanceof OperationProblem) {
        refuse(error.message);
      }
      throw error;
    }
    if (step.temporaryName === true) {
      temporary.push({ step, number, left: watchTemporaryName(model, step) });
    }
  }
  session.finish();
  for (const { step, number, left } of temporary) {
    const holder = left();
    if (holder !== undefined) {
      throw new MigrationPlanError(`Step ${number}, ${describeOperation(step)}: the name it gives is a temporary one, and ${holder} still has it after the last step.`, step, number);
    }
  }
  const problem = finalProblem(model);
  if (problem !== undefined) {
    throw new MigrationPlanError(`After the last step the schema does not hold together: ${problem}`);
  }
}

/**
 * The schema that a plan makes of a schema, carried out step by step. The
 * schema that is given is not changed. Throws a `MigrationPlanError` at the
 * first step that cannot be carried out when its turn comes, and for a plan
 * that leaves a schema a database would refuse.
 */
export function applyPlan(before: DatabaseSchema, plan: MigrationPlan): DatabaseSchema {
  const model = SchemaModel.from(before);
  applyPlanTo(model, plan);
  return model.toSchema();
}

/**
 * Throws a `MigrationPlanError` unless the plan can be carried out on the
 * schema, as `applyPlan` carries it out. With `target`, also unless it then
 * arrives there: steps that can each be taken may still lead elsewhere than
 * the schema the plan is for (values added to a type in an order that gives
 * another order than was asked for).
 */
export function validatePlan(before: DatabaseSchema, plan: MigrationPlan, target?: DatabaseSchema): void {
  const model = SchemaModel.from(before);
  applyPlanTo(model, plan);
  if (target === undefined) {
    return;
  }
  // What is still to do is what differs: said as the diff says it.
  const [first, ...more] = diffSchemas(model.toSchema(), target).changes;
  if (first !== undefined) {
    throw new MigrationPlanError(`The plan does not arrive at the schema it is for: ${describeOperation(first)} is still to do${more.length === 0 ? "" : `, and ${more.length} more change${more.length === 1 ? "" : "s"}`}.`);
  }
}
