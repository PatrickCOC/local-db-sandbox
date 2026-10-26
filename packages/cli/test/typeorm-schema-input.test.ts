import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createNestProject } from "../../nest-typeorm/test/support/nest-project.ts";
import { runCli } from "../src/index.ts";

/*
 * TypeORM entities as a side of the three schema commands (Phase E2, D-044):
 * `diff-schema`, `plan-migration`, and `generate-migration` read a NestJS
 * project, a folder of entity files, or one entity file, through the entity
 * collection that `init-nest` uses, and compare what it gives.
 *
 * The projects are copies of the NestJS fixture of this repository
 * (`packages/nest-typeorm/test/fixtures/nest-project`: the entities `User`
 * and `Category`), in temporary directories. Where an entity is changed in a
 * project that has been read before, each command is a process of its own,
 * as it is for a user: a process reads an entity file once.
 */

const BIN = join(import.meta.dirname, "../src/bin.ts");
const TYPEORM_FIXTURES = join(import.meta.dirname, "../../import-typeorm/test/fixtures");

/** `User` with the column `active` taken away and a column `nickname` added. */
const USER_CHANGED = `import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ type: "varchar", length: 40, nullable: true })
  nickname: string;

  @CreateDateColumn()
  createdAt: Date;
}
`;

/** A third entity, in a file of its own. */
const TAG = `import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class Tag {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar", length: 20 })
  label: string;
}
`;

/** `User` with a relation that needs a join table, which the entity collection does not read. */
const USER_WITH_JOIN_TABLE = `import { Column, CreateDateColumn, Entity, JoinTable, ManyToMany, PrimaryGeneratedColumn } from "typeorm";
import { Category } from "../categories/category.entity";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ default: true })
  active: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToMany(() => Category)
  @JoinTable()
  categories: Category[];
}
`;

/** The tables of the fixture's entities as PostgreSQL migrations would make them, with nothing an entity does not say. */
const TABLES_AS_ENTITIES_SAY = [
  'create table users (id serial primary key, name varchar not null, active boolean not null default true, "createdAt" timestamp not null);',
  "create table category (code varchar primary key, label varchar not null);",
].join("\n");

/** The same tables with what entities do not say here: an index, a unique and a check constraint, and the default of a column that TypeORM fills. */
const TABLES_WITH_MORE = [
  'create table users (id serial primary key, name varchar not null, active boolean not null default true, "createdAt" timestamp not null default now(), constraint users_name_key unique (name), constraint users_name_check check (name <> \'\'));',
  "create index users_active_idx on users (active);",
  "create table category (code varchar primary key, label varchar not null);",
].join("\n");

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** What a command printed after the two lines that name its sides. */
const body = (stdout: string): string => stdout.split("\n").slice(2).join("\n");
/** The steps that a refusal of `generate-migration` lists, each as it is written, in the order of their text. */
const stepsOf = (stderr: string): string[] =>
  stderr
    .split("\n")
    .filter((line) => /^  step \d+: /.test(line))
    .map((line) => line.replace(/^  step \d+: /, ""))
    .sort();

