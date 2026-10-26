import { indexKeysProblem } from "../../runtime/src/index-definition.ts";
import type { ObjectProvenance, SchemaOrigin } from "../../runtime/src/index.ts";
import type { RenameEvidence } from "../../schema-diff/src/index.ts";
import { compareText } from "../../schema-diff/src/stable-json.ts";
import { checkFromState, checkState, columnState, comparable, defaultState, enumNamesIn, enumState, foreignKeyState, hasText, indexFromState, indexState, primaryKeyState, tableState, typeState, uniqueFromState, uniqueState } from "./model.ts";
import type { ModelColumn, ModelEnum, ModelTable, SchemaModel } from "./model.ts";
import type { Operation } from "./plan.ts";

/*
 * One operation carried out on a model of a schema (D-038). This is what an
 * operation means, and it is the same for a change of a diff and for a step
 * of a plan: the object is looked up by the name it has now, what the
 * operation says the object was is compared with what it is, and the model
 * is changed.
 *
 * What is refused here is what makes no sense on any schema: an object that
 * is not there, or is not what the operation says. What may not be done at
 * a given moment of a migration (a table dropped while a foreign key refers
 * to it) is a rule of plans, in `rules.ts`.
 */

/** Why an operation cannot be carried out. The message says what is wrong; who catches it says with which operation. */
export class OperationProblem extends Error {
  readonly operation?: Operation;

  constructor(problem: string, operation?: Operation) {
    super(problem);
    this.name = "OperationProblem";
    if (operation !== undefined) {
      this.operation = operation;
    }
  }
}

export function fail(problem: string, operation?: Operation): never {
  throw new OperationProblem(problem, operation);
}

/** A name in quotes; what should be a name and is none, as that. */
function quoted(name: unknown): string {
  return typeof name === "string" ? `"${name}"` : "<none>";
}

