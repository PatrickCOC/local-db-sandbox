import type { Row } from "../../core/src/index.ts";
import { copyCanonicalType, indexKeyLists, toStoredValue } from "../../runtime/src/index.ts";
import type {
  CanonicalType,
  CheckConstraint,
  ColumnSchema,
  ColumnType,
  DefaultFunction,
  Deferrable,
  EnumType,
  ForeignKeyConstraint,
  IndexDefinition,
  IndexKey,
  SchemaOrigin,
  SchemaRename,
  SchemaTypes,
  SourcePosition,
  ExpressionName,
  TableSchema,
  UniqueConstraint,
} from "../../runtime/src/index.ts";
import { findMigrationsDirectory, readMigrationFiles } from "./migrations.ts";
import type { MigrationFile } from "./migrations.ts";
import { expressionText, parseMigration } from "./parser.ts";
import type { ParsedStatement, PgNode } from "./parser.ts";
import { chooseConstraintName, chooseRelationName, indexColumnNames, nameAddition } from "./pg-names.ts";
import type { Namespace } from "./pg-names.ts";
import { parseArrayLiteral } from "./pg-arrays.ts";
import { POSTGRESQL, columnType } from "./pg-types.ts";
import { shorten } from "./report.ts";
import type { MigrationSummary, ReportCategory, ReportEntry, ReportOutcome } from "./report.ts";

/*
 * Reads a chain of PostgreSQL migrations and works out the schema they leave:
 * the statements are applied, in order, to a model of the schema, much as
 * PostgreSQL applies them to its catalog. The result is the sandbox's
 * canonical schema (`TableSchema[]` and `SchemaTypes`), not a model of
 * PostgreSQL: nothing of PostgreSQL reaches the runtime but what these can
 * say.
 *
 * Only the `public` schema is collected. Statements are recognized by
 * PostgreSQL's own parse tree (parser.ts), never by matching text.
 *
 * Every object of the result carries its provenance (D-036): the statement
 * that created it (`origin`, with the file's SHA-256) and the renames since
 * (`renames`). Objects a statement does not name get the name PostgreSQL
 * would give them (pg-names.ts), marked as generated.
 *
 * What a statement does that the sandbox does not reproduce is reported, a
 * statement at a time (report.ts). A chain that PostgreSQL itself would
 * refuse (a table created twice, a column that is not there) is an error:
 * the schema it would leave is not defined.
 */

/** The `source` of the provenance this collector records. */
export const COLLECTOR_SOURCE = "postgresql-migrations";

export interface SourceLocation {
  file: string;
  line: number;
}

/** Where each table, column, and enumerated type of the result was created (a summary of the origins, for the report). */
export interface SchemaProvenance {
  tables: Record<string, { created: SourceLocation; columns: Record<string, SourceLocation> }>;
  enums: Record<string, SourceLocation>;
}

export interface CollectedSchema {
  /** The migrations directory. */
  directory: string;
  /** The migrations in the order they were applied. */
  migrations: MigrationSummary[];
  /** The tables the migrations leave, as the sandbox defines tables. */
  tables: TableSchema[];
  /** The enumerated types they leave; columns refer to them by name. */
  types: SchemaTypes;
  /** Rows that the migrations insert, by table, as fixture values. */
  seeds: Record<string, Row[]>;
  report: ReportEntry[];
  provenance: SchemaProvenance;
}

export interface CollectOptions {
  /** The time that `now()` in an inserted row stands for. Default: the time of collection. */
  now?: () => Date;
}

/** A chain of migrations that PostgreSQL would refuse, at the statement that it would refuse. */
export class MigrationError extends Error {
  readonly file: string;
  readonly line: number;

  constructor(file: string, line: number, message: string) {
    super(`${file}:${line}: ${message}`);
    this.name = "MigrationError";
    this.file = file;
    this.line = line;
  }
}

interface Tracked {
  name: string;
  origin: SchemaOrigin;
  renames: SchemaRename[];
}

interface ModelColumn extends Tracked {
  type: ColumnType;
  canonical: CanonicalType;
  /** As the migration wrote it. */
  declaredType: string;
  /** As PostgreSQL names it. */
  dialectType: string;
  enumName?: string;
  nullable: boolean;
  /**
   * How PostgreSQL numbers the column, if it does: by a default that takes
   * the next value of a sequence (`serial`, or `default nextval(...)`), or as
   * an identity column. The two are apart because they end differently: a
   * default is dropped or replaced, an identity is dropped as such.
   */
  numbering?: "default" | "identity";
  /** The sequence `serial` made, by name. It is the column's for as long as the column is there, whatever becomes of the default. */
  sequence?: string;
  /** The sequence of an identity column, by name. It goes when the identity is dropped. */
  identitySequence?: string;
  default?: unknown;
  defaultFunction?: DefaultFunction;
  defaultExpression?: string;
  /** What the names in `defaultExpression` referred to when it was written. */
  defaultNames?: ExpressionNames;
  generated?: string;
  /**
   * The enumerated type that the default is a value of, when the column is
   * of another type by now. PostgreSQL does not rewrite a default when a
   * column's type changes: `'ok'::mood` stays that, read as the new type at
   * each write. So the default still rests on the type, which is not dropped
   * while it does, and follows the type's and its values' new names.
   */
  defaultRestsOn?: string;
}

/**
 * What the names in an expression referred to when it was written (D-040).
 * PostgreSQL keeps what an expression means, so a rename changes what it has
 * of the expression; the schema keeps the text, which stays as it was
 * written. From these the collector says what each name in a text is called
 * by now (`ExpressionName`).
 *
 * A column, the table, and an enumerated type are held as what they are:
 * each has its name of the moment. A value of a type, a function, and a type
 * that is not enumerated have no such thing here, so the name they have by
 * now is kept beside the name the text has, and follows their renames.
 */
interface ExpressionNames {
  /** Columns of the expression's table, each with the name the text has for it. */
  columns: { column: ModelColumn; name: string }[];
  /** The table's own name, as the text has it, where the text names the table. */
  table?: string;
  /** Enumerated types the text casts to. */
  types: { type: ModelEnum; name: string }[];
  /** Texts in the expression that are values of an enumerated type the expression has to do with. */
  values: { type: ModelEnum; name: string; now: string }[];
  /** Functions the text calls, by their name without a schema. */
  functions: { name: string; now: string }[];
  /** Types of the public schema that the text casts to and that are not enumerated: a domain, a type of several parts. */
  otherTypes: { name: string; now: string }[];
}

/** A primary key or unique constraint: a constraint with an index of the same name. */
interface ModelKey extends Tracked {
  columns: string[];
  /** Columns the constraint's index carries along (`INCLUDE`). */
  include: string[];
  deferrable?: Deferrable;
  nullsNotDistinct: boolean;
  /** What the constraint says that the schema has no place for, clause by clause. */
  sourceClauses: string[];
}

/** A primary key or unique constraint that a statement adds, before it is named. */
interface NewKey {
  conname?: string;
  columns: string[];
  /** Columns the constraint's index only carries along (`INCLUDE`). They are part of the name PostgreSQL gives it. */
  including: string[];
  primary: boolean;
  nullsNotDistinct: boolean;
  deferrable?: Deferrable;
  sourceClauses: string[];
  /** Whether the name is one PostgreSQL chose. Default: when the statement gives none. */
  generatedName?: boolean;
}

interface ModelForeignKey extends Tracked {
  columns: string[];
  table: string;
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
  deferrable?: Deferrable;
  sourceClauses: string[];
}

interface ModelCheck extends Tracked {
  expression: string;
  /** The table's columns the expression uses. */
  columns: string[];
  names: ExpressionNames;
  sourceClauses: string[];
}

interface ModelTable extends Tracked {
  columns: ModelColumn[];
  primaryKey?: ModelKey;
  uniques: ModelKey[];
  foreignKeys: ModelForeignKey[];
  checks: ModelCheck[];
}

interface ModelIndex extends Tracked {
  table: string;
  /** The keys in their order, with what each says of itself. `columns` and `expressions` are the keys' own, in that order. */
  keys: IndexKey[];
  columns: string[];
  expressions: string[];
  /** Columns the index carries along (`INCLUDE`). */
  include: string[];
  unique: boolean;
  nullsNotDistinct: boolean;
  /** As PostgreSQL names it; `undefined` for a B-tree. */
  method?: string;
  where?: string;
  /** What the names in the expressions and in the condition referred to. */
  names: ExpressionNames;
  sourceClauses: string[];
}

interface ModelEnum extends Tracked {
  values: string[];
  valueRenames: SchemaRename[];
}

const ACTIONS: Record<string, string | undefined> = { a: undefined, r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
const NOW_FUNCTIONS = new Set(["now", "transaction_timestamp", "statement_timestamp", "clock_timestamp"]);
const NOW_VALUE_FUNCTIONS = new Set(["SVFOP_CURRENT_TIMESTAMP", "SVFOP_CURRENT_TIMESTAMP_N", "SVFOP_LOCALTIMESTAMP", "SVFOP_LOCALTIMESTAMP_N"]);
const UUID_FUNCTIONS = new Set(["gen_random_uuid", "uuid_generate_v4", "uuid_generate_v1", "uuid_generate_v7", "uuidv4", "uuidv7"]);
/** Words that end a column's default expression in a column definition. */
const CONSTRAINT_WORDS = new Set(["not", "null", "constraint", "primary", "unique", "references", "check", "default", "collate", "generated", "deferrable", "initially"]);
/** Words that end a column's type in a column definition or `ALTER COLUMN ... TYPE`. */
const TYPE_END_WORDS = new Set([...CONSTRAINT_WORDS, "using", "compression", "storage"]);
/** Constraints that are named and added after a column's own definition. */
const KEY_CONSTRAINTS = new Set(["CONSTR_PRIMARY", "CONSTR_UNIQUE", "CONSTR_FOREIGN", "CONSTR_CHECK", "CONSTR_EXCLUSION"]);

function sval(node: PgNode | undefined): string {
  return String(node?.String?.sval ?? "");
}

function nameList(nodes: PgNode[] | undefined): string[] {
  return (nodes ?? []).map(sval);
}

/** The function a call names, without its schema, in lower case. */
function functionName(call: PgNode): string {
  return (nameList(call.funcname).at(-1) ?? "").toLowerCase();
}

/** The smallest `location` within a node: where its text starts. */
function firstLocation(node: unknown): number | undefined {
  let found: number | undefined;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "location" && typeof inner === "number" && inner >= 0) {
          found = found === undefined ? inner : Math.min(found, inner);
        } else {
          visit(inner);
        }
      }
    }
  };
  visit(node);
  return found;
}

/** Every function call within a node, by name. */
function callsIn(node: unknown): string[] {
  const calls: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === "object" && value !== null) {
      const call = (value as PgNode).FuncCall;
      if (call !== undefined) {
        calls.push(nameList(call.funcname).join("."));
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(node);
  return calls;
}

/** Every node of one kind within a node, in the order they are written. */
function nodesOf(node: unknown, kind: string): PgNode[] {
  const found: PgNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === "object" && value !== null) {
      const inner = (value as PgNode)[kind];
      if (inner !== undefined && typeof inner === "object") {
        found.push(inner as PgNode);
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(node);
  return found;
}

/** Options as they are written in parentheses (`WITH (fillfactor = 70, fastupdate = off)`), as one text: `fillfactor=70, fastupdate=off`. */
function optionsText(options: PgNode[] | undefined): string {
  return (options ?? [])
    .map((entry) => (entry.DefElem ?? {}) as PgNode)
    .map((option) => {
      const arg = (option.arg ?? {}) as PgNode;
      const value =
        arg.Integer !== undefined
          ? String(arg.Integer.ival ?? 0)
          : arg.Float !== undefined
            ? String(arg.Float.fval)
            : arg.String !== undefined
              ? String(arg.String.sval)
              : arg.Boolean !== undefined
                ? String(arg.Boolean.boolval === true)
                : arg.TypeName !== undefined
                  ? nameList(arg.TypeName.names).join(".")
                  : undefined;
      return value === undefined ? String(option.defname) : `${option.defname}=${value}`;
    })
    .join(", ");
}

/** Whether a constraint is deferrable, as its node says. `INITIALLY DEFERRED` says `DEFERRABLE`. */
function deferrableOf(node: PgNode): Deferrable | undefined {
  return node.initdeferred === true ? "deferred" : node.deferrable === true ? "immediate" : undefined;
}

/** The constraints of a column's definition that the words after one (`DEFERRABLE`, `INITIALLY DEFERRED`) can be of. */
const DEFERRABLE_CONSTRAINTS = new Set(["CONSTR_PRIMARY", "CONSTR_UNIQUE", "CONSTR_EXCLUSION", "CONSTR_FOREIGN"]);

/**
 * How PostgreSQL builds an index, as far as it decides what an index of the
 * kind can be. Only a B-tree is unique and has its keys in an order; a hash
 * index is over one column; these carry columns along. A method that is not
 * listed (one of an extension) may be anything.
 */
const INDEX_METHODS: Record<string, { include: boolean; multicolumn: boolean }> = {
  hash: { include: false, multicolumn: false },
  gin: { include: false, multicolumn: true },
  gist: { include: true, multicolumn: true },
  spgist: { include: true, multicolumn: false },
  brin: { include: false, multicolumn: true },
};

/** The names of the columns an expression refers to, each once, in order. */
function columnReferences(node: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === "object" && value !== null) {
      const reference = (value as PgNode).ColumnRef;
      if (reference !== undefined) {
        const name = (reference.fields as PgNode[] | undefined)?.at(-1)?.String?.sval;
        if (typeof name === "string" && !found.includes(name)) {
          found.push(name);
        }
        return;
      }
      Object.values(value).forEach(visit);
    }
  };
  visit(node);
  return found;
}

const NOT_CONSTANT = Symbol("not constant");

/** The value of `ARRAY[...]` over constants: the elements, each as `constantValue` gives it. */
interface ConstantArray {
  array: unknown[];
}

function isConstantArray(value: unknown): value is ConstantArray {
  return typeof value === "object" && value !== null && Array.isArray((value as ConstantArray).array);
}

/**
 * The value of a constant expression: a literal, possibly cast, or
 * `ARRAY[...]` over such (a `ConstantArray`). `NOT_CONSTANT` for anything
 * else.
 */
function constantValue(node: PgNode | undefined): unknown {
  if (node === undefined) {
    return NOT_CONSTANT;
  }
  if (node.A_ArrayExpr !== undefined) {
    const elements = ((node.A_ArrayExpr.elements ?? []) as PgNode[]).map(constantValue);
    return elements.includes(NOT_CONSTANT) ? NOT_CONSTANT : { array: elements };
  }
  const constant = node.A_Const;
  if (constant !== undefined) {
    if (constant.isnull) {
      return null;
    }
    // The parse tree leaves out a value that is zero or false.
    if ("ival" in constant) {
      return Number(constant.ival?.ival ?? 0);
    }
    if ("fval" in constant) {
      return Number(constant.fval?.fval ?? 0);
    }
    if ("boolval" in constant) {
      return constant.boolval?.boolval === true;
    }
    if ("sval" in constant) {
      return String(constant.sval?.sval ?? "");
    }
    if ("bsval" in constant) {
      return String(constant.bsval?.bsval ?? "");
    }
    return NOT_CONSTANT;
  }
  const cast = node.TypeCast;
  if (cast !== undefined) {
    const value = constantValue(cast.arg);
    if (value === NOT_CONSTANT || value === null) {
      return value;
    }
    const target = (nameList(cast.typeName?.names).at(-1) ?? "").toLowerCase();
    if ((target === "json" || target === "jsonb") && typeof value === "string") {
      try {
        return { json: JSON.parse(value) };
      } catch {
        return NOT_CONSTANT;
      }
    }
    if (target === "bool" && typeof value === "string") {
      return /^(t|true|y|yes|on|1)$/i.test(value) ? true : /^(f|false|n|no|off|0)$/i.test(value) ? false : NOT_CONSTANT;
    }
    return value;
  }
  return NOT_CONSTANT;
}

/** Whether an expression is the time of the write: `now()`, `current_timestamp`, `timezone('utc', now())`, ... */
function isNow(node: PgNode | undefined): boolean {
  if (node === undefined) {
    return false;
  }
  if (node.SQLValueFunction !== undefined) {
    return NOW_VALUE_FUNCTIONS.has(node.SQLValueFunction.op);
  }
  if (node.TypeCast !== undefined) {
    return isNow(node.TypeCast.arg);
  }
  const call = node.FuncCall;
  if (call !== undefined) {
    const name = functionName(call);
    if (NOW_FUNCTIONS.has(name)) {
      return true;
    }
    // `timezone('utc', now())` and `now() at time zone 'utc'`: the same moment, written in another zone.
    return name === "timezone" && isNow((call.args as PgNode[] | undefined)?.at(-1));
  }
  return false;
}

