import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { startDisposablePostgres } from "../../import-postgres/test/support/disposable-postgres.ts";
import { schemaFile } from "../../storage-json/test/support/database-files.ts";
import { runCli } from "../src/index.ts";

/*
 * Where PostgreSQL knowledge and its parser may be (CLAUDE.md, rules 4 and
 * 8a; D-034, D-036, D-037):
 *
 * - PostgreSQL's parse tree, type names, and naming rules are in
 *   packages/import-postgres. Only the CLI, which composes the packages,
 *   imports it; the runtime, the storage, the PostgREST endpoint, the
 *   schema diff, and the migration package work with the canonical schema
 *   and never reach it.
 * - How PostgreSQL's SQL is written (D-039) is in the migration package's
 *   src/postgres, and nowhere else: the rest of that package, which plans and
 *   applies diffs, knows no database, and does not reach it.
 * - The parser (libpg-query) is imported in one place, on first use, so that
 *   it is loaded when migrations are collected, and when a generated
 *   migration is checked before it is printed, and by nothing else.
 * - The client of PostgreSQL servers (postgres) is imported in one place too,
 *   on first use, in packages/import-postgres, so that it is loaded by
 *   init-pg, which reads a server's catalog, and by nothing else (D-049).
 *
 * The first is read from the sources: what each file imports, followed
 * through. That cannot see a module that is loaded under a name worked out
 * at run time, so the packages the rule names may not load anything that
 * way at all. The second is watched: the CLI is run in a process of its own
 * that records every module it resolves, however it is asked for.
 */

const PACKAGES = resolve(import.meta.dirname, "../..");
const slashes = (path: string): string => path.replaceAll("\\", "/");

/** The source files of a package, relative to `packages/`. */
function sourcesOf(name: string): string[] {
  const src = join(PACKAGES, name, "src");
  return readdirSync(src, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => slashes(join(name, "src", file)));
}

interface Imports {
  /** Files of this repository, relative to `packages/`. `erased`: an `import type`, which is gone when the file runs. */
  files: { file: string; erased: boolean }[];
  /** Modules by name. */
  modules: { name: string; erased: boolean; dynamic: boolean }[];
  /** Ways of loading a module whose name the source does not say: `import()` or `require()` of a value, and `createRequire`. */
  opaque: string[];
}

/** What a piece of TypeScript source imports, read from its syntax tree. */
function importsIn(source: string, path: string): Imports {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true);
  const found: Imports = { files: [], modules: [], opaque: [] };
  const record = (specifier: string, erased: boolean, dynamic: boolean): void => {
    if (specifier.startsWith(".")) {
      found.files.push({ file: slashes(relative(PACKAGES, resolve(dirname(path), specifier))), erased });
    } else {
      found.modules.push({ name: specifier, erased, dynamic });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text, node.importClause?.isTypeOnly === true, false);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text, node.isTypeOnly, false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      record(node.argument.literal.text, true, false);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        record(argument.text, false, true);
      } else {
        found.opaque.push(node.getText(tree).replace(/\s+/g, " ").slice(0, 60));
      }
    } else if (ts.isIdentifier(node) && node.text === "createRequire") {
      found.opaque.push("createRequire");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

function importsOf(file: string): Imports {
  const path = join(PACKAGES, file);
  const found = importsIn(readFileSync(path, "utf8"), path);
  for (const { file: target } of found.files) {
    assert.ok(existsSync(join(PACKAGES, target)), `${file} imports ${target}, which does not exist`);
  }
  return found;
}

/** Everything the given files import, directly or through what they import. `running`: without what `import type` brings. */
function reach(entries: string[], running = false): { files: Set<string>; modules: Set<string> } {
  const files = new Set<string>();
  const modules = new Set<string>();
  const queue = [...entries];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    const found = importsOf(file);
    found.modules.filter((entry) => !(running && entry.erased)).forEach((entry) => modules.add(entry.name));
    queue.push(...found.files.filter((entry) => !(running && entry.erased)).map((entry) => entry.file));
  }
  return { files, modules };
}

