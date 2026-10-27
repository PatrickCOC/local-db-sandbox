import { createHash } from "node:crypto";
import { collectMigrationFiles } from "./collector.ts";
import type { CollectedSchema } from "./collector.ts";
import type { MigrationFile } from "./migrations.ts";
import { describeTarget, withReadOnlyCatalog } from "./pg-client.ts";
import type { CatalogQuery, CatalogRow, PostgresConnectionOptions, PostgresTarget } from "./pg-client.ts";
import type { ReportCategory, ReportOutcome } from "./report.ts";

/*
 * The schema of a running PostgreSQL database, read from its system catalog
 * (D-049). No row of a table is read, and nothing is written: the scan runs
 * catalog queries in a read-only transaction (pg-client.ts).
 *
 * The catalog is read with `pg_catalog` and PostgreSQL's own functions that
 * write an object as SQL (`format_type`, `pg_get_expr`,
 * `pg_get_constraintdef`, `pg_get_indexdef`), not with `information_schema`:
 * the views of `information_schema` show only what the user has privileges
 * on (a constraint only to the owner of its table), so a read-only role
 * would see less than there is, and nothing would say so. `pg_catalog` is
 * readable by every role unless it was restricted, and then the scan fails
 * and says so.
 *
 * What was read is written as the statements that would create it, and
 * those go through the migration collector, as a project's migrations do.
 * So there is one way from PostgreSQL to the canonical schema: the same
 * types, defaults, keys, constraints, and indexes, and the same report of
 * what is kept as information, not reproduced, or unsupported.
 *
 * The sandbox has one namespace. Tables of the schemas that are read keep
 * their names without the schema; when two of those schemas have an object of
 * the same name, the scan is refused and the names are listed. What refers
 * to something outside those schemas (a foreign key, a type) is said, not
 * followed.
 */

/** Where the statements of a scan come from, as provenance names it (`SourcePosition.source`). */
export const CATALOG_SOURCE = "postgresql-catalog";

/** The name the statements of a scan have in the report and in provenance. */
export const SCAN_FILE = "schema-scan.sql";

/** The oldest server whose catalog has every column the scan reads (`attgenerated`: PostgreSQL 12). */
export const MINIMUM_SERVER_VERSION = 120000;

export type PostgresScanErrorCode = "invalid-schema" | "schema-not-found" | "no-usage" | "name-conflict" | "server-version" | "no-tables";

/** A scan that cannot give a schema: what was asked for is not there, or would not be one namespace. */
export class PostgresScanError extends Error {
  readonly code: PostgresScanErrorCode;

  constructor(code: PostgresScanErrorCode, message: string) {
    super(message);
    this.name = "PostgresScanError";
    this.code = code;
  }
}

/** Something the scan saw and did not hand to the collector, and why. */
export interface ScanNote {
  outcome: Extract<ReportOutcome, "not-reproduced" | "unsupported">;
  category: ReportCategory;
  /** What it concerns, as `schema.name`. */
  object: string;
  message: string;
}

export interface ScanOptions {
  connection: PostgresConnectionOptions;
  /** The schemas to read (default: `public`). */
  schemas?: string[];
}

export interface ScannedSchema {
  target: PostgresTarget;
  /** `server_version` of the server. */
  serverVersion: string;
  schemas: string[];
  /** The catalog written as statements: what the collector read. Schema only. */
  script: string;
  collected: CollectedSchema;
  notes: ScanNote[];
}

