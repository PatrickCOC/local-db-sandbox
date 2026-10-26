import type { CanonicalType, SchemaTypes, TableSchema } from "../../runtime/src/index.ts";
import type { DatabaseFormat, DatabaseStorageOptions } from "./database-storage.ts";
import { createDatabase, databaseFormatFor, openDatabaseStorage } from "./open-database.ts";
import { mergeSchemas } from "./schema-document.ts";
import { JsonStorageError } from "./storage-error.ts";

export interface ConvertDatabaseOptions extends DatabaseStorageOptions {
  /** Table definitions to store in place of the source's definitions of the same tables. */
  schema?: TableSchema[];
  /**
   * Asked for table definitions when the source stores none and `schema` is
   * not given, for example to read them from ORM entities. Not called
   * otherwise.
   */
  fallbackSchema?: () => TableSchema[] | undefined;
  /** Replace a database that is already at the target path. */
  overwrite?: boolean;
}

export interface ConversionResult {
  from: { path: string; format: DatabaseFormat };
  to: { path: string; format: DatabaseFormat };
  tables: number;
  rows: number;
  /** Tables whose definition is stored in the result. The others are described from their rows when opened. */
  declaredTables: number;
  /** `stored`: the source's own definitions. `given`: from `schema` or `fallbackSchema`. `none`: no table has one. */
  schemaSource: "stored" | "given" | "none";
  /** What the target format has no place for. */
  notes: string[];
}

const enumNamed = (type: CanonicalType): string | undefined => (type.kind === "enum" ? type.name : type.kind === "array" ? enumNamed(type.element) : undefined);

/**
 * Table definitions without what is worked out from an ORM's entities each
 * time they are read (D-040): a canonical type that stands beside what was
 * declared, on a column of which the source's own dialect says nothing, and
 * the enumerated types that only such columns name. A single file has no
 * place for it, and the application that opens the file has the entities.
 *
 * What a source said itself (a column with its type in the source's dialect,
 * a column that carries its type's values, a type that no such column names)
 * is left as it is: that is refused, not dropped.
 */
function withoutDerivedTypes(schema: readonly TableSchema[], types: SchemaTypes | undefined): { schema: TableSchema[]; types: SchemaTypes | undefined; leftOut: boolean } {
  const named = new Set<string>();
  let leftOut = false;
  const tables = schema.map((table) => ({
    ...table,
    columns: table.columns.map((column) => {
      if (column.canonicalType === undefined || column.sourceDialectType !== undefined || column.enum !== undefined || column.origin !== undefined) {
        return column;
      }
      const { canonicalType, ...rest } = column;
      const enumName = enumNamed(canonicalType);
      if (enumName !== undefined) {
        named.add(enumName);
      }
      leftOut = true;
      return rest;
    }),
  }));
  // A type that a column of the schema still carries, or that nothing left out names, stays.
  const carried = new Set(tables.flatMap((table) => table.columns.flatMap((column) => (column.enum === undefined ? [] : [column.enum.name]))));
  const enums = (types?.enums ?? []).filter((type) => !named.has(type.name) || carried.has(type.name));
  return { schema: tables, types: enums.length > 0 ? { enums } : undefined, leftOut };
}

/**
 * Copies a database into the other format: a single file into a directory,
 * or a directory into a single file. Rows, configuration, table definitions,
 * enumerated types, and extra keys are carried over; what the single file has
 * no place for (D-033, D-036) is refused, not dropped, but for what is
 * worked out from an ORM's entities (D-040), which is left out and noted.
 * The source is not changed.
 */
export async function convertDatabase(from: string, to: string, options: ConvertDatabaseOptions = {}): Promise<ConversionResult> {
  const source = openDatabaseStorage(from, options);
  const format = databaseFormatFor(to);
  if (format === source.format) {
    throw new JsonStorageError(
      source.format === "file"
        ? `${from} is a single-file database already; give a directory path to convert it to (a path that does not end in .json).`
        : `${from} is a directory database already; give a .json path to convert it to a single file.`,
    );
  }

  const { collections } = await source.load();
  const { schema: stored, persistence, name: _name, types: storedTypes, ...rest } = source.metadata();
  const given = options.schema ?? (stored === undefined ? options.fallbackSchema?.() : undefined);
  // Given definitions replace the stored ones of the same tables; the others are carried over.
  const merged = given === undefined ? stored : mergeSchemas(stored, given);
  const forFile = format === "file" && merged !== undefined ? withoutDerivedTypes(merged, storedTypes) : undefined;
  const schema = forFile?.schema ?? merged;
  const types = forFile === undefined ? storedTypes : forFile.types;
  const metadata = { ...rest, ...(types !== undefined && { types }) };
  const declared = schema !== undefined && schema.length > 0;

  const notes: string[] = [];
  if (forFile?.leftOut === true) {
    notes.push("What the columns are in the database of their entities (canonical types, and the enumerated types they name) is not stored in a single file: it is worked out from the entities.");
  }
  if (format === "file" && persistence === "memory") {
    notes.push('The directory\'s "persistence": "memory" is not stored in a single file.');
  }
  await createDatabase(
    to,
    { collections, ...metadata, ...(declared && { schema }), ...(format === "directory" && persistence !== undefined && { persistence }) },
    { format, overwrite: options.overwrite, maxFileSizeMb: options.maxFileSizeMb, onSizeWarning: options.onSizeWarning },
  );

  return {
    from: { path: from, format: source.format },
    to: { path: to, format },
    tables: Object.keys(collections).length,
    rows: Object.values(collections).reduce((total, rows) => total + rows.length, 0),
    declaredTables: declared ? schema.length : 0,
    schemaSource: !declared ? "none" : given !== undefined ? "given" : "stored",
    notes,
  };
}
