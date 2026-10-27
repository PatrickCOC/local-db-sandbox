import { checkSqlStatements } from "../../import-postgres/src/sql-check.ts";
import { exportPostgresSql } from "../../migration/src/postgres/index.ts";
import type { SnapshotResult } from "../../runtime-access/src/index.ts";
import type { StudioExportMode, StudioExportOutcome } from "../../studio/src/index.ts";

/*
 * The SQL export of Local DB Studio's Export tab (D-050), as the CLI
 * composes it: Studio reads the tables (a snapshot of the runtime's access),
 * the migration package writes them as PostgreSQL, and what is written of the
 * definitions is given to PostgreSQL's own parser before it is given to
 * anyone, as a generated migration is (D-039). Studio itself knows no SQL
 * dialect.
 */

/** Writes a snapshot of tables as a script for PostgreSQL, or says every reason it cannot. */
export async function exportSqlForStudio(snapshot: SnapshotResult, request: { tables: string[]; mode: StudioExportMode }): Promise<StudioExportOutcome> {
  const exported = exportPostgresSql({ schema: snapshot.schema, ...(snapshot.rows !== undefined && { rows: snapshot.rows }), mode: request.mode });
  if (exported.status === "refused") {
    return exported;
  }
  // Every statement of definitions is one statement, and every expression copied from the schema one expression. The rows
  // are constants that the generator's own functions wrote, and are not parsed again.
  const checks = await checkSqlStatements(exported.definitions);
  const wrong = checks.findIndex((check) => check.problem !== undefined);
  if (wrong >= 0) {
    return { status: "refused", refusals: [{ message: `A statement of the definitions is not what PostgreSQL would read: ${checks[wrong]?.problem} (${exported.definitions[wrong]?.sql.slice(0, 200)})` }] };
  }
  return { status: "exported", sql: exported.sql, tables: exported.tables, rows: exported.rows, statements: exported.statements, warnings: exported.warnings };
}
