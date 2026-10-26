/*
 * Result of importing entities from an ORM: just enough to create sandbox
 * collections and to tell the user what was and was not understood.
 *
 * This is an import report, not a schema language. The sandbox core does not
 * know about it; only collection names (and optional sample rows) reach the
 * generated database file.
 */

export type FieldType = "string" | "number" | "boolean" | "date" | "json" | "array" | "binary" | "unknown";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ImportedField {
  /** Property name on the entity, which is the key used in sandbox rows. */
  name: string;
  /** Database column name, when it differs from the property name. */
  column?: string;
  type: FieldType;
  /** Type as declared in the source, for example "varchar" or "Number". */
  sourceType?: string;
  /** For a column that the ORM fills (`sourceType` is its decorator): the type the decorator states, when it states one. */
  declaredType?: string;
  /** What the declared type takes beyond its name, as the column declares it: a length, the digits in all, and the digits after the point. */
  length?: number;
  precision?: number;
  scale?: number;
  /** The column is an array of its declared type. */
  array?: boolean;
  /** The name the column gives its enumerated type in the database, when it gives one. */
  enumName?: string;
  /** For an array column whose elements are enumerated: their values. (`enum` is for a column whose own value is one.) */
  elementEnum?: (string | number)[];
  primary: boolean;
  nullable: boolean;
  /** Generation strategy declared in the source, for example "increment" or "uuid". */
  generated?: string;
  /** Present only when the source declares a static value. */
  default?: JsonValue;
  enum?: (string | number)[];
  /** Set when this field holds the key of a row in another collection. */
  references?: { collection: string; field: string; onDelete?: string };
}

export interface ImportedCollection {
  /** Collection name in the sandbox (the table name). */
  name: string;
  /** Name of the entity class it came from. */
  source: string;
  fields: ImportedField[];
}

export interface ImportIssue {
  /**
   * - `unsupported`: a construct was skipped.
   * - `ambiguous`: something was imported, but its meaning could not be fully determined.
   * - `note`: imported, with a behavior difference worth knowing.
   */
  kind: "unsupported" | "ambiguous" | "note";
  entity?: string;
  property?: string;
  message: string;
  /**
   * What of the entities' schema the collections do not have because of
   * this, for whoever reads them as a schema: a `table` (a join table, an
   * entity that was skipped), a `column`, a `key` (the column is there, and
   * what it refers to is not known), a `default` (one that is no value, or
   * the one a database gives a column that TypeORM fills), or the entity's
   * `constraints` (indexes, unique and check constraints). Absent where the
   * collections lack nothing: what is only about how the sandbox treats
   * rows, and a type that is kept as it was declared.
   */
  omits?: "table" | "column" | "key" | "default" | "constraints";
}

export interface ImportResult {
  collections: ImportedCollection[];
  issues: ImportIssue[];
}

export interface DatabaseDocument {
  $meta: { version: 1 };
  data: Record<string, Record<string, JsonValue>[]>;
}

export interface DatabaseDocumentOptions {
  /** Add one fixed placeholder row per collection. Collections are empty by default. */
  sampleRows?: boolean;
}

const SAMPLE_UUID = "00000000-0000-4000-8000-000000000001";
const SAMPLE_DATE = "2000-01-01T00:00:00.000Z";

function placeholder(field: ImportedField): JsonValue {
  if (field.generated === "uuid") {
    return SAMPLE_UUID;
  }
  if (field.generated !== undefined) {
    return 1;
  }
  if (field.primary) {
    return field.type === "number" ? 1 : "1";
  }
  if (field.default !== undefined) {
    return field.default;
  }
  if (field.nullable) {
    return null;
  }
  if (field.enum !== undefined && field.enum.length > 0) {
    return field.enum[0] as string | number;
  }
  switch (field.type) {
    case "string":
      return "sample";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "date":
      return SAMPLE_DATE;
    case "json":
      return {};
    case "array":
      return [];
    case "binary":
      // Base64 text of no bytes.
      return "";
    default:
      return null;
  }
}

function sampleRow(collection: ImportedCollection, all: ImportedCollection[]): Record<string, JsonValue> {
  const row: Record<string, JsonValue> = {};
  for (const field of collection.fields) {
    // Every collection gets exactly one row, so a reference can point at the target's row.
    const target = all
      .find((candidate) => candidate.name === field.references?.collection)
      ?.fields.find((candidate) => candidate.name === field.references?.field);
    // A nullable reference to the same collection stays empty instead of pointing at itself.
    const selfOptional = field.references?.collection === collection.name && field.nullable;
    row[field.name] = target !== undefined && !field.primary && !selfOptional ? placeholder(target) : placeholder(field);
  }
  return row;
}

/** Builds the content of a sandbox database file from an import result. */
export function toDatabaseDocument(result: ImportResult, options: DatabaseDocumentOptions = {}): DatabaseDocument {
  const data: DatabaseDocument["data"] = {};
  for (const collection of result.collections) {
    data[collection.name] = options.sampleRows ? [sampleRow(collection, result.collections)] : [];
  }
  return { $meta: { version: 1 }, data };
}