const packageOf = (file: string): string => file.split("/")[0] as string;
const packagesReached = (name: string, running = false): string[] => [...new Set([...reach(sourcesOf(name), running).files].map(packageOf))].sort();
/** `libpg-query`, or a file of it. */
const isParser = (name: string): boolean => /^libpg-query(\/|$)/.test(name);
/** `postgres`, the client of PostgreSQL servers, or a file of it. */
const isClient = (name: string): boolean => /^postgres(\/|$)/.test(name);
/** `@dagrejs/dagre`, the layout of Studio's ER diagram, or anything else of `@dagrejs`. */
const isLayout = (name: string): boolean => /^@dagrejs\//.test(name);

const ALL = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(PACKAGES, entry.name, "src")))
  .map((entry) => entry.name)
  .sort();
/** The packages that work with the canonical schema alone (CLAUDE.md, rule 8a), and the core below them. */
const CANONICAL_ONLY = ["core", "migration", "postgrest", "runtime", "schema-diff", "storage-json"];

describe("package boundaries: how the sources are read", () => {
  it("finds every way a module is named in a source", () => {
    const found = importsIn(
      [
        'import { a } from "./a.ts";',
        'import type { B } from "../../b/src/b.ts";',
        'export * from "./c.ts";',
        'export type { D } from "./d.ts";',
        'import parser from "libpg-query";',
        'const lazy = await import("libpg-query/wasm/index.js");',
        'const old = require("left-pad");',
        "type T = import(\"./t.ts\").T;",
        "const hidden = await import(name);",
        'const made = createRequire(import.meta.url)("libpg-query");',
        "const sql = `select * from \"users\"`;",
      ].join("\n"),
      join(PACKAGES, "x/src/x.ts"),
    );
    assert.deepEqual(found.files, [
      { file: "x/src/a.ts", erased: false },
      { file: "b/src/b.ts", erased: true },
      { file: "x/src/c.ts", erased: false },
      { file: "x/src/d.ts", erased: true },
      { file: "x/src/t.ts", erased: true },
    ]);
    assert.deepEqual(found.modules, [
      { name: "libpg-query", erased: false, dynamic: false },
      { name: "libpg-query/wasm/index.js", erased: false, dynamic: true },
      { name: "left-pad", erased: false, dynamic: true },
    ]);
    assert.deepEqual(found.opaque, ["import(name)", "createRequire"]);
    assert.deepEqual(found.modules.map((entry) => isParser(entry.name)), [true, true, false]);
  });
});

