import type { DatabaseContents } from "./database-storage.ts";

/*
 * What a migration is: one step from one format of a database to the next.
 *
 * A migration does not write the database. It says what the database
 * consists of in the target format (`transform`), and the migration engine
 * (migrate.ts) does the rest the same way for every step: it holds the save
 * lock, writes the new files next to the old ones, reads the result back and
 * compares it with what was there, and only then publishes it, by replacing
 * manifest.json. So a migration cannot leave a database half changed, and
 * cannot forget to check its result.
 *
 * Only directory databases have migrations. The single file has had one
 * format; the shape of a migration for it is to be defined with its second.
 */

/** A directory database as a migration finds it. */
export interface DirectoryMigrationSource {
  directory: string;
  /** `manifest.json` as it is stored, in the format the migration starts from. */
  manifest: Record<string, unknown>;
}

/** The same database in the target format, as far as it differs. */
export interface DirectoryMigrationOutput {
  /** The manifest in the target format. Putting it in place is the migration. */
  manifest: Record<string, unknown>;
  /**
   * Files to add, by path within the directory, with their text. None may
   * exist yet: a file that is part of a database is never changed, so what a
   * migration changes it writes under a new name and names in the manifest.
   */
  write: Record<string, string>;
  /** Files and folders, by path within the directory, that are part of neither format once the manifest is in place. Removed after it is. */
  remove: string[];
  /** What changes, a line each, for whoever runs the migration. */
  changes: string[];
}

export interface FormatMigration {
  readonly storage: "directory";
  /** The format the migration starts from. */
  readonly from: number;
  /** The format it leads to. */
  readonly to: number;
  /** What the step is, in a sentence. */
  readonly summary: string;
  /**
   * Describes something that the source format requires to be finished before
   * a database in it can be read, such as a save that was committed and not
   * completed; `undefined` when there is nothing. Changes nothing.
   */
  pending?(directory: string): string | undefined;
  /**
   * Finishes what `pending` describes. Only called by a migration, which
   * holds the save lock. Throws when it cannot be finished now.
   */
  recover?(directory: string): void;
  /**
   * Works out the database in the target format. Reads what it needs and
   * changes nothing, so it is also what a dry run runs. Throws when the
   * database is not one the step can migrate.
   */
  transform(source: DirectoryMigrationSource): DirectoryMigrationOutput;
  /**
   * Checks what was read back from the result against what was read from
   * the source, and throws when it is not what the step should give.
   * Default: rows, table definitions, configuration, and the other metadata
   * are the same.
   */
  verify?(before: DatabaseContents, after: DatabaseContents): void;
}
