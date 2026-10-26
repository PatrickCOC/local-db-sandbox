import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SqlEvent } from "../../../runtime/src/index.ts";
import { createSandboxDataSource } from "../../src/index.ts";
import type { TypeormSandbox } from "../../src/index.ts";
import { compileDecorators } from "./decorators.ts";

const NESTED = { name: "report", tags: ["a", "b"], owner: { id: 7, roles: [{ name: "admin", scopes: ["read", "write"] }] }, draft: false, score: 1.5, parent: null };

/** What the application of the regression saves for a browser's request: three objects and two nulls in text columns. */
const LOGIN = {
  userId: 12,
  accessToken: "Zm9vYmFy",
  ip: "::1",
  browser: { name: "Chrome", version: "153.0.0.0", major: "153" },
  engine: { name: "Blink", version: "153.0.0.0" },
  os: { name: "Windows", version: "10" },
  device: null,
  location: null,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
};

/**
 * Defines, for one installed TypeORM package, the tests of how values are
 * converted between JavaScript and the runtime, and returns that package's
 * version.
 *
 * Entities written for PostgreSQL get their column types rewritten to ones
 * TypeORM's SQLite dialect accepts. The type is also what TypeORM chooses a
 * value's conversion by, so these tests check that a value still arrives at
 * SQLite in a form it can bind, and comes back as the application gets it in
 * production. Every value goes through TypeORM's own persistence and
 * hydration code; nothing calls the sandbox's internals.
 *
 * A test file must call this once, because TypeORM keeps decorator metadata
 * per process.
 */