describe("CLI: TypeORM entities as a side of diff-schema, plan-migration, and generate-migration", { timeout: 600_000 }, () => {
  const made: string[] = [];

  after(async () => {
    for (const directory of made) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  /** A copy of the fixture project, with files written over or added before anything of it is read. */
  async function project(files: Record<string, string> = {}): Promise<string> {
    const directory = await createNestProject();
    made.push(directory);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(directory, name, ".."), { recursive: true });
      writeFileSync(join(directory, name), text);
    }
    return directory;
  }
  const changed = { "src/users/user.entity.ts": USER_CHANGED, "src/tags/tag.entity.ts": TAG };

  async function scratch(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "local-db-sandbox-entities-"));
    made.push(directory);
    return directory;
  }

  /** Runs a command in this process. */
  async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  }

  /** Runs a command as a user does: a process of its own, in the project. What Node itself warns of is left out of stderr. */
  function cli(cwd: string, ...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({
          code,
          stdout,
          stderr: stderr
            .split("\n")
            .filter((line) => !/^\(node:\d+\) ExperimentalWarning: |^\(Use `node --trace-warnings/.test(line))
            .join("\n"),
        }),
      );
    });
  }

  /** A database directory made from PostgreSQL migrations by `init`. */
  async function databaseFromMigrations(sql: string): Promise<string> {
    const directory = await scratch();
    mkdirSync(join(directory, "migrations"));
    writeFileSync(join(directory, "migrations", "0001_init.sql"), sql);
    const database = join(directory, "sandbox.db");
    const created = await run("init", join(directory, "migrations"), "--out", database, "--report", join(directory, "report.json"));
    assert.equal(created.code, 0, created.stderr);
    return database;
  }

  /** Every file under a directory, but for installed packages, with its size and when it was last written. */
  function fingerprint(directory: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      const full = join(entry.parentPath, entry.name);
      const name = full.slice(directory.length + 1).replaceAll("\\", "/");
      if (name.split("/").includes("node_modules")) {
        continue;
      }
      const stats = statSync(full);
      found[name] = entry.isDirectory() ? "directory" : `${stats.size} bytes, written ${stats.mtimeMs}`;
    }
    return found;
  }

  describe("a database and the project it was made from", () => {
    it("do not differ while the entities are as they were, whichever is given first", async () => {
      const directory = await project();
      assert.equal((await cli(directory, "init-nest")).code, 0);

      const same = await cli(directory, "diff-schema", "sandbox.db", ".");
      assert.deepEqual([same.code, same.stderr], [0, ""]);
      assert.equal(same.stdout, "Before: sandbox.db (database directory)\nAfter:  . (TypeORM entities in src, 2 tables)\nNo differences.\n");

      const reversed = await cli(directory, "diff-schema", ".", "sandbox.db");
      assert.deepEqual([reversed.code, reversed.stderr], [0, ""]);
      assert.equal(reversed.stdout, "Before: . (TypeORM entities in src, 2 tables)\nAfter:  sandbox.db (database directory)\nNo differences.\n");

      assert.equal((await cli(directory, "diff-schema", "sandbox.db", ".", "--json")).stdout, '{\n  "diffVersion": 1,\n  "changes": []\n}\n');
      assert.equal(body((await cli(directory, "plan-migration", "sandbox.db", ".")).stdout), "No steps: the two schemas do not differ.\n");
      const migration = await cli(directory, "generate-migration", "sandbox.db", ".", "--dialect", "postgres");
      assert.deepEqual([migration.code, migration.stderr, /\b(ALTER|CREATE|DROP)\b/.test(migration.stdout)], [0, "", false], migration.stdout);
    });

    it("differ by what a change of the entities changes, before anything is written: the diff, the plan, and the SQL", async () => {
      const directory = await project();
      assert.equal((await cli(directory, "init-nest")).code, 0);
      // The entities change after the database was made: a column goes, a column comes, and there is one more entity.
      writeFileSync(join(directory, "src/users/user.entity.ts"), USER_CHANGED);
      mkdirSync(join(directory, "src/tags"));
      writeFileSync(join(directory, "src/tags/tag.entity.ts"), TAG);
      const before = fingerprint(directory);

      // What the changed entities are as a database is known by another way: a second project that has them from the start, and its database.
      const other = await project(changed);
      assert.equal((await cli(other, "init-nest")).code, 0);
      const newer = join(other, "sandbox.db");

      const diff = await cli(directory, "diff-schema", "sandbox.db", ".");
      assert.deepEqual([diff.code, diff.stderr], [0, ""]);
      assert.equal(diff.stdout.split("\n").slice(0, 3).join("\n"), "Before: sandbox.db (database directory)\nAfter:  . (TypeORM entities in src, 3 tables)\n3 changes:");
      assert.match(diff.stdout, /^  - column users\.active\b/m);
      assert.match(diff.stdout, /^  \+ column users\.nickname varchar\(40\)$/m);
      assert.match(diff.stdout, /^  \+ table tag\b/m);
      assert.equal(body(diff.stdout), body((await cli(directory, "diff-schema", "sandbox.db", newer)).stdout));
      // As JSON it is the same bytes as the diff of the two databases: the paths of what was compared are not part of it.
      const json = (await cli(directory, "diff-schema", "sandbox.db", ".", "--json")).stdout;
      assert.deepEqual(JSON.parse(json).changes.map((change: { op: string }) => change.op).sort(), ["addColumn", "addTable", "dropColumn"]);
      assert.equal(json, (await cli(directory, "diff-schema", "sandbox.db", newer, "--json")).stdout);

      // The other way round, the project is what is left behind.
      const reversed = await cli(directory, "diff-schema", ".", "sandbox.db");
      assert.deepEqual([reversed.code, reversed.stderr], [0, ""]);
      assert.match(reversed.stdout, /^  - table tag\b/m);
      assert.match(reversed.stdout, /^  - column users\.nickname\b/m);
      assert.match(reversed.stdout, /^  \+ column users\.active boolean not null default true$/m);
      assert.equal(body(reversed.stdout), body((await cli(directory, "diff-schema", newer, "sandbox.db")).stdout));

      const plan = await cli(directory, "plan-migration", "sandbox.db", ".");
      assert.deepEqual([plan.code, plan.stderr], [0, ""]);
      assert.match(plan.stdout, /^3 steps:$/m);
      assert.equal(body(plan.stdout), body((await cli(directory, "plan-migration", "sandbox.db", newer)).stdout));

      // The SQL has been given to PostgreSQL's own parser by the command, as every migration it prints.
      const migration = await cli(directory, "generate-migration", "sandbox.db", ".", "--dialect", "postgres");
      assert.deepEqual([migration.code, migration.stderr], [0, ""]);
      assert.match(migration.stdout, /^ALTER TABLE "users" DROP COLUMN "active";$/m);
      assert.match(migration.stdout, /^ALTER TABLE "users" ADD COLUMN "nickname" varchar\(40\);$/m);
      assert.match(migration.stdout, /^CREATE TABLE "tag" \($/m);
      assert.equal(migration.stdout, (await cli(directory, "generate-migration", "sandbox.db", newer, "--dialect", "postgres")).stdout);

      // Nothing was written: not the database, not the project, and nothing beside them.
      assert.deepEqual(fingerprint(directory), before);
    });
  });

  describe("two sets of entities", () => {
    it("are compared as projects, as folders of entity files, and as single entity files, and give the same diff each time", async () => {
      // Neither project was set up with init-nest: where its entities are is read from nest-cli.json.
      const [older, newer] = [await project(), await project(changed)];
      const projects = await run("diff-schema", older, newer);
      assert.deepEqual([projects.code, projects.stderr], [0, ""]);
      assert.equal(projects.stdout.split("\n").slice(0, 3).join("\n"), `Before: ${older} (TypeORM entities in src, 2 tables)\nAfter:  ${newer} (TypeORM entities in src, 3 tables)\n3 changes:`);
      assert.match(projects.stdout, /^  - column users\.active\b/m);
      assert.match(projects.stdout, /^  \+ column users\.nickname varchar\(40\)$/m);
      assert.match(projects.stdout, /^  \+ table tag\b/m);

      const folders = await run("diff-schema", join(older, "src"), join(newer, "src"));
      assert.deepEqual([folders.code, folders.stderr], [0, ""]);
      assert.equal(folders.stdout, [`Before: ${join(older, "src")} (TypeORM entities, 2 tables)`, `After:  ${join(newer, "src")} (TypeORM entities, 3 tables)`, body(projects.stdout)].join("\n"));

      // One file is the entities of that file: the table of the third entity is not part of either side.
      const [olderFile, newerFile] = [join(older, "src/users/user.entity.ts"), join(newer, "src/users/user.entity.ts")];
      const files = await run("diff-schema", olderFile, newerFile);
      assert.deepEqual([files.code, files.stderr], [0, ""]);
      assert.equal(files.stdout.split("\n").slice(0, 3).join("\n"), `Before: ${olderFile} (TypeORM entities, 1 table)\nAfter:  ${newerFile} (TypeORM entities, 1 table)\n2 changes:`);
      assert.doesNotMatch(files.stdout, /table tag/);

      // The same bytes for the same entities, however they were given and however often.
      const json = (await run("diff-schema", older, newer, "--json")).stdout;
      assert.deepEqual(JSON.parse(json).changes.map((change: { op: string }) => change.op).sort(), ["addColumn", "addTable", "dropColumn"]);
      assert.equal((await run("diff-schema", join(older, "src"), join(newer, "src"), "--json")).stdout, json);
      assert.equal((await run("diff-schema", older, newer, "--json")).stdout, json);

      // The plan and the SQL are made of them as of any two schemas.
      const plan = await run("plan-migration", older, newer);
      assert.deepEqual([plan.code, plan.stderr], [0, ""]);
      assert.match(plan.stdout, /^3 steps:$/m);
      const migration = await run("generate-migration", older, newer, "--dialect", "postgres");
      assert.deepEqual([migration.code, migration.stderr], [0, ""]);
      assert.match(migration.stdout, /^ALTER TABLE "users" ADD COLUMN "nickname" varchar\(40\);$/m);
    });

    it("are not given a meaning they do not have: a type PostgreSQL does not have is compared as it was declared, and the generator refuses to write it", async () => {
      const withDatetime = USER_CHANGED.replace('@Column({ type: "varchar", length: 40, nullable: true })\n  nickname: string;', '@Column({ type: "datetime", nullable: true })\n  seenAt: Date;');
      assert.match(withDatetime, /seenAt/);
      const [older, newer] = [await project(), await project({ "src/users/user.entity.ts": withDatetime })];
      const diff = await run("diff-schema", older, newer);
      assert.deepEqual([diff.code, diff.stderr], [0, ""]);
      assert.match(diff.stdout, /^  \+ column users\.seenAt datetime$/m);

      // The generator's own refusal, as for any schema: it is another matter than what entities do not say.
      const refused = await run("generate-migration", older, newer, "--dialect", "postgres");
      assert.deepEqual([refused.code, refused.stdout], [1, ""]);
      assert.match(refused.stderr, /^Error: No migration was generated: 1 of 2 steps cannot be written as SQL without knowing more\.$/m);
      assert.match(refused.stderr, /^  step 2, addColumn "users"\."seenAt": unsupported \(no-canonical-type\)$/m);
      assert.match(refused.stderr, /^    The column "users"\."seenAt" says how its type was spelled \("datetime"\), and not what the type is\./m);
      assert.doesNotMatch(refused.stderr, /does not say/);
    });
  });

  describe("what is loaded to read entities", () => {
    it("is the entity files and nothing else of the application: no entry point, no module, no database settings, no service", async () => {
      const directory = await project();
      const mark = join(directory, "loaded.txt");
      const marked = (name: string): void => {
        const file = join(directory, "src", name);
        writeFileSync(file, `require("node:fs").appendFileSync(${JSON.stringify(mark)}, ${JSON.stringify(`${name}\n`)});\n${readFileSync(file, "utf8")}`);
      };
      for (const name of ["main.ts", "app.module.ts", "database.config.ts", "users/users.module.ts", "users/users.service.ts", "users/user.entity.ts", "categories/category.entity.ts"]) {
        marked(name);
      }
      for (const command of [["diff-schema", ".", "."], ["plan-migration", ".", "."], ["generate-migration", ".", ".", "--dialect", "postgres"]]) {
        rmSync(mark, { force: true });
        const result = await cli(directory, ...command);
        assert.deepEqual([result.code, result.stderr], [0, ""], command.join(" "));
        assert.equal(readFileSync(mark, "utf8"), "categories/category.entity.ts\nusers/user.entity.ts\n", command.join(" "));
      }
    });

    it("is not a source file that declares no entity: it is refused, and not run", async () => {
      const directory = await project();
      const mark = join(directory, "ran.txt");
      writeFileSync(join(directory, "src/boot.ts"), `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\nexport const started = true;\n`);
      for (const name of ["src/boot.ts", "src/main.ts"]) {
        const file = join(directory, name);
        const refused = await run("diff-schema", directory, file);
        assert.deepEqual([refused.code, refused.stdout], [1, ""]);
        assert.match(refused.stderr, new RegExp(`^Error: <after>: ${escape(file)} declares no TypeORM entity, and was not loaded: `));
        assert.match(refused.stderr, /Give a file that declares entities, the folder that holds the entity files, or the project\./);
      }
      assert.equal(existsSync(mark), false);
    });

    it("may not open a connection that leaves this machine: the connection is refused, and the command fails and says where it went", async () => {
      // What a careless module does when it is loaded, and an entity file that imports it.
      const directory = await project({
        "src/shared/client.ts": 'import { connect } from "node:net";\n\nexport const client = connect({ host: "db.prod.example", port: 5432 });\nclient.on("error", () => undefined);\n',
        "src/users/user.entity.ts": `import "../shared/client";\n${USER_CHANGED}`,
      });
      const result = await cli(directory, "diff-schema", ".", ".");
      assert.deepEqual([result.code, result.stdout], [1, ""], result.stderr);
      assert.match(result.stderr, /^Error: <before>: The TypeORM entities in src were not collected: loading the entity files tried to reach db\.prod\.example:5432, which was refused\./);
      assert.match(result.stderr, /Reading entities connects to nothing outside this machine: /);
    });
  });

  describe("what cannot be read as entities", () => {
    it("is a project whose entities are not found: it says what it looked for, and takes the folder of the entity files", async () => {
      const directory = await project();
      rmSync(join(directory, "nest-cli.json"));
      renameSync(join(directory, "src/main.ts"), join(directory, "src/server.ts"));
      const older = await project();
      const refused = await run("diff-schema", older, directory);
      assert.deepEqual([refused.code, refused.stdout], [1, ""]);
      assert.equal(
        refused.stderr.split("\n")[0],
        `Error: <after>: ${directory} is a project with TypeORM whose entities are not found: it has no .local-db-sandbox/sandbox.config.json (which "init-nest" writes), and no entry point at ${join("src", "main.ts")}. Give the folder that holds its entity files.`,
      );
      // The folder is the way that is supported for such a project.
      assert.deepEqual([(await run("diff-schema", older, join(directory, "src"))).code, (await run("diff-schema", older, join(directory, "src"))).stdout.split("\n")[2]], [0, "No differences."]);
    });

    it("is a project, a folder, or a file without an entity: nothing is compared with an empty schema", async () => {
      const older = await project();
      const failure = async (path: string): Promise<string> => {
        const { code, stdout, stderr } = await run("diff-schema", older, path);
        assert.deepEqual([code, stdout], [1, ""], stderr);
        return stderr;
      };

      // A project of the right shape, with no entity file where its entities would be.
      const none = await project();
      rmSync(join(none, "src/users/user.entity.ts"));
      rmSync(join(none, "src/categories/category.entity.ts"));
      assert.equal((await failure(none)).split("\n")[0], `Error: <after>: ${none} has no TypeORM entity: no file in ${join(none, "src")} declares one, so there is nothing to compare.`);

      // Entity files of which no entity can be read: the collector says why, for each.
      const view = join(TYPEORM_FIXTURES, "unsupported", "view.entity.ts");
      const unreadable = await failure(view);
      assert.match(unreadable, new RegExp(`^Error: <after>: There is nothing to compare: No importable TypeORM entities found in ${escape(view)}\\.\\n`));
      assert.match(unreadable, /^  - Summary: Entity kind "view" is not supported; the entity was skipped\.$/m);

      // A folder with nothing of any kind in it.
      const empty = await scratch();
      assert.match(await failure(empty), new RegExp(`^Error: <after>: ${escape(empty)} is neither a database directory \\(it has no manifest\\.json\\), nor PostgreSQL migrations \\(.*\\), nor TypeORM entities \\(no file in it declares one\\)\\.\\n`));
    });

    it("is entity files that cannot be collected: the file and the reason are named", async () => {
      const older = await project();
      // An entity file that fails when it is loaded.
      const broken = join(TYPEORM_FIXTURES, "broken");
      const failed = await run("diff-schema", older, broken);
      assert.deepEqual([failed.code, failed.stdout], [1, ""]);
      assert.match(failed.stderr, new RegExp(`^Error: <after>: The TypeORM entities in ${escape(broken)} were not collected: Failed to load .*broken\\.entity\\.cjs: boom\\n`));

      // Entity files in a place where TypeORM is not installed.
      const bare = await scratch();
      writeFileSync(join(bare, "thing.entity.ts"), TAG);
      const uninstalled = await run("diff-schema", older, bare);
      assert.deepEqual([uninstalled.code, uninstalled.stdout], [1, ""]);
      assert.match(uninstalled.stderr, new RegExp(`^Error: <after>: The TypeORM entities in ${escape(bare)} were not collected: Cannot load "typeorm" from the project that contains `));
    });

    it("is a project that has PostgreSQL migrations and entities both: it is asked which, and each can be given", async () => {
      const directory = await project();
      mkdirSync(join(directory, "supabase/migrations"), { recursive: true });
      writeFileSync(join(directory, "supabase/migrations/0001_init.sql"), TABLES_AS_ENTITIES_SAY);
      const older = await project();

      const ambiguous = await run("diff-schema", older, directory);
      assert.deepEqual([ambiguous.code, ambiguous.stdout], [1, ""]);
      assert.equal(
        ambiguous.stderr.split("\n")[0],
        `Error: <after>: ${directory} has PostgreSQL migrations (${join(directory, "supabase", "migrations")}) and TypeORM entities (${join(directory, "src")}) both. Give the one to compare.`,
      );
      const migrations = await run("diff-schema", join(directory, "supabase/migrations"), join(directory, "supabase/migrations"));
      assert.deepEqual([migrations.code, migrations.stdout.split("\n")[1]], [0, `After:  ${join(directory, "supabase/migrations")} (PostgreSQL migrations, 1 file)`]);
      const entities = await run("diff-schema", older, join(directory, "src"));
      assert.deepEqual([entities.code, entities.stdout.split("\n").slice(1).join("\n")], [0, `After:  ${join(directory, "src")} (TypeORM entities, 2 tables)\nNo differences.\n`]);
    });

    it("is not a project with migrations and no entity: that is read as migrations, as it was", async () => {
      const directory = await project();
      rmSync(join(directory, "src/users/user.entity.ts"));
      rmSync(join(directory, "src/categories/category.entity.ts"));
      mkdirSync(join(directory, "migrations"));
      writeFileSync(join(directory, "migrations/0001_init.sql"), TABLES_AS_ENTITIES_SAY);
      const read = await run("diff-schema", directory, directory);
      assert.deepEqual([read.code, read.stderr], [0, ""]);
      assert.equal(read.stdout, `Before: ${directory} (PostgreSQL migrations, 1 file)\nAfter:  ${directory} (PostgreSQL migrations, 1 file)\nNo differences.\n`);
    });

    it("is not a folder that holds the .sql files itself: that is migrations, as it was, whatever else is in it", async () => {
      // Entity files beside the migrations: the folder was given, and it is a folder of migrations.
      const directory = await project();
      writeFileSync(join(directory, "src/0001_init.sql"), TABLES_AS_ENTITIES_SAY);
      const read = await run("diff-schema", join(directory, "src"), join(directory, "src"));
      assert.deepEqual([read.code, read.stderr], [0, ""]);
      assert.equal(read.stdout.split("\n")[0], `Before: ${join(directory, "src")} (PostgreSQL migrations, 1 file)`);
      // The entities of that project are read by giving the project: it keeps no migrations where a project keeps them.
      assert.equal((await run("diff-schema", directory, directory)).stdout.split("\n")[0], `Before: ${directory} (TypeORM entities in src, 2 tables)`);
    });

    it("is a project whose packages are not installed: it says that TypeORM is not there, and reads nothing", async () => {
      // The files of the project without what `npm install` gives it, outside any folder that has TypeORM.
      const directory = await scratch();
      mkdirSync(join(directory, "src/users"), { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "fresh-checkout", dependencies: { typeorm: "^0.3.0" } }));
      writeFileSync(join(directory, "src/main.ts"), "export {};\n");
      writeFileSync(join(directory, "src/users/user.entity.ts"), USER_CHANGED);
      const refused = await run("diff-schema", await project(), directory);
      assert.deepEqual([refused.code, refused.stdout], [1, ""]);
      assert.match(refused.stderr, new RegExp(`^Error: <after>: ${escape(directory)} is neither a database directory \\(it has no manifest\\.json\\), nor PostgreSQL migrations \\(.*\\), nor TypeORM entities \\(TypeORM is not installed for this project: install its packages, and its entities can be read\\)\\.\\n`));
    });
  });

  describe("what entities do not say", () => {
    it("is noted where the collection left a table, a column, or a key out, and not where it left nothing out", async () => {
      // The fixture of the entity collection's own tests: a join table, table inheritance, an embedded column, relations without a key.
      const entities = join(TYPEORM_FIXTURES, "unsupported");
      const read = await run("diff-schema", entities, entities);
      assert.equal(read.code, 0);
      assert.equal(read.stdout, `Before: ${entities} (TypeORM entities, 3 tables)\nAfter:  ${entities} (TypeORM entities, 3 tables)\nNo differences.\n`);
      const notes = read.stderr.split("\n").filter((line) => line.startsWith("Note: <after>: "));
      const about = `Note: <after>: ${entities}: not read from the entities, and not part of what is compared: `;
      assert.deepEqual([...notes].sort(), [
        `${about}Embedded entities are not supported; the property was skipped. (Account.address)`,
        `${about}Entities defined with EntitySchema are not supported; only decorated classes are imported. (legacy)`,
        `${about}Entity kind "entity-child" is not supported; the entity was skipped. (Photo)`,
        `${about}Many-to-many relations need a join table, which is not generated. (Account.tags)`,
        `${about}Membership does not have exactly one primary column; no key field was imported. (Account.membership)`,
        `${about}Referenced column "missing" was not found on Tag. (Account.odd)`,
        `${about}Table inheritance (@TableInheritance) is not supported; the entity was skipped. (Content)`,
        `${about}The related entity "Outside" was not imported, so the key field's type and target are unknown. (Account.outside)`,
      ]);
      // The same is said of the other side, and of nothing that is only about how the sandbox treats rows.
      assert.equal(read.stderr.split("\n").filter((line) => line.startsWith("Note: <before>: ")).length, 8);
      assert.doesNotMatch(read.stderr, /transformer|Lifecycle hooks|select: false|identifies rows|not enforced/);
    });

    it("is not written as SQL: an index, a unique or check constraint, and a default TypeORM sets, where one side has them and the entities are the other", async () => {
      const fuller = await databaseFromMigrations(TABLES_WITH_MORE);
      const directory = await project();

      // The diff and the plan show the four, and say that they may only be what the entities do not say.
      const dropped = ["- check users (name <> '') [users_name_check]", "- unique users (name) [users_name_key]", "- index users_active_idx on users", "~ column users.createdAt: default current_timestamp dropped"];
      const diff = await run("diff-schema", fuller, directory);
      assert.equal(diff.code, 0);
      for (const line of dropped) {
        assert.ok(diff.stdout.split("\n").includes(`  ${line}`), `${line}\n${diff.stdout}`);
      }
      const says = "It was read from TypeORM entities, which say no indexes and no unique or check constraints, and of which not every default, table, column, and key is read";
      assert.ok(diff.stderr.split("\n").includes(`Note: 4 of the changes are of what <after> does not say. ${says}: such a change may be a difference, or only what was not read.`), diff.stderr);
      const plan = await run("plan-migration", fuller, directory);
      assert.equal(plan.code, 0);
      assert.ok(plan.stderr.split("\n").includes(`Note: 4 of the steps are of what <after> does not say. ${says}: such a step may be a difference, or only what was not read.`), plan.stderr);

      const refused = await run("generate-migration", fuller, directory, "--dialect", "postgres");
      assert.deepEqual([refused.code, refused.stdout], [1, ""]);
      const lines = refused.stderr.split("\n");
      assert.match(lines[0] ?? "", new RegExp(`^Error: No migration was generated: 4 of the \\d+ steps are of what <after> does not say\\. ${escape(says)}: such a step may be a difference, or only what was not read\\.$`));
      assert.deepEqual(stepsOf(refused.stderr), [...dropped].sort());
      assert.ok(lines.includes('"diff-schema" and "plan-migration" show every difference. For SQL, compare two sides that say the same things: a project and the database that "init-nest" made of it, or two sets of entities.'), refused.stderr);
      // With --json nothing is printed either: there is no migration to say anything of. And no file is written.
      const asJson = await run("generate-migration", fuller, directory, "--dialect", "postgres", "--json");
      assert.deepEqual([asJson.code, asJson.stdout], [1, ""]);
      const out = join(await scratch(), "0002_next.sql");
      assert.equal((await run("generate-migration", fuller, directory, "--dialect", "postgres", "--out", out)).code, 1);
      assert.equal(existsSync(out), false);

      // The other way round they would be added, and are not written either.
      const reversed = await run("generate-migration", directory, fuller, "--dialect", "postgres");
      assert.deepEqual([reversed.code, reversed.stdout], [1, ""]);
      assert.match(reversed.stderr, /^Error: No migration was generated: 4 of the \d+ steps are of what <before> does not say\./);
      assert.deepEqual(stepsOf(reversed.stderr), ["+ check users (name <> '') [users_name_check]", "+ index users_active_idx on users (active)", "+ unique users (name) [users_name_key]", "~ column users.createdAt: default none -> current_timestamp"]);

      // A side that has none of them is not refused for it, and nothing is noted.
      const plain = await databaseFromMigrations(TABLES_AS_ENTITIES_SAY);
      const written = await run("generate-migration", plain, directory, "--dialect", "postgres");
      assert.doesNotMatch(written.stderr, /does not say/);
      assert.doesNotMatch((await run("diff-schema", plain, directory)).stderr, /does not say/);
    });

    it("is not written as SQL: a table that would be dropped, where the entities declare a table that was not read", async () => {
      const withJoinTable = await databaseFromMigrations(
        `${TABLES_AS_ENTITIES_SAY}\ncreate table users_categories_category ("usersId" int not null references users (id), "categoryCode" varchar not null references category (code), primary key ("usersId", "categoryCode"));`,
      );
      const directory = await project({ "src/users/user.entity.ts": USER_WITH_JOIN_TABLE });

      const diff = await run("diff-schema", withJoinTable, directory);
      assert.equal(diff.code, 0);
      assert.match(diff.stdout, /^  - table users_categories_category\b/m);
      assert.match(diff.stderr, new RegExp(`^Note: <after>: ${escape(directory)}: not read from the entities, and not part of what is compared: Many-to-many relations need a join table, which is not generated\\. \\(User\\.categories\\)$`, "m"));

      const refused = await run("generate-migration", withJoinTable, directory, "--dialect", "postgres");
      assert.deepEqual([refused.code, refused.stdout], [1, ""]);
      // After the note that says what was not read.
      assert.match(refused.stderr, /^Error: No migration was generated: 1 of the 1 step is of what <after> does not say\./m);
      assert.deepEqual(stepsOf(refused.stderr), ["- table users_categories_category"]);
    });
  });

  it("the three commands say in their help that entities are read, and how", async () => {
    for (const command of ["diff-schema", "plan-migration", "generate-migration"]) {
      const help = (await run(command, "--help")).stdout;
      assert.match(help, /TypeORM entities/, command);
    }
    const help = (await run("diff-schema", "--help")).stdout;
    assert.match(help, /TypeORM entities\s+a NestJS project \(its entities are read from the folder of its entry point\),\s+a folder of entity files, or one entity file/);
    assert.match(help, /Only files that declare an entity are loaded/);
  });
});