describe("package boundaries: PostgreSQL knowledge", () => {
  it("has the packages this test knows about", () => {
    for (const name of ["cli", "import-postgres", ...CANONICAL_ONLY]) {
      assert.ok(ALL.includes(name), name);
    }
  });

  it("only the CLI imports the PostgreSQL collector; no other package reaches it or its parser, however indirectly", () => {
    for (const name of ALL.filter((candidate) => candidate !== "cli" && candidate !== "import-postgres")) {
      const reached = reach(sourcesOf(name));
      assert.deepEqual([...reached.files].filter((file) => packageOf(file) === "import-postgres"), [], `${name} reaches the PostgreSQL collector`);
      assert.deepEqual([...reached.modules].filter(isParser), [], `${name} reaches the PostgreSQL parser`);
      assert.deepEqual([...reached.modules].filter(isClient), [], `${name} reaches the PostgreSQL client`);
    }
    assert.ok(packagesReached("cli").includes("import-postgres"));
  });

  it("no source names a module by a path into node_modules, or imports this package by its own name", () => {
    for (const file of ALL.flatMap(sourcesOf)) {
      const found = importsOf(file);
      assert.deepEqual(found.files.filter((entry) => entry.file.includes("node_modules")), [], file);
      assert.deepEqual(found.modules.filter((entry) => entry.name.includes("node_modules") || /^local-db-sandbox(\/|$)/.test(entry.name)), [], file);
    }
  });

  it("the packages that work with the canonical schema load no module whose name is not written in their source", () => {
    for (const name of CANONICAL_ONLY) {
      for (const file of sourcesOf(name)) {
        assert.deepEqual(importsOf(file).opaque, [], file);
      }
    }
  });

  /** What of the runtime is the canonical schema's own code, and no more: canonical types, what a text names, and the two ways an index says its keys (D-040). */
  const SCHEMA_MODEL = ["runtime/src/canonical-type.ts", "runtime/src/expression-names.ts", "runtime/src/index-definition.ts"];

  it("the schema diff depends on the canonical schema alone: when it runs, on its own files and the runtime's schema model", () => {
    assert.deepEqual([...reach(sourcesOf("schema-diff"), true).files].filter((file) => packageOf(file) !== "schema-diff").sort(), SCHEMA_MODEL);
    // And the schema model is on its own: it loads nothing.
    assert.deepEqual([...reach(SCHEMA_MODEL, true).files].sort(), SCHEMA_MODEL);
    assert.deepEqual([...reach(sourcesOf("schema-diff"), true).modules], []);
    // With what it only takes types from: the runtime's schema model, which names the core's rows.
    assert.deepEqual(packagesReached("schema-diff"), ["core", "runtime", "schema-diff"]);
    const direct = sourcesOf("schema-diff").flatMap((file) => importsOf(file).files.map((entry) => packageOf(entry.file)));
    assert.deepEqual([...new Set(direct)].sort(), ["runtime", "schema-diff"]);
  });

  it("the migration package depends on the canonical schema and the schema diff alone", () => {
    // D-038: it plans and applies diffs of canonical schemas. No collector, no parser, no storage, no HTTP, no ORM, no dialect.
    assert.deepEqual(packagesReached("migration"), ["core", "migration", "runtime", "schema-diff"]);
    const running = reach(sourcesOf("migration"), true);
    assert.deepEqual([...new Set([...running.files].map(packageOf))].sort(), ["migration", "runtime", "schema-diff"]);
    assert.deepEqual([...running.files].filter((file) => packageOf(file) === "runtime").sort(), SCHEMA_MODEL);
    assert.deepEqual([...running.modules], []);
    // And the schema diff does not know that it is planned: nothing of it reaches the migration package.
    assert.equal(packagesReached("schema-diff").includes("migration"), false);
  });

  it("within the migration package, what is PostgreSQL's is in src/postgres, and nothing else of the package reaches it", () => {
    // D-039: a diff applied to a schema, the plan, and its validator know no database.
    const isGenerator = (file: string): boolean => file.startsWith("migration/src/postgres/");
    const neutral = sourcesOf("migration").filter((file) => !isGenerator(file));
    const generator = sourcesOf("migration").filter(isGenerator);
    assert.ok(neutral.length > 0 && generator.length > 0);
    assert.deepEqual([...reach(neutral).files].filter(isGenerator), []);
    // The generator reads plans and canonical schemas, and writes text: no collector, no parser, no module of any kind.
    const reached = reach(generator, true);
    assert.deepEqual([...new Set([...reached.files].map(packageOf))].sort(), ["migration", "runtime", "schema-diff"]);
    assert.deepEqual([...reached.files].filter((file) => packageOf(file) === "runtime").sort(), SCHEMA_MODEL);
    assert.deepEqual([...reached.modules], []);
    // What it generates is checked with PostgreSQL's parser by who composes the two: the CLI.
    assert.ok(importsOf("cli/src/generate-migration-command.ts").files.some((entry) => entry.file === "import-postgres/src/sql-check.ts"));
  });

  it("the runtime, the storage, and the PostgREST endpoint reach only one another and the core", () => {
    assert.deepEqual(packagesReached("runtime"), ["core", "runtime"]);
    assert.deepEqual(packagesReached("storage-json"), ["core", "runtime", "storage-json"]);
    assert.deepEqual(packagesReached("postgrest"), ["core", "postgrest", "runtime", "storage-json"]);
  });

  it("the collector reaches the runtime's schema model and nothing that stores, serves, or compares", () => {
    assert.deepEqual(packagesReached("import-postgres"), ["core", "import-postgres", "runtime"]);
  });
});

