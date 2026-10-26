import type { CanonicalType, ColumnSchema, ColumnType, DatabaseSchema, EnumType, SchemaOrigin, SchemaRename, SourcePosition, TableSchema } from "../../../runtime/src/index.ts";

/*
 * Generated migration histories, for the properties of the migration package
 * (D-038). A history keeps a small model of a schema and changes it the way
 * migrations change a database: every object knows the statement that
 * created it, a rename is recorded, and what depends on a renamed or dropped
 * object follows it or goes with it. The schema at two moments of a history
 * is a pair of canonical schemas with all the provenance a collector gives.
 *
 * Nothing is random: a history is made from a seed, and the same seed gives
 * the same history. Names come from small pools, so that a name that was
 * given up is soon taken again: renames onto dropped names, names passed on,
 * and names exchanged all happen often.
 *
 * Nothing here reads the diff or the migration package.
 */

/** Numbers from 0 up to 1 in an order that the seed decides. */
export function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export interface HistoryOptions {
  /** Names of dropped or renamed objects may be taken again. Without it every name is new. */
  reuse: boolean;
  /** Also changes that migrations of PostgreSQL cannot make: a value removed from a type, values put in another order. */
  handEdits: boolean;
  /**
   * Tables, enumerated types, constraints, and indexes take their names from
   * one pool, and no two of them have one name: as in a database that keeps
   * the names of several kinds of object in one place. Names then pass from
   * a thing of one kind to a thing of another.
   */
  oneNamespace?: boolean;
  /**
   * Only schemas that PostgreSQL itself can have, so that a history can be
   * written as SQL and run there (D-039): a foreign key refers to a key of
   * its table, by columns of the key's types, and goes with that key; a key
   * that foreign keys rest on is also replaced by another, as a migration
   * does it; a numbered column takes no NULL; an index is over columns or
   * over expressions; and an expression is one PostgreSQL computes, of
   * constants, so that no rename reaches into it. Without it nothing here
   * is different: the same seed gives the history it always gave.
   */
  postgres?: boolean;
}

type Type = { kind: "int" | "bigint" | "text" | "varchar" | "bool" | "ts" } | { kind: "enum" | "enumArray"; enumName: string };
type Default = { kind: "value"; value: unknown } | { kind: "function" } | { kind: "increment" } | { kind: "expression"; expression: string };

interface Tracked {
  name: string;
  origin: SchemaOrigin;
  renames: SchemaRename[];
}
interface Column extends Tracked {
  type: Type;
  nullable: boolean;
  default?: Default;
}
interface Key extends Tracked {
  columns: string[];
}
interface ForeignKey extends Tracked {
  columns: string[];
  table: string;
  refColumns: string[];
  onDelete?: string;
}
interface Index extends Tracked {
  columns: string[];
  unique: boolean;
  expressions: string[];
  where?: string;
}
interface Check extends Tracked {
  expression: string;
}
interface Table extends Tracked {
  columns: Column[];
  primaryKey?: Key;
  uniques: Key[];
  foreignKeys: ForeignKey[];
  indexes: Index[];
  checks: Check[];
}
interface Enum extends Tracked {
  values: string[];
  valueRenames: SchemaRename[];
}

const isEnum = (type: Type): type is { kind: "enum" | "enumArray"; enumName: string } => type.kind === "enum" || type.kind === "enumArray";
const sameType = (a: Type, b: Type): boolean => a.kind === b.kind && (!isEnum(a) || !isEnum(b) || a.enumName === b.enumName);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((name) => b.includes(name));

export class History {
  /** What was done, as lines of text: for the message of a property that fails. */
  readonly log: string[] = [];
  #tables: Table[] = [];
  #enums: Enum[] = [];
  #statement = 0;
  #file = "0001.sql";
  #fresh = 0;
  readonly #next: () => number;
  readonly #options: HistoryOptions;

  constructor(seed: number, options: HistoryOptions) {
    this.#next = sequence(seed);
    this.#options = options;
  }

  /** What follows is of a later migration file. */
  nextFile(): void {
    this.#file = "0002.sql";
    this.#statement = 0;
    this.log.push("--- the schema so far is the before side ---");
  }

  // --- choices ----------------------------------------------------------------------

  #below(limit: number): number {
    return Math.floor(this.#next() * limit);
  }

  #pick<T>(list: readonly T[]): T | undefined {
    return list.length === 0 ? undefined : list[this.#below(list.length)];
  }

