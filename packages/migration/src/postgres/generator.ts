import { canonicalTypeKey } from "../../../runtime/src/canonical-type.ts";
import type { CanonicalType } from "../../../runtime/src/canonical-type.ts";
import { staleNamesOf } from "../../../runtime/src/expression-names.ts";
import { copyIndexKey, indexKeys } from "../../../runtime/src/index-definition.ts";
import type { DatabaseSchema, Deferrable, ExpressionName } from "../../../runtime/src/index.ts";
import type { CheckState, ColumnState, DefaultState, ForeignKeyState, IndexState, PrimaryKeyState, UniqueState } from "../../../schema-diff/src/index.ts";
import { compareText } from "../../../schema-diff/src/stable-json.ts";
import { SchemaModel, defaultState, foreignKeyState, normalizeAction } from "../model.ts";
import type { ModelColumn, ModelEnum, ModelForeignKey, ModelTable } from "../model.ts";
import { Session, constraintNames, describeOperation } from "../operations.ts";
import type { MigrationPlan, MigrationStep } from "../plan.ts";
import { applyPlanTo } from "../validate.ts";
import { POSTGRES_MIGRATION_VERSION, inSegments, stableJson } from "./migration.ts";
import type { PostgresMigration } from "./migration.ts";
import { Refusal, refuse } from "./safety.ts";
import type { DataReason, SafetyClass, SafetyReason } from "./safety.ts";
import { REFERENTIAL_ACTIONS, expressionsOf, statementSql } from "./statements.ts";
import type { ColumnDefault, ColumnDefinition, PostgresStatement, ReferentialAction, StatementBody, StatementReason, TableConstraint } from "./statements.ts";
import { classifyTypeChange } from "./type-changes.ts";

/*
 * The PostgreSQL generator (D-039): a migration plan as the statements that
 * carry it out on PostgreSQL.
 *
 * The plan is read, never the diff: the steps are taken in their order, each
 * on the schema as it is when its turn comes, and each becomes the
 * statements PostgreSQL does it with. Nothing is put in another order. The
 * schema is carried along as the validator of plans carries it, so that a
 * step is written with what is there at that moment: the type a default is
 * of, the foreign keys that rest on a key.
 *
 * What PostgreSQL asks beyond the rules of a plan is met with statements of
 * its own, each saying why (`because`, in `statements.ts`):
 *
 * - A key or unique index is not dropped while a foreign key rests on it,
 *   and no foreign key is kept between columns of types that PostgreSQL does
 *   not compare: the foreign key goes first, and is added again after the
 *   last step, under the names things have then. One that the plan drops
 *   meanwhile, or whose table it drops, does not come back.
 * - A table has a type of its own name: an enumerated type of that name,
 *   which the plan drops later, is renamed out of its way and dropped under
 *   that name.
 * - An enumerated type loses no value and keeps its order: to take a value
 *   out, or to reorder, the type is made again.
 * - A default that is a value of an enumerated type stays that when its
 *   column's type changes: it is taken off before, and put back as a constant
 *   of the new type when it is one. One that is not stays off, for the step
 *   of the plan that changes it.
 * - A numbered column is a whole number that takes no NULL: its numbering
 *   goes before its type or its NOT NULL does, as an identity and as a
 *   default, since a schema does not say which of the two it is.
 * - A unique constraint over the columns of another key is left out of
 *   CREATE TABLE by PostgreSQL: it is added by a statement of its own.
 *
 * What a schema holds of a key, a constraint, or an index is written
 * (D-040): the columns it carries along, whether it is deferrable, how an
 * index is built, and its keys with what each says. What a schema only says
 * there is (`sourceClauses`) is not: such a thing is refused, since written
 * from the rest it would be another thing.
 *
 * An expression is written as the text the schema has, and only when that
 * text is what PostgreSQL would read as it was meant: a text that names
 * something by a name it has no longer (`ExpressionName`), or that may, is
 * refused. This holds for a text that the plan gives (a check that is
 * added) and for one that is written back on the way (a default, after its
 * column's type was made again): the schema that is carried along has
 * followed the plan's own renames by then.
 *
 * What cannot be written is not written some other way. A step is refused
 * with its class and reason (`safety.ts`), all the steps are looked at, and
 * a plan with a refused step gives no migration at all.
 */

export interface PostgresGenerationOptions {
  /**
   * The caller's word that the rows fit what the new schema asks of them: no
   * NULL in a column that becomes NOT NULL, no value outside a type that
   * becomes narrower, none of the values that go from an enumerated type.
   * With it the statements that rest on this are written, and marked
   * (`assumes`); PostgreSQL still refuses one as a whole when the rows do
   * not fit. Without it such a step is refused, and nothing is generated.
   */
  assumeValidData?: boolean;
}

/** What the generator makes of one step of the plan. */
export interface StepAssessment {
  /** The number of the step in the plan, from 1. */
  step: number;
  /** The step in a few words: `setNotNull "users"."name"`. */
  operation: string;
  safety: SafetyClass;
  /** Unless `safe`: why, as a word a program can read, and as a sentence. */
  reason?: SafetyReason;
  detail?: string;
}

/**
 * A plan as a PostgreSQL migration, or the steps it is refused for. `steps`
 * has every step of the plan, in order, either way.
 */
export type PostgresGeneration = { status: "generated"; migration: PostgresMigration; steps: StepAssessment[] } | { status: "refused"; refusals: StepAssessment[]; steps: StepAssessment[] };

/** What a generator gave, as JSON text: the same bytes for the same plan and schema. */
export function stringifyPostgresGeneration(generation: PostgresGeneration, indent = 2): string {
  return stableJson(generation, indent);
}

interface Notes {
  because?: StatementReason;
  assumes?: { reason: DataReason; detail: string };
  dropsData?: true;
}

/** A foreign key that PostgreSQL has no longer, though the plan's schema still has it. */
interface Suspended {
  table: ModelTable;
  key: ModelForeignKey;
  /** The step it went for. */
  step: number;
  because: StatementReason;
}

const quoted = (name: string): string => `"${name}"`;
const sameColumns = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((name) => b.includes(name));

/** `"a"`, `"a" or "b"`, `"a", "b", or "c"`. */
function either(values: readonly string[]): string {
  const shown = values.map((value) => JSON.stringify(value));
  return shown.length <= 2 ? shown.join(" or ") : `${shown.slice(0, -1).join(", ")}, or ${shown.at(-1)}`;
}

