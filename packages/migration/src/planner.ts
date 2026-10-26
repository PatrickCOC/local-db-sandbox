import type { DatabaseSchema } from "../../runtime/src/index.ts";
import { CHANGE_ORDER, stableStringify } from "../../schema-diff/src/index.ts";
import type { ForeignKeyState, SchemaChange, SchemaChangeOp, SchemaDiff } from "../../schema-diff/src/index.ts";
import { compareText } from "../../schema-diff/src/stable-json.ts";
import { applyDiffTo, inCanonicalOrder } from "./apply-diff.ts";
import { SchemaModel, comparable, enumState, foreignKeyState, tableState } from "./model.ts";
import { OperationProblem, Session, constraintNames, describeOperation } from "./operations.ts";
import { MIGRATION_PLAN_VERSION } from "./plan.ts";
import type { MigrationPlan, MigrationStep } from "./plan.ts";
import { RENAME_KINDS, checkRenameTargets, resolveRenames } from "./renames.ts";
import type { RenameChange, Renaming } from "./renames.ts";
import { blockers } from "./rules.ts";
import { MigrationPlanError, finalProblem } from "./validate.ts";

/*
 * The planner (D-038): a schema diff as steps that can each be carried out
 * when its turn comes.
 *
 * The order of a diff's list is not trusted. The changes are carried out on
 * a model of the schema, and a change is taken when the rules of `rules.ts`
 * let it be carried out on the schema as it then is: a table is dropped when
 * no foreign key refers to it any more, a name is taken when it is free, a
 * value is added when the value it is put next to is there. Of the changes
 * that can be taken, the first in the diff's own order of kinds and names is:
 * that order decides nothing but which of several possible plans it is, so
 * that a diff has one plan.
 *
 * The three parts of a diff stay three parts, because the names in a change
 * mean what they mean in its part: what goes (by the names before), the
 * renames, what comes and what changes (by the names after).
 *
 * Where no change can be taken, the plan needs a step that the diff does not
 * have:
 *
 * - Tables that are dropped together and refer to each other: a foreign key
 *   between them is dropped on its own first.
 * - Renames that take each other's names: one of the objects is renamed to a
 *   temporary name, which frees its name, and takes its own name from there
 *   when that is free.
 *
 * Anything else that cannot be taken is a diff that leads nowhere a database
 * goes, and is refused. So is a diff that gives a constraint's name to
 * another constraint and leaves the first without one (a schema written by
 * hand may not name its keys): in a database it needs another name, and
 * neither the diff nor anything known here says which.
 */

const FIRST_RENAME = CHANGE_ORDER.indexOf(RENAME_KINDS[0]);
const LAST_RENAME = CHANGE_ORDER.indexOf(RENAME_KINDS[RENAME_KINDS.length - 1] as SchemaChangeOp);

/**
 * The kinds of object whose names a database may keep in one place. Which
 * kinds share their names differs from database to database (tables with
 * indexes, constraints across a schema, tables with types), and the plan
 * relies on none of it: among these kinds a name is given up before it is
 * taken, whatever kinds the two are and wherever they are.
 */
const ONE_NAMESPACE = new Set<string>(["renameEnumType", "renameTable", "renameConstraint", "renameIndex"]);

/** Every name of a schema, of whatever kind. */
function namesOf(model: SchemaModel): string[] {
  return [
    ...model.enums.flatMap((type) => [type.name, ...type.values]),
    ...model.tables.flatMap((table) => [table.name, ...table.columns.map((column) => column.name), ...constraintNames(table), ...table.indexes.map((index) => index.name)]),
  ];
}

/** What a schema means, as text: the same for two models that differ in nothing but where things come from and how they are listed. */
function meaningOf(model: SchemaModel): string {
  const byName = <T extends { name: string }>(items: T[]): T[] => [...items].sort((a, b) => compareText(a.name, b.name));
  return comparable({ enums: byName(model.enums.map(enumState)), tables: byName(model.tables.map((table) => tableState(table, true))) });
}

