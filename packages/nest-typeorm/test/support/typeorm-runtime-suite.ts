import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { SandboxLimitError } from "../../../core/src/index.ts";
import { SandboxDialectUnsupportedError, SandboxParameterError, formatSqlEvent } from "../../../runtime/src/index.ts";
import type { SqlEvent } from "../../../runtime/src/index.ts";
import { createDatabase } from "../../../storage-json/src/index.ts";
import { databaseFiles } from "../../../storage-json/test/support/database-files.ts";
import { createSandboxDataSource, isSandboxDataSource } from "../../src/index.ts";
import type { TypeormSandbox } from "../../src/index.ts";
import { compileDecorators } from "./decorators.ts";

const SEED_AUTHOR = {
  id: 7,
  name: "Seed",
  score: 2,
  bio: null,
  lastSeenAt: "2026-01-02T03:04:05.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
};

/**
 * Defines the tests of TypeORM on the relational runtime for one installed
 * TypeORM package, and returns that package's version.
 *
 * TypeORM itself runs here: its repositories, entity manager, transactions,
 * and QueryBuilder generate SQL for its SQLite dialect, and the sandbox's
 * relational runtime executes that SQL. Nothing of TypeORM is emulated.
 *
 * Everything goes through the installed package named `packageName`: the
 * fixture entities are decorated with it and the DataSource is created from
 * it, as in an application that has that version installed. A test file must
 * call this once, because TypeORM keeps decorator metadata per process.
 */