/** A schema name that is PostgreSQL's own. */
export function isSystemSchema(name: string): boolean {
  return name === "information_schema" || /^pg_/i.test(name);
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;
const text = (row: CatalogRow, key: string): string => String(row[key] ?? "");
const optional = (row: CatalogRow, key: string): string | undefined => (row[key] === null || row[key] === undefined ? undefined : String(row[key]));
const flag = (row: CatalogRow, key: string): boolean => row[key] === true || row[key] === "t";

/** The kinds of relation the scan looks at, by `relkind`. */
const RELATION_KINDS: Record<string, string> = { r: "table", p: "partitioned table", v: "view", m: "materialized view", f: "foreign table" };

interface Relation {
  oid: string;
  schema: string;
  name: string;
  kind: string;
  partition: boolean;
  rowSecurity: boolean;
  extension: string | undefined;
  inherits: boolean;
}

/** Reads what the catalog says of the schemas, in the read-only transaction. */
async function readCatalog(query: CatalogQuery, schemas: string[]): Promise<Omit<ScannedSchema, "target" | "collected">> {
  const [server] = await query("SELECT current_setting('server_version_num')::int AS number, current_setting('server_version') AS version");
  const versionNumber = Number(server?.number ?? 0);
  const serverVersion = text(server ?? {}, "version");
  if (versionNumber < MINIMUM_SERVER_VERSION) {
    throw new PostgresScanError("server-version", `The server is PostgreSQL ${serverVersion}; the scan reads the catalog of PostgreSQL 12 or later.`);
  }
  const wanted = JSON.stringify(schemas);

  const found = await query(
    `SELECT s.name, n.oid IS NOT NULL AS found
       FROM json_array_elements_text($1::text::json) WITH ORDINALITY AS s(name, position)
       LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = s.name
      ORDER BY s.position`,
    [wanted],
  );
  const missing = found.filter((row) => !flag(row, "found")).map((row) => text(row, "name"));
  if (missing.length > 0) {
    throw new PostgresScanError("schema-not-found", `The database has no schema ${missing.map((name) => `"${name}"`).join(", ")}.`);
  }

  // A schema the role may not use is left out of the search path by PostgreSQL, which then writes every name of it with
  // the schema: its tables would be taken for those of another schema. USAGE gives no access to rows.
  const unusable = await query(
    `SELECT s.name, current_user AS role FROM json_array_elements_text($1::text::json) AS s(name) WHERE NOT has_schema_privilege(s.name, 'USAGE')`,
    [wanted],
  );
  if (unusable.length > 0) {
    const role = text(unusable[0] as CatalogRow, "role");
    const names = unusable.map((row) => text(row, "name"));
    throw new PostgresScanError(
      "no-usage",
      `The user "${role}" may not use the schema${names.length === 1 ? "" : "s"} ${names.map((name) => `"${name}"`).join(", ")} (it has no USAGE privilege), so PostgreSQL does not write the names of ${names.length === 1 ? "it" : "them"} as the scan reads them. USAGE gives no access to any row: GRANT USAGE ON SCHEMA ${names.map(quote).join(", ")} TO ${quote(role)};`,
    );
  }

  // Names in the statements, and in what PostgreSQL writes for us below, are then those of the schemas that are read, without the schema.
  await query("SELECT set_config('search_path', $1, true)", [schemas.map(quote).join(", ")]);

  const relations: Relation[] = (
    await query(
      `SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, c.relispartition AS partition,
              c.relrowsecurity AS row_security, EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid) AS inherits,
              (SELECT e.extname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
                WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_catalog.pg_extension'::regclass AND d.deptype = 'e'
                LIMIT 1) AS extension
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN (SELECT json_array_elements_text($1::text::json)) AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ORDER BY n.nspname, c.relname`,
      [wanted],
    )
  ).map((row) => ({
    oid: text(row, "oid"),
    schema: text(row, "schema"),
    name: text(row, "name"),
    kind: text(row, "kind"),
    partition: flag(row, "partition"),
    rowSecurity: flag(row, "row_security"),
    extension: optional(row, "extension"),
    inherits: flag(row, "inherits"),
  }));

  const notes: ScanNote[] = [];
  const note = (outcome: ScanNote["outcome"], category: ReportCategory, object: string, message: string): void => {
    notes.push({ outcome, category, object, message });
  };
  const qualified = (relation: { schema: string; name: string }): string => `${relation.schema}.${relation.name}`;
  const tables: Relation[] = [];
  for (const relation of relations) {
    const kind = RELATION_KINDS[relation.kind] ?? relation.kind;
    if (relation.extension !== undefined) {
      note("not-reproduced", "extensions", qualified(relation), `The ${kind} ${qualified(relation)} belongs to the extension "${relation.extension}" and is left out.`);
    } else if (relation.kind === "v" || relation.kind === "m") {
      note("not-reproduced", "views", qualified(relation), `The ${kind} ${qualified(relation)} is not created locally.`);
    } else if (relation.kind === "f") {
      note("not-reproduced", "other", qualified(relation), `The foreign table ${qualified(relation)} is not created locally: its rows are on another server.`);
    } else if (relation.partition) {
      note("not-reproduced", "table", qualified(relation), `${qualified(relation)} is a partition; its partitioned table is created locally as one ordinary table, and the partition is not.`);
    } else {
      tables.push(relation);
    }
  }
  if (tables.length === 0) {
    const left = notes.length === 0 ? "" : ` (left out: ${notes.map((entry) => entry.object).join(", ")})`;
    throw new PostgresScanError("no-tables", `The schema${schemas.length === 1 ? "" : "s"} ${schemas.map((name) => `"${name}"`).join(", ")} ${schemas.length === 1 ? "has" : "have"} no tables to create${left}.`);
  }
  const tableOids = JSON.stringify(tables.map((table) => table.oid));
  const byOid = new Map(tables.map((table) => [table.oid, table]));

  const columns = await query(
    `SELECT a.attrelid::text AS relation, a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, a.attidentity::text AS identity, a.attgenerated::text AS generated,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS expression,
            COALESCE(en.nspname, tn.nspname) AS type_schema,
            CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
                 THEN (SELECT pg_catalog.quote_ident(cn.nspname) || '.' || pg_catalog.quote_ident(co.collname)
                         FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace WHERE co.oid = a.attcollation) END AS collation
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
       JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
       LEFT JOIN pg_catalog.pg_type et ON et.oid = t.typelem AND t.typcategory = 'A'
       LEFT JOIN pg_catalog.pg_namespace en ON en.oid = et.typnamespace
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid IN (SELECT json_array_elements_text($1::text::json)::oid) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum`,
    [tableOids],
  );

  const enums = await query(
    `SELECT n.nspname AS schema, t.typname AS name, e.enumlabel AS label
       FROM pg_catalog.pg_type t
       JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
       JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
      WHERE n.nspname IN (SELECT json_array_elements_text($1::text::json))
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
      ORDER BY n.nspname, t.typname, e.enumsortorder`,
    [wanted],
  );

  const constraints = await query(
    `SELECT co.conrelid::text AS relation, co.conname AS name, co.contype::text AS kind, pg_catalog.pg_get_constraintdef(co.oid) AS definition,
            co.confrelid::text AS referenced, rn.nspname AS referenced_schema, rc.relname AS referenced_name
       FROM pg_catalog.pg_constraint co
       LEFT JOIN pg_catalog.pg_class rc ON rc.oid = co.confrelid
       LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
      WHERE co.conrelid IN (SELECT json_array_elements_text($1::text::json)::oid) AND co.contype IN ('p', 'u', 'f', 'c', 'x', 't')
      ORDER BY co.conrelid, co.conname`,
    [tableOids],
  );

  const indexes = await query(
    `SELECT i.indrelid::text AS relation, ic.relname AS name, pg_catalog.pg_get_indexdef(i.indexrelid) AS definition, i.indisunique AS is_unique,
            i.indisvalid AS is_valid, pg_catalog.quote_ident(ic.relname) AS quoted_name,
            pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname) AS quoted_table
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE i.indrelid IN (SELECT json_array_elements_text($1::text::json)::oid)
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint co WHERE co.conindid = i.indexrelid AND co.conrelid = i.indrelid AND co.contype IN ('p', 'u', 'x'))
      ORDER BY c.relname, ic.relname`,
    [tableOids],
  );

  const triggers = await query(
    `SELECT tg.tgrelid::text AS relation, count(*)::int AS count
       FROM pg_catalog.pg_trigger tg
      WHERE tg.tgrelid IN (SELECT json_array_elements_text($1::text::json)::oid) AND NOT tg.tgisinternal
      GROUP BY tg.tgrelid`,
    [tableOids],
  );

  refuseConflicts(tables, indexes, enums, byOid);

  // --- the catalog as statements ----------------------------------------------
  const statements: string[] = [];
  const enumNames = new Map<string, string[]>();
  for (const row of enums) {
    const name = text(row, "name");
    enumNames.set(name, [...(enumNames.get(name) ?? []), text(row, "label")]);
  }
  for (const [name, labels] of enumNames) {
    statements.push(`CREATE TYPE ${quote(name)} AS ENUM (${labels.map(literal).join(", ")})`);
  }

  const scanned = new Set(schemas);
  for (const table of tables) {
    const definitions = columns
      .filter((row) => text(row, "relation") === table.oid)
      .map((row) => {
        const typeSchema = text(row, "type_schema");
        let type = text(row, "type");
        if (!scanned.has(typeSchema) && typeSchema !== "pg_catalog") {
          // A type of a schema that is not read. It is named as one name that no type of the sandbox has, so that it is
          // kept as PostgreSQL's own type and said to be unknown, and is never taken for a type of the same name that is read.
          const arrays = /(\[\])+$/.exec(type)?.[0] ?? "";
          note(
            "not-reproduced",
            "other-schemas",
            `${qualified(table)}.${text(row, "name")}`,
            `The column ${qualified(table)}.${text(row, "name")} has the type ${type}, of the schema "${typeSchema}", which is not read; it is kept as PostgreSQL's own type, and its values are not checked.`,
          );
          type = `${quote(type.slice(0, type.length - arrays.length))}${arrays}`;
        }
        const collation = optional(row, "collation");
        const expression = optional(row, "expression");
        const identity = text(row, "identity");
        const generated = text(row, "generated");
        return [
          `${quote(text(row, "name"))} ${type}`,
          collation !== undefined ? ` COLLATE ${collation}` : "",
          identity === "a" ? " GENERATED ALWAYS AS IDENTITY" : identity === "d" ? " GENERATED BY DEFAULT AS IDENTITY" : "",
          generated === "s" && expression !== undefined ? ` GENERATED ALWAYS AS (${expression}) STORED` : "",
          generated === "v" && expression !== undefined ? ` GENERATED ALWAYS AS (${expression}) VIRTUAL` : "",
          generated === "" && expression !== undefined ? ` DEFAULT ${expression}` : "",
          flag(row, "not_null") ? " NOT NULL" : "",
        ].join("");
      });
    statements.push(`CREATE TABLE ${quote(table.name)} (\n  ${definitions.join(",\n  ")}\n)`);
    if (table.inherits) {
      note("not-reproduced", "table", qualified(table), `${qualified(table)} inherits from another table; it is created locally with all its columns, and without the inheritance.`);
    }
    if (table.rowSecurity) {
      note("not-reproduced", "row-level-security", qualified(table), `${qualified(table)} has row level security enabled; it is not reproduced locally, and every row can be read and written.`);
    }
  }

  // Keys first, as a foreign key needs the key it refers to; then checks and exclusions; then foreign keys.
  const order = ["p", "u", "c", "x", "f"];
  const kept = constraints.filter((row) => byOid.has(text(row, "relation")));
  for (const kind of order) {
    for (const row of kept.filter((candidate) => text(candidate, "kind") === kind)) {
      const table = byOid.get(text(row, "relation")) as Relation;
      if (kind === "f" && !byOid.has(text(row, "referenced"))) {
        const target = `${text(row, "referenced_schema")}.${text(row, "referenced_name")}`;
        note(
          "not-reproduced",
          "constraint",
          `${qualified(table)}.${text(row, "name")}`,
          `The foreign key "${text(row, "name")}" of ${qualified(table)} refers to ${target}, which is not read (${scanned.has(text(row, "referenced_schema")) ? "it is not an ordinary table" : "its schema is not one of those read"}); it is not reproduced, and the column takes any value.`,
        );
        continue;
      }
      statements.push(`ALTER TABLE ${quote(table.name)} ADD CONSTRAINT ${quote(text(row, "name"))} ${text(row, "definition")}`);
    }
  }
  for (const row of constraints.filter((candidate) => text(candidate, "kind") === "t")) {
    const table = byOid.get(text(row, "relation")) as Relation;
    note("not-reproduced", "triggers", `${qualified(table)}.${text(row, "name")}`, `The constraint trigger "${text(row, "name")}" of ${qualified(table)} is not reproduced locally.`);
  }

  for (const row of indexes) {
    const table = byOid.get(text(row, "relation")) as Relation;
    const object = `${table.schema}.${text(row, "name")}`;
    if (!flag(row, "is_valid")) {
      note("not-reproduced", "index", object, `The index ${object} is not valid in PostgreSQL (a build that did not finish) and is left out.`);
      continue;
    }
    // PostgreSQL writes the table with its schema whatever the search path: put the table's name in the sandbox in its place.
    const definition = text(row, "definition");
    const head = `CREATE ${flag(row, "is_unique") ? "UNIQUE " : ""}INDEX ${text(row, "quoted_name")} ON `;
    const rest = [`ONLY ${text(row, "quoted_table")} `, `${text(row, "quoted_table")} `].find((prefix) => definition.startsWith(head + prefix));
    if (rest === undefined) {
      note("unsupported", "index", object, `The index ${object} could not be read: PostgreSQL wrote it as ${definition}.`);
      continue;
    }
    statements.push(`${head}${quote(table.name)} ${definition.slice(head.length + rest.length)}`);
  }

  for (const row of triggers) {
    const table = byOid.get(text(row, "relation")) as Relation;
    const count = Number(row.count);
    note("not-reproduced", "triggers", qualified(table), `${qualified(table)} has ${count} trigger${count === 1 ? "" : "s"}, which ${count === 1 ? "is" : "are"} not reproduced locally.`);
  }

  return { serverVersion, schemas, script: statements.map((statement) => `${statement};\n`).join("\n"), notes };
}

/** Refuses to put two objects of the same name, from two schemas, into the one namespace of the sandbox. */
function refuseConflicts(tables: Relation[], indexes: CatalogRow[], enums: CatalogRow[], byOid: Map<string, Relation>): void {
  type Owner = { schema: string; what: string };
  const add = (map: Map<string, Owner[]>, name: string, schema: string, kind: string): void => {
    const list = map.get(name) ?? [];
    list.push({ schema, what: `${kind} ${schema}.${name}` });
    map.set(name, list);
  };
  // Tables and indexes share one namespace of relations; a table also has a type of its own name, which an enumerated type may not share.
  const relations = new Map<string, Owner[]>();
  const types = new Map<string, Owner[]>();
  for (const table of tables) {
    add(relations, table.name, table.schema, "table");
    add(types, table.name, table.schema, "table");
  }
  for (const row of indexes) {
    add(relations, text(row, "name"), (byOid.get(text(row, "relation")) as Relation).schema, "index");
  }
  for (const row of enums.filter((row, index) => index === 0 || text(enums[index - 1] as CatalogRow, "name") !== text(row, "name") || text(enums[index - 1] as CatalogRow, "schema") !== text(row, "schema"))) {
    add(types, text(row, "name"), text(row, "schema"), "type");
  }
  const conflicts = [...relations.entries(), ...types.entries()]
    .filter(([, owners]) => new Set(owners.map((owner) => owner.schema)).size > 1)
    .map(([name, owners]) => `"${name}": ${owners.map((owner) => owner.what).join(", ")}`);
  const unique = [...new Set(conflicts)];
  if (unique.length > 0) {
    throw new PostgresScanError(
      "name-conflict",
      `The schemas that are read have objects of the same name, and the sandbox has one namespace, so one would replace the other:\n  ${unique.join("\n  ")}\nRead the schemas one at a time (one --schema each), into databases of their own.`,
    );
  }
}

/**
 * Reads the schema of a running PostgreSQL database and gives it as the
 * collector gives a project's migrations: tables, types, and a report.
 */
export async function scanPostgresDatabase(options: ScanOptions): Promise<ScannedSchema> {
  const schemas = [...new Set(options.schemas === undefined || options.schemas.length === 0 ? ["public"] : options.schemas)];
  for (const schema of schemas) {
    if (schema === "" || isSystemSchema(schema)) {
      throw new PostgresScanError("invalid-schema", `"${schema}" is ${schema === "" ? "not a schema name" : "a system schema of PostgreSQL"}; the scan reads the schemas of an application.`);
    }
  }
  let target: PostgresTarget | undefined;
  const read = await withReadOnlyCatalog(options.connection, (query, connected) => {
    target = connected;
    return readCatalog(query, schemas);
  });
  const bytes = new TextEncoder().encode(read.script);
  const file: MigrationFile = { file: SCAN_FILE, path: SCAN_FILE, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  const collected = await collectMigrationFiles(`${describeTarget(target as PostgresTarget)}, schema ${schemas.join(", ")}`, [file], { source: CATALOG_SOURCE });
  return { target: target as PostgresTarget, ...read, collected };
}
