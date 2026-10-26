import { canonicalTypeKey, copyCanonicalType } from "../../runtime/src/canonical-type.ts";
import type { CanonicalType } from "../../runtime/src/canonical-type.ts";
import { copyExpressionName } from "../../runtime/src/expression-names.ts";
import { copyIndexKey, indexKeys } from "../../runtime/src/index-definition.ts";
import type { CheckConstraint, ColumnSchema, DatabaseSchema, Deferrable, EnumType, ExpressionName, IndexDefinition, ObjectProvenance, SchemaOrigin, SchemaRename, TableSchema, UniqueConstraint } from "../../runtime/src/index.ts";
import { CHANGE_ORDER, SCHEMA_DIFF_VERSION } from "./ir.ts";
import type {
  CheckState,
  ColumnState,
  ConstraintKind,
  DefaultState,
  EnumState,
  ForeignKeyState,
  IndexState,
  PrimaryKeyState,
  RenameEvidence,
  SchemaChange,
  SchemaDiff,
  TableState,
  TypeState,
  UniqueState,
} from "./ir.ts";
import { compareText, stableStringify } from "./stable-json.ts";

/*
 * Compares two canonical schemas (D-037).
 *
 * Semantics, not spelling: column types are compared by their canonical type
 * (`integer` and `int4` are one type), defaults by their canonical meaning
 * (D-034: `now()` and `current_timestamp` are one default), foreign key
 * actions with `NO ACTION` made explicit. What has no canonical form is
 * compared as text, conservatively: two spellings that may mean the same are
 * reported as a change, never declared equal.
 *
 * Identity: an object of the after side is the before side's object of the
 * same name, unless explicit evidence says that it is another one, renamed
 * (`renameEvidence`: the same origin, and recorded renames from one name to
 * the other). Evidence is looked at first, so that a renamed object stays
 * renamed when something new has its old name, or when it has taken the name
 * of something that is dropped. Nothing is matched by similarity. A constraint
 * without a name (a schema written by hand, or by an ORM) is matched by what
 * it is: its columns, its expression.
 *
 * Two objects under one name are still two objects. A key, constraint, or
 * index of the before side is compared with the after side's by what it is
 * on: a column or table that is dropped is not the one that takes its name.
 *
 * Provenance never makes two schemas differ; only renames use it.
 *
 * An expression is text of its source, and a rename leaves that text as it
 * was while the source's database follows the rename. Two texts that read
 * alike therefore say the same only when every name in them is the same
 * thing's on both sides (D-040). A schema that knows what a text names says
 * so (`ExpressionName`): each name, with what its thing is called now.
 *
 * - Where both sides say what the text names: what a name is called on the
 *   before side has to be, by the renames of this diff, what it is called
 *   on the after side. A text that reads alike and names a column that was
 *   renamed is another expression than one that names the column which has
 *   taken that name.
 * - Where one side says it: the same, with the other side's text taken as
 *   it is written, in the names that side has.
 * - Where neither does (schemas written by hand, by an ORM, or in an
 *   earlier format): the texts are compared as text, as long as no rename
 *   of this diff can reach them. A rename of a column of the table, of the
 *   table, of an enumerated type, or of a value of one may have reached a
 *   text, and nothing says whether it did: across one, a text is the other
 *   side's only when the two are one object (the same origin), which a
 *   database follows through a rename by itself. A default has no object of
 *   its own.
 * - The same holds for a text that may be stale (`mayBeStale`): it is one
 *   object's, or it is as unknown as the other side's with nothing renamed
 *   between them.
 * - The diff knows no functions, and no type that is not enumerated: of one
 *   object, such a thing is the one it was; of two, it is when both sides
 *   call it the same.
 *
 * Two texts that are not known to say the same are different: the one goes
 * and the other comes, with what the schema says of the text that comes. A
 * default that the runtime computes is what it computes, whatever its text
 * is.
 *
 * Order: changes are listed by kind in `CHANGE_ORDER`, and within a kind by
 * table (or type), then by object name (or, for a constraint without a name,
 * its definition), by code point. The values added to one enumerated type
 * keep the order in which they can be added. Nothing depends on the order the
 * schemas list their objects in.
 *
 * Names: what goes (keys, constraints, indexes, columns, tables) stands
 * before the renames and is named as the before side names things. The
 * renames and everything after them name things as the after side does.
 *
 * Not compared: the order of a table's columns (the order of the columns of
 * a key, a constraint, or an index is), and how the runtime stores a column
 * whose canonical type is known.
 */

interface Named extends ObjectProvenance {
  name: string;
}

function sameOrigin(a: SchemaOrigin, b: SchemaOrigin): boolean {
  return a.source === b.source && a.file === b.file && a.sha256 === b.sha256 && a.statement === b.statement && a.name === b.name;
}

function sameRename(a: SchemaRename, b: SchemaRename): boolean {
  return a.from === b.from && a.to === b.to && a.at.source === b.at.source && a.at.file === b.at.file && a.at.sha256 === b.at.sha256 && a.at.statement === b.at.statement;
}

function copyOrigin(origin: SchemaOrigin): SchemaOrigin {
  return { ...origin };
}

/**
 * Evidence that `after` is `before` renamed: they have the same origin, the
 * renames `before` records are the start of those `after` records, and the
 * rest lead from `before`'s name to `after`'s. The evidence is that rest.
 * `undefined` otherwise, also for an object without provenance, and for a
 * later state compared with an earlier one.
 */
export function renameEvidence(before: Named, after: Named): RenameEvidence | undefined {
  if (before.origin === undefined || after.origin === undefined || !sameOrigin(before.origin, after.origin) || before.name === after.name) {
    return undefined;
  }
  const known = before.renames ?? [];
  const history = after.renames ?? [];
  if (known.length >= history.length || !known.every((record, index) => sameRename(record, history[index] as SchemaRename))) {
    return undefined;
  }
  // A history that does not hang together is no evidence: it leads from the name the object was created with, by way of the before side's name, to the after side's.
  let name = after.origin.name;
  for (const [index, record] of history.entries()) {
    if (record.from !== name || (index === known.length && name !== before.name)) {
      return undefined;
    }
    name = record.to;
  }
  if (name !== after.name) {
    return undefined;
  }
  return { origin: copyOrigin(after.origin), renames: structuredClone(history.slice(known.length)) };
}

/** The spaces that SQL takes for layout. Other characters that look like spaces are part of a text. */
const LAYOUT = "[ \\t\\n\\r\\f\\v]+";