/*
 * Local DB Studio (D-042). The access to a runtime, and the control that
 * serves it to other processes, are a package of their own, which knows the
 * runtime, the storage's record of who has a database, and the statement
 * splitter of the SQL console, and nothing above them. Studio is its page
 * and its session on top of that access: it has no way to a database of its
 * own, and nothing that serves an application knows of it.
 */
describe("package boundaries: Local DB Studio", () => {
  it("has the packages this test knows about", () => {
    for (const name of ["runtime-access", "studio"]) {
      assert.ok(ALL.includes(name), name);
    }
  });

  it("the access to a runtime reaches the runtime, the storage, and the SQL console's splitter, and no adapter", () => {
    assert.deepEqual(packagesReached("runtime-access"), ["core", "runtime", "runtime-access", "sql-console", "storage-json"]);
    // Of the SQL console it takes how statements are told apart, and executes nothing through it.
    const fromConsole = sourcesOf("runtime-access").flatMap((file) => importsOf(file).files.filter((entry) => packageOf(entry.file) === "sql-console" && !entry.erased).map(() => file));
    assert.deepEqual(fromConsole, ["runtime-access/src/local-access.ts"]);
    for (const file of sourcesOf("runtime-access")) {
      assert.deepEqual(importsOf(file).opaque, [], file);
      assert.deepEqual(importsOf(file).modules.filter((entry) => !entry.name.startsWith("node:")), [], file);
    }
  });

  it("Studio reaches a database through the access alone: it imports no runtime, and nothing that serves an application", () => {
    assert.deepEqual(packagesReached("studio"), ["core", "runtime", "runtime-access", "sql-console", "storage-json", "studio"]);
    // What its own files import, to run: the access, the storage's record of the owner, and the one function that opens a database on the runtime.
    const direct = sourcesOf("studio").flatMap((file) => importsOf(file).files.filter((entry) => !entry.erased).map((entry) => packageOf(entry.file)));
    assert.deepEqual([...new Set(direct)].sort(), ["runtime-access", "sql-console", "storage-json", "studio"]);
    for (const file of sourcesOf("studio")) {
      assert.deepEqual(importsOf(file).opaque, [], file);
      // No framework, and no library: Node, and nothing else; but for the layout of the ER diagram, on first use (D-053, below).
      assert.deepEqual(importsOf(file).modules.filter((entry) => !entry.name.startsWith("node:") && !(file === "studio/src/diagram.ts" && entry.name === "@dagrejs/dagre" && entry.dynamic)), [], file);
    }
  });

  it("only the CLI knows of Studio; the processes that own a database know the access, and not who looks through it", () => {
    for (const name of ALL.filter((candidate) => candidate !== "cli" && candidate !== "studio")) {
      assert.deepEqual([...reach(sourcesOf(name)).files].filter((file) => packageOf(file) === "studio"), [], `${name} reaches Studio`);
    }
    assert.ok(packagesReached("cli").includes("studio"));
    // The runtime, the storage, and the PostgREST package do not know the access either (asserted above by what they reach).
    // The NestJS sandbox serves its runtime itself, so it does; the PostgREST endpoint is served by the command that starts it.
    assert.ok(packagesReached("nest-typeorm").includes("runtime-access"));
    assert.equal(packagesReached("postgrest").includes("runtime-access"), false);
    assert.ok(importsOf("cli/src/postgrest-command.ts").files.some((entry) => entry.file === "runtime-access/src/index.ts"));
  });
});

describe("package boundaries: the client of PostgreSQL servers", () => {
  it("is named by one source file, once, in an import() that runs on first use, in the package that reads PostgreSQL", () => {
    const naming = ALL.flatMap(sourcesOf).flatMap((file) =>
      importsOf(file)
        .modules.filter((entry) => isClient(entry.name))
        .map((entry) => ({ file, ...entry })),
    );
    assert.deepEqual(naming, [{ file: "import-postgres/src/pg-client.ts", name: "postgres", erased: false, dynamic: true }]);
  });
});

