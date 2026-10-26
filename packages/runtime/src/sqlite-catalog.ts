import { quoteIdentifier } from "./query-ir.ts";
import { RuntimeSchemaError } from "./runtime.ts";
import type { ColumnReference, ColumnSchema, ColumnType, ForeignKeyConstraint, TableSchema, UniqueConstraint } from "./runtime.ts";

/*
 * What SQL did to the tables of the runtime, read back from SQLite's catalog
 * as table definitions (Phase E1, D-045).
 *
 * The runtime creates its tables from definitions, and saves rows in the
 * shape those give them. A statement such as CREATE TABLE or ALTER TABLE
 * changes SQLite's tables and not the definitions. This reads the catalog
 * after such a statement and says what the tables are now, in the schema's
 * terms: a table that SQL did not touch keeps its definition as it was, with
 * all it says; a table or a column that SQL made is described from what
 * SQLite knows of it.
 *
 * Only what can be described without guessing is: tables made and dropped,
 * and columns added and dropped. Anything else that changed the catalog (an
 * index, a view, a trigger, a CHECK constraint, a collation, a type SQLite
 * gives no fixed meaning) is refused with what it is, so that nothing a
 * statement did is lost without a word.
 */

/** One object of SQLite's catalog (`sqlite_master`), other than SQLite's own. */
export interface CatalogEntry {
  type: string;
  name: string;
  table: string;
  sql: string | null;
}

/** Table definitions, and the catalog they describe: where the next reading starts from. */
export interface TableCatalog {
  readonly tables: readonly TableSchema[];
  readonly entries: readonly CatalogEntry[];
}

/** A change of the catalog that cannot be described as table definitions. Nothing was read. */
export class UnkeptSchemaChangeError extends RuntimeSchemaError {
  constructor(message: string) {
    super(message);
    this.name = "UnkeptSchemaChangeError";
  }
}

/** Runs a query on the database and returns its rows. */
export type CatalogQuery = (sql: string) => Record<string, unknown>[];

/**
 * The type names of SQLite's documentation ("Affinity Name Examples"), and
 * what the runtime stores each as. BOOLEAN, DATE, and DATETIME are the
 * runtime's own spellings of its types. A name that is not here (`serial`,
 * `uuid`, `timestamptz`, `json`) is refused: SQLite would accept it with an
 * affinity of its own, which is not what such a name says.
 */
const TYPE_NAMES: Readonly<Record<string, ColumnType>> = {
  INT: "integer",
  INTEGER: "integer",
  TINYINT: "integer",
  SMALLINT: "integer",
  MEDIUMINT: "integer",
  BIGINT: "integer",
  "UNSIGNED BIG INT": "integer",
  INT2: "integer",
  INT8: "integer",
  CHARACTER: "text",
  VARCHAR: "text",
  "VARYING CHARACTER": "text",
  NCHAR: "text",
  "NATIVE CHARACTER": "text",
  NVARCHAR: "text",
  TEXT: "text",
  CLOB: "text",
  BLOB: "binary",
  REAL: "real",
  DOUBLE: "real",
  "DOUBLE PRECISION": "real",
  FLOAT: "real",
  NUMERIC: "numeric",
  DECIMAL: "numeric",
  BOOLEAN: "boolean",
  DATE: "date",
  DATETIME: "datetime",
  "": "any",
};

/** What the schema has no place for, in SQL that made a table or a column. Looked for outside quotes and comments. */
const UNKEPT_CLAUSES: readonly [RegExp, string][] = [
  [/\bCHECK\b/i, "a CHECK constraint"],
  [/\bCOLLATE\b/i, "a collation"],
  [/\bDEFERRABLE\b/i, "a deferrable key"],
  [/\bON\s+CONFLICT\b/i, "an ON CONFLICT clause"],
  [/\bGENERATED\b|\bAS\s*\(/i, "a generated column"],
  [/\bWITHOUT\s+ROWID\b/i, "WITHOUT ROWID"],
  [/\)\s*STRICT\b/i, "STRICT"],
];

