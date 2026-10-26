import type { ObjectProvenance } from "../../runtime/src/index.ts";
import type { RenameEvidence, SchemaChange } from "../../schema-diff/src/index.ts";
import type { ModelEnum, ModelTable, SchemaModel } from "./model.ts";
import { OperationProblem, checkIdentity, constraintNames, constraintOfKind, fail } from "./operations.ts";
import type { Session } from "./operations.ts";
import type { Operation } from "./plan.ts";

/*
 * The renames of a diff, each bound to the object it renames (D-038).
 *
 * A diff's renames stand together, after what goes and before what comes. A
 * rename says its object's old name (`from`), but says where the object is
 * by the names of the after side: the column `name` of the table that is
 * called `accounts` afterwards. So the objects are found once, before any
 * of them is renamed, and held; from then on a rename can be carried out at
 * any moment and in any order, and still means the same object.
 */

export type RenameChange = Extract<SchemaChange, { evidence: RenameEvidence }>;

export const RENAME_KINDS = ["renameEnumType", "renameEnumValue", "renameTable", "renameColumn", "renameConstraint", "renameIndex"] as const satisfies readonly RenameChange["op"][];

export interface Renaming {
  readonly change: RenameChange;
  /** The name the change gives the object. */
  readonly to: string;
  /** Where the object's name is its own: two renamings with the same space must not give one name. */
  readonly space: object;
  /** The object's name now. */
  name(): string;
  /** What is renamed, with the names things have now: `the column "users"."name"`. */
  describe(): string;
  /** The kind of thing, and where its name is its own: `column of table "users"`. */
  kind(): string;
  /** Whether another object of the space has the name now. */
  taken(name: string): boolean;
  /** What the name is taken by, for a message: `table "users" has a column "x"`. */
  takenBy(name: string): string;
  /** Renames the object. What refers to it follows. */
  rename(to: string): void;
  /** The rename to `to` as an operation, with the names things have now. It has no evidence. */
  operation(to: string): Operation;
  /** Adds the renames the change gives as evidence to those the object records. */
  record(session: Session): void;
  /**
   * Takes a name from whatever else has it where this object's name is its
   * own. Only a constraint has this: a diff's after side may leave a
   * constraint without a name and give its old name to another.
   */
  release?(name: string, session: Session): void;
}

/**
 * Finds the object of every rename. `model` is as it is before any of them:
 * after what the diff drops. Refuses a rename of an object that is not
 * there, or that is not the one the evidence is of, and two renames of one
 * object.
 */
