import type { SchemaChange } from "../../schema-diff/src/index.ts";
import type { EntityOmissions } from "./project-entities.ts";

/*
 * The changes of a diff that are there because a side that was read from
 * TypeORM entities does not say something (Phase E2, D-044).
 *
 * Entities say no indexes and no unique or check constraints here, and the
 * collection does not read every default, table, column, and key of them.
 * Compared with a side that says more, what the entities lack is listed as
 * dropped where they are <after>, and as added where they are <before>:
 * that may be a difference, or only what was not read. Such a change is
 * shown, with a note, and never written as SQL: a migration from it could
 * drop what the application still has.
 *
 * Nothing of the diff, the plan, or the generator is changed for it. This
 * is about what a command does with a diff whose side says less.
 */

/** Which of the two sides a schema is: what it lacks is dropped when it is `after`, and added when it is `before`. */
export type Side = "before" | "after";

/** Whether a change is there because the entities, on that side, lack something of a kind they did not say. */
function isUnsaid(change: SchemaChange, entities: EntityOmissions, side: Side): boolean {
  const lacking = side === "after" ? "drop" : "add";
  switch (change.op) {
    // Never said: of a table the entities have. A table they do not have is another matter, and so is what goes or comes with it.
    case "dropIndex":
    case "dropUnique":
    case "dropCheck":
      return lacking === "drop" && entities.has.has(change.table);
    case "addIndex":
    case "addUnique":
    case "addCheck":
      return lacking === "add" && entities.has.has(change.table);
    // Said, but for what the collection reported that it did not read.
    case "dropTable":
      return lacking === "drop" && entities.tables;
    case "addTable":
      return lacking === "add" && entities.tables;
    case "dropColumn":
      return lacking === "drop" && entities.columns.has(change.table);
    case "addColumn":
      return lacking === "add" && entities.columns.has(change.table);
    case "dropForeignKey":
    case "dropPrimaryKey":
      return lacking === "drop" && entities.keys.has(change.table);
    case "addForeignKey":
    case "addPrimaryKey":
      return lacking === "add" && entities.keys.has(change.table);
    case "dropDefault":
      return lacking === "drop" && entities.defaults.has(`${change.table}.${change.column}`);
    case "setDefault":
      // A default where there was none; one that replaces another is a difference of two that were said.
      return lacking === "add" && change.before === undefined && entities.defaults.has(`${change.table}.${change.column}`);
    default:
      return false;
  }
}

/** The positions, in `changes`, of those that are of what the entities on that side do not say. None when that side was not read from entities. */
export function unsaidChanges(changes: readonly SchemaChange[], entities: EntityOmissions | undefined, side: Side): number[] {
  return entities === undefined ? [] : changes.flatMap((change, position) => (isUnsaid(change, entities, side) ? [position] : []));
}

/** What entities are as a side, for whoever is told that a change may only be what they do not say. */
export const ENTITIES_SAY_LESS = "It was read from TypeORM entities, which say no indexes and no unique or check constraints, and of which not every default, table, column, and key is read";

/** The sentence that says how many changes, or steps, are of what a side does not say. `total`: how many there are in all, when that is said too. */
export function unsaidSentence(count: number, what: "change" | "step", side: Side, total?: number): string {
  const all = total === undefined ? `the ${what}s` : `the ${total} ${what}${total === 1 ? "" : "s"}`;
  return `${count} of ${all} ${count === 1 ? "is" : "are"} of what <${side}> does not say. ${ENTITIES_SAY_LESS}: such a ${what} may be a difference, or only what was not read.`;
}