/**
 * What a statement needs the rows to be: what the statement is marked with,
 * and what its step is classed by. Whether such a step is written on the
 * caller's word or refused is decided for the plan as a whole, after the
 * last step: until then the two are written alike.
 */
const rowsNeed = (reason: DataReason, detail: string): { reason: DataReason; detail: string } => ({ reason, detail });

/** The enumerated type a canonical type is, or is an array of, by name. */
function enumOf(type: CanonicalType | undefined): string | undefined {
  return type === undefined ? undefined : type.kind === "enum" ? type.name : type.kind === "array" ? enumOf(type.element) : undefined;
}

/**
 * What PostgreSQL compares a type as: two types with the same answer can be
 * the two sides of a foreign key, so that a column of one changes its type
 * while the other still has the old one. Whole numbers of every size are
 * compared with each other, and so are texts with and without a length, and
 * dates with times; a whole number and a decimal, a UUID and a text, and an
 * enumerated type and anything else are not. Tried on PostgreSQL 18; a pair
 * that is not known is taken not to be compared.
 */
function comparedAs(type: CanonicalType): string {
  switch (type.kind) {
    case "integer":
    case "decimal":
    case "float":
    case "char":
    case "interval":
      return type.kind;
    case "text":
    case "varchar":
      return "text";
    case "date":
    case "timestamp":
      return "date and time";
    case "time":
      return type.withTimeZone ? "time with time zone" : "time";
    case "array":
      return `array of ${comparedAs(type.element)}`;
    default:
      return canonicalTypeKey(type);
  }
}

class Generator {
  readonly #model: SchemaModel;
  readonly #session: Session;
  readonly #plan: MigrationPlan;
  readonly #options: PostgresGenerationOptions;
  readonly #statements: PostgresStatement[] = [];
  readonly #assessments: StepAssessment[] = [];
  /** The number of the step that is being written. */
  #step = 0;
  /** Enumerated types that PostgreSQL has under another name than the plan's schema: renamed out of a table's way. */
  readonly #aliases = new Map<ModelEnum, string>();
  readonly #suspended: Suspended[] = [];
  /**
   * Columns whose default PostgreSQL has no longer, though the plan's schema
   * still has one, each with the step it went for. `numbering`: what went is
   * the column's numbering, not a constant.
   */
  readonly #defaultsOff = new Map<ModelColumn, { step: number; numbering: boolean }>();
  /** The steps that take values out of one enumerated type, when the type was made again for all of them at the first. */
  #remade: { type: ModelEnum; until: number; rows?: { reason: DataReason; detail: string } } | undefined;
  /** Names that a name made up here must not be. */
  readonly #taken: Set<string>;
  #made = 0;

  constructor(before: DatabaseSchema, plan: MigrationPlan, options: PostgresGenerationOptions, target: SchemaModel) {
    this.#model = SchemaModel.from(before);
    this.#session = new Session(this.#model);
    this.#plan = plan;
    this.#options = options;
    this.#taken = new Set([...namesOf(this.#model), ...namesOf(target), ...plan.steps.flatMap(namesIn)]);
  }

  run(): PostgresGeneration {
    for (const [index, step] of this.#plan.steps.entries()) {
      this.#step = index + 1;
      let assessment: StepAssessment = { step: this.#step, operation: describeOperation(step), safety: "safe" };
      try {
        const rows = this.#write(step, index);
        if (rows !== undefined) {
          assessment = { ...assessment, safety: "requiresDataMigration", reason: rows.reason, detail: rows.detail };
        }
      } catch (error) {
        if (!(error instanceof Refusal)) {
          throw error;
        }
        // A plan with a refused step gives no migration, so what the step had written by then is given to nobody. The steps after it are still looked at.
        assessment = { ...assessment, safety: error.safety, reason: error.reason, detail: error.message };
      }
      this.#assessments.push(assessment);
      // The plan was carried out once before any of this, so the step can be taken.
      this.#session.apply(step);
    }
    this.#session.finish();
    this.#finish();
    const refusals = this.#assessments.filter((assessment) => assessment.safety === "requiresExplicitCast" || assessment.safety === "unsupported" || (assessment.safety === "requiresDataMigration" && this.#options.assumeValidData !== true));
    if (refusals.length > 0) {
      return { status: "refused", refusals, steps: this.#assessments };
    }
    return { status: "generated", migration: { version: POSTGRES_MIGRATION_VERSION, dialect: "postgresql", segments: inSegments(this.#statements) }, steps: this.#assessments };
  }

  // --- writing ----------------------------------------------------------------------

  #emit(body: StatementBody, notes: Notes = {}): void {
    const expressions = expressionsOf(body);
    for (const expression of expressions) {
      if (expression.trim() === "" || expression.includes("\u0000")) {
        refuse("expression-not-representable", `An expression of the schema is ${expression.trim() === "" ? "empty" : "not a text PostgreSQL reads"}: ${JSON.stringify(expression)}.`);
      }
    }
    this.#statements.push({
      ...body,
      step: this.#step,
      ...(notes.because !== undefined && { because: notes.because }),
      safety: notes.assumes === undefined ? "safe" : "requiresDataMigration",
      ...(notes.assumes !== undefined && { assumes: notes.assumes }),
      ...(notes.dropsData === true && { dropsData: true as const }),
      ...(expressions.length > 0 && { expressions }),
      sql: statementSql(body),
    });
  }

  /** A name that nothing has, of either schema or of the plan, for something that is there only on the way. */
  #newName(): string {
    do {
      this.#made += 1;
    } while (this.#taken.has(`migration_old_${this.#made}`));
    return `migration_old_${this.#made}`;
  }

  // --- the schema at this step ----------------------------------------------------------

  #table(name: string): ModelTable {
    return this.#model.table(name) as ModelTable;
  }

  #column(table: ModelTable, name: string): ModelColumn {
    return table.columns.find((column) => column.name === name) as ModelColumn;
  }

  /** The name PostgreSQL has for an enumerated type of the plan's schema. */
  #typeName(name: string): string {
    const type = this.#model.enumType(name);
    return (type === undefined ? undefined : this.#aliases.get(type)) ?? name;
  }

  /** A canonical type with its enumerated types under the names PostgreSQL has for them. */
  #pgType(type: CanonicalType): CanonicalType {
    return type.kind === "enum" ? { kind: "enum", name: this.#typeName(type.name) } : type.kind === "array" ? { kind: "array", element: this.#pgType(type.element) } : type;
  }