/** A dropped table without one of the foreign keys it is said to have had: that key is dropped by a step of its own. */
function withoutForeignKey(change: Extract<SchemaChange, { op: "dropTable" }>, key: ForeignKeyState): SchemaChange {
  const keys = [...(change.before.foreignKeys ?? [])];
  const at = keys.findIndex((candidate) => comparable(candidate) === comparable(key));
  if (at >= 0) {
    keys.splice(at, 1);
  }
  return { ...change, before: { ...change.before, foreignKeys: keys } };
}

/**
 * The plan that carries a diff out on a schema. Throws a
 * `DiffApplicationError` for a diff that does not fit the schema (as
 * `applyDiff` does), and a `MigrationPlanError` for a diff that leads to a
 * schema a database would refuse, such as one with a foreign key to a table
 * that is not there.
 *
 * The plan is the same for the same schema and diff, whatever order the
 * schema lists its objects in and the diff its changes.
 */
export function planMigration(before: DatabaseSchema, diff: SchemaDiff): MigrationPlan {
  // What the diff means. This refuses a diff that does not fit, and gives what the plan has to arrive at.
  const expected = SchemaModel.from(before);
  const [taken] = applyDiffTo(expected, diff);
  if (taken !== undefined) {
    throw new MigrationPlanError(
      `Table "${taken.table}": the name "${taken.name}" is given to another constraint, and ${taken.from}, which has it, is left without a name. A plan has to rename it, and nothing says to what: give it a name in the schema to arrive at.`,
    );
  }

  const model = SchemaModel.from(before);
  const session = new Session(model);
  const steps: MigrationStep[] = [];
  const reserved = new Set([...namesOf(model), ...namesOf(expected)]);
  let temporaryNames = 0;
  const temporaryName = (): string => {
    do {
      temporaryNames += 1;
    } while (reserved.has(`migration_tmp_${temporaryNames}`));
    return `migration_tmp_${temporaryNames}`;
  };
  const refuse = (step: MigrationStep, problem: string): never => {
    throw new MigrationPlanError(`${describeOperation(step)} cannot be carried out, at any point of the plan: ${problem}`, step);
  };
  const carryOut = (step: MigrationStep): void => {
    try {
      session.apply(step);
    } catch (error) {
      throw error instanceof OperationProblem ? new MigrationPlanError(`${describeOperation(step)}: ${error.message}`, step) : error;
    }
    steps.push(structuredClone(step));
  };
  const changes = inCanonicalOrder(diff.changes);
  const rankOf = (change: SchemaChange): number => CHANGE_ORDER.indexOf(change.op);

  // 1. What goes: each thing when nothing rests on it any more.
  let going = changes.filter((change) => rankOf(change) < FIRST_RENAME);
  while (going.length > 0) {
    const next = going.find((change) => blockers(model, change).length === 0);
    if (next !== undefined) {
      carryOut(next);
      going = going.filter((change) => change !== next);
      continue;
    }
    /*
     * Nothing can go. Then tables that go refer to each other: for the first
     * of them, the foreign keys of the others that are in its way go first,
     * on their own. (A column that goes is never what is stuck: it waits for
     * a table whose key refers to it, and that table is one of these.)
     */
    const tablesGoing = new Set(going.filter((change) => change.op === "dropTable").map((change) => change.table));
    let released = false;
    for (const change of going) {
      const table = change.op === "dropTable" ? model.table(change.table) : undefined;
      if (table === undefined) {
        continue;
      }
      const inTheWay = model
        .referencesTo(table)
        .filter(({ table: owner }) => owner !== table && tablesGoing.has(owner.name))
        .map(({ table: owner, key }) => ({ owner, state: foreignKeyState(key) }))
        // By table and name; keys that are alike but for where they come from, by all they say: never by the order they are listed in.
        .sort((a, b) => compareText(a.owner.name, b.owner.name) || compareText(a.state.name ?? comparable(a.state), b.state.name ?? comparable(b.state)) || compareText(stableStringify(a.state), stableStringify(b.state)));
      for (const { owner, state } of inTheWay) {
        carryOut({ op: "dropForeignKey", table: owner.name, ...(state.name !== undefined && { constraint: state.name }), before: state, planned: "tables-dropped-together" });
        going = going.map((other) => (other.op === "dropTable" && other.table === owner.name ? withoutForeignKey(other, state) : other));
        released = true;
      }
      if (released) {
        break;
      }
    }
    if (!released) {
      const stuck = going[0] as SchemaChange;
      refuse(stuck, blockers(model, stuck)[0] as string);
    }
  }

  // 2. The renames: each when the name it gives is free.
  let renamings: Renaming[];
  try {
    renamings = resolveRenames(
      session,
      changes.filter((change): change is RenameChange => rankOf(change) >= FIRST_RENAME && rankOf(change) <= LAST_RENAME),
    );
    checkRenameTargets(renamings);
  } catch (error) {
    throw error instanceof OperationProblem ? new MigrationPlanError(error.operation === undefined ? error.message : `${describeOperation(error.operation)}: ${error.message}`, error.operation) : error;
  }
  let waiting = renamings;
  const together = (renaming: Renaming): boolean => ONE_NAMESPACE.has(renaming.change.op);
  /** The renaming whose object has the name another one is to get, and has yet to give it up. */
  const holderFor = (renaming: Renaming): Renaming | undefined => waiting.find((other) => other !== renaming && other.name() === renaming.to && (other.space === renaming.space || (together(other) && together(renaming))));
  while (waiting.length > 0) {
    const next = waiting.find((renaming) => !renaming.taken(renaming.to) && holderFor(renaming) === undefined);
    if (next !== undefined) {
      steps.push(structuredClone({ ...next.operation(next.to), evidence: next.change.evidence }));
      next.rename(next.to);
      next.record(session);
      waiting = waiting.filter((renaming) => renaming !== next);
      continue;
    }
    // Every rename waits for a name another one has: somewhere the names go round. Follow who waits for whom until one comes up again.
    const followed: Renaming[] = [];
    let current: Renaming | undefined = waiting[0];
    while (current !== undefined && !followed.includes(current)) {
      followed.push(current);
      current = holderFor(current);
    }
    if (current === undefined) {
      const stuck = followed.at(-1) as Renaming;
      throw new MigrationPlanError(`${describeOperation(stuck.change)} cannot be carried out, at any point of the plan: ${stuck.takenBy(stuck.to)} already.`, stuck.change);
    }
    // One object of the ring moves out of the way: the one whose name comes first, so that it is always the same one.
    const [away] = followed.slice(followed.indexOf(current)).sort((a, b) => compareText(a.name(), b.name())) as [Renaming];
    const name = temporaryName();
    steps.push({ ...away.operation(name), planned: "rename-cycle", temporaryName: true });
    away.rename(name);
  }

  // 3. What comes and what changes: each when what it needs is there.
  let coming = changes.filter((change) => rankOf(change) > LAST_RENAME);
  while (coming.length > 0) {
    const next = coming.find((change) => blockers(model, change).length === 0);
    if (next === undefined) {
      const stuck = coming[0] as SchemaChange;
      refuse(stuck, blockers(model, stuck)[0] as string);
      break;
    }
    carryOut(next);
    coming = coming.filter((change) => change !== next);
  }

  session.finish();
  const problem = finalProblem(model);
  if (problem !== undefined) {
    throw new MigrationPlanError(`The diff leads to a schema that a database would refuse: ${problem}`);
  }
  if (meaningOf(model) !== meaningOf(expected)) {
    // Not a fault of the diff: the steps above do not add up to what the diff means.
    throw new Error("The migration plan does not arrive at the schema its diff describes. This is a defect of the planner.");
  }
  return { version: MIGRATION_PLAN_VERSION, steps };
}