/** The SQL with quoted names, string literals, and comments blanked out, so that a word is looked for only where it is a word of SQL. */
function unquoted(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, (run) => " ".repeat(run.length));
}

function refuseClauses(sql: string, what: string): void {
  const text = unquoted(sql);
  for (const [pattern, clause] of UNKEPT_CLAUSES) {
    if (pattern.test(text)) {
      throw new UnkeptSchemaChangeError(`${what} has ${clause}, which a table definition of the sandbox has no place for.`);
    }
  }
}

function entriesOf(query: CatalogQuery): CatalogEntry[] {
  return query("SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid").map((row) => ({
    type: String(row.type),
    name: String(row.name),
    table: String(row.tbl),
    sql: row.sql === null || row.sql === undefined ? null : String(row.sql),
  }));
}

/** The catalog as it is, for the definitions the runtime created its tables from. */
export function catalogOf(query: CatalogQuery, tables: readonly TableSchema[]): TableCatalog {
  return { tables, entries: entriesOf(query) };
}

interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultSql: string | null;
  /** Position in the primary key, from 1; 0 when not part of it. */
  pk: number;
  hidden: number;
}

function columnsOf(query: CatalogQuery, table: string): ColumnInfo[] {
  return query(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).map((row) => ({
    name: String(row.name),
    type: String(row.type ?? ""),
    notNull: Number(row.notnull) === 1,
    defaultSql: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
    pk: Number(row.pk),
    hidden: Number(row.hidden),
  }));
}

interface KeyInfo {
  id: number;
  table: string;
  from: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
}

function keysOf(query: CatalogQuery, table: string): KeyInfo[] {
  return query(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).map((row) => ({
    id: Number(row.id),
    table: String(row.table),
    from: String(row.from),
    to: row.to === null || row.to === undefined ? null : String(row.to),
    onUpdate: String(row.on_update),
    onDelete: String(row.on_delete),
  }));
}

function typeOf(declared: string, where: string): ColumnType {
  // `VARCHAR(255)`, `DECIMAL(10, 2)`: the size says nothing of how a value is stored.
  const name = declared.replace(/\(\s*[+-]?\d+\s*(?:,\s*[+-]?\d+\s*)?\)\s*$/, "").trim().replace(/\s+/g, " ").toUpperCase();
  const type = Object.hasOwn(TYPE_NAMES, name) ? TYPE_NAMES[name] : undefined;
  if (type === undefined) {
    throw new UnkeptSchemaChangeError(
      `${where} has the type ${JSON.stringify(declared)}, which the sandbox's SQLite gives no meaning of its own (SQLite would store it by an affinity, not as that type). ` +
        "Use a type of SQLite: INTEGER, REAL, NUMERIC, TEXT, BLOB, BOOLEAN, DATE, or DATETIME.",
    );
  }
  return type;
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const STRING = /^'((?:[^']|'')*)'$/;