/** An operation in a few words, with the names it has: `renameColumn "users"."name" to "full_name"`. */
export function describeOperation(operation: Operation): string {
  const op = operation.op;
  switch (operation.op) {
    case "dropTable":
    case "addTable":
      return `${op} ${quoted(operation.table)}`;
    case "renameTable":
      return `${op} ${quoted(operation.from)} to ${quoted(operation.table)}`;
    case "dropColumn":
    case "addColumn":
    case "dropDefault":
    case "alterColumnType":
    case "dropNotNull":
    case "setNotNull":
    case "setDefault":
      return `${op} ${quoted(operation.table)}.${quoted(operation.column)}`;
    case "renameColumn":
      return `${op} ${quoted(operation.table)}.${quoted(operation.from)} to ${quoted(operation.column)}`;
    case "dropForeignKey":
    case "dropCheck":
    case "dropUnique":
    case "dropPrimaryKey":
    case "addPrimaryKey":
    case "addUnique":
    case "addCheck":
    case "addForeignKey":
      return `${op}${operation.constraint === undefined ? "" : ` ${quoted(operation.constraint)}`} of table ${quoted(operation.table)}`;
    case "dropIndex":
    case "addIndex":
      return `${op} ${quoted(operation.index)} of table ${quoted(operation.table)}`;
    case "renameConstraint":
      return `${op} ${quoted(operation.from)} of table ${quoted(operation.table)} to ${quoted(operation.constraint)}`;
    case "renameIndex":
      return `${op} ${quoted(operation.from)} of table ${quoted(operation.table)} to ${quoted(operation.index)}`;
    case "addEnumType":
    case "dropEnumType":
      return `${op} ${quoted(operation.enum)}`;
    case "renameEnumType":
      return `${op} ${quoted(operation.from)} to ${quoted(operation.enum)}`;
    case "addEnumValue":
    case "removeEnumValue":
      return `${op} ${quoted(operation.value)} of enumerated type ${quoted(operation.enum)}`;
    case "renameEnumValue":
      return `${op} ${quoted(operation.from)} of enumerated type ${quoted(operation.enum)} to ${quoted(operation.to)}`;
    case "replaceEnumValues":
      return `${op} of enumerated type ${quoted(operation.enum)}`;
    default:
      return String(op);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Refuses an operation that is not all there, or that says two things: one
 * whose state is of another name than the operation is of, and a table that
 * is added with more than a table is added with. An operation that passes
 * can be read without looking whether each part of it is there.
 */
export function checkOperation(operation: Operation): void {
  const whole = operation as unknown as Record<string, unknown>;
  const names = (...keys: string[]): void => {
    for (const key of keys) {
      if (typeof whole[key] !== "string") {
        fail(`the change has no "${key}".`);
      }
    }
  };
  /** The state under `key`, with the members a state of its kind has. */
  const state = (key: "before" | "after", members: Record<string, "string" | "boolean" | "array" | "object">): Record<string, unknown> => {
    const found = whole[key];
    if (!isRecord(found)) {
      return fail(`the change has no "${key}".`);
    }
    part(key, found, members);
    return found;
  };
  const part = (where: string, found: Record<string, unknown>, members: Record<string, "string" | "boolean" | "array" | "object">): void => {
    for (const [member, kind] of Object.entries(members)) {
      const value = found[member];
      const there = kind === "array" ? Array.isArray(value) : kind === "object" ? isRecord(value) : typeof value === kind;
      if (!there) {
        fail(`"${where}" has no "${member}".`);
      }
    }
  };
  /** The operation is of the thing its state describes: one name, said twice. */
  const sameName = (key: "before" | "after", named: unknown, noun: string): void => {
    const described = (whole[key] as Record<string, unknown>).name;
    if (described !== named) {
      const of = named === undefined ? `the change names no ${noun}` : `the change is of "${String(named)}"`;
      fail(`${of}, and what it describes ${described === undefined ? "has no name" : `is called "${String(described)}"`}.`);
    }
  };
  const COLUMN = { name: "string", type: "object", nullable: "boolean" } as const;
  const side = operation.op.startsWith("drop") ? "before" : "after";

  switch (operation.op) {
    case "dropForeignKey":
    case "addForeignKey": {
      names("table");
      const key = state(side, { columns: "array", references: "object", onDelete: "string", onUpdate: "string" });
      part(`${side}.references`, key.references as Record<string, unknown>, { table: "string", columns: "array" });
      return sameName(side, whole.constraint, "constraint");
    }
    case "dropCheck":
    case "addCheck":
      names("table");
      state(side, { expression: "string" });
      return sameName(side, whole.constraint, "constraint");
    case "dropUnique":
    case "addUnique":
    case "dropPrimaryKey":
    case "addPrimaryKey":
      names("table");
      state(side, { columns: "array" });
      return sameName(side, whole.constraint, "constraint");
    case "dropIndex":
    case "addIndex":
      names("table", "index");
      state(side, { name: "string", columns: "array", unique: "boolean" });
      return sameName(side, whole.index, "index");
    case "dropColumn":
    case "addColumn": {
      names("table", "column");
      const column = state(side, COLUMN);
      part(`${side}.type`, column.type as Record<string, unknown>, { storage: "string" });
      return sameName(side, whole.column, "column");
    }
    case "dropTable":
    case "addTable": {
      names("table");
      const table = state(side, { name: "string", columns: "array", uniques: "array", checks: "array" });
      sameName(side, whole.table, "table");
      const columns = table.columns as unknown[];
      for (const column of columns) {
        if (!isRecord(column)) {
          return fail(`"${side}" has a column that is no column.`);
        }
        part(`${side}.columns`, column, COLUMN);
        part(`${side}.columns`, column.type as Record<string, unknown>, { storage: "string" });
      }
      if (operation.op === "addTable") {
        const has = (name: unknown): boolean => columns.some((column) => (column as { name: unknown }).name === name);
        const over = (what: string, list: unknown): void => {
          for (const name of Array.isArray(list) ? list : []) {
            if (!has(name)) {
              fail(`its ${what} is over the column "${String(name)}", which it does not have.`);
            }
          }
        };
        over("primary key", operation.after.primaryKey?.columns);
        operation.after.uniques.forEach((unique) => over(`unique constraint${unique.name === undefined ? "" : ` "${unique.name}"`}`, unique.columns));
        // What refers to other tables, and what is no part of a table's definition, comes when the table is there.
        for (const [list, noun] of [
          ["foreignKeys", "foreign keys"],
          ["indexes", "indexes"],
        ] as const) {
          const count = operation.after[list]?.length ?? 0;
          if (count > 0) {
            fail(`an added table's ${noun} are changes of their own; this one lists ${count}.`);
          }
        }
      }
      return;
    }
    case "renameEnumType":
      return names("enum", "from");
    case "renameEnumValue":
      return names("enum", "from", "to");
    case "renameTable":
      return names("table", "from");
    case "renameColumn":
      return names("table", "column", "from");
    case "renameConstraint":
      names("table", "constraint", "from");
      if (!["primaryKey", "unique", "foreignKey", "check"].includes(String(whole.kind))) {
        fail('the change has no "kind" of constraint.');
      }
      return;
    case "renameIndex":
      return names("table", "index", "from");
    case "addEnumType":
    case "dropEnumType":
      names("enum");
      state(side, { name: "string", values: "array" });
      return sameName(side, whole.enum, "enumerated type");
    case "addEnumValue":
    case "removeEnumValue":
      return names("enum", "value");
    case "replaceEnumValues":
      names("enum");
      if (!Array.isArray(whole.before) || !Array.isArray(whole.after)) {
        fail(`the change has no "${Array.isArray(whole.before) ? "after" : "before"}".`);
      }
      return;
    case "dropDefault":
      names("table", "column");
      state("before", { kind: "string" });
      return;
    case "setDefault":
      names("table", "column");
      state("after", { kind: "string" });
      return;
    case "alterColumnType":
      names("table", "column");
      state("before", { storage: "string" });
      state("after", { storage: "string" });
      return;
    case "dropNotNull":
    case "setNotNull":
      return names("table", "column");
    default:
      return fail("this kind of change is not known.");
  }
}

function sameOrigin(a: SchemaOrigin, b: SchemaOrigin): boolean {
  return a.source === b.source && a.file === b.file && a.sha256 === b.sha256 && a.statement === b.statement && a.name === b.name;
}

const created = (origin: SchemaOrigin): string => `statement ${origin.statement} of ${origin.file} created as "${origin.name}"`;

/**
 * A rename with evidence is a rename of one object: the one with the origin
 * the evidence gives. `what` names the object: `the column "users"."name"`.
 */
export function checkIdentity(object: ObjectProvenance, evidence: RenameEvidence | undefined, what: string): void {
  if (evidence === undefined) {
    return;
  }
  if (object.origin === undefined) {
    fail(`${what} does not say where it comes from, so it cannot be told to be the one the change renames.`);
  }
  if (!sameOrigin(object.origin, evidence.origin)) {
    fail(`${what} is not the one the change renames: it was created by statement ${object.origin.statement} of ${object.origin.file} as "${object.origin.name}", and the change renames what ${created(evidence.origin)}.`);
  }
}

/** Fails unless what the schema has is what the operation says it was. */
function fits(what: string, current: unknown, expected: unknown, plural = false): void {
  if (comparable(current) !== comparable(expected)) {
    const shown = (state: unknown): string => (state === undefined ? "none" : comparable(state));
    fail(`${what} ${plural ? "are" : "is"} not what the change says ${plural ? "they were" : "it was"}. The schema has ${shown(current)}; the change says ${shown(expected)}.`);
  }
}

type ConstraintList = "uniques" | "foreignKeys" | "checks";
const CONSTRAINT_NOUN: Record<ConstraintList, string> = { uniques: "unique constraint", foreignKeys: "foreign key", checks: "check" };

/** Every name a table's constraints have. */
export function constraintNames(table: ModelTable): string[] {
  return [table.primaryKey?.name, ...table.uniques.map((unique) => unique.name), ...table.foreignKeys.map((key) => key.name), ...table.checks.map((check) => check.name)].filter((name): name is string => name !== undefined);
}

/** A name that a diff gives to a constraint while another constraint of the table has it, which is then left without a name. */
export interface NameTaken {
  table: string;
  name: string;
  /** What had the name: "the primary key", "a unique constraint", ... */
  from: string;
}

/**
 * Operations carried out on one model, one after another. `finish` settles
 * what only the whole says: which numbered columns the runtime numbers, and
 * the order of the value renames that were recorded.
 */
export class Session {
  readonly model: SchemaModel;
  /**
   * A name that an operation gives to a constraint is taken from a constraint
   * of the table that has it and that no operation is about. This is how a
   * diff is read: its after side may leave a key without a name (the columns'
   * marks give it) and give the key's old name to something else. The steps
   * of a plan are not read so: there a name that is taken is taken.
   */
  readonly #namesYield: boolean;
  readonly #rekeyed = new Set<ModelTable>();
  readonly #redefined = new Map<ModelColumn, ModelTable>();
  /** For each type that got value renames recorded: how many it had before. */
  readonly #valueRenames = new Map<ModelEnum, number>();
  /** Types that were added, or got values added: what the operations say of them is not all of their history. */
  readonly #valuesAdded = new Set<ModelEnum>();

  constructor(model: SchemaModel, options: { namesYield?: boolean } = {}) {
    this.model = model;
    this.#namesYield = options.namesYield === true;
  }

  /** The names that were taken from constraints, each with the table and with what had it. */
  readonly namesTaken: NameTaken[] = [];
  /** The names that operations here gave to constraints, by table. */
  readonly #given = new Map<ModelTable, Set<string>>();

  /** Notes that an operation gave a constraint of a table its name: that name is not taken from it again. */
  gave(table: ModelTable, name: string | undefined): void {
    if (name !== undefined) {
      this.#given.set(table, (this.#given.get(table) ?? new Set<string>()).add(name));
    }
  }

  /**
   * Takes a name from the constraints of a table that have it. Not a name
   * that an operation here gave: what a diff names twice is named twice in
   * the schema it describes, which a schema file may be and no database is.
   */
  takeName(table: ModelTable, name: string): void {
    if (this.#given.get(table)?.has(name) === true) {
      return;
    }
    const constraints: [string, { name?: string } | undefined][] = [
      ["the primary key", table.primaryKey],
      ...table.uniques.map((unique): [string, { name?: string }] => ["a unique constraint", unique]),
      ...table.foreignKeys.map((key): [string, { name?: string }] => ["a foreign key", key]),
      ...table.checks.map((check): [string, { name?: string }] => ["a check", check]),
    ];
    for (const [from, constraint] of constraints) {
      if (constraint !== undefined && constraint.name === name) {
        delete constraint.name;
        this.namesTaken.push({ table: table.name, name, from });
      }
    }
  }

  /** A constraint is given a name: with `namesYield`, whatever has it gives it up. (Without, the rules of a plan have refused the step.) */
  #naming(table: ModelTable, name: string | undefined): void {
    if (name !== undefined && this.#namesYield) {
      this.takeName(table, name);
    }
    this.gave(table, name);
  }

  table(name: string): ModelTable {
    return this.model.table(name) ?? fail(`there is no table "${name}".`);
  }

  column(table: ModelTable, name: string): ModelColumn {
    return table.columns.find((column) => column.name === name) ?? fail(`table "${table.name}" has no column "${name}".`);
  }

  enumType(name: string): ModelEnum {
    return this.model.enumType(name) ?? fail(`there is no enumerated type "${name}".`);
  }

  /** Adds the renames a change gives as evidence to those the object records. */
  recordRenames(object: ObjectProvenance, evidence: RenameEvidence | undefined): void {
    if (evidence !== undefined && evidence.renames.length > 0) {
      object.renames = [...(object.renames ?? []), ...structuredClone(evidence.renames)];
    }
  }

  /** As `recordRenames`, for the renames of a type's values. */
  recordValueRenames(type: ModelEnum, evidence: RenameEvidence | undefined): void {
    if (evidence !== undefined && evidence.renames.length > 0) {
      if (!this.#valueRenames.has(type)) {
        this.#valueRenames.set(type, type.valueRenames?.length ?? 0);
      }
      type.valueRenames = [...(type.valueRenames ?? []), ...structuredClone(evidence.renames)];
    }
  }

  #constraint<K extends ConstraintList>(table: ModelTable, list: K, name: string | undefined, expected: unknown, state: (item: ModelTable[K][number]) => unknown): ModelTable[K][number] {
    const items: ModelTable[K][number][] = table[list];
    const described = (item: ModelTable[K][number]): boolean => comparable(state(item)) === comparable(expected);
    // By name; of several of one name, which a schema file may have, the one that is described.
    const found = name !== undefined ? (items.find((item) => item.name === name && described(item)) ?? items.find((item) => item.name === name)) : items.find((item) => item.name === undefined && described(item));
    if (found === undefined) {
      return fail(name !== undefined ? `table "${table.name}" has no ${CONSTRAINT_NOUN[list]} "${name}".` : `table "${table.name}" has no ${CONSTRAINT_NOUN[list]} without a name that is what the change describes.`);
    }
    fits(`the ${CONSTRAINT_NOUN[list]}`, state(found), expected);
    return found;
  }

  #columnsExist(table: ModelTable, names: readonly string[]): void {
    names.forEach((name) => this.column(table, name));
  }

  apply(operation: Operation): void {
    const model = this.model;
    switch (operation.op) {
      // --- what goes ---
      case "dropForeignKey": {
        const table = this.table(operation.table);
        const key = this.#constraint(table, "foreignKeys", operation.constraint, operation.before, foreignKeyState);
        table.foreignKeys = table.foreignKeys.filter((other) => other !== key);
        return;
      }
      case "dropCheck": {
        const table = this.table(operation.table);
        const check = this.#constraint(table, "checks", operation.constraint, operation.before, checkState);
        table.checks = table.checks.filter((other) => other !== check);
        return;
      }
      case "dropUnique": {
        const table = this.table(operation.table);
        const unique = this.#constraint(table, "uniques", operation.constraint, operation.before, uniqueState);
        table.uniques = table.uniques.filter((other) => other !== unique);
        return;
      }
      case "dropIndex": {
        const table = this.table(operation.table);
        const named = table.indexes.filter((candidate) => candidate.name === operation.index);
        const index = named.find((candidate) => comparable(indexState(candidate)) === comparable(operation.before)) ?? named[0] ?? fail(`table "${table.name}" has no index "${operation.index}".`);
        fits("the index", indexState(index), operation.before);
        table.indexes = table.indexes.filter((other) => other !== index);
        return;
      }
      case "dropPrimaryKey": {
        const table = this.table(operation.table);
        if (table.primaryKey === undefined) {
          return fail(`table "${table.name}" has no primary key.`);
        }
        // A key that only the columns' marks give has no order of its own: it is the same key in whatever order the table lists its columns.
        const implicit = table.primaryKey.implicit === true;
        const ordered = <T extends { columns: string[] }>(key: T): T => (implicit ? { ...key, columns: [...key.columns].sort(compareText) } : key);
        fits("the primary key", ordered(primaryKeyState(table.primaryKey)), ordered(operation.before));
        model.setPrimaryKey(table, undefined);
        this.#rekeyed.add(table);
        return;
      }
      case "dropColumn": {
        const table = this.table(operation.table);
        const column = this.column(table, operation.column);
        fits("the column", columnState(column), operation.before);
        table.columns = table.columns.filter((other) => other !== column);
        return;
      }
      case "dropTable": {
        const table = this.table(operation.table);
        fits("the table", tableState(table, true), operation.before);
        model.tables = model.tables.filter((other) => other !== table);
        return;
      }

      // --- renames ---
      case "renameEnumType": {
        const type = this.enumType(operation.from);
        if (model.enumType(operation.enum) !== undefined) {
          return fail(`there is an enumerated type "${operation.enum}" already.`);
        }
        checkIdentity(type, operation.evidence, `the enumerated type "${operation.from}"`);
        model.renameEnum(type, operation.enum);
        this.recordRenames(type, operation.evidence);
        return;
      }
      case "renameEnumValue": {
        const type = this.enumType(operation.enum);
        if (!type.values.includes(operation.from)) {
          return fail(`the type has no value "${operation.from}".`);
        }
        if (type.values.includes(operation.to)) {
          return fail(`the type has the value "${operation.to}" already.`);
        }
        checkIdentity(type, operation.evidence, `the enumerated type "${operation.enum}"`);
        model.renameEnumValue(type, operation.from, operation.to);
        this.recordValueRenames(type, operation.evidence);
        return;
      }
      case "renameTable": {
        const table = this.table(operation.from);
        if (model.table(operation.table) !== undefined) {
          return fail(`there is a table "${operation.table}" already.`);
        }
        checkIdentity(table, operation.evidence, `the table "${operation.from}"`);
        model.renameTable(table, operation.table);
        this.recordRenames(table, operation.evidence);
        return;
      }
      case "renameColumn": {
        const table = this.table(operation.table);
        const column = this.column(table, operation.from);
        if (table.columns.some((other) => other.name === operation.column)) {
          return fail(`table "${table.name}" has a column "${operation.column}" already.`);
        }
        checkIdentity(column, operation.evidence, `the column "${table.name}"."${operation.from}"`);
        model.renameColumn(table, column, operation.column);
        this.recordRenames(column, operation.evidence);
        return;
      }
      case "renameConstraint": {
        const table = this.table(operation.table);
        const constraint = constraintOfKind(table, operation.kind, operation.from);
        // (The renames of a diff are not carried out here, one after another, but at once: `apply-diff.ts`.)
        if (constraintNames(table).includes(operation.constraint)) {
          return fail(`table "${table.name}" has a constraint "${operation.constraint}" already.`);
        }
        checkIdentity(constraint, operation.evidence, `the ${KIND_NOUN[operation.kind]} "${operation.from}" of table "${table.name}"`);
        constraint.name = operation.constraint;
        this.recordRenames(constraint, operation.evidence);
        return;
      }
      case "renameIndex": {
        const table = this.table(operation.table);
        const index = table.indexes.find((candidate) => candidate.name === operation.from) ?? fail(`table "${table.name}" has no index "${operation.from}".`);
        if (table.indexes.some((other) => other.name === operation.index)) {
          return fail(`table "${table.name}" has an index "${operation.index}" already.`);
        }
        checkIdentity(index, operation.evidence, `the index "${operation.from}" of table "${table.name}"`);
        index.name = operation.index;
        this.recordRenames(index, operation.evidence);
        return;
      }

      // --- what comes and what changes ---
      case "addEnumType": {
        if (model.enumType(operation.enum) !== undefined) {
          return fail(`there is an enumerated type "${operation.enum}" already.`);
        }
        const type: ModelEnum = { name: operation.enum, values: [...operation.after.values], listed: true, ...(operation.after.origin !== undefined && { origin: { ...operation.after.origin } }) };
        model.enums.push(type);
        this.#valuesAdded.add(type);
        return;
      }
      case "addEnumValue": {
        const type = this.enumType(operation.enum);
        if (type.values.includes(operation.value)) {
          return fail(`the type has the value "${operation.value}" already.`);
        }
        const anchor = operation.afterValue ?? operation.beforeValue;
        const at = anchor === undefined ? type.values.length - 1 : type.values.indexOf(anchor);
        if (anchor !== undefined && at < 0) {
          return fail(`the type has no value "${anchor}" to put it ${operation.afterValue !== undefined ? "after" : "before"}.`);
        }
        const position = operation.afterValue !== undefined || anchor === undefined ? at + 1 : at;
        model.setEnumValues(type, [...type.values.slice(0, position), operation.value, ...type.values.slice(position)]);
        this.#valuesAdded.add(type);
        return;
      }
      case "replaceEnumValues": {
        const type = this.enumType(operation.enum);
        fits("the type's values", type.values, operation.before, true);
        if (operation.after.some((value) => !type.values.includes(value))) {
          this.#valuesAdded.add(type);
        }
        model.setEnumValues(type, [...operation.after]);
        return;
      }
      case "addTable": {
        if (model.table(operation.table) !== undefined) {
          return fail(`there is a table "${operation.table}" already.`);
        }
        const table = model.tableFromState(operation.after);
        model.tables.push(table);
        this.#rekeyed.add(table);
        return;
      }
      case "addColumn": {
        const table = this.table(operation.table);
        if (table.columns.some((column) => column.name === operation.column)) {
          return fail(`table "${table.name}" has a column "${operation.column}" already.`);
        }
        const column = model.columnFromState(operation.after);
        table.columns.push(column);
        this.#redefined.set(column, table);
        return;
      }
      case "dropDefault":
      case "setDefault": {
        const table = this.table(operation.table);
        const column = this.column(table, operation.column);
        fits("the column's default", defaultState(column), operation.before);
        model.setColumnDefault(column, operation.op === "setDefault" ? operation.after : undefined);
        this.#redefined.set(column, table);
        return;
      }
      case "alterColumnType": {
        const table = this.table(operation.table);
        const column = this.column(table, operation.column);
        fits("the column's type", typeState(column), operation.before);
        model.setColumnType(column, operation.after);
        this.#redefined.set(column, table);
        return;
      }
      case "dropNotNull":
      case "setNotNull": {
        const column = this.column(this.table(operation.table), operation.column);
        const nullable = operation.op === "dropNotNull";
        if (column.nullable === nullable) {
          return fail(nullable ? "the column takes NULL already." : "the column is not null already.");
        }
        column.nullable = nullable;
        return;
      }
      case "removeEnumValue": {
        const type = this.enumType(operation.enum);
        if (!type.values.includes(operation.value)) {
          return fail(`the type has no value "${operation.value}".`);
        }
        model.setEnumValues(
          type,
          type.values.filter((value) => value !== operation.value),
        );
        return;
      }
      case "dropEnumType": {
        const type = this.enumType(operation.enum);
        fits("the enumerated type", enumState(type), operation.before);
        model.enums = model.enums.filter((other) => other !== type);
        /*
         * A column that still names the type as what it is made of (arrays of
         * it) is one that the after side says nothing of but how it was
         * declared: there the column is the same, and the type is gone. So
         * the column no longer says what its type is. (In a plan a type is
         * not dropped while a column has it: `rules.ts`.)
         */
        for (const owner of model.tables) {
          for (const column of owner.columns) {
            if (enumNamesIn(column.canonicalType).includes(operation.enum)) {
              delete column.canonicalType;
            }
          }
        }
        return;
      }
      case "addPrimaryKey": {
        const table = this.table(operation.table);
        if (table.primaryKey !== undefined) {
          return fail(`table "${table.name}" has a primary key already.`);
        }
        this.#columnsExist(table, [...operation.after.columns, ...(operation.after.include ?? [])]);
        this.#naming(table, operation.after.name);
        model.setPrimaryKey(table, operation.after);
        this.#rekeyed.add(table);
        return;
      }
      case "addUnique": {
        const table = this.table(operation.table);
        this.#naming(table, operation.after.name);
        this.#columnsExist(table, [...operation.after.columns, ...(operation.after.include ?? [])]);
        table.uniques.push(uniqueFromState(operation.after));
        return;
      }
      case "addCheck": {
        const table = this.table(operation.table);
        this.#naming(table, operation.after.name);
        table.checks.push(checkFromState(operation.after));
        return;
      }
      case "addIndex": {
        const table = this.table(operation.table);
        const state = operation.after;
        if (table.indexes.some((index) => index.name === state.name)) {
          return fail(`table "${table.name}" has an index "${state.name}" already.`);
        }
        this.#columnsExist(table, [...state.columns, ...(state.include ?? [])]);
        const problem = indexKeysProblem(state);
        if (problem !== undefined) {
          return fail(`what the change says of its keys does not hold together: ${problem}.`);
        }
        table.indexes.push(indexFromState(state));
        return;
      }
      case "addForeignKey": {
        const table = this.table(operation.table);
        this.#naming(table, operation.after.name);
        this.#columnsExist(table, operation.after.columns);
        table.foreignKeys.push(model.foreignKeyFromState(table, operation.after));
        return;
      }
      default:
        return fail("this kind of change is not known.");
    }
  }

  /** After the last operation. */
  finish(): void {
    for (const table of this.#rekeyed) {
      if (this.model.tables.includes(table)) {
        this.model.settleNumbering(table);
      }
    }
    for (const [column, table] of this.#redefined) {
      if (this.model.tables.includes(table) && table.columns.includes(column) && !this.#rekeyed.has(table)) {
        this.model.settleNumbering(table, column);
      }
    }
    /*
     * A type's values are told apart by the type's whole history of value
     * renames. An operation says where an added type comes from, and that a
     * value is added, but not what such a value was called on the way: with
     * the type's origin and part of its history, a later diff would take it
     * for the type as it was before renames it has had already, and report
     * them again. So such a type says nothing of where it comes from.
     */
    for (const type of this.#valuesAdded) {
      delete type.origin;
      delete type.renames;
      delete type.valueRenames;
      this.#valueRenames.delete(type);
    }
    // The renames of a type's values are recorded value by value; a source records them as they happened.
    for (const [type, kept] of this.#valueRenames) {
      const all = type.valueRenames ?? [];
      const added = all
        .slice(kept)
        .map((record, index) => ({ record, index }))
        .sort((a, b) => compareText(a.record.at.file, b.record.at.file) || a.record.at.statement - b.record.at.statement || a.index - b.index);
      type.valueRenames = [...all.slice(0, kept), ...added.map((entry) => entry.record)];
    }
  }
}