export async function typeormRuntimeSuite(packageName: string): Promise<string> {
  const require = createRequire(import.meta.url);
  const typeorm = require(packageName);
  const { version } = JSON.parse(readFileSync(join(dirname(require.resolve(packageName)), "package.json"), "utf8")) as { version: string };

  const fixtures = join(import.meta.dirname, "..", "fixtures");
  compileDecorators(fixtures, { typeorm: packageName });
  // Specifiers are computed so that the type checker does not follow them into decorator code.
  const load = (name: string): Promise<any> => import(pathToFileURL(join(fixtures, "entities", name)).href);
  const { Author, Country, Token, Ticket, Membership, Summary, UserAbilityRule } = await load("entities.ts");
  const { Event } = await load("postgres.ts");

  describe(`TypeORM ${version} on the relational runtime`, () => {
    let dir: string;
    let file: string;
    let sandbox: TypeormSandbox;
    let authors: any;
    let events: SqlEvent[];

    const stored = async (collection: string): Promise<Record<string, any>[]> => JSON.parse(await readFile(file, "utf8")).data[collection];
    const statements = (): string[] => events.map((event) => event.sql);
    const open = (options: object = {}): Promise<TypeormSandbox> =>
      createSandboxDataSource({ typeorm, file, entities: [Author, Country, Token, Ticket, Membership, UserAbilityRule, Event], ...options });

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-typeorm-"));
      file = join(dir, "sandbox.db.json");
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
      await writeFile(file, JSON.stringify({ $meta: { version: 1 }, $config: { server: { port: 4999 } }, data: { authors: [SEED_AUTHOR] } }));
      sandbox = await open();
      authors = sandbox.dataSource.getRepository(Author);
      events = [];
      sandbox.runtime.subscribe((event) => events.push(event));
    });

    describe("startup", () => {
      it("gives a real TypeORM DataSource, initialized by TypeORM's own SQLite driver on the runtime", () => {
        assert.ok(sandbox.dataSource instanceof typeorm.DataSource);
        assert.equal(sandbox.dataSource.isInitialized, true);
        assert.ok(authors instanceof typeorm.Repository);
        assert.equal(sandbox.dataSource.options.type, "better-sqlite3");
        assert.equal(isSandboxDataSource(sandbox.dataSource), true);
        assert.deepEqual(sandbox.warnings, []);
      });

      it("creates a table per entity from the imported metadata and loads the JSON fixture into it", async () => {
        const tables = sandbox.runtime.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").rows;
        assert.deepEqual(tables.map((row) => row.name), ["authors", "country", "events", "membership", "ticket", "tokens", "user_ability_rule"]);
        assert.deepEqual(sandbox.runtime.execute("SELECT id, name, lastSeenAt FROM authors").rows, [{ id: 7, name: "Seed", lastSeenAt: "2026-01-02 03:04:05.000" }]);

        const seed = await authors.findOneBy({ id: 7 });
        assert.ok(seed instanceof Author);
        assert.deepEqual(seed.lastSeenAt, new Date("2026-01-02T03:04:05.000Z"));
        assert.equal(seed.bio, null);
      });

      it("closes the runtime when the DataSource is destroyed", async () => {
        await sandbox.dataSource.destroy();
        assert.equal(sandbox.dataSource.isInitialized, false);
        assert.throws(() => sandbox.runtime.execute("SELECT 1"));
      });

      it("reports entities the runtime has no table for", async () => {
        const withView = await open({ entities: [Author, Summary], persistence: "memory" });
        assert.equal(withView.warnings.length, 1);
        assert.match(withView.warnings[0] as string, /^Summary: the sandbox has no table "summary"\. Entity kind "view" is not supported/);
      });

      it("refuses a column type that has no SQLite counterpart", async () => {
        const { Place } = await load("unsupported-type.ts");
        await assert.rejects(open({ entities: [Place] }), (error) => {
          assert.ok(error instanceof SandboxDialectUnsupportedError, String(error));
          assert.match(error.message, /Data type "geometry" in "Place\.location" is not supported by "better-sqlite3" database\. The sandbox maps common PostgreSQL and MySQL column types/);
          return true;
        });
      });
    });

    describe("repository create, read, update, delete", () => {
      it("runs SQL generated by TypeORM on SQLite and saves committed changes to the JSON file", async () => {
        const ada = await authors.save(authors.create({ name: "Ada" }));
        // AUTOINCREMENT continues after the largest key in the fixture.
        assert.deepEqual([ada.id, ada.score, ada.bio, ada.version], [8, 0, null, 1]);
        assert.ok(ada.createdAt instanceof Date);
        assert.ok(statements().some((sql) => /^INSERT INTO "authors"\s*\(/.test(sql)), statements().join("\n"));
        assert.deepEqual(statements().filter((sql) => /^(BEGIN|COMMIT)/.test(sql)), ["BEGIN TRANSACTION", "COMMIT"]);

        assert.deepEqual(await stored("authors"), [
          SEED_AUTHOR,
          { id: 8, name: "Ada", score: 0, bio: null, lastSeenAt: null, createdAt: ada.createdAt.toISOString(), updatedAt: ada.updatedAt.toISOString(), version: 1 },
        ]);
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")).$config, { server: { port: 4999 } });

        assert.deepEqual((await authors.find({ where: { score: 0 }, order: { name: "ASC" } })).map((author: any) => author.name), ["Ada"]);
        assert.equal(await authors.count(), 2);

        assert.equal((await authors.update(8, { score: 5 })).affected, 1);
        assert.deepEqual((await stored("authors"))[1]?.score, 5);
        assert.equal((await stored("authors"))[1]?.version, 2);

        assert.equal((await authors.delete(8)).affected, 1);
        assert.deepEqual(await stored("authors"), [SEED_AUTHOR]);
        assert.equal(await authors.findOneBy({ id: 8 }), null);
      });

      it("supports find options that the hand-written repository did not", async () => {
        await authors.save([{ name: "Ada", score: 5 }, { name: "Bo", score: 9 }]);
        const found = await authors.find({ where: [{ score: typeorm.MoreThan(4) }, { name: typeorm.In(["Seed"]) }], select: { name: true }, order: { name: "DESC" } });
        assert.deepEqual(found.map((author: any) => author.name), ["Seed", "Bo", "Ada"]);
        assert.equal(await authors.countBy({ bio: typeorm.IsNull() }), 3);
      });

      it("keeps changes in memory only when persistence is off", async () => {
        const memory = await open({ persistence: "memory" });
        await memory.dataSource.getRepository(Author).save({ name: "Temporary" });
        assert.equal(await memory.dataSource.getRepository(Author).count(), 2);
        assert.deepEqual(await stored("authors"), [SEED_AUTHOR]);
      });

      it("reads back what was saved after the file is opened again", async () => {
        await authors.save({ name: "Ada", lastSeenAt: new Date("2026-03-04T05:06:07.000Z") });
        await sandbox.dataSource.destroy();

        const reopened = await open();
        const ada = await reopened.dataSource.getRepository(Author).findOneBy({ name: "Ada" });
        assert.deepEqual([ada.id, ada.lastSeenAt.toISOString()], [8, "2026-03-04T05:06:07.000Z"]);
      });

      it("gives a single file that carries table definitions the tables as the runtime has them: it has no place for what the columns are in the entities' database", async () => {
        await sandbox.dataSource.destroy();
        const carried = [{ name: "country", columns: [{ name: "code", type: "text" as const, nullable: false, primary: true }, { name: "name", type: "text" as const, nullable: false, primary: false }] }];
        await createDatabase(file, { collections: { authors: [SEED_AUTHOR] }, schema: carried }, { overwrite: true });

        const opened = await open();
        // A save would be refused for definitions that a single file cannot store.
        await opened.dataSource.getRepository(Country).save({ code: "pt", name: "Portugal" });
        const document = JSON.parse(await readFile(file, "utf8"));
        assert.deepEqual(document.data.country, [{ code: "pt", name: "Portugal" }]);
        const tables = document.$tableSchema.tables as { name: string; columns: Record<string, unknown>[] }[];
        assert.deepEqual(tables.map((table) => table.name).sort(), ["authors", "country", "events", "membership", "ticket", "tokens", "user_ability_rule"]);
        assert.deepEqual(tables.flatMap((table) => table.columns).filter((column) => "canonicalType" in column), []);
        assert.equal(document.$tableSchema.types, undefined);
      });
    });

    describe("primary keys that are not named id", () => {
      it("uses the entity's own key columns", async () => {
        const countries = sandbox.dataSource.getRepository(Country);
        await countries.save({ code: "pt", name: "Portugal" });
        await countries.save({ code: "pt", name: "Portuguese Republic" });
        await countries.insert({ code: "jp", name: "Japan" });
        assert.deepEqual(await stored("country"), [
          { code: "pt", name: "Portuguese Republic" },
          { code: "jp", name: "Japan" },
        ]);
        await assert.rejects(countries.insert({ code: "jp", name: "Again" }), /UNIQUE constraint failed: country\.code/);
        await countries.delete("pt");
        assert.deepEqual((await stored("country")).map((row) => row.code), ["jp"]);

        const tickets = sandbox.dataSource.getRepository(Ticket);
        const saved = await tickets.save([{ title: "one" }, { title: "two" }]);
        assert.deepEqual(saved.map((ticket: any) => ticket.number), [1, 2]);
        assert.deepEqual((await stored("ticket"))[1], { number: 2, title: "two", authorId: null });

        const token = await sandbox.dataSource.getRepository(Token).save({ label: "x" });
        assert.match(token.uuid, /^[0-9a-f-]{36}$/);
        assert.deepEqual(await stored("tokens"), [{ uuid: token.uuid, label: "x" }]);
      });

      it("supports a composite primary key", async () => {
        const memberships = sandbox.dataSource.getRepository(Membership);
        await memberships.save([{ accountId: 1, groupId: 1 }, { accountId: 1, groupId: 2 }]);
        assert.equal(await memberships.countBy({ accountId: 1 }), 2);
        await memberships.delete({ accountId: 1, groupId: 1 });
        assert.deepEqual(await stored("membership"), [{ accountId: 1, groupId: 2 }]);
      });
    });

    describe("DataSource.transaction", () => {
      it("commits several writes together in one SQLite transaction", async () => {
        const result = await sandbox.dataSource.transaction(async (manager: any) => {
          const author = await manager.save(Author, { name: "Ada" });
          await manager.getRepository(Ticket).save({ title: "first", authorId: author.id });
          await manager.update(Author, { id: 7 }, { score: 3 });
          // Nothing is saved, and nothing is visible in the file, before the commit.
          assert.equal((await stored("authors")).length, 1);
          assert.equal(sandbox.runtime.inTransaction, true);
          return author.id;
        });

        assert.equal(result, 8);
        assert.equal(sandbox.runtime.inTransaction, false);
        assert.deepEqual(statements().filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql)), ["BEGIN TRANSACTION", "COMMIT"]);
        assert.deepEqual((await stored("authors")).map((row) => [row.id, row.name, row.score]), [[7, "Seed", 3], [8, "Ada", 0]]);
        assert.deepEqual(await stored("ticket"), [{ number: 1, title: "first", authorId: 8 }]);
      });

      it("rolls back every write when the callback fails, leaving the runtime and the file unchanged", async () => {
        const before = await readFile(file, "utf8");
        await assert.rejects(
          sandbox.dataSource.transaction(async (manager: any) => {
            await manager.save(Author, { name: "Ada" });
            await manager.delete(Author, { id: 7 });
            assert.equal(await manager.count(Author), 1);
            throw new Error("changed my mind");
          }),
          /changed my mind/,
        );

        assert.deepEqual(statements().filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql)), ["BEGIN TRANSACTION", "ROLLBACK"]);
        assert.equal(await readFile(file, "utf8"), before);
        assert.deepEqual((await authors.find()).map((author: any) => author.name), ["Seed"]);
        // A failing statement inside the transaction rolls it back as well.
        await assert.rejects(
          sandbox.dataSource.transaction(async (manager: any) => {
            await manager.save(Country, { code: "pt", name: "Portugal" });
            await manager.insert(Author, { id: 7, name: "Duplicate" });
          }),
          /UNIQUE constraint failed: authors\.id/,
        );
        assert.equal(await sandbox.dataSource.getRepository(Country).count(), 0);
        assert.equal(await readFile(file, "utf8"), before);
      });

      it("refuses a commit that would take the file above the size limit", async () => {
        const limited = await open({ maxFileSizeMb: 0.002 });
        const before = await readFile(file, "utf8");
        await assert.rejects(limited.dataSource.getRepository(Author).save({ name: "x".repeat(4000) }), (error: any) => {
          assert.ok(error.driverError instanceof SandboxLimitError, String(error));
          return true;
        });
        assert.equal(await readFile(file, "utf8"), before);
        assert.equal(limited.runtime.inTransaction, false);
        assert.equal(await limited.dataSource.getRepository(Author).count(), 1);
      });
    });

    describe("QueryBuilder and raw SQL", () => {
      beforeEach(async () => {
        await authors.save([{ name: "Ada", score: 5 }, { name: "Bo", score: 9 }]);
        await sandbox.dataSource.getRepository(Ticket).save([{ title: "t1", authorId: 8 }, { title: "t2", authorId: 8 }, { title: "t3", authorId: null }]);
        events.length = 0;
      });

      it("executes the SQL that QueryBuilder generates", async () => {
        const found = await authors.createQueryBuilder("author").where("author.score >= :min", { min: 5 }).orderBy("author.name", "DESC").getMany();
        assert.deepEqual(found.map((author: any) => author.name), ["Bo", "Ada"]);
        assert.equal(events.length, 1);
        assert.match(events[0]?.sql ?? "", /^SELECT "author"\."id" AS "author_id".* FROM "authors" "author" WHERE "author"\."score" >= 5 ORDER BY "author"\."name" DESC$/);
        assert.equal(events[0]?.rows, 2);

        const totals = await authors.createQueryBuilder("author").select("SUM(author.score)", "total").addSelect("COUNT(*)", "count").getRawOne();
        assert.deepEqual(totals, { total: 16, count: 3 });

        const updated = await authors.createQueryBuilder().update().set({ bio: "busy" }).where("score > :min", { min: 4 }).execute();
        assert.equal(updated.affected, 2);
        assert.deepEqual((await stored("authors")).map((row) => row.bio), [null, "busy", "busy"]);
      });

      it("joins tables and loads relations through SQL", async () => {
        const tickets = await sandbox.dataSource
          .getRepository(Ticket)
          .createQueryBuilder("ticket")
          .innerJoinAndSelect("ticket.author", "author")
          .where("author.name = :name", { name: "Ada" })
          .orderBy("ticket.number")
          .getMany();
        assert.deepEqual(tickets.map((ticket: any) => [ticket.title, ticket.author.name]), [["t1", "Ada"], ["t2", "Ada"]]);
        assert.ok(tickets[0].author instanceof Author);

        const withRelation = await sandbox.dataSource.getRepository(Ticket).find({ relations: { author: true }, order: { number: "ASC" } });
        assert.deepEqual(withRelation.map((ticket: any) => ticket.author?.name ?? null), ["Ada", "Ada", null]);
      });

      it("enforces the foreign key that the relation declares", async () => {
        await assert.rejects(sandbox.dataSource.getRepository(Ticket).save({ title: "orphan", authorId: 99 }), /FOREIGN KEY constraint failed/);
        await assert.rejects(authors.delete(8), /FOREIGN KEY constraint failed/);
      });

      it("executes raw SQL that SQLite understands, with and without parameters", async () => {
        assert.deepEqual(await sandbox.dataSource.query("SELECT name FROM authors WHERE score > ? ORDER BY name", [4]), [{ name: "Ada" }, { name: "Bo" }]);
        assert.deepEqual(await sandbox.dataSource.query("SELECT COUNT(*) AS n FROM authors"), [{ n: 3 }]);
      });

      it("fails clearly for SQL of another dialect instead of approximating it", async () => {
        const unsupported = (message: RegExp) => (error: unknown): boolean => {
          assert.ok(error instanceof SandboxDialectUnsupportedError, String(error));
          assert.match(error.message, message);
          return true;
        };
        await assert.rejects(sandbox.dataSource.query("SELECT now()::date AS today"), unsupported(/SQLite cannot run this statement/));
        await assert.rejects(
          authors.createQueryBuilder("author").where("author.name ILIKE :name", { name: "a%" }).getMany(),
          unsupported(/near "ILIKE": syntax error\. The sandbox runs SQL on embedded SQLite and does not translate/),
        );
        await assert.rejects(sandbox.dataSource.query("SELECT * FROM authors FOR UPDATE SKIP LOCKED"), unsupported(/syntax error/));
        assert.deepEqual(events.map((event) => event.errorCode), ["SANDBOX_DIALECT_UNSUPPORTED", "SANDBOX_DIALECT_UNSUPPORTED", "SANDBOX_DIALECT_UNSUPPORTED"]);
        // The runtime is still usable afterwards.
        assert.equal(await authors.count(), 3);
      });
    });

    /*
     * Regression test for a failure seen in a real application that is written
     * for PostgreSQL:
     *
     *   repository.query('SELECT ... FROM "user_ability_rule" "uar" WHERE "uar"."userId" = $1', [userId])
     *   -> column index out of range
     *
     * TypeORM hands SQL given to `query` to the driver as it is, so `$1` and
     * the parameter array arrive at the runtime unchanged. Every statement
     * here goes through `DataSource.query` or `Repository.query` and TypeORM's
     * own better-sqlite3 query runner.
     */
    describe("raw SQL with PostgreSQL-style positional parameters", () => {
      const ABILITY_SQL = `SELECT
        "uar"."action" as "action",
        "uar"."subject" as "subject"
      FROM "user_ability_rule" "uar"
      WHERE "uar"."userId" = $1`;
      /** A failure of the runtime, which TypeORM passes on as it is when the statement is compiled and as `driverError` when it is executed. */
      const cause = (error: any): unknown => error.driverError ?? error;
      const refused = (message: RegExp) => (error: unknown): boolean => {
        assert.ok(cause(error) instanceof SandboxParameterError, String(error));
        assert.match((cause(error) as Error).message, message);
        return true;
      };
      const query = (sql: string, parameters?: unknown[]): Promise<Record<string, unknown>[]> => sandbox.dataSource.query(sql, parameters);

      beforeEach(async () => {
        await sandbox.dataSource.getRepository(UserAbilityRule).save([
          { userId: 1, action: "read", subject: "Order" },
          { userId: 1, action: "update", subject: "Order" },
          { userId: 2, action: "read", subject: "$1" },
          { userId: null, action: "manage", subject: "all" },
        ]);
        events.length = 0;
      });

      it("runs the application's query, through DataSource.query and through Repository.query", async () => {
        const expected = [{ action: "read", subject: "Order" }, { action: "update", subject: "Order" }];
        assert.deepEqual(await sandbox.dataSource.query(ABILITY_SQL, [1]), expected);
        assert.deepEqual(await authors.query(ABILITY_SQL, [1]), expected);
        assert.deepEqual(await sandbox.dataSource.manager.query(ABILITY_SQL, [2]), [{ action: "read", subject: "$1" }]);
        assert.deepEqual(await sandbox.dataSource.transaction((manager: any) => manager.query(ABILITY_SQL, [3])), []);
      });

      it("binds each placeholder to the parameter of its number, in any order and as often as it appears", async () => {
        const rules = 'SELECT "action", "subject" FROM "user_ability_rule"';
        assert.deepEqual(await query(`${rules} WHERE "userId" = $1 AND "action" = $2`, [1, "update"]), [{ action: "update", subject: "Order" }]);
        assert.deepEqual(await query(`${rules} WHERE "action" = $2 AND "userId" = $1`, [1, "update"]), [{ action: "update", subject: "Order" }]);
        assert.deepEqual(await query(`${rules} WHERE "action" = $1 OR "subject" = $1 ORDER BY "id"`, ["all"]), [{ action: "manage", subject: "all" }]);
        assert.deepEqual(await query(`${rules} WHERE "userId" IN ($1, $2) AND "action" <> $3 AND "subject" = $4 ORDER BY "id" LIMIT $5`, [1, 2, "update", "Order", 5]), [
          { action: "read", subject: "Order" },
        ]);
        assert.deepEqual(await query('UPDATE "user_ability_rule" SET "subject" = $2 WHERE "userId" = $1 AND "action" = $3 RETURNING "subject"', [1, "Invoice", "read"]), [{ subject: "Invoice" }]);
        assert.deepEqual((await stored("user_ability_rule")).map((row) => row.subject), ["Invoice", "Order", "$1", "all"]);
      });

      it("takes $N inside a string or a comment as text", async () => {
        assert.deepEqual(await query('SELECT "action" FROM "user_ability_rule" WHERE "subject" = \'$1\''), [{ action: "read" }]);
        assert.deepEqual(await query('SELECT "action" FROM "user_ability_rule" WHERE "subject" = \'$1\' AND "userId" = $1 -- not $2', [2]), [{ action: "read" }]);
        assert.deepEqual(await query('SELECT /* $2 */ "action" AS "$3" FROM "user_ability_rule" WHERE "userId" = $1 AND "action" = \'update\'', [1]), [{ $3: "update" }]);
      });

      it("refuses a placeholder without a parameter instead of binding NULL", async () => {
        await assert.rejects(query(`${ABILITY_SQL} AND "uar"."action" = $3`, [1, "read"]), refused(/^The statement uses \$3, but 2 parameters were given\./));
        await assert.rejects(query(ABILITY_SQL), refused(/uses \$1, but no parameters were given/));
        await assert.rejects(query(ABILITY_SQL, [1, 2]), refused(/^2 parameters were given, but the statement uses none after \$1\./));
        await assert.rejects(query(`${ABILITY_SQL} AND "uar"."action" = ?`, [1, "read"]), refused(/mixes \$N and \? placeholders/));
        assert.deepEqual(events.map((event) => event.errorCode), ["SANDBOX_PARAMETER", "SANDBOX_PARAMETER", "SANDBOX_PARAMETER", "SANDBOX_PARAMETER"]);
        // The runtime is still usable afterwards, and the same statement runs once it gets its parameter.
        assert.equal((await query(ABILITY_SQL, [1])).length, 2);
      });

      it("binds null, dates, and booleans as it does for ?, and refuses an object under its own number", async () => {
        assert.deepEqual(await query('SELECT "action" FROM "user_ability_rule" WHERE "userId" IS $1', [null]), [{ action: "manage" }]);
        assert.deepEqual(await query(ABILITY_SQL, [null]), []);
        const seen = new Date("2026-01-02T03:04:05.000Z");
        assert.deepEqual(await query('SELECT "name" FROM "authors" WHERE "lastSeenAt" = $1', [seen]), [{ name: "Seed" }]);
        assert.deepEqual(await query("SELECT $1 AS yes, $2 AS no", [true, false]), [{ yes: 1, no: 0 }]);
        await assert.rejects(query(`${ABILITY_SQL} AND "uar"."subject" = $2`, [1, { name: "Order" }]), (error: any) => {
          assert.ok(error.driverError instanceof TypeError, String(error.driverError));
          assert.match(error.message, /Parameter 2 is an object, which SQLite cannot bind/);
          return true;
        });
      });

      it("reports the application's own SQL and parameters, not the form SQLite was given", async () => {
        await query(ABILITY_SQL, [1]);
        await query('SELECT "action" FROM "user_ability_rule" WHERE "action" = $2 AND "userId" = $1', [1, "update"]);
        assert.deepEqual(events.map((event) => [event.sql, event.parameters, event.tables, event.returnedRows]), [
          [ABILITY_SQL, [1], ["user_ability_rule"], 2],
          ['SELECT "action" FROM "user_ability_rule" WHERE "action" = $2 AND "userId" = $1', [1, "update"], ["user_ability_rule"], 1],
        ]);
        assert.deepEqual(formatSqlEvent(events[0] as SqlEvent, { mode: "verbose" }).split("\n").slice(1, 3), [
          'sql: SELECT "uar"."action" as "action", "uar"."subject" as "subject" FROM "user_ability_rule" "uar" WHERE "uar"."userId" = $1',
          "params: [1]",
        ]);
      });

      it("still fails for SQL of another dialect around the placeholders", async () => {
        const unsupported = (error: unknown): boolean => error instanceof SandboxDialectUnsupportedError;
        await assert.rejects(query(`${ABILITY_SQL}::int`, [1]), unsupported);
        await assert.rejects(query('SELECT * FROM "user_ability_rule" WHERE "action" ILIKE $1', ["re%"]), unsupported);
        await assert.rejects(query(`${ABILITY_SQL} FOR UPDATE`, [1]), unsupported);
        await assert.rejects(query('SELECT * FROM "user_ability_rule" WHERE "subject" ->> $1 @> $2', ["a", "b"]), unsupported);
        await assert.rejects(query('SELECT * FROM "user_ability_rule" WHERE "userId" = ANY($1)', ["{1,2}"]), unsupported);
      });

      it("leaves the SQL that TypeORM generates, and its ? placeholders, as they are", async () => {
        const rules = sandbox.dataSource.getRepository(UserAbilityRule);
        // A value that looks like a placeholder is data: it is bound, or written by TypeORM as a quoted literal.
        assert.deepEqual((await rules.findBy({ subject: "$1" })).map((rule: any) => rule.action), ["read"]);
        assert.deepEqual((await rules.createQueryBuilder("rule").where("rule.subject = :subject AND rule.userId = :userId", { subject: "$1", userId: 2 }).getMany()).map((rule: any) => rule.action), ["read"]);
        assert.equal((await rules.update({ subject: "$1" }, { action: "$2" })).affected, 1);
        assert.deepEqual(await query('SELECT "action" FROM "user_ability_rule" WHERE "subject" = ? AND "userId" = ?', ["$1", 2]), [{ action: "$2" }]);
        assert.equal((await rules.delete({ action: "$2" })).affected, 1);

        const data = events.filter((event) => event.operation !== "TRANSACTION");
        assert.equal(data.length, 5);
        assert.deepEqual(data.map((event) => event.errorCode), [undefined, undefined, undefined, undefined, undefined]);
        // None of these statements has a placeholder of the other style for the runtime to rewrite.
        assert.deepEqual(data.filter((event) => /\$\d/.test(event.sql.replace(/'(?:[^']|'')*'/g, ""))), []);
        assert.match(data[0]?.sql ?? "", /WHERE \(?\(?"UserAbilityRule"\."subject" = \?\)?\)?$/);
        assert.deepEqual(data[0]?.parameters, ["$1"]);
        assert.deepEqual(data[3], { ...data[3], sql: 'SELECT "action" FROM "user_ability_rule" WHERE "subject" = ? AND "userId" = ?', parameters: ["$1", 2], returnedRows: 1 });
      });
    });

    describe("completeness of SQL events", () => {
      it("reports every statement TypeORM sends, in order, none merged or dropped", async () => {
        await authors.save([{ name: "Ada", score: 5 }, { name: "Bo", score: 9 }]);
        await sandbox.dataSource.getRepository(Ticket).save([{ title: "t1", authorId: 8 }, { title: "t2", authorId: 9 }]);
        events.length = 0;

        // TypeORM's own log of what it executes, independent of the runtime's events.
        const sent: string[] = [];
        const record = (query: string): void => void sent.push(query);
        sandbox.dataSource.logger = { logQuery: record, logQueryError: (_error: unknown, query: string) => record(query), logQuerySlow: () => undefined, logSchemaBuild: () => undefined, logMigration: () => undefined, log: () => undefined };

        const tickets = sandbox.dataSource.getRepository(Ticket);
        // Repository queries, one after another.
        await authors.findOneBy({ id: 8 });
        await authors.findOneBy({ id: 9 });
        // Relations loaded through a join, and through separate queries.
        await tickets.find({ relations: { author: true }, order: { number: "ASC" } });
        await tickets.find({ relations: { author: true }, relationLoadStrategy: "query", order: { number: "ASC" } });
        // QueryBuilder.
        await authors.createQueryBuilder("author").leftJoin(Ticket, "ticket", "ticket.authorId = author.id").select(["author.name"]).where("author.score > :min", { min: 1 }).getRawMany();
        // A transaction that commits, one that rolls back, and a failing statement.
        await sandbox.dataSource.transaction(async (manager: any) => {
          await manager.save(Author, { name: "Cy" });
          await manager.update(Author, { id: 8 }, { score: 6 });
        });
        await assert.rejects(
          sandbox.dataSource.transaction(async (manager: any) => {
            await manager.delete(Ticket, { number: 1 });
            throw new Error("undo");
          }),
        );
        await assert.rejects(sandbox.dataSource.query("SELECT * FROM authors WHERE name ILIKE 'a%'"));
        await sandbox.dataSource.query("PRAGMA table_info(authors)");

        assert.ok(sent.length >= 14, `TypeORM sent ${sent.length} statements`);
        assert.deepEqual(statements(), sent);
        // The two lookups are two events, and the join names both of its tables on one.
        assert.deepEqual(events.slice(0, 2).map((event) => [event.operation, event.tables, event.returnedRows]), [["SELECT", ["authors"], 1], ["SELECT", ["authors"], 1]]);
        assert.ok(events.some((event) => event.operation === "SELECT" && event.tables?.join(",") === "ticket,authors"));
        assert.deepEqual(events.map((event) => event.transaction).filter((boundary) => boundary !== undefined), ["BEGIN", "COMMIT", "BEGIN", "ROLLBACK"]);
      });
    });

    describe("a directory database", () => {
      let directory: string;
      /** The files the directory consists of now, under the names they have in a new database. */
      const directoryFiles = (): Promise<Record<string, string>> => databaseFiles(directory);
      const table = async (name: string): Promise<Record<string, any>[]> => JSON.parse((await directoryFiles())[`tables/${name}.json`] ?? "null");
      const openDirectory = (options: object = {}): Promise<TypeormSandbox> =>
        createSandboxDataSource({ typeorm, file: directory, entities: [Author, Country, Ticket], ...options });

      beforeEach(async () => {
        directory = join(dir, "sandbox.db");
        await rm(directory, { recursive: true, force: true });
        await createDatabase(directory, { collections: { authors: [SEED_AUTHOR] }, config: { server: { port: 4999 } } });
      });

      it("is loaded into SQLite and written back as one file per table", async () => {
        const opened = await openDirectory();
        const repository = opened.dataSource.getRepository(Author);
        assert.equal((await repository.findOneBy({ id: 7 })).name, "Seed");

        const ada = await repository.save({ name: "Ada" });
        await opened.dataSource.getRepository(Country).save({ code: "pt", name: "Portugal" });

        assert.deepEqual(Object.keys(await directoryFiles()).sort(), ["manifest.json", "schema.json", "tables/authors.json", "tables/country.json", "tables/ticket.json"]);
        assert.deepEqual((await table("authors")).map((row) => [row.id, row.name]), [[7, "Seed"], [ada.id, "Ada"]]);
        assert.deepEqual(await table("country"), [{ code: "pt", name: "Portugal" }]);
        assert.deepEqual(await table("ticket"), []);
        assert.deepEqual(JSON.parse((await directoryFiles())["manifest.json"] as string).config, { server: { port: 4999 } });
      });

      it("records the entities' table definitions in schema.json", async () => {
        const opened = await openDirectory();
        // Nothing is written until something is committed.
        assert.deepEqual(JSON.parse((await directoryFiles())["schema.json"] as string).tables, []);
        await opened.dataSource.getRepository(Country).save({ code: "pt", name: "Portugal" });

        const schema = JSON.parse((await directoryFiles())["schema.json"] as string);
        assert.deepEqual(schema.tables.map((entry: { name: string }) => entry.name), ["authors", "country", "ticket"]);
        assert.deepEqual(schema.tables[0].columns[0], { column: "id", property: "id", type: "integer", declaredType: "Number", canonicalType: { kind: "integer", bits: 32 }, nullable: false, primaryKey: true, generated: "increment" });
        // The storage type; next to it what the entity declared, here the property's own type; and what that is in the entity's own database (D-040).
        assert.deepEqual(schema.tables[1].columns[0], { column: "code", property: "code", type: "text", declaredType: "String", canonicalType: { kind: "varchar" }, nullable: false, primaryKey: true });
        const authorId = schema.tables[2].columns.find((column: { column: string }) => column.column === "authorId");
        assert.deepEqual(authorId.references, { table: "authors", column: "id" });
      });

      it("saves the tables of a transaction together, and nothing when it is rolled back", async () => {
        const opened = await openDirectory();
        await opened.dataSource.transaction(async (manager: any) => {
          const author = await manager.save(Author, { name: "Ada" });
          await manager.save(Ticket, { title: "first", authorId: author.id });
          // Not a single file has changed before the commit.
          assert.equal((await table("authors")).length, 1);
        });
        assert.deepEqual([(await table("authors")).length, (await table("ticket")).length], [2, 1]);

        const committed = await directoryFiles();
        await assert.rejects(
          opened.dataSource.transaction(async (manager: any) => {
            await manager.delete(Ticket, { number: 1 });
            await manager.save(Author, { name: "Never" });
            throw new Error("undo");
          }),
          /undo/,
        );
        assert.deepEqual(await directoryFiles(), committed);
      });

      it("keeps the previous directory when a commit is above the size limit", async () => {
        // Room for the manifest, the table files, and the schema file, which says of every column what it is; none for a row of 12 kB.
        const limited = await openDirectory({ maxFileSizeMb: 0.008 });
        await limited.dataSource.getRepository(Country).save({ code: "pt", name: "Portugal" });
        const before = await directoryFiles();

        await assert.rejects(limited.dataSource.getRepository(Author).save({ name: "x".repeat(12000) }), (error: any) => error.driverError instanceof SandboxLimitError);
        assert.deepEqual(await directoryFiles(), before);
        assert.equal(await limited.dataSource.getRepository(Author).count(), 1);
      });

      it("discards changes when the manifest sets persistence to memory, and says so", async () => {
        await rm(directory, { recursive: true, force: true });
        await createDatabase(directory, { collections: { authors: [SEED_AUTHOR] }, persistence: "memory" });
        const before = await directoryFiles();

        const memory = await openDirectory();
        assert.equal(memory.runtime.persistence, "memory");
        assert.match(memory.warnings[0] ?? "", /declares "persistence": "memory": changes are not saved/);
        await memory.dataSource.getRepository(Author).save({ name: "Temporary" });
        assert.deepEqual(await directoryFiles(), before);

        // An explicit choice overrides what the database declares.
        const saving = await openDirectory({ persistence: "json" });
        assert.deepEqual(saving.warnings, []);
        await saving.dataSource.getRepository(Author).save({ name: "Kept" });
        assert.equal((await table("authors")).length, 2);
      });
    });

    describe("entities declared for PostgreSQL", () => {
      it("stores their column types the SQLite way and returns the same values", async () => {
        const columns = sandbox.runtime.execute('PRAGMA table_info("events")').rows.map((row) => [row.name, row.type]);
        assert.deepEqual(columns, [
          ["id", "TEXT"],
          ["kind", "TEXT"],
          ["display_name", "TEXT"],
          ["payload", "TEXT"],
          ["tags", "TEXT"],
          ["occurredAt", "DATETIME"],
          ["amount", "NUMERIC"],
          ["ratio", "REAL"],
          ["acknowledged", "BOOLEAN"],
        ]);

        const repository = sandbox.dataSource.getRepository(Event);
        const occurredAt = new Date("2026-04-05T06:07:08.000Z");
        const saved = await repository.save({ displayName: "Deploy", payload: { ok: true, steps: [1, 2] }, tags: ["a", "b"], occurredAt, amount: 12.5, ratio: 0.25 });
        assert.equal(saved.kind, "info");
        assert.equal(saved.acknowledged, false);

        // The fixture uses property names and JSON values; SQL uses the column name.
        assert.deepEqual(await stored("events"), [
          { id: saved.id, kind: "info", displayName: "Deploy", payload: { ok: true, steps: [1, 2] }, tags: ["a", "b"], occurredAt: "2026-04-05T06:07:08.000Z", amount: 12.5, ratio: 0.25, acknowledged: false },
        ]);
        assert.deepEqual(sandbox.runtime.execute("SELECT display_name, acknowledged, tags FROM events").rows, [{ display_name: "Deploy", acknowledged: 0, tags: '["a","b"]' }]);

        await sandbox.dataSource.destroy();
        const reopened = await open();
        const found = await reopened.dataSource.getRepository(Event).findOneByOrFail({ displayName: "Deploy" });
        // A decimal comes back as PostgreSQL's driver returns it: text, with the digits of its scale.
        assert.deepEqual(
          [found.payload, found.tags, found.occurredAt, found.amount, found.ratio, found.acknowledged, found.kind],
          [{ ok: true, steps: [1, 2] }, ["a", "b"], occurredAt, "12.50", 0.25, false, "info"],
        );
      });
    });
  });

  return version;
}
