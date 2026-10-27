import type { Row } from "../../../core/src/index.ts";
import type { CanonicalType } from "../../../runtime/src/canonical-type.ts";
import type { ColumnSchema, DatabaseSchema, TableSchema } from "../../../runtime/src/index.ts";
import { diffSchemas } from "../../../schema-diff/src/index.ts";
import { DiffApplicationError } from "../apply-diff.ts";
import { planMigration } from "../planner.ts";
import { MigrationPlanError } from "../validate.ts";
import { generatePostgresMigration } from "./generator.ts";
import { Refusal } from "./safety.ts";
import { quoteIdentifier, quoteLiteral } from "./sql.ts";
import { expressionsOf, statementSql } from "./statements.ts";
import type { PostgresStatement, StatementBody, TableConstraint } from "./statements.ts";
import { defaultLiteral } from "./types.ts";

/*
 * Tables of a sandbox as an SQL script for PostgreSQL (D-050): their
 * definitions, their rows, or both, to load into an empty PostgreSQL
 * database with `psql -f`.
 *
 * Nothing here is a second generator. The definitions are the migration
 * from an empty schema to the tables (D-037, D-038, D-039): the same
 * statements, refused for the same reasons. The rows are written with the
 * generator's own constants (`defaultLiteral`), names (`quoteIdentifier`),
 * and texts (`quoteLiteral`), from the canonical type of each column.
 *
 * What PostgreSQL asks of a load beyond a migration:
 *
 * - Foreign keys are added after the rows, so that tables that refer to one
 *   another, or to themselves, load in any order. (Rows alone are put in the
 *   order of the foreign keys among the tables, and a table that refers to
 *   itself has its rows put after those they refer to, where that can be.)
 * - A numbered column gets the values the rows have, and its sequence is set
 *   past the largest, so that the next row PostgreSQL numbers does not take
 *   one of them.
 * - Everything is one transaction: a load that fails anywhere leaves nothing.
 *
 * What cannot be written as what it is, is not written: the export is
 * refused, with every reason, and gives no script at all. What the script
 * leaves out on purpose is said in it, and to whoever asked (`warnings`).
 */

export type SqlExportMode = "schema" | "data" | "schema-and-data";

export const SQL_EXPORT_MODES: readonly SqlExportMode[] = ["schema", "data", "schema-and-data"];

/** The default most an export may be, in bytes of SQL text. */
export const DEFAULT_MAX_EXPORT_BYTES = 67_108_864;

/** Rows of a table in one INSERT. */
const ROWS_PER_INSERT = 100;

export interface SqlExportInput {
  /** The tables to export, as the sandbox has them, and the enumerated types they use. */
  schema: DatabaseSchema;
  /** Rows by table, as fixture values. Required for the modes with data. */
  rows?: Record<string, Row[]>;
  mode: SqlExportMode;
  /** Bytes of SQL text the export may have (default 64 MiB). */
  maxBytes?: number;
}

/** A reason an export was refused: what, and why. */
export interface SqlExportRefusal {
  table?: string;
  column?: string;
  message: string;
}

export type SqlExport =
  | {
      status: "exported";
      /** The script. */
      sql: string;
      /** The tables, in the order the script has them. */
      tables: string[];
      rows: number;
      /** Statements, not counting BEGIN and COMMIT. */
      statements: number;
      /** What the script leaves out, or rests on, on purpose: also said in it. */
      warnings: string[];
      /** The statements of definitions, with the expressions of the schema they hold, for a check with PostgreSQL's parser. */
      definitions: { sql: string; expressions?: string[] }[];
    }
  | { status: "refused"; refusals: SqlExportRefusal[] };

export const MODE_LABEL: Record<SqlExportMode, string> = { schema: "schema only", data: "data only", "schema-and-data": "schema and data" };