export async function typeormValuesSuite(packageName: string): Promise<string> {
  const require = createRequire(import.meta.url);
  const typeorm = require(packageName);
  const { version } = JSON.parse(readFileSync(join(dirname(require.resolve(packageName)), "package.json"), "utf8")) as { version: string };

  const fixtures = join(import.meta.dirname, "..", "fixtures");
  compileDecorators(fixtures, { typeorm: packageName });
  // The specifier is computed so that the type checker does not follow it into decorator code.
  const { Document, AuthToken, Measurement, Level } = await import(pathToFileURL(join(fixtures, "entities", "values.ts")).href);

  describe(`values converted by TypeORM ${version} on the relational runtime`, () => {
    let dir: string;
    let file: string;
    let sandbox: TypeormSandbox;
    let documents: any;
    let tokens: any;
    let events: SqlEvent[];

    /** The rows of a table in the JSON file; none before the first commit. */
    const stored = async (collection: string): Promise<Record<string, any>[]> => JSON.parse(await readFile(file, "utf8")).data[collection] ?? [];
    const open = (options: object = {}): Promise<TypeormSandbox> => createSandboxDataSource({ typeorm, file, entities: [Document, AuthToken, Measurement], ...options });
    /** What SQLite itself holds, without TypeORM. */
    const raw = (sql: string): Record<string, any>[] => sandbox.runtime.execute(sql).rows;
    const written = (operation: string, table: string): SqlEvent[] => events.filter((event) => event.operation === operation && event.tables?.includes(table));
    const bindable = (value: unknown): boolean => value === null || ["string", "number", "bigint"].includes(typeof value);

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-values-"));
      file = join(dir, "sandbox.db.json");
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
      await writeFile(file, JSON.stringify({ $meta: { version: 1 }, data: {} }));
      sandbox = await open();
      documents = sandbox.dataSource.getRepository(Document);
      tokens = sandbox.dataSource.getRepository(AuthToken);
      events = [];
      sandbox.runtime.subscribe((event) => events.push(event));
    });

    describe("columns declared jsonb, json, and simple-json", () => {
      it("saves an object through a repository as JSON text, and reads the object back", async () => {
        const saved = await documents.save({ title: "one", body: { a: 1 }, settings: { b: [2] }, extra: { c: "three" } });

        const [insert] = written("INSERT", "documents");
        assert.ok(insert !== undefined && insert.parameters.every(bindable), JSON.stringify(insert?.parameters));
        assert.deepEqual(insert.parameters, ["one", '{"a":1}', '{"b":[2]}', '{"c":"three"}']);
        assert.deepEqual(raw("SELECT body, typeof(body) AS stored, settings, extra FROM documents"), [
          { body: '{"a":1}', stored: "text", settings: '{"b":[2]}', extra: '{"c":"three"}' },
        ]);

        const found = await documents.findOneByOrFail({ id: saved.id });
        assert.deepEqual([found.body, found.settings, found.extra], [{ a: 1 }, { b: [2] }, { c: "three" }]);
      });

      it("inserts an object through InsertQueryBuilder", async () => {
        const result = await documents.createQueryBuilder().insert().into(Document).values([{ title: "one", body: NESTED, settings: { on: true } }, { title: "two", body: [1, 2] }]).execute();
        assert.equal(result.identifiers.length, 2);
        assert.ok(written("INSERT", "documents").every((event) => event.parameters.every(bindable)));

        const found = await documents.find({ order: { id: "ASC" } });
        assert.deepEqual(found.map((document: any) => [document.title, document.body, document.settings]), [["one", NESTED, { on: true }], ["two", [1, 2], null]]);
      });

      it("updates with an object through a repository, UpdateQueryBuilder, and a saved entity", async () => {
        const { id } = await documents.save({ title: "one", body: { a: 1 }, settings: { b: 2 }, extra: { c: 3 } });
        events.length = 0;

        assert.equal((await documents.update(id, { body: { a: 2, more: [true] } })).affected, 1);
        assert.equal((await documents.createQueryBuilder().update().set({ settings: { b: { deep: null } } }).where("id = :id", { id }).execute()).affected, 1);
        const loaded = await documents.findOneByOrFail({ id });
        loaded.extra.c = 4;
        await documents.save(loaded);

        assert.equal(written("UPDATE", "documents").length, 3);
        assert.ok(written("UPDATE", "documents").every((event) => event.parameters.every(bindable)));
        assert.deepEqual(raw("SELECT body, settings, extra FROM documents"), [{ body: '{"a":2,"more":[true]}', settings: '{"b":{"deep":null}}', extra: '{"c":4}' }]);
        const found = await documents.findOneByOrFail({ id });
        assert.deepEqual([found.body, found.settings, found.extra], [{ a: 2, more: [true] }, { b: { deep: null } }, { c: 4 }]);

        // Saving what was loaded, unchanged, is still recognized as no change.
        events.length = 0;
        await documents.save(found);
        assert.deepEqual(written("UPDATE", "documents"), []);
      });

      it("returns objects, not JSON text, from QueryBuilder selects", async () => {
        await documents.save([{ title: "one", body: NESTED, settings: [1, { two: 2 }], extra: { c: 3 } }, { title: "two", body: { other: true } }]);

        const one = await documents.createQueryBuilder("document").where("document.title = :title", { title: "one" }).getOneOrFail();
        assert.equal(typeof one.body, "object");
        assert.deepEqual([one.body, one.settings, one.extra], [NESTED, [1, { two: 2 }], { c: 3 }]);

        const many = await documents.createQueryBuilder("document").select(["document.id", "document.body"]).orderBy("document.id", "DESC").getMany();
        assert.deepEqual(many.map((document: any) => document.body), [{ other: true }, NESTED]);
      });

      it("keeps a null value as NULL", async () => {
        const { id } = await documents.save({ title: "none", body: null, settings: null, extra: null });
        assert.deepEqual(raw("SELECT body IS NULL AS body, settings IS NULL AS settings, extra IS NULL AS extra FROM documents"), [{ body: 1, settings: 1, extra: 1 }]);
        const found = await documents.findOneByOrFail({ id });
        assert.deepEqual([found.body, found.settings, found.extra], [null, null, null]);
        assert.equal(await documents.countBy({ body: typeorm.IsNull() }), 1);

        await documents.update(id, { body: { a: 1 } });
        await documents.update(id, { body: null });
        assert.equal((await documents.findOneByOrFail({ id })).body, null);
        assert.deepEqual((await stored("documents")).map((row) => [row.body, row.settings, row.extra]), [[null, null, null]]);
      });

      it("round-trips nested objects, arrays, and JSON scalars in every kind of JSON column", async () => {
        const values = [NESTED, [1, "two", [3, { four: [null, false] }], {}], [], {}, "text", 0, false];
        for (const value of values) {
          const { id } = await documents.save({ title: "value", body: value, settings: value, extra: value });
          const found = await documents.findOneByOrFail({ id });
          assert.deepEqual([found.body, found.settings, found.extra], [value, value, value]);
        }
        assert.deepEqual((await stored("documents")).map((row) => row.body), values);
      });

      it("commits JSON values with a transaction, and discards them with a rollback", async () => {
        await sandbox.dataSource.transaction(async (manager: any) => {
          const first = await manager.save(Document, { title: "kept", body: { step: 1 } });
          await manager.update(Document, first.id, { body: { step: 2, log: ["created", "updated"] } });
          await manager.createQueryBuilder().insert().into(Document).values({ title: "also kept", body: [NESTED] }).execute();
          assert.deepEqual(await stored("documents"), []);
        });
        const committed = await readFile(file, "utf8");
        assert.deepEqual((await stored("documents")).map((row) => [row.title, row.body]), [["kept", { step: 2, log: ["created", "updated"] }], ["also kept", [NESTED]]]);

        await assert.rejects(
          sandbox.dataSource.transaction(async (manager: any) => {
            await manager.update(Document, { title: "kept" }, { body: { step: 3 } });
            await manager.save(Document, { title: "never", body: { lost: true } });
            assert.deepEqual((await manager.findOneByOrFail(Document, { title: "kept" })).body, { step: 3 });
            throw new Error("undo");
          }),
          /undo/,
        );
        assert.equal(await readFile(file, "utf8"), committed);
        assert.deepEqual((await documents.find({ order: { id: "ASC" } })).map((document: any) => document.body), [{ step: 2, log: ["created", "updated"] }, [NESTED]]);
      });

      it("writes the logical value to the JSON snapshot, and reads it from there when the file is opened again", async () => {
        await documents.save({ title: "one", body: NESTED, settings: [NESTED], extra: { c: 3 } });
        const snapshot = await stored("documents");
        // The file holds the value itself, not the text SQLite stores.
        assert.deepEqual(snapshot, [{ id: 1, title: "one", body: NESTED, settings: [NESTED], extra: { c: 3 }, preferences: { theme: "light" }, history: [], code: null }]);
        await sandbox.dataSource.destroy();

        const reopened = await open();
        const found = await reopened.dataSource.getRepository(Document).findOneByOrFail({ title: "one" });
        assert.deepEqual([found.body, found.settings, found.extra, found.preferences, found.history], [NESTED, [NESTED], { c: 3 }, { theme: "light" }, []]);

        // A commit that does not touch the row writes the same values again.
        await reopened.dataSource.getRepository(Document).save({ title: "two" });
        assert.deepEqual((await stored("documents"))[0], snapshot[0]);
        await reopened.dataSource.destroy();
      });

      it("uses a default declared as an object or an array when the column is left out", async () => {
        const saved = await documents.save({ title: "defaults" });
        assert.deepEqual([saved.preferences, saved.history], [{ theme: "light" }, []]);
        assert.deepEqual(raw("SELECT preferences, history FROM documents"), [{ preferences: '{"theme":"light"}', history: "[]" }]);

        await documents.createQueryBuilder().insert().into(Document).values({ title: "also defaults" }).execute();
        const found = await documents.findOneByOrFail({ title: "also defaults" });
        assert.deepEqual([found.preferences, found.history], [{ theme: "light" }, []]);
        // The decorator metadata still holds the default as declared.
        const declared = typeorm.getMetadataArgsStorage().columns.find((column: any) => column.target === Document && column.propertyName === "preferences");
        assert.deepEqual(declared.options.default, { theme: "light" });
      });
    });

    describe("objects written to text columns", () => {
      const TEXT = { browser: JSON.stringify(LOGIN.browser), engine: JSON.stringify(LOGIN.engine), os: JSON.stringify(LOGIN.os) };

      it("saves the application's auth_token row: each object arrives as JSON text, as node-postgres sends it", async () => {
        const saved = await tokens.save({ ...LOGIN });

        const [insert] = written("INSERT", "auth_token");
        assert.equal(
          insert?.sql,
          'INSERT INTO "auth_token"("id", "createdAt", "updatedAt", "userId", "accessToken", "idTokenProvider", "idToken", "expireDate", "ip", "os", "engine", "device", "browser", "location", "userAgent") ' +
            "VALUES (NULL, datetime('now'), datetime('now'), 12, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)",
        );
        // accessToken, ip, os, engine, device, browser, location, userAgent: the third is the one SQLite could not bind.
        assert.deepEqual(insert?.parameters, [LOGIN.accessToken, LOGIN.ip, TEXT.os, TEXT.engine, null, TEXT.browser, null, LOGIN.userAgent]);
        assert.equal(insert?.errorCode, undefined);

        // The columns are text, so what comes back is the text: the application reads a string in production too.
        const found = await tokens.findOneByOrFail({ id: saved.id });
        assert.deepEqual([found.os, found.engine, found.device, found.browser, found.location], [TEXT.os, TEXT.engine, null, TEXT.browser, null]);
        assert.deepEqual([JSON.parse(found.os), JSON.parse(found.engine), JSON.parse(found.browser)], [LOGIN.os, LOGIN.engine, LOGIN.browser]);
        assert.deepEqual([found.userId, found.accessToken, found.ip, found.userAgent], [LOGIN.userId, LOGIN.accessToken, LOGIN.ip, LOGIN.userAgent]);
        assert.ok(found.createdAt instanceof Date);

        const [row] = await stored("auth_token");
        assert.deepEqual([row?.os, row?.engine, row?.device, row?.browser, row?.location], [TEXT.os, TEXT.engine, null, TEXT.browser, null]);

        // The lookup the application makes before it saves a token finds the row.
        assert.equal((await tokens.findOne({ where: { userId: LOGIN.userId, ip: LOGIN.ip, userAgent: LOGIN.userAgent } }))?.accessToken, LOGIN.accessToken);
      });

      it("does the same through InsertQueryBuilder, an update, and a transaction", async () => {
        await tokens.createQueryBuilder().insert().into(AuthToken).values({ ...LOGIN }).execute();
        const token = await tokens.findOneByOrFail({ accessToken: LOGIN.accessToken });
        assert.equal(token.os, TEXT.os);

        await tokens.update(token.id, { os: { name: "Linux" } });
        await tokens.createQueryBuilder().update().set({ engine: { name: "Gecko" } }).where("id = :id", { id: token.id }).execute();
        await sandbox.dataSource.transaction(async (manager: any) => {
          await manager.save(AuthToken, { id: token.id, device: { type: "mobile", vendor: "Acme" } });
        });
        await assert.rejects(
          sandbox.dataSource.transaction(async (manager: any) => {
            await manager.update(AuthToken, token.id, { browser: { name: "Other" } });
            throw new Error("undo");
          }),
          /undo/,
        );

        assert.ok(written("UPDATE", "auth_token").every((event) => event.parameters.every(bindable)));
        const found = await tokens.findOneByOrFail({ id: token.id });
        assert.deepEqual([found.os, found.engine, found.device, found.browser], ['{"name":"Linux"}', '{"name":"Gecko"}', '{"type":"mobile","vendor":"Acme"}', TEXT.browser]);
        assert.deepEqual((await stored("auth_token")).map((row) => row.device), ['{"type":"mobile","vendor":"Acme"}']);
      });

      it("leaves strings, and conditions on text columns, as they were", async () => {
        const first = await tokens.save({ accessToken: "one", ip: "10.0.0.1", os: "plain text", userAgent: "Alpha/1.0" });
        await tokens.save({ accessToken: "two", ip: "10.0.0.2", os: '{"already":"text"}', userAgent: "Beta/2.0" });
        assert.deepEqual(raw("SELECT os FROM auth_token ORDER BY id"), [{ os: "plain text" }, { os: '{"already":"text"}' }]);

        const names = (found: any[]): string[] => found.map((token) => token.accessToken).sort();
        assert.deepEqual(names(await tokens.findBy({ ip: typeorm.In(["10.0.0.1", "10.0.0.2"]) })), ["one", "two"]);
        assert.deepEqual(names(await tokens.findBy({ userAgent: typeorm.Like("Beta%") })), ["two"]);
        assert.deepEqual(names(await tokens.findBy({ os: typeorm.Not(typeorm.IsNull()), location: typeorm.IsNull() })), ["one", "two"]);
        assert.deepEqual(names(await tokens.createQueryBuilder("token").where({ ip: typeorm.In(["10.0.0.2"]) }).getMany()), ["two"]);
        assert.deepEqual(names(await tokens.createQueryBuilder("token").where("token.os = :os", { os: "plain text" }).getMany()), ["one"]);
        assert.equal((await tokens.update({ userAgent: typeorm.Like("Alpha%") }, { location: "here" })).affected, 1);
        assert.equal((await tokens.delete({ ip: typeorm.In(["10.0.0.2"]) })).affected, 1);
        assert.deepEqual(raw("SELECT accessToken, location FROM auth_token"), [{ accessToken: "one", location: "here" }]);

        // Saving what was loaded, unchanged, is still recognized as no change.
        events.length = 0;
        await tokens.save(await tokens.findOneByOrFail({ id: first.id }));
        assert.deepEqual(written("UPDATE", "auth_token"), []);
      });

      it("applies the application's own transformer first, and still returns what it returns", async () => {
        const { id } = await documents.save({ title: "coded", code: "Abc" });
        assert.deepEqual(raw("SELECT code FROM documents"), [{ code: "ABC" }]);
        assert.equal((await documents.findOneByOrFail({ id })).code, "abc");
        assert.equal(await documents.countBy({ code: "abc" }), 1);
      });
    });

    describe("values that nothing converts", () => {
      const refused = (message: RegExp) => (error: any): boolean => {
        assert.match(String(error.message), message);
        assert.ok(error.driverError instanceof TypeError, String(error.driverError));
        return true;
      };

      it("are refused by the runtime, with the parameter named, instead of being given a form", async () => {
        const insert = 'INSERT INTO "documents" ("title", "body", "preferences", "history") VALUES (?, ?, \'{}\', \'[]\')';
        await assert.rejects(sandbox.dataSource.query(insert, ["raw", { a: 1 }]), refused(/Parameter 2 is an object, which SQLite cannot bind/));
        await assert.rejects(sandbox.dataSource.query(insert, ["raw", [1, 2]]), refused(/Parameter 2 is an array, which SQLite cannot bind/));
        // An object in first position, even an empty one, is not taken for named parameters.
        await assert.rejects(sandbox.dataSource.query('SELECT * FROM "documents" WHERE "body" = ?', [{}]), refused(/Parameter 1 is an object/));
        await assert.rejects(documents.createQueryBuilder("document").where("document.body = :body", { body: { a: 1 } }).getMany(), refused(/Parameter 1 is an object/));

        assert.deepEqual(events.map((event) => event.errorCode), ["SQL_ERROR", "SQL_ERROR", "SQL_ERROR", "SQL_ERROR"]);
        assert.match(events[0]?.errorMessage ?? "", /has to be converted before it reaches the runtime/);
        assert.deepEqual(await stored("documents"), []);
        // The runtime is still usable afterwards.
        assert.equal(await documents.count(), 0);
      });

      it("are refused in a column whose type has no conversion for them", async () => {
        // node-postgres sends neither an array nor an object for an integer column as something PostgreSQL would accept.
        await assert.rejects(tokens.save({ accessToken: "x", os: ["Windows", "10"] }), refused(/Parameter 2 is an array, which SQLite cannot bind/));
        await assert.rejects(tokens.save({ accessToken: "x", userId: { id: 1 } }), refused(/Parameter 1 is an object, which SQLite cannot bind/));
        assert.equal(await tokens.count(), 0);
        assert.equal(sandbox.runtime.inTransaction, false);
      });
    });

    describe("other column types declared for PostgreSQL", () => {
      it("keep the conversion TypeORM makes for them", async () => {
        const measurements = sandbox.dataSource.getRepository(Measurement);
        const seenAt = new Date("2026-01-02T03:04:05.678Z");

        const bare = await measurements.save({});
        assert.deepEqual([bare.notes, bare.aliases, bare.level, bare.flag], [[], [], Level.Low, false]);

        const { id } = await measurements.save({ labels: ["a", "b"], counts: [1, 2], notes: ["n"], aliases: ["x"], colors: ["red", "blue"], level: Level.High, day: "2026-01-02", at: "03:04:05", seenAt, flag: true });
        const [insert] = written("INSERT", "measurements").slice(-1);
        assert.ok(insert !== undefined && insert.parameters.every(bindable), JSON.stringify(insert?.parameters));

        const found = await measurements.findOneByOrFail({ id });
        assert.deepEqual(
          [found.labels, found.counts, found.notes, found.aliases, found.colors, found.level, found.day, found.at, found.seenAt, found.flag],
          [["a", "b"], [1, 2], ["n"], ["x"], ["red", "blue"], Level.High, "2026-01-02", "03:04:05", seenAt, true],
        );
        assert.deepEqual((await stored("measurements"))[1], {
          id,
          labels: ["a", "b"],
          counts: [1, 2],
          notes: ["n"],
          aliases: ["x"],
          colors: ["red", "blue"],
          level: 2,
          total: null,
          price: null,
          day: "2026-01-02",
          at: "03:04:05",
          seenAt: "2026-01-02T03:04:05.678Z",
          flag: true,
        });
      });
    });
  });

  return version;
}
