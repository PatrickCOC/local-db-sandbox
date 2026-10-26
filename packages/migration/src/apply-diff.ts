import type { DatabaseSchema } from "../../runtime/src/index.ts";
import { CHANGE_ORDER, SCHEMA_DIFF_VERSION, stableStringify } from "../../schema-diff/src/index.ts";
import type { SchemaChange, SchemaChangeOp, SchemaDiff } from "../../schema-diff/src/index.ts";
import { compareText } from "../../schema-diff/src/stable-json.ts";
import { SchemaModel } from "./model.ts";
import { OperationProblem, Session, checkOperation, describeOperation, schemaProblems } from "./operations.ts";
import type { NameTaken } from "./operations.ts";
import { RENAME_KINDS, checkRenameTargets, resolveRenames } from "./renames.ts";
import type { RenameChange } from "./renames.ts";

/*
 * What a schema diff means, applied to a schema (D-038):
 *
 *   applyDiff(A, diffSchemas(A, B)) means B.
 *
 * A diff's changes stand in three parts (`ir.ts` of the schema diff), and
 * they are applied as that says:
 *
 * 1. What goes, found by the names the schema has.
 * 2. The renames. Those of one kind are applied at once, not one after
 *    another: two tables that exchange their names, or pass a name on, are
 *    each simply renamed. What refers to a renamed object follows it.
 * 3. What comes and what changes, by the names things have after the
 *    renames.
 *
 * The order of the changes within the list is not read: it is only an order
 * of names. So the same changes in another order give the same schema.
 *
 * This says what a diff means, not how a database is brought there: nothing
 * here cares whether a step could be taken alone. That is the plan's
 * (`planner.ts`).
 */

/** A diff that cannot be applied to the schema it is given. The message says which change, and why. */
export class DiffApplicationError extends Error {
  /** The change that does not fit, when it is one change. */
  readonly change?: SchemaChange;

  constructor(message: string, change?: SchemaChange) {
    super(message);
    this.name = "DiffApplicationError";
    if (change !== undefined) {
      this.change = change;
    }
  }
}

const KNOWN = new Set<string>(CHANGE_ORDER);
const RENAMES = new Set<string>(RENAME_KINDS);
const FIRST_RENAME = CHANGE_ORDER.indexOf(RENAME_KINDS[0]);

/** The changes of a diff in one order, whatever order the list has them in: by kind, then by all they say. */
export function inCanonicalOrder(changes: readonly SchemaChange[]): SchemaChange[] {
  const rank = new Map<string, number>(CHANGE_ORDER.map((op, index) => [op, index]));
  return changes
    .map((change) => ({ change, text: stableStringify(change) }))
    .sort((a, b) => (rank.get(a.change.op) as number) - (rank.get(b.change.op) as number) || compareText(a.text, b.text))
    .map((entry) => entry.change);
}

/** Refuses a diff of another version, a change of a kind that this version does not have, and a change that is not whole or says two things. */
export function checkDiff(diff: SchemaDiff): void {
  if (typeof diff !== "object" || diff === null) {
    throw new DiffApplicationError("This is not a schema diff.");
  }
  if ((diff.diffVersion as number) !== SCHEMA_DIFF_VERSION) {
    throw new DiffApplicationError(`This is a schema diff of version ${String(diff.diffVersion)}; version ${SCHEMA_DIFF_VERSION} is the one that can be applied.`);
  }
  if (!Array.isArray(diff.changes)) {
    throw new DiffApplicationError("This schema diff has no list of changes.");
  }
  for (const [index, change] of (diff.changes as unknown[]).entries()) {
    if (typeof change !== "object" || change === null) {
      throw new DiffApplicationError(`Change ${index + 1} of the diff is not a change.`);
    }
  }
  for (const change of diff.changes) {
    if (!KNOWN.has(change.op)) {
      throw new DiffApplicationError(`${String(change.op)}: this kind of change is not known.`, change);
    }
    attempt(change, () => checkOperation(change));
  }
}