/** A line of comment: what it says may hold a name, and a name may hold a line end, which would end the comment. */
const comment = (text: string): string => `-- ${text.replace(/[\r\n]+/g, " ")}`;
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The foreign keys of a table, as the schema has them: each column's own, and those over several columns. */
function foreignKeysOf(table: TableSchema): { name?: string; columns: string[]; table: string; refColumns: string[] }[] {
  return [
    ...table.columns.filter((column) => column.references !== undefined).map((column) => ({ ...(column.references?.name !== undefined && { name: column.references.name }), columns: [column.name], table: column.references?.table as string, refColumns: [column.references?.column as string] })),
    ...(table.foreignKeys ?? []).map((key) => ({ ...(key.name !== undefined && { name: key.name }), columns: [...key.columns], table: key.references.table, refColumns: [...key.references.columns] })),
  ];
}

/**
 * The schema without the foreign keys to tables that are not exported: such
 * a key could not be created, and would hold no row the script has. Each one
 * is said, when the script has definitions (`say`).
 */
function withinExport(schema: DatabaseSchema, warnings: string[], say: boolean): DatabaseSchema {
  const exported = new Set(schema.tables.map((table) => table.name));
  const left = (table: TableSchema, columns: string[], target: string): void => {
    if (say) {
      warnings.push(`The foreign key of "${table.name}" (${columns.join(", ")}) to "${target}" is left out: "${target}" is not exported.`);
    }
  };
  const tables = schema.tables.map((table): TableSchema => {
    const columns = table.columns.map((column): ColumnSchema => {
      if (column.references === undefined || exported.has(column.references.table)) {
        return column;
      }
      left(table, [column.name], column.references.table);
      const { references: _references, ...rest } = column;
      return rest;
    });
    const foreignKeys = (table.foreignKeys ?? []).filter((key) => {
      if (exported.has(key.references.table)) {
        return true;
      }
      left(table, key.columns, key.references.table);
      return false;
    });
    const { foreignKeys: _foreignKeys, ...rest } = table;
    return { ...rest, columns, ...(foreignKeys.length > 0 && { foreignKeys }) };
  });
  return { tables, types: schema.types };
}

/**
 * The tables in the order of their foreign keys among them, as far as there
 * is one: a table after the tables it refers to. Tables that refer to one
 * another keep the order they had, and are named.
 */
function loadOrder(tables: readonly TableSchema[]): { order: TableSchema[]; cycles: string[][]; selfReferring: string[] } {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const needs = new Map(tables.map((table) => [table.name, new Set(foreignKeysOf(table).map((key) => key.table).filter((name) => name !== table.name && byName.has(name)))]));
  const selfReferring = tables.filter((table) => foreignKeysOf(table).some((key) => key.table === table.name)).map((table) => table.name);
  const order: TableSchema[] = [];
  const placed = new Set<string>();
  let remaining = tables.map((table) => table.name);
  while (remaining.length > 0) {
    const ready = remaining.filter((name) => [...(needs.get(name) ?? [])].every((other) => placed.has(other)));
    if (ready.length === 0) {
      break;
    }
    for (const name of ready) {
      order.push(byName.get(name) as TableSchema);
      placed.add(name);
    }
    remaining = remaining.filter((name) => !placed.has(name));
  }
  // What is left refers, through one table or more, to itself.
  const cycles = remaining.length > 0 ? [remaining] : [];
  order.push(...remaining.map((name) => byName.get(name) as TableSchema));
  return { order, cycles, selfReferring };
}

/** The rows of a table that refers to itself over one column, those that are referred to first, where that can be. */
function selfOrdered(table: TableSchema, rows: readonly Row[]): Row[] {
  const keys = foreignKeysOf(table).filter((key) => key.table === table.name && key.columns.length === 1);
  if (keys.length !== 1) {
    return [...rows];
  }
  const [key] = keys as [(typeof keys)[number]];
  const column = key.columns[0] as string;
  const target = key.refColumns[0] as string;
  const byValue = new Map<string, Row>();
  rows.forEach((row) => byValue.set(JSON.stringify(row[target] ?? null), row));
  const done = new Set<Row>();
  const out: Row[] = [];
  const visit = (row: Row, path: Set<Row>): void => {
    if (done.has(row) || path.has(row)) {
      return;
    }
    path.add(row);
    const parent = row[column] === null || row[column] === undefined ? undefined : byValue.get(JSON.stringify(row[column]));
    if (parent !== undefined && parent !== row) {
      visit(parent, path);
    }
    done.add(row);
    out.push(row);
  };
  rows.forEach((row) => visit(row, new Set()));
  return out;
}

