import type { CanonicalType, ColumnType, DefaultFunction, Deferrable, ExpressionName, IndexKey, SchemaOrigin, SchemaRename } from "../../runtime/src/index.ts";

/*
 * The schema diff IR (D-037): what differs between two canonical schemas, as
 * data. It says what changed, not how to change it: no SQL, no dialect. A
 * migration generator (a later phase) reads it.
 *
 * A change names things as they are called where it stands in the list
 * (`CHANGE_ORDER`), and the list has three parts:
 *
 * 1. What goes: keys, constraints, and indexes, then columns and tables.
 *    Nothing is renamed yet, so these changes, and what they say the object
 *    was (`before`), use the before side's names throughout.
 * 2. The renames.
 * 3. What comes and what changes. These use the after side's names, also in
 *    what they say a column was before (`before` of a changed type or
 *    default): a renamed enumerated type or value has its new name there.
 *    Enumerated types and values go here too, at the end: a type can only be
 *    dropped once no column has it.
 *
 * So a name is never two things at one place of the list: a column that is
 * dropped is gone before another column is renamed to its name.
 *
 * Only text of the source is left as it was written: declared spellings and
 * expressions.
 *
 * Serialized with `stringifySchemaDiff`, a diff is byte-stable: the same two
 * schemas give the same text, whatever order their tables, constraints,
 * indexes, and types were listed in.
 */

export const SCHEMA_DIFF_VERSION = 1;

export interface SchemaDiff {
  diffVersion: typeof SCHEMA_DIFF_VERSION;
  changes: SchemaChange[];
}

/**
 * Why a rename is a rename: both sides are the same object (the same
 * `origin`: created by the same statement of the same file, under the same
 * name), the renames the before side records are the start of those the
 * after side records, and the rest lead from the before side's name to the
 * after side's. Without all of it, a different name is a drop and an add.
 */
export interface RenameEvidence {
  origin: SchemaOrigin;
  /** The renames the after side records beyond the before side's: from the one name to the other, oldest first. */
  renames: SchemaRename[];
}

/** A column's type, as the diff compared it. */
export interface TypeState {
  /** How the runtime stores the values. */
  storage: ColumnType;
  canonical?: CanonicalType;
  /** As the source wrote it. */
  declared?: string;
  /** The enumerated type, when the column takes one and has no canonical type. */
  enum?: string;
}

/**
 * A column's default, by its canonical meaning (D-033, D-034):
 * - `value`: a constant.
 * - `function`: computed at the write (`current_timestamp`, `current_date`); `expression` is how the source wrote it.
 * - `increment`: the next number (serial, identity, auto-increment).
 * - `generated`: another value the source's database makes (`uuid`), not computed locally.
 * - `expression`: another expression of the source, kept as text.
 *
 * `names`: what `expression` names, with what each of those things is
 * called now (`ExpressionName`, D-040); a text that is stale by a name is
 * not what the database has. `mayBeStale`: the schema does not say what the
 * text names, and a rename may have reached it.
 */
export type DefaultState =
  | { kind: "value"; value: unknown }
  | { kind: "function"; function: DefaultFunction; expression?: string; names?: ExpressionName[]; mayBeStale?: true }
  | { kind: "increment" }
  | { kind: "generated"; strategy: string; expression?: string; names?: ExpressionName[]; mayBeStale?: true }
  | { kind: "expression"; expression: string; names?: ExpressionName[]; mayBeStale?: true };

export interface ColumnState {
  name: string;
  type: TypeState;
  nullable: boolean;
  default?: DefaultState;
  origin?: SchemaOrigin;
}

/**
 * What a key, a constraint, or an index is beyond its columns (D-040). Each
 * is there only when it says something: a constraint that is not deferrable
 * has no `deferrable`.
 *
 * `sourceClauses`: what the source says of the object that the schema has no
 * place for, as text. An object with any is another object than one without,
 * and is not written for a database from this.
 */
