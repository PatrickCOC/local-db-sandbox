import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/*
 * Paths as the commands print them, and the database of a project, as a
 * command finds it when none is named (D-052). Nothing here writes, scans,
 * or starts anything: it reads what this tool wrote.
 */

/** Where every command of this tool keeps what it writes in a project. */
export const SANDBOX_DIRECTORY = ".local-db-sandbox";

/**
 * A path as a command line takes it: from the current directory when it is
 * below it, with `/` between its parts, which every shell on Windows takes
 * (a `\` is an escape in Git Bash); in double quotes when it has a space or
 * a character a shell would read, which bash, cmd, and PowerShell all take.
 */
export function shownPath(path: string, cwd: string = process.cwd()): string {
  const way = relative(cwd, path);
  const shown = way === "" ? "." : way.startsWith("..") || isAbsolute(way) ? path : way;
  const slashed = sep === "\\" ? shown.split("\\").join("/") : shown;
  return /^[\w@%+=:,./\-\u0080-\uffff]+$/u.test(slashed) ? slashed : `"${slashed.replaceAll('"', '\\"')}"`;
}

/** The nearest `.local-db-sandbox` directory at or above `from`. */
function sandboxDirectoryAbove(from: string): string | undefined {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    const candidate = join(directory, SANDBOX_DIRECTORY);
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dirname(directory) === directory) {
      return undefined;
    }
  }
}

export type ProjectDatabase =
  | { status: "found"; database: string; source: string; port?: number }
  | { status: "none" | "ambiguous" | "missing"; message: string };

/**
 * The database of the project that `from` is in, when no command line named
 * one: the one `.local-db-sandbox/sandbox.config.json` names (`init-nest`),
 * or `.local-db-sandbox/sandbox.db` (`init`, `init-pg`). When the project has
 * both, and they are not the same, none is taken: both are named.
 */
export function findProjectDatabase(from: string = process.cwd()): ProjectDatabase {
  const directory = sandboxDirectoryAbove(from);
  const howTo = "Name the database (local-db-sandbox studio <database>), or create one here with init, init-nest, or init-pg.";
  if (directory === undefined) {
    return { status: "none", message: `No database was named, and no ${SANDBOX_DIRECTORY} directory was found here or above. ${howTo}` };
  }
  const configFile = join(directory, "sandbox.config.json");
  let configured: { database: string; port?: number } | undefined;
  if (existsSync(configFile)) {
    try {
      const config = JSON.parse(readFileSync(configFile, "utf8")) as { database?: unknown; port?: unknown };
      if (typeof config.database === "string") {
        configured = { database: resolve(directory, config.database), ...(typeof config.port === "number" && { port: config.port }) };
      }
    } catch {
      // An unreadable configuration names nothing; the default below may still be there.
    }
  }
  const standard = join(directory, "sandbox.db");
  const candidates = [
    ...(configured !== undefined && existsSync(configured.database) ? [{ database: configured.database, source: `${shownPath(configFile)}`, ...(configured.port !== undefined && { port: configured.port }) }] : []),
    ...(existsSync(standard) && standard !== configured?.database ? [{ database: standard, source: `the default of init and init-pg` }] : []),
  ];
  if (candidates.length === 1) {
    return { status: "found", ...(candidates[0] as { database: string; source: string; port?: number }) };
  }
  if (candidates.length === 2) {
    return { status: "ambiguous", message: `No database was named, and this project has two: ${candidates.map((candidate) => `${shownPath(candidate.database)} (${candidate.source})`).join(" and ")}. Name the one to open.` };
  }
  return {
    status: "missing",
    message: `No database was named, and none of ${SANDBOX_DIRECTORY} is there: ${configured !== undefined ? `${shownPath(configured.database)} (named by ${shownPath(configFile)}) and ` : ""}${shownPath(standard)} do not exist. ${howTo}`,
  };
}

/** How Studio is started on `database` from the current directory: without a path when it would find that database by itself. */
export function studioCommand(database: string): string {
  const found = findProjectDatabase();
  return found.status === "found" && resolve(found.database) === resolve(database) ? "local-db-sandbox studio" : `local-db-sandbox studio ${shownPath(database)}`;
}

/** The last lines of a command that created something: what to run next, each with what it is for, in one column. */
export function nextSteps(steps: { command: string; why: string }[]): string[] {
  const width = Math.max(...steps.map((step) => step.command.length));
  return ["Next steps:", ...steps.map((step) => `  ${step.command.padEnd(width)}   ${step.why}`)];
}

const WRITE_FAILURES: Record<string, string> = {
  EACCES: "permission denied: this user may not write there",
  EPERM: "the operation is not permitted there (a file may be open in another program, or protected)",
  EROFS: "the file system is read-only",
  ENOSPC: "there is no space left on the disk",
  ENOTDIR: "a part of the path is a file, not a directory",
  EISDIR: "a directory is where a file was to be written",
  ENAMETOOLONG: "the path is too long",
  EBUSY: "the file is in use by another program",
};

/** Why writing failed, in words, from the system's code anywhere in the error's causes; `undefined` when no code says. */
export function writeFailureReason(error: unknown): string | undefined {
  for (let cause: unknown = error, depth = 0; cause !== undefined && cause !== null && depth < 5; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && WRITE_FAILURES[code] !== undefined) {
      return `${WRITE_FAILURES[code]} (${code})`;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return undefined;
}
