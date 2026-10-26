import type { ExpressionName } from "./runtime.ts";

/*
 * What the text of an expression names (`ExpressionName`, D-040): the names
 * a rename can reach, each with what its thing is called now. Pure: this is
 * the canonical schema's own code, like its canonical types.
 */

export const EXPRESSION_NAME_KINDS: readonly ExpressionName["kind"][] = ["column", "table", "type", "value", "function"];

/** A name with its keys in one order, and without a `now` that is the name the text has. */
export function copyExpressionName(entry: ExpressionName): ExpressionName {
  return { kind: entry.kind, name: entry.name, ...(entry.now !== undefined && entry.now !== entry.name && { now: entry.now }), ...(entry.type !== undefined && { type: entry.type }) };
}

/** The names a text is stale by: those of things that are called something else now. */
export function staleNamesOf(names: readonly ExpressionName[] | undefined): ExpressionName[] {
  return (names ?? []).filter((entry) => entry.now !== undefined && entry.now !== entry.name).map(copyExpressionName);
}

/** Whether a text names the thing of one kind that is called `name` now; `type`: of a value, its type. */
export function namedNow(names: readonly ExpressionName[] | undefined, kind: ExpressionName["kind"], name: string, type?: string): boolean {
  return (names ?? []).some((entry) => entry.kind === kind && (entry.now ?? entry.name) === name && (kind !== "value" || entry.type === type));
}

/** A thing that is renamed: a column of the expression's table, the table, an enumerated type, or a value of one (`type`, as its type is called). */
export interface RenamedThing {
  kind: "column" | "table" | "type" | "value";
  from: string;
  to: string;
  type?: string;
}

/**
 * The names of a text after a thing is renamed. A name of that thing has
 * what the thing is called from here on, and is not stale when that is what
 * the text says. A value is its type's: it follows the rename of its type,
 * and a value of the same name of another type is another thing.
 */
export function namesAfterRename(names: readonly ExpressionName[], renamed: RenamedThing): ExpressionName[] {
  return names.map((entry) => {
    if (renamed.kind === "type" && entry.kind === "value" && entry.type === renamed.from) {
      return copyExpressionName({ ...entry, type: renamed.to });
    }
    const isIt = entry.kind === renamed.kind && (entry.now ?? entry.name) === renamed.from && (renamed.kind !== "value" || entry.type === renamed.type);
    return copyExpressionName(isIt ? { ...entry, now: renamed.to } : entry);
  });
}
