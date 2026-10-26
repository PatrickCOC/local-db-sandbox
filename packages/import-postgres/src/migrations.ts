import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/*
 * Finding a project's PostgreSQL migrations and putting them in the order
 * they are applied in.
 *
 * Migration tools name their files after a version: `0001_init.sql`,
 * `20240101120000_add_users.sql` (Supabase), `V2__add_users.sql` (Flyway),
 * `003-orders.sql`. Files are applied in the order of that version, compared
 * as a number, so that `V10` comes after `V9`. When the files of a directory
 * do not all start with a version, they are applied in the order of their
 * names, as tools without versions do.
 */

export class MigrationSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationSourceError";
  }
}

export interface MigrationFile {
  /** Name relative to the migrations directory, with `/` separators. */
  file: string;
  path: string;
  /** The file's bytes; statement locations are byte offsets into them. */
  bytes: Uint8Array;
  /** SHA-256 of the bytes, so that a later step can tell whether the migration changed. */
  sha256: string;
}

/** Where a project keeps its migrations, by convention, relative to the project. */
export const MIGRATION_DIRECTORIES = ["supabase/migrations", "migrations", "db/migrations", "database/migrations", "sql/migrations"];

/** `V12__name.sql`, `0012_name.sql`, `20240101120000-name.sql`: the version is the leading number. */
const VERSIONED = /^[Vv]?(\d+)(?=[_.\-]|$)/;

function hasSqlFiles(directory: string): boolean {
  return readdirSync(directory, { withFileTypes: true }).some((entry) => entry.isFile() && /\.sql$/i.test(entry.name));
}

/**
 * The directory of migrations for a path: the path itself when it holds
 * `.sql` files, else the first conventional migrations directory under it.
 */
export function findMigrationsDirectory(path: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new MigrationSourceError(`${path} is not a directory.`);
  }
  if (hasSqlFiles(absolute)) {
    return absolute;
  }
  for (const candidate of MIGRATION_DIRECTORIES) {
    const directory = join(absolute, candidate);
    if (existsSync(directory) && statSync(directory).isDirectory() && hasSqlFiles(directory)) {
      return directory;
    }
  }
  throw new MigrationSourceError(
    `No PostgreSQL migrations found in ${path}: it has no .sql files, and neither has ${MIGRATION_DIRECTORIES.join(", ")} under it. Give the directory that holds the migrations.`,
  );
}

/** The `.sql` files of a migrations directory, in the order they are applied. Subdirectories are not read. */
export function readMigrationFiles(directory: string): MigrationFile[] {
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.sql$/i.test(entry.name))
    .map((entry) => entry.name);
  if (names.length === 0) {
    throw new MigrationSourceError(`${directory} has no .sql files.`);
  }
  const versions = names.map((name) => VERSIONED.exec(name)?.[1]);
  let ordered: string[];
  if (versions.every((version) => version !== undefined)) {
    const byVersion = new Map<bigint, string>();
    for (const [index, name] of names.entries()) {
      const version = BigInt(versions[index] as string);
      const other = byVersion.get(version);
      if (other !== undefined) {
        throw new MigrationSourceError(`${directory}: ${other} and ${name} have the same version (${version}), so their order is not defined.`);
      }
      byVersion.set(version, name);
    }
    ordered = [...byVersion.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, name]) => name);
  } else {
    ordered = [...names].sort();
  }
  return ordered.map((name) => {
    const path = join(directory, name);
    const bytes = readFileSync(path);
    return { file: relative(directory, path).split("\\").join("/"), path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}