  /** The canonical type a state gives; a schema that only says how a type was spelled is not written from. */
  #canonical(type: { canonical?: CanonicalType; declared?: string }, what: string): CanonicalType {
    return type.canonical ?? refuse("no-canonical-type", `${what} says how its type was spelled${type.declared === undefined ? "" : ` ("${type.declared}")`}, and not what the type is. A type is written from what it is.`);
  }

  /** Whether a constant is a value of a type as far as its enumerated type goes: `values` are the type's. */
  #isValueOf(type: CanonicalType, value: unknown, values: readonly string[]): boolean {
    if (type.kind === "enum") {
      return typeof value === "string" && values.includes(value);
    }
    if (type.kind === "array" && enumOf(type) !== undefined) {
      const every = (item: unknown): boolean => item === null || (Array.isArray(item) ? item.every(every) : typeof item === "string" && values.includes(item));
      return Array.isArray(value) && value.every(every);
    }
    return true;
  }

  /**
   * Refuses a text that a rename has left behind, or may have: it is not
   * what PostgreSQL has of the expression, and written again it would be
   * refused, or be of whatever has the name by now. `what`: what the text is
   * of, as a sentence starts.
   */
  #current(text: { names?: readonly ExpressionName[] | undefined; mayBeStale?: boolean | undefined }, what: string, written: string): void {
    if (text.mayBeStale === true) {
      refuse(
        "stale-expression-after-rename",
        `${what} has the text (${written}), and the schema does not say what that names, while a rename may have reached it since it was written. It is not written into a database from that: collected again from its migrations, the schema says what each text names.`,
      );
    }
    const stale = staleNamesOf(text.names);
    if (stale.length > 0) {
      const each = stale.map((entry) => `${entry.kind} "${entry.name}"${entry.type === undefined ? "" : ` of "${entry.type}"`} is "${entry.now}" now`).join(", ");
      refuse(
        "stale-expression-after-rename",
        `${what} was written as (${written}) when things had other names: ${each}. PostgreSQL has what the text meant, and the schema has the text as it was written: written into a database again, it would be refused, or be of whatever has that name by now.`,
      );
    }
  }

  /** Refuses a key, a constraint, or an index of which the schema only says that there is more to it than it holds. */
  #whole(clauses: readonly string[] | undefined, what: string, kind: "index" | "constraint"): void {
    if (clauses !== undefined && clauses.length > 0) {
      refuse(kind === "index" ? "index-not-representable" : "constraint-not-representable", `${what} says what the schema has no place for: ${clauses.join(", ")}. Written from the rest, it would be another ${kind}.`);
    }
  }

  /** A key, a constraint, or an index of a table, as a sentence starts with it. */
  #named(noun: string, name: string | undefined, table: string): string {
    return `The ${noun}${name === undefined ? "" : ` ${quoted(name)}`} of table ${quoted(table)}`;
  }

  /** A primary key or a unique constraint as PostgreSQL has it, with all the schema holds of it. */
  #key(kind: "primaryKey" | "unique", table: string, state: PrimaryKeyState | UniqueState): TableConstraint {
    this.#whole(state.sourceClauses, this.#named(kind === "unique" ? "unique constraint" : "primary key", state.name, table), "constraint");
    const parts = {
      ...(state.name !== undefined && { name: state.name }),
      columns: [...state.columns],
      ...(state.include !== undefined && state.include.length > 0 && { include: [...state.include] }),
    };
    const deferrable: { deferrable?: Deferrable } = state.deferrable === undefined ? {} : { deferrable: state.deferrable };
    return kind === "primaryKey" ? { kind, ...parts, ...deferrable } : { kind, ...parts, ...((state as UniqueState).nullsNotDistinct === true && { nullsNotDistinct: true as const }), ...deferrable };
  }

  /** A check as PostgreSQL has it: its text, when that is what PostgreSQL would read as it was meant. */
  #check(table: string, state: CheckState): TableConstraint {
    const what = this.#named("check", state.name, table);
    this.#whole(state.sourceClauses, what, "constraint");
    this.#current(state, what, state.expression);
    return { kind: "check", ...(state.name !== undefined && { name: state.name }), expression: state.expression };
  }

  /** A default as PostgreSQL has it. Not for the next number: that is no default to PostgreSQL where it can be said at all. */
  #default(state: Exclude<DefaultState, { kind: "increment" }>, type: CanonicalType, what: string): ColumnDefault {
    const expression = (text: string): ColumnDefault => {
      this.#current(state.kind === "value" ? {} : state, `The default of ${what}`, text);
      return { kind: "expression", expression: text };
    };
    /** The text is not one to write: but what the default is may be known without it. */
    const stale = state.kind !== "value" && (state.mayBeStale === true || staleNamesOf(state.names).length > 0);
    switch (state.kind) {
      case "value": {
        const enumName = enumOf(type);
        const values = enumName === undefined ? undefined : this.#model.enumType(enumName)?.values;
        if (values !== undefined && !this.#isValueOf(type, state.value, values)) {
          refuse("default-not-a-value-of-its-type", `The default of ${what}, ${JSON.stringify(state.value)}, is no value of the enumerated type "${enumName}" at this step.`);
        }
        return { kind: "value", value: state.value, type: this.#pgType(type) };
      }
      case "function":
        // How the source wrote it says more than what it is called here: `timezone('utc', now())` is the time of the write too. A text that a rename left behind says nothing that can be written, and what the default is does not rest on it.
        return state.expression !== undefined && !stale ? expression(state.expression) : { kind: "function", function: state.function };
      case "generated":
        if (state.expression !== undefined && !(stale && state.strategy === "uuid")) {
          return expression(state.expression);
        }
        return state.strategy === "uuid" ? { kind: "function", function: "random_uuid" } : refuse("value-not-representable", `The default of ${what} is a value that the source's database makes ("${state.strategy}"), and the schema does not say how.`);
      case "expression":
        return expression(state.expression);
    }
  }

  #definition(table: string, state: ColumnState): ColumnDefinition {
    const what = `The column ${quoted(table)}.${quoted(state.name)}`;
    const type = this.#canonical(state.type, what);
    const base = { name: state.name, type: this.#pgType(type), notNull: !state.nullable };
    if (state.default?.kind === "increment") {
      // An identity column takes no NULL, and is a whole number.
      if (state.nullable || type.kind !== "integer") {
        refuse("numbering-not-representable", `${what} is numbered, and ${state.nullable ? "takes NULL" : "is no whole number"}: that is a column with a sequence of its own, which a schema does not hold. PostgreSQL's numbered column (an identity) takes no NULL and is a whole number.`);
      }
      return { ...base, identity: true };
    }
    return { ...base, ...(state.default !== undefined && { default: this.#default(state.default, type, `the column ${quoted(table)}.${quoted(state.name)}`) }) };
  }

  // --- names that PostgreSQL keeps in one place --------------------------------------------

  /** Fails when a relation (a table, an index, or a key, which has an index of its name) is to get a name that one has. */
  #relationNameFree(name: string, what: string): void {
    const holder = this.#model.tables.flatMap((table) => [
      ...(table.name === name ? [`the table ${quoted(name)}`] : []),
      ...table.indexes.filter((index) => index.name === name).map(() => `the index ${quoted(name)} of table ${quoted(table.name)}`),
      ...(table.primaryKey?.name === name ? [`the primary key ${quoted(name)} of table ${quoted(table.name)}`] : []),
      ...table.uniques.filter((unique) => unique.name === name).map(() => `the unique constraint ${quoted(name)} of table ${quoted(table.name)}`),
    ])[0];
    if (holder !== undefined) {
      refuse("name-conflict", `${what} is to be called ${quoted(name)}, as ${holder} is at this step. PostgreSQL keeps the names of tables, indexes, and keys in one place.`);
    }
  }

  /** A table is to get a name: no relation has it, and an enumerated type that has it is in the way of the table's own type. */
  #tableNameFree(name: string, later: number): void {
    this.#relationNameFree(name, `The table`);
    const type = this.#model.enums.find((candidate) => (this.#aliases.get(candidate) ?? candidate.name) === name);
    if (type === undefined) {
      return;
    }
    // A type that the plan drops later is only in the way until then.
    if (!this.#plan.steps.slice(later).some((step) => step.op === "dropEnumType" && step.enum === type.name)) {
      refuse("name-conflict", `The table ${quoted(name)} would have the name of the enumerated type ${quoted(name)}. PostgreSQL keeps a type for every table, under the table's name.`);
    }
    const away = this.#newName();
    this.#emit({ kind: "renameType", type: name, to: away }, { because: "type-name-taken-by-table" });
    this.#aliases.set(type, away);
  }

  /** An enumerated type is to get a name: no table has it. */
  #typeNameFree(name: string): void {
    if (this.#model.table(name) !== undefined) {
      refuse("name-conflict", `The enumerated type ${quoted(name)} would have the name of the table ${quoted(name)}. PostgreSQL keeps a type for every table, under the table's name.`);
    }
  }

  // --- foreign keys and the keys they rest on ----------------------------------------------

  #isSuspended(key: ModelForeignKey): boolean {
    return this.#suspended.some((entry) => entry.key === key);
  }

  /** Whether a table has a key that a foreign key to these columns can rest on. A deferrable key is none: PostgreSQL rests no foreign key on one. */
  #hasKeyOver(table: ModelTable, columns: readonly string[]): boolean {
    return (
      (table.primaryKey !== undefined && table.primaryKey.deferrable === undefined && sameColumns(table.primaryKey.columns, columns)) ||
      table.uniques.some((unique) => unique.deferrable === undefined && sameColumns(unique.columns, columns)) ||
      table.indexes.some((index) => index.unique === true && (index.expressions ?? []).length === 0 && index.where === undefined && sameColumns(index.columns, columns))
    );
  }

  #foreignKey(table: string, key: { name?: string; columns: string[]; references: { table: string; columns: string[] }; onDelete: string; onUpdate: string; deferrable?: Deferrable }): TableConstraint {
    const action = (given: string): ReferentialAction => {
      const normal = normalizeAction(given);
      return REFERENTIAL_ACTIONS.find((known) => known === normal) ?? refuse("unknown-referential-action", `A foreign key of table ${quoted(table)} has the action "${given}", which PostgreSQL does not have.`);
    };
    return {
      kind: "foreignKey",
      ...(key.name !== undefined && { name: key.name }),
      columns: [...key.columns],
      references: { table: key.references.table, columns: [...key.references.columns] },
      onDelete: action(key.onDelete),
      onUpdate: action(key.onUpdate),
      ...(key.deferrable !== undefined && { deferrable: key.deferrable }),
    };
  }

  /** Takes a foreign key off, for PostgreSQL's sake: it is put back after the last step if the plan's schema still has it then. */
  #suspend(table: ModelTable, key: ModelForeignKey, because: StatementReason): void {
    if (this.#isSuspended(key)) {
      return;
    }
    if (key.name === undefined) {
      refuse("constraint-name-unknown", `A foreign key of table ${quoted(table.name)} over (${key.columns.join(", ")}) has to be dropped for this step and added again, and the schema has no name for it. PostgreSQL drops a constraint by its name.`);
    }
    this.#emit({ kind: "dropConstraint", table: table.name, constraint: key.name }, { because });
    this.#suspended.push({ table, key, step: this.#step, because });
  }

  /** A key or unique index over these columns of a table is to go: the foreign keys to exactly them rest on it, as far as is known here. */
  #releaseKey(table: ModelTable, columns: readonly string[]): void {
    this.#model
      .referencesTo(table)
      .filter(({ key }) => sameColumns(key.refColumns, columns))
      .sort((a, b) => compareText(a.table.name, b.table.name) || compareText(a.key.name ?? "", b.key.name ?? ""))
      .forEach(({ table: owner, key }) => this.#suspend(owner, key, "foreign-key-rests-on-dropped-key"));
  }

  /** The foreign keys that a column is in, on either side. */
  #foreignKeysOf(table: ModelTable, column: ModelColumn): { table: ModelTable; key: ModelForeignKey }[] {
    return [...table.foreignKeys.filter((key) => key.columns.includes(column.name)).map((key) => ({ table, key })), ...this.#model.referencesTo(table).filter(({ key }) => key.refColumns.includes(column.name))]
      .filter((entry, index, all) => all.findIndex((other) => other.key === entry.key) === index)
      .sort((a, b) => compareText(a.table.name, b.table.name) || compareText(a.key.name ?? "", b.key.name ?? ""));
  }

  // --- defaults across a change of type ---------------------------------------------------

  /** Whether PostgreSQL has a default for a column: the plan's schema has one, and it was not taken off here. */
  #hasDefault(column: ModelColumn): boolean {
    return defaultState(column) !== undefined && !this.#defaultsOff.has(column);
  }

  /** Whether PostgreSQL numbers a column at this step. */
  #isNumbered(column: ModelColumn): boolean {
    return defaultState(column)?.kind === "increment" && !this.#defaultsOff.has(column);
  }

  /**
   * Takes a column's numbering off ahead of the step of the plan that
   * replaces it: PostgreSQL's numbered column is a whole number that takes
   * no NULL, and a plan changes a type and drops NOT NULL before it sets a
   * new default. As an identity and as a default, since a schema does not
   * say which of the two it is.
   */
  #numberingOff(table: ModelTable, column: ModelColumn): void {
    this.#emit({ kind: "dropIdentity", table: table.name, column: column.name }, { because: "numbering-kind-unknown" });
    this.#emit({ kind: "dropDefault", table: table.name, column: column.name }, { because: "numbering-kind-unknown" });
    this.#defaultsOff.set(column, { step: this.#step, numbering: true });
  }

  /**
   * Puts a default back that was taken off for a change of the column's
   * type, when it is a value of the type the column has now. One that is not
   * stays off: the plan changes it by a step of its own.
   */
  #restoreDefault(table: ModelTable, column: ModelColumn, type: CanonicalType, values: readonly string[], because: StatementReason): void {
    const state = defaultState(column) as Exclude<DefaultState, { kind: "increment" }>;
    if (state.kind === "value" && !this.#isValueOf(type, state.value, values)) {
      this.#defaultsOff.set(column, { step: this.#step, numbering: false });
      return;
    }
    const fallback: ColumnDefault = state.kind === "value" ? { kind: "value", value: state.value, type: this.#pgType(type) } : this.#default(state, type, `the column ${quoted(table.name)}.${quoted(column.name)}`);
    this.#emit({ kind: "setDefault", table: table.name, column: column.name, default: fallback }, { because });
  }

  /**
   * An enumerated type gets other values than PostgreSQL can give it in
   * place: the type is made again. `gone`: the values that go.
   */
  #remakeEnum(type: ModelEnum, values: readonly string[], gone: readonly string[]): { reason: DataReason; detail: string } | undefined {
    const name = this.#typeName(type.name);
    const columns = this.#model.columnsOfEnum(type.name).sort((a, b) => compareText(a.table.name, b.table.name) || compareText(a.column.name, b.column.name));
    if (columns.length === 0) {
      // Nothing is of the type: it is dropped and created.
      this.#emit({ kind: "dropType", type: name }, { because: "enum-type-made-again" });
      this.#emit({ kind: "createEnumType", type: name, values: [...values] }, { because: "enum-type-made-again" });
      return undefined;
    }
    const because = "enum-type-made-again" as const;
    const places = columns.map(({ table, column }) => `${quoted(table.name)}.${quoted(column.name)}`).join(", ");
    const rows = gone.length === 0 ? undefined : rowsNeed("rows-may-hold-removed-value", `No row may hold ${either(gone)} in ${places}: the type ${quoted(type.name)} is made again without ${gone.length === 1 ? "it" : "them"}.`);
    const typed = columns.map((entry) => ({ ...entry, type: this.#canonical({ ...(entry.column.canonicalType !== undefined && { canonical: entry.column.canonicalType }), ...(entry.column.declaredType !== undefined && { declared: entry.column.declaredType }) }, `The column ${quoted(entry.table.name)}.${quoted(entry.column.name)}`) }));
    // A foreign key between a column of the old type and one of the new cannot be: those of these columns go, and come back at the end.
    typed.flatMap(({ table, column }) => this.#foreignKeysOf(table, column)).forEach(({ table, key }) => this.#suspend(table, key, because));
    const withDefault = typed.filter(({ column }) => this.#hasDefault(column));
    withDefault.forEach(({ table, column }) => this.#emit({ kind: "dropDefault", table: table.name, column: column.name }, { because }));
    const old = this.#newName();
    this.#emit({ kind: "renameType", type: name, to: old }, { because });
    this.#emit({ kind: "createEnumType", type: name, values: [...values] }, { because });
    for (const { table, column, type: columnType } of typed) {
      this.#emit({ kind: "alterColumnType", table: table.name, column: column.name, type: this.#pgType(columnType), using: "text" }, { because, ...(rows !== undefined && { assumes: rows }) });
    }
    this.#emit({ kind: "dropType", type: old }, { because });
    withDefault.forEach(({ table, column, type: columnType }) => this.#restoreDefault(table, column, columnType, values, because));
    return rows;
  }

  // --- one step ------------------------------------------------------------------------

  /** Writes the statements of a step. Returns what the step needs the rows to be, when it needs them to be something. Throws a `Refusal` for a step that cannot be written. */
  #write(step: MigrationStep, index: number): { reason: DataReason; detail: string } | undefined {
    const named = (constraint: string | undefined, noun: string, table: string): string =>
      constraint ?? refuse("constraint-name-unknown", `The ${noun} of table ${quoted(table)} that is dropped has no name in the schema. PostgreSQL drops a constraint by its name, and nothing here says what the database calls it.`);
    switch (step.op) {
      // --- what goes ---
      case "dropForeignKey": {
        const table = this.#table(step.table);
        const key = table.foreignKeys.find((candidate) => candidate.name !== undefined && candidate.name === step.constraint);
        const at = key === undefined ? -1 : this.#suspended.findIndex((entry) => entry.key === key);
        if (at >= 0) {
          // PostgreSQL has it no longer: it went ahead of what it rested on, and does not come back.
          this.#suspended.splice(at, 1);
          return undefined;
        }
        this.#emit({ kind: "dropConstraint", table: step.table, constraint: named(step.constraint, "foreign key", step.table) });
        return undefined;
      }
      case "dropCheck":
        this.#emit({ kind: "dropConstraint", table: step.table, constraint: named(step.constraint, "check", step.table) });
        return undefined;
      case "dropUnique":
      case "dropPrimaryKey": {
        const constraint = named(step.constraint, step.op === "dropUnique" ? "unique constraint" : "primary key", step.table);
        this.#releaseKey(this.#table(step.table), step.before.columns);
        this.#emit({ kind: "dropConstraint", table: step.table, constraint });
        return undefined;
      }
      case "dropIndex":
        if (step.before.unique && (step.before.expressions ?? []).length === 0 && step.before.where === undefined) {
          this.#releaseKey(this.#table(step.table), step.before.columns);
        }
        this.#emit({ kind: "dropIndex", index: step.index });
        return undefined;
      case "dropColumn":
        this.#emit({ kind: "dropColumn", table: step.table, column: step.column }, { dropsData: true });
        return undefined;
      case "dropTable":
        this.#emit({ kind: "dropTable", table: step.table }, { dropsData: true });
        return undefined;

      // --- the renames ---
      case "renameEnumType":
        this.#typeNameFree(step.enum);
        this.#emit({ kind: "renameType", type: this.#typeName(step.from), to: step.enum });
        return undefined;
      case "renameEnumValue":
        this.#emit({ kind: "renameEnumValue", type: this.#typeName(step.enum), value: step.from, to: step.to });
        return undefined;
      case "renameTable":
        this.#tableNameFree(step.table, index + 1);
        this.#emit({ kind: "renameTable", table: step.from, to: step.table });
        return undefined;
      case "renameColumn":
        this.#emit({ kind: "renameColumn", table: step.table, column: step.from, to: step.column });
        return undefined;
      case "renameConstraint": {
        const table = this.#table(step.table);
        if (step.kind === "foreignKey" && table.foreignKeys.some((key) => key.name === step.from && this.#isSuspended(key))) {
          // PostgreSQL has it no longer: it comes back at the end under the name it has then.
          return undefined;
        }
        if (step.kind === "primaryKey" || step.kind === "unique") {
          this.#relationNameFree(step.constraint, `The ${step.kind === "unique" ? "unique constraint" : "primary key"} ${quoted(step.from)} of table ${quoted(step.table)}`);
        }
        this.#emit({ kind: "renameConstraint", table: step.table, constraint: step.from, to: step.constraint });
        return undefined;
      }
      case "renameIndex":
        this.#relationNameFree(step.index, `The index ${quoted(step.from)}`);
        this.#emit({ kind: "renameIndex", index: step.from, to: step.index });
        return undefined;

      // --- what comes and what changes ---
      case "addEnumType":
        this.#typeNameFree(step.enum);
        this.#emit({ kind: "createEnumType", type: step.enum, values: [...step.after.values] });
        return undefined;
      case "addEnumValue":
        this.#emit({ kind: "addEnumValue", type: this.#typeName(step.enum), value: step.value, ...(step.beforeValue !== undefined ? { before: step.beforeValue } : step.afterValue !== undefined ? { after: step.afterValue } : {}) });
        return undefined;
      case "replaceEnumValues": {
        const type = this.#model.enumType(step.enum) as ModelEnum;
        return this.#remakeEnum(
          type,
          step.after,
          step.before.filter((value) => !step.after.includes(value)),
        );
      }
      case "removeEnumValue": {
        const type = this.#model.enumType(step.enum) as ModelEnum;
        if (this.#remade !== undefined && this.#remade.type === type && index <= this.#remade.until) {
          // The type was made again without this value too, at the first of these steps.
          return this.#remade.rows;
        }
        // The steps that stand together and take values out of the same type: one type made again does for them all, at the first of them.
        const together = (at: number): boolean => {
          const other = this.#plan.steps[at];
          return other !== undefined && other.op === "removeEnumValue" && other.enum === step.enum;
        };
        let [first, last] = [index, index];
        while (together(first - 1)) {
          first -= 1;
        }
        while (together(last + 1)) {
          last += 1;
        }
        const gone = this.#plan.steps.slice(first, last + 1).map((other) => (other as Extract<MigrationStep, { op: "removeEnumValue" }>).value);
        const rows = this.#remakeEnum(
          type,
          type.values.filter((value) => !gone.includes(value)),
          gone,
        );
        this.#remade = { type, until: last, ...(rows !== undefined && { rows }) };
        return rows;
      }
      case "addTable": {
        const state = step.after;
        const columns = state.columns.map((column) => this.#definition(step.table, column));
        const keys = [...(state.primaryKey === undefined ? [] : [{ ...state.primaryKey, noun: "primary key" }]), ...state.uniques.map((unique) => ({ ...unique, noun: "unique constraint" }))];
        // What the table is created with, as PostgreSQL has it: this refuses what cannot be written, before anything of the table is.
        const primaryKey = state.primaryKey === undefined ? [] : [this.#key("primaryKey", step.table, state.primaryKey)];
        const checks = state.checks.map((check) => this.#check(step.table, check));
        const takesNull = state.primaryKey?.columns.find((name) => state.columns.find((column) => column.name === name)?.nullable === true);
        if (takesNull !== undefined) {
          refuse("primary-key-column-takes-null", `The column ${quoted(step.table)}.${quoted(takesNull)} is of the primary key and is said to take NULL. In PostgreSQL a column of a primary key takes none.`);
        }
        this.#tableNameFree(step.table, index + 1);
        // A key has an index of its name, which is a relation beside the table itself and the other keys.
        const relations = [step.table];
        for (const key of keys) {
          if (key.name === undefined) {
            continue;
          }
          if (relations.includes(key.name)) {
            refuse("name-conflict", `The ${key.noun} ${quoted(key.name)} of table ${quoted(step.table)} would have the name of the table or of another of its keys. PostgreSQL keeps the names of tables, indexes, and keys in one place.`);
          }
          this.#relationNameFree(key.name, `The ${key.noun} of table ${quoted(step.table)}`);
          relations.push(key.name);
        }
        /*
         * PostgreSQL leaves a unique constraint out of CREATE TABLE, without a
         * word, when the primary key or an earlier one is over the same columns
         * in the same order: it makes one index for both. Added by a statement
         * of its own, it is made. So such a one is.
         */
        const inTable: string[][] = state.primaryKey === undefined ? [] : [state.primaryKey.columns];
        const repeats = (key: { columns: string[] }): boolean => inTable.some((columns) => columns.length === key.columns.length && columns.every((name, position) => name === key.columns[position]));
        const uniques: TableConstraint[] = [];
        const afterwards: TableConstraint[] = [];
        for (const unique of state.uniques) {
          const constraint = this.#key("unique", step.table, unique);
          if (repeats(unique)) {
            afterwards.push(constraint);
          } else {
            uniques.push(constraint);
            inTable.push(unique.columns);
          }
        }
        const constraints: TableConstraint[] = [...primaryKey, ...uniques, ...checks];
        this.#emit({ kind: "createTable", table: step.table, columns, constraints });
        afterwards.forEach((constraint) => this.#emit({ kind: "addConstraint", table: step.table, constraint }, { because: "key-over-the-same-columns" }));
        return undefined;
      }
      case "addColumn": {
        const column = this.#definition(step.table, step.after);
        // A table with rows has to have a value for each of them.
        const rows = column.notNull && column.default === undefined && column.identity !== true ? rowsNeed("rows-need-a-value", `The table ${quoted(step.table)} may have rows, and the new column ${quoted(step.column)} takes no NULL and has no default: PostgreSQL has no value for them.`) : undefined;
        this.#emit({ kind: "addColumn", table: step.table, column }, { ...(rows !== undefined && { assumes: rows }) });
        return rows;
      }
      case "dropDefault": {
        const column = this.#column(this.#table(step.table), step.column);
        if (this.#defaultsOff.delete(column)) {
          // PostgreSQL has it no longer: it went when the column's type changed.
          return undefined;
        }
        if (step.before.kind === "increment") {
          this.#emit({ kind: "dropIdentity", table: step.table, column: step.column }, { because: "numbering-kind-unknown" });
          this.#emit({ kind: "dropDefault", table: step.table, column: step.column }, { because: "numbering-kind-unknown" });
          return undefined;
        }
        this.#emit({ kind: "dropDefault", table: step.table, column: step.column });
        return undefined;
      }
      case "setDefault": {
        const table = this.#table(step.table);
        const column = this.#column(table, step.column);
        const what = `the column ${quoted(step.table)}.${quoted(step.column)}`;
        if (step.after.kind === "increment") {
          return refuse("numbering-not-representable", `The column ${quoted(step.table)}.${quoted(step.column)} is there already, and is to be numbered: its numbers have to start above the values its rows have, and a schema does not say where that is.`);
        }
        const type = this.#canonical({ ...(column.canonicalType !== undefined && { canonical: column.canonicalType }), ...(column.declaredType !== undefined && { declared: column.declaredType }) }, `The column ${quoted(step.table)}.${quoted(step.column)}`);
        const fallback = this.#default(step.after, type, what);
        if (this.#isNumbered(column)) {
          // PostgreSQL sets no default on an identity column: the identity goes first, if it is one.
          this.#emit({ kind: "dropIdentity", table: step.table, column: step.column }, { because: "numbering-kind-unknown" });
        }
        this.#emit({ kind: "setDefault", table: step.table, column: step.column, default: fallback });
        this.#defaultsOff.delete(column);
        return undefined;
      }
      case "alterColumnType": {
        const table = this.#table(step.table);
        const column = this.#column(table, step.column);
        const what = `The column ${quoted(step.table)}.${quoted(step.column)}`;
        const [was, is] = [this.#canonical(step.before, what), this.#canonical(step.after, what)];
        const change = classifyTypeChange(was, is, (name) => this.#model.enumType(name)?.values);
        if (change.safety === "requiresExplicitCast") {
          return refuse(change.reason, change.detail);
        }
        const rows = change.safety === "requiresDataMigration" ? rowsNeed(change.reason, change.detail) : undefined;
        // PostgreSQL's numbered column is a whole number: the numbering goes before the type does. (The plan's schema keeps it until the step that gives another default; one that never comes is found after the last step.)
        if (is.kind !== "integer" && this.#isNumbered(column)) {
          this.#numberingOff(table, column);
        }
        // A foreign key cannot be between the old type and the new one when PostgreSQL does not compare the two, and the other side changes at another step.
        if (comparedAs(was) !== comparedAs(is)) {
          this.#foreignKeysOf(table, column).forEach(({ table: owner, key }) => this.#suspend(owner, key, "foreign-key-across-type-change"));
        }
        // A default that is a value of an enumerated type stays that when the column leaves the type: it is taken off, and put back as a constant of the new type.
        const enumIs = enumOf(is);
        const offAndOn = enumOf(was) !== undefined && enumOf(was) !== enumIs && this.#hasDefault(column);
        if (offAndOn) {
          this.#emit({ kind: "dropDefault", table: step.table, column: step.column }, { because: "enum-default-across-type-change" });
        }
        this.#emit({ kind: "alterColumnType", table: step.table, column: step.column, type: this.#pgType(is), ...(change.using !== undefined && { using: change.using }) }, { ...(rows !== undefined && { assumes: rows }) });
        if (offAndOn) {
          this.#restoreDefault(table, column, is, enumIs === undefined ? [] : (this.#model.enumType(enumIs)?.values ?? []), "enum-default-across-type-change");
        }
        return rows;
      }
      case "dropNotNull": {
        const table = this.#table(step.table);
        const column = this.#column(table, step.column);
        if (this.#isNumbered(column)) {
          // A later step that gives the column another default takes the numbering off: then it goes here, ahead of that step.
          if (!this.#plan.steps.slice(index + 1).some((later) => later.op === "setDefault" && later.table === step.table && later.column === step.column)) {
            refuse("numbering-not-representable", `The column ${quoted(step.table)}.${quoted(step.column)} is numbered, and is to take NULL: that is a column with a sequence of its own, which a schema does not hold. PostgreSQL's numbered column (an identity) takes no NULL.`);
          }
          this.#numberingOff(table, column);
        }
        this.#emit({ kind: "dropNotNull", table: step.table, column: step.column });
        return undefined;
      }
      case "setNotNull": {
        const rows = rowsNeed("rows-may-hold-null", `No row of ${quoted(step.table)} may hold NULL in ${quoted(step.column)}.`);
        this.#emit({ kind: "setNotNull", table: step.table, column: step.column }, { assumes: rows });
        return rows;
      }
      case "dropEnumType": {
        const type = this.#model.enumType(step.enum) as ModelEnum;
        this.#emit({ kind: "dropType", type: this.#typeName(step.enum) });
        this.#aliases.delete(type);
        return undefined;
      }
      case "addPrimaryKey": {
        const table = this.#table(step.table);
        const takesNull = step.after.columns.find((name) => this.#column(table, name).nullable);
        if (takesNull !== undefined) {
          refuse("primary-key-column-takes-null", `The column ${quoted(step.table)}.${quoted(takesNull)} is of the primary key and is said to take NULL. In PostgreSQL a column of a primary key takes none.`);
        }
        if (step.after.name !== undefined) {
          this.#relationNameFree(step.after.name, `The primary key of table ${quoted(step.table)}`);
        }
        this.#emit({ kind: "addConstraint", table: step.table, constraint: this.#key("primaryKey", step.table, step.after) });
        return undefined;
      }
      case "addUnique":
        if (step.after.name !== undefined) {
          this.#relationNameFree(step.after.name, `The unique constraint of table ${quoted(step.table)}`);
        }
        this.#emit({ kind: "addConstraint", table: step.table, constraint: this.#key("unique", step.table, step.after) });
        return undefined;
      case "addCheck":
        this.#emit({ kind: "addConstraint", table: step.table, constraint: this.#check(step.table, step.after) });
        return undefined;
      case "addIndex":
        this.#emit(this.#index(step.table, step.after));
        return undefined;
      case "addForeignKey":
        this.#emit({ kind: "addConstraint", table: step.table, constraint: this.#addedForeignKey(step.table, step.after) });
        return undefined;
    }
  }

  #index(table: string, state: IndexState): StatementBody {
    const what = this.#named("index", state.name, table);
    this.#whole(state.sourceClauses, what, "index");
    const expressions = state.expressions ?? [];
    // The keys in their order: an index over columns and expressions both that does not state them does not say it.
    if (indexKeys(state) === undefined) {
      refuse("index-elements-order-unknown", `The index ${quoted(state.name)} of table ${quoted(table)} is over columns (${state.columns.join(", ")}) and expressions (${expressions.join(", ")}), and a schema does not say in which order they stand.`);
    }
    if (expressions.length > 0 || state.where !== undefined) {
      this.#current(state, what, [...expressions, ...(state.where === undefined ? [] : [state.where])].join("; "));
    }
    this.#relationNameFree(state.name, `The index of table ${quoted(table)}`);
    return {
      kind: "createIndex",
      index: state.name,
      table,
      unique: state.unique,
      columns: [...state.columns],
      expressions: [...expressions],
      ...(state.where !== undefined && { where: state.where }),
      ...(state.method !== undefined && { method: state.method }),
      ...(state.keys !== undefined && { keys: state.keys.map(copyIndexKey) }),
      ...(state.include !== undefined && state.include.length > 0 && { include: [...state.include] }),
      ...(state.nullsNotDistinct === true && { nullsNotDistinct: true as const }),
    };
  }

  /** A foreign key that is added: PostgreSQL makes it with a key over the columns it refers to, which has to be there. */
  #addedForeignKey(table: string, state: ForeignKeyState): TableConstraint {
    this.#whole(state.sourceClauses, this.#named("foreign key", state.name, table), "constraint");
    const target = this.#table(state.references.table);
    const columns = state.references.columns;
    if (!this.#hasKeyOver(target, columns)) {
      // A key that is over them and is deferrable is the one thing in the way: said, so that it need not be looked for.
      const deferrable = [
        ...(target.primaryKey !== undefined && target.primaryKey.deferrable !== undefined && sameColumns(target.primaryKey.columns, columns) ? [`The primary key${target.primaryKey.name === undefined ? "" : ` ${quoted(target.primaryKey.name)}`}`] : []),
        ...target.uniques.filter((unique) => unique.deferrable !== undefined && sameColumns(unique.columns, columns)).map((unique) => `The unique constraint${unique.name === undefined ? "" : ` ${quoted(unique.name)}`}`),
      ][0];
      refuse(
        "foreign-key-without-key",
        `The foreign key${state.name === undefined ? "" : ` ${quoted(state.name)}`} of table ${quoted(table)} refers to ${quoted(state.references.table)} (${columns.join(", ")}), and no primary key, unique constraint, or unique index is over exactly those columns at this step. PostgreSQL makes a foreign key with one.${
          deferrable === undefined ? "" : ` (${deferrable} is over them and is deferrable: PostgreSQL rests no foreign key on a deferrable key.)`
        }`,
      );
    }
    return this.#foreignKey(table, state);
  }

  // --- after the last step ----------------------------------------------------------------

  /** Notes on a step what was only found after the last one, unless the step is refused already. */
  #refuseStep(step: number, refusal: Refusal): void {
    const assessment = this.#assessments[step - 1] as StepAssessment;
    if (assessment.safety === "safe" || assessment.safety === "requiresDataMigration") {
      this.#assessments[step - 1] = { step: assessment.step, operation: assessment.operation, safety: refusal.safety, reason: refusal.reason, detail: refusal.message };
    }
  }

  #finish(): void {
    // The foreign keys that went for PostgreSQL's sake come back, under the names things have now: those the plan's schema still has.
    for (const { table, key, step, because } of this.#suspended) {
      if (!this.#model.tables.includes(table) || !table.foreignKeys.includes(key)) {
        continue;
      }
      this.#step = step;
      try {
        // As the plan's schema has it now: with all that it holds of the key, and with what it only says there is, which is not written back.
        this.#emit({ kind: "addConstraint", table: table.name, constraint: this.#addedForeignKey(table.name, foreignKeyState(key)) }, { because });
      } catch (error) {
        if (!(error instanceof Refusal)) {
          throw error;
        }
        this.#refuseStep(step, error);
      }
    }
    // A default that went with a change of type, and that no step set again or dropped: the schema to arrive at has one that is no value of its type.
    for (const [column, { step, numbering }] of this.#defaultsOff) {
      const table = this.#model.tables.find((candidate) => candidate.columns.includes(column));
      if (table === undefined) {
        continue;
      }
      const what = `the column ${quoted(table.name)}.${quoted(column.name)}`;
      this.#refuseStep(
        step,
        numbering
          ? new Refusal("numbering-not-representable", `From this step on ${what} is no whole number, and it stays numbered: no later step of the plan gives it another default. PostgreSQL's numbered column (an identity) is a whole number.`)
          : new Refusal("default-not-a-value-of-its-type", `The default of ${what} is no value of the type the column has from this step on, and no later step of the plan changes it.`),
      );
    }
  }
}

/** Every name of a schema, of whatever kind. */
function namesOf(model: SchemaModel): string[] {
  return [...model.enums.flatMap((type) => [type.name, ...type.values]), ...model.tables.flatMap((table) => [table.name, ...table.columns.map((column) => column.name), ...constraintNames(table), ...table.indexes.map((index) => index.name)])];
}

/** The names a step gives: among them the temporary names of the plan, which neither schema has. */
function namesIn(step: MigrationStep): string[] {
  const named = step as { enum?: unknown; table?: unknown; column?: unknown; constraint?: unknown; index?: unknown; to?: unknown };
  return [named.enum, named.table, named.column, named.constraint, named.index, named.to].filter((name): name is string => typeof name === "string");
}

/**
 * The PostgreSQL migration of a plan, for the schema the plan is for. Throws
 * a `MigrationPlanError` for a plan that cannot be carried out on that
 * schema, as `applyPlan` does. A plan that can be, and that has a step that
 * cannot be written as SQL without knowing more, is not an error: the result
 * says which steps, and why, and has no migration.
 *
 * The result is the same for the same schema and plan, in whatever order the
 * schema lists its objects.
 */
export function generatePostgresMigration(before: DatabaseSchema, plan: MigrationPlan, options: PostgresGenerationOptions = {}): PostgresGeneration {
  // The plan is carried out once as the validator of plans carries it out: what cannot be carried out is no plan to write statements for.
  const target = SchemaModel.from(before);
  applyPlanTo(target, plan);
  return new Generator(before, plan, options, target).run();
}
