import { createHash } from "node:crypto";

/*
 * File names for the tables of a directory database.
 *
 * A table name can be any string, and not every string is a usable file name
 * everywhere. The name a table's file gets is worked out here and then
 * recorded in the database's manifest, which is what readers go by: nothing
 * ever has to decode a file name back into a table name.
 */

const MAX_BASE_LENGTH = 100;
/** Reserved on Windows whatever the extension, and compared without regard to case. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/**
 * What a table's file may be called: a plain name of unreserved characters,
 * ending in `.json`. A file written for a later generation of the database
 * has that generation before the ending: `users.g7.json`.
 */
const SAFE_FILE = /^([A-Za-z0-9_%~-]+)(?:\.g\d+)?\.json$/;

function encoded(text: string): string {
  return [...Buffer.from(text, "utf8")].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

/**
 * The file name, without `.json`, for a table name. Letters, digits, `_`,
 * and `-` are kept; every other character is written as the `%XX` bytes of
 * its UTF-8 form, so path separators, dots, spaces, and `%` itself cannot
 * appear. Names that are reserved or awkward on some platform are changed,
 * and a very long name is cut and given a hash of the whole name.
 *
 * The same table name always gives the same result.
 */
export function tableFileBase(tableName: string): string {
  if (tableName === "") {
    // `~` is never produced for a character, so this cannot be another table's name.
    return "~empty";
  }
  let base = "";
  for (const character of tableName) {
    base += /^[A-Za-z0-9_-]$/.test(character) ? character : encoded(character);
  }
  if (RESERVED_NAME.test(base) || base.startsWith("-")) {
    base = `${encoded(base[0] as string)}${base.slice(1)}`;
  }
  if (base.length > MAX_BASE_LENGTH) {
    const hash = createHash("sha1").update(tableName).digest("hex").slice(0, 8);
    base = `${base.slice(0, MAX_BASE_LENGTH - 9)}~${hash}`;
  }
  return base;
}

/** Whether `file` is a plain, portable file name that a manifest may use for a table. */
export function isSafeTableFile(file: string): boolean {
  const base = SAFE_FILE.exec(file)?.[1];
  return base !== undefined && !RESERVED_NAME.test(base) && !base.startsWith("-");
}

/** A table file's name without its generation and its ending: `users` for `users.json` and for `users.g7.json`. */
export function tableFileStem(file: string): string {
  return SAFE_FILE.exec(file)?.[1] ?? file.replace(/\.json$/i, "");
}

/**
 * Chooses a file for every table, in the order given. A table that already
 * has a file keeps it. Two tables never share a file, also when their names
 * differ only in case, since some file systems ignore case: a later table
 * then gets `~2`, `~3`, ... added.
 */
export function assignTableFiles(tableNames: string[], existing: ReadonlyMap<string, string>): Map<string, string> {
  const files = new Map<string, string>();
  const taken = new Set<string>();
  for (const name of tableNames) {
    const file = existing.get(name);
    if (file !== undefined) {
      files.set(name, file);
      taken.add(file.toLowerCase());
    }
  }
  const ordered = new Map<string, string>();
  for (const name of tableNames) {
    let file = files.get(name);
    if (file === undefined) {
      const base = tableFileBase(name);
      file = `${base}.json`;
      for (let attempt = 2; taken.has(file.toLowerCase()); attempt += 1) {
        file = `${base}~${attempt}.json`;
      }
      taken.add(file.toLowerCase());
    }
    ordered.set(name, file);
  }
  return ordered;
}
