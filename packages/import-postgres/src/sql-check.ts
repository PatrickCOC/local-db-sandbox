import { loadParser } from "./parser.ts";
import type { PgNode } from "./parser.ts";

/*
 * What PostgreSQL's own parser says of SQL that was written for it (D-039).
 *
 * A generator of migrations writes names and constants itself, quoted. An
 * expression (a check, a default, the condition of an index) it can only
 * copy: a schema holds expressions as the text their source wrote. A text
 * that is more than one expression would end the place it was written into
 * and make something else of what follows. So what was generated is given to
 * the parser before it is given to anyone:
 *
 * - every statement is one statement to PostgreSQL;
 * - every expression that was copied into one is one expression.
 *
 * Nothing here knows who wrote the SQL: a statement is its text, and the
 * expressions that were copied into it.
 */

export interface SqlToCheck {
  /** One statement. */
  sql: string;
  /** The expressions that were copied into it, as they were written. */
  expressions?: readonly string[];
}

export interface SqlCheck {
  /** What PostgreSQL parses the statement as: the node type, such as `AlterTableStmt`. Not there when it could not be parsed as one statement. */
  kind?: string;
  /** What is wrong with the statement or with an expression in it. */
  problem?: string;
}

interface Parsed {
  statements: PgNode[];
  error?: string;
}

async function parse(sql: string): Promise<Parsed> {
  const parser = await loadParser();
  try {
    const result = await parser.parse(sql);
    return { statements: (result.stmts ?? []).map((entry) => entry.stmt ?? {}) };
  } catch (error) {
    const details = (error as { sqlDetails?: { message?: string } }).sqlDetails;
    return { statements: [], error: details?.message ?? (error instanceof Error ? error.message : String(error)) };
  }
}

/** What of a query makes it more than the one value it selects. */
const CLAUSES = ["distinctClause", "intoClause", "fromClause", "whereClause", "groupClause", "havingClause", "windowClause", "valuesLists", "sortClause", "limitOffset", "limitCount", "lockingClause", "withClause", "larg", "rarg"];

/**
 * Why a text is not one expression, or `undefined` when it is one. It is one
 * when `SELECT (text)` is a query of that one value and nothing else: no
 * second value, no name for it, no clause after it.
 */
async function expressionProblem(text: string): Promise<string | undefined> {
  const { statements, error } = await parse(`SELECT (${text})`);
  if (error !== undefined) {
    return error;
  }
  const [only] = statements;
  const select = only?.SelectStmt as PgNode | undefined;
  if (statements.length !== 1 || select === undefined) {
    return "it ends the place it stands in, and goes on as another statement";
  }
  const targets = (select.targetList ?? []) as PgNode[];
  if (targets.length !== 1 || targets[0]?.ResTarget?.name !== undefined || CLAUSES.some((clause) => select[clause] !== undefined)) {
    return "it ends the place it stands in, and goes on";
  }
  return undefined;
}

/**
 * Checks statements with PostgreSQL's parser, one result for each, in their
 * order. A statement without a `problem` is one statement, and each of its
 * expressions one expression.
 */
export async function checkSqlStatements(statements: readonly SqlToCheck[]): Promise<SqlCheck[]> {
  const checks: SqlCheck[] = [];
  for (const { sql, expressions } of statements) {
    const { statements: parsed, error } = await parse(sql);
    if (error !== undefined) {
      checks.push({ problem: `PostgreSQL cannot parse it: ${error}.` });
      continue;
    }
    if (parsed.length !== 1) {
      checks.push({ problem: parsed.length === 0 ? "It is no statement to PostgreSQL." : `It is ${parsed.length} statements to PostgreSQL, not one.` });
      continue;
    }
    const kind = Object.keys(parsed[0] as PgNode)[0] ?? "Unknown";
    let problem: string | undefined;
    for (const expression of expressions ?? []) {
      const why = await expressionProblem(expression);
      if (why !== undefined) {
        problem = `The expression ${JSON.stringify(expression)} is not one expression to PostgreSQL: ${why}.`;
        break;
      }
    }
    checks.push(problem === undefined ? { kind } : { kind, problem });
  }
  return checks;
}