function isToday(node: PgNode | undefined): boolean {
  return node?.SQLValueFunction?.op === "SVFOP_CURRENT_DATE" || (node?.TypeCast !== undefined && isToday(node.TypeCast.arg));
}

/** The type with references to an enumerated type renamed; the type itself when it has none. */
function renameEnumIn(type: CanonicalType, from: string, to: string): CanonicalType {
  if (type.kind === "enum" && type.name === from) {
    return { kind: "enum", name: to };
  }
  if (type.kind === "array") {
    const element = renameEnumIn(type.element, from, to);
    return element === type.element ? type : { kind: "array", element };
  }
  return type;
}

/** The enumerated type a canonical type is, or is an array of, by name. */
function enumIn(type: CanonicalType): string | undefined {
  return type.kind === "enum" ? type.name : type.kind === "array" ? enumIn(type.element) : undefined;
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

class Collector {
  readonly #tables = new Map<string, ModelTable>();
  readonly #indexes = new Map<string, ModelIndex>();
  readonly #enums = new Map<string, ModelEnum>();
  readonly #seeds = new Map<string, Row[]>();
  readonly #report: ReportEntry[] = [];
  readonly #namespace: Namespace = { relations: new Set(), constraints: new Set() };
  /**
   * The temporary tables that are there, by name. They are not tables of the
   * schema, and nothing is kept of them but that they are there, and whether
   * they go when their transaction is committed (ON COMMIT DROP). All of them
   * go at the end of their migration: no migration can count on the session
   * of another.
   */
  readonly #temporary = new Map<string, { dropAtCommit: boolean }>();
  /** The indexes of temporary tables: each index's name, with its table's. */
  readonly #temporaryIndexes = new Map<string, string>();
  /**
   * Whether all that the migrations did to the schema has been seen. Not
   * after a statement whose effect cannot be known here: a DO block, a
   * function called for its effect, or anything reported as unsupported.
   * PostgreSQL may then have a key, or lack a type or a foreign key, that the
   * model does not, so what is refused only because of what rests on what
   * (a foreign key on its key, a table's type on its name) is refused no
   * longer: a chain that PostgreSQL takes is never refused for them.
   */
  #sure = true;
  readonly #now: () => Date;
  #file!: MigrationFile;
  #statement!: ParsedStatement;

  constructor(options: CollectOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  async apply(file: MigrationFile, statements: ParsedStatement[]): Promise<void> {
    this.#file = file;
    for (const statement of statements) {
      this.#statement = statement;
      await this.#dispatch(statement.kind, statement.node[statement.kind] as PgNode);
    }
    this.#endTemporary(() => true);
  }

  // --- reporting and provenance ----------------------------------------------

  #position(): SourcePosition {
    return { source: COLLECTOR_SOURCE, file: this.#file.file, sha256: this.#file.sha256, statement: this.#statement.index, line: this.#statement.line };
  }

  #origin(name: string, generatedName = false): SchemaOrigin {
    return { ...this.#position(), name, ...(generatedName && { generatedName: true }) };
  }

  /** Renames a tracked object and records the rename. */
  #renamed(object: Tracked, to: string): void {
    object.renames.push({ from: object.name, to, at: this.#position() });
    object.name = to;
  }

  #note(outcome: ReportOutcome, category: ReportCategory, message: string, object?: string, kind?: string): void {
    if (outcome === "unsupported") {
      this.#sure = false;
    }
    this.#report.push({
      file: this.#file.file,
      line: this.#statement.line,
      statement: this.#statement.index,
      kind: kind ?? this.#statement.kind,
      outcome,
      category,
      ...(object !== undefined && { object }),
      message,
      sql: shorten(this.#statement.text),
    });
  }

  #fail(message: string): never {
    throw new MigrationError(this.#file.file, this.#statement.line, message);
  }

  // --- names ----------------------------------------------------------------

  /** A table named by a `RangeVar`: `undefined` when it is in another schema than `public`. */
  #local(relation: PgNode | undefined): string | undefined {
    const schema = relation?.schemaname as string | undefined;
    return schema === undefined || schema === "public" ? String(relation?.relname ?? "") : undefined;
  }

  /** Whether a type's name, as a statement gives it (`status`, `public.status`, `app.status`), is one of the public schema. */
  #isLocalType(parts: readonly string[]): boolean {
    return parts.length < 2 || parts.at(-2) === "public";
  }

  /**
   * Whether a table a statement names is a temporary one: named in
   * `pg_temp`, or by its name alone when a temporary table has that name,
   * which hides a table of the schema for as long as it is there.
   */
  #isTemporary(relation: PgNode | undefined): boolean {
    const schema = relation?.schemaname as string | undefined;
    return schema === "pg_temp" || (schema === undefined && this.#temporary.has(String(relation?.relname ?? "")));
  }

  /** The note for a statement on a temporary table, which is not applied. */
  #onTemporary(relation: PgNode | undefined): void {
    const name = String(relation?.relname ?? "");
    this.#note("not-reproduced", "temporary-tables", `"${name}" is a temporary table, which is not created locally; the statement is not applied.`, name);
  }

  /** A temporary table comes into being: remembered by name, and reported. */
  #createTemporary(relation: PgNode | undefined, ifNotExists: boolean, onCommit: unknown): void {
    const name = String(relation?.relname ?? "");
    if (this.#temporary.has(name)) {
      if (ifNotExists) {
        return this.#note("no-effect", "temporary-tables", `The temporary table "${name}" exists already (IF NOT EXISTS).`, name);
      }
      this.#fail(`relation "${name}" already exists.`);
    }
    const dropAtCommit = onCommit === "ONCOMMIT_DROP";
    this.#temporary.set(name, { dropAtCommit });
    this.#note("not-reproduced", "temporary-tables", `The temporary table "${name}" lasts ${dropAtCommit ? "until its transaction is committed" : "for one session of PostgreSQL"} and is not created locally.`, name);
  }

  /** The temporary tables that `ends` picks are there no longer, and neither are their indexes. */
  #endTemporary(ends: (table: { dropAtCommit: boolean }) => boolean): void {
    for (const [name, table] of [...this.#temporary]) {
      if (ends(table)) {
        this.#dropTemporary(name);
      }
    }
  }

  #dropTemporary(name: string): boolean {
    for (const [index, table] of [...this.#temporaryIndexes]) {
      if (table === name) {
        this.#temporaryIndexes.delete(index);
      }
    }
    return this.#temporary.delete(name);
  }

  /** An index of a temporary table: nothing is kept of it but its name, by which it is renamed and dropped. */
  #indexTemporary(node: PgNode): void {
    const table = String(node.relation?.relname ?? "");
    const elements = [...((node.indexParams ?? []) as PgNode[]), ...((node.indexIncludingParams ?? []) as PgNode[])].map((entry) => entry.IndexElem as PgNode);
    // Its name is one of the temporary schema's, where the temporary tables and their indexes have theirs.
    const taken: Namespace = { relations: new Set([...this.#temporary.keys(), ...this.#temporaryIndexes.keys()]), constraints: new Set() };
    this.#temporaryIndexes.set(node.idxname ?? chooseRelationName(taken, table, nameAddition(indexColumnNames(elements)), "idx", false), table);
  }

  /** The index of a temporary table that a statement names: in `pg_temp`, or by its name alone, which hides an index of the schema. */
  #temporaryIndex(schema: string | undefined, name: string): string | undefined {
    return (schema === undefined || schema === "pg_temp") && this.#temporaryIndexes.has(name) ? name : undefined;
  }

  #qualified(relation: PgNode | undefined): string {
    return relation?.schemaname === undefined ? String(relation?.relname ?? "") : `${relation.schemaname}.${relation.relname}`;
  }

  #table(name: string, missingOk = false): ModelTable | undefined {
    const table = this.#tables.get(name);
    if (table === undefined && !missingOk) {
      this.#fail(`relation "${name}" does not exist.`);
    }
    return table;
  }

  #column(table: ModelTable, name: string): ModelColumn {
    const column = table.columns.find((candidate) => candidate.name === name);
    if (column === undefined) {
      return this.#fail(`column "${name}" of relation "${table.name}" does not exist.`);
    }
    return column;
  }

  /** Takes a name for an object that has an index (a primary key or unique constraint): both a relation and a constraint. */
  #claimKeyName(name: string): void {
    this.#namespace.relations.add(name);
    this.#namespace.constraints.add(name);
  }

  #releaseKeyName(name: string): void {
    this.#namespace.relations.delete(name);
    this.#namespace.constraints.delete(name);
  }

  /**
   * Fails when a table or an enumerated type is to take a name that the
   * other kind has: PostgreSQL keeps a type for every table, the type of its
   * rows, under the table's name. (An index has no such type.)
   */
  #typeNameFree(name: string): void {
    if (this.#sure && (this.#enums.has(name) || this.#tables.has(name))) {
      this.#fail(`type "${name}" already exists.`);
    }
  }

  /**
   * The keys of a table that a foreign key to these columns can rest on: a
   * primary key, a unique constraint, or a unique index over exactly them,
   * in whatever order. An index over an expression or with a condition is
   * no key, and neither is a constraint that is deferrable (`deferrable`
   * gives those instead: PostgreSQL has another refusal for them).
   */
  #keysOver(table: ModelTable, columns: readonly string[], deferrable = false): Tracked[] {
    const overThem = (key: { columns: string[] }): boolean => key.columns.length === columns.length && columns.every((name) => key.columns.includes(name));
    const constraints = [...(table.primaryKey !== undefined ? [table.primaryKey] : []), ...table.uniques].filter((key) => overThem(key) && (key.deferrable !== undefined) === deferrable);
    return deferrable
      ? constraints
      : [...constraints, ...[...this.#indexes.values()].filter((index) => index.table === table.name && index.unique && index.expressions.length === 0 && index.where === undefined && overThem(index))];
  }

  /**
   * A key or unique index of a table is to go: what becomes of the foreign
   * keys to its columns. One that has no other key over those columns rests
   * on this one. PostgreSQL refuses to drop the key then, or with CASCADE
   * drops the foreign key with it; the names of those that went are
   * returned. One that has another key may rest on either: which of them
   * PostgreSQL made it with is not known here, so it is kept, and with
   * CASCADE said to be. `what`: the key as PostgreSQL names it in its
   * refusal, and as the report names it.
   */
  #releaseKey(table: ModelTable, key: Tracked & { columns: string[] }, cascade: boolean, what: { refused: string; dropped: string }): string[] {
    const toIt = this.#referencesTo(table.name).filter(({ key: foreignKey }) => this.#keysOver(table, foreignKey.refColumns).includes(key));
    const resting = toIt.filter(({ key: foreignKey }) => this.#keysOver(table, foreignKey.refColumns).length === 1);
    const named = ({ owner, key: foreignKey }: { owner: ModelTable; key: ModelForeignKey }): string => `"${foreignKey.name}" of "${owner.name}"`;
    if (!cascade) {
      const [first] = resting;
      if (first !== undefined && this.#sure) {
        this.#fail(`cannot drop ${what.refused} because other objects depend on it (foreign key ${named(first)}). Use CASCADE.`);
      }
      return [];
    }
    for (const { owner, key: foreignKey } of resting) {
      owner.foreignKeys.splice(owner.foreignKeys.indexOf(foreignKey), 1);
      this.#namespace.constraints.delete(foreignKey.name);
    }
    for (const entry of toIt.filter((candidate) => !resting.includes(candidate))) {
      this.#note(
        "unsupported",
        "constraint",
        `Dropped ${what.dropped} with CASCADE. The foreign key ${named(entry)} has another key over the same columns to rest on, and which of them PostgreSQL made it with is not known here: it is kept, and PostgreSQL may have dropped it.`,
        `${entry.owner.name}.${entry.key.name}`,
      );
    }
    return resting.map(named);
  }

  // --- what the names in an expression refer to ------------------------------------------

  /**
   * What the names in an expression refer to as it is written (see
   * `ExpressionNames`). `table`: the table whose columns the expression can
   * name; a default has none. `own`: the column a default is of, whose
   * enumerated type a text in the default can be a value of.
   */
  #namesIn(node: unknown, table: ModelTable | undefined, own?: ModelColumn): ExpressionNames {
    const names: ExpressionNames = { columns: [], types: [], values: [], functions: [], otherTypes: [] };
    /** The enumerated types the expression has to do with: a text in it that is a value of one may be meant as that value. */
    const enums = new Set<ModelEnum>();
    const enumOf = (column: ModelColumn): void => {
      const type = this.#enums.get(enumIn(column.canonical) ?? "");
      if (type !== undefined) {
        enums.add(type);
      }
    };
    if (own !== undefined) {
      enumOf(own);
    }
    for (const reference of table === undefined ? [] : nodesOf(node, "ColumnRef")) {
      const fields = (reference.fields ?? []) as PgNode[];
      const parts = fields.map((field) => field.String?.sval).filter((part): part is string => typeof part === "string");
      const last = parts.at(-1);
      const column = fields.some((field) => field.A_Star !== undefined) ? undefined : table?.columns.find((candidate) => candidate.name === last);
      if (column !== undefined && last !== undefined) {
        if (!names.columns.some((entry) => entry.column === column)) {
          names.columns.push({ column, name: last });
        }
        enumOf(column);
      }
      // `t.a`, `public.t.a`: the name before the column's is the table's. `t.*`, and `t` where it is no column, are the table as a row.
      const tableName = column !== undefined ? parts.at(-2) : last;
      if (tableName !== undefined && tableName === table?.name) {
        names.table = tableName;
      }
    }
    for (const cast of nodesOf(node, "TypeCast")) {
      const parts = nameList(cast.typeName?.names);
      const name = parts.at(-1);
      if (name === undefined || !this.#isLocalType(parts)) {
        continue;
      }
      const type = this.#enums.get(name);
      if (type !== undefined) {
        if (!names.types.some((entry) => entry.type === type)) {
          names.types.push({ type, name });
        }
        enums.add(type);
      } else if (!names.otherTypes.some((entry) => entry.name === name)) {
        names.otherTypes.push({ name, now: name });
      }
    }
    for (const constant of nodesOf(node, "A_Const")) {
      const text = constant.sval?.sval;
      for (const type of typeof text === "string" ? enums : []) {
        if (type.values.includes(text) && !names.values.some((entry) => entry.type === type && entry.name === text)) {
          names.values.push({ type, name: text, now: text });
        }
      }
    }
    for (const call of callsIn(node)) {
      const name = call.split(".").at(-1) as string;
      if (!names.functions.some((entry) => entry.name === name)) {
        names.functions.push({ name, now: name });
      }
    }
    return names;
  }

  /**
   * What the schema says of an expression's text (`ExpressionName`): what it
   * names of columns, the table, enumerated types and their values, each
   * with what it is called now when that is something else; and the
   * functions and other types that were renamed since. Where an enumerated
   * type that the text names is gone, it is not known what the text names.
   */
  #textOf(names: ExpressionNames, table: ModelTable | undefined): { names: ExpressionName[] } | { mayBeStale: true } {
    if ([...names.types, ...names.values].some(({ type }) => this.#enums.get(type.name) !== type)) {
      return { mayBeStale: true };
    }
    const called = (name: string, now: string): { name: string; now?: string } => ({ name, ...(now !== name && { now }) });
    return {
      names: [
        ...names.columns.map(({ column, name }): ExpressionName => ({ kind: "column", ...called(name, column.name) })),
        ...(names.table !== undefined && table !== undefined ? [{ kind: "table" as const, ...called(names.table, table.name) }] : []),
        ...names.types.map(({ type, name }): ExpressionName => ({ kind: "type", ...called(name, type.name) })),
        ...names.values.map(({ type, name, now }): ExpressionName => ({ kind: "value", ...called(name, now), type: type.name })),
        // A schema keeps no functions, and no types but enumerated ones: of those, only what was renamed is said.
        ...names.otherTypes.filter(({ name, now }) => now !== name).map(({ name, now }): ExpressionName => ({ kind: "type", name, now })),
        ...names.functions.filter(({ name, now }) => now !== name).map(({ name, now }): ExpressionName => ({ kind: "function", name, now })),
      ],
    };
  }

  /** Every expression that is kept, with what holds it. */
  #expressions(): { names: ExpressionNames; table: ModelTable; what: string; text: string; object: string; category: ReportCategory }[] {
    const found: { names: ExpressionNames; table: ModelTable; what: string; text: string; object: string; category: ReportCategory }[] = [];
    for (const table of this.#tables.values()) {
      for (const check of table.checks) {
        found.push({ names: check.names, table, what: `The check "${check.name}" of "${table.name}"`, text: check.expression, object: `${table.name}.${check.name}`, category: "constraint" });
      }
      for (const column of table.columns) {
        if (column.defaultNames !== undefined && column.defaultExpression !== undefined) {
          found.push({ names: column.defaultNames, table, what: `The default of "${table.name}"."${column.name}"`, text: column.defaultExpression, object: `${table.name}.${column.name}`, category: "column" });
        }
      }
    }
    for (const index of this.#indexes.values()) {
      const table = this.#tables.get(index.table);
      if (table !== undefined && (index.expressions.length > 0 || index.where !== undefined)) {
        const text = [...index.expressions, ...(index.where === undefined ? [] : [index.where])].join("; ");
        found.push({ names: index.names, table, what: `The index "${index.name}" on "${table.name}"`, text, object: index.name, category: "index" });
      }
    }
    return found;
  }

  /**
   * Says, at a rename, which expressions the rename leaves behind: those
   * that name the renamed thing by another name than it has from here on.
   * `named`: the name an expression has for the thing, when it names it.
   */
  #noteLeftBehind(now: string, named: (names: ExpressionNames, table: ModelTable) => string | undefined): void {
    for (const { names, table, what, text, object, category } of this.#expressions()) {
      const was = named(names, table);
      if (was !== undefined && was !== now) {
        this.#note("retained", category, `${what} was written with "${was}", which is "${now}" from here on: its text (${text}) is kept as it was written, and is no longer what PostgreSQL has.`, object);
      }
    }
  }

  // --- dispatch -------------------------------------------------------------

  async #dispatch(kind: string, node: PgNode): Promise<void> {
    // What is done to a temporary table is done to nothing that is kept.
    if (kind === "CreateStmt" && (node.relation?.relpersistence === "t" || node.relation?.schemaname === "pg_temp")) {
      return this.#createTemporary(node.relation, node.if_not_exists === true, node.oncommit);
    }
    if (kind === "CreateTableAsStmt" && node.objtype !== "OBJECT_MATVIEW" && (node.into?.rel?.relpersistence === "t" || node.into?.rel?.schemaname === "pg_temp")) {
      return this.#createTemporary(node.into.rel, node.if_not_exists === true, node.into.onCommit);
    }
    // SELECT ... INTO TEMP: the same as CREATE TEMP TABLE ... AS.
    if (kind === "SelectStmt" && (node.intoClause?.rel?.relpersistence === "t" || node.intoClause?.rel?.schemaname === "pg_temp")) {
      return this.#createTemporary(node.intoClause.rel, false, node.intoClause.onCommit);
    }
    if (kind === "TransactionStmt" && (node.kind === "TRANS_STMT_COMMIT" || node.kind === "TRANS_STMT_ROLLBACK")) {
      // The transaction ends, and with it the temporary tables that were made to go then.
      this.#endTemporary((table) => table.dropAtCommit);
    }
    if (kind === "IndexStmt" && this.#isTemporary(node.relation)) {
      this.#indexTemporary(node);
      return this.#onTemporary(node.relation);
    }
    if (["AlterTableStmt", "InsertStmt", "UpdateStmt", "DeleteStmt", "CopyStmt"].includes(kind) && this.#isTemporary(node.relation)) {
      return this.#onTemporary(node.relation);
    }
    if (kind === "TruncateStmt" && ((node.relations ?? []) as PgNode[]).length > 0 && ((node.relations ?? []) as PgNode[]).every((entry) => this.#isTemporary(entry.RangeVar))) {
      return this.#onTemporary(((node.relations as PgNode[])[0] as PgNode).RangeVar);
    }
    if (kind === "RenameStmt" && node.renameType === "OBJECT_INDEX" && this.#temporaryIndex(node.relation?.schemaname, String(node.relation?.relname)) !== undefined) {
      const [from, to] = [String(node.relation.relname), String(node.newname)];
      const table = this.#temporaryIndexes.get(from) as string;
      this.#temporaryIndexes.delete(from);
      this.#temporaryIndexes.set(to, table);
      return this.#note("not-reproduced", "temporary-tables", `Renamed the index "${from}" of the temporary table "${table}" to "${to}"; it was not created locally.`, to);
    }
    if (kind === "RenameStmt" && node.relation !== undefined && this.#isTemporary(node.relation)) {
      this.#onTemporary(node.relation);
      if (node.renameType === "OBJECT_TABLE") {
        const [from, to] = [String(node.relation.relname), String(node.newname)];
        const table = this.#temporary.get(from);
        if (table !== undefined) {
          this.#temporary.delete(from);
          this.#temporary.set(to, table);
          for (const [index, owner] of this.#temporaryIndexes) {
            if (owner === from) {
              this.#temporaryIndexes.set(index, to);
            }
          }
        }
      }
      return;
    }
    switch (kind) {
      case "CreateStmt":
        return this.#createTable(node);
      case "AlterTableStmt":
        return this.#alterTable(node);
      case "RenameStmt":
        return this.#rename(node);
      case "DropStmt":
        return this.#drop(node);
      case "IndexStmt":
        return this.#createIndex(node);
      case "CreateEnumStmt":
        return this.#createEnum(node);
      case "AlterEnumStmt":
        return this.#alterEnum(node);
      case "InsertStmt":
        return this.#insert(node);
      case "SelectStmt":
      case "CallStmt":
        return this.#query(node);
      case "CreatePolicyStmt":
      case "AlterPolicyStmt":
        return this.#note("not-reproduced", "row-level-security", `Row level security policy "${node.policy_name}" on ${this.#qualified(node.table)} is not enforced locally: every client reads and writes every row.`, this.#qualified(node.table));
      case "GrantStmt":
      case "GrantRoleStmt":
      case "AlterDefaultPrivilegesStmt":
      case "CreateRoleStmt":
      case "AlterRoleStmt":
      case "AlterRoleSetStmt":
      case "DropRoleStmt":
      case "AlterOwnerStmt":
        return this.#note("not-reproduced", "permissions", "Roles, grants, and ownership are not reproduced locally: the sandbox has no database users.");
      case "CreateExtensionStmt":
      case "AlterExtensionStmt":
      case "AlterExtensionContentsStmt":
        return this.#note("not-reproduced", "extensions", `The extension ${node.extname !== undefined ? `"${node.extname}"` : ""} is not installed locally; what it provides is not available.`.replace("  ", " "), node.extname);
      case "CreateFunctionStmt":
      case "AlterFunctionStmt":
      case "DoStmt":
        // What a block does when PostgreSQL runs it is not known here.
        this.#sure &&= kind !== "DoStmt";
        return this.#note("not-reproduced", "functions", kind === "DoStmt" ? "An anonymous code block (DO) is not run locally." : `The function ${nameList(node.funcname).join(".") || ""} is not created locally; SQL that calls it fails there.`, nameList(node.funcname).join(".") || undefined);
      case "CreateTrigStmt":
      case "CreateEventTrigStmt":
      case "AlterEventTrigStmt":
        return this.#note(
          "not-reproduced",
          "triggers",
          `The trigger ${node.trigname !== undefined ? `"${node.trigname}" ` : ""}is not created locally: rows written in the sandbox do not get what it would do.`,
          node.relation !== undefined ? this.#qualified(node.relation) : undefined,
        );
      case "CreatePublicationStmt":
      case "AlterPublicationStmt":
      case "CreateSubscriptionStmt":
      case "AlterSubscriptionStmt":
        return this.#note("not-reproduced", "replication", "Publications and subscriptions (replication, Supabase Realtime) are not reproduced locally.");
      case "CreateSchemaStmt":
        return this.#note("not-reproduced", "other-schemas", `The schema "${node.schemaname}" is not created locally; only the public schema is collected.`, node.schemaname);
      case "CreateSeqStmt":
      case "AlterSeqStmt":
        return this.#note("not-reproduced", "sequences", `The sequence ${this.#qualified(node.sequence)} is not created locally. Columns with serial or identity numbering are numbered by the sandbox when they are a single integer primary key.`, this.#qualified(node.sequence));
      case "ViewStmt":
        return this.#note("unsupported", "views", `The view ${this.#qualified(node.view)} is not created locally; a query of it fails there.`, this.#qualified(node.view));
      case "CreateTableAsStmt":
        return this.#note("unsupported", "views", `${node.objtype === "OBJECT_MATVIEW" ? "The materialized view" : "The table created from a query,"} ${this.#qualified(node.into?.rel)} is not created locally.`, this.#qualified(node.into?.rel));
      case "CommentStmt":
        return this.#note("no-effect", "comments", "Comment; not kept.");
      case "TransactionStmt":
        return this.#note("no-effect", "transactions", "Transaction control; each migration is collected as a whole.");
      case "VariableSetStmt":
      case "VariableShowStmt":
        return this.#note("no-effect", "session", `Session setting${node.name !== undefined ? ` "${node.name}"` : ""}; no effect on the collected schema.`);
      case "UpdateStmt":
      case "DeleteStmt":
      case "MergeStmt":
      case "TruncateStmt":
      case "CopyStmt":
        return this.#note("unsupported", "data", `${kind.replace("Stmt", "").toUpperCase()} in a migration is not applied to the rows the migrations insert.`);
      case "CompositeTypeStmt":
      case "CreateDomainStmt":
      case "CreateRangeStmt":
      case "DefineStmt":
        return this.#note("unsupported", "type", "Only enumerated types are collected; columns of this type are stored as given, without its rules.");
      default:
        return this.#note("unsupported", "other", `${kind} is not handled by the collector.`);
    }
  }

  // --- tables ---------------------------------------------------------------

  async #createTable(node: PgNode): Promise<void> {
    const name = this.#local(node.relation);
    if (name === undefined) {
      return this.#note("not-reproduced", "other-schemas", `The table ${this.#qualified(node.relation)} is in another schema than public and is not created locally.`, this.#qualified(node.relation));
    }
    if (this.#tables.has(name)) {
      if (node.if_not_exists) {
        return this.#note("no-effect", "table", `Table "${name}" exists already (IF NOT EXISTS).`, name);
      }
      this.#fail(`relation "${name}" already exists.`);
    }
    this.#typeNameFree(name);
    const table: ModelTable = { name, columns: [], uniques: [], foreignKeys: [], checks: [], origin: this.#origin(name), renames: [] };
    this.#tables.set(name, table);
    this.#namespace.relations.add(name);
    if ((node.inhRelations ?? []).length > 0 || node.partspec !== undefined || node.partbound !== undefined || node.ofTypename !== undefined) {
      this.#note("unsupported", "table", `Inheritance, partitioning, and typed tables are not reproduced; "${name}" is created from its own columns only.`, name);
    }
    const constraints: { constraint: PgNode; column?: string }[] = [];
    for (const element of (node.tableElts ?? []) as PgNode[]) {
      if (element.ColumnDef !== undefined) {
        constraints.push(...(await this.#addColumn(table, element.ColumnDef, "CreateStmt")));
      } else if (element.Constraint !== undefined) {
        constraints.push({ constraint: element.Constraint });
      } else if (element.TableLikeClause !== undefined) {
        this.#note("unsupported", "table", `LIKE ${this.#qualified(element.TableLikeClause.relation)} is not reproduced; its columns are missing from "${name}".`, name);
      }
    }
    await this.#addConstraints(table, constraints, "CreateStmt", true);
    const parts = [
      `${table.columns.length} column${table.columns.length === 1 ? "" : "s"}`,
      ...(table.primaryKey !== undefined ? [`primary key ${table.primaryKey.name} (${table.primaryKey.columns.join(", ")})`] : []),
      ...(table.foreignKeys.length > 0 ? [`${table.foreignKeys.length} foreign key${table.foreignKeys.length === 1 ? "" : "s"}`] : []),
      ...(table.uniques.length > 0 ? [`${table.uniques.length} unique constraint${table.uniques.length === 1 ? "" : "s"}`] : []),
    ];
    this.#note("applied", "table", `Created table "${name}": ${parts.join(", ")}.`, name);
  }

  /** The type as the migration wrote it: from the type's position up to what follows it. */
  async #typeSpelling(typeName: PgNode): Promise<string | undefined> {
    const location = typeName.location;
    if (typeof location !== "number" || location < 0) {
      return undefined;
    }
    const text = (await expressionText(this.#file.bytes, location, this.#statement.end, TYPE_END_WORDS)).replace(/\s+/g, " ");
    return text === "" ? undefined : text;
  }

  /**
   * Adds a column with its type, nullability, and default, and returns its
   * key, foreign key, and check constraints, which are added after the
   * statement's columns (as PostgreSQL does) with the column's name.
   */
  async #addColumn(table: ModelTable, definition: PgNode, kind: string): Promise<{ constraint: PgNode; column: string }[]> {
    const name = String(definition.colname);
    if (table.columns.some((column) => column.name === name)) {
      this.#fail(`column "${name}" specified more than once in "${table.name}".`);
    }
    const typeName = (definition.typeName ?? {}) as PgNode;
    const info = columnType(typeName, new Set(this.#enums.keys()));
    const column: ModelColumn = {
      name,
      type: info.type,
      canonical: info.canonical,
      declaredType: (await this.#typeSpelling(typeName)) ?? info.dialectType,
      dialectType: info.dialectType,
      ...(info.enumName !== undefined && { enumName: info.enumName }),
      nullable: !info.serial,
      ...(info.serial && { numbering: "default" as const }),
      origin: this.#origin(name),
      renames: [],
    };
    table.columns.push(column);
    if (info.unknown) {
      this.#note("retained", "column", `"${table.name}"."${name}" has the type ${info.dialectType}, which the sandbox does not know; its values are stored as they are given.`, `${table.name}.${name}`, kind);
    }
    if (definition.raw_default !== undefined) {
      await this.#setDefault(table, column, definition.raw_default, definition.raw_default, kind);
    }
    const constraints = ((definition.constraints ?? []) as PgNode[]).map((entry) => entry.Constraint as PgNode).filter((entry) => entry !== undefined);
    this.#applyConstraintAttributes(constraints);
    // `serial` is a default: PostgreSQL takes no second one, and no identity beside one.
    let hasDefault = info.serial || definition.raw_default !== undefined;
    for (const constraint of constraints) {
      switch (constraint.contype) {
        case "CONSTR_NOTNULL":
          column.nullable = false;
          break;
        case "CONSTR_NULL":
          column.nullable = true;
          break;
        case "CONSTR_DEFAULT":
          if (hasDefault) {
            this.#fail(`multiple default values specified for column "${name}" of table "${table.name}".`);
          }
          hasDefault = true;
          await this.#setDefault(table, column, constraint.raw_expr, constraint, kind);
          break;
        case "CONSTR_IDENTITY":
          column.numbering = "identity";
          column.nullable = false;
          break;
        case "CONSTR_GENERATED":
          this.#note("retained", "column", `"${table.name}"."${name}" is a generated column; the sandbox does not compute it, so it holds what is written to it.`, `${table.name}.${name}`, kind);
          break;
        default:
          break;
      }
    }
    if (hasDefault && constraints.some((constraint) => constraint.contype === "CONSTR_IDENTITY")) {
      this.#fail(`both default and identity specified for column "${name}" of table "${table.name}".`);
    }
    // The sequence PostgreSQL creates for the column; its name is taken before the table's constraints are named.
    if (info.serial) {
      column.sequence = this.#newSequence(table, column);
    } else if (column.numbering === "identity") {
      column.identitySequence = this.#newSequence(table, column);
    }
    return constraints.filter((constraint) => KEY_CONSTRAINTS.has(constraint.contype)).map((constraint) => ({ constraint, column: name }));
  }

  /** Takes a name for a sequence of a column, as PostgreSQL names it. */
  #newSequence(table: ModelTable, column: ModelColumn): string {
    const name = chooseRelationName(this.#namespace, table.name, column.name, "seq", false);
    this.#namespace.relations.add(name);
    return name;
  }

  /** Gives back the names of a column's sequences: the column, or its table, is dropped. */
  #releaseSequences(column: ModelColumn): void {
    for (const name of [column.sequence, column.identitySequence]) {
      if (name !== undefined) {
        this.#namespace.relations.delete(name);
      }
    }
  }

  /** Whether the column has a default, as PostgreSQL counts it: an identity is none. */
  #hasDefault(column: ModelColumn): boolean {
    return column.default !== undefined || column.defaultFunction !== undefined || column.defaultExpression !== undefined || column.numbering === "default";
  }

  /** Takes a column's default away, with what the default did: the numbering of a `serial`, the UUID of `gen_random_uuid()`. */
  #clearDefault(column: ModelColumn): void {
    delete column.default;
    delete column.defaultFunction;
    delete column.defaultExpression;
    delete column.defaultNames;
    delete column.defaultRestsOn;
    if (column.generated === "uuid") {
      delete column.generated;
    }
    if (column.numbering === "default") {
      delete column.numbering;
    }
  }

  /** A column's default: `expression` is its parse tree, `at` the node whose location starts its text. */
  async #setDefault(table: ModelTable, column: ModelColumn, expression: PgNode | undefined, at: PgNode, kind: string): Promise<void> {
    this.#clearDefault(column);
    const object = `${table.name}.${column.name}`;
    const constant = constantValue(expression);
    if (constant !== NOT_CONSTANT) {
      if (constant === null) {
        return;
      }
      const value = this.#coerce(column, constant);
      if (value !== NOT_CONSTANT) {
        column.default = value;
        // Written as a value of an enumerated type that is not the column's own (`('ok'::mood)::text`): PostgreSQL keeps it as that value, so it rests on the type as a default does whose column has left its type.
        const [cast, ...more] = this.#namesIn(expression, undefined).types;
        if (cast !== undefined && more.length === 0 && cast.type.name !== enumIn(column.canonical)) {
          column.defaultRestsOn = cast.type.name;
        }
        return;
      }
    }
    const text = await this.#text(expression ?? at, CONSTRAINT_WORDS);
    column.defaultExpression = text;
    // A default names no column of its table. What it can name is a type, a value of the type of its own column, or a function.
    column.defaultNames = this.#namesIn(expression, undefined, column);
    if (isNow(expression) && column.type === "datetime") {
      column.defaultFunction = "current_timestamp";
      return;
    }
    if (isToday(expression) && column.type === "date") {
      column.defaultFunction = "current_date";
      return;
    }
    const call = expression?.FuncCall;
    if (call !== undefined && functionName(call) === "nextval") {
      column.numbering = "default";
      delete column.defaultExpression;
      delete column.defaultNames;
      return;
    }
    if (call !== undefined && UUID_FUNCTIONS.has(functionName(call))) {
      column.generated = "uuid";
      this.#note("retained", "column", `The default of "${table.name}"."${column.name}" (${text}) is kept as information: the sandbox does not generate UUIDs, so a row written without one gets none.`, object, kind);
      return;
    }
    this.#note("retained", "column", `The default of "${table.name}"."${column.name}" (${text}) is kept as information and not computed locally.`, object, kind);
  }

  /**
   * An element of an array, as a value of the array's element type. An
   * element of a literal is text (`{1,2}`), one of `ARRAY[...]` a constant;
   * an array within the array has elements of the same type.
   * `NOT_CONSTANT` for what is not a value of the type.
   */
  #arrayElement(type: CanonicalType, element: unknown): unknown {
    if (element === null) {
      return null;
    }
    const inner = Array.isArray(element) ? element : isConstantArray(element) ? element.array : undefined;
    if (inner !== undefined) {
      const values = inner.map((item) => this.#arrayElement(type, item));
      return values.includes(NOT_CONSTANT) ? NOT_CONSTANT : values;
    }
    switch (type.kind) {
      case "integer":
        if (typeof element === "number") {
          return Number.isInteger(element) ? element : NOT_CONSTANT;
        }
        if (typeof element !== "string" || !/^[+-]?\d+$/.test(element)) {
          return NOT_CONSTANT;
        }
        // An integer that a number does not hold exactly stays the digits it was written with.
        return Number.isSafeInteger(Number(element)) ? Number(element) : element;
      case "float":
      case "decimal":
        if (typeof element === "number") {
          return element;
        }
        return typeof element === "string" && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(element) ? Number(element) : NOT_CONSTANT;
      case "boolean":
        if (typeof element === "boolean") {
          return element;
        }
        return typeof element !== "string" ? NOT_CONSTANT : /^(t|true|y|yes|on|1)$/i.test(element) ? true : /^(f|false|n|no|off|0)$/i.test(element) ? false : NOT_CONSTANT;
      case "json":
        if (typeof element === "object" && "json" in element) {
          return (element as { json: unknown }).json;
        }
        try {
          return typeof element === "string" ? (JSON.parse(element) as unknown) : NOT_CONSTANT;
        } catch {
          return NOT_CONSTANT;
        }
      default:
        // Text, and what is stored as text: as it is written.
        return typeof element === "string" ? element : typeof element === "number" ? String(element) : NOT_CONSTANT;
    }
  }

  /** A constant as the value of a column, or `NOT_CONSTANT` when it does not fit the column. */
  #coerce(column: ModelColumn, value: unknown): unknown {
    if (column.canonical.kind === "array") {
      // PostgreSQL's array literal, or ARRAY[...]: an array, which the runtime stores as JSON. `{}` is the array without elements.
      // A default that is an array already (the column's type changes, and its default stays) is its elements.
      const elements = typeof value === "string" ? parseArrayLiteral(value) : isConstantArray(value) ? value.array : Array.isArray(value) ? value : undefined;
      return elements === undefined ? NOT_CONSTANT : this.#arrayElement(column.canonical.element, elements);
    }
    if (isConstantArray(value)) {
      return NOT_CONSTANT;
    }
    let candidate = value;
    if (typeof value === "object" && value !== null && "json" in value) {
      candidate = (value as { json: unknown }).json;
      if (column.type !== "json") {
        return NOT_CONSTANT;
      }
    } else if (column.type === "json" && typeof value === "string") {
      try {
        candidate = JSON.parse(value);
      } catch {
        return NOT_CONSTANT;
      }
    } else if (column.type === "boolean" && typeof value === "string") {
      candidate = /^(t|true|y|yes|on|1)$/i.test(value) ? true : /^(f|false|n|no|off|0)$/i.test(value) ? false : value;
    } else if ((column.type === "integer" || column.type === "real" || column.type === "numeric") && typeof value === "string" && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value)) {
      candidate = Number(value);
    } else if ((column.type === "text" || column.type === "any") && typeof value === "number") {
      candidate = column.type === "text" ? String(value) : value;
    } else if (column.type === "binary") {
      // bytea literals are hex text: '\x0102'.
      if (typeof value !== "string" || !/^\\x([0-9a-fA-F]{2})*$/.test(value)) {
        return NOT_CONSTANT;
      }
      candidate = Buffer.from(value.slice(2), "hex").toString("base64");
    }
    if (column.enumName !== undefined && !(this.#enums.get(column.enumName)?.values ?? []).includes(String(candidate))) {
      return NOT_CONSTANT;
    }
    try {
      toStoredValue({ name: column.name, type: column.type, nullable: true, primary: false }, candidate);
    } catch {
      return NOT_CONSTANT;
    }
    if ((column.type === "integer" || column.type === "real" || column.type === "numeric") && typeof candidate !== "number") {
      return NOT_CONSTANT;
    }
    if (column.type === "boolean" && typeof candidate !== "boolean") {
      return NOT_CONSTANT;
    }
    return candidate;
  }

  /** The source text of an expression's node: the whole expression, with the parentheses it starts with. `lists`: as `expressionText` takes it. */
  async #text(node: PgNode, stopWords: ReadonlySet<string> = new Set(), lists = 0): Promise<string> {
    const start = firstLocation(node);
    return start === undefined ? "" : expressionText(this.#file.bytes, start, this.#statement.end, stopWords, this.#statement.start, lists);
  }

  // --- constraints ----------------------------------------------------------

  /**
   * Adds the constraints of a statement in the order PostgreSQL names them:
   * checks (when the table is made), the primary key and unique constraints
   * (with their indexes, the primary key first), then foreign keys. In
   * `CREATE TABLE`, a unique constraint on the same columns as the primary
   * key or as an earlier one is left out, as PostgreSQL leaves it out.
   */
  async #addConstraints(table: ModelTable, entries: { constraint: PgNode; column?: string }[], kind: string, inCreateTable: boolean): Promise<void> {
    const keysOf = (entry: { constraint: PgNode; column?: string }): string[] => {
      const keys = nameList(entry.constraint.keys);
      return keys.length > 0 ? keys : entry.column === undefined ? [] : [entry.column];
    };
    for (const entry of entries.filter(({ constraint }) => constraint.contype === "CONSTR_CHECK")) {
      await this.#addCheck(table, entry.constraint, kind, inCreateTable);
    }
    const primary = entries.filter(({ constraint }) => constraint.contype === "CONSTR_PRIMARY");
    if (primary.length > 1 || (primary.length === 1 && table.primaryKey !== undefined)) {
      this.#fail(`multiple primary keys for table "${table.name}" are not allowed.`);
    }
    const keys: NewKey[] = [];
    for (const entry of [...primary, ...entries.filter(({ constraint }) => constraint.contype === "CONSTR_UNIQUE")]) {
      const isPrimary = entry.constraint.contype === "CONSTR_PRIMARY";
      if (entry.constraint.indexname !== undefined) {
        keys.push(this.#keyFromIndex(table, entry.constraint, isPrimary, inCreateTable));
        continue;
      }
      const columns = keysOf(entry);
      const including = nameList(entry.constraint.including);
      const nullsNotDistinct = entry.constraint.nulls_not_distinct === true;
      const deferrable = deferrableOf(entry.constraint);
      // What a key says of its index beyond its columns, which the schema has no place for.
      const sourceClauses = [
        ...((entry.constraint.options ?? []).length > 0 ? [`WITH (${optionsText(entry.constraint.options)})`] : []),
        ...(entry.constraint.indexspace !== undefined && entry.constraint.indexspace !== "" ? [`USING INDEX TABLESPACE ${entry.constraint.indexspace}`] : []),
        ...(entry.constraint.without_overlaps === true ? ["WITHOUT OVERLAPS"] : []),
      ];
      const earlier =
        inCreateTable && !isPrimary
          ? keys.find((key) => sameColumns(key.columns, columns) && sameColumns(key.including, including) && key.nullsNotDistinct === nullsNotDistinct && key.deferrable === deferrable && sourceClauses.length === 0 && key.sourceClauses.length === 0)
          : undefined;
      if (earlier !== undefined) {
        earlier.conname ??= entry.constraint.conname;
        this.#note("no-effect", "constraint", `The unique constraint on "${table.name}" (${columns.join(", ")}) repeats ${earlier.primary ? "the primary key" : "an earlier one"}; PostgreSQL creates one index for both.`, `${table.name}.${columns.join(",")}`, kind);
        continue;
      }
      keys.push({ ...(entry.constraint.conname !== undefined && { conname: entry.constraint.conname }), columns, including, primary: isPrimary, nullsNotDistinct, ...(deferrable !== undefined && { deferrable }), sourceClauses });
    }
    for (const key of keys) {
      key.including.forEach((name) => this.#column(table, name));
      const added = key.primary ? this.#addPrimaryKey(table, key) : this.#addUnique(table, key, kind);
      if (key.including.length > 0) {
        this.#note("retained", "constraint", `INCLUDE (${key.including.join(", ")}) of "${added.name}" lets PostgreSQL answer from the index alone; the columns are kept as what the key carries along, and are not part of the key.`, `${table.name}.${added.name}`, kind);
      }
      this.#noteClauses("constraint", `the constraint "${added.name}" of "${table.name}"`, key.sourceClauses, `${table.name}.${added.name}`, kind);
    }
    for (const entry of entries.filter(({ constraint }) => constraint.contype === "CONSTR_EXCLUSION")) {
      const name = entry.constraint.conname ?? "EXCLUDE";
      this.#note("unsupported", "constraint", `EXCLUDE constraint "${name}" is not reproduced locally.`, `${table.name}.${name}`, kind);
    }
    for (const entry of entries.filter(({ constraint }) => constraint.contype === "CONSTR_FOREIGN")) {
      const fkColumns = nameList(entry.constraint.fk_attrs);
      this.#addForeignKey(table, entry.constraint, fkColumns.length > 0 ? fkColumns : entry.column === undefined ? [] : [entry.column], kind, inCreateTable);
    }
  }

  /**
   * The words that follow a constraint in a column's definition (DEFERRABLE,
   * INITIALLY DEFERRED, NOT ENFORCED) are of that constraint. The parser
   * gives them as entries of their own; PostgreSQL then puts each on the
   * entry before it, when that is a constraint that can have it, and refuses
   * it otherwise. This does the same, with the same refusals.
   */
  #applyConstraintAttributes(constraints: PgNode[]): void {
    let last: PgNode | undefined;
    let sawDeferrability = false;
    let sawInitially = false;
    const target = (clause: string): PgNode => (last !== undefined && DEFERRABLE_CONSTRAINTS.has(last.contype) ? last : this.#fail(`misplaced ${clause} clause.`));
    const once = (seen: boolean, clauses: string): void => {
      if (seen) {
        this.#fail(`multiple ${clauses} clauses not allowed.`);
      }
    };
    for (const constraint of constraints) {
      switch (constraint.contype) {
        case "CONSTR_ATTR_DEFERRABLE": {
          const constrained = target("DEFERRABLE");
          once(sawDeferrability, "DEFERRABLE/NOT DEFERRABLE");
          sawDeferrability = true;
          constrained.deferrable = true;
          break;
        }
        case "CONSTR_ATTR_NOT_DEFERRABLE": {
          const constrained = target("NOT DEFERRABLE");
          once(sawDeferrability, "DEFERRABLE/NOT DEFERRABLE");
          sawDeferrability = true;
          constrained.deferrable = false;
          if (sawInitially && constrained.initdeferred === true) {
            this.#fail("constraint declared INITIALLY DEFERRED must be DEFERRABLE.");
          }
          break;
        }
        case "CONSTR_ATTR_DEFERRED": {
          const constrained = target("INITIALLY DEFERRED");
          once(sawInitially, "INITIALLY IMMEDIATE/DEFERRED");
          sawInitially = true;
          constrained.initdeferred = true;
          // INITIALLY DEFERRED alone says DEFERRABLE.
          if (!sawDeferrability) {
            constrained.deferrable = true;
          } else if (constrained.deferrable !== true) {
            this.#fail("constraint declared INITIALLY DEFERRED must be DEFERRABLE.");
          }
          break;
        }
        case "CONSTR_ATTR_IMMEDIATE": {
          const constrained = target("INITIALLY IMMEDIATE");
          once(sawInitially, "INITIALLY IMMEDIATE/DEFERRED");
          sawInitially = true;
          constrained.initdeferred = false;
          break;
        }
        case "CONSTR_ATTR_ENFORCED":
        case "CONSTR_ATTR_NOT_ENFORCED": {
          const enforced = constraint.contype === "CONSTR_ATTR_ENFORCED";
          if (last === undefined || (last.contype !== "CONSTR_CHECK" && last.contype !== "CONSTR_FOREIGN")) {
            this.#fail(`misplaced ${enforced ? "" : "NOT "}ENFORCED clause.`);
          }
          last.is_enforced = enforced;
          break;
        }
        default:
          last = constraint;
          sawDeferrability = false;
          sawInitially = false;
      }
    }
  }

  /**
   * A primary key or unique constraint made from an index that is there
   * (`ADD CONSTRAINT ... USING INDEX`): it is over the index's columns, and
   * the index is the constraint's own from here on, no longer an index of its
   * own. The constraint has the index's name unless the statement gives it
   * one, in which case PostgreSQL renames the index.
   */
  #keyFromIndex(table: ModelTable, constraint: PgNode, primary: boolean, inCreateTable: boolean): NewKey {
    const name = String(constraint.indexname);
    if (inCreateTable) {
      this.#fail("cannot use an existing index in CREATE TABLE.");
    }
    const index = this.#indexes.get(name);
    if (index === undefined) {
      const ofConstraint = [...this.#tables.values()].some((other) => ["primaryKey", "unique"].includes(this.#constraintNamed(other, name)?.kind ?? ""));
      return this.#fail(ofConstraint ? `index "${name}" is already associated with a constraint.` : `index "${name}" does not exist.`);
    }
    if (index.table !== table.name) {
      this.#fail(`index "${name}" does not belong to table "${table.name}".`);
    }
    if (!index.unique) {
      this.#fail(`"${name}" is not a unique index.`);
    }
    if (index.expressions.length > 0) {
      this.#fail(`index "${name}" contains expressions.`);
    }
    if (index.where !== undefined) {
      this.#fail(`"${name}" is a partial index.`);
    }
    // A key's index has its keys in the order every key has by itself: no direction, operator class, or collation of its own.
    const special = index.keys.findIndex((key) => key.order !== undefined || key.nulls !== undefined || key.operatorClass !== undefined || key.collation !== undefined);
    if (special >= 0) {
      this.#fail(`index "${name}" column number ${special + 1} does not have default sorting behavior.`);
    }
    this.#indexes.delete(name);
    this.#namespace.relations.delete(name);
    const conname = constraint.conname as string | undefined;
    const deferrable = deferrableOf(constraint);
    // A name the migrations wrote, for the constraint or for the index, is not one PostgreSQL chose.
    return {
      conname: conname ?? name,
      columns: [...index.columns],
      including: [...index.include],
      primary,
      nullsNotDistinct: index.nullsNotDistinct,
      ...(deferrable !== undefined && { deferrable }),
      // What the index said beyond what the schema holds is the constraint's now.
      sourceClauses: [...index.sourceClauses],
      generatedName: conname === undefined && index.origin.generatedName === true,
    };
  }

  /** What a key is beyond its name and columns, as the statement that adds it says. */
  #keyParts(key: NewKey): Pick<ModelKey, "include" | "deferrable" | "nullsNotDistinct" | "sourceClauses"> {
    return { include: [...key.including], ...(key.deferrable !== undefined && { deferrable: key.deferrable }), nullsNotDistinct: key.nullsNotDistinct, sourceClauses: [...key.sourceClauses] };
  }

  /** Reports the clauses of an object that are kept as text: what the schema holds of the object is not all the source says of it. */
  #noteClauses(category: ReportCategory, what: string, clauses: readonly string[], object: string, kind?: string): void {
    if (clauses.length > 0) {
      this.#note("retained", category, `${clauses.join(", ")} of ${what} is kept as text, and is not what the schema holds of the ${category === "index" ? "index" : "constraint"}: it is not written for another database from this schema.`, object, kind);
    }
  }

  #addPrimaryKey(table: ModelTable, key: NewKey): ModelKey {
    if (table.primaryKey !== undefined) {
      this.#fail(`multiple primary keys for table "${table.name}" are not allowed.`);
    }
    key.columns.forEach((column) => {
      this.#column(table, column).nullable = false;
    });
    const name = key.conname ?? chooseRelationName(this.#namespace, table.name, undefined, "pkey", true);
    this.#claimKeyName(name);
    table.primaryKey = { name, columns: [...key.columns], ...this.#keyParts(key), origin: this.#origin(name, key.generatedName ?? key.conname === undefined), renames: [] };
    return table.primaryKey;
  }

  #addUnique(table: ModelTable, key: NewKey, kind: string): ModelKey {
    key.columns.forEach((column) => this.#column(table, column));
    // The name is made from all the columns of the constraint's index, those it only carries along too.
    const name = key.conname ?? chooseRelationName(this.#namespace, table.name, nameAddition([...key.columns, ...key.including]), "key", true);
    this.#claimKeyName(name);
    const unique: ModelKey = { name, columns: [...key.columns], ...this.#keyParts(key), origin: this.#origin(name, key.generatedName ?? key.conname === undefined), renames: [] };
    table.uniques.push(unique);
    if (key.nullsNotDistinct) {
      this.#note("retained", "constraint", `NULLS NOT DISTINCT of "${name}" is not reproduced: the local constraint lets several rows hold NULL.`, `${table.name}.${name}`, kind);
    }
    return unique;
  }

  async #addCheck(table: ModelTable, constraint: PgNode, kind: string, inCreateTable: boolean): Promise<void> {
    // (A check is never deferrable: PostgreSQL's parser refuses the clause on one before anything of it gets here.)
    const expression = await this.#text(constraint.raw_expr ?? constraint);
    // PostgreSQL names a check after the one column it uses, if it uses one, wherever it was written.
    const columns = columnReferences(constraint.raw_expr).filter((name) => table.columns.some((column) => column.name === name));
    const name = constraint.conname ?? chooseConstraintName(this.#namespace, table.name, columns.length === 1 ? columns[0] : undefined, "check");
    this.#namespace.constraints.add(name);
    // The parser says of every check that it is enforced, and leaves that out of one that is not.
    const notEnforced = constraint.is_enforced !== true;
    const sourceClauses = [
      ...(constraint.is_no_inherit === true ? ["NO INHERIT"] : []),
      // A table that is being made has no rows: its constraints are valid from the start, whatever is said. One that is not enforced is not validated either, which is said once.
      ...(constraint.skip_validation === true && !inCreateTable && !notEnforced ? ["NOT VALID"] : []),
      ...(notEnforced ? ["NOT ENFORCED"] : []),
    ];
    table.checks.push({ name, expression, columns, names: this.#namesIn(constraint.raw_expr, table), sourceClauses, origin: this.#origin(name, constraint.conname === undefined), renames: [] });
    this.#noteClauses("constraint", `the check "${name}" of "${table.name}"`, sourceClauses, `${table.name}.${name}`, kind);
    this.#note("retained", "constraint", `Check constraint "${name}" (${expression}) is kept as information and not enforced locally.`, `${table.name}.${name}`, kind);
  }

  #addForeignKey(table: ModelTable, constraint: PgNode, columns: string[], kind: string, inCreateTable: boolean): void {
    columns.forEach((name) => this.#column(table, name));
    const targetName = this.#local(constraint.pktable);
    if (targetName === undefined) {
      const shown = constraint.conname ?? `${table.name}_${columns.join("_")}_fkey`;
      this.#note("not-reproduced", "other-schemas", `Foreign key "${shown}" refers to ${this.#qualified(constraint.pktable)}, in another schema; it is not reproduced, and the column takes any value.`, `${table.name}.${shown}`, kind);
      return;
    }
    const target = this.#table(targetName) as ModelTable;
    let refColumns = nameList(constraint.pk_attrs);
    if (refColumns.length === 0) {
      if (target.primaryKey === undefined) {
        this.#fail(`there is no primary key for referenced table "${targetName}".`);
      }
      if (this.#sure && target.primaryKey.deferrable !== undefined) {
        this.#fail(`cannot use a deferrable primary key for referenced table "${targetName}".`);
      }
      refColumns = [...target.primaryKey.columns];
    }
    refColumns.forEach((column) => this.#column(target, column));
    if (refColumns.length !== columns.length) {
      this.#fail(`number of referencing and referenced columns for foreign key "${constraint.conname ?? table.name}" disagree.`);
    }
    if (this.#sure && this.#keysOver(target, refColumns).length === 0) {
      // A key that is checked only at the end of a transaction is none to rest on.
      this.#fail(
        this.#keysOver(target, refColumns, true).length > 0
          ? `cannot use a deferrable unique constraint for referenced table "${targetName}".`
          : `there is no unique constraint matching given keys for referenced table "${targetName}".`,
      );
    }
    const name = constraint.conname ?? chooseConstraintName(this.#namespace, table.name, nameAddition(columns), "fkey");
    this.#namespace.constraints.add(name);
    const onDelete = ACTIONS[constraint.fk_del_action ?? "a"];
    const onUpdate = ACTIONS[constraint.fk_upd_action ?? "a"];
    const deferrable = deferrableOf(constraint);
    const setColumns = nameList(constraint.fk_del_set_cols);
    const sourceClauses = [
      ...(constraint.fk_matchtype === "f" ? ["MATCH FULL"] : constraint.fk_matchtype === "p" ? ["MATCH PARTIAL"] : []),
      ...(setColumns.length > 0 ? [`ON DELETE ${onDelete ?? "SET NULL"} (${setColumns.join(", ")})`] : []),
      // A table that is being made has no rows: its constraints are valid from the start, whatever is said. One that is not enforced is not validated either, which is said once. (The parser says of every foreign key that it is enforced, and leaves that out of one that is not.)
      ...(constraint.skip_validation === true && !inCreateTable && constraint.is_enforced === true ? ["NOT VALID"] : []),
      ...(constraint.is_enforced === true ? [] : ["NOT ENFORCED"]),
      ...(constraint.fk_with_period === true || constraint.pk_with_period === true ? ["PERIOD"] : []),
    ];
    table.foreignKeys.push({
      name,
      columns: [...columns],
      table: targetName,
      refColumns,
      ...(onDelete !== undefined && { onDelete }),
      ...(onUpdate !== undefined && { onUpdate }),
      ...(deferrable !== undefined && { deferrable }),
      sourceClauses,
      origin: this.#origin(name, constraint.conname === undefined),
      renames: [],
    });
    this.#noteClauses("constraint", `the foreign key "${name}" of "${table.name}"`, sourceClauses, `${table.name}.${name}`, kind);
  }

  /** The constraint of a table with this name, of any kind. */
  #constraintNamed(table: ModelTable, name: string): { kind: "primaryKey" | "unique" | "foreignKey" | "check"; object: Tracked } | undefined {
    if (table.primaryKey?.name === name) {
      return { kind: "primaryKey", object: table.primaryKey };
    }
    const unique = table.uniques.find((entry) => entry.name === name);
    if (unique !== undefined) {
      return { kind: "unique", object: unique };
    }
    const foreignKey = table.foreignKeys.find((entry) => entry.name === name);
    if (foreignKey !== undefined) {
      return { kind: "foreignKey", object: foreignKey };
    }
    const check = table.checks.find((entry) => entry.name === name);
    return check === undefined ? undefined : { kind: "check", object: check };
  }

  /** Removes a constraint by name; `false` when the table has none of that name. */
  #dropConstraint(table: ModelTable, name: string): boolean {
    const found = this.#constraintNamed(table, name);
    if (found === undefined) {
      return false;
    }
    if (found.kind === "primaryKey") {
      delete table.primaryKey;
      this.#releaseKeyName(name);
    } else if (found.kind === "unique") {
      table.uniques = table.uniques.filter((entry) => entry !== found.object);
      this.#releaseKeyName(name);
    } else if (found.kind === "foreignKey") {
      table.foreignKeys = table.foreignKeys.filter((entry) => entry !== found.object);
      this.#namespace.constraints.delete(name);
    } else {
      table.checks = table.checks.filter((entry) => entry !== found.object);
      this.#namespace.constraints.delete(name);
    }
    return true;
  }

  /** Foreign keys of other tables (and of the table itself) that refer to `table`, optionally to one of its columns. */
  #referencesTo(table: string, column?: string): { owner: ModelTable; key: ModelForeignKey }[] {
    return [...this.#tables.values()].flatMap((owner) =>
      owner.foreignKeys.filter((key) => key.table === table && (column === undefined || key.refColumns.includes(column))).map((key) => ({ owner, key })),
    );
  }

  // --- ALTER TABLE ----------------------------------------------------------

  async #alterTable(node: PgNode): Promise<void> {
    const commands = ((node.cmds ?? []) as PgNode[]).map((command) => command.AlterTableCmd as PgNode);
    const objectType = node.objtype ?? "OBJECT_TABLE";
    if (objectType !== "OBJECT_TABLE") {
      const what = String(objectType).replace("OBJECT_", "").toLowerCase();
      return this.#note(what === "index" ? "no-effect" : "unsupported", what === "view" || what === "matview" ? "views" : what === "sequence" ? "sequences" : "other", `ALTER ${what.toUpperCase()} ${this.#qualified(node.relation)} is not applied locally.`, this.#qualified(node.relation));
    }
    const name = this.#local(node.relation);
    if (name === undefined) {
      return this.#note("not-reproduced", "other-schemas", `${this.#qualified(node.relation)} is in another schema than public; the change is not reproduced.`, this.#qualified(node.relation));
    }
    const table = this.#table(name, node.missing_ok === true);
    if (table === undefined) {
      return this.#note("no-effect", "table", `Table "${name}" does not exist (IF EXISTS); nothing done.`, name);
    }
    for (const command of commands) {
      await this.#alterCommand(table, command);
    }
  }

  async #alterCommand(table: ModelTable, command: PgNode): Promise<void> {
    const kind = `AlterTableStmt/${command.subtype}`;
    const columnName = command.name as string | undefined;
    const object = columnName === undefined ? table.name : `${table.name}.${columnName}`;
    switch (command.subtype) {
      case "AT_AddColumn": {
        const definition = command.def?.ColumnDef as PgNode;
        const name = String(definition?.colname);
        if (table.columns.some((column) => column.name === name) && command.missing_ok) {
          return this.#note("no-effect", "column", `Column "${table.name}"."${name}" exists already (IF NOT EXISTS).`, `${table.name}.${name}`, kind);
        }
        const constraints = await this.#addColumn(table, definition, kind);
        await this.#addConstraints(table, constraints, kind, false);
        const column = this.#column(table, name);
        const rows = this.#seeds.get(table.name) ?? [];
        if (rows.length > 0 && !column.nullable && column.default === undefined && column.defaultFunction === undefined && column.numbering === undefined) {
          this.#fail(`column "${name}" of relation "${table.name}" contains null values: the table has rows, and the new NOT NULL column has no default.`);
        }
        return this.#note("applied", "column", `Added column "${table.name}"."${name}" (${column.declaredType}${column.nullable ? "" : ", not null"}).`, `${table.name}.${name}`, kind);
      }
      case "AT_DropColumn": {
        const name = columnName as string;
        if (!table.columns.some((column) => column.name === name)) {
          if (command.missing_ok) {
            return this.#note("no-effect", "column", `Column "${table.name}"."${name}" does not exist (IF EXISTS); nothing done.`, object, kind);
          }
          this.#column(table, name);
        }
        this.#dropColumn(table, name, command.behavior === "DROP_CASCADE");
        return this.#note("applied", "column", `Dropped column "${table.name}"."${name}".`, object, kind);
      }
      case "AT_AlterColumnType": {
        const column = this.#column(table, columnName as string);
        const typeName = (command.def?.ColumnDef?.typeName ?? {}) as PgNode;
        const info = columnType(typeName, new Set(this.#enums.keys()));
        // The enumerated type the column's values, or its elements, were of, and the one they are of now.
        const [enumWas, enumIs] = [enumIn(column.canonical), enumIn(info.canonical)];
        const hasDefault = column.default !== undefined || column.defaultExpression !== undefined;
        if (this.#sure && column.numbering === "identity" && info.canonical.kind !== "integer") {
          this.#fail("identity column type must be smallint, integer, or bigint.");
        }
        // PostgreSQL converts a default with its column, and has no conversion from one enumerated type to another.
        if (this.#sure && hasDefault && enumWas !== undefined && enumIs !== undefined && enumWas !== enumIs) {
          this.#fail(`default for column "${column.name}" cannot be cast automatically to type ${info.dialectType}.`);
        }
        column.type = info.type;
        column.canonical = info.canonical;
        column.dialectType = info.dialectType;
        column.declaredType = (await this.#typeSpelling(typeName)) ?? info.dialectType;
        if (info.enumName !== undefined) {
          column.enumName = info.enumName;
        } else {
          delete column.enumName;
        }
        if (column.default !== undefined && this.#coerce(column, column.default) === NOT_CONSTANT) {
          delete column.default;
        }
        // A default that stays is still the value of the type it was written as.
        if (enumWas !== undefined && enumWas !== enumIs && (column.default !== undefined || column.defaultExpression !== undefined)) {
          column.defaultRestsOn ??= enumWas;
        }
        return this.#note("applied", "column", `"${table.name}"."${column.name}" is now ${column.declaredType}.`, object, kind);
      }
      case "AT_ColumnDefault": {
        const column = this.#column(table, columnName as string);
        if (column.numbering === "identity") {
          // PostgreSQL: use ALTER COLUMN ... DROP IDENTITY instead.
          this.#fail(`column "${column.name}" of relation "${table.name}" is an identity column.`);
        }
        if (command.def === undefined) {
          this.#clearDefault(column);
          return this.#note("applied", "column", `Dropped the default of "${table.name}"."${column.name}".`, object, kind);
        }
        await this.#setDefault(table, column, command.def, command.def, kind);
        return this.#note("applied", "column", `Set the default of "${table.name}"."${column.name}".`, object, kind);
      }
      case "AT_SetNotNull":
      case "AT_DropNotNull": {
        const column = this.#column(table, columnName as string);
        column.nullable = command.subtype === "AT_DropNotNull";
        return this.#note("applied", "column", `"${table.name}"."${column.name}" is ${column.nullable ? "nullable" : "not null"}.`, object, kind);
      }
      case "AT_AddIdentity": {
        const column = this.#column(table, columnName as string);
        const shown = `column "${column.name}" of relation "${table.name}"`;
        if (column.nullable) {
          this.#fail(`${shown} must be declared NOT NULL before identity can be added.`);
        }
        if (column.numbering === "identity") {
          this.#fail(`${shown} is already an identity column.`);
        }
        if (this.#hasDefault(column)) {
          this.#fail(`${shown} already has a default value.`);
        }
        column.numbering = "identity";
        column.identitySequence = this.#newSequence(table, column);
        return this.#note("applied", "column", `"${table.name}"."${column.name}" is an identity column.`, object, kind);
      }
      case "AT_DropIdentity": {
        const column = this.#column(table, columnName as string);
        if (column.numbering !== "identity") {
          if (command.missing_ok) {
            return this.#note("no-effect", "column", `"${table.name}"."${column.name}" is not an identity column (IF EXISTS); nothing done.`, object, kind);
          }
          this.#fail(`column "${column.name}" of relation "${table.name}" is not an identity column.`);
        }
        delete column.numbering;
        if (column.identitySequence !== undefined) {
          this.#namespace.relations.delete(column.identitySequence);
          delete column.identitySequence;
        }
        return this.#note("applied", "column", `"${table.name}"."${column.name}" is no longer an identity column.`, object, kind);
      }
      case "AT_AddConstraint": {
        const constraint = command.def?.Constraint as PgNode;
        const before = new Set([table.primaryKey?.name, ...table.uniques.map((entry) => entry.name), ...table.foreignKeys.map((entry) => entry.name)]);
        await this.#addConstraints(table, [{ constraint }], kind, false);
        const added = [table.primaryKey, ...table.uniques, ...table.foreignKeys].find((entry) => entry !== undefined && !before.has(entry.name));
        if (added !== undefined) {
          this.#note("applied", "constraint", `Added constraint "${added.name}" to "${table.name}"${added.origin.generatedName ? " (named by PostgreSQL)" : ""}.`, `${table.name}.${added.name}`, kind);
        }
        return;
      }
      case "AT_DropConstraint": {
        const name = columnName as string;
        const found = this.#constraintNamed(table, name);
        // A key goes when no foreign key rests on it, or with those that do.
        const withIt =
          found !== undefined && (found.kind === "primaryKey" || found.kind === "unique")
            ? this.#releaseKey(table, found.object as ModelKey, command.behavior === "DROP_CASCADE", { refused: `constraint "${name}" on table "${table.name}"`, dropped: `constraint "${name}" of "${table.name}"` })
            : [];
        if (!this.#dropConstraint(table, name)) {
          if (command.missing_ok) {
            return this.#note("no-effect", "constraint", `Constraint "${name}" of "${table.name}" does not exist (IF EXISTS); nothing done.`, object, kind);
          }
          this.#fail(`constraint "${name}" of relation "${table.name}" does not exist.`);
        }
        return this.#note("applied", "constraint", `Dropped constraint "${name}" of "${table.name}"${withIt.length === 0 ? "" : `, and with it the foreign keys that rest on it: ${withIt.join(", ")}`}.`, object, kind);
      }
      case "AT_ValidateConstraint": {
        // A constraint that was added without being checked (NOT VALID) is one like any other from here on.
        const validated = this.#constraintNamed(table, String(columnName))?.object as { sourceClauses?: string[] } | undefined;
        if (validated?.sourceClauses !== undefined) {
          validated.sourceClauses = validated.sourceClauses.filter((clause) => clause !== "NOT VALID");
        }
        return this.#note("no-effect", "constraint", `VALIDATE CONSTRAINT "${columnName}": constraints are checked locally as rows are written.`, object, kind);
      }
      case "AT_AlterConstraint": {
        const change = (command.def?.ATAlterConstraint ?? {}) as PgNode;
        const name = String(change.conname);
        const found = this.#constraintNamed(table, name);
        if (found === undefined) {
          return this.#fail(`constraint "${name}" of relation "${table.name}" does not exist.`);
        }
        // PostgreSQL changes these of a foreign key, and of no other constraint.
        if (found.kind !== "foreignKey") {
          return this.#fail(`constraint "${name}" of relation "${table.name}" is not a foreign key constraint.`);
        }
        const key = found.object as ModelForeignKey;
        if (change.alterDeferrability === true) {
          const deferrable = deferrableOf(change);
          if (deferrable === undefined) {
            delete key.deferrable;
          } else {
            key.deferrable = deferrable;
          }
        }
        if (change.alterEnforceability === true) {
          // The parser says that a constraint is to be enforced, and leaves that out of one that is not to be.
          key.sourceClauses = [...key.sourceClauses.filter((clause) => clause !== "NOT ENFORCED"), ...(change.is_enforced === true ? [] : ["NOT ENFORCED"])];
        }
        return this.#note("applied", "constraint", `Changed constraint "${name}" of "${table.name}": ${key.deferrable === undefined ? "not deferrable" : `deferrable, initially ${key.deferrable}`}.`, `${table.name}.${name}`, kind);
      }
      case "AT_EnableRowSecurity":
      case "AT_DisableRowSecurity":
      case "AT_ForceRowSecurity":
      case "AT_NoForceRowSecurity":
        return this.#note("not-reproduced", "row-level-security", `Row level security of "${table.name}" is not reproduced locally: every client reads and writes every row.`, table.name, kind);
      case "AT_ChangeOwner":
        return this.#note("not-reproduced", "permissions", `The owner of "${table.name}" is not reproduced locally.`, table.name, kind);
      case "AT_EnableTrig":
      case "AT_DisableTrig":
      case "AT_EnableAlwaysTrig":
      case "AT_EnableReplicaTrig":
      case "AT_EnableTrigAll":
      case "AT_DisableTrigAll":
      case "AT_EnableTrigUser":
      case "AT_DisableTrigUser":
        return this.#note("not-reproduced", "triggers", `Triggers of "${table.name}" are not reproduced locally.`, table.name, kind);
      case "AT_ReplicaIdentity":
        return this.#note("not-reproduced", "replication", `The replica identity of "${table.name}" is not reproduced locally.`, table.name, kind);
      case "AT_SetStatistics":
      case "AT_SetStorage":
      case "AT_SetCompression":
      case "AT_SetOptions":
      case "AT_ResetOptions":
      case "AT_SetRelOptions":
      case "AT_ResetRelOptions":
      case "AT_ClusterOn":
      case "AT_DropCluster":
      case "AT_SetLogged":
      case "AT_SetUnLogged":
      case "AT_SetTableSpace":
        return this.#note("no-effect", "table", `A storage setting of "${table.name}"; no effect on the collected schema.`, object, kind);
      default:
        return this.#note("unsupported", "table", `${String(command.subtype).replace("AT_", "")} of "${table.name}" is not handled by the collector.`, object, kind);
    }
  }

  #dropColumn(table: ModelTable, name: string, cascade: boolean): void {
    const referencing = this.#referencesTo(table.name, name).filter(({ owner }) => owner !== table || !owner.foreignKeys.some((key) => key.columns.includes(name)));
    if (referencing.length > 0 && !cascade) {
      this.#fail(`cannot drop column "${name}" of table "${table.name}" because other objects depend on it (foreign key "${referencing[0]?.key.name}"). Use CASCADE.`);
    }
    for (const { owner, key } of referencing) {
      owner.foreignKeys.splice(owner.foreignKeys.indexOf(key), 1);
      this.#namespace.constraints.delete(key.name);
    }
    const column = this.#column(table, name);
    this.#releaseSequences(column);
    table.columns = table.columns.filter((entry) => entry !== column);
    // A key goes with a column of it, and with a column its index only carries along.
    const usesIt = (key: ModelKey): boolean => key.columns.includes(name) || key.include.includes(name);
    if (table.primaryKey !== undefined && usesIt(table.primaryKey)) {
      this.#releaseKeyName(table.primaryKey.name);
      delete table.primaryKey;
    }
    for (const unique of table.uniques.filter(usesIt)) {
      this.#releaseKeyName(unique.name);
    }
    table.uniques = table.uniques.filter((entry) => !usesIt(entry));
    for (const key of table.foreignKeys.filter((entry) => entry.columns.includes(name))) {
      this.#namespace.constraints.delete(key.name);
    }
    table.foreignKeys = table.foreignKeys.filter((entry) => !entry.columns.includes(name));
    for (const check of table.checks.filter((entry) => entry.columns.includes(name))) {
      this.#namespace.constraints.delete(check.name);
    }
    table.checks = table.checks.filter((entry) => !entry.columns.includes(name));
    // An index goes with a column of its key, of what it carries along, of one of its expressions, or of its condition.
    for (const [indexName, index] of this.#indexes) {
      if (index.table === table.name && (index.columns.includes(name) || index.include.includes(name) || index.names.columns.some((entry) => entry.column === column))) {
        this.#indexes.delete(indexName);
        this.#namespace.relations.delete(indexName);
      }
    }
    for (const row of this.#seeds.get(table.name) ?? []) {
      delete row[name];
    }
  }

  // --- RENAME ---------------------------------------------------------------

  #rename(node: PgNode): void {
    const newName = String(node.newname);
    switch (node.renameType) {
      case "OBJECT_COLUMN": {
        const name = this.#local(node.relation);
        if (name === undefined) {
          return this.#note("not-reproduced", "other-schemas", `${this.#qualified(node.relation)} is in another schema than public; the rename is not reproduced.`);
        }
        const table = this.#table(name, node.missing_ok === true);
        if (table === undefined) {
          return this.#note("no-effect", "table", `Table "${name}" does not exist (IF EXISTS); nothing done.`, name);
        }
        const oldName = String(node.subname);
        const column = this.#column(table, oldName);
        if (table.columns.some((other) => other.name === newName)) {
          this.#fail(`column "${newName}" of relation "${table.name}" already exists.`);
        }
        this.#renamed(column, newName);
        const rename = (names: string[]): string[] => names.map((entry) => (entry === oldName ? newName : entry));
        for (const key of [...(table.primaryKey === undefined ? [] : [table.primaryKey]), ...table.uniques]) {
          key.columns = rename(key.columns);
          key.include = rename(key.include);
        }
        table.foreignKeys.forEach((key) => (key.columns = rename(key.columns)));
        table.checks.forEach((check) => (check.columns = rename(check.columns)));
        for (const { key } of this.#referencesTo(table.name, oldName)) {
          key.refColumns = rename(key.refColumns);
        }
        for (const index of this.#indexes.values()) {
          if (index.table === table.name) {
            index.columns = rename(index.columns);
            index.include = rename(index.include);
            index.keys = index.keys.map((key) => (key.column === oldName ? { ...key, column: newName } : key));
          }
        }
        for (const row of this.#seeds.get(table.name) ?? []) {
          if (Object.hasOwn(row, oldName)) {
            row[newName] = row[oldName];
            delete row[oldName];
          }
        }
        this.#note("applied", "column", `Renamed "${table.name}"."${oldName}" to "${newName}".`, `${table.name}.${newName}`);
        // PostgreSQL has the column itself in an expression. The schema has the text, which still says the name it was written with.
        return this.#noteLeftBehind(newName, (names, owner) => (owner === table ? names.columns.find((entry) => entry.column === column)?.name : undefined));
      }
      case "OBJECT_TABLE": {
        const name = this.#local(node.relation);
        if (name === undefined) {
          return this.#note("not-reproduced", "other-schemas", `${this.#qualified(node.relation)} is in another schema than public; the rename is not reproduced.`);
        }
        const table = this.#table(name, node.missing_ok === true);
        if (table === undefined) {
          return this.#note("no-effect", "table", `Table "${name}" does not exist (IF EXISTS); nothing done.`, name);
        }
        if (this.#namespace.relations.has(newName)) {
          this.#fail(`relation "${newName}" already exists.`);
        }
        this.#typeNameFree(newName);
        // In its place: the order of the tables is the order they were created in.
        const order = [...this.#tables];
        this.#tables.clear();
        for (const [key, value] of order) {
          this.#tables.set(key === name ? newName : key, value);
        }
        this.#renamed(table, newName);
        this.#namespace.relations.delete(name);
        this.#namespace.relations.add(newName);
        for (const owner of this.#tables.values()) {
          owner.foreignKeys.forEach((key) => (key.table = key.table === name ? newName : key.table));
        }
        for (const index of this.#indexes.values()) {
          index.table = index.table === name ? newName : index.table;
        }
        const rows = this.#seeds.get(name);
        if (rows !== undefined) {
          this.#seeds.delete(name);
          this.#seeds.set(newName, rows);
        }
        // PostgreSQL keeps the names of the table's constraints, indexes, and sequences.
        this.#note("applied", "table", `Renamed table "${name}" to "${newName}".`, newName);
        return this.#noteLeftBehind(newName, (names, owner) => (owner === table ? names.table : undefined));
      }
      case "OBJECT_TABCONSTRAINT": {
        const name = this.#local(node.relation);
        const table = name === undefined ? undefined : this.#table(name);
        if (table === undefined) {
          return this.#note("not-reproduced", "other-schemas", `${this.#qualified(node.relation)} is in another schema than public; the rename is not reproduced.`);
        }
        const oldName = String(node.subname);
        const found = this.#constraintNamed(table, oldName);
        if (found === undefined) {
          return this.#fail(`constraint "${oldName}" for table "${table.name}" does not exist.`);
        }
        this.#renameConstraint(found.kind, found.object, newName);
        return this.#note("applied", "constraint", `Renamed constraint "${oldName}" of "${table.name}" to "${newName}".`, `${table.name}.${newName}`);
      }
      case "OBJECT_INDEX": {
        const oldName = String(node.relation?.relname);
        const index = this.#indexes.get(oldName);
        if (index !== undefined) {
          const order = [...this.#indexes];
          this.#indexes.clear();
          for (const [key, value] of order) {
            this.#indexes.set(key === oldName ? newName : key, value);
          }
          this.#renamed(index, newName);
          this.#namespace.relations.delete(oldName);
          this.#namespace.relations.add(newName);
          return this.#note("applied", "index", `Renamed index "${oldName}" to "${newName}".`, newName);
        }
        // The index of a primary key or unique constraint has the constraint's name; renaming one renames the other.
        for (const table of this.#tables.values()) {
          const found = this.#constraintNamed(table, oldName);
          if (found !== undefined && (found.kind === "primaryKey" || found.kind === "unique")) {
            this.#renameConstraint(found.kind, found.object, newName);
            return this.#note("applied", "constraint", `Renamed the index of constraint "${oldName}" (and the constraint) to "${newName}".`, `${table.name}.${newName}`);
          }
        }
        if (node.missing_ok) {
          return this.#note("no-effect", "index", `Index "${oldName}" does not exist (IF EXISTS); nothing done.`, oldName);
        }
        return this.#fail(`relation "${oldName}" does not exist.`);
      }
      case "OBJECT_TYPE": {
        const parts = nameList(node.object?.List?.items);
        const oldName = parts.at(-1) ?? "";
        if (!this.#isLocalType(parts)) {
          return this.#note("not-reproduced", "other-schemas", `The type ${parts.join(".")} is in another schema than public; the rename is not reproduced.`, parts.join("."));
        }
        const type = this.#enums.get(oldName);
        if (type === undefined) {
          this.#note("unsupported", "type", `Renaming the type "${oldName}" is not handled: it is not an enumerated type the collector knows.`, oldName);
          return this.#otherTypeRenamed(oldName, newName);
        }
        if (this.#enums.has(newName)) {
          this.#fail(`type "${newName}" already exists.`);
        }
        this.#typeNameFree(newName);
        const order = [...this.#enums];
        this.#enums.clear();
        for (const [key, value] of order) {
          this.#enums.set(key === oldName ? newName : key, value);
        }
        this.#renamed(type, newName);
        for (const table of this.#tables.values()) {
          for (const column of table.columns) {
            const canonical = renameEnumIn(column.canonical, oldName, newName);
            if (canonical !== column.canonical) {
              column.canonical = canonical;
              // The spelling the migration used names a type that is no longer called that.
              column.dialectType = canonical.kind === "array" ? `${newName}[]` : newName;
              column.declaredType = column.dialectType;
            }
            if (column.enumName === oldName) {
              column.enumName = newName;
            }
            if (column.defaultRestsOn === oldName) {
              column.defaultRestsOn = newName;
            }
          }
        }
        this.#note("applied", "type", `Renamed type "${oldName}" to "${newName}".`, newName);
        return this.#noteLeftBehind(newName, (names) => names.types.find((entry) => entry.type === type)?.name);
      }
      case "OBJECT_POLICY":
        return this.#note("not-reproduced", "row-level-security", "Row level security policies are not reproduced locally.");
      case "OBJECT_FUNCTION":
      case "OBJECT_PROCEDURE":
      case "OBJECT_ROUTINE":
      case "OBJECT_AGGREGATE": {
        this.#note("not-reproduced", "functions", "Functions are not created locally.");
        const oldName = nameList(node.object?.ObjectWithArgs?.objname).at(-1);
        if (oldName === undefined) {
          return;
        }
        // An expression that calls the function has it under its new name in PostgreSQL. Functions are not kept here, so every call of that name is taken to be of this one.
        for (const { names } of this.#expressions()) {
          for (const entry of names.functions) {
            if (entry.now === oldName) {
              entry.now = newName;
            }
          }
        }
        return this.#noteLeftBehind(newName, (names) => names.functions.find((entry) => entry.now === newName)?.name);
      }
      case "OBJECT_DOMAIN": {
        this.#note("unsupported", "other", "Renaming a domain is not handled by the collector.");
        const parts = nameList(node.object?.List?.items);
        const oldName = parts.at(-1);
        return oldName === undefined || !this.#isLocalType(parts) ? undefined : this.#otherTypeRenamed(oldName, newName);
      }
      case "OBJECT_TRIGGER":
        return this.#note("not-reproduced", "triggers", "Triggers are not created locally.");
      case "OBJECT_SCHEMA":
        return this.#note("not-reproduced", "other-schemas", "Only the public schema is collected.");
      case "OBJECT_VIEW":
      case "OBJECT_MATVIEW":
        return this.#note("not-reproduced", "views", "Views are not created locally.");
      case "OBJECT_SEQUENCE":
        return this.#note("not-reproduced", "sequences", "Sequences are not created locally.");
      default:
        return this.#note("unsupported", "other", `Renaming a ${String(node.renameType).replace("OBJECT_", "").toLowerCase()} is not handled by the collector.`);
    }
  }

  /**
   * A type that is not enumerated (a domain, a type of several parts) is
   * renamed. Such types are not kept here, so every cast to that name is
   * taken to be to this one: PostgreSQL has it under its new name.
   */
  #otherTypeRenamed(oldName: string, newName: string): void {
    for (const { names } of this.#expressions()) {
      for (const entry of names.otherTypes) {
        if (entry.now === oldName) {
          entry.now = newName;
        }
      }
    }
    this.#noteLeftBehind(newName, (names) => names.otherTypes.find((entry) => entry.now === newName)?.name);
  }

  #renameConstraint(kind: "primaryKey" | "unique" | "foreignKey" | "check", object: Tracked, newName: string): void {
    const oldName = object.name;
    if (kind === "primaryKey" || kind === "unique") {
      this.#releaseKeyName(oldName);
      this.#claimKeyName(newName);
    } else {
      this.#namespace.constraints.delete(oldName);
      this.#namespace.constraints.add(newName);
    }
    this.#renamed(object, newName);
  }

  // --- DROP -----------------------------------------------------------------

  #drop(node: PgNode): void {
    const cascade = node.behavior === "DROP_CASCADE";
    const objects = (node.objects ?? []) as PgNode[];
    const qualifiedNames = (object: PgNode): string[] => nameList(object.List?.items ?? (object.String !== undefined ? [object] : object.TypeName?.names));
    switch (node.removeType) {
      case "OBJECT_TABLE":
        for (const object of objects) {
          const parts = qualifiedNames(object);
          const name = parts.at(-1) ?? "";
          // A temporary table: named in pg_temp, or by a name alone that one has.
          if (parts.at(-2) === "pg_temp" || (parts.length === 1 && this.#temporary.has(name))) {
            if (this.#dropTemporary(name)) {
              this.#note("not-reproduced", "temporary-tables", `Dropped the temporary table "${name}", which was not created locally.`, name);
            } else if (node.missing_ok) {
              this.#note("no-effect", "temporary-tables", `The temporary table "${name}" does not exist (IF EXISTS); nothing done.`, name);
            } else {
              this.#fail(`table "${name}" does not exist.`);
            }
            continue;
          }
          if (parts.length > 1 && parts[0] !== "public") {
            this.#note("not-reproduced", "other-schemas", `${parts.join(".")} is in another schema than public; dropping it is not reproduced.`, parts.join("."));
            continue;
          }
          const table = this.#table(name, node.missing_ok === true);
          if (table === undefined) {
            this.#note("no-effect", "table", `Table "${name}" does not exist (IF EXISTS); nothing done.`, name);
            continue;
          }
          const referencing = this.#referencesTo(name).filter(({ owner }) => owner !== table);
          if (referencing.length > 0 && !cascade) {
            this.#fail(`cannot drop table "${name}" because other objects depend on it (foreign key "${referencing[0]?.key.name}" of "${referencing[0]?.owner.name}"). Use CASCADE.`);
          }
          for (const { owner, key } of referencing) {
            owner.foreignKeys.splice(owner.foreignKeys.indexOf(key), 1);
            this.#namespace.constraints.delete(key.name);
          }
          this.#tables.delete(name);
          this.#seeds.delete(name);
          this.#namespace.relations.delete(name);
          for (const key of [table.primaryKey, ...table.uniques].filter((entry) => entry !== undefined)) {
            this.#releaseKeyName(key.name);
          }
          for (const entry of [...table.foreignKeys, ...table.checks]) {
            this.#namespace.constraints.delete(entry.name);
          }
          table.columns.forEach((column) => this.#releaseSequences(column));
          for (const [indexName, index] of this.#indexes) {
            if (index.table === name) {
              this.#indexes.delete(indexName);
              this.#namespace.relations.delete(indexName);
            }
          }
          this.#note("applied", "table", `Dropped table "${name}".`, name);
        }
        return;
      case "OBJECT_INDEX":
        for (const object of objects) {
          const parts = qualifiedNames(object);
          const name = parts.at(-1) ?? "";
          if (parts.length <= 2 && this.#temporaryIndex(parts.at(-2), name) !== undefined) {
            const table = this.#temporaryIndexes.get(name) as string;
            this.#temporaryIndexes.delete(name);
            this.#note("not-reproduced", "temporary-tables", `Dropped the index "${name}" of the temporary table "${table}", which was not created locally.`, name);
            continue;
          }
          const index = this.#indexes.get(name);
          if (index !== undefined) {
            // A unique index goes when no foreign key rests on it, or with those that do.
            const owner = this.#tables.get(index.table);
            const withIt = owner === undefined ? [] : this.#releaseKey(owner, index, cascade, { refused: `index "${name}"`, dropped: `index "${name}"` });
            this.#indexes.delete(name);
            this.#namespace.relations.delete(name);
            this.#note("applied", "index", `Dropped index "${name}"${withIt.length === 0 ? "" : `, and with it the foreign keys that rest on it: ${withIt.join(", ")}`}.`, name);
          } else if (node.missing_ok) {
            this.#note("no-effect", "index", `Index "${name}" does not exist (IF EXISTS); nothing done.`, name);
          } else {
            this.#fail(`index "${name}" does not exist.`);
          }
        }
        return;
      case "OBJECT_TYPE":
        for (const object of objects) {
          const parts = qualifiedNames(object);
          const name = parts.at(-1) ?? "";
          if (!this.#isLocalType(parts)) {
            this.#note("not-reproduced", "other-schemas", `The type ${parts.join(".")} is in another schema than public; dropping it is not reproduced.`, parts.join("."));
            continue;
          }
          if (!this.#enums.has(name)) {
            if (node.missing_ok) {
              this.#note("no-effect", "type", `Type "${name}" does not exist (IF EXISTS); nothing done.`, name);
            } else {
              this.#note("unsupported", "type", `Dropping the type "${name}" is not handled: it is not an enumerated type the collector knows.`, name);
            }
            continue;
          }
          const users = [...this.#tables.values()].flatMap((table) =>
            table.columns.filter((column) => column.enumName === name || renameEnumIn(column.canonical, name, `${name}\0`) !== column.canonical).map((column) => `${table.name}.${column.name}`),
          );
          if (users.length > 0) {
            if (!cascade) {
              this.#fail(`cannot drop type "${name}" because other objects depend on it (column ${users[0]}).`);
            }
            this.#note("unsupported", "type", `DROP TYPE ... CASCADE would drop the columns ${users.join(", ")}; the collector keeps them and leaves the type.`, name);
            continue;
          }
          // A default that was a value of the type still rests on it, though its column is of another type by now.
          const resting = [...this.#tables.values()].flatMap((table) => table.columns.filter((column) => column.defaultRestsOn === name).map((column) => ({ table, column })));
          const [first] = resting;
          if (first !== undefined && !cascade && this.#sure) {
            this.#fail(`cannot drop type "${name}" because other objects depend on it (the default of column ${first.table.name}.${first.column.name}).`);
          }
          for (const { column } of resting) {
            // With CASCADE the default goes with the type.
            if (cascade) {
              this.#clearDefault(column);
            }
            delete column.defaultRestsOn;
          }
          const dropped = this.#enums.get(name);
          this.#enums.delete(name);
          this.#note("applied", "type", `Dropped type "${name}"${cascade && resting.length > 0 ? `, and with it the defaults that were values of it: ${resting.map(({ table, column }) => `${table.name}.${column.name}`).join(", ")}` : ""}.`, name);
          // An expression that casts to the type depends on it in PostgreSQL. Which expressions those are is known here; that they go with it is not reproduced.
          for (const { names, what, object, category } of this.#expressions()) {
            if (names.types.some((entry) => entry.type === dropped)) {
              const it = category === "constraint" ? "the check" : category === "index" ? "the index" : "the default";
              this.#note("unsupported", category, `${what} casts to the type "${name}", which is dropped: PostgreSQL refuses that, or drops ${it} with it (CASCADE). It is kept, and what its text names is not known from here on.`, object);
            }
          }
        }
        return;
      case "OBJECT_POLICY":
        return this.#note("not-reproduced", "row-level-security", "Row level security policies are not reproduced locally.");
      case "OBJECT_FUNCTION":
      case "OBJECT_PROCEDURE":
      case "OBJECT_AGGREGATE":
        return this.#note("not-reproduced", "functions", "Functions are not created locally.");
      case "OBJECT_TRIGGER":
      case "OBJECT_EVENT_TRIGGER":
        return this.#note("not-reproduced", "triggers", "Triggers are not created locally.");
      case "OBJECT_EXTENSION":
        return this.#note("not-reproduced", "extensions", "Extensions are not installed locally.");
      case "OBJECT_SCHEMA":
        return this.#note("not-reproduced", "other-schemas", "Only the public schema is collected.");
      case "OBJECT_VIEW":
      case "OBJECT_MATVIEW":
        return this.#note("not-reproduced", "views", "Views are not created locally.");
      case "OBJECT_SEQUENCE":
        return this.#note("not-reproduced", "sequences", "Sequences are not created locally.");
      case "OBJECT_PUBLICATION":
        return this.#note("not-reproduced", "replication", "Publications are not reproduced locally.");
      default:
        return this.#note("unsupported", "other", `Dropping a ${String(node.removeType).replace("OBJECT_", "").toLowerCase()} is not handled by the collector.`);
    }
  }

  // --- indexes and enumerated types ----------------------------------------

  async #createIndex(node: PgNode): Promise<void> {
    const tableName = this.#local(node.relation);
    if (tableName === undefined) {
      return this.#note("not-reproduced", "other-schemas", `The index is on ${this.#qualified(node.relation)}, in another schema than public; it is not created locally.`);
    }
    const table = this.#table(tableName) as ModelTable;
    const elements = ((node.indexParams ?? []) as PgNode[]).map((entry) => entry.IndexElem as PgNode);
    const included = ((node.indexIncludingParams ?? []) as PgNode[]).map((entry) => entry.IndexElem as PgNode);
    // A B-tree is what an index is when nothing is said; said or not, it is not kept as a method.
    const accessMethod = typeof node.accessMethod === "string" && node.accessMethod.toLowerCase() !== "btree" ? node.accessMethod.toLowerCase() : undefined;
    const sourceClauses: string[] = [];
    const keys: IndexKey[] = [];
    const dotted = (parts: readonly string[]): boolean => parts.some((part) => part.includes("."));
    const spelled = (parts: readonly string[]): string => parts.map((part) => (/^[a-z_][a-z0-9_$]*$/.test(part) ? part : `"${part.replaceAll('"', '""')}"`)).join(".");
    for (const [place, element] of elements.entries()) {
      const descending = element.ordering === "SORTBY_DESC";
      // Where NULLs stand is said only when it is not where the order puts them: last when ascending, first when descending.
      const nulls = element.nulls_ordering === "SORTBY_NULLS_FIRST" ? "first" : element.nulls_ordering === "SORTBY_NULLS_LAST" ? "last" : undefined;
      const operatorClass = nameList(element.opclass);
      const collation = nameList(element.collation);
      // The collation every text has anyway is not one that is named.
      const named = collation.length > 0 && !(collation.at(-1) === "default" && (collation.length === 1 || collation[0] === "pg_catalog"));
      keys.push({
        ...(element.name !== undefined
          ? { column: this.#column(table, String(element.name)).name }
          : // The first element stands right after the parenthesis of the list of elements.
            { expression: await this.#text(element.expr, undefined, 1) }),
        ...(descending && { order: "desc" as const }),
        ...(nulls !== undefined && nulls !== (descending ? "first" : "last") && { nulls }),
        ...(operatorClass.length > 0 && !dotted(operatorClass) && { operatorClass: operatorClass.join(".") }),
        ...(named && !dotted(collation) && { collation: collation.join(".") }),
      });
      // A schema keeps such a name as its parts with dots between them. One that has a dot of its own cannot be kept so: it is said to be there.
      if (dotted(operatorClass)) {
        sourceClauses.push(`key ${place + 1}: operator class ${spelled(operatorClass)}`);
      }
      if (named && dotted(collation)) {
        sourceClauses.push(`key ${place + 1}: collation ${spelled(collation)}`);
      }
      if ((element.opclassopts ?? []).length > 0) {
        sourceClauses.push(`key ${place + 1}: operator class parameters (${optionsText(element.opclassopts)})`);
      }
    }
    const lists = indexKeyLists(keys);
    const columns = lists.columns;
    const expressions = lists.expressions ?? [];
    if (node.idxname !== undefined && this.#namespace.relations.has(node.idxname)) {
      if (node.if_not_exists) {
        return this.#note("no-effect", "index", `Index "${node.idxname}" exists already (IF NOT EXISTS).`, node.idxname);
      }
      this.#fail(`relation "${node.idxname}" already exists.`);
    }
    const include = included.map((element) => this.#column(table, String(element.name)).name);
    // What an index of each kind can be, as PostgreSQL has it. A method that is not known here may be anything.
    const method = accessMethod === undefined ? undefined : INDEX_METHODS[accessMethod];
    if (this.#sure && accessMethod !== undefined && method !== undefined) {
      if (node.unique === true) {
        this.#fail(`access method "${accessMethod}" does not support unique indexes.`);
      }
      if (include.length > 0 && !method.include) {
        this.#fail(`access method "${accessMethod}" does not support included columns.`);
      }
      if (elements.length > 1 && !method.multicolumn) {
        this.#fail(`access method "${accessMethod}" does not support multicolumn indexes.`);
      }
      if (elements.some((element) => element.ordering !== undefined && element.ordering !== "SORTBY_DEFAULT")) {
        this.#fail(`access method "${accessMethod}" does not support ASC/DESC options.`);
      }
      if (elements.some((element) => element.nulls_ordering !== undefined && element.nulls_ordering !== "SORTBY_NULLS_DEFAULT")) {
        this.#fail(`access method "${accessMethod}" does not support NULLS FIRST/LAST options.`);
      }
    }
    if ((node.options ?? []).length > 0) {
      sourceClauses.push(`WITH (${optionsText(node.options)})`);
    }
    if (typeof node.tableSpace === "string" && node.tableSpace !== "") {
      sourceClauses.push(`TABLESPACE ${node.tableSpace}`);
    }
    const name = node.idxname ?? chooseRelationName(this.#namespace, tableName, nameAddition(indexColumnNames([...elements, ...included])), "idx", false);
    this.#namespace.relations.add(name);
    const where = node.whereClause === undefined ? undefined : await this.#text(node.whereClause);
    this.#indexes.set(name, {
      name,
      table: tableName,
      keys,
      columns,
      expressions,
      include,
      unique: node.unique === true,
      nullsNotDistinct: node.nulls_not_distinct === true,
      ...(accessMethod !== undefined && { method: accessMethod }),
      ...(where !== undefined && { where }),
      // What the names in the expressions and in the condition mean, as they are written here.
      names: this.#namesIn([elements.map((element) => element.expr), node.whereClause], table),
      sourceClauses,
      origin: this.#origin(name, node.idxname === undefined),
      renames: [],
    });
    if (include.length > 0) {
      this.#note("retained", "index", `INCLUDE (${include.join(", ")}) of "${name}" lets PostgreSQL answer from the index alone; the columns are kept as what the index carries along, and are not part of its key.`, name);
    }
    this.#noteClauses("index", `the index "${name}" on "${tableName}"`, sourceClauses, name);
    const methodNote = accessMethod !== undefined ? ` (a ${accessMethod} index in PostgreSQL; an ordinary index locally)` : "";
    if (expressions.length > 0 || where !== undefined) {
      return this.#note(
        "retained",
        "index",
        `${node.unique ? "Unique index" : "Index"} "${name}" on "${tableName}" ${expressions.length > 0 ? `over expressions (${expressions.join(", ")})` : ""}${where !== undefined ? ` where ${where}` : ""} is kept as information and not created locally${node.unique ? "; its uniqueness is not enforced" : ""}.`.replace("  ", " "),
        name,
      );
    }
    return this.#note("applied", "index", `Created ${node.unique ? "unique index" : "index"} "${name}" on "${tableName}" (${columns.join(", ")})${methodNote}.`, name);
  }

  #createEnum(node: PgNode): void {
    const parts = nameList(node.typeName);
    const name = parts.at(-1) ?? "";
    if (!this.#isLocalType(parts)) {
      return this.#note("not-reproduced", "other-schemas", `The type ${parts.join(".")} is in another schema than public and is not collected.`, parts.join("."));
    }
    if (this.#enums.has(name)) {
      this.#fail(`type "${name}" already exists.`);
    }
    this.#typeNameFree(name);
    const values = nameList(node.vals);
    this.#enums.set(name, { name, values, origin: this.#origin(name), renames: [], valueRenames: [] });
    this.#note("applied", "type", `Created enumerated type "${name}" (${values.join(", ")}).`, name);
  }

  #alterEnum(node: PgNode): void {
    const parts = nameList(node.typeName);
    const name = parts.at(-1) ?? "";
    if (!this.#isLocalType(parts)) {
      return this.#note("not-reproduced", "other-schemas", `The type ${parts.join(".")} is in another schema than public; the change is not reproduced.`, parts.join("."));
    }
    const type = this.#enums.get(name);
    if (type === undefined) {
      return this.#note("unsupported", "type", `"${name}" is not an enumerated type the collector knows; the change is not applied.`, name);
    }
    const values = type.values;
    if (node.oldVal !== undefined) {
      const index = values.indexOf(node.oldVal);
      if (index < 0) {
        this.#fail(`"${node.oldVal}" is not an existing enum label of "${name}".`);
      }
      if (values.includes(node.newVal)) {
        this.#fail(`enum label "${node.newVal}" already exists in "${name}".`);
      }
      values[index] = node.newVal;
      type.valueRenames.push({ from: node.oldVal, to: node.newVal, at: this.#position() });
      for (const table of this.#tables.values()) {
        // A default that is the value follows it, also on a column that has left the type and kept the default.
        for (const column of table.columns.filter((candidate) => candidate.enumName === name || candidate.defaultRestsOn === name)) {
          if (column.default === node.oldVal) {
            column.default = node.newVal;
          }
          if (column.enumName !== name) {
            continue;
          }
          for (const row of this.#seeds.get(table.name) ?? []) {
            if (row[column.name] === node.oldVal) {
              row[column.name] = node.newVal;
            }
          }
        }
      }
      // A value in an expression is that value in PostgreSQL, whatever it is called.
      for (const { names } of this.#expressions()) {
        for (const entry of names.values) {
          if (entry.type === type && entry.now === node.oldVal) {
            entry.now = node.newVal;
          }
        }
      }
      this.#note("applied", "type", `Renamed the value "${node.oldVal}" of "${name}" to "${node.newVal}".`, name);
      return this.#noteLeftBehind(node.newVal, (names) => names.values.find((entry) => entry.type === type && entry.now === node.newVal)?.name);
    }
    if (values.includes(node.newVal)) {
      if (node.skipIfNewValExists) {
        return this.#note("no-effect", "type", `"${name}" has the value "${node.newVal}" already (IF NOT EXISTS).`, name);
      }
      this.#fail(`enum label "${node.newVal}" already exists in "${name}".`);
    }
    let position = values.length;
    if (node.newValNeighbor !== undefined) {
      const neighbor = values.indexOf(node.newValNeighbor);
      if (neighbor < 0) {
        this.#fail(`"${node.newValNeighbor}" is not an existing enum label of "${name}".`);
      }
      position = node.newValIsAfter ? neighbor + 1 : neighbor;
    }
    values.splice(position, 0, node.newVal);
    this.#note("applied", "type", `Added the value "${node.newVal}" to "${name}".`, name);
  }

  // --- data -----------------------------------------------------------------

  #insert(node: PgNode): void {
    const name = this.#local(node.relation);
    if (name === undefined) {
      return this.#note("not-reproduced", "other-schemas", `Rows inserted into ${this.#qualified(node.relation)}, in another schema than public, are not loaded.`, this.#qualified(node.relation));
    }
    const table = this.#table(name) as ModelTable;
    const lists = node.selectStmt?.SelectStmt?.valuesLists as PgNode[] | undefined;
    if (lists === undefined) {
      return this.#note("unsupported", "data", `INSERT into "${name}" from a query is not applied; only INSERT ... VALUES with constant values is loaded.`, name);
    }
    const action = node.onConflictClause?.action as string | undefined;
    if (action === "ONCONFLICT_UPDATE") {
      return this.#note("unsupported", "data", `INSERT into "${name}" with ON CONFLICT DO UPDATE is not applied.`, name);
    }
    const targets = node.cols === undefined ? table.columns.map((column) => column.name) : (node.cols as PgNode[]).map((entry) => String(entry.ResTarget?.name));
    const columns = targets.map((target) => this.#column(table, target));
    const keys = [table.primaryKey?.columns, ...table.uniques.map((unique) => unique.columns)].filter((key): key is string[] => key !== undefined);
    const rows = this.#seeds.get(name) ?? [];
    let inserted = 0;
    let skipped = 0;
    for (const list of lists) {
      const items = (list.List?.items ?? []) as PgNode[];
      if (items.length !== columns.length) {
        this.#fail(`INSERT into "${name}" has ${items.length} values for ${columns.length} columns.`);
      }
      const row: Row = {};
      for (const [position, item] of items.entries()) {
        const column = columns[position] as ModelColumn;
        if (item.SetToDefault !== undefined) {
          continue;
        }
        if (isNow(item) || isToday(item)) {
          const now = this.#now().toISOString();
          row[column.name] = isToday(item) ? now.slice(0, 10) : now;
          continue;
        }
        const constant = constantValue(item);
        const value = constant === NOT_CONSTANT || constant === null ? constant : this.#coerce(column, constant);
        if (value === NOT_CONSTANT) {
          return this.#note("unsupported", "data", `INSERT into "${name}" gives "${column.name}" a value that is not a constant of its type; the statement is not applied.`, name);
        }
        row[column.name] = value;
      }
      const conflict = keys.find((key) => key.every((column) => row[column] !== undefined && row[column] !== null) && rows.some((other) => key.every((column) => other[column] === row[column])));
      if (conflict !== undefined) {
        if (action === "ONCONFLICT_NOTHING") {
          skipped += 1;
          continue;
        }
        this.#fail(`duplicate key value violates unique constraint on "${name}" (${conflict.join(", ")}).`);
      }
      rows.push(row);
      inserted += 1;
    }
    this.#seeds.set(name, rows);
    this.#note("seeded", "data", `${inserted} row${inserted === 1 ? "" : "s"} for "${name}"${skipped > 0 ? ` (${skipped} skipped: ON CONFLICT DO NOTHING)` : ""}.`, name);
  }

  #query(node: PgNode): void {
    const calls = callsIn(node);
    if (calls.some((call) => call.startsWith("cron.") || call === "schedule" || call === "unschedule")) {
      return this.#note("not-reproduced", "scheduling", `Scheduled job (${calls.filter((call) => call.startsWith("cron.")).join(", ") || calls.join(", ")}) is not run locally: nothing calls what it schedules.`);
    }
    // What a function does when PostgreSQL runs it is not known here.
    this.#sure = false;
    return this.#note("not-reproduced", "functions", `A query run for its effect${calls.length > 0 ? ` (${calls.join(", ")})` : ""} is not run locally.`);
  }

  // --- result ---------------------------------------------------------------

  result(directory: string, migrations: MigrationSummary[]): CollectedSchema {
    const tables: TableSchema[] = [...this.#tables.values()].map((table) => this.#tableSchema(table));
    const seeds: Record<string, Row[]> = {};
    for (const [name, rows] of this.#seeds) {
      if (this.#tables.has(name) && rows.length > 0) {
        seeds[name] = rows;
      }
    }
    const enums: EnumType[] = [...this.#enums.values()].map((type) => ({
      name: type.name,
      values: [...type.values],
      sourceDialectType: { dialect: POSTGRESQL, type: type.name },
      ...provenanceOf(type),
      ...(type.valueRenames.length > 0 && { valueRenames: structuredClone(type.valueRenames) }),
    }));
    const provenance: SchemaProvenance = { tables: {}, enums: {} };
    for (const table of this.#tables.values()) {
      provenance.tables[table.name] = {
        created: { file: table.origin.file, line: table.origin.line },
        columns: Object.fromEntries(table.columns.map((column) => [column.name, { file: column.origin.file, line: column.origin.line }])),
      };
    }
    for (const type of this.#enums.values()) {
      provenance.enums[type.name] = { file: type.origin.file, line: type.origin.line };
    }
    return { directory, migrations, tables, types: { enums }, seeds, report: this.#report, provenance };
  }

  #tableSchema(table: ModelTable): TableSchema {
    const key = table.primaryKey?.columns ?? [];
    const singleColumn = new Map<string, ModelForeignKey>();
    const foreignKeys: ForeignKeyConstraint[] = [];
    for (const foreignKey of table.foreignKeys) {
      const [column] = foreignKey.columns;
      if (foreignKey.columns.length === 1 && column !== undefined && !singleColumn.has(column)) {
        singleColumn.set(column, foreignKey);
      } else {
        foreignKeys.push({
          name: foreignKey.name,
          columns: [...foreignKey.columns],
          references: { table: foreignKey.table, columns: [...foreignKey.refColumns] },
          ...(foreignKey.onDelete !== undefined && { onDelete: foreignKey.onDelete }),
          ...(foreignKey.onUpdate !== undefined && { onUpdate: foreignKey.onUpdate }),
          ...beyondOf(foreignKey),
          ...provenanceOf(foreignKey),
        });
      }
    }
    const columns = table.columns.map((column): ColumnSchema => {
      const primary = key.includes(column.name);
      const generatedByDatabase = column.numbering !== undefined && primary && key.length === 1 && column.type === "integer";
      const reference = singleColumn.get(column.name);
      const values = column.enumName === undefined ? undefined : this.#enums.get(column.enumName)?.values;
      const defaultText = column.defaultExpression === undefined || column.defaultNames === undefined ? undefined : this.#textOf(column.defaultNames, undefined);
      return {
        name: column.name,
        type: column.type,
        declaredType: column.declaredType,
        canonicalType: copyCanonicalType(column.canonical),
        sourceDialectType: { dialect: POSTGRESQL, type: column.dialectType },
        nullable: primary ? false : column.nullable,
        primary,
        ...(generatedByDatabase && { autoIncrement: true }),
        ...(column.numbering !== undefined ? { generated: "increment" } : column.generated !== undefined ? { generated: column.generated } : {}),
        ...(column.default !== undefined && { default: column.default }),
        ...(column.defaultFunction !== undefined && { defaultFunction: column.defaultFunction }),
        ...(column.defaultExpression !== undefined && { defaultExpression: column.defaultExpression }),
        ...(defaultText !== undefined && ("names" in defaultText ? { defaultNames: defaultText.names } : { defaultMayBeStale: true })),
        ...(reference !== undefined && {
          references: {
            table: reference.table,
            column: reference.refColumns[0] as string,
            ...(reference.onDelete !== undefined && { onDelete: reference.onDelete }),
            ...(reference.onUpdate !== undefined && { onUpdate: reference.onUpdate }),
            name: reference.name,
            ...beyondOf(reference),
            ...provenanceOf(reference),
          },
        }),
        ...(column.enumName !== undefined && values !== undefined && { enum: { name: column.enumName, values: [...values] } }),
        ...provenanceOf(column),
      };
    });
    for (const column of table.columns) {
      if (column.numbering !== undefined && !(key.length === 1 && key[0] === column.name && column.type === "integer")) {
        this.#report.push({
          file: column.origin.file,
          line: column.origin.line,
          statement: column.origin.statement,
          kind: "ColumnDef",
          outcome: "retained",
          category: "column",
          object: `${table.name}.${column.name}`,
          message: `"${table.name}"."${column.name}" is numbered by a sequence in PostgreSQL; locally only a single integer primary key is numbered, so a row written without it gets none.`,
          sql: "",
        });
      }
    }
    const indexes: IndexDefinition[] = [...this.#indexes.values()]
      .filter((index) => index.table === table.name)
      .map((index) => {
        // The keys as an index holds them: its columns and its expressions, and `keys` when those two do not say it all.
        const lists = indexKeyLists(index.keys);
        return {
          name: index.name,
          columns: lists.columns,
          ...(index.unique && { unique: true }),
          ...(lists.expressions !== undefined && { expressions: lists.expressions }),
          ...(index.where !== undefined && { where: index.where }),
          ...(index.method !== undefined && { method: index.method }),
          ...(lists.keys !== undefined && { keys: lists.keys }),
          ...(index.include.length > 0 && { include: [...index.include] }),
          ...(index.nullsNotDistinct && { nullsNotDistinct: true }),
          ...((lists.expressions !== undefined || index.where !== undefined) && this.#textOf(index.names, table)),
          ...beyondOf(index),
          ...provenanceOf(index),
        };
      });
    const keyOf = (key: ModelKey): Pick<UniqueConstraint, "name" | "columns" | "include" | "deferrable" | "nullsNotDistinct" | "sourceClauses"> => ({
      name: key.name,
      columns: [...key.columns],
      ...(key.include.length > 0 && { include: [...key.include] }),
      ...(key.deferrable !== undefined && { deferrable: key.deferrable }),
      ...(key.nullsNotDistinct && { nullsNotDistinct: true }),
      ...beyondOf({ sourceClauses: key.sourceClauses }),
    });
    const uniques: UniqueConstraint[] = table.uniques.map((unique) => ({ ...keyOf(unique), ...provenanceOf(unique) }));
    const checks: CheckConstraint[] = table.checks.map((check) => ({ name: check.name, expression: check.expression, ...this.#textOf(check.names, table), ...beyondOf({ sourceClauses: check.sourceClauses }), ...provenanceOf(check) }));
    return {
      name: table.name,
      columns,
      ...(table.primaryKey !== undefined && { primaryKey: { ...keyOf(table.primaryKey), ...provenanceOf(table.primaryKey) } }),
      ...(uniques.length > 0 && { uniques }),
      ...(foreignKeys.length > 0 && { foreignKeys }),
      ...(indexes.length > 0 && { indexes }),
      ...(checks.length > 0 && { checks }),
      ...provenanceOf(table),
    };
  }
}

/** Whether a constraint is deferrable, and the clauses that are kept as text, as the schema keeps them: only what says something. */
function beyondOf(object: { deferrable?: Deferrable; sourceClauses: readonly string[] }): { deferrable?: Deferrable; sourceClauses?: string[] } {
  return { ...(object.deferrable !== undefined && { deferrable: object.deferrable }), ...(object.sourceClauses.length > 0 && { sourceClauses: [...object.sourceClauses] }) };
}

/** The provenance of a tracked object, as the schema keeps it: copies, and no empty rename list. */
function provenanceOf(object: Tracked): { origin: SchemaOrigin; renames?: SchemaRename[] } {
  return { origin: { ...object.origin }, ...(object.renames.length > 0 && { renames: structuredClone(object.renames) }) };
}

/** Collects the schema that migration files leave, applied in the order given. */
export async function collectMigrationFiles(directory: string, files: readonly MigrationFile[], options: CollectOptions = {}): Promise<CollectedSchema> {
  const collector = new Collector(options);
  const migrations: MigrationSummary[] = [];
  for (const file of files) {
    const statements = await parseMigration(file);
    await collector.apply(file, statements);
    migrations.push({ file: file.file, sha256: file.sha256, statements: statements.length });
  }
  return collector.result(directory, migrations);
}

/**
 * Collects the schema that a project's PostgreSQL migrations leave. `path` is
 * the migrations directory, or a project that has one where projects usually
 * keep it (`supabase/migrations`, `migrations`, ...).
 */
export async function collectPostgresMigrations(path: string, options: CollectOptions = {}): Promise<CollectedSchema> {
  const directory = findMigrationsDirectory(path);
  return collectMigrationFiles(directory, readMigrationFiles(directory), options);
}
