import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { startDisposablePostgres } from "../../import-postgres/test/support/disposable-postgres.ts";
import { allFiles } from "../../storage-json/test/support/database-files.ts";
import { GITIGNORE_HEADER, gitignoreRule, ignoreSandboxFiles } from "../src/gitignore.ts";
import { runCli } from "../src/index.ts";
import { findProjectDatabase, shownPath } from "../src/project-paths.ts";

/*
 * Setting up a project's sandbox (D-052): the .gitignore of the project's
 * Git repository, what the init commands print at the end, and the
 * project's database found without a path. Each project is a folder of its
 * own in the system's temporary folder, a Git repository where a test asks
 * for one (`git init`); what a rule matches is asked of Git itself.
 */

const MIGRATION = "create table notes (id serial primary key, body text not null);\ninsert into notes (body) values ('hello');\n";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
/** Whether Git ignores `path` (relative to `root`), by any rule it has. */
const ignored = (root: string, path: string): boolean => {
  try {
    git(root, "check-ignore", "-q", "--no-index", "--", path);
    return true;
  } catch {
    return false;
  }
};

describe("project setup: .gitignore, paths, and the project's database", { timeout: 180_000 }, () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-setup-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function run(cwd: string, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const before = process.cwd();
    process.chdir(cwd);
    try {
      const code = await runCli(argv, { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
      return { code, stdout, stderr };
    } finally {
      process.chdir(before);
    }
  }

  /** A project with one migration, in a folder of `name` under the test's folder; a Git repository with `repository`. */
  function project(name: string, options: { repository?: boolean; migration?: string } = {}): string {
    const root = join(dir, name);
    mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
    writeFileSync(join(root, "supabase", "migrations", "0001_init.sql"), options.migration ?? MIGRATION);
    if (options.repository === true) {
      git(root, "init", "-q");
    }
    return root;
  }

  describe(".gitignore", () => {
    it("is given the rules for what init wrote, which Git then ignores, and nothing more; a second run adds nothing", async () => {
      const root = project("app", { repository: true });
      const first = await run(root, "init");
      assert.equal(first.code, 0, first.stderr);
      const rules = [
        "/.local-db-sandbox/sandbox.db/",
        "/.local-db-sandbox/sandbox.db.owner.json",
        "/.local-db-sandbox/sandbox.db.owner.lock",
        "/.local-db-sandbox/sandbox-preview.db/",
        "/.local-db-sandbox/sandbox.db.report.json",
      ];
      assert.match(first.stdout, new RegExp(`\\nAdded to \\.gitignore: ${rules.map((rule) => rule.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join(" ")}\\n`));
      assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), `${GITIGNORE_HEADER}\n${rules.join("\n")}\n`);
      for (const path of [".local-db-sandbox/sandbox.db/manifest.json", ".local-db-sandbox/sandbox.db.owner.json", ".local-db-sandbox/sandbox-preview.db/manifest.json", ".local-db-sandbox/sandbox.db.report.json"]) {
        assert.ok(ignored(root, path), path);
      }
      // The configuration of a project, other databases, and other .db, .json, or .sql files are not.
      for (const path of [".local-db-sandbox/sandbox.config.json", ".local-db-sandbox/sandbox.server.ts", "other.db/manifest.json", "data.json", "supabase/migrations/0001_init.sql", "sandbox.db.owner.json"]) {
        assert.equal(ignored(root, path), false, path);
      }
      assert.equal(git(root, "status", "--porcelain", "--untracked-files=all").includes("sandbox.db/"), false);

      const again = await run(root, "init", "--force");
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /\n\.gitignore already ignores the sandbox's files\.\n/);
      assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), `${GITIGNORE_HEADER}\n${rules.join("\n")}\n`);
    });

    it("keeps the file as it was, byte for byte, with its comments, rules, line ends, and byte order mark", async () => {
      const root = project("kept", { repository: true });
      const original = "\uFEFF# My project\r\nnode_modules/\r\n\r\n# logs\r\n*.log\r\n!keep.log";
      writeFileSync(join(root, ".gitignore"), original);
      assert.equal((await run(root, "init")).code, 0);
      const text = readFileSync(join(root, ".gitignore"), "utf8");
      assert.ok(text.startsWith(`${original}\r\n\r\n${GITIGNORE_HEADER}\r\n/.local-db-sandbox/sandbox.db/\r\n`), JSON.stringify(text));
      assert.equal(text.includes("\n") && text.split("\n").every((line, index, lines) => index === lines.length - 1 || line.endsWith("\r")), true);
      // A database somewhere else in the project gets its rules under the same comment line, and nothing else moves.
      assert.equal((await run(root, "init", "--out", "data/second.db")).code, 0);
      const after = readFileSync(join(root, ".gitignore"), "utf8");
      assert.ok(after.startsWith(original));
      assert.equal(after.split(GITIGNORE_HEADER).length, 2);
      assert.match(after, /\/\.local-db-sandbox\/sandbox\.db\.report\.json\r\n\/data\/second\.db\/\r\n/);
      assert.ok(ignored(root, "data/second.db/manifest.json"));
    });

    it("adds nothing for what Git ignores already, by a rule of the project's own", async () => {
      const root = project("own-rule", { repository: true });
      writeFileSync(join(root, ".gitignore"), "# everything of the sandbox\n.local-db-sandbox/\n");
      const result = await run(root, "init");
      assert.match(result.stdout, /\n\.gitignore already ignores the sandbox's files\.\n/);
      assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "# everything of the sandbox\n.local-db-sandbox/\n");
    });

    it("is left alone outside a Git repository, with --no-gitignore, and for a database outside the project's repository", async () => {
      const plain = project("no-repository");
      const result = await run(plain, "init");
      assert.equal(result.code, 0);
      assert.match(result.stdout, /\n\.gitignore was not changed: .*no-repository is not in a Git repository \(no \.git there or above\)\.\n/);
      assert.equal(existsSync(join(plain, ".gitignore")), false);

      const asked = project("asked-not-to", { repository: true });
      const quiet = await run(asked, "init", "--no-gitignore");
      assert.equal(quiet.code, 0);
      assert.doesNotMatch(quiet.stdout, /gitignore/);
      assert.equal(existsSync(join(asked, ".gitignore")), false);

      const inside = project("inside", { repository: true });
      const elsewhere = join(dir, "elsewhere", "sandbox.db");
      const outside = await run(inside, "init", "--out", elsewhere);
      assert.equal(outside.code, 0);
      assert.match(outside.stdout, /\n\.gitignore was not changed: the database is not in the project's Git repository \(.*inside\)\.\n/);
      assert.equal(existsSync(join(inside, ".gitignore")), false);
    });

    it("is not changed when init fails, and a database that was there stays as it was", async () => {
      const root = project("failing", { repository: true });
      assert.equal((await run(root, "init", "--no-gitignore")).code, 0);
      writeFileSync(join(root, ".gitignore"), "# mine\n");
      const database = join(root, ".local-db-sandbox", "sandbox.db");
      const before = await allFiles(database);
      writeFileSync(join(root, "supabase", "migrations", "0002_broken.sql"), "alter table nowhere add column x int;\n");
      const failed = await run(root, "init", "--force");
      assert.equal(failed.code, 1);
      assert.match(failed.stderr, /relation "nowhere" does not exist\. Nothing was written\./);
      assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "# mine\n");
      assert.deepEqual(await allFiles(database), before);
    });

    it("says which generated files Git tracks already, and takes nothing out of Git", async () => {
      const root = project("tracked", { repository: true });
      assert.equal((await run(root, "init", "--no-gitignore")).code, 0);
      git(root, "add", ".");
      git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "a database, committed by mistake");
      const result = await run(root, "init", "--force");
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /\nWarning: Git already tracks \.local-db-sandbox\/sandbox\.db, \.local-db-sandbox\/sandbox\.db\.report\.json; a rule does not change that\. To stop tracking it without deleting it: git rm -r --cached \.local-db-sandbox\/sandbox\.db \.local-db-sandbox\/sandbox\.db\.report\.json\n/);
      assert.ok(git(root, "ls-files").includes(".local-db-sandbox/sandbox.db/manifest.json"));
    });

    it("is given the rules for what init-pg wrote, from the directory it is run in", async () => {
      const server = await startDisposablePostgres("create table notes (id integer primary key, body text);");
      try {
        const root = join(dir, "scanned");
        mkdirSync(root);
        git(root, "init", "-q");
        const result = await run(root, "init-pg", server.url);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /\nAdded to \.gitignore: \/\.local-db-sandbox\/sandbox\.db\/ .* \/\.local-db-sandbox\/sandbox\.db\.report\.json\nNext steps:\n {2}local-db-sandbox studio +look into the tables, and add rows\n/);
        assert.ok(ignored(root, ".local-db-sandbox/sandbox.db/manifest.json"));
        // A scan that fails changes no .gitignore.
        writeFileSync(join(root, ".gitignore"), "# kept\n");
        const failed = await run(root, "init-pg", server.url, "--schema", "nowhere", "--force");
        assert.equal(failed.code, 1);
        assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "# kept\n");
      } finally {
        await server.stop();
      }
    });

    it("writes rules for paths with spaces, Unicode, and pattern characters that match those paths and no others", async () => {
      const root = join(dir, "my proj ü");
      mkdirSync(root);
      git(root, "init", "-q");
      for (const [database, format] of [["data [1]/sand*box ü.db", "directory"], ["single file?.db.json", "file"]] as const) {
        const outcome = await ignoreSandboxFiles(root, { database: join(root, database), format });
        assert.equal(outcome.status, "added");
      }
      assert.equal(gitignoreRule("data [1]/sand*box ü.db", true), "/data \\[1]/sand\\*box ü.db/");
      assert.ok(ignored(root, "data [1]/sand*box ü.db/manifest.json"));
      assert.ok(ignored(root, "data [1]/sand*box ü-preview.db/manifest.json"));
      assert.ok(ignored(root, "data [1]/sand*box ü.db.owner.json"));
      assert.ok(ignored(root, "single file?.db.json"));
      assert.ok(ignored(root, "single file?-preview.db.json"));
      // The pattern characters are taken as themselves.
      for (const path of ["data 1/sand*box ü.db/manifest.json", "data [1]/sandXbox ü.db/manifest.json", "single fileX.db.json"]) {
        assert.equal(ignored(root, path), false, path);
      }
    });
  });

  describe("what the init commands print, and the project's database", () => {
    it("reads the current directory without an argument, and prints the next steps with paths that paste into any shell", async () => {
      const root = project("next steps ü", { repository: true });
      const result = await run(root, "init");
      assert.equal(result.code, 0, result.stderr);
      // In the project, Studio finds the database by itself.
      assert.match(result.stdout, /\nNext steps:\n {2}local-db-sandbox studio +look into the rows, and change them\n {2}local-db-sandbox postgrest \.local-db-sandbox\/sandbox\.db {3}serve the database to supabase-js clients\n$/);
      // From elsewhere, the path is whole, with `/`, and in quotes when it has a space.
      assert.equal(shownPath(join(root, ".local-db-sandbox", "sandbox.db"), dir), `"next steps ü/.local-db-sandbox/sandbox.db"`);
      assert.equal(shownPath(join(root, "plain.db"), root), "plain.db");
    });

    it("says which command is for a project of the other kind", async () => {
      const nest = join(dir, "nest-app");
      mkdirSync(join(nest, "src"), { recursive: true });
      writeFileSync(join(nest, "src", "main.ts"), "// a NestJS entry point\n");
      writeFileSync(join(nest, "nest-cli.json"), "{}\n");
      const forNest = await run(nest, "init");
      assert.equal(forNest.code, 1);
      assert.match(forNest.stderr, /^Error: No PostgreSQL migrations found in .*\. This looks like a NestJS project: for NestJS \+ TypeORM, use init-nest\.\n/);
      const empty = join(dir, "empty");
      mkdirSync(empty);
      assert.match((await run(empty, "init")).stderr, /\. To read the schema of a running PostgreSQL database instead, use init-pg\.\n/);
      const migrations = project("migrations-only");
      const forMigrations = await run(migrations, "init-nest");
      assert.equal(forMigrations.code, 1);
      assert.match(forMigrations.stderr, /^Error: Entry point does not exist: .*\. This directory has PostgreSQL migrations \(supabase\/migrations\): for those, use init\.\n/);
    });

    it("says why a database cannot be written where it was asked for", async () => {
      const root = project("blocked");
      writeFileSync(join(root, "a-file"), "not a directory\n");
      const result = await run(root, "init", "--out", "a-file/sandbox.db");
      assert.equal(result.code, 1);
      assert.match(result.stderr, /^Error: The database could not be created at a-file\/sandbox\.db: .*\(a part of the path is a file, not a directory \(ENOTDIR\)\)\n/);
    });

    it("finds the project's database for studio: the default of init, the one init-nest's configuration names, or says why not", () => {
      const none = join(dir, "nothing-here");
      mkdirSync(none);
      assert.deepEqual(findProjectDatabase(none).status, "none");

      const root = join(dir, "project");
      mkdirSync(join(root, ".local-db-sandbox", "sandbox.db"), { recursive: true });
      mkdirSync(join(root, "src", "deep"), { recursive: true });
      const found = findProjectDatabase(join(root, "src", "deep"));
      assert.deepEqual(found, { status: "found", database: join(root, ".local-db-sandbox", "sandbox.db"), source: "the default of init and init-pg" });

      // init-nest's configuration names a database that is not there yet: the default is the one there is.
      writeFileSync(join(root, ".local-db-sandbox", "sandbox.config.json"), JSON.stringify({ entry: "../src/main.ts", database: "../sandbox.db", port: 3001 }));
      assert.equal(findProjectDatabase(root).status, "found");
      // Both are there: none is taken, and both are named.
      mkdirSync(join(root, "sandbox.db"));
      const both = findProjectDatabase(root);
      assert.equal(both.status, "ambiguous");
      assert.match(both.status === "ambiguous" ? both.message : "", /this project has two: .*sandbox\.db \(.*sandbox\.config\.json\) and .*\.local-db-sandbox\/sandbox\.db \(the default of init and init-pg\)\. Name the one to open\./);
      // The configuration's database alone: taken, with the port of its sandbox.
      rmdirSync(join(root, ".local-db-sandbox", "sandbox.db"));
      assert.deepEqual(findProjectDatabase(root), { status: "found", database: join(root, "sandbox.db"), source: shownPath(join(root, ".local-db-sandbox", "sandbox.config.json")), port: 3001 });
      // Neither: said, with both names.
      rmdirSync(join(root, "sandbox.db"));
      const missing = findProjectDatabase(root);
      assert.equal(missing.status, "missing");
      assert.match(missing.status === "missing" ? missing.message : "", /do not exist\. Name the database \(local-db-sandbox studio <database>\), or create one here with init, init-nest, or init-pg\.$/);
    });

    it("opens the project's database in studio without a path, and starts the API tab at init-nest's sandbox", async () => {
      const root = join(dir, "studio project");
      mkdirSync(join(root, ".local-db-sandbox"), { recursive: true });
      writeFileSync(join(root, ".local-db-sandbox", "sandbox.config.json"), JSON.stringify({ entry: "../src/main.ts", database: "../sandbox.db", port: 3456 }));
      const quiet = { stdout: { write: () => undefined }, stderr: { write: () => undefined }, signals: new EventEmitter() };
      writeFileSync(join(dir, "seed.json"), JSON.stringify({ data: { notes: [{ id: 1, text: "a" }] } }));
      assert.equal(await runCli(["convert", join(dir, "seed.json"), "--out", join(root, "sandbox.db")], quiet), 0);
      const before = process.cwd();
      process.chdir(root);
      let output = "";
      const signals = new EventEmitter();
      const write = (text: string): void => {
        output += text;
      };
      const exit = runCli(["studio", "--port", "0"], { stdout: { write }, stderr: { write }, signals });
      try {
        for (let waited = 0; !/Press Ctrl\+C to stop\./.test(output) && waited < 30_000; waited += 100) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.match(output, /^Opening sandbox\.db \(from \.local-db-sandbox\/sandbox\.config\.json\)\.\n/);
        assert.match(output, /\nLocal DB Studio at /);
        const [url, key] = (/(http:\/\/127\.0\.0\.1:\d+)\/#key=([0-9a-f]{48})/.exec(output) ?? []).slice(1) as [string, string];
        const status = (await (await fetch(`${url}/api/status`, { headers: { authorization: `Bearer ${key}` } })).json()) as { api?: string };
        assert.equal(status.api, "http://127.0.0.1:3456/");
      } finally {
        // Stopped whatever happened, so that a failed assertion leaves no server behind.
        signals.emit("SIGINT");
        assert.equal(await exit, 0);
        process.chdir(before);
      }
    });
  });
});