export interface PrimaryKeyState {
  name?: string;
  columns: string[];
  /** Columns the key's index carries along. */
  include?: string[];
  deferrable?: Deferrable;
  sourceClauses?: string[];
  origin?: SchemaOrigin;
}

export interface UniqueState {
  name?: string;
  columns: string[];
  include?: string[];
  deferrable?: Deferrable;
  nullsNotDistinct?: true;
  sourceClauses?: string[];
  origin?: SchemaOrigin;
}

/** `NO ACTION` when the source gives none. */
export type ReferentialAction = string;

export interface ForeignKeyState {
  name?: string;
  columns: string[];
  references: { table: string; columns: string[] };
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
  deferrable?: Deferrable;
  sourceClauses?: string[];
  origin?: SchemaOrigin;
}

export interface CheckState {
  name?: string;
  expression: string;
  /** What `expression` names, with what each of those things is called now. */
  names?: ExpressionName[];
  /** The schema does not say what `expression` names, and a rename may have reached it. */
  mayBeStale?: true;
  sourceClauses?: string[];
  origin?: SchemaOrigin;
}

/**
 * An index. `columns` and `expressions` say an index over columns alone or
 * over expressions alone, each key ascending; `keys` is there when they do
 * not say the index: the keys in their order, each with its direction, where
 * its NULLs stand, its operator class, and its collation. With columns and
 * expressions both and no `keys`, the order of the keys is not known.
 */
export interface IndexState {
  name: string;
  columns: string[];
  expressions?: string[];
  unique: boolean;
  where?: string;
  /** How the index is built; absent for a B-tree. */
  method?: string;
  keys?: IndexKey[];
  include?: string[];
  nullsNotDistinct?: true;
  /** What the expressions and `where` name, with what each of those things is called now. */
  names?: ExpressionName[];
  /** The schema does not say what they name, and a rename may have reached them. */
  mayBeStale?: true;
  sourceClauses?: string[];
  origin?: SchemaOrigin;
}

export interface EnumState {
  name: string;
  values: string[];
  origin?: SchemaOrigin;
}

/**
 * A table: its columns in their order, and what `CREATE TABLE` makes with it.
 * Its foreign keys and indexes are changes of their own when a table is
 * added (`addForeignKey`, `addIndex`), and listed here only for a dropped one.
 */
export interface TableState {
  name: string;
  columns: ColumnState[];
  primaryKey?: PrimaryKeyState;
  uniques: UniqueState[];
  checks: CheckState[];
  foreignKeys?: ForeignKeyState[];
  indexes?: IndexState[];
  origin?: SchemaOrigin;
}

export type ConstraintKind = "primaryKey" | "unique" | "foreignKey" | "check";

