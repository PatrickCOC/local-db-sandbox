import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { previewPathOf } from "./simulate-command.ts";

/*
 * The host project's `.gitignore`, for what an init command wrote (D-052).
 *
 * What is ignored is what this tool generates and nothing else: the database
 * (a directory, or a single file), the record of the process that has it
 * open (`<database>.owner.json`, `.owner.lock`), the copy `simulate` writes
 * beside it (`<name>-preview.db`), and the report of `init` and `init-pg`.
 * Each rule names its own path from the repository's root (`/...`), so that
 * no other `.db`, `.json`, or `.sql` file is matched. The project's sandbox
 * configuration (`sandbox.config.json`, `sandbox.server.ts`) is not
 * ignored: a team may share it.
 *
 * The file is changed only when it is safe to:
 *
 * - The project and the database are in one Git repository: the nearest
 *   `.git` above each is the same. Otherwise nothing is written, and that is
 *   said (no repository; a database outside the project's repository).
 * - A rule that is there already, or a path that Git ignores already by
 *   another rule (`git check-ignore`, when Git is installed), is not added.
 * - What the file holds stays as it is, byte for byte, with its comments,
 *   its line ends, and its byte order mark: the rules are added at its end,
 *   under a comment line that says where they came from, or under that line
 *   when an earlier run wrote it. The new file is written beside it and put
 *   in its place in one step.
 * - A path that Git tracks already is named, with the command that stops
 *   tracking it; nothing is removed from Git.
 *
 * The commands call this only after they succeeded: a failed init changes
 * no `.gitignore`.
 */

export const GITIGNORE_HEADER = "# Local DB Sandbox: local databases and runtime files (added by local-db-sandbox)";

export interface SandboxFiles {
  /** The database: a directory, or a single file. */
  database: string;
  format: "directory" | "file";
  /** The report beside the database, when the command writes one. */
  report?: string;
}

export type GitignoreOutcome =
  /** `added` holds the rules written. */
  | { status: "added"; file: string; added: string[]; tracked: string[] }
  /** Every path was ignored already. */
  | { status: "present"; file: string; tracked: string[] }
  | { status: "no-repository" | "other-repository" | "failed"; reason: string };

/** The nearest directory at or above `from` that has a `.git` (a directory, or the file of a worktree or submodule). */
export function gitRootOf(from: string): string | undefined {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) {
      return directory;
    }
    if (dirname(directory) === directory) {
      return undefined;
    }
  }
}

