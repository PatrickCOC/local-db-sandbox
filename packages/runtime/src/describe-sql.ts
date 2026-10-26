import type { SqlOperation, TransactionBoundary } from "./runtime.ts";

export interface SqlDescription {
  operation: SqlOperation;
  transaction?: TransactionBoundary;
  tables?: string[];
}

const TABLE_REFERENCE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_]\w*))/gi;

/** The first word of a statement, in upper case, after any leading space and comments. */
export function leadingKeyword(sql: string): string {
  return /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? "";
}

function operationOf(keyword: string, sql: string): Pick<SqlDescription, "operation" | "transaction"> {
  switch (keyword) {
    case "SELECT":
    case "UPDATE":
    case "DELETE":
      return { operation: keyword };
    case "INSERT":
    case "REPLACE":
      return { operation: "INSERT" };
    case "BEGIN":
    case "SAVEPOINT":
    case "RELEASE":
      return { operation: "TRANSACTION", transaction: keyword };
    case "COMMIT":
    case "END":
      return { operation: "TRANSACTION", transaction: "COMMIT" };
    case "ROLLBACK":
      return { operation: "TRANSACTION", transaction: /\bROLLBACK\s+(TRANSACTION\s+)?TO\b/i.test(sql) ? "ROLLBACK TO SAVEPOINT" : "ROLLBACK" };
    default:
      return { operation: "OTHER" };
  }
}

/**
 * What a statement is, as far as that can be told without parsing it: its
 * kind from the first keyword, and the tables that follow FROM, JOIN, INTO,
 * or UPDATE. A name is reported only when it is one of `knownTables`, so a
 * guess can never invent a table; when nothing matches, `tables` is absent.
 */
export function describeSql(sql: string, knownTables: readonly string[]): SqlDescription {
  const description: SqlDescription = operationOf(leadingKeyword(sql), sql);
  if (description.operation === "TRANSACTION" || description.operation === "OTHER") {
    return description;
  }
  const known = new Map(knownTables.map((name) => [name.toLowerCase(), name]));
  const tables: string[] = [];
  // Text inside string literals is data, not table names.
  for (const match of sql.replace(/'(?:[^']|'')*'/g, "''").matchAll(TABLE_REFERENCE)) {
    const table = known.get((match[1]?.replaceAll('""', '"') ?? match[2] ?? match[3] ?? match[4] ?? "").toLowerCase());
    if (table !== undefined && !tables.includes(table)) {
      tables.push(table);
    }
  }
  if (tables.length > 0) {
    description.tables = tables;
  }
  return description;
}
