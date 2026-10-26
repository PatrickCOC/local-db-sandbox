import { formatCanonicalType } from "../../runtime/src/canonical-type.ts";
import { staleNamesOf } from "../../runtime/src/expression-names.ts";
import { indexKeys } from "../../runtime/src/index-definition.ts";
import type { Deferrable, ExpressionName } from "../../runtime/src/index.ts";
import type { DefaultState, ForeignKeyState, IndexState, RenameEvidence, SchemaChange, SchemaDiff, TypeState } from "./ir.ts";

/*
 * A diff as lines for people: one per change, `+` for what is added, `-` for
 * what is dropped, `~` for what changes. Formatted from the IR; the IR is
 * what programs read.
 */

function typeText(type: TypeState): string {
  if (type.canonical !== undefined) {
    return formatCanonicalType(type.canonical);
  }
  return type.declared ?? (type.enum !== undefined ? `enum ${type.enum}` : type.storage);
}

/**
 * What differs between two types that were compared as declared: which of
 * the storage type, the declared spelling, and the enumerated type. Showing
 * both types as text would not do: a type that says nothing of how it was
 * declared is shown by its storage type, and `boolean -> boolean` would be
 * the line for a difference.
 */
function declaredDifference(before: TypeState, after: TypeState): string {
  const spelling = (type: TypeState): string | undefined => type.declared?.trim().replace(/\s+/g, " ");
  const enumOf = (type: TypeState): string | undefined => type.enum ?? (type.canonical?.kind === "enum" ? type.canonical.name : undefined);
  const differences = [
    before.storage !== after.storage ? `storage type ${before.storage} -> ${after.storage}` : undefined,
    spelling(before)?.toLowerCase() !== spelling(after)?.toLowerCase() ? `declared type ${spelling(before) ?? "none"} -> ${spelling(after) ?? "none"}` : undefined,
    enumOf(before) !== enumOf(after) ? `enumerated type ${enumOf(before) ?? "none"} -> ${enumOf(after) ?? "none"}` : undefined,
  ].filter((difference) => difference !== undefined);
  return differences.length > 0 ? differences.join(", ") : `type ${typeText(before)} -> ${typeText(after)}`;
}

function defaultText(state: DefaultState | undefined): string {
  if (state === undefined) {
    return "none";
  }
  switch (state.kind) {
    case "value":
      return JSON.stringify(state.value);
    case "function":
      return state.function;
    case "increment":
      return "the next number";
    case "generated":
      return `generated ${state.strategy}${state.expression === undefined ? "" : ` (${state.expression})`}`;
    case "expression":
      return state.expression;
  }
}

function named(name: string | undefined): string {
  return name === undefined ? "" : ` [${name}]`;
}

function list(columns: readonly string[]): string {
  return `(${columns.join(", ")})`;
}

function deferrableText(deferrable: Deferrable | undefined): string {
  return deferrable === undefined ? "" : deferrable === "deferred" ? " deferrable initially deferred" : " deferrable";
}

/** What an object says that the schema has no place for, after everything else of it. */
function clausesText(clauses: readonly string[] | undefined): string {
  return clauses === undefined || clauses.length === 0 ? "" : `; not held by the schema: ${clauses.join(", ")}`;
}

/** What is the matter with an expression's text: the names it is stale by, or that it may be stale. */
function staleText(text: { names?: readonly ExpressionName[]; mayBeStale?: boolean }): string {
  if (text.mayBeStale === true) {
    return "; its text may be stale: what it names is not known, and a rename may have reached it";
  }
  const each = staleNamesOf(text.names).map((entry) => `${entry.kind} "${entry.name}"${entry.type === undefined ? "" : ` of "${entry.type}"`} is "${entry.now}" now`);
  return each.length === 0 ? "" : `; its text has names that are stale: ${each.join(", ")}`;
}

/** What a key carries along, and whether two NULLs are the same to it. */
function keyText(key: { include?: readonly string[]; nullsNotDistinct?: boolean }): string {
  return `${key.include === undefined || key.include.length === 0 ? "" : ` include ${list(key.include)}`}${key.nullsNotDistinct === true ? " nulls not distinct" : ""}`;
}

function foreignKeyText(table: string, key: ForeignKeyState): string {
  const actions = [key.onDelete !== "NO ACTION" ? `on delete ${key.onDelete.toLowerCase()}` : undefined, key.onUpdate !== "NO ACTION" ? `on update ${key.onUpdate.toLowerCase()}` : undefined].filter(Boolean);
  return `${table} ${list(key.columns)} -> ${key.references.table} ${list(key.references.columns)}${actions.length > 0 ? ` ${actions.join(", ")}` : ""}${deferrableText(key.deferrable)}${named(key.name)}${clausesText(key.sourceClauses)}`;
}

/** An index as it is created: how it is built, its keys in their order with what each says, and what else it has. */
function indexText(table: string, index: IndexState): string {
  const keys = indexKeys(index);
  const each =
    keys === undefined
      ? [...index.columns, ...(index.expressions ?? [])]
      : keys.map((key) => `${key.column ?? key.expression}${key.collation === undefined ? "" : ` collate ${key.collation}`}${key.operatorClass === undefined ? "" : ` ${key.operatorClass}`}${key.order === undefined ? "" : ` ${key.order}`}${key.nulls === undefined ? "" : ` nulls ${key.nulls}`}`);
  return `${index.unique ? "unique index" : "index"} ${index.name} on ${table}${index.method === undefined ? "" : ` using ${index.method}`} ${list(each)}${keyText(index)}${index.where === undefined ? "" : ` where ${index.where}`}${clausesText(index.sourceClauses)}${staleText(index)}`;
}