/** A path in `.gitignore`'s pattern syntax: from the root, each character taken as itself. */
export function gitignoreRule(path: string, directory: boolean): string {
  // `\`, `*`, `?`, and `[` are pattern characters, escaped with a backslash; a trailing space would be dropped unless escaped.
  const escaped = path.replace(/[\\*?[]/g, "\\$&").replace(/ $/, "\\ ");
  return `/${escaped}${directory ? "/" : ""}`;
}

/** Runs Git in `root`, and gives its output; `undefined` when Git is not there, or did not answer. */
function git(root: string, args: string[], input?: string): Promise<{ code: number; stdout: string } | undefined> {
  return new Promise((done) => {
    const child = execFile("git", ["-C", root, ...args], { timeout: 5_000, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : undefined;
      done(code === undefined ? undefined : { code, stdout });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}

/** The generated paths of a database, relative to the root with `/`, each with whether it is a directory. */
function generatedPaths(root: string, files: SandboxFiles): { path: string; directory: boolean }[] {
  const within = (path: string): string | undefined => {
    const way = relative(root, path);
    return way === "" || way.startsWith("..") || isAbsolute(way) ? undefined : way.split(sep).join("/");
  };
  const database = resolve(files.database);
  const paths = [
    { path: database, directory: files.format === "directory" },
    { path: `${database}.owner.json`, directory: false },
    { path: `${database}.owner.lock`, directory: false },
    { path: resolve(previewPathOf(database)), directory: files.format === "directory" },
    ...(files.report === undefined ? [] : [{ path: resolve(files.report), directory: false }]),
  ];
  return paths.flatMap((entry) => {
    const way = within(entry.path);
    return way === undefined ? [] : [{ path: way, directory: entry.directory }];
  });
}

/** Where rules go in `text` when an earlier run wrote the header: the end of the block of lines under it. */
function endOfBlock(text: string): number | undefined {
  const lines = text.split(/(?<=\n)/);
  let at = 0;
  let inBlock = false;
  let end: number | undefined;
  for (const line of lines) {
    const content = line.replace(/\r?\n$/, "");
    if (content === GITIGNORE_HEADER) {
      inBlock = true;
      end = at + line.length;
    } else if (inBlock && content.trim() !== "") {
      end = at + line.length;
    } else {
      inBlock = false;
    }
    at += line.length;
  }
  return end;
}

/**
 * Adds the rules for what an init command wrote to the `.gitignore` of the
 * project's Git repository, as far as that is safe. `project` is the
 * project's directory.
 */
export async function ignoreSandboxFiles(project: string, files: SandboxFiles): Promise<GitignoreOutcome> {
  const root = gitRootOf(project);
  if (root === undefined) {
    return { status: "no-repository", reason: `${project} is not in a Git repository (no .git there or above)` };
  }
  if (gitRootOf(dirname(resolve(files.database))) !== root) {
    return { status: "other-repository", reason: `the database is not in the project's Git repository (${root})` };
  }
  const paths = generatedPaths(root, files);
  const file = join(root, ".gitignore");
  let text = "";
  try {
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch (error) {
    return { status: "failed", reason: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  // What Git ignores already, by any rule of any of its files; without Git, the rules written in this file as they would be written.
  const ignored = new Set<string>();
  // The paths go in as they are, one after the other with NUL between them (`-z` takes them so, and only from its input).
  // With `-v`, Git says which pattern matched: source, line, pattern, path. A path counts as ignored only by a pattern that
  // has something in it and is no negation: Git takes the `\r` of an empty line of a CRLF file for a pattern that matches.
  const asked = await git(root, ["check-ignore", "-z", "-v", "--no-index", "--stdin"], paths.map((entry) => `${entry.directory ? `${entry.path}/` : entry.path}\0`).join(""));
  if (asked !== undefined && (asked.code === 0 || asked.code === 1)) {
    const fields = asked.stdout.split("\0");
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const pattern = (fields[index + 2] as string).trim();
      if (pattern !== "" && !pattern.startsWith("!")) {
        ignored.add((fields[index + 3] as string).replace(/\/$/, ""));
      }
    }
  }
  const missing = paths.filter((entry) => !ignored.has(entry.path) && !lines.has(gitignoreRule(entry.path, entry.directory)));
  const listed = await git(root, ["ls-files", "-z", "--", ...paths.map((entry) => entry.path)]);
  const tracked =
    listed?.code === 0
      ? paths
          .map((entry) => entry.path)
          .filter((path) => listed.stdout.split("\0").some((line) => line === path || line.startsWith(`${path}/`)))
      : [];
  if (missing.length === 0) {
    return { status: "present", file, tracked };
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const rules = missing.map((entry) => gitignoreRule(entry.path, entry.directory));
  const end = endOfBlock(text);
  let next: string;
  if (end !== undefined) {
    // Under the rules an earlier run added; the rest of the file as it is.
    const before = text.slice(0, end);
    next = `${before}${before.endsWith("\n") ? "" : eol}${rules.join(eol)}${eol}${text.slice(end)}`;
  } else {
    const ending = text === "" || text.endsWith("\n") ? "" : eol;
    next = `${text}${ending}${text.trim() === "" ? "" : eol}${GITIGNORE_HEADER}${eol}${rules.join(eol)}${eol}`;
  }
  const temporary = join(root, `.gitignore.local-db-sandbox-${process.pid}`);
  try {
    writeFileSync(temporary, next);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    return { status: "failed", reason: `${file} could not be written: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { status: "added", file, added: rules, tracked };
}

/** What a command prints about the outcome. */
export function describeGitignore(outcome: GitignoreOutcome, shown: (path: string) => string): string[] {
  const tracked = (list: string[]): string[] =>
    list.length === 0 ? [] : [`Warning: Git already tracks ${list.join(", ")}; a rule does not change that. To stop tracking it without deleting it: git rm -r --cached ${list.map((path) => (/[\s"']/.test(path) ? JSON.stringify(path) : path)).join(" ")}`];
  switch (outcome.status) {
    case "added":
      return [`Added to ${shown(outcome.file)}: ${outcome.added.join(" ")}`, ...tracked(outcome.tracked)];
    case "present":
      return [`${shown(outcome.file)} already ignores the sandbox's files.`, ...tracked(outcome.tracked)];
    case "failed":
      return [`Warning: .gitignore was not changed: ${outcome.reason}. Add the sandbox's paths yourself, or run again.`];
    default:
      return [`.gitignore was not changed: ${outcome.reason}.`];
  }
}
