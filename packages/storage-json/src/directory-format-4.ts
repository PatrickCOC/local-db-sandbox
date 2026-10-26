import { existsSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST, SCHEMA, SCHEMA_FILE, documentText, isPlainObject, parseJson, readText, versionedFile } from "./directory-files.ts";
import type { FormatMigration } from "./format-migration.ts";
import { readSchemaDocument, toSchemaDocument } from "./schema-document.ts";
import { JsonStorageError } from "./storage-error.ts";

/*
 * The migration from directory format 4 to format 5 (D-040).
 *
 * Format 5 lays a directory out exactly as format 4 does. What changed is
 * what its schema file says, and what it means when it does not say it: the
 * schema document has a version 2, which holds how an index is built and
 * what its keys are, whether a key or a foreign key is deferrable, the
 * clauses of a source that the schema has no place for, and what the text of
 * an expression names. In a version 2 document an index without a method is
 * a B-tree, and an expression says what its text names, with what each of
 * those things is called now. A format 4 reader does not read a version 2
 * document, so a format 5 database states `minimumReaderVersion` 5.
 *
 * The schema file of a format 4 database is a version 1 document, which
 * could say none of that. It is read by the rule for such documents
 * (schema-document.ts): where it records a rename, the expressions that the
 * rename may have reached are marked as possibly stale. What that gives
 * is written as a version 2 document, under a new name, as a save writes a
 * schema that changed; the table files stay as they are.
 */

/** The keys a format 4 manifest has. */
const FORMAT_4_KEYS = new Set(["formatVersion", "minimumReaderVersion", "database", "persistence", "config", "generation", "schema", "tables", "retired", "extra"]);

export const directoryFormat4To5: FormatMigration = {
  storage: "directory",
  from: 4,
  to: 5,
  summary:
    "The schema file may also hold how an index is built and what its keys are, whether a constraint is deferrable, clauses of the source that the schema has no place for, and what the text of an expression names. The schema file is written again in that form; the tables stay as they are.",

  transform({ directory, manifest }) {
    const unexpected = Object.keys(manifest).find((key) => !FORMAT_4_KEYS.has(key));
    if (manifest.formatVersion !== 4 || unexpected !== undefined) {
      throw new JsonStorageError(
        manifest.formatVersion !== 4
          ? `${join(directory, MANIFEST)} is not a format 4 manifest.`
          : `${join(directory, MANIFEST)} has the key "${unexpected}", which a format 4 manifest does not have. It is not migrated, because what the key means is not known.`,
      );
    }
    const tableCount = Array.isArray(manifest.tables) ? manifest.tables.length : 0;
    const tables = `tables/: ${tableCount} table ${tableCount === 1 ? "file" : "files"} kept as ${tableCount === 1 ? "it is" : "they are"}`;
    const stamped = { ...manifest, formatVersion: 5, minimumReaderVersion: 5, ...(isPlainObject(manifest.extra) && { extra: manifest.extra }) };
    const schemaName = typeof manifest.schema === "string" && SCHEMA_FILE.test(manifest.schema) ? manifest.schema : existsSync(join(directory, SCHEMA)) ? SCHEMA : undefined;
    if (schemaName === undefined) {
      return { manifest: stamped, write: {}, remove: [], changes: [`${MANIFEST}: formatVersion 4 -> 5, minimumReaderVersion 5`, "schema: there is none", tables] };
    }

    const shownAs = join(directory, schemaName);
    const schema = readSchemaDocument(parseJson(readText(shownAs, shownAs).text, shownAs), shownAs);
    const marked =
      schema.tables.reduce((count, table) => count + (table.checks ?? []).filter((check) => check.mayBeStale === true).length + (table.indexes ?? []).filter((index) => index.mayBeStale === true).length, 0) +
      schema.tables.reduce((count, table) => count + table.columns.filter((column) => column.defaultMayBeStale === true).length, 0);
    // A file that is part of a database is never changed: what changes is written under the name of a new generation.
    const generation = (typeof manifest.generation === "number" ? manifest.generation : 0) + 1;
    const written = versionedFile("schema", generation);
    return {
      manifest: { ...stamped, generation, schema: written },
      write: { [written]: documentText(toSchemaDocument(schema.tables, schema.types)) },
      remove: [schemaName],
      changes: [
        `${MANIFEST}: formatVersion 4 -> 5, minimumReaderVersion 5, generation ${generation}, schema "${written}"`,
        `${schemaName} -> ${written}: written again as a schema document of version 2${
          marked === 0 ? "" : `; ${marked} ${marked === 1 ? "expression is" : "expressions are"} marked as possibly stale, since a rename is recorded that may have reached ${marked === 1 ? "it" : "them"} and format 4 did not record what a text names`
        }`,
        tables,
      ],
    };
  },
};
