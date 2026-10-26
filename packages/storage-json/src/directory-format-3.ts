import { join } from "node:path";
import { MANIFEST, SCHEMA_FILE, isPlainObject } from "./directory-files.ts";
import type { FormatMigration } from "./format-migration.ts";
import { JsonStorageError } from "./storage-error.ts";

/*
 * The migration from directory format 3 to format 4 (D-033, D-036).
 *
 * Format 4 lays a directory out exactly as format 3 does. What changed is what
 * its schema file may say: unique constraints, foreign keys over several
 * columns, indexes, checks, and computed defaults (D-033); and the schema's
 * enumerated types, the primary key as a constraint, canonical types, and
 * provenance (D-036). A format 3 reader refuses a schema with those keys, so
 * a format 4 database states `minimumReaderVersion` 4.
 *
 * A format 3 schema has none of them and is a valid format 4 schema as it is,
 * so the migration writes a manifest and nothing else.
 */

/** The keys a format 3 manifest has. */
const FORMAT_3_KEYS = new Set(["formatVersion", "minimumReaderVersion", "database", "persistence", "config", "generation", "schema", "tables", "retired", "extra"]);

export const directoryFormat3To4: FormatMigration = {
  storage: "directory",
  from: 3,
  to: 4,
  summary:
    "The schema file may also hold constraints and indexes with their names, enumerated types, computed defaults, canonical types, and where each object comes from. Nothing of the database changes; the manifest states the new format.",

  transform({ directory, manifest }) {
    const unexpected = Object.keys(manifest).find((key) => !FORMAT_3_KEYS.has(key));
    if (manifest.formatVersion !== 3 || unexpected !== undefined) {
      throw new JsonStorageError(
        manifest.formatVersion !== 3
          ? `${join(directory, MANIFEST)} is not a format 3 manifest.`
          : `${join(directory, MANIFEST)} has the key "${unexpected}", which a format 3 manifest does not have. It is not migrated, because what the key means is not known.`,
      );
    }
    const schema = typeof manifest.schema === "string" && SCHEMA_FILE.test(manifest.schema) ? manifest.schema : undefined;
    const tableCount = Array.isArray(manifest.tables) ? manifest.tables.length : 0;
    return {
      manifest: { ...manifest, formatVersion: 4, minimumReaderVersion: 4, ...(isPlainObject(manifest.extra) && { extra: manifest.extra }) },
      write: {},
      remove: [],
      changes: [
        `${MANIFEST}: formatVersion 3 -> 4, minimumReaderVersion 4`,
        schema === undefined ? "schema: there is none" : `${schema}: kept as it is (a format 3 schema is a valid format 4 schema)`,
        `tables/: ${tableCount} table ${tableCount === 1 ? "file" : "files"} kept as ${tableCount === 1 ? "it is" : "they are"}`,
      ],
    };
  },
};