/** Runs `step`; what it finds wrong is said as a problem of the change. */
function attempt(change: SchemaChange | undefined, step: () => void): void {
  try {
    step();
  } catch (error) {
    if (error instanceof OperationProblem) {
      const about = (error.operation as SchemaChange | undefined) ?? change;
      throw new DiffApplicationError(about === undefined ? error.message : `${describeOperation(about)}: ${error.message}`, about);
    }
    throw error;
  }
}

/** Whether a value can be added to its type now: what it is put after or before is there. */
function anchored(model: SchemaModel, change: Extract<SchemaChange, { op: "addEnumValue" }>): boolean {
  const anchor = change.afterValue ?? change.beforeValue;
  const type = model.enumType(change.enum);
  return anchor === undefined || type === undefined || type.values.includes(anchor);
}

/**
 * The diff applied to a model of the schema. Returns the names that the diff
 * took from constraints which it leaves without a name: what the diff means
 * is clear there, and how a database gets there is not (`planner.ts`).
 */
export function applyDiffTo(model: SchemaModel, diff: SchemaDiff): NameTaken[] {
  checkDiff(diff);
  // A diff is read as a description: a name it gives to a constraint is taken from one that the after side leaves without a name.
  const session = new Session(model, { namesYield: true });
  const changes = inCanonicalOrder(diff.changes);
  const isRename = (change: SchemaChange): change is RenameChange => RENAMES.has(change.op);
  const rankOf = (change: SchemaChange): number => CHANGE_ORDER.indexOf(change.op as SchemaChangeOp);

  // 1. What goes.
  for (const change of changes.filter((candidate) => rankOf(candidate) < FIRST_RENAME)) {
    attempt(change, () => session.apply(change));
  }

  // 2. The renames: every object is found first, then all of a kind are renamed at once, by way of names nothing has.
  attempt(undefined, () => {
    const renamings = resolveRenames(session, changes.filter(isRename));
    for (const renaming of renamings) {
      if (renaming.release !== undefined && renaming.taken(renaming.to) && !renamings.some((other) => other !== renaming && other.space === renaming.space && other.name() === renaming.to)) {
        renaming.release(renaming.to, session);
      }
    }
    checkRenameTargets(renamings);
    for (const kind of RENAME_KINDS) {
      const together = renamings.filter((renaming) => renaming.change.op === kind);
      together.forEach((renaming, index) => renaming.rename(`\u0000${index}`));
      together.forEach((renaming) => renaming.rename(renaming.to));
    }
    renamings.forEach((renaming) => renaming.record(session));
  });

  // 3. What comes and what changes. Values are added to a type in the order in which each has what it is put next to.
  let waiting: SchemaChange[] = [];
  for (const change of changes.filter((candidate) => rankOf(candidate) >= FIRST_RENAME && !isRename(candidate))) {
    if (change.op === "addEnumValue") {
      waiting.push(change);
      continue;
    }
    waiting = addValues(model, session, waiting, true);
    attempt(change, () => session.apply(change));
  }
  addValues(model, session, waiting, true);

  session.finish();
  const [problem] = schemaProblems(model, false);
  if (problem !== undefined) {
    throw new DiffApplicationError(`The diff leaves a schema that does not hold together: ${problem}`);
  }
  return session.namesTaken;
}

/** Adds the values that wait, each when what it is put next to is there. With `all`, one that never can be is a problem. */
function addValues(model: SchemaModel, session: Session, waiting: SchemaChange[], all: boolean): SchemaChange[] {
  let left = waiting as Extract<SchemaChange, { op: "addEnumValue" }>[];
  while (left.length > 0) {
    const next = left.find((change) => anchored(model, change)) ?? (all ? left[0] : undefined);
    if (next === undefined) {
      break;
    }
    attempt(next, () => session.apply(next));
    left = left.filter((change) => change !== next);
  }
  return left;
}

/**
 * The schema that a diff makes of a schema. The schema that is given is not
 * changed. Throws a `DiffApplicationError` for a diff that does not fit it:
 * a change of something that is not there or is not what the change says it
 * was, a rename of another object than the one its evidence is of, and
 * changes that leave a schema that does not hold together.
 */
export function applyDiff(before: DatabaseSchema, diff: SchemaDiff): DatabaseSchema {
  const model = SchemaModel.from(before);
  applyDiffTo(model, diff);
  return model.toSchema();
}