/** A column's default, as the schema keeps one: a value, or the time or day of the write. */
function defaultOf(text: string | null, type: ColumnType, where: string): Pick<ColumnSchema, "default" | "defaultFunction"> {
  if (text === null) {
    return {};
  }
  // A signed number may be written in parentheses (`DEFAULT (-1)`); it is still that number.
  const value = text.trim().replace(/^\(\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*\)$/, "$1");
  const upper = value.toUpperCase();
  const unfit = (): never => {
    throw new UnkeptSchemaChangeError(`${where} has the default ${value}, which is not a value of a ${type} column that a table definition of the sandbox can keep.`);
  };
  if (upper === "NULL") {
    return {};
  }
  if (upper === "CURRENT_TIMESTAMP" || upper === "CURRENT_DATE") {
    const wanted = upper === "CURRENT_TIMESTAMP" ? "datetime" : "date";
    return type === wanted ? { defaultFunction: upper === "CURRENT_TIMESTAMP" ? "current_timestamp" : "current_date" } : unfit();
  }
  if (upper === "TRUE" || upper === "FALSE") {
    return type === "boolean" ? { default: upper === "TRUE" } : unfit();
  }
  if (NUMBER.test(value)) {
    const number = Number(value);
    if (type === "boolean") {
      return number === 0 || number === 1 ? { default: number === 1 } : unfit();
    }
    return type === "integer" || type === "real" || type === "numeric" || type === "any" ? { default: number } : unfit();
  }
  const quoted = STRING.exec(value);
  if (quoted !== null) {
    return type === "text" || type === "date" || type === "datetime" || type === "any" ? { default: (quoted[1] as string).replaceAll("''", "'") } : unfit();
  }
  throw new UnkeptSchemaChangeError(`${where} has the default ${value}, an expression: a table definition of the sandbox keeps a value, CURRENT_TIMESTAMP, or CURRENT_DATE.`);
}

/** What `REFERENCES t` with no column refers to: the primary key of `t`. */
function referencedColumns(target: string, tables: readonly TableSchema[], where: string): string[] {
  const table = tables.find((candidate) => candidate.name === target);
  const primary = table?.primaryKey?.columns ?? table?.columns.filter((column) => column.primary).map((column) => column.name) ?? [];
  if (primary.length === 0) {
    throw new UnkeptSchemaChangeError(`${where} refers to "${target}" without naming its columns, and "${target}" has no primary key to refer to.`);
  }
  return primary;
}

const action = (value: string): string | undefined => (value.toUpperCase() === "NO ACTION" ? undefined : value.toUpperCase());

/**
 * The foreign keys of a table, of the columns `of`, in the schema's terms: a
 * key over one column is that column's `references`; one over several is a
 * key of the table.
 */
function keysFor(query: CatalogQuery, table: string, of: ReadonlySet<string>, tables: readonly TableSchema[]): { columns: Map<string, ColumnReference>; table: ForeignKeyConstraint[] } {
  const groups = new Map<number, KeyInfo[]>();
  for (const key of keysOf(query, table)) {
    groups.set(key.id, [...(groups.get(key.id) ?? []), key]);
  }
  const columns = new Map<string, ColumnReference>();
  const keys: ForeignKeyConstraint[] = [];
  for (const group of groups.values()) {
    if (!group.every((key) => of.has(key.from))) {
      continue;
    }
    const first = group[0] as KeyInfo;
    const where = `The foreign key of "${table}" (${group.map((key) => key.from).join(", ")})`;
    const to = group.every((key) => key.to !== null) ? group.map((key) => key.to as string) : referencedColumns(first.table, tables, where);
    if (to.length !== group.length) {
      throw new UnkeptSchemaChangeError(`${where} has ${group.length} columns and refers to ${to.length}.`);
    }
    const onDelete = action(first.onDelete);
    const onUpdate = action(first.onUpdate);
    if (group.length === 1) {
      columns.set(first.from, { table: first.table, column: to[0] as string, ...(onDelete !== undefined && { onDelete }), ...(onUpdate !== undefined && { onUpdate }) });
    } else {
      keys.push({ columns: group.map((key) => key.from), references: { table: first.table, columns: to }, ...(onDelete !== undefined && { onDelete }), ...(onUpdate !== undefined && { onUpdate }) });
    }
  }
  return { columns, table: keys };
}