/**
 * SQL text compared as written, apart from its layout. Layout is set aside
 * only where it cannot be part of what the text says: spaces count within a
 * quoted text, and a line end closes a comment. How texts are quoted and
 * comments are written differs between dialects, so a text with a character
 * that quotes in some dialect, or the start of a comment, is compared exactly.
 */
function normalizeSql(text: string): string {
  const trimmed = text.replace(new RegExp(`^${LAYOUT}|${LAYOUT}$`, "g"), "");
  return /['"`$#[]|--|\/\*/.test(trimmed) ? trimmed : trimmed.replace(new RegExp(LAYOUT, "g"), " ");
}

function normalizeAction(action: string | undefined): string {
  return action === undefined ? "NO ACTION" : action.trim().replace(/\s+/g, " ").toUpperCase();
}

interface Pair<T> {
  before: T;
  after: T;
  evidence?: RenameEvidence;
}

interface Matching<T> {
  pairs: Pair<T>[];
  removed: T[];
  added: T[];
}

/** What an object of a list is, apart from its name: for objects that may have no name. */
interface Signatures<T> {
  /** Of an object of the before side, in the names the after side has. */
  before: (item: T) => string;
  after: (item: T) => string;
}

/**
 * Matches the objects of two lists: by explicit rename evidence; then, among
 * those left, by name; then, for objects of which one has no name, by
 * signature. Evidence comes first: a renamed object stays the same object
 * when something new has taken its old name. Deterministic: candidates are
 * tried in an order that depends only on the objects.
 *
 * With `takeovers: false`, an object is not taken to be renamed onto a name
 * that another object of the before side has and gives up by being dropped.
 * The two are then matched by name, and the first one is dropped.
 */
function match<T extends ObjectProvenance & { name?: string }>(before: readonly T[], after: readonly T[], options: { signature?: Signatures<T>; takeovers?: boolean } = {}): Matching<T> {
  const { signature } = options;
  // By name and by what the object is; two that are alike in both, by all they say, so that they still have one order.
  const sorted = (items: readonly T[], side: "before" | "after"): T[] => {
    const heads = new Map(items.map((item) => [item, `${item.name ?? ""}\u0000${signature?.[side](item) ?? ""}`]));
    const texts = new Map<T, string>();
    const textOf = (item: T): string => texts.get(item) ?? (texts.set(item, stableStringify(item)).get(item) as string);
    return [...items].sort((a, b) => compareText(heads.get(a) as string, heads.get(b) as string) || compareText(textOf(a), textOf(b)));
  };
  const sortedBefore = sorted(before, "before");
  const sortedAfter = sorted(after, "after");
  let pairs: Pair<T>[] = [];
  const matchedBefore = new Set<T>();
  const matchedAfter = new Set<T>();
  const pair = (a: T, b: T, evidence?: RenameEvidence): void => {
    pairs.push({ before: a, after: b, ...(evidence !== undefined && { evidence }) });
    matchedBefore.add(a);
    matchedAfter.add(b);
  };
  for (const b of sortedAfter) {
    if (b.name === undefined) {
      continue;
    }
    for (const a of sortedBefore) {
      if (!matchedBefore.has(a) && a.name !== undefined) {
        const evidence = renameEvidence(a as Named, b as Named);
        if (evidence !== undefined) {
          pair(a, b, evidence);
          break;
        }
      }
    }
  }
  if (options.takeovers === false) {
    // Giving up one rename can leave another without a free name, so until nothing changes.
    for (let changed = true; changed; ) {
      changed = false;
      for (const candidate of pairs) {
        const holder = sortedBefore.find((item) => item !== candidate.before && item.name === candidate.after.name);
        if (holder !== undefined && !matchedBefore.has(holder)) {
          pairs = pairs.filter((entry) => entry !== candidate);
          matchedBefore.delete(candidate.before);
          matchedAfter.delete(candidate.after);
          changed = true;
          break;
        }
      }
    }
  }
  for (const a of sortedBefore) {
    const b = a.name === undefined || matchedBefore.has(a) ? undefined : sortedAfter.find((candidate) => !matchedAfter.has(candidate) && candidate.name === a.name);
    if (b !== undefined) {
      pair(a, b);
    }
  }
  if (signature !== undefined) {
    for (const b of sortedAfter) {
      if (matchedAfter.has(b)) {
        continue;
      }
      const a = sortedBefore.find((candidate) => !matchedBefore.has(candidate) && (candidate.name === undefined || b.name === undefined) && signature.before(candidate) === signature.after(b));
      if (a !== undefined) {
        pair(a, b);
      }
    }
  }
  return { pairs, removed: sortedBefore.filter((item) => !matchedBefore.has(item)), added: sortedAfter.filter((item) => !matchedAfter.has(item)) };
}

/** Marks the name of a table or column that the after side does not have. No name starts with it. */
const GONE = "\u0000";

/**
 * How the objects of the before side are called on the after side, as far as
 * explicit renames tell, and which of them the after side does not have.
 * Tables, columns, and enumerated types are looked up by the names the
 * before side has.
 */
class Renames {
  /** The tables both sides have: the before side's name, and the after side's. */
  readonly tables = new Map<string, string>();
  readonly droppedTables = new Set<string>();
  /** By the before side's table name: the columns both sides have, and those that only the before side has. */
  readonly columns = new Map<string, Map<string, string>>();
  readonly droppedColumns = new Map<string, Set<string>>();
  readonly enums = new Map<string, string>();
  readonly enumValues = new Map<string, Map<string, string>>();
  /**
   * The values of the before side's enumerated types, by the type's name
   * there.
   */
  readonly valuesBefore = new Map<string, readonly string[]>();

  /** Whether this diff renames something that the text of an expression can name. `table`: the before side's name of the expression's table; a default has none, and names no column. */
  #renamesReach(table: string | undefined): boolean {
    const renamed = (names: ReadonlyMap<string, string> | undefined): boolean => [...(names ?? [])].some(([before, after]) => before !== after);
    return this.enums.size > 0 || [...this.enumValues.values()].some(renamed) || (table !== undefined && (this.tableIdentity(table) !== table || renamed(this.columns.get(table))));
  }

  /**
   * What a default of the before side names, with what those things are
   * called on the after side: a default names types, and values of them.
   */
  namesAfter(names: readonly ExpressionName[]): ExpressionName[] {
    return names.map((entry) => {
      const now = entry.now ?? entry.name;
      if (entry.kind === "value" && entry.type !== undefined) {
        return copyExpressionName({ ...entry, now: this.enumValue(entry.type, now), type: this.enumName(entry.type) });
      }
      return copyExpressionName(entry.kind === "type" && this.valuesBefore.has(now) ? { ...entry, now: this.enumName(now) } : entry);
    });
  }

  /** The before side's name of the enumerated type that the after side calls `name`. */
  #enumNameBefore(name: string): string | undefined {
    const [renamed] = [...this.enums].filter(([, after]) => after === name);
    return renamed !== undefined ? renamed[0] : this.valuesBefore.has(name) && !this.enums.has(name) ? name : undefined;
  }

  /**
   * What the after side calls the thing that the before side calls `name`.
   * `null`: the diff does not know such things (a function, a type that is
   * not enumerated). `undefined`: nothing says. `table`: the before side's
   * name of the table whose column is meant. `type`: of a value, the before
   * side's name of its type.
   */
  #called(kind: ExpressionName["kind"], name: string, table: string | undefined, type: string | undefined): string | null | undefined {
    switch (kind) {
      case "column":
        return table === undefined ? undefined : this.columnIdentity(table, name);
      case "table":
        return this.tableIdentity(name);
      case "type":
        return this.valuesBefore.has(name) ? this.enumName(name) : null;
      case "value":
        return type === undefined ? undefined : this.enumValue(type, name);
      case "function":
        return null;
    }
  }

  /**
   * Whether the names of a text lead, by the renames of this diff, from what
   * the before side calls them to what the after side does. A side that does
   * not say what its text names (`undefined`) has the text as it is written:
   * each name is what that side has under it. Where both sides say it, a
   * name that only one of them has is a difference: the two texts do not
   * name the same things.
   */
  #namesLead(table: string | undefined, said: { before: readonly ExpressionName[] | undefined; after: readonly ExpressionName[] | undefined }, oneObject: boolean): boolean {
    const [before, after] = [said.before ?? [], said.after ?? []];
    const bothSay = said.before !== undefined && said.after !== undefined;
    // A name of the text, on both sides: a value is its type's, and its type is named as the after side names it.
    const keyOf = (entry: ExpressionName, type: string | undefined): string => `${entry.kind}\u0000${entry.name}\u0000${type ?? ""}`;
    const names = new Map<string, { before?: ExpressionName; after?: ExpressionName }>();
    for (const entry of before) {
      names.set(keyOf(entry, entry.type === undefined ? undefined : this.enumName(entry.type)), { before: entry });
    }
    for (const entry of after) {
      const key = keyOf(entry, entry.type);
      names.set(key, { ...names.get(key), after: entry });
    }
    for (const { before: was, after: is } of names.values()) {
      const entry = (was ?? is) as ExpressionName;
      const [nameBefore, nameAfter] = [was?.now ?? entry.name, is?.now ?? entry.name];
      const called = this.#called(entry.kind, nameBefore, table, was?.type ?? (is?.type === undefined ? undefined : this.#enumNameBefore(is.type)));
      // What the diff does not know (a function, a type that is not enumerated) is listed only when it was renamed: one side may well say nothing of it.
      if (called === null ? !oneObject && nameBefore !== nameAfter : called !== nameAfter || (bothSay && (was === undefined || is === undefined))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether a text that both sides have says the same on both (see the head
   * of this file). `table`: the before side's name of the table whose
   * columns the text can name; a default names none. `oneObject`: the two
   * texts are one object's.
   */
  sameMeaning(table: string | undefined, before: TextNames, after: TextNames, oneObject: boolean): boolean {
    const mayBeStale = before.mayBeStale === true || after.mayBeStale === true;
    const known = !mayBeStale && (before.names !== undefined || after.names !== undefined);
    const said = { before: before.names, after: after.names };
    if (oneObject) {
      return !known || this.#namesLead(table, said, true);
    }
    if (said.before !== undefined && said.after !== undefined) {
      return this.#namesLead(table, said, false);
    }
    // A text of which it is not known what it names is the other side's only where no rename of this diff can reach it.
    if (this.#renamesReach(table)) {
      return false;
    }
    return mayBeStale ? before.mayBeStale === true && after.mayBeStale === true : this.#namesLead(table, said, false);
  }

  enumName(name: string): string {
    return this.enums.get(name) ?? name;
  }

  enumValue(type: string, value: string): string {
    return this.enumValues.get(type)?.get(value) ?? value;
  }

  /** A canonical type of the before side with its enumerated types renamed. */
  canonical(type: CanonicalType): CanonicalType {
    if (type.kind === "enum") {
      return { kind: "enum", name: this.enumName(type.name) };
    }
    if (type.kind === "array") {
      return { kind: "array", element: this.canonical(type.element) };
    }
    return type;
  }

  /**
   * Which table of the after side a table of the before side is: its name
   * there. A table that is dropped is none of them, whatever is called like
   * it afterwards. A name the before side does not have as a table (a table
   * outside the schema) stands for itself.
   */
  tableIdentity(name: string): string {
    return this.droppedTables.has(name) ? `${GONE}${name}` : (this.tables.get(name) ?? name);
  }

  /** As `tableIdentity`, for a column of a table of the before side. */
  columnIdentity(table: string, name: string): string {
    if (this.droppedTables.has(table) || this.droppedColumns.get(table)?.has(name) === true) {
      return `${GONE}${name}`;
    }
    return this.columns.get(table)?.get(name) ?? name;
  }
}

// --- states -----------------------------------------------------------------

/** What a schema says of the text of an expression: what it names, or that it may be stale. */
interface TextNames {
  names?: readonly ExpressionName[] | undefined;
  mayBeStale?: boolean | undefined;
}

/** What a schema says of a text as a state has it: copies, and only what is said. */
function textOf(text: TextNames): { names?: ExpressionName[]; mayBeStale?: true } {
  return text.names !== undefined ? { names: text.names.map(copyExpressionName) } : text.mayBeStale === true ? { mayBeStale: true } : {};
}

/** `sourceClauses` as a state has them: a copy, and nothing for none. */
function clausesOf(clauses: readonly string[] | undefined): { sourceClauses?: string[] } {
  return clauses === undefined || clauses.length === 0 ? {} : { sourceClauses: [...clauses] };
}

function defaultState(column: ColumnSchema): DefaultState | undefined {
  if (column.autoIncrement === true || column.generated === "increment") {
    return { kind: "increment" };
  }
  // The text of the default, when it has one, with what a rename has left of it.
  const text = column.defaultExpression === undefined ? {} : { expression: column.defaultExpression, ...textOf({ names: column.defaultNames, mayBeStale: column.defaultMayBeStale }) };
  if (column.defaultFunction !== undefined) {
    return { kind: "function", function: column.defaultFunction, ...text };
  }
  // A default of null is no default.
  if (column.default !== undefined && column.default !== null) {
    return { kind: "value", value: structuredClone(column.default) };
  }
  if (column.generated !== undefined) {
    return { kind: "generated", strategy: column.generated, ...text };
  }
  if (column.defaultExpression !== undefined) {
    return { kind: "expression", expression: column.defaultExpression, ...textOf({ names: column.defaultNames, mayBeStale: column.defaultMayBeStale }) };
  }
  return undefined;
}

/** What makes two defaults the same: their canonical meaning, not their spelling. */
function defaultKey(state: DefaultState | undefined): string {
  if (state === undefined) {
    return "";
  }
  switch (state.kind) {
    case "value":
      return `value:${stableStringify(state.value)}`;
    case "function":
      return `function:${state.function}`;
    case "increment":
      return "increment";
    case "generated":
      return `generated:${state.strategy}:${normalizeSql(state.expression ?? "")}`;
    case "expression":
      return `expression:${normalizeSql(state.expression)}`;
  }
}

/** The enumerated type a column takes its values from, by name, however the schema says it. */
function enumOf(column: ColumnSchema): string | undefined {
  return column.enum?.name ?? (column.canonicalType?.kind === "enum" ? column.canonicalType.name : undefined);
}

function typeState(column: ColumnSchema): TypeState {
  return {
    storage: column.type,
    ...(column.canonicalType !== undefined && { canonical: copyCanonicalType(column.canonicalType) }),
    ...(column.declaredType !== undefined && { declared: column.declaredType }),
    ...(column.canonicalType === undefined && column.enum !== undefined && { enum: column.enum.name }),
  };
}

function columnState(column: ColumnSchema): ColumnState {
  const fallback = defaultState(column);
  return {
    name: column.name,
    type: typeState(column),
    nullable: column.nullable,
    ...(fallback !== undefined && { default: fallback }),
    ...(column.origin !== undefined && { origin: copyOrigin(column.origin) }),
  };
}

/*
 * A change to a column that stays (its type, its default) stands after the
 * renames. What it says the column was is therefore written in the names the
 * after side has: an enumerated type and a value that were renamed have
 * their new names there. (Spellings and expressions are text of the source,
 * and stay.)
 */

function typeStateAfterRenames(renames: Renames, column: ColumnSchema): TypeState {
  const state = typeState(column);
  return {
    ...state,
    ...(state.canonical !== undefined && { canonical: renames.canonical(state.canonical) }),
    ...(state.enum !== undefined && { enum: renames.enumName(state.enum) }),
  };
}

/**
 * The before side's default as the after side names things: one that is a
 * renamed value of the column's enumerated type is that value as it is
 * called now, and what its text names is called what it is called now.
 */
function defaultStateAfterRenames(renames: Renames, column: ColumnSchema): DefaultState | undefined {
  const state = defaultState(column);
  const type = enumOf(column);
  if (state === undefined || state.kind === "increment") {
    return state;
  }
  if (state.kind !== "value") {
    return state.names === undefined ? state : { ...state, names: renames.namesAfter(state.names) };
  }
  return typeof state.value !== "string" || type === undefined ? state : { kind: "value", value: renames.enumValue(type, state.value) };
}

interface PrimaryKey extends ObjectProvenance {
  name?: string;
  columns: string[];
  include?: string[];
  deferrable?: Deferrable;
  sourceClauses?: string[];
  /** The source gave the order of the key's columns (a `PrimaryKeyConstraint`). */
  ordered: boolean;
}

/** What a key or a constraint is beyond its columns, as a state has it: only what says something, and what is carried along in one order. */
function keyParts(key: { include?: readonly string[] | undefined; deferrable?: Deferrable | undefined; sourceClauses?: readonly string[] | undefined }): { include?: string[]; deferrable?: Deferrable; sourceClauses?: string[] } {
  return {
    ...(key.include !== undefined && key.include.length > 0 && { include: [...key.include] }),
    ...(key.deferrable !== undefined && { deferrable: key.deferrable }),
    ...clausesOf(key.sourceClauses),
  };
}

/** What a key or a constraint is beyond its columns, as one text: two that differ in it are two. `columnsOf`: the names of the after side for those of the before side. */
function partsSignature(key: { include?: readonly string[] | undefined; deferrable?: Deferrable | undefined; nullsNotDistinct?: boolean | undefined; sourceClauses?: readonly string[] | undefined }, columnsOf: (names: readonly string[]) => string[] = (names) => [...names]): unknown[] {
  // What an index carries along is not ordered.
  return [columnsOf(key.include ?? []).sort(compareText), key.deferrable ?? null, key.nullsNotDistinct === true, [...(key.sourceClauses ?? [])]];
}

function primaryKeyOf(table: TableSchema): PrimaryKey | undefined {
  if (table.primaryKey !== undefined) {
    return { ...table.primaryKey, columns: [...table.primaryKey.columns], ordered: true };
  }
  const columns = table.columns.filter((column) => column.primary).map((column) => column.name);
  return columns.length === 0 ? undefined : { columns, ordered: false };
}

function primaryKeyState(key: PrimaryKey): PrimaryKeyState {
  return { ...(key.name !== undefined && { name: key.name }), columns: [...key.columns], ...keyParts(key), ...(key.origin !== undefined && { origin: copyOrigin(key.origin) }) };
}

interface ForeignKey extends ObjectProvenance {
  name?: string;
  columns: string[];
  table: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
  deferrable?: Deferrable;
  sourceClauses?: string[];
}

/** A table's foreign keys, of one column (a column's `references`) and of several, in one list. */
function foreignKeysOf(table: TableSchema): ForeignKey[] {
  const single = table.columns.flatMap((column): ForeignKey[] =>
    column.references === undefined
      ? []
      : [
          {
            ...(column.references.name !== undefined && { name: column.references.name }),
            columns: [column.name],
            table: column.references.table,
            refColumns: [column.references.column],
            onDelete: normalizeAction(column.references.onDelete),
            onUpdate: normalizeAction(column.references.onUpdate),
            ...keyParts(column.references),
            ...(column.references.origin !== undefined && { origin: column.references.origin }),
            ...(column.references.renames !== undefined && { renames: column.references.renames }),
          },
        ],
  );
  const several = (table.foreignKeys ?? []).map(
    (key): ForeignKey => ({
      ...(key.name !== undefined && { name: key.name }),
      columns: [...key.columns],
      table: key.references.table,
      refColumns: [...key.references.columns],
      onDelete: normalizeAction(key.onDelete),
      onUpdate: normalizeAction(key.onUpdate),
      ...keyParts(key),
      ...(key.origin !== undefined && { origin: key.origin }),
      ...(key.renames !== undefined && { renames: key.renames }),
    }),
  );
  return [...single, ...several];
}

function foreignKeyState(key: ForeignKey): ForeignKeyState {
  return {
    ...(key.name !== undefined && { name: key.name }),
    columns: [...key.columns],
    references: { table: key.table, columns: [...key.refColumns] },
    onDelete: key.onDelete,
    onUpdate: key.onUpdate,
    ...keyParts(key),
    ...(key.origin !== undefined && { origin: copyOrigin(key.origin) }),
  };
}

function uniqueState(unique: UniqueConstraint): UniqueState {
  const { include, deferrable, sourceClauses } = keyParts(unique);
  return {
    ...(unique.name !== undefined && { name: unique.name }),
    columns: [...unique.columns],
    ...(include !== undefined && { include }),
    ...(deferrable !== undefined && { deferrable }),
    ...(unique.nullsNotDistinct === true && { nullsNotDistinct: true as const }),
    ...(sourceClauses !== undefined && { sourceClauses }),
    ...(unique.origin !== undefined && { origin: copyOrigin(unique.origin) }),
  };
}

function checkState(check: CheckConstraint): CheckState {
  return {
    ...(check.name !== undefined && { name: check.name }),
    expression: check.expression,
    ...textOf(check),
    ...clausesOf(check.sourceClauses),
    ...(check.origin !== undefined && { origin: copyOrigin(check.origin) }),
  };
}

function indexState(index: IndexDefinition): IndexState {
  return {
    name: index.name,
    columns: [...index.columns],
    ...(index.expressions !== undefined && index.expressions.length > 0 && { expressions: [...index.expressions] }),
    unique: index.unique === true,
    ...(index.where !== undefined && { where: index.where }),
    ...(index.method !== undefined && { method: index.method }),
    ...(index.keys !== undefined && { keys: index.keys.map(copyIndexKey) }),
    ...(index.include !== undefined && index.include.length > 0 && { include: [...index.include] }),
    ...(index.nullsNotDistinct === true && { nullsNotDistinct: true as const }),
    ...((index.expressions ?? []).length > 0 || index.where !== undefined ? textOf(index) : {}),
    ...clausesOf(index.sourceClauses),
    ...(index.origin !== undefined && { origin: copyOrigin(index.origin) }),
  };
}

function enumState(type: EnumType): EnumState {
  return { name: type.name, values: [...type.values], ...(type.origin !== undefined && { origin: copyOrigin(type.origin) }) };
}

type Columns = (names: readonly string[]) => string[];
const asTheyAre: Columns = (names) => [...names];

/*
 * What an object is, apart from its name, as one text: two objects with one
 * signature are the same object as far as a schema says. `columnsOf` gives
 * the names the after side has for the columns of an object of the before
 * side. An object that says nothing beyond its columns has the signature it
 * always had.
 */
const uniqueSignature = (unique: { columns: readonly string[]; include?: readonly string[]; deferrable?: Deferrable; nullsNotDistinct?: boolean; sourceClauses?: readonly string[] }, columnsOf: Columns = asTheyAre): string => {
  const parts = partsSignature(unique, columnsOf);
  return JSON.stringify(stableStringify(parts) === PLAIN_PARTS ? columnsOf(unique.columns) : [columnsOf(unique.columns), ...parts]);
};
const foreignKeySignature = (key: { columns: readonly string[]; table: string; refColumns: readonly string[]; onDelete: string; onUpdate: string; deferrable?: Deferrable; sourceClauses?: readonly string[] }): string => {
  const parts = partsSignature(key);
  return JSON.stringify([key.columns, key.table, key.refColumns, key.onDelete, key.onUpdate, ...(stableStringify(parts) === PLAIN_PARTS ? [] : parts)]);
};
const checkSignature = (check: { expression: string; sourceClauses?: readonly string[] }): string =>
  (check.sourceClauses ?? []).length === 0 ? normalizeSql(check.expression) : JSON.stringify([normalizeSql(check.expression), check.sourceClauses]);
const indexSignature = (index: IndexDefinition, columnsOf: Columns = asTheyAre): string => {
  const keys = indexKeys(index);
  const expressions = (index.expressions ?? []).map(normalizeSql);
  const where = index.where === undefined ? null : normalizeSql(index.where);
  const parts = partsSignature(index, columnsOf);
  // An index over columns alone or over expressions alone, each key as it is by itself: said as it always was.
  if (index.keys === undefined && index.method === undefined && stableStringify(parts) === PLAIN_PARTS) {
    return JSON.stringify([index.unique === true, columnsOf(index.columns), expressions, where]);
  }
  // The keys in their order, each with what it says of itself; `null` for an index that does not say where its columns and expressions stand.
  const keyed =
    keys === undefined
      ? null
      : keys.map((key) => [key.column === undefined ? null : columnsOf([key.column])[0], key.expression === undefined ? null : normalizeSql(key.expression), key.order ?? null, key.nulls ?? null, key.operatorClass ?? null, key.collation ?? null]);
  return JSON.stringify([index.unique === true, columnsOf(index.columns), expressions, where, index.method ?? null, keyed, ...parts]);
};
/** `partsSignature` of an object that says nothing beyond its columns. */
const PLAIN_PARTS = stableStringify([[], null, false, []]);

/** States in one order, whatever order they were listed in: by name, by what they are, and, for two that are alike, by all they say. */
function sortedStates<T extends { name?: string }>(states: T[], signature: (state: T) => string): T[] {
  const keyOf = (state: T): string => `${state.name ?? ""}\u0000${signature(state)}\u0000${stableStringify(state)}`;
  return [...states].sort((a, b) => compareText(keyOf(a), keyOf(b)));
}

/**
 * A table as a change describes it, in its own side's names. Its foreign
 * keys and indexes are listed for a table that is dropped; those of an added
 * table are changes of their own.
 */
function tableState(table: TableSchema, withDependents: boolean): TableState {
  const key = primaryKeyOf(table);
  const uniques = sortedStates((table.uniques ?? []).map(uniqueState), (state) => uniqueSignature(state));
  const checks = sortedStates((table.checks ?? []).map(checkState), (state) => checkSignature(state));
  return {
    name: table.name,
    columns: table.columns.map(columnState),
    ...(key !== undefined && { primaryKey: primaryKeyState(key) }),
    uniques,
    checks,
    ...(withDependents && {
      foreignKeys: sortedStates(foreignKeysOf(table).map(foreignKeyState), (state) => foreignKeySignature({ ...state, table: state.references.table, refColumns: state.references.columns })),
      indexes: sortedStates((table.indexes ?? []).map(indexState), (state) => indexSignature(state)),
    }),
    ...(table.origin !== undefined && { origin: copyOrigin(table.origin) }),
  };
}

// --- the diff -----------------------------------------------------------------

interface Pending {
  change: SchemaChange;
  group: string;
  item: string;
  sequence: number;
  /** The change as text: the last thing two changes are ordered by. */
  text?: string;
}

const RANK = new Map<string, number>(CHANGE_ORDER.map((op, index) => [op, index]));

class DiffBuilder {
  readonly #pending: Pending[] = [];
  readonly renames = new Renames();

  /** `group` is the table or type a change is listed under, `item` the object within it. */
  add(change: SchemaChange, group: string, item = "", sequence = 0): void {
    this.#pending.push({ change, group, item, sequence });
  }

  result(): SchemaDiff {
    const textOf = (entry: Pending): string => (entry.text ??= stableStringify(entry.change));
    const ordered = [...this.#pending].sort(
      (a, b) =>
        (RANK.get(a.change.op) as number) - (RANK.get(b.change.op) as number) ||
        compareText(a.group, b.group) ||
        compareText(a.item, b.item) ||
        a.sequence - b.sequence ||
        // Two changes that are alike so far are ordered by all they say, never by the order they were found in.
        compareText(textOf(a), textOf(b)),
    );
    return { diffVersion: SCHEMA_DIFF_VERSION, changes: ordered.map((entry) => entry.change) };
  }
}

function diffEnums(builder: DiffBuilder, before: readonly EnumType[], after: readonly EnumType[]): void {
  for (const type of before) {
    builder.renames.valuesBefore.set(type.name, type.values);
  }
  // A type can only be dropped after the renames (its columns have to be given another type first), so a name it still has cannot be taken by a rename.
  const matching = match(before, after, { takeovers: false });
  for (const { before: a, after: b, evidence } of matching.pairs) {
    if (evidence !== undefined) {
      builder.renames.enums.set(a.name, b.name);
      builder.add({ op: "renameEnumType", enum: b.name, from: a.name, evidence }, b.name);
    }
    diffEnumValues(builder, a, b);
  }
  for (const type of matching.added) {
    builder.add({ op: "addEnumType", enum: type.name, after: enumState(type) }, type.name);
  }
  for (const type of matching.removed) {
    builder.add({ op: "dropEnumType", enum: type.name, before: enumState(type) }, type.name);
  }
}

/**
 * The values of one enumerated type. Values are renamed only on evidence:
 * both sides are the same type, the before side's value renames are the
 * start of the after side's, and the rest of those lead from values of the
 * before side to values of the after side. Renames that lead anywhere else
 * (to a value that is there already, or to one the after side does not have)
 * do not hang together with the two schemas, and are no evidence at all.
 */
function diffEnumValues(builder: DiffBuilder, before: EnumType, after: EnumType): void {
  /** The before side's values, as the after side names them. */
  let working = [...before.values];
  /** For each value of `working` that was renamed: the before side's name of it, and the renames since. */
  let renamed = new Map<string, { original: string; history: SchemaRename[] }>();
  const known = before.valueRenames ?? [];
  const all = after.valueRenames ?? [];
  const sameType = before.origin !== undefined && after.origin !== undefined && sameOrigin(before.origin, after.origin);
  if (sameType && known.length <= all.length && known.every((record, index) => sameRename(record, all[index] as SchemaRename))) {
    const replayed = [...working];
    const histories = new Map<string, { original: string; history: SchemaRename[] }>();
    let consistent = true;
    for (const record of all.slice(known.length)) {
      const index = replayed.indexOf(record.from);
      if (index < 0) {
        // A value that came after the before side, and was renamed since.
        continue;
      }
      if (replayed.includes(record.to)) {
        consistent = false;
        break;
      }
      const earlier = histories.get(record.from) ?? { original: record.from, history: [] };
      histories.delete(record.from);
      histories.set(record.to, { original: earlier.original, history: [...earlier.history, record] });
      replayed[index] = record.to;
    }
    if (consistent && [...histories.keys()].every((value) => after.values.includes(value))) {
      working = replayed;
      renamed = histories;
    }
  }
  const valueRenames = new Map<string, string>();
  for (const [current, { original, history }] of renamed) {
    if (current !== original && after.origin !== undefined) {
      valueRenames.set(original, current);
      builder.add({ op: "renameEnumValue", enum: after.name, from: original, to: current, evidence: { origin: copyOrigin(after.origin), renames: structuredClone(history) } }, after.name, original);
    }
  }
  builder.renames.enumValues.set(before.name, valueRenames);

  const removed = working.filter((value) => !after.values.includes(value));
  const surviving = working.filter((value) => after.values.includes(value));
  const inAfterOrder = after.values.filter((value) => surviving.includes(value));
  if (surviving.some((value, index) => value !== inAfterOrder[index])) {
    builder.add({ op: "replaceEnumValues", enum: after.name, before: working, after: [...after.values] }, after.name);
    return;
  }
  for (const value of removed) {
    builder.add({ op: "removeEnumValue", enum: after.name, value }, after.name, value);
  }
  const present = new Set(surviving);
  for (const [position, value] of after.values.entries()) {
    if (present.has(value)) {
      continue;
    }
    const previous = after.values[position - 1];
    const next = after.values.slice(position + 1).find((candidate) => present.has(candidate));
    builder.add(
      { op: "addEnumValue", enum: after.name, value, ...(previous !== undefined ? { afterValue: previous } : next !== undefined ? { beforeValue: next } : {}) },
      after.name,
      "",
      position,
    );
    present.add(value);
  }
}

function sameTypes(builder: DiffBuilder, before: ColumnSchema, after: ColumnSchema): { same: boolean; comparedBy: "canonical" | "declared" } {
  if (before.canonicalType !== undefined && after.canonicalType !== undefined) {
    return { same: canonicalTypeKey(builder.renames.canonical(before.canonicalType)) === canonicalTypeKey(after.canonicalType), comparedBy: "canonical" };
  }
  const declared = (column: ColumnSchema): string => (column.declaredType ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const enumBefore = enumOf(before);
  return { same: before.type === after.type && declared(before) === declared(after) && (enumBefore === undefined ? undefined : builder.renames.enumName(enumBefore)) === enumOf(after), comparedBy: "declared" };
}

/** The changes of a column that both sides have. They stand after the renames: `table` and the column are named as the after side names them. */
function diffColumns(builder: DiffBuilder, table: string, before: ColumnSchema, after: ColumnSchema): void {
  const types = sameTypes(builder, before, after);
  if (!types.same) {
    builder.add({ op: "alterColumnType", table, column: after.name, before: typeStateAfterRenames(builder.renames, before), after: typeState(after), comparedBy: types.comparedBy }, table, after.name);
  }
  if (before.nullable !== after.nullable) {
    builder.add(after.nullable ? { op: "dropNotNull", table, column: after.name } : { op: "setNotNull", table, column: after.name }, table, after.name);
  }
  const defaultBefore = defaultStateAfterRenames(builder.renames, before);
  const defaultAfter = defaultState(after);
  // A default that is compared by its text: whether the text says the same on both sides. It names no column, and has no object of its own.
  const byText = defaultAfter !== undefined && (defaultAfter.kind === "expression" || (defaultAfter.kind === "generated" && defaultAfter.expression !== undefined));
  const sameDefault =
    defaultKey(defaultBefore) === defaultKey(defaultAfter) &&
    (!byText || builder.renames.sameMeaning(undefined, { names: before.defaultNames, mayBeStale: before.defaultMayBeStale }, { names: after.defaultNames, mayBeStale: after.defaultMayBeStale }, false));
  if (!sameDefault) {
    if (defaultAfter === undefined) {
      builder.add({ op: "dropDefault", table, column: after.name, before: defaultBefore as DefaultState }, table, after.name);
    } else {
      builder.add({ op: "setDefault", table, column: after.name, ...(defaultBefore !== undefined && { before: defaultBefore }), after: defaultAfter }, table, after.name);
    }
  }
}

function sameKeyColumns(a: PrimaryKey, b: PrimaryKey): boolean {
  if (a.columns.length !== b.columns.length || stableStringify(partsSignature(a)) !== stableStringify(partsSignature(b))) {
    return false;
  }
  return a.ordered && b.ordered ? a.columns.every((name, index) => name === b.columns[index]) : a.columns.every((name) => b.columns.includes(name));
}

function diffPrimaryKeys(builder: DiffBuilder, beforeTable: TableSchema, afterTable: TableSchema): void {
  const before = primaryKeyOf(beforeTable);
  const after = primaryKeyOf(afterTable);
  if (before === undefined && after === undefined) {
    return;
  }
  const drop = (): void => {
    const state = primaryKeyState(before as PrimaryKey);
    builder.add({ op: "dropPrimaryKey", table: beforeTable.name, ...(state.name !== undefined && { constraint: state.name }), before: state }, beforeTable.name, state.name ?? "");
  };
  const add = (): void => {
    const state = primaryKeyState(after as PrimaryKey);
    builder.add({ op: "addPrimaryKey", table: afterTable.name, ...(state.name !== undefined && { constraint: state.name }), after: state }, afterTable.name, state.name ?? "");
  };
  if (before === undefined) {
    return add();
  }
  if (after === undefined) {
    return drop();
  }
  // The before side's key over the columns as the after side has them: a column that is dropped is not the one that takes its name.
  const identities = (names: readonly string[] | undefined): string[] => (names ?? []).map((name) => builder.renames.columnIdentity(beforeTable.name, name));
  const sameColumns = sameKeyColumns({ ...before, columns: identities(before.columns), ...(before.include !== undefined && { include: identities(before.include) }) }, after);
  if (before.name !== undefined && after.name !== undefined && before.name !== after.name) {
    const evidence = renameEvidence(before as Named, after as Named);
    if (evidence !== undefined && sameColumns) {
      builder.add({ op: "renameConstraint", table: afterTable.name, kind: "primaryKey", constraint: after.name, from: before.name, evidence }, afterTable.name, after.name);
      return;
    }
    drop();
    add();
    return;
  }
  if (!sameColumns) {
    drop();
    add();
  }
}

/**
 * Constraints and indexes of one kind on a pair of tables. One that goes is
 * described as the before side has it, under the before side's table name:
 * it stands before the renames. One that comes, and a rename, are under the
 * after side's.
 */
function diffNamedObjects<T extends ObjectProvenance & { name?: string }, S extends { name?: string }>(
  builder: DiffBuilder,
  tables: { before: string; after: string },
  before: readonly T[],
  after: readonly T[],
  signature: Signatures<T>,
  handlers: {
    state: (item: T) => S;
    drop: (table: string, state: S) => SchemaChange;
    add: (table: string, state: S) => SchemaChange;
    rename: (table: string, from: string, to: string, evidence: RenameEvidence) => SchemaChange;
    /** For objects that can have expressions: what the schema says of one's text, when it has one. */
    texts?: (item: T) => TextNames | undefined;
  },
): void {
  const matching = match(before, after, { signature });
  const drop = (item: T): void => builder.add(handlers.drop(tables.before, handlers.state(item)), tables.before, item.name ?? signature.after(item));
  const add = (item: T): void => builder.add(handlers.add(tables.after, handlers.state(item)), tables.after, item.name ?? signature.after(item));
  /** Whether the texts of two objects that read alike say the same: see `Renames.sameMeaning`. */
  const textsCompare = (a: T, b: T): boolean => {
    const [textsBefore, textsAfter] = [handlers.texts?.(a), handlers.texts?.(b)];
    return textsBefore === undefined || textsAfter === undefined || builder.renames.sameMeaning(tables.before, textsBefore, textsAfter, a.origin !== undefined && b.origin !== undefined && sameOrigin(a.origin, b.origin));
  };
  for (const { before: a, after: b, evidence } of matching.pairs) {
    if (signature.before(a) !== signature.after(b) || !textsCompare(a, b)) {
      drop(a);
      add(b);
    } else if (evidence !== undefined && a.name !== undefined && b.name !== undefined) {
      builder.add(handlers.rename(tables.after, a.name, b.name, evidence), tables.after, b.name);
    }
  }
  matching.removed.forEach(drop);
  matching.added.forEach(add);
}

function diffTableContents(builder: DiffBuilder, before: TableSchema, after: TableSchema): void {
  const tables = { before: before.name, after: after.name };
  const renames = builder.renames;
  const columnsOf = (names: readonly string[]): string[] => names.map((name) => renames.columnIdentity(before.name, name));

  diffPrimaryKeys(builder, before, after);

  diffNamedObjects(
    builder,
    tables,
    before.uniques ?? [],
    after.uniques ?? [],
    { before: (unique) => uniqueSignature(unique, columnsOf), after: (unique) => uniqueSignature(unique) },
    {
      state: uniqueState,
      drop: (table, state) => ({ op: "dropUnique", table, ...(state.name !== undefined && { constraint: state.name }), before: state }),
      add: (table, state) => ({ op: "addUnique", table, ...(state.name !== undefined && { constraint: state.name }), after: state }),
      rename: (table, from, to, evidence) => ({ op: "renameConstraint", table, kind: "unique" as ConstraintKind, constraint: to, from, evidence }),
    },
  );

  diffNamedObjects(
    builder,
    tables,
    foreignKeysOf(before),
    foreignKeysOf(after),
    {
      before: (key) =>
        foreignKeySignature({ ...key, columns: columnsOf(key.columns), table: renames.tableIdentity(key.table), refColumns: key.refColumns.map((name) => renames.columnIdentity(key.table, name)) }),
      after: foreignKeySignature,
    },
    {
      state: foreignKeyState,
      drop: (table, state) => ({ op: "dropForeignKey", table, ...(state.name !== undefined && { constraint: state.name }), before: state }),
      add: (table, state) => ({ op: "addForeignKey", table, ...(state.name !== undefined && { constraint: state.name }), after: state }),
      rename: (table, from, to, evidence) => ({ op: "renameConstraint", table, kind: "foreignKey" as ConstraintKind, constraint: to, from, evidence }),
    },
  );

  diffNamedObjects(
    builder,
    tables,
    before.checks ?? [],
    after.checks ?? [],
    { before: checkSignature, after: checkSignature },
    {
      texts: (check) => check,
      state: checkState,
      drop: (table, state) => ({ op: "dropCheck", table, ...(state.name !== undefined && { constraint: state.name }), before: state }),
      add: (table, state) => ({ op: "addCheck", table, ...(state.name !== undefined && { constraint: state.name }), after: state }),
      rename: (table, from, to, evidence) => ({ op: "renameConstraint", table, kind: "check" as ConstraintKind, constraint: to, from, evidence }),
    },
  );

  diffNamedObjects(
    builder,
    tables,
    before.indexes ?? [],
    after.indexes ?? [],
    { before: (index) => indexSignature(index, columnsOf), after: (index) => indexSignature(index) },
    {
      texts: (index) => ((index.expressions ?? []).length > 0 || index.where !== undefined ? index : undefined),
      state: indexState,
      drop: (table, state) => ({ op: "dropIndex", table, index: state.name as string, before: state }),
      add: (table, state) => ({ op: "addIndex", table, index: state.name as string, after: state }),
      rename: (table, from, to, evidence) => ({ op: "renameIndex", table, index: to, from, evidence }),
    },
  );
}

function addTable(builder: DiffBuilder, table: TableSchema): void {
  builder.add({ op: "addTable", table: table.name, after: tableState(table, false) }, table.name);
  for (const key of foreignKeysOf(table)) {
    const state = foreignKeyState(key);
    builder.add({ op: "addForeignKey", table: table.name, ...(state.name !== undefined && { constraint: state.name }), after: state }, table.name, state.name ?? foreignKeySignature(key));
  }
  for (const index of table.indexes ?? []) {
    builder.add({ op: "addIndex", table: table.name, index: index.name, after: indexState(index) }, table.name, index.name);
  }
}

/**
 * The enumerated types of a schema: those it lists, and those that only its
 * columns give (a schema made in code may put the values on its columns and
 * list no types). A type the schema lists is the type; a column does not
 * define it a second time. Of columns that disagree, the first by table and
 * column name is taken.
 */
function enumTypesOf(schema: DatabaseSchema): EnumType[] {
  const types = new Map(schema.types.enums.map((type) => [type.name, type]));
  const given = schema.tables
    .flatMap((table) => table.columns.flatMap((column) => (column.enum === undefined ? [] : [{ place: `${table.name}\u0000${column.name}`, type: column.enum }])))
    .sort((a, b) => compareText(a.place, b.place));
  for (const { type } of given) {
    if (!types.has(type.name)) {
      types.set(type.name, { name: type.name, values: [...type.values] });
    }
  }
  return [...types.values()];
}

/** What differs between two canonical schemas, as the diff IR. */
export function diffSchemas(before: DatabaseSchema, after: DatabaseSchema): SchemaDiff {
  const builder = new DiffBuilder();
  const renames = builder.renames;
  diffEnums(builder, enumTypesOf(before), enumTypesOf(after));

  const tables = match(before.tables, after.tables);
  for (const { before: a, after: b, evidence } of tables.pairs) {
    renames.tables.set(a.name, b.name);
    if (evidence !== undefined) {
      builder.add({ op: "renameTable", table: b.name, from: a.name, evidence }, b.name);
    }
  }
  for (const table of tables.removed) {
    renames.droppedTables.add(table.name);
  }
  // Every column pair is known before any constraint is compared: a foreign key may refer to a renamed or dropped column of another table.
  const columnMatchings = tables.pairs.map((pair) => {
    const columns = match(pair.before.columns, pair.after.columns);
    renames.columns.set(pair.before.name, new Map(columns.pairs.map(({ before: a, after: b }) => [a.name, b.name])));
    renames.droppedColumns.set(pair.before.name, new Set(columns.removed.map((column) => column.name)));
    return { pair, columns };
  });
  for (const { pair, columns } of columnMatchings) {
    const table = pair.after.name;
    for (const { before: a, after: b, evidence } of columns.pairs) {
      if (evidence !== undefined) {
        builder.add({ op: "renameColumn", table, column: b.name, from: a.name, evidence }, table, b.name);
      }
      diffColumns(builder, table, a, b);
    }
    for (const column of columns.added) {
      builder.add({ op: "addColumn", table, column: column.name, after: columnState(column) }, table, column.name);
    }
    for (const column of columns.removed) {
      // Before the renames: the table still has the before side's name.
      builder.add({ op: "dropColumn", table: pair.before.name, column: column.name, before: columnState(column) }, pair.before.name, column.name);
    }
    diffTableContents(builder, pair.before, pair.after);
  }
  for (const table of tables.added) {
    addTable(builder, table);
  }
  for (const table of tables.removed) {
    builder.add({ op: "dropTable", table: table.name, before: tableState(table, true) }, table.name);
  }
  return builder.result();
}

/** The diff as JSON text: the same two schemas always give the same bytes. */
export function stringifySchemaDiff(diff: SchemaDiff, indent = 2): string {
  return stableStringify(diff, indent);
}