describe("package boundaries: the layout of the ER diagram", () => {
  it("is named by one source file, once, in an import() that runs on first use, in Studio (D-053)", () => {
    const naming = ALL.flatMap(sourcesOf).flatMap((file) =>
      importsOf(file)
        .modules.filter((entry) => isLayout(entry.name))
        .map((entry) => ({ file, ...entry })),
    );
    assert.deepEqual(naming, [{ file: "studio/src/diagram.ts", name: "@dagrejs/dagre", erased: false, dynamic: true }]);
  });
});

describe("package boundaries: the PostgreSQL parser", () => {
  it("is named by one source file, once, in an import() that runs on first use", () => {
    const naming = ALL.flatMap(sourcesOf).flatMap((file) =>
      importsOf(file)
        .modules.filter((entry) => isParser(entry.name))
        .map((entry) => ({ file, ...entry })),
    );
    assert.deepEqual(naming, [{ file: "import-postgres/src/parser.ts", name: "libpg-query", erased: false, dynamic: true }]);
  });

  describe("at run time", { timeout: 120_000 }, () => {
    let dir: string;
    let database: string;
    let plainFile: string;
    let migrations: string;

    /*
     * Runs steps in a new Node process that records every module it resolves,
     * and says after each step whether the parser has been resolved by then,
     * under whatever name. A step is a command line for the CLI, or a
     * database to serve and stop. A command that serves until it is
     * interrupted is interrupted as soon as it listens for that.
     */
    const PROBE = `
import { registerHooks } from "node:module";
import { PassThrough } from "node:stream";
const resolved = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    resolved.push(result.url);
    return result;
  },
});
const [entry, steps] = JSON.parse(process.argv[2]);
const library = await import(entry);
const report = [];
for (const step of steps) {
  let code = 0;
  if (step.cli !== undefined) {
    const stdin = new PassThrough();
    stdin.end("");
    const signals = { once: (_name, listener) => setImmediate(listener), off() {} };
    code = await library.runCli(step.cli, { stdout: { write() {} }, stderr: { write() {} }, signals, stdin });
  } else {
    const sandbox = await library.startPostgrestSandbox({ database: step.serve, port: 0, save: false });
    await sandbox.stop();
  }
  report.push({ code, parser: resolved.some((url) => url.includes("libpg-query")), client: resolved.some((url) => url.includes("/node_modules/postgres/")) });
}
console.log(JSON.stringify(report));
`;

    type Step = { cli: string[] } | { serve: string };

    async function probe(steps: Step[]): Promise<{ code: number; parser: boolean; client: boolean }[]> {
      const script = join(dir, "probe.mjs");
      writeFileSync(script, PROBE);
      const entry = pathToFileURL(join(PACKAGES, "cli/src/index.ts")).href;
      const { stdout } = await promisify(execFile)(process.execPath, [script, JSON.stringify([entry, steps])], { cwd: dir });
      return JSON.parse(stdout);
    }

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-boundaries-"));
      migrations = join(dir, "migrations");
      mkdirSync(migrations);
      writeFileSync(join(migrations, "0001_init.sql"), "create table notes (id serial primary key, body text not null);");
      database = join(dir, "sandbox.db");
      plainFile = join(dir, "plain.db.json");
      writeFileSync(plainFile, JSON.stringify({ data: { users: [{ id: 1 }] } }));
      // Made here, in this process: the processes that are watched start with a database that exists.
      const io = { stdout: { write: () => undefined }, stderr: { write: () => undefined }, signals: { once: () => undefined, off: () => undefined } };
      assert.equal(await runCli(["init", migrations, "--out", database], io), 0);
    });

    after(async () => {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it("is not loaded by importing the package, nor by any command that collects no migrations", async () => {
      const steps: [Step, number][] = [
        [{ cli: ["--help"] }, 0],
        [{ cli: ["--version"] }, 0],
        [{ cli: ["init", "--help"] }, 0],
        [{ cli: ["diff-schema", "--help"] }, 0],
        [{ cli: ["plan-migration", "--help"] }, 0],
        [{ cli: ["generate-migration", "--help"] }, 0],
        [{ cli: ["import-typeorm", "--help"] }, 0],
        [{ cli: ["init-nest", "--help"] }, 0],
        [{ cli: ["init-pg", "--help"] }, 0],
        [{ cli: ["studio", "--help"] }, 0],
        [{ cli: ["inspect", database] }, 0],
        [{ cli: ["migrate", database, "--dry-run"] }, 0],
        [{ cli: ["sql", database, "select count(*) from notes", "--read-only"] }, 0],
        [{ cli: ["convert", plainFile, "--out", join(dir, "converted.db")] }, 0],
        // No sandbox is capturing mail here: the command says so and exits with 1.
        [{ cli: ["mail", "list"] }, 1],
        // A schema diff of databases and schema files reads stored definitions: no migrations, no parser.
        [{ cli: ["diff-schema", database, database] }, 0],
        [{ cli: ["diff-schema", database, schemaFile(database), "--json"] }, 0],
        // The plan of a diff is made from the two schemas alone.
        [{ cli: ["plan-migration", database, schemaFile(database), "--json"] }, 0],
        // A migration without statements has nothing to give to the parser.
        [{ cli: ["generate-migration", database, schemaFile(database), "--dialect", "postgres"] }, 0],
        // The two commands that serve: started, and stopped as soon as they wait for a signal.
        [{ cli: [plainFile, "--port", "0", "--quiet"] }, 0],
        [{ cli: ["postgrest", database, "--port", "0", "--no-save", "--quiet"] }, 0],
        [{ serve: database }, 0],
        // Studio, on a directory it has to itself and on a single file it reads: it looks into a database, and collects nothing.
        [{ cli: ["studio", database, "--port", "0"] }, 0],
        [{ cli: ["studio", plainFile, "--port", "0"] }, 0],
      ];
      const report = await probe(steps.map(([step]) => step));
      assert.deepEqual(
        report.map((entry, index) => ({ step: steps[index]?.[0], ...entry })),
        steps.map(([step, code]) => ({ step, code, parser: false, client: false })),
      );
    });

    it("is loaded when migrations are collected: by init, and by a schema diff that is given migrations", async () => {
      assert.deepEqual(await probe([{ cli: ["diff-schema", database, database] }, { cli: ["diff-schema", migrations, database] }]), [
        { code: 0, parser: false, client: false },
        { code: 0, parser: true, client: false },
      ]);
      assert.deepEqual(await probe([{ cli: ["inspect", database] }, { cli: ["init", migrations, "--out", join(dir, "again.db")] }]), [
        { code: 0, parser: false, client: false },
        { code: 0, parser: true, client: false },
      ]);
    });

    it("is loaded when a migration was generated: what is printed has been given to PostgreSQL's own parser", async () => {
      // The database's own definitions, with one column more: no migrations are collected for either side.
      const document = JSON.parse(readFileSync(schemaFile(database), "utf8"));
      document.tables[0].columns.push({ ...document.tables[0].columns[1], column: "more", nullable: true });
      const changed = join(dir, "changed.schema.json");
      writeFileSync(changed, JSON.stringify(document));
      assert.deepEqual(await probe([{ cli: ["plan-migration", database, changed, "--json"] }, { cli: ["generate-migration", database, changed, "--dialect", "postgres"] }]), [
        { code: 0, parser: false, client: false },
        { code: 0, parser: true, client: false },
      ]);
    });

    it("the client of PostgreSQL servers is loaded by init-pg alone, which also collects with the parser what it read", async () => {
      const server = await startDisposablePostgres("create table notes (id serial primary key, body text not null);");
      try {
        assert.deepEqual(await probe([{ cli: ["inspect", database] }, { cli: ["init-pg", server.url, "--out", join(dir, "scanned.db")] }]), [
          { code: 0, parser: false, client: false },
          { code: 0, parser: true, client: true },
        ]);
      } finally {
        await server.stop();
      }
    });
  });
});