/** A column that SQL made, from what SQLite knows of it. */
function columnFrom(info: ColumnInfo, table: string, singleKey: boolean, references: ColumnReference | undefined): ColumnSchema {
  const where = `Column "${table}"."${info.name}"`;
  if (info.hidden !== 0) {
    throw new UnkeptSchemaChangeError(`${where} is ${info.hidden === 1 ? "a hidden column" : "a generated column"}, which a table definition of the sandbox has no place for.`);
  }
  const type = typeOf(info.type, where);
  // INTEGER PRIMARY KEY, spelled so, is SQLite's row id: the database assigns the next integer.
  const rowId = singleKey && info.pk === 1 && info.type.trim().toUpperCase() === "INTEGER";
  return {
    name: info.name,
    type,
    ...(info.type !== "" && { declaredType: info.type }),
    nullable: !info.notNull && !rowId,
    primary: info.pk > 0,
    ...(rowId && { autoIncrement: true }),
    ...defaultOf(info.defaultSql, type, where),
    ...(references !== undefined && { references }),
  };
}

/** A table that SQL made, from what SQLite knows of it. */
function tableFrom(query: CatalogQuery, entry: CatalogEntry, tables: readonly TableSchema[]): TableSchema {
  const where = `Table "${entry.name}"`;
  if (entry.sql === null || /^\s*CREATE\s+VIRTUAL\b/i.test(entry.sql)) {
    throw new UnkeptSchemaChangeError(`${where} is a virtual table, which the sandbox does not keep.`);
  }
  refuseClauses(entry.sql, where);
  const infos = columnsOf(query, entry.name);
  const primary = infos.filter((info) => info.pk > 0).sort((a, b) => a.pk - b.pk);
  const keys = keysFor(query, entry.name, new Set(infos.map((info) => info.name)), tables);
  const columns = infos.map((info) => columnFrom(info, entry.name, primary.length === 1, keys.columns.get(info.name)));

  const uniques: UniqueConstraint[] = [];
  for (const index of query(`PRAGMA index_list(${quoteIdentifier(entry.name)})`)) {
    if (String(index.origin) === "u") {
      const keyColumns = query(`PRAGMA index_info(${quoteIdentifier(String(index.name))})`)
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((row) => String(row.name));
      uniques.push({ columns: keyColumns });
    }
  }
  return {
    name: entry.name,
    columns,
    ...(primary.length > 1 && { primaryKey: { columns: primary.map((info) => info.name) } }),
    ...(uniques.length > 0 && { uniques }),
    ...(keys.table.length > 0 && { foreignKeys: keys.table }),
  };
}

/** The columns of a definition that a table-level part of it names. */
function namedColumns(table: TableSchema): Set<string> {
  return new Set([
    ...(table.primaryKey?.columns ?? []),
    ...(table.uniques ?? []).flatMap((unique) => unique.columns),
    ...(table.foreignKeys ?? []).flatMap((key) => key.columns),
    ...(table.indexes ?? []).flatMap((index) => index.columns),
  ]);
}

/**
 * A table whose SQL changed: columns added at its end, or dropped, as ALTER
 * TABLE does. The columns that are left keep their definitions.
 */