const DECIMAL_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * One value of a column, as a constant of the column's canonical type
 * (`defaultLiteral`, the generator's own). A whole number or a decimal that
 * the sandbox keeps as its digits, because a JavaScript number does not hold
 * it exactly, is written as those digits. A column without a canonical type
 * (a schema written by hand) has its value written as the constant
 * PostgreSQL reads into the column's type from the text, by how the sandbox
 * stores it.
 */
function valueSql(column: ColumnSchema, value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  const type: CanonicalType | undefined = column.canonicalType;
  if (type !== undefined) {
    if ((type.kind === "integer" && typeof value === "string" && /^[+-]?\d+$/.test(value)) || ((type.kind === "decimal" || type.kind === "float") && typeof value === "string" && DECIMAL_TEXT.test(value))) {
      return value;
    }
    return defaultLiteral(type, value);
  }
  switch (column.type) {
    case "integer":
    case "real":
    case "numeric":
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
      if (typeof value === "string" && DECIMAL_TEXT.test(value)) {
        return value;
      }
      break;
    case "boolean":
      if (typeof value === "boolean") {
        return String(value);
      }
      break;
    case "json":
      return quoteLiteral(JSON.stringify(value));
    case "binary":
      if (typeof value === "string" && BASE64.test(value)) {
        return quoteLiteral(`\\x${Buffer.from(value, "base64").toString("hex")}`);
      }
      break;
    default:
      if (typeof value === "string") {
        return quoteLiteral(value);
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return String(value);
      }
      if (typeof value === "boolean") {
        return String(value);
      }
      return quoteLiteral(JSON.stringify(value));
  }
  throw new Refusal("value-not-representable", `${JSON.stringify(value)} is not a value of the column's type (${column.type}).`);
}

/** The definitions: the migration from an empty schema to the tables, with the foreign keys taken out to come last. */
function definitionsOf(schema: DatabaseSchema): { early: PostgresStatement[]; foreignKeys: { sql: string; expressions?: string[] }[] } | { refusals: SqlExportRefusal[] } {
  const empty: DatabaseSchema = { tables: [], types: { enums: [] } };
  let generation;
  try {
    generation = generatePostgresMigration(empty, planMigration(empty, diffSchemas(empty, schema)));
  } catch (error) {
    if (error instanceof DiffApplicationError || error instanceof MigrationPlanError) {
      return { refusals: [{ message: `The tables cannot be written as definitions: ${error.message}` }] };
    }
    throw error;
  }
  if (generation.status === "refused") {
    return { refusals: generation.refusals.map((refusal) => ({ message: `${refusal.operation}: ${refusal.detail ?? refusal.reason ?? refusal.safety}` })) };
  }
  const early: PostgresStatement[] = [];
  const foreignKeys: { sql: string; expressions?: string[] }[] = [];
  const later = (table: string, constraint: TableConstraint): void => {
    const body: StatementBody = { kind: "addConstraint", table, constraint };
    foreignKeys.push({ sql: statementSql(body) });
  };
  for (const statement of generation.migration.segments.flatMap((segment) => segment.statements)) {
    if (statement.kind === "createTable" && statement.constraints.some((constraint) => constraint.kind === "foreignKey")) {
      const { sql: _sql, expressions: _expressions, ...notes } = statement;
      const body: StatementBody = { kind: "createTable", table: statement.table, columns: statement.columns, constraints: statement.constraints.filter((constraint) => constraint.kind !== "foreignKey") };
      const expressions = expressionsOf(body);
      early.push({ ...notes, ...body, sql: statementSql(body), ...(expressions.length > 0 && { expressions }) } as PostgresStatement);
      statement.constraints.filter((constraint) => constraint.kind === "foreignKey").forEach((constraint) => later(statement.table, constraint));
    } else if (statement.kind === "addConstraint" && statement.constraint.kind === "foreignKey") {
      later(statement.table, statement.constraint);
    } else {
      early.push(statement);
    }
  }
  return { early, foreignKeys };
}

/** Tables of a sandbox as an SQL script for PostgreSQL, or every reason it cannot be one. */
export function exportPostgresSql(input: SqlExportInput): SqlExport {
  const { mode } = input;
  const withData = mode !== "schema";
  const withSchema = mode !== "data";
  const warnings: string[] = [];
  const refusals: SqlExportRefusal[] = [];
  if (input.schema.tables.length === 0) {
    return { status: "refused", refusals: [{ message: "No table was chosen to export." }] };
  }
  if (withData && input.rows === undefined) {
    return { status: "refused", refusals: [{ message: "The rows of the tables are needed for an export with data." }] };
  }
  const schema = withinExport(input.schema, warnings, withSchema);
  const { order, cycles, selfReferring } = loadOrder(schema.tables);
  // Rows alone go into tables that are there: what they refer to outside the export, the target has to hold.
  const outside = withData && !withSchema ? input.schema.tables.flatMap((table) => foreignKeysOf(table).filter((key) => !schema.tables.some((other) => other.name === key.table)).map((key) => `"${table.name}" (${key.columns.join(", ")}) refers to "${key.table}"`)) : [];

  let definitions: { early: PostgresStatement[]; foreignKeys: { sql: string; expressions?: string[] }[] } | undefined;
  if (withSchema) {
    const made = definitionsOf(schema);
    if ("refusals" in made) {
      refusals.push(...made.refusals);
    } else {
      definitions = made;
    }
  }

  // The rows, table by table, as INSERTs of up to a hundred rows each.
  const inserts: string[] = [];
  const sequences: string[] = [];
  let rowCount = 0;
  if (withData) {
    for (const table of order) {
      const rows = table.name in (input.rows ?? {}) ? (input.rows?.[table.name] ?? []) : [];
      const untyped = table.columns.filter((column) => column.canonicalType === undefined).map((column) => column.name);
      if (untyped.length > 0 && rows.length > 0) {
        warnings.push(`"${table.name}": ${untyped.join(", ")} ${untyped.length === 1 ? "has" : "have"} no type of the database in the sandbox's schema; ${untyped.length === 1 ? "its values are" : "their values are"} written as constants that PostgreSQL reads into the type the column has where the script is loaded.`);
      }
      if (rows.length === 0) {
        continue;
      }
      rowCount += rows.length;
      const numbered = table.columns.filter((column) => column.autoIncrement === true);
      let names: string;
      try {
        names = table.columns.map((column) => quoteIdentifier(column.name)).join(", ");
      } catch (error) {
        refusals.push({ table: table.name, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      // A numbered column of the target may be an identity that takes no value from a row unless told to: the rows' own values are kept.
      const head = `INSERT INTO ${quoteIdentifier(table.name)} (${names})${numbered.length > 0 ? " OVERRIDING SYSTEM VALUE" : ""} VALUES`;
      const ordered = mode === "data" && selfReferring.includes(table.name) ? selfOrdered(table, rows) : rows;
      for (let start = 0; start < ordered.length; start += ROWS_PER_INSERT) {
        const values: string[] = [];
        for (const [offset, row] of ordered.slice(start, start + ROWS_PER_INSERT).entries()) {
          const cells: string[] = [];
          for (const column of table.columns) {
            const key = column.key ?? column.name;
            try {
              cells.push(valueSql(column, row[key]));
            } catch (error) {
              refusals.push({ table: table.name, column: column.name, message: `Row ${start + offset + 1}: ${error instanceof Error ? error.message : String(error)}` });
              cells.push("NULL");
            }
          }
          values.push(`  (${cells.join(", ")})`);
        }
        inserts.push(`${head}\n${values.join(",\n")}`);
        if (refusals.length > 50) {
          break;
        }
      }
      for (const column of numbered) {
        // pg_get_serial_sequence finds the sequence of a serial column and of an identity column alike; with none, it gives NULL, and setval does nothing.
        sequences.push(
          `SELECT setval(pg_get_serial_sequence(${quoteLiteral(quoteIdentifier(table.name))}, ${quoteLiteral(column.name)}), COALESCE(MAX(${quoteIdentifier(column.name)}), 0) + 1, false) FROM ${quoteIdentifier(table.name)}`,
        );
      }
    }
  }
  if (refusals.length > 0) {
    return { status: "refused", refusals: refusals.slice(0, 50) };
  }

  if (withData && !withSchema) {
    if (cycles.length > 0 || selfReferring.length > 0) {
      const named = [...new Set([...cycles.flat(), ...selfReferring])].map((name) => `"${name}"`).join(", ");
      warnings.push(
        `${named} refer to one another or to themselves. The rows are loaded in one order; where the foreign keys of the target are not DEFERRABLE, a row may come before the row it refers to and be refused. Export schema and data together to load them without that.`,
      );
    }
    if (outside.length > 0) {
      warnings.push(`Rows refer to tables that are not exported, which the target has to hold already: ${outside.join("; ")}.`);
    }
  }

  const statements: string[] = [];
  if (definitions !== undefined) {
    statements.push(...definitions.early.map((statement) => statement.sql));
  }
  if (withData && !withSchema && (cycles.length > 0 || selfReferring.length > 0)) {
    statements.push("SET CONSTRAINTS ALL DEFERRED");
  }
  statements.push(...inserts, ...sequences);
  if (definitions !== undefined) {
    statements.push(...definitions.foreignKeys.map((statement) => statement.sql));
  }

  const tables = order.map((table) => table.name);
  const lines = [
    comment("Local DB Sandbox: SQL export for PostgreSQL."),
    comment(`Mode: ${MODE_LABEL[mode]}. Tables (${tables.length}): ${tables.join(", ")}.${withData ? ` Rows: ${rowCount}.` : ""}`),
    comment(withSchema ? "Load it into a database that has none of these tables or types, with a client that sends one statement at a time: psql -v ON_ERROR_STOP=1 -f <file>." : "Load it into a database that has these tables, empty, with a client that sends one statement at a time: psql -v ON_ERROR_STOP=1 -f <file>."),
    comment("It is one transaction: when a statement fails, nothing of it stays."),
    ...(withData ? [comment("It holds the rows of the tables as they are in the sandbox: data you entered, which may be personal. Keep the file accordingly.")] : []),
    ...(warnings.length > 0 ? [comment("Warnings:"), ...warnings.map((warning) => comment(`  ${warning}`))] : []),
    "",
    "BEGIN;",
    "",
    ...statements.map((statement) => `${statement};\n`),
    "COMMIT;",
    "",
    comment(`End of export: ${plural(statements.length, "statement")}.`),
    "",
  ];
  const sql = lines.join("\n");
  const most = input.maxBytes ?? DEFAULT_MAX_EXPORT_BYTES;
  const bytes = Buffer.byteLength(sql);
  if (bytes > most) {
    return { status: "refused", refusals: [{ message: `The script would have ${bytes} bytes, and an export may have ${most}. Export fewer tables, or the schema alone.` }] };
  }
  const definitionChecks = definitions === undefined ? [] : [...definitions.early.map((statement) => ({ sql: statement.sql, ...(statement.expressions !== undefined && { expressions: statement.expressions }) })), ...definitions.foreignKeys];
  return { status: "exported", sql, tables, rows: rowCount, statements: statements.length, warnings, definitions: definitionChecks };
}