const KIND_NOUN = { primaryKey: "primary key", unique: "unique constraint", foreignKey: "foreign key", check: "check" } as const;

/** A table's constraint of one kind, by name. */
export function constraintOfKind(table: ModelTable, kind: keyof typeof KIND_NOUN, name: string): ObjectProvenance & { name?: string } {
  const found = kind === "primaryKey" ? (table.primaryKey?.name === name ? table.primaryKey : undefined) : (kind === "unique" ? table.uniques : kind === "foreignKey" ? table.foreignKeys : table.checks).find((candidate) => candidate.name === name);
  return found ?? fail(`table "${table.name}" has no ${KIND_NOUN[kind]} "${name}".`);
}

/**
 * What is wrong with a schema as a whole, in the order it is found. Always:
 * what no schema can have (two tables of one name, a key over a column that
 * is not there, a text that is said to name a column that is not there, a
 * column of a type that is not there). With `strict`, also
 * what a database refuses and a schema file may still say: a foreign key to
 * nothing, a default that is not a value of its column's type, and one name
 * for two constraints of a table or two indexes.
 */
export function schemaProblems(model: SchemaModel, strict: boolean): string[] {
  const problems: string[] = [];
  const twice = (names: readonly string[]): string[] => [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  twice(model.tables.map((table) => table.name)).forEach((name) => problems.push(`there are two tables "${name}".`));
  twice(model.enums.map((type) => type.name)).forEach((name) => problems.push(`there are two enumerated types "${name}".`));
  for (const type of model.enums) {
    twice(type.values).forEach((value) => problems.push(`the enumerated type "${type.name}" has the value "${value}" twice.`));
  }
  for (const table of model.tables) {
    twice(table.columns.map((column) => column.name)).forEach((name) => problems.push(`table "${table.name}" has two columns "${name}".`));
    const has = (name: string): boolean => table.columns.some((column) => column.name === name);
    const over = (what: string, columns: readonly string[]): void => {
      columns.filter((name) => !has(name)).forEach((name) => problems.push(`${what} of table "${table.name}" is over the column "${name}", which the table does not have.`));
    };
    const named = (noun: string, name: string | undefined): string => `the ${noun}${name === undefined ? "" : ` "${name}"`}`;
    if (table.primaryKey !== undefined) {
      over(named("primary key", table.primaryKey.name), [...table.primaryKey.columns, ...(table.primaryKey.include ?? [])]);
    }
    table.uniques.forEach((unique) => over(named("unique constraint", unique.name), [...unique.columns, ...(unique.include ?? [])]));
    table.foreignKeys.forEach((key) => over(named("foreign key", key.name), key.columns));
    table.indexes.forEach((index) => over(named("index", index.name), [...index.columns, ...(index.include ?? [])]));
    // A text that names a column, where the schema says what it names: by what the column is called now.
    const names = (what: string, text: { names?: readonly { kind: string; name: string; now?: string }[] | undefined }): void => {
      const columns = (text.names ?? []).filter((entry) => entry.kind === "column").map((entry) => entry.now ?? entry.name);
      columns.filter((name) => !has(name)).forEach((name) => problems.push(`${what} of table "${table.name}" names the column "${name}", which the table does not have.`));
    };
    table.checks.forEach((check) => names(named("check", check.name), check));
    table.indexes.filter(hasText).forEach((index) => names(named("index", index.name), index));
    for (const column of table.columns) {
      for (const name of new Set([...(column.enum === undefined ? [] : [column.enum.name]), ...enumNamesIn(column.canonicalType)])) {
        if (model.enumType(name) === undefined) {
          problems.push(`the column "${table.name}"."${column.name}" is of the enumerated type "${name}", which the schema does not have.`);
        }
      }
    }
    if (!strict) {
      continue;
    }
    twice(constraintNames(table)).forEach((name) => problems.push(`table "${table.name}" has two constraints "${name}".`));
    for (const key of table.foreignKeys) {
      const what = named("foreign key", key.name);
      const target = model.table(key.table);
      if (target === undefined) {
        problems.push(`${what} of table "${table.name}" refers to the table "${key.table}", which the schema does not have.`);
        continue;
      }
      if (key.refColumns.length !== key.columns.length) {
        problems.push(`${what} of table "${table.name}" has ${key.columns.length} column${key.columns.length === 1 ? "" : "s"} and refers to ${key.refColumns.length}.`);
      }
      key.refColumns.filter((name) => !target.columns.some((column) => column.name === name)).forEach((name) => problems.push(`${what} of table "${table.name}" refers to the column "${key.table}"."${name}", which the table does not have.`));
    }
    for (const column of table.columns) {
      const typeName = column.enum?.name ?? (column.canonicalType?.kind === "enum" ? column.canonicalType.name : undefined);
      const type = typeName === undefined ? undefined : model.enumType(typeName);
      if (type !== undefined && typeof column.default === "string" && !type.values.includes(column.default)) {
        problems.push(`the default of the column "${table.name}"."${column.name}" is "${column.default}", which is not a value of the enumerated type "${type.name}".`);
      }
    }
  }
  if (strict) {
    const indexes = model.tables.flatMap((table) => table.indexes.map((index) => index.name));
    twice(indexes).forEach((name) => problems.push(`there are two indexes "${name}".`));
  }
  return problems;
}
