import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runCli, startSandbox } from "../../cli/src/index.ts";
import { TypeormImportError, importTypeorm, toDatabaseDocument } from "../src/index.ts";
import type { ImportIssue, ImportResult, ImportedCollection, ImportedField } from "../src/index.ts";

const fixtures = join(import.meta.dirname, "fixtures");

function collection(result: ImportResult, name: string): ImportedCollection {
  const found = result.collections.find((candidate) => candidate.name === name);
  assert.ok(found, `collection ${name}`);
  return found;
}

function field(result: ImportResult, collectionName: string, name: string): ImportedField {
  const found = collection(result, collectionName).fields.find((candidate) => candidate.name === name);
  assert.ok(found, `field ${collectionName}.${name}`);
  return found;
}

function issue(result: ImportResult, entity: string, property?: string): ImportIssue[] {
  return result.issues.filter((candidate) => candidate.entity === entity && candidate.property === property);
}

describe("importTypeorm", () => {
  describe("a representative project", () => {
    let result: ImportResult;
    before(() => {
      result = importTypeorm(join(fixtures, "blog"));
    });

    it("imports each @Entity as a collection named after its table", () => {
      assert.deepEqual(
        result.collections.map((entry) => [entry.name, entry.source]).sort(),
        [
          ["post", "Post"],
          ["post_categories", "Category"],
          ["users", "User"],
        ],
      );
    });

    it("imports @PrimaryGeneratedColumn with its generation strategy", () => {
      assert.deepEqual(field(result, "users", "id"), {
        name: "id",
        type: "number",
        sourceType: "Number",
        primary: true,
        nullable: false,
        generated: "increment",
      });
      assert.deepEqual(field(result, "post", "id"), {
        name: "id",
        type: "string",
        sourceType: "uuid",
        primary: true,
        nullable: false,
        generated: "uuid",
      });
    });

    it("imports @PrimaryColumn without generation", () => {
      assert.deepEqual(field(result, "post_categories", "code"), {
        name: "code",
        type: "string",
        sourceType: "varchar",
        length: 20,
        primary: true,
        nullable: false,
      });
    });

    it("keeps what a declared type takes beyond its name: a length, and the digits of a decimal", () => {
      assert.deepEqual([field(result, "users", "email").sourceType, field(result, "users", "email").length], ["varchar", 200]);
      assert.deepEqual([field(result, "post", "price").precision, field(result, "post", "price").scale], [10, 2]);
      // A type that is declared without any has none.
      const plain = field(result, "users", "name");
      assert.deepEqual([plain.length, plain.precision, plain.scale, plain.array, plain.enumName], [undefined, undefined, undefined, undefined, undefined]);
    });

    it("imports regular columns with types from the declaration or the property type", () => {
      const types = Object.fromEntries(collection(result, "users").fields.map((entry) => [entry.name, entry.type]));
      assert.deepEqual(types, {
        id: "number",
        createdAt: "date",
        name: "string",
        email: "string",
        bio: "string",
        active: "boolean",
        loginCount: "number",
        role: "string",
        tier: "number",
        lastSeenAt: "date",
        settings: "json",
      });
      assert.equal(field(result, "users", "name").sourceType, "String");
      assert.equal(field(result, "users", "email").sourceType, "varchar");
      assert.equal(field(result, "post", "keywords").type, "array");
    });

    it("includes columns inherited from a base class, parent columns first", () => {
      assert.deepEqual(
        collection(result, "users").fields.slice(0, 3).map((entry) => entry.name),
        ["id", "createdAt", "name"],
      );
    });

    it("imports nullable", () => {
      assert.equal(field(result, "users", "bio").nullable, true);
      assert.equal(field(result, "users", "name").nullable, false);
      assert.equal(field(result, "post", "price").nullable, true);
    });

    it("imports static defaults and reports defaults that are not static", () => {
      assert.equal(field(result, "users", "active").default, true);
      assert.equal(field(result, "users", "loginCount").default, 0);
      assert.equal(field(result, "users", "role").default, "reader");
      assert.deepEqual(field(result, "users", "settings").default, { theme: "light" });
      assert.equal("default" in field(result, "users", "name"), false);

      assert.equal("default" in field(result, "users", "lastSeenAt"), false);
      assert.match(issue(result, "User", "lastSeenAt")[0]?.message ?? "", /database expression/);
      assert.equal("default" in field(result, "post", "keywords"), false);
      assert.equal(issue(result, "Post", "keywords")[0]?.kind, "unsupported");
    });

    it("imports enum values for string and numeric enums", () => {
      assert.deepEqual(field(result, "users", "role").enum, ["admin", "editor", "reader"]);
      assert.deepEqual(field(result, "users", "tier").enum, [0, 1]);
      assert.equal(field(result, "users", "tier").default, 0);
    });

    it("adds a key field for @ManyToOne using TypeORM's default join column name", () => {
      assert.deepEqual(field(result, "post", "authorId"), {
        name: "authorId",
        type: "number",
        sourceType: "Number",
        primary: false,
        nullable: false,
        references: { collection: "users", field: "id" },
      });
    });

    it("reuses an explicit key column named by @JoinColumn", () => {
      const names = collection(result, "post").fields.map((entry) => entry.name);
      assert.equal(names.filter((name) => name === "categoryCode").length, 1);
      assert.deepEqual(field(result, "post", "categoryCode"), {
        name: "categoryCode",
        type: "string",
        sourceType: "String",
        primary: false,
        nullable: true,
        references: { collection: "post_categories", field: "code" },
      });
    });

    it("adds a nullable key field for an owning @OneToOne with a custom join column", () => {
      assert.deepEqual(field(result, "post", "previous_id"), {
        name: "previous_id",
        type: "string",
        sourceType: "uuid",
        primary: false,
        nullable: true,
        references: { collection: "post", field: "id" },
      });
    });

    it("adds no field for relation properties themselves or for @OneToMany", () => {
      const users = collection(result, "users").fields.map((entry) => entry.name);
      const posts = collection(result, "post").fields.map((entry) => entry.name);
      assert.ok(!users.includes("posts"));
      assert.ok(!posts.includes("author") && !posts.includes("category") && !posts.includes("previous"));
    });

    it("reports what differs from the application, and nothing else", () => {
      assert.deepEqual(
        result.issues.map((entry) => `${entry.kind} ${entry.entity}.${entry.property ?? "*"}`).sort(),
        [
          "ambiguous Category.*",
          "ambiguous Post.price",
          "note User.*",
          "note User.createdAt",
          "unsupported Post.keywords",
          "unsupported User.lastSeenAt",
        ],
      );
      assert.match(issue(result, "Category")[0]?.message ?? "", /primary column is: code/);
      assert.match(issue(result, "Post", "price")[0]?.message ?? "", /imported as a string/);
      assert.match(issue(result, "User")[0]?.message ?? "", /not enforced/);
    });

    it("gives the same result when imported again", () => {
      assert.deepEqual(importTypeorm(join(fixtures, "blog")), result);
    });

    it("imports a single file and reports relations to entities that were not imported", () => {
      const single = importTypeorm(join(fixtures, "blog", "post.entity.ts"));
      assert.deepEqual(single.collections.map((entry) => entry.name), ["post"]);
      assert.deepEqual(field(single, "post", "authorId"), {
        name: "authorId",
        type: "unknown",
        primary: false,
        nullable: false,
      });
      assert.match(issue(single, "Post", "author")[0]?.message ?? "", /"User" was not imported/);
    });
  });

  describe("unsupported and ambiguous constructs", () => {
    let result: ImportResult;
    before(() => {
      result = importTypeorm(join(fixtures, "unsupported"));
    });

    const reported = (entity: string, property: string | undefined, kind: ImportIssue["kind"], message: RegExp): void => {
      const found = issue(result, entity, property).filter((entry) => entry.kind === kind && message.test(entry.message));
      assert.equal(found.length, 1, `${entity}.${property}: ${message}`);
    };

    it("skips entity kinds it does not support and says so", () => {
      assert.deepEqual(result.collections.map((entry) => entry.name).sort(), ["account", "membership", "tag"]);
      reported("Summary", undefined, "unsupported", /Entity kind "view"/);
      reported("Content", undefined, "unsupported", /Table inheritance/);
      reported("Photo", undefined, "unsupported", /Entity kind "entity-child"/);
      reported("legacy", undefined, "unsupported", /EntitySchema/);
    });

    it("skips unsupported properties and says so", () => {
      const names = collection(result, "account").fields.map((entry) => entry.name);
      for (const skipped of ["address", "total", "tags", "tagIds", "membership", "membershipId"]) {
        assert.ok(!names.includes(skipped), skipped);
      }
      reported("Account", "address", "unsupported", /Embedded/);
      reported("Account", "total", "unsupported", /Column kind "virtual-property"/);
      reported("Account", "tags", "unsupported", /join table/);
      reported("Account", "tagIds", "unsupported", /@RelationId/);
      reported("Account", "membership", "unsupported", /exactly one primary column/);
    });

    it("imports what it can with an unknown type instead of guessing", () => {
      for (const name of ["location", "misc"]) {
        assert.equal(field(result, "account", name).type, "unknown");
      }
      reported("Account", "location", "ambiguous", /"geometry" is not recognized/);
      reported("Account", "misc", "ambiguous", /add an explicit column type/);
      // Binary data is a type of its own, under any of its names.
      assert.deepEqual([field(result, "account", "secret").type, field(result, "account", "secret").sourceType], ["binary", "bytea"]);
      assert.equal(result.issues.some((issue) => issue.property === "secret" && /not recognized/.test(issue.message)), false);

      assert.equal("enum" in field(result, "account", "dynamic"), false);
      reported("Account", "dynamic", "ambiguous", /Enum values could not be read/);

      assert.equal(field(result, "account", "scores").type, "array");
      // An array of enum values is an array, not one enum value.
      assert.equal(field(result, "account", "colors").type, "array");
      assert.equal("enum" in field(result, "account", "colors"), false);
      // That the column is an array, and the values of its elements, are kept beside it.
      assert.deepEqual([field(result, "account", "scores").array, field(result, "account", "colors").array, field(result, "account", "colors").elementEnum], [true, true, ["red", "blue"]]);
    });

    it("keeps key fields whose target is unknown, without a reference", () => {
      assert.deepEqual(field(result, "account", "outsideId"), {
        name: "outsideId",
        type: "unknown",
        primary: false,
        nullable: true,
      });
      reported("Account", "outside", "ambiguous", /"Outside" was not imported/);
      reported("Account", "odd", "ambiguous", /Referenced column "missing"/);
    });

    it("reports behavior the sandbox does not reproduce", () => {
      reported("Account", "nickname", "unsupported", /transformer is not applied/);
      reported("Account", "secret", "note", /select: false is ignored/);
      reported("Account", undefined, "unsupported", /Lifecycle hooks/);
      reported("Account", undefined, "note", /not enforced/);
      reported("Membership", undefined, "ambiguous", /primary column is: accountId, groupId/);
    });

    it("says of each issue what of the entities' schema it leaves out, and says nothing where it leaves nothing out", () => {
      const omitted = (of: ImportResult): string[] => of.issues.filter((entry) => entry.omits !== undefined).map((entry) => `${entry.omits} ${entry.entity}.${entry.property ?? "*"}`).sort();
      // A table that is not there (a join table, an entity that was skipped); a column (embedded, or the key of a
      // relation that got none); a key whose target is not known; and the indexes and constraints of an entity.
      assert.deepEqual(omitted(result), [
        "column Account.address",
        "column Account.membership",
        "constraints Account.*",
        "key Account.odd",
        "key Account.outside",
        "table Account.tags",
        "table Content.*",
        "table Photo.*",
        "table legacy.*",
      ]);
      // Not: a view (it is no table), a property that is no column (`total`, `tagIds`), a type that is kept as it
      // was declared, and what is only about how the sandbox treats rows (a transformer, hooks, `select: false`).
      for (const [entity, property] of [["Summary", undefined], ["Account", "total"], ["Account", "tagIds"], ["Account", "location"], ["Account", "nickname"], ["Account", "secret"], ["Membership", undefined]] as const) {
        assert.deepEqual(issue(result, entity, property).filter((entry) => entry.omits !== undefined), [], `${entity}.${property}`);
      }
      // A default that is not a value, and the default a database gives a column that TypeORM fills.
      assert.deepEqual(omitted(importTypeorm(join(fixtures, "blog"))), ["constraints User.*", "default Post.keywords", "default User.createdAt", "default User.lastSeenAt"]);
    });
  });

  describe("loading", () => {
    it("imports compiled JavaScript entities without TypeScript", () => {
      const result = importTypeorm(join(fixtures, "compiled"));
      assert.deepEqual(result.collections, [
        {
          name: "things",
          source: "Thing",
          fields: [
            { name: "id", type: "number", sourceType: "Number", primary: true, nullable: false, generated: "increment" },
            { name: "label", type: "string", sourceType: "varchar", primary: false, nullable: false },
          ],
        },
      ]);
      assert.deepEqual(result.issues, []);
    });

    it("does not load files that do not look like entity files", () => {
      // fixtures/blog/helpers.ts throws when loaded.
      assert.doesNotThrow(() => importTypeorm(join(fixtures, "blog")));
    });

    it("fails clearly for a missing path", () => {
      assert.throws(() => importTypeorm(join(fixtures, "nope")), (error) => {
        assert.ok(error instanceof TypeormImportError);
        assert.match(error.message, /Path does not exist/);
        return true;
      });
    });

    it("fails clearly when no entity is found", () => {
      assert.throws(() => importTypeorm(join(fixtures, "plain")), /No importable TypeORM entities/);
      assert.throws(() => importTypeorm(join(import.meta.dirname, "../../core/src")), /No TypeORM entity files found/);
    });

    it("names the file that failed to load and why", () => {
      assert.throws(() => importTypeorm(join(fixtures, "broken")), /Failed to load .*broken\.entity\.cjs: boom/);
    });

    it("fails clearly when only unsupported entities are found, listing why", () => {
      assert.throws(() => importTypeorm(join(fixtures, "unsupported", "view.entity.ts")), (error) => {
        assert.ok(error instanceof TypeormImportError);
        assert.match(error.message, /No importable TypeORM entities/);
        assert.match(error.message, /Summary: Entity kind "view"/);
        return true;
      });
    });

    describe("a project with tsconfig path settings", () => {
      const users = {
        name: "users",
        source: "User",
        fields: [
          { name: "id", type: "number", sourceType: "Number", primary: true, nullable: false, generated: "increment" },
          { name: "role", type: "string", sourceType: "enum", primary: false, nullable: false, enum: ["admin", "member"], default: "member" },
        ],
      };

      it("resolves baseUrl imports such as src/... and paths aliases, from a folder or a single file", () => {
        // user.entity.ts imports "src/api/constants/user-role.constants" and "@shared/base".
        const file = join(fixtures, "nest", "src", "api", "entities", "user.entity.ts");
        assert.deepEqual(importTypeorm(file), { collections: [users], issues: [] });
        assert.deepEqual(importTypeorm(join(fixtures, "nest", "src", "api")), { collections: [users], issues: [] });
      });

      it("names the import and the tsconfig when an alias matches nothing", () => {
        assert.throws(() => importTypeorm(join(fixtures, "nest", "src", "broken")), (error) => {
          assert.ok(error instanceof TypeormImportError);
          assert.match(error.message, /Failed to load .*audit\.entity\.ts: Cannot find module "@missing\/audit-kinds"/);
          assert.match(error.message, /baseUrl or paths in .*nest[\\/]tsconfig\.json/);
          return true;
        });
      });
    });

    describe("a project without a tsconfig", () => {
      let dir: string;
      before(async () => {
        // Outside this repository, so that no tsconfig.json is found above the entities.
        dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-orm-"));
        await cp(join(fixtures, "no-tsconfig"), dir, { recursive: true });
        await symlink(join(import.meta.dirname, "../../../node_modules"), join(dir, "node_modules"), "junction");
      });
      after(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      it("still imports entities that use relative imports", async () => {
        await writeFile(
          join(dir, "relative.entity.ts"),
          'import { Entity, PrimaryColumn } from "typeorm";\nimport { UserRole } from "./src/user-role.constants";\n\n' +
            "@Entity()\nexport class Relative {\n  @PrimaryColumn({ type: \"enum\", enum: UserRole })\n  id!: UserRole;\n}\n",
        );
        const result = importTypeorm(join(dir, "relative.entity.ts"));
        assert.deepEqual(result.collections.map((entry) => entry.name), ["relative"]);
      });

      it("says that no tsconfig was found when an alias cannot be resolved", () => {
        assert.throws(() => importTypeorm(join(dir, "src")), (error) => {
          assert.ok(error instanceof TypeormImportError);
          assert.match(error.message, /Failed to load .*user\.entity\.ts: Cannot find module "src\/user-role\.constants"/);
          assert.match(error.message, /No tsconfig\.json was found/);
          return true;
        });
      });
    });

    describe("outside a TypeORM project", () => {
      let dir: string;
      before(async () => {
        dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-orm-"));
        await writeFile(join(dir, "user.entity.js"), 'const { Entity } = require("typeorm");\n');
      });
      after(async () => {
        await rm(dir, { recursive: true, force: true });
      });

      it("fails clearly when typeorm is not installed there", () => {
        assert.throws(() => importTypeorm(dir), /Cannot load "typeorm" from the project/);
      });
    });
  });
});

describe("toDatabaseDocument", () => {
  let result: ImportResult;
  before(() => {
    result = importTypeorm(join(fixtures, "blog"));
  });

  it("creates empty collections by default", () => {
    assert.deepEqual(toDatabaseDocument(result), {
      $meta: { version: 1 },
      data: { post_categories: [], users: [], post: [] },
    });
  });

  it("creates one fixed placeholder row per collection on request", () => {
    const document = toDatabaseDocument(result, { sampleRows: true });
    assert.deepEqual(document.data, {
      post_categories: [{ code: "1", label: "sample" }],
      users: [
        {
          id: 1,
          createdAt: "2000-01-01T00:00:00.000Z",
          name: "sample",
          email: "sample",
          bio: null,
          active: true,
          loginCount: 0,
          role: "reader",
          tier: 0,
          lastSeenAt: "2000-01-01T00:00:00.000Z",
          settings: { theme: "light" },
        },
      ],
      post: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          title: "sample",
          price: null,
          keywords: [],
          categoryCode: "1",
          authorId: 1,
          previous_id: null,
        },
      ],
    });
    assert.deepEqual(toDatabaseDocument(result, { sampleRows: true }), document);
  });
});