export type SchemaChange =
  // 1. What goes, in the before side's names.
  | { op: "dropForeignKey"; table: string; constraint?: string; before: ForeignKeyState }
  | { op: "dropCheck"; table: string; constraint?: string; before: CheckState }
  | { op: "dropUnique"; table: string; constraint?: string; before: UniqueState }
  | { op: "dropIndex"; table: string; index: string; before: IndexState }
  | { op: "dropPrimaryKey"; table: string; constraint?: string; before: PrimaryKeyState }
  | { op: "dropColumn"; table: string; column: string; before: ColumnState }
  | { op: "dropTable"; table: string; before: TableState }
  // 2. The renames. The object has its new name (`enum`, `table`, `column`, `constraint`, `index`, `to`), and had `from`.
  | { op: "renameEnumType"; enum: string; from: string; evidence: RenameEvidence }
  | { op: "renameEnumValue"; enum: string; from: string; to: string; evidence: RenameEvidence }
  | { op: "renameTable"; table: string; from: string; evidence: RenameEvidence }
  | { op: "renameColumn"; table: string; column: string; from: string; evidence: RenameEvidence }
  | { op: "renameConstraint"; table: string; kind: ConstraintKind; constraint: string; from: string; evidence: RenameEvidence }
  | { op: "renameIndex"; table: string; index: string; from: string; evidence: RenameEvidence }
  // 3. What comes and what changes, in the after side's names.
  | { op: "addEnumType"; enum: string; after: EnumState }
  /** Inserted after `afterValue` or before `beforeValue`; with neither, after whatever values the type has there. */
  | { op: "addEnumValue"; enum: string; value: string; afterValue?: string; beforeValue?: string }
  /** The values of a type in an order that adding and removing values does not give (the type has to be made again). */
  | { op: "replaceEnumValues"; enum: string; before: string[]; after: string[] }
  | { op: "addTable"; table: string; after: TableState }
  | { op: "addColumn"; table: string; column: string; after: ColumnState }
  | { op: "dropDefault"; table: string; column: string; before: DefaultState }
  /** `comparedBy`: `canonical` when both sides have a canonical type; else `declared` (storage type, declared spelling, and enumerated type). */
  | { op: "alterColumnType"; table: string; column: string; before: TypeState; after: TypeState; comparedBy: "canonical" | "declared" }
  | { op: "dropNotNull"; table: string; column: string }
  | { op: "setNotNull"; table: string; column: string }
  | { op: "setDefault"; table: string; column: string; before?: DefaultState; after: DefaultState }
  | { op: "removeEnumValue"; enum: string; value: string }
  | { op: "dropEnumType"; enum: string; before: EnumState }
  | { op: "addPrimaryKey"; table: string; constraint?: string; after: PrimaryKeyState }
  | { op: "addUnique"; table: string; constraint?: string; after: UniqueState }
  | { op: "addCheck"; table: string; constraint?: string; after: CheckState }
  | { op: "addIndex"; table: string; index: string; after: IndexState }
  | { op: "addForeignKey"; table: string; constraint?: string; after: ForeignKeyState };

export type SchemaChangeOp = SchemaChange["op"];

/**
 * The order of the kinds of change in a diff. It is also an order in which
 * the kinds can be carried out:
 *
 * - what goes comes first, each thing after what depends on it: foreign keys
 *   before the keys and tables they refer to, constraints and indexes before
 *   their columns, columns and tables last;
 * - then the renames, when every name that is given up by a drop is free;
 * - then what comes: types before the tables and columns that use them, and
 *   changes of columns;
 * - then the enumerated values and types that go, once no column and no
 *   default has them;
 * - then the new keys, constraints, and indexes, foreign keys after the keys
 *   they refer to.
 *
 * Within a kind, changes are in the order of their names, which is not an
 * order of dependence. That is left to whoever carries a diff out, in three
 * cases: tables that are dropped together and refer to one another (each
 * dropped table's `before` lists its foreign keys); renames of one kind of
 * which one takes the name another gives up (`a` to `b` and `b` to `c`, or
 * `a` to `b` and `b` to `a`, which needs a name in between); and several
 * changes of one enumerated type's values.
 */
export const CHANGE_ORDER = [
  "dropForeignKey",
  "dropCheck",
  "dropUnique",
  "dropIndex",
  "dropPrimaryKey",
  "dropColumn",
  "dropTable",
  "renameEnumType",
  "renameEnumValue",
  "renameTable",
  "renameColumn",
  "renameConstraint",
  "renameIndex",
  "addEnumType",
  "addEnumValue",
  "replaceEnumValues",
  "addTable",
  "addColumn",
  "dropDefault",
  "alterColumnType",
  "dropNotNull",
  "setNotNull",
  "setDefault",
  "removeEnumValue",
  "dropEnumType",
  "addPrimaryKey",
  "addUnique",
  "addCheck",
  "addIndex",
  "addForeignKey",
] as const satisfies readonly SchemaChangeOp[];

type Assert<T extends true> = T;
/** Every kind of change has its place in the order: a kind that `CHANGE_ORDER` leaves out does not compile. */
export type ChangeOrderIsComplete = Assert<SchemaChangeOp extends (typeof CHANGE_ORDER)[number] ? true : false>;
