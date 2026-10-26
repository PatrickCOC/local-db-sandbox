import type { DatabaseFormat } from "./database-storage.ts";
import { directoryFormat2To3 } from "./directory-format-2.ts";
import { directoryFormat3To4 } from "./directory-format-3.ts";
import { directoryFormat4To5 } from "./directory-format-4.ts";
import type { FormatMigration } from "./format-migration.ts";
import { assessFormat } from "./format-version.ts";
import type { FormatStamp, FormatStatus } from "./format-version.ts";

/**
 * Every migration this build has, in any order. The formats it reads and
 * migrates are the ones from which these lead to the current format.
 *
 *   directory   2 -> 3 -> 4 -> 5
 *   file        (none: format 1 is the only one)
 *
 * A new format is added by raising `CURRENT_FORMAT_VERSION`, describing it in
 * `FORMAT_HISTORY`, and adding the migration from the format before it here.
 */
export const FORMAT_MIGRATIONS: readonly FormatMigration[] = [directoryFormat2To3, directoryFormat3To4, directoryFormat4To5];

/** What this build may do with a database that states this format. */
export function formatStatusOf(storage: DatabaseFormat, stamp: FormatStamp): FormatStatus {
  return assessFormat(storage, stamp, FORMAT_MIGRATIONS);
}