  #chance(probability: number): boolean {
    return this.#next() < probability;
  }

  #position(): SourcePosition {
    this.#statement += 1;
    return { source: "generated-history", file: this.#file, sha256: `sha256-of-${this.#file}`, statement: this.#statement, line: this.#statement };
  }

  #origin(name: string): SchemaOrigin {
    return { ...this.#position(), name };
  }

  /** A name that nothing has where `taken` looks: one of a small pool, or with `reuse` off one that was never used. */
  #name(prefix: string, pool: number, taken: (name: string) => boolean): string | undefined {
    if (!this.#options.reuse) {
      this.#fresh += 1;
      return `${prefix}${this.#fresh}`;
    }
    return this.#pick(Array.from({ length: pool }, (_unused, index) => `${prefix}${index + 1}`).filter((name) => !taken(name)));
  }

  /** A name for a table, type, constraint, or index: of its kind's own pool, or with `oneNamespace` of the pool they share. */
  #nameOfKind(prefix: string, pool: number, taken: (name: string) => boolean): string | undefined {
    if (this.#options.oneNamespace !== true) {
      return this.#name(prefix, pool, taken);
    }
    const shared = new Set([...this.#tables.map((table) => table.name), ...this.#enums.map((type) => type.name), ...this.#constraints().map(({ constraint }) => constraint.name), ...this.#tables.flatMap((table) => table.indexes.map((index) => index.name))]);
    return this.#name("n", 10, (name) => shared.has(name));
  }

  #rename(object: Tracked, to: string): void {
    object.renames.push({ from: object.name, to, at: this.#position() });
    object.name = to;
  }

  #constraints(): { table: Table; constraint: Tracked }[] {
    return this.#tables.flatMap((table) => [table.primaryKey, ...table.uniques, ...table.foreignKeys, ...table.checks].filter((entry): entry is Key => entry !== undefined).map((constraint) => ({ table, constraint })));
  }

  // Constraint and index names are taken across the schema, as PostgreSQL takes those of keys and indexes.
  #constraintName(): string | undefined {
    const taken = new Set(this.#constraints().map(({ constraint }) => constraint.name));
    return this.#nameOfKind("k", 7, (name) => taken.has(name));
  }

  #indexName(): string | undefined {
    const taken = new Set(this.#tables.flatMap((table) => table.indexes.map((index) => index.name)));
    return this.#nameOfKind("i", 5, (name) => taken.has(name));
  }

  #randomType(): Type {
    const type = this.#pick(this.#enums);
    const kinds = ["int", "bigint", "text", "varchar", "bool", "ts", ...(type === undefined ? [] : ["enum", "enum", "enumArray"])];
    const kind = this.#pick(kinds) as string;
    return kind === "enum" || kind === "enumArray" ? { kind, enumName: (type as Enum).name } : ({ kind } as Type);
  }

  #randomDefault(type: Type): Default | undefined {
    if (this.#chance(0.5)) {
      return undefined;
    }
    switch (type.kind) {
      case "int":
      case "bigint":
        return this.#chance(0.3) ? { kind: "increment" } : this.#chance(0.2) ? { kind: "expression", expression: this.#expression(`f${this.#below(3)}()`, (n) => `1 + ${n}`) } : { kind: "value", value: this.#below(3) };
      case "text":
      case "varchar":
        return this.#chance(0.2) ? { kind: "expression", expression: this.#expression(`g${this.#below(3)}()`, (n) => `lower('G${n}')`) } : { kind: "value", value: this.#pick(["", "a", "v1", "v2"]) };
      case "bool":
        return { kind: "value", value: this.#chance(0.5) };
      case "ts":
        return { kind: "function" };
      case "enum": {
        const value = this.#pick(this.#enums.find((candidate) => candidate.name === type.enumName)?.values ?? []);
        return value === undefined ? undefined : { kind: "value", value };
      }
      default:
        return undefined;
    }
  }

  /**
   * An expression as a history writes it: a made-up call, which is only a
   * text; or, for PostgreSQL, an expression of constants that it computes,
   * with the number the made-up one ends in.
   */
  #expression(madeUp: string, real: (n: string) => string): string {
    return this.#options.postgres === true ? real(/\d/.exec(madeUp)?.[0] ?? "0") : madeUp;
  }

  #column(name: string): Column {
    const type = this.#randomType();
    const fallback = this.#randomDefault(type);
    const origin = this.#origin(name);
    const takesNull = this.#chance(0.6);
    // PostgreSQL's numbered column takes no NULL.
    return { name, origin, renames: [], type, nullable: takesNull && !(this.#options.postgres === true && fallback?.kind === "increment"), ...(fallback !== undefined && { default: fallback }) };
  }

  #someColumns(table: Table, most = 2): string[] {
    const names = table.columns.map((column) => column.name);
    const count = Math.min(names.length, 1 + this.#below(most));
    const chosen: string[] = [];
    while (chosen.length < count) {
      const name = this.#pick(names) as string;
      if (!chosen.includes(name)) {
        chosen.push(name);
      }
    }
    return chosen;
  }

  // --- one change --------------------------------------------------------------------

  /** Makes one change that can be made, and says it in the log. */
  step(): void {
    const changes: (() => string | undefined)[] = [
      () => this.#createTable(),
      () => this.#createTable(),
      () => this.#dropTable(),
      () => this.#renameTable(),
      () => this.#addColumn(),
      () => this.#addColumn(),
      () => this.#dropColumn(),
      () => this.#renameColumn(),
      () => this.#renameColumn(),
      () => this.#alterType(),
      () => this.#changeDefault(),
      () => this.#changeNullable(),
      () => this.#addPrimaryKey(),
      () => this.#dropPrimaryKey(),
      () => this.#renameConstraint(),
      () => this.#renameConstraint(),
      () => this.#addUnique(),
      () => this.#dropUnique(),
      () => this.#addIndex(),
      () => this.#dropIndex(),
      () => this.#renameIndex(),
      () => this.#addForeignKey(),
      () => this.#addForeignKey(),
      () => this.#dropForeignKey(),
      () => this.#addCheck(),
      () => this.#dropCheck(),
      () => this.#createEnum(),
      () => this.#dropEnum(),
      () => this.#renameEnum(),
      () => this.#addValue(),
      () => this.#renameValue(),
      () => this.#renameValue(),
      // What the planner has to work for: names exchanged, tables that refer to each other, and such tables dropped at once.
      () => this.#exchangeNames(),
      () => this.#referEachOther(),
      () => this.#dropTablesTogether(),
      ...(this.#options.handEdits ? [() => this.#removeValue(), () => this.#reorderValues()] : []),
      ...(this.#options.postgres === true ? [() => this.#replaceKey(), () => this.#replaceKey()] : []),
    ];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const done = (this.#pick(changes) as () => string | undefined)();
      if (done !== undefined) {
        this.log.push(done);
        return;
      }
    }
  }

  #createTable(): string | undefined {
    const name = this.#nameOfKind("t", 4, (candidate) => this.#tables.some((table) => table.name === candidate));
    if (name === undefined) {
      return undefined;
    }
    const table: Table = { name, origin: this.#origin(name), renames: [], columns: [], uniques: [], foreignKeys: [], indexes: [], checks: [] };
    const count = 1 + this.#below(3);
    for (let index = 0; index < count; index += 1) {
      const columnName = this.#name("c", 5, (candidate) => table.columns.some((column) => column.name === candidate));
      if (columnName !== undefined) {
        table.columns.push(this.#column(columnName));
      }
    }
    if (table.columns.length === 0) {
      return undefined;
    }
    this.#tables.push(table);
    return `create table ${name} (${table.columns.map((column) => column.name).join(", ")})`;
  }

  #removeTable(table: Table): void {
    this.#tables = this.#tables.filter((other) => other !== table);
    for (const other of this.#tables) {
      other.foreignKeys = other.foreignKeys.filter((key) => key.table !== table.name);
    }
  }

  #dropTable(): string | undefined {
    const table = this.#pick(this.#tables);
    if (table === undefined) {
      return undefined;
    }
    this.#removeTable(table);
    return `drop table ${table.name} cascade`;
  }

  #dropTablesTogether(): string | undefined {
    const first = this.#pick(this.#tables);
    // By preference a table that the first refers to, or that refers to it.
    const related = this.#tables.filter((other) => other !== first && (other.foreignKeys.some((key) => key.table === first?.name) || (first?.foreignKeys.some((key) => key.table === other.name) ?? false)));
    const second = this.#pick(related) ?? this.#pick(this.#tables.filter((other) => other !== first));
    if (first === undefined || second === undefined) {
      return undefined;
    }
    this.#removeTable(first);
    this.#removeTable(second);
    return `drop table ${first.name}, ${second.name} cascade`;
  }

  #renameTableTo(table: Table, name: string): void {
    const old = table.name;
    this.#rename(table, name);
    for (const other of this.#tables) {
      for (const key of other.foreignKeys) {
        if (key.table === old) {
          key.table = name;
        }
      }
    }
  }

  #renameTable(): string | undefined {
    const table = this.#pick(this.#tables);
    const name = this.#nameOfKind("t", 4, (candidate) => this.#tables.some((other) => other.name === candidate));
    if (table === undefined || name === undefined) {
      return undefined;
    }
    const old = table.name;
    this.#renameTableTo(table, name);
    return `alter table ${old} rename to ${name}`;
  }

  #addColumn(): string | undefined {
    const table = this.#pick(this.#tables);
    if (table === undefined) {
      return undefined;
    }
    const name = this.#name("c", 5, (candidate) => table.columns.some((column) => column.name === candidate));
    if (name === undefined) {
      return undefined;
    }
    table.columns.push(this.#column(name));
    return `alter table ${table.name} add column ${name}`;
  }

  #dropColumn(): string | undefined {
    const table = this.#pick(this.#tables.filter((candidate) => candidate.columns.length > 1));
    const column = table === undefined ? undefined : this.#pick(table.columns);
    if (table === undefined || column === undefined) {
      return undefined;
    }
    table.columns = table.columns.filter((other) => other !== column);
    if (table.primaryKey?.columns.includes(column.name)) {
      delete table.primaryKey;
    }
    table.uniques = table.uniques.filter((unique) => !unique.columns.includes(column.name));
    table.foreignKeys = table.foreignKeys.filter((key) => !key.columns.includes(column.name));
    table.indexes = table.indexes.filter((index) => !index.columns.includes(column.name));
    for (const other of this.#tables) {
      other.foreignKeys = other.foreignKeys.filter((key) => !(key.table === table.name && key.refColumns.includes(column.name)));
    }
    return `alter table ${table.name} drop column ${column.name} cascade`;
  }

  #renameColumnTo(table: Table, column: Column, name: string): void {
    const old = column.name;
    this.#rename(column, name);
    const follow = (names: string[]): string[] => names.map((candidate) => (candidate === old ? name : candidate));
    if (table.primaryKey !== undefined) {
      table.primaryKey.columns = follow(table.primaryKey.columns);
    }
    for (const object of [...table.uniques, ...table.foreignKeys, ...table.indexes]) {
      object.columns = follow(object.columns);
    }
    for (const other of this.#tables) {
      for (const key of other.foreignKeys) {
        if (key.table === table.name) {
          key.refColumns = follow(key.refColumns);
        }
      }
    }
  }

  #renameColumn(): string | undefined {
    const table = this.#pick(this.#tables);
    const column = table === undefined ? undefined : this.#pick(table.columns);
    if (table === undefined || column === undefined) {
      return undefined;
    }
    const name = this.#name("c", 5, (candidate) => table.columns.some((other) => other.name === candidate));
    if (name === undefined) {
      return undefined;
    }
    const old = column.name;
    this.#renameColumnTo(table, column, name);
    return `alter table ${table.name} rename column ${old} to ${name}`;
  }

  /** Whether a column is in a foreign key, on either side. */
  #inForeignKey(table: Table, column: Column): boolean {
    return table.foreignKeys.some((key) => key.columns.includes(column.name)) || this.#tables.some((other) => other.foreignKeys.some((key) => key.table === table.name && key.refColumns.includes(column.name)));
  }

  /**
   * A key of a table goes. In PostgreSQL the foreign keys that rest on it go
   * with it (CASCADE), unless another key is over the same columns.
   */
  #keyGone(table: Table, columns: readonly string[]): void {
    if (this.#options.postgres !== true || [table.primaryKey, ...table.uniques].some((key) => key !== undefined && sameSet(key.columns, columns))) {
      return;
    }
    for (const other of this.#tables) {
      other.foreignKeys = other.foreignKeys.filter((key) => !(key.table === table.name && sameSet(key.refColumns, columns)));
    }
  }

  /**
   * A key that a foreign key rests on is replaced by a unique constraint
   * over the same columns, as a migration does it: the foreign key is
   * dropped, the key replaced, and the foreign key added again as it was.
   * So the foreign key stays, and what it rests on is another object.
   */
  #replaceKey(): string | undefined {
    const resting = this.#tables.flatMap((table) =>
      [table.primaryKey, ...table.uniques]
        .filter((key): key is Key => key !== undefined && this.#tables.some((other) => other.foreignKeys.some((foreignKey) => foreignKey.table === table.name && sameSet(foreignKey.refColumns, key.columns))))
        .map((key) => ({ table, key })),
    );
    const found = this.#pick(resting);
    const name = this.#constraintName();
    if (found === undefined || name === undefined) {
      return undefined;
    }
    const { table, key } = found;
    if (table.primaryKey === key) {
      delete table.primaryKey;
    } else {
      table.uniques = table.uniques.filter((other) => other !== key);
    }
    table.uniques.push({ name, origin: this.#origin(name), renames: [], columns: [...key.columns] });
    return `replace the key ${key.name} of ${table.name}, which a foreign key rests on, by the unique constraint ${name}`;
  }

  #alterType(): string | undefined {
    const table = this.#pick(this.#tables);
    // PostgreSQL keeps no foreign key between columns of types it does not compare: a column of one keeps its type.
    const column = table === undefined ? undefined : this.#pick(this.#options.postgres === true ? table.columns.filter((candidate) => !this.#inForeignKey(table, candidate)) : table.columns);
    if (table === undefined || column === undefined) {
      return undefined;
    }
    column.type = this.#randomType();
    delete column.default;
    return `alter table ${table.name} alter column ${column.name} type ${column.type.kind}`;
  }

  #changeDefault(): string | undefined {
    const table = this.#pick(this.#tables);
    const column = table === undefined ? undefined : this.#pick(table.columns);
    if (table === undefined || column === undefined) {
      return undefined;
    }
    const fallback = this.#randomDefault(column.type);
    if (fallback === undefined) {
      delete column.default;
    } else {
      column.default = fallback;
    }
    if (this.#options.postgres === true && fallback?.kind === "increment") {
      column.nullable = false;
    }
    return `alter table ${table.name} alter column ${column.name} ${fallback === undefined ? "drop default" : `set default ${JSON.stringify(fallback)}`}`;
  }

  #changeNullable(): string | undefined {
    const table = this.#pick(this.#tables);
    const column = table === undefined ? undefined : this.#pick(table.columns.filter((candidate) => !(table.primaryKey?.columns.includes(candidate.name) ?? false) && !(this.#options.postgres === true && candidate.default?.kind === "increment")));
    if (table === undefined || column === undefined) {
      return undefined;
    }
    column.nullable = !column.nullable;
    return `alter table ${table.name} alter column ${column.name} ${column.nullable ? "drop" : "set"} not null`;
  }

  #addPrimaryKey(): string | undefined {
    const table = this.#pick(this.#tables.filter((candidate) => candidate.primaryKey === undefined));
    const name = this.#constraintName();
    if (table === undefined || name === undefined) {
      return undefined;
    }
    const columns = this.#someColumns(table);
    for (const column of table.columns) {
      if (columns.includes(column.name)) {
        column.nullable = false;
      }
    }
    table.primaryKey = { name, origin: this.#origin(name), renames: [], columns };
    return `alter table ${table.name} add constraint ${name} primary key (${columns.join(", ")})`;
  }

  #dropPrimaryKey(): string | undefined {
    const table = this.#pick(this.#tables.filter((candidate) => candidate.primaryKey !== undefined));
    if (table === undefined) {
      return undefined;
    }
    const name = table.primaryKey?.name;
    const columns = table.primaryKey?.columns ?? [];
    delete table.primaryKey;
    this.#keyGone(table, columns);
    return `alter table ${table.name} drop constraint ${name}`;
  }

  #renameConstraint(): string | undefined {
    const found = this.#pick(this.#constraints());
    const name = this.#constraintName();
    if (found === undefined || name === undefined) {
      return undefined;
    }
    const old = found.constraint.name;
    this.#rename(found.constraint, name);
    return `alter table ${found.table.name} rename constraint ${old} to ${name}`;
  }

  #addUnique(): string | undefined {
    const table = this.#pick(this.#tables);
    const name = this.#constraintName();
    if (table === undefined || name === undefined) {
      return undefined;
    }
    const columns = this.#someColumns(table);
    table.uniques.push({ name, origin: this.#origin(name), renames: [], columns });
    return `alter table ${table.name} add constraint ${name} unique (${columns.join(", ")})`;
  }

  #dropUnique(): string | undefined {
    const table = this.#pick(this.#tables.filter((candidate) => candidate.uniques.length > 0));
    const unique = table === undefined ? undefined : this.#pick(table.uniques);
    if (table === undefined || unique === undefined) {
      return undefined;
    }
    table.uniques = table.uniques.filter((other) => other !== unique);
    this.#keyGone(table, unique.columns);
    return `alter table ${table.name} drop constraint ${unique.name}`;
  }

  #addIndex(): string | undefined {
    const table = this.#pick(this.#tables);
    const name = this.#indexName();
    if (table === undefined || name === undefined) {
      return undefined;
    }
    const columns = this.#someColumns(table);
    const expressions = this.#chance(0.2) ? [this.#expression(`h${this.#below(3)}(q)`, (n) => `1 + ${n}`)] : [];
    const unique = this.#chance(0.3);
    const where = this.#chance(0.2) ? this.#expression(`w${this.#below(3)} > 0`, (n) => `${n} > -1`) : undefined;
    // A schema does not say where an expression stands among columns: for PostgreSQL an index is over the one or the other.
    table.indexes.push({ name, origin: this.#origin(name), renames: [], columns: this.#options.postgres === true && expressions.length > 0 ? [] : columns, unique, expressions, ...(where !== undefined && { where }) });
    return `create index ${name} on ${table.name} (${columns.join(", ")})`;
  }

  #dropIndex(): string | undefined {
    const table = this.#pick(this.#tables.filter((candidate) => candidate.indexes.length > 0));
    const index = table === undefined ? undefined : this.#pick(table.indexes);
    if (table === undefined || index === undefined) {
      return undefined;
    }
    table.indexes = table.indexes.filter((other) => other !== index);
    return `drop index ${index.name}`;
  }

  #renameIndex(): string | undefined {
    const index = this.#pick(this.#tables.flatMap((table) => table.indexes));
    const name = this.#indexName();
    if (index === undefined || name === undefined) {
      return undefined;
    }
    const old = index.name;
    this.#rename(index, name);
    return `alter index ${old} rename to ${name}`;
  }

  #foreignKey(table: Table, target: Table): string | undefined {
    const name = this.#constraintName();
    if (name === undefined) {
      return undefined;
    }
    if (this.#options.postgres === true) {
      // PostgreSQL makes a foreign key with a key of the table it refers to, by columns of the key's types.
      const key = this.#pick([target.primaryKey, ...target.uniques].filter((candidate): candidate is Key => candidate !== undefined));
      if (key === undefined) {
        return undefined;
      }
      const own: string[] = [];
      for (const refColumn of key.columns) {
        const type = (target.columns.find((candidate) => candidate.name === refColumn) as Column).type;
        const column = this.#pick(table.columns.filter((candidate) => !own.includes(candidate.name) && sameType(candidate.type, type)));
        if (column === undefined) {
          return undefined;
        }
        own.push(column.name);
      }
      const action = this.#pick([undefined, "CASCADE", "SET NULL"]);
      table.foreignKeys.push({ name, origin: this.#origin(name), renames: [], columns: own, table: target.name, refColumns: [...key.columns], ...(action !== undefined && { onDelete: action }) });
      return `alter table ${table.name} add constraint ${name} foreign key (${own.join(", ")}) references ${target.name} (${key.columns.join(", ")})`;
    }
    const columns = this.#someColumns(table);
    if (target.columns.length < columns.length) {
      return undefined;
    }
    const refColumns: string[] = [];
    while (refColumns.length < columns.length) {
      const candidate = (this.#pick(target.columns) as Column).name;
      if (!refColumns.includes(candidate)) {
        refColumns.push(candidate);
      }
    }
    const onDelete = this.#pick([undefined, "CASCADE", "SET NULL"]);
    table.foreignKeys.push({ name, origin: this.#origin(name), renames: [], columns, table: target.name, refColumns, ...(onDelete !== undefined && { onDelete }) });
    return `alter table ${table.name} add constraint ${name} foreign key (${columns.join(", ")}) references ${target.name} (${refColumns.join(", ")})`;
  }

  #addForeignKey(): string | undefined {
    const table = this.#pick(this.#tables);
    const target = this.#pick(this.#tables);
    return table === undefined || target === undefined ? undefined : this.#foreignKey(table, target);
  }

  #referEachOther(): string | undefined {
    const first = this.#pick(this.#tables);
    const second = this.#pick(this.#tables.filter((other) => other !== first));
    if (first === undefined || second === undefined) {
      return undefined;
    }
    const there = this.#foreignKey(first, second);
    const back = this.#foreignKey(second, first);
    return there === undefined && back === undefined ? undefined : [there, back].filter((line) => line !== undefined).join("; ");
  }

  #dropForeignKey(): string | undefined {
    const table = this.#pick(this.#tables.filter((candidate) => candidate.foreignKeys.length > 0));
    const key = table === undefined ? undefined : this.#pick(table.foreignKeys);
    if (table === undefined || key === undefined) {
      return undefined;
    }
    table.foreignKeys = table.foreignKeys.filter((other) => other !== key);
    return `alter table ${table.name} drop constraint ${key.name}`;
  }

  #addCheck(): string | undefined {
    const table = this.#pick(this.#tables);
    const name = this.#constraintName();
    if (table === undefined || name === undefined) {
      return undefined;
    }
    const expression = this.#expression(`p${this.#below(4)} > 0`, (n) => `${n} + 1 > 0`);
    table.checks.push({ name, origin: this.#origin(name), renames: [], expression });
    return `alter table ${table.name} add constraint ${name} check (${expression})`;
  }

  #dropCheck(): string | undefined {
    const table = this.#pick(this.#tables.filter((candidate) => candidate.checks.length > 0));
    const check = table === undefined ? undefined : this.#pick(table.checks);
    if (table === undefined || check === undefined) {
      return undefined;
    }
    table.checks = table.checks.filter((other) => other !== check);
    return `alter table ${table.name} drop constraint ${check.name}`;
  }

  #createEnum(): string | undefined {
    const name = this.#nameOfKind("e", 3, (candidate) => this.#enums.some((type) => type.name === candidate));
    if (name === undefined) {
      return undefined;
    }
    const values = (this.#options.reuse ? ["v1", "v2", "v3"] : ["w1", "w2", "w3"]).slice(0, 1 + this.#below(3));
    this.#enums.push({ name, origin: this.#origin(name), renames: [], values, valueRenames: [] });
    return `create type ${name} as enum (${values.join(", ")})`;
  }

  #columnsOf(type: Enum, scalarOnly = false): Column[] {
    return this.#tables.flatMap((table) => table.columns.filter((column) => (scalarOnly ? column.type.kind === "enum" : isEnum(column.type)) && isEnum(column.type) && column.type.enumName === type.name));
  }

  #dropEnum(): string | undefined {
    const type = this.#pick(this.#enums.filter((candidate) => this.#columnsOf(candidate).length === 0));
    if (type === undefined) {
      return undefined;
    }
    this.#enums = this.#enums.filter((other) => other !== type);
    return `drop type ${type.name}`;
  }

  #renameEnumTo(type: Enum, name: string): void {
    const columns = this.#columnsOf(type);
    this.#rename(type, name);
    for (const column of columns) {
      (column.type as { enumName: string }).enumName = name;
    }
  }

  #renameEnum(): string | undefined {
    const type = this.#pick(this.#enums);
    const name = this.#nameOfKind("e", 3, (candidate) => this.#enums.some((other) => other.name === candidate));
    if (type === undefined || name === undefined) {
      return undefined;
    }
    const old = type.name;
    this.#renameEnumTo(type, name);
    return `alter type ${old} rename to ${name}`;
  }

  #addValue(): string | undefined {
    const type = this.#pick(this.#enums);
    if (type === undefined) {
      return undefined;
    }
    const value = this.#name("v", 6, (candidate) => type.values.includes(candidate));
    if (value === undefined) {
      return undefined;
    }
    type.values.splice(this.#below(type.values.length + 1), 0, value);
    return `alter type ${type.name} add value ${value} -> (${type.values.join(", ")})`;
  }

  #renameValueTo(type: Enum, old: string, value: string): void {
    type.values[type.values.indexOf(old)] = value;
    type.valueRenames.push({ from: old, to: value, at: this.#position() });
    for (const column of this.#columnsOf(type, true)) {
      if (column.default?.kind === "value" && column.default.value === old) {
        column.default.value = value;
      }
    }
  }

  #renameValue(): string | undefined {
    const type = this.#pick(this.#enums.filter((candidate) => candidate.values.length > 0));
    if (type === undefined) {
      return undefined;
    }
    const old = this.#pick(type.values) as string;
    const value = this.#name("v", 6, (candidate) => type.values.includes(candidate));
    if (value === undefined) {
      return undefined;
    }
    this.#renameValueTo(type, old, value);
    return `alter type ${type.name} rename value ${old} to ${value}`;
  }

  #removeValue(): string | undefined {
    const type = this.#pick(this.#enums.filter((candidate) => candidate.values.length > 1));
    if (type === undefined) {
      return undefined;
    }
    const used = new Set(this.#columnsOf(type, true).map((column) => (column.default?.kind === "value" ? column.default.value : undefined)));
    const value = this.#pick(type.values.filter((candidate) => !used.has(candidate)));
    if (value === undefined) {
      return undefined;
    }
    type.values = type.values.filter((other) => other !== value);
    return `(by hand) remove value ${value} of ${type.name}`;
  }

  #reorderValues(): string | undefined {
    const type = this.#pick(this.#enums.filter((candidate) => candidate.values.length > 1));
    if (type === undefined) {
      return undefined;
    }
    type.values.reverse();
    return `(by hand) reverse the values of ${type.name}`;
  }

  /**
   * Two objects of one kind exchange their names, as migrations do it: the
   * first is renamed out of the way, the second takes the first's name, and
   * the first takes the second's. Each rename is recorded.
   */
  #exchangeNames(): string | undefined {
    const way = "exchange_tmp";
    if (this.#options.oneNamespace === true && this.#chance(0.5)) {
      // Two things of whatever kinds, which share their names: a table and an index, a type and a constraint, ...
      const things: { kind: string; object: Tracked; rename: (to: string) => void }[] = [
        ...this.#tables.map((table) => ({ kind: "table", object: table as Tracked, rename: (to: string) => this.#renameTableTo(table, to) })),
        ...this.#enums.map((type) => ({ kind: "type", object: type as Tracked, rename: (to: string) => this.#renameEnumTo(type, to) })),
        ...this.#constraints().map(({ constraint }) => ({ kind: "constraint", object: constraint, rename: (to: string) => this.#rename(constraint, to) })),
        ...this.#tables.flatMap((table) => table.indexes.map((index) => ({ kind: "index", object: index as Tracked, rename: (to: string) => this.#rename(index, to) }))),
      ];
      const first = this.#pick(things);
      const second = this.#pick(things.filter((other) => other.object !== first?.object));
      if (first === undefined || second === undefined) {
        return undefined;
      }
      const [a, b] = [first.object.name, second.object.name];
      first.rename(way);
      second.rename(a);
      first.rename(b);
      return `exchange the names of the ${first.kind} ${a} and the ${second.kind} ${b}`;
    }
    switch (this.#below(5)) {
      case 0: {
        const first = this.#pick(this.#tables);
        const second = this.#pick(this.#tables.filter((other) => other !== first));
        if (first === undefined || second === undefined) {
          return undefined;
        }
        const [a, b] = [first.name, second.name];
        this.#renameTableTo(first, way);
        this.#renameTableTo(second, a);
        this.#renameTableTo(first, b);
        return `exchange the names of the tables ${a} and ${b}`;
      }
      case 1: {
        const table = this.#pick(this.#tables.filter((candidate) => candidate.columns.length > 1));
        const first = table === undefined ? undefined : this.#pick(table.columns);
        const second = table === undefined ? undefined : this.#pick(table.columns.filter((other) => other !== first));
        if (table === undefined || first === undefined || second === undefined) {
          return undefined;
        }
        const [a, b] = [first.name, second.name];
        this.#renameColumnTo(table, first, way);
        this.#renameColumnTo(table, second, a);
        this.#renameColumnTo(table, first, b);
        return `exchange the names of the columns ${a} and ${b} of ${table.name}`;
      }
      case 2: {
        const all = this.#constraints().map(({ constraint }) => constraint);
        const first = this.#pick(all);
        const second = this.#pick(all.filter((other) => other !== first));
        if (first === undefined || second === undefined) {
          return undefined;
        }
        const [a, b] = [first.name, second.name];
        this.#rename(first, way);
        this.#rename(second, a);
        this.#rename(first, b);
        return `exchange the names of the constraints ${a} and ${b}`;
      }
      case 3: {
        const all = this.#tables.flatMap((table) => table.indexes);
        const first = this.#pick(all);
        const second = this.#pick(all.filter((other) => other !== first));
        if (first === undefined || second === undefined) {
          return undefined;
        }
        const [a, b] = [first.name, second.name];
        this.#rename(first, way);
        this.#rename(second, a);
        this.#rename(first, b);
        return `exchange the names of the indexes ${a} and ${b}`;
      }
      default: {
        const type = this.#pick(this.#enums.filter((candidate) => candidate.values.length > 1));
        const first = type === undefined ? undefined : this.#pick(type.values);
        const second = type === undefined ? undefined : this.#pick(type.values.filter((other) => other !== first));
        if (type === undefined || first === undefined || second === undefined) {
          return undefined;
        }
        this.#renameValueTo(type, first, way);
        this.#renameValueTo(type, second, first);
        this.#renameValueTo(type, way, second);
        return `exchange the values ${first} and ${second} of ${type.name}`;
      }
    }
  }

  // --- the schema as it is now ---------------------------------------------------------

  schema(): DatabaseSchema {
    const provenance = (object: Tracked): { origin: SchemaOrigin; renames?: SchemaRename[] } => ({ origin: { ...object.origin }, ...(object.renames.length > 0 && { renames: structuredClone(object.renames) }) });
    const enums = this.#enums.map((type): EnumType => ({ name: type.name, values: [...type.values], ...provenance(type), ...(type.valueRenames.length > 0 && { valueRenames: structuredClone(type.valueRenames) }) }));
    const typeOf = (type: Type): { type: ColumnType; declaredType: string; canonicalType: CanonicalType; enum?: { name: string; values: string[] } } => {
      switch (type.kind) {
        case "int":
          return { type: "integer", declaredType: "integer", canonicalType: { kind: "integer", bits: 32 } };
        case "bigint":
          return { type: "integer", declaredType: "bigint", canonicalType: { kind: "integer", bits: 64 } };
        case "text":
          return { type: "text", declaredType: "text", canonicalType: { kind: "text" } };
        case "varchar":
          return { type: "text", declaredType: "varchar(20)", canonicalType: { kind: "varchar", length: 20 } };
        case "bool":
          return { type: "boolean", declaredType: "boolean", canonicalType: { kind: "boolean" } };
        case "ts":
          return { type: "datetime", declaredType: "timestamptz", canonicalType: { kind: "timestamp", withTimeZone: true } };
        case "enum":
          return { type: "text", declaredType: type.enumName, canonicalType: { kind: "enum", name: type.enumName }, enum: { name: type.enumName, values: [...(this.#enums.find((candidate) => candidate.name === type.enumName) as Enum).values] } };
        default:
          return { type: "json", declaredType: `${type.enumName}[]`, canonicalType: { kind: "array", element: { kind: "enum", name: type.enumName } } };
      }
    };
    const tables = this.#tables.map((table): TableSchema => {
      // As a collector writes it: the first key over one column is on that column, the others in the table's list.
      const single = new Map<string, ForeignKey>();
      const several: ForeignKey[] = [];
      for (const key of table.foreignKeys) {
        const [only] = key.columns;
        if (key.columns.length === 1 && only !== undefined && !single.has(only)) {
          single.set(only, key);
        } else {
          several.push(key);
        }
      }
      const columns = table.columns.map((column): ColumnSchema => {
        const reference = single.get(column.name);
        const primary = table.primaryKey?.columns.includes(column.name) ?? false;
        return {
          name: column.name,
          ...typeOf(column.type),
          nullable: primary ? false : column.nullable,
          primary,
          ...(column.default?.kind === "value" && { default: structuredClone(column.default.value) }),
          // What a text names is said as a collector says it. The expressions of a history name nothing that a rename reaches: no column, no type, no value.
          ...(column.default?.kind === "function" && { defaultFunction: "current_timestamp" as const, defaultExpression: "now()", defaultNames: [] }),
          ...(column.default?.kind === "increment" && { generated: "increment" }),
          ...(column.default?.kind === "expression" && { defaultExpression: column.default.expression, defaultNames: [] }),
          ...(reference !== undefined && { references: { table: reference.table, column: reference.refColumns[0] as string, ...(reference.onDelete !== undefined && { onDelete: reference.onDelete }), name: reference.name, ...provenance(reference) } }),
          ...provenance(column),
        };
      });
      return {
        name: table.name,
        columns,
        ...(table.primaryKey !== undefined && { primaryKey: { name: table.primaryKey.name, columns: [...table.primaryKey.columns], ...provenance(table.primaryKey) } }),
        ...(table.uniques.length > 0 && { uniques: table.uniques.map((unique) => ({ name: unique.name, columns: [...unique.columns], ...provenance(unique) })) }),
        ...(several.length > 0 && {
          foreignKeys: several.map((key) => ({ name: key.name, columns: [...key.columns], references: { table: key.table, columns: [...key.refColumns] }, ...(key.onDelete !== undefined && { onDelete: key.onDelete }), ...provenance(key) })),
        }),
        ...(table.indexes.length > 0 && {
          indexes: table.indexes.map((index) => ({ name: index.name, columns: [...index.columns], ...(index.unique && { unique: true }), ...(index.expressions.length > 0 && { expressions: [...index.expressions] }), ...(index.where !== undefined && { where: index.where }), ...((index.expressions.length > 0 || index.where !== undefined) && { names: [] }), ...provenance(index) })),
        }),
        ...(table.checks.length > 0 && { checks: table.checks.map((check) => ({ name: check.name, expression: check.expression, names: [], ...provenance(check) })) }),
        ...provenance(table),
      };
    });
    return { tables, types: { enums } };
  }
}

/** A pair of schemas of one history: after `first` changes, and after `second` more, which are of a later migration file. */
export function historyPair(seed: number, options: HistoryOptions): { before: DatabaseSchema; after: DatabaseSchema; log: string[] } {
  const lengths = sequence(seed * 7919 + 13);
  const history = new History(seed, options);
  const first = 4 + Math.floor(lengths() * 22);
  for (let index = 0; index < first; index += 1) {
    history.step();
  }
  history.nextFile();
  const before = history.schema();
  const second = 1 + Math.floor(lengths() * 10);
  for (let index = 0; index < second; index += 1) {
    history.step();
  }
  return { before, after: history.schema(), log: history.log };
}

/** The same schema, listed in another order: its tables, types, constraints, and indexes, and the keys of every object. Columns keep their order. */
export function listedDifferently(schema: DatabaseSchema, seed: number): DatabaseSchema {
  const next = sequence(seed);
  const shuffled = <T>(list: readonly T[]): T[] => {
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = Math.floor(next() * (index + 1));
      [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
    }
    return copy;
  };
  const keysReversed = <T>(value: T): T => {
    if (Array.isArray(value)) {
      return value.map(keysReversed) as T;
    }
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, inner]) => [key, keysReversed(inner)]),
      ) as T;
    }
    return value;
  };
  return keysReversed({
    tables: shuffled(schema.tables).map((table) => ({
      ...table,
      ...(table.uniques !== undefined && { uniques: shuffled(table.uniques) }),
      ...(table.foreignKeys !== undefined && { foreignKeys: shuffled(table.foreignKeys) }),
      ...(table.indexes !== undefined && { indexes: shuffled(table.indexes) }),
      ...(table.checks !== undefined && { checks: shuffled(table.checks) }),
    })),
    types: { enums: shuffled(schema.types.enums) },
  });
}