function alteredTable(query: CatalogQuery, before: TableSchema, was: CatalogEntry, now: CatalogEntry, tables: readonly TableSchema[]): TableSchema {
  const where = `Table "${now.name}"`;
  const infos = columnsOf(query, now.name);
  const names = infos.map((info) => info.name);
  const kept = before.columns.filter((column) => names.includes(column.name));
  const removed = before.columns.filter((column) => !names.includes(column.name)).map((column) => column.name);
  const added = infos.slice(kept.length);
  if (kept.some((column, index) => column.name !== names[index])) {
    throw new UnkeptSchemaChangeError(`${where} has its columns renamed or in another order, which the simulation does not follow. It keeps tables made and dropped, and columns added and dropped.`);
  }
  if (added.length === 0 && removed.length === 0) {
    throw new UnkeptSchemaChangeError(`${where} was changed in a way the simulation does not follow (its columns are the same, its definition is not). It keeps tables made and dropped, and columns added and dropped.`);
  }
  if (added.length > 0) {
    // ALTER TABLE ... ADD COLUMN inserts the column's definition into the table's SQL, after its last column: what
    // is new is what lies between what the two have in common at the start and at the end.
    const old = was.sql ?? "";
    const text = now.sql ?? "";
    let start = 0;
    while (start < old.length && old[start] === text[start]) {
      start += 1;
    }
    if (removed.length > 0 || !text.endsWith(old.slice(start))) {
      throw new UnkeptSchemaChangeError(`${where} has columns added and others dropped or renamed at once, which the simulation cannot tell apart. Change one column per statement.`);
    }
    refuseClauses(text.slice(start, text.length - (old.length - start)), `The column added to "${now.name}"`);
  }
  const named = namedColumns(before);
  const referenced = removed.find((name) => named.has(name) || tables.some((other) => other.name !== before.name && other.columns.some((column) => column.references?.table === before.name && column.references.column === name)));
  if (referenced !== undefined) {
    throw new UnkeptSchemaChangeError(`${where}: the column "${referenced}" is gone, and a key, a unique constraint, or an index of the stored definitions still names it.`);
  }
  const keys = keysFor(query, now.name, new Set(added.map((info) => info.name)), tables);
  return {
    ...before,
    columns: [...kept, ...added.map((info) => columnFrom(info, now.name, false, keys.columns.get(info.name)))],
    ...(keys.table.length > 0 && { foreignKeys: [...(before.foreignKeys ?? []), ...keys.table] }),
  };
}

const sameEntry = (a: CatalogEntry, b: CatalogEntry): boolean => a.type === b.type && a.name === b.name && a.table === b.table && a.sql === b.sql;

/**
 * The tables as they are now, starting from a reading of them: what SQL did
 * since `from`, in the schema's terms. Throws `UnkeptSchemaChangeError` for
 * a change that cannot be described; `from` is then still what the tables
 * were.
 */
export function readTableCatalog(query: CatalogQuery, from: TableCatalog): TableCatalog {
  const entries = entriesOf(query);
  const tablesNow = entries.filter((entry) => entry.type === "table");
  const tablesBefore = new Map(from.entries.filter((entry) => entry.type === "table").map((entry) => [entry.name, entry]));
  const dropped = new Set([...tablesBefore.keys()].filter((name) => !tablesNow.some((entry) => entry.name === name)));

  // Indexes, views, and triggers: SQL made, dropped, or changed none, but for those that went with a table that was dropped.
  const others = (list: readonly CatalogEntry[]): CatalogEntry[] => list.filter((entry) => entry.type !== "table" && entry.sql !== null && !dropped.has(entry.table));
  const otherBefore = others(from.entries);
  const otherNow = others(entries);
  for (const entry of otherNow) {
    if (!otherBefore.some((candidate) => sameEntry(candidate, entry))) {
      throw new UnkeptSchemaChangeError(
        `The ${entry.type} "${entry.name}" was ${from.entries.some((candidate) => candidate.type === entry.type && candidate.name === entry.name) ? "changed" : "made"}: a simulated copy keeps tables and their columns, and no ${entry.type} that SQL makes or changes.`,
      );
    }
  }
  for (const entry of otherBefore) {
    if (!otherNow.some((candidate) => candidate.name === entry.name)) {
      throw new UnkeptSchemaChangeError(`The ${entry.type} "${entry.name}" was dropped: a simulated copy keeps the indexes of its stored definitions, and does not follow one that SQL drops.`);
    }
  }

  const definitions = new Map(from.tables.map((table) => [table.name, table]));
  const tables: TableSchema[] = [];
  for (const table of from.tables) {
    const was = tablesBefore.get(table.name);
    const now = tablesNow.find((entry) => entry.name === table.name);
    if (now === undefined) {
      continue;
    }
    tables.push(was === undefined || was.sql === now.sql ? table : alteredTable(query, table, was, now, from.tables));
  }
  for (const entry of tablesNow) {
    if (!definitions.has(entry.name)) {
      tables.push(tableFrom(query, entry, [...tables, ...from.tables]));
    }
  }
  return { tables, entries };
}