function evidenceText(evidence: RenameEvidence): string {
  const last = evidence.renames.at(-1);
  return last === undefined ? "" : ` (${last.at.file}:${last.at.line})`;
}

/** One line for a change. */
export function formatSchemaChange(change: SchemaChange): string {
  switch (change.op) {
    case "renameEnumType":
      return `~ enum ${change.from} renamed to ${change.enum}${evidenceText(change.evidence)}`;
    case "renameEnumValue":
      return `~ enum ${change.enum}: value ${change.from} renamed to ${change.to}${evidenceText(change.evidence)}`;
    case "renameTable":
      return `~ table ${change.from} renamed to ${change.table}${evidenceText(change.evidence)}`;
    case "renameColumn":
      return `~ column ${change.table}.${change.from} renamed to ${change.column}${evidenceText(change.evidence)}`;
    case "renameConstraint":
      return `~ ${change.kind === "primaryKey" ? "primary key" : change.kind === "foreignKey" ? "foreign key" : change.kind} ${change.from} of ${change.table} renamed to ${change.constraint}${evidenceText(change.evidence)}`;
    case "renameIndex":
      return `~ index ${change.from} of ${change.table} renamed to ${change.index}${evidenceText(change.evidence)}`;
    case "dropForeignKey":
      return `- foreign key ${foreignKeyText(change.table, change.before)}`;
    case "dropCheck":
      return `- check ${change.table} (${change.before.expression})${named(change.constraint)}`;
    case "dropUnique":
      return `- unique ${change.table} ${list(change.before.columns)}${keyText(change.before)}${deferrableText(change.before.deferrable)}${named(change.constraint)}`;
    case "dropIndex":
      return `- index ${change.index} on ${change.table}`;
    case "dropPrimaryKey":
      return `- primary key ${change.table} ${list(change.before.columns)}${keyText(change.before)}${deferrableText(change.before.deferrable)}${named(change.constraint)}`;
    case "addEnumType":
      return `+ enum ${change.enum} ${list(change.after.values)}`;
    case "addEnumValue":
      return `+ enum ${change.enum}: value ${change.value}${change.afterValue !== undefined ? ` after ${change.afterValue}` : change.beforeValue !== undefined ? ` before ${change.beforeValue}` : ""}`;
    case "replaceEnumValues":
      return `~ enum ${change.enum}: values ${list(change.before)} -> ${list(change.after)}`;
    case "addTable":
      return `+ table ${change.table} (${change.after.columns.length} column${change.after.columns.length === 1 ? "" : "s"}${change.after.primaryKey === undefined ? "" : `, primary key ${list(change.after.primaryKey.columns)}`})`;
    case "addColumn":
      return `+ column ${change.table}.${change.column} ${typeText(change.after.type)}${change.after.nullable ? "" : " not null"}${change.after.default === undefined ? "" : ` default ${defaultText(change.after.default)}`}`;
    case "dropDefault":
      return `~ column ${change.table}.${change.column}: default ${defaultText(change.before)} dropped`;
    case "alterColumnType":
      return change.comparedBy === "declared"
        ? `~ column ${change.table}.${change.column}: ${declaredDifference(change.before, change.after)} (compared as declared)`
        : `~ column ${change.table}.${change.column}: type ${typeText(change.before)} -> ${typeText(change.after)}`;
    case "dropNotNull":
      return `~ column ${change.table}.${change.column}: nullable`;
    case "setNotNull":
      return `~ column ${change.table}.${change.column}: not null`;
    case "setDefault": {
      const text = (state: DefaultState | undefined): { expression?: string; names?: readonly ExpressionName[]; mayBeStale?: boolean } => (state === undefined || state.kind === "value" || state.kind === "increment" ? {} : state);
      // A default that is set to the text it had: its text names other things than it did, or is not known to name the same.
      const matter = staleText(text(change.after)) || (text(change.after).expression !== undefined && defaultText(change.before) === defaultText(change.after) ? "; it reads as it did, and does not name what it named" : "");
      return `~ column ${change.table}.${change.column}: default ${defaultText(change.before)} -> ${defaultText(change.after)}${matter}`;
    }
    case "dropColumn":
      return `- column ${change.table}.${change.column}`;
    case "dropTable":
      return `- table ${change.table}`;
    case "removeEnumValue":
      return `- enum ${change.enum}: value ${change.value}`;
    case "dropEnumType":
      return `- enum ${change.enum}`;
    case "addPrimaryKey":
      return `+ primary key ${change.table} ${list(change.after.columns)}${keyText(change.after)}${deferrableText(change.after.deferrable)}${named(change.constraint)}${clausesText(change.after.sourceClauses)}`;
    case "addUnique":
      return `+ unique ${change.table} ${list(change.after.columns)}${keyText(change.after)}${deferrableText(change.after.deferrable)}${named(change.constraint)}${clausesText(change.after.sourceClauses)}`;
    case "addCheck":
      return `+ check ${change.table} (${change.after.expression})${named(change.constraint)}${clausesText(change.after.sourceClauses)}${staleText(change.after)}`;
    case "addIndex":
      return `+ ${indexText(change.table, change.after)}`;
    case "addForeignKey":
      return `+ foreign key ${foreignKeyText(change.table, change.after)}`;
  }
}

/** The lines of a diff: a count, then one line per change. */
export function formatSchemaDiff(diff: SchemaDiff): string[] {
  if (diff.changes.length === 0) {
    return ["No differences."];
  }
  return [`${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"}:`, ...diff.changes.map((change) => `  ${formatSchemaChange(change)}`)];
}