/**
 * A copy of a schema as someone might write it by hand: without where things
 * come from, without the names of keys and constraints, without canonical
 * types, or with the enumerated types that columns give left out of the list
 * of types (`types`).
 */
export function without(schema: DatabaseSchema, what: readonly ("provenance" | "names" | "canonical" | "types")[]): DatabaseSchema {
  const copy = JSON.parse(
    JSON.stringify(schema, (key, inner: unknown) => {
      // Nor what its texts name: a schema that is written by hand says its texts, and no more.
      if (what.includes("provenance") && (key === "origin" || key === "renames" || key === "valueRenames" || key === "names" || key === "defaultNames")) {
        return undefined;
      }
      return what.includes("canonical") && key === "canonicalType" ? undefined : inner;
    }),
  ) as DatabaseSchema;
  if (what.includes("types")) {
    const given = new Set(copy.tables.flatMap((table) => table.columns.flatMap((column) => (column.enum === undefined ? [] : [column.enum.name]))));
    copy.types.enums = copy.types.enums.filter((type) => !given.has(type.name));
  }
  if (what.includes("names")) {
    for (const table of copy.tables) {
      for (const column of table.columns) {
        delete column.references?.name;
      }
      delete table.primaryKey?.name;
      for (const constraint of [...(table.uniques ?? []), ...(table.foreignKeys ?? []), ...(table.checks ?? [])]) {
        delete constraint.name;
      }
    }
  }
  return copy;
}