export function resolveRenames(session: Session, changes: readonly RenameChange[]): Renaming[] {
  const model: SchemaModel = session.model;
  const renamings: Renaming[] = [];
  const bound = new Map<unknown, RenameChange>();
  /** Runs `find` for one change; a problem it finds is a problem of that change. */
  const resolve = <T extends RenameChange>(change: T, find: () => { object: unknown; what: string; provenance: ObjectProvenance; renaming: Omit<Renaming, "change" | "to"> & { to: string } }): void => {
    try {
      const { object, what, provenance, renaming } = find();
      checkIdentity(provenance, change.evidence, what);
      if (bound.has(object)) {
        fail(`another change renames ${what} as well.`);
      }
      bound.set(object, change);
      renamings.push({ change, ...renaming });
    } catch (error) {
      throw error instanceof OperationProblem ? new OperationProblem(error.message, change) : error;
    }
  };
  const of = <K extends RenameChange["op"]>(op: K): Extract<RenameChange, { op: K }>[] => changes.filter((change): change is Extract<RenameChange, { op: K }> => change.op === op);

  // Enumerated types, then their values: a value's type is named as it is called afterwards.
  const enumAfter = new Map<string, ModelEnum>();
  for (const change of of("renameEnumType")) {
    resolve(change, () => {
      const type = session.enumType(change.from);
      enumAfter.set(change.enum, type);
      return {
        object: type,
        what: `the enumerated type "${change.from}"`,
        provenance: type,
        renaming: {
          to: change.enum,
          space: model.enums,
          name: () => type.name,
          describe: () => `the enumerated type "${type.name}"`,
          kind: () => "enumerated type",
          taken: (name) => model.enums.some((other) => other !== type && other.name === name),
          takenBy: (name) => `there is an enumerated type "${name}"`,
          rename: (to) => model.renameEnum(type, to),
          operation: (to) => ({ op: "renameEnumType", enum: to, from: type.name }),
          record: (run) => run.recordRenames(type, change.evidence),
        },
      };
    });
  }
  const renamedEnums = new Set(enumAfter.values());
  const enumCalled = (name: string): ModelEnum => {
    const type = enumAfter.get(name) ?? model.enumType(name);
    // A type that is renamed away is not what its old name means afterwards.
    return type !== undefined && (enumAfter.has(name) || !renamedEnums.has(type)) ? type : fail(`there is no enumerated type "${name}".`);
  };
  for (const change of of("renameEnumValue")) {
    resolve(change, () => {
      const type = enumCalled(change.enum);
      if (!type.values.includes(change.from)) {
        fail(`the type has no value "${change.from}".`);
      }
      let current = change.from;
      return {
        // A value has no object of its own: it is its type and the name it had.
        object: `${model.enums.indexOf(type)} ${change.from}`,
        what: `the value "${change.from}" of the enumerated type "${type.name}"`,
        provenance: type,
        renaming: {
          to: change.to,
          space: type,
          name: () => current,
          describe: () => `the value "${current}" of the enumerated type "${type.name}"`,
          kind: () => `value of the enumerated type "${type.name}"`,
          taken: (name) => name !== current && type.values.includes(name),
          takenBy: (name) => `the enumerated type "${type.name}" has the value "${name}"`,
          rename: (to) => {
            model.renameEnumValue(type, current, to);
            current = to;
          },
          operation: (to) => ({ op: "renameEnumValue", enum: type.name, from: current, to }),
          record: (run) => run.recordValueRenames(type, change.evidence),
        },
      };
    });
  }

  // Tables, then what is in them: a column's table is named as it is called afterwards.
  const tableAfter = new Map<string, ModelTable>();
  for (const change of of("renameTable")) {
    resolve(change, () => {
      const table = session.table(change.from);
      tableAfter.set(change.table, table);
      return {
        object: table,
        what: `the table "${change.from}"`,
        provenance: table,
        renaming: {
          to: change.table,
          space: model.tables,
          name: () => table.name,
          describe: () => `the table "${table.name}"`,
          kind: () => "table",
          taken: (name) => model.tables.some((other) => other !== table && other.name === name),
          takenBy: (name) => `there is a table "${name}"`,
          rename: (to) => model.renameTable(table, to),
          operation: (to) => ({ op: "renameTable", table: to, from: table.name }),
          record: (run) => run.recordRenames(table, change.evidence),
        },
      };
    });
  }
  const renamedTables = new Set(tableAfter.values());
  const tableCalled = (name: string): ModelTable => {
    const table = tableAfter.get(name) ?? model.table(name);
    return table !== undefined && (tableAfter.has(name) || !renamedTables.has(table)) ? table : fail(`there is no table "${name}".`);
  };
  // One space for the columns of a table and one for its constraints and indexes, which are found by the table.
  const spaces = new Map<ModelTable, { columns: object; constraints: object; indexes: object }>();
  const spaceOf = (table: ModelTable): { columns: object; constraints: object; indexes: object } => spaces.get(table) ?? (spaces.set(table, { columns: {}, constraints: {}, indexes: {} }).get(table) as { columns: object; constraints: object; indexes: object });

  for (const change of of("renameColumn")) {
    resolve(change, () => {
      const table = tableCalled(change.table);
      const column = session.column(table, change.from);
      return {
        object: column,
        what: `the column "${table.name}"."${change.from}"`,
        provenance: column,
        renaming: {
          to: change.column,
          space: spaceOf(table).columns,
          name: () => column.name,
          describe: () => `the column "${table.name}"."${column.name}"`,
          kind: () => `column of table "${table.name}"`,
          taken: (name) => table.columns.some((other) => other !== column && other.name === name),
          takenBy: (name) => `table "${table.name}" has a column "${name}"`,
          rename: (to) => model.renameColumn(table, column, to),
          operation: (to) => ({ op: "renameColumn", table: table.name, column: to, from: column.name }),
          record: (run) => run.recordRenames(column, change.evidence),
        },
      };
    });
  }
  for (const change of of("renameConstraint")) {
    resolve(change, () => {
      const table = tableCalled(change.table);
      const constraint = constraintOfKind(table, change.kind, change.from);
      return {
        object: constraint,
        what: `the constraint "${change.from}" of table "${table.name}"`,
        provenance: constraint,
        renaming: {
          to: change.constraint,
          space: spaceOf(table).constraints,
          name: () => constraint.name as string,
          describe: () => `the constraint "${constraint.name}" of table "${table.name}"`,
          kind: () => `constraint of table "${table.name}"`,
          taken: (name) => name !== constraint.name && constraintNames(table).includes(name),
          takenBy: (name) => `table "${table.name}" has a constraint "${name}"`,
          rename: (to) => {
            constraint.name = to;
          },
          operation: (to) => ({ op: "renameConstraint", table: table.name, kind: change.kind, constraint: to, from: constraint.name as string }),
          record: (run) => {
            run.recordRenames(constraint, change.evidence);
            run.gave(table, constraint.name);
          },
          release: (name, run) => run.takeName(table, name),
        },
      };
    });
  }
  for (const change of of("renameIndex")) {
    resolve(change, () => {
      const table = tableCalled(change.table);
      const index = table.indexes.find((candidate) => candidate.name === change.from) ?? fail(`table "${table.name}" has no index "${change.from}".`);
      return {
        object: index,
        what: `the index "${change.from}" of table "${table.name}"`,
        provenance: index,
        renaming: {
          to: change.index,
          space: spaceOf(table).indexes,
          name: () => index.name,
          describe: () => `the index "${index.name}" of table "${table.name}"`,
          kind: () => `index of table "${table.name}"`,
          taken: (name) => table.indexes.some((other) => other !== index && other.name === name),
          takenBy: (name) => `table "${table.name}" has an index "${name}"`,
          rename: (to) => {
            index.name = to;
          },
          operation: (to) => ({ op: "renameIndex", table: table.name, index: to, from: index.name }),
          record: (run) => run.recordRenames(index, change.evidence),
        },
      };
    });
  }
  return renamings;
}

/**
 * Refuses renames that cannot all be: two that give one name where a name is
 * an object's own, and one that gives a name that something else keeps.
 */
export function checkRenameTargets(renamings: readonly Renaming[]): void {
  for (const [position, renaming] of renamings.entries()) {
    if (renamings.slice(0, position).some((other) => other.space === renaming.space && other.to === renaming.to)) {
      fail(`another change gives the name "${renaming.to}" to another ${renaming.kind()}.`, renaming.change);
    }
    const releasing = renamings.some((other) => other !== renaming && other.space === renaming.space && other.name() === renaming.to);
    if (renaming.taken(renaming.to) && !releasing) {
      fail(`${renaming.takenBy(renaming.to)} already.`, renaming.change);
    }
  }
}