describe("import-typeorm command", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-import-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["import-typeorm", ...argv], {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      signals: new EventEmitter(),
    });
    return { code, stdout, stderr };
  }

  it("writes a database file that the sandbox starts and serves immediately", async () => {
    const out = join(dir, "db.json");
    const { code, stdout, stderr } = await run(join(fixtures, "blog"), "--out", out);

    assert.equal(code, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /^Imported 3 TypeORM entities from /);
    assert.match(stdout, /\n {2}users \(User\): id, createdAt, name, /);
    assert.match(stdout, /authorId -> users\.id/);
    assert.match(stdout, /\nNot imported exactly \(6\):\n/);
    assert.match(stdout, /\n {2}\[ambiguous\] Post\.price: /);
    assert.match(stdout, /\n {2}\[ambiguous\] Category: /);
    assert.ok(stdout.includes(`Wrote ${out} (empty collections).`));
    assert.ok(stdout.endsWith(`Start it with: local-db-sandbox ${out}\n`));

    assert.deepEqual(JSON.parse(await readFile(out, "utf8")), {
      $meta: { version: 1 },
      data: { post_categories: [], users: [], post: [] },
    });

    const sandbox = await startSandbox({ file: out, port: 0 });
    try {
      assert.deepEqual(await (await fetch(`${sandbox.url}/`)).json(), {
        collections: ["post_categories", "users", "post"],
      });
      assert.deepEqual(await (await fetch(`${sandbox.url}/users`)).json(), []);

      const created = await fetch(`${sandbox.url}/users`, { method: "POST", body: JSON.stringify({ name: "Patrick" }) });
      assert.equal(created.status, 201);
      assert.deepEqual(await created.json(), { id: 1, name: "Patrick" });

      await fetch(`${sandbox.url}/post`, { method: "POST", body: JSON.stringify({ title: "Hello", authorId: 1 }) });
      const posts = (await (await fetch(`${sandbox.url}/post?authorId=1`)).json()) as unknown[];
      assert.equal(posts.length, 1);
    } finally {
      await sandbox.stop();
    }
  });

  it("writes placeholder rows with --sample-rows and serves them", async () => {
    const out = join(dir, "sample.json");
    const { code, stdout } = await run(join(fixtures, "blog"), "-o", out, "--sample-rows");
    assert.equal(code, 0);
    assert.match(stdout, /one placeholder row per collection/);

    const sandbox = await startSandbox({ file: out, port: 0 });
    try {
      const user = (await (await fetch(`${sandbox.url}/users/1`)).json()) as { role: string };
      assert.equal(user.role, "reader");
    } finally {
      await sandbox.stop();
    }
  });

  it("does not overwrite an existing file unless --force is given", async () => {
    const out = join(dir, "keep.json");
    await writeFile(out, "original");

    const refused = await run(join(fixtures, "compiled"), "--out", out);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already exists\. Use --force/);
    assert.equal(await readFile(out, "utf8"), "original");

    const forced = await run(join(fixtures, "compiled"), "--out", out, "--force");
    assert.equal(forced.code, 0);
    assert.deepEqual(JSON.parse(await readFile(out, "utf8")).data, { things: [] });
    assert.doesNotMatch(forced.stdout, /Not imported exactly/);
  });

  it("reports usage and import errors without writing a file", async () => {
    const out = join(dir, "never.json");

    const help = await run("--help");
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: local-db-sandbox import-typeorm <path>/);

    const noPath = await run("--out", out);
    assert.equal(noPath.code, 1);
    assert.match(noPath.stderr, /exactly one path/);

    const missing = await run(join(fixtures, "nope"), "--out", out);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^Error: Path does not exist/);

    const none = await run(join(fixtures, "plain"), "--out", out);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /No importable TypeORM entities/);

    await assert.rejects(readFile(out, "utf8"));
  });
});
