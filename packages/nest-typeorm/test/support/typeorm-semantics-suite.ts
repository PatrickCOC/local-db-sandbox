import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SqlEvent } from "../../../runtime/src/index.ts";
import { createDatabase } from "../../../storage-json/src/index.ts";
import { storedRows, tableFile } from "../../../storage-json/test/support/database-files.ts";
import { createSandboxDataSource } from "../../src/index.ts";
import type { TypeormSandbox } from "../../src/index.ts";
import { compileDecorators } from "./decorators.ts";

const WHEN = new Date("2026-01-02T03:04:05.678Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One more than the largest integer a JavaScript number holds exactly. */
const BEYOND = "9007199254740993";

/**
 * Defines, for one installed TypeORM package, the tests of what an
 * application gets back for each kind of column, and returns that package's
 * version.
 *
 * The entities are declared as an application written for PostgreSQL or
 * MySQL declares them (fixtures/entities/semantics.ts); SQLite holds the
 * values. Every test goes through TypeORM's own persistence and hydration:
 * a value is written and read by a repository or a QueryBuilder, and compared
 * with what TypeORM gives that application on its own database. What SQLite
 * holds, and what a raw query returns, is asserted separately, because it is
 * not the same thing.
 *
 * A test file must call this once, because TypeORM keeps decorator metadata
 * per process.
 */
export async function typeormSemanticsSuite(packageName: string): Promise<string> {
  const require = createRequire(import.meta.url);
  const typeorm = require(packageName);
  const { version } = JSON.parse(readFileSync(join(dirname(require.resolve(packageName)), "package.json"), "utf8")) as { version: string };

  const fixtures = join(import.meta.dirname, "..", "fixtures");
  compileDecorators(fixtures, { typeorm: packageName });
  // The specifier is computed so that the type checker does not follow it into decorator code.
  const { Flag, Moment, Clock, Paper, Choice, Amount, List, Identity, Attachment, Status, Priority } = await import(pathToFileURL(join(fixtures, "entities", "semantics.ts")).href);
  const entities = [Flag, Moment, Clock, Paper, Choice, Amount, List, Identity, Attachment];

  describe(`what an application gets back from TypeORM ${version} on the relational runtime`, () => {
    let dir: string;
    let file: string;
    let sandbox: TypeormSandbox;
    let events: SqlEvent[];

    const open = async (path = file): Promise<TypeormSandbox> => {
      const opened = await createSandboxDataSource({ typeorm, file: path, entities });
      events = [];
      opened.runtime.subscribe((event) => events.push(event));
      return opened;
    };
    const repository = (entity: unknown): any => sandbox.dataSource.getRepository(entity);
    /** What SQLite itself holds, without TypeORM. */
    const held = (sql: string): Record<string, any>[] => sandbox.runtime.execute(sql).rows;
    /** The rows of a table in the JSON file; none before the first commit. */
    const fixture = async (table: string): Promise<Record<string, any>[]> => JSON.parse(await readFile(file, "utf8")).data[table] ?? [];
    /** Closes the sandbox and opens the database again, as a restart of the application does. */
    const restart = async (path = file): Promise<void> => {
      await sandbox.dataSource.destroy();
      sandbox = await open(path);
    };
    /** Saved by a repository, then read back by a repository and, as an entity, by a QueryBuilder: the two must agree. */
    const roundTrip = async (entity: unknown, values: object): Promise<any> => {
      const saved = await repository(entity).save(repository(entity).create(values));
      const found = await repository(entity).findOneByOrFail({ id: saved.id });
      const built = await repository(entity).createQueryBuilder("row").where("row.id = :id", { id: saved.id }).getOneOrFail();
      assert.deepEqual(built, found);
      return found;
    };

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-semantics-"));
      file = join(dir, "sandbox.db.json");
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
      await sandbox?.dataSource.destroy().catch(() => undefined);
      await writeFile(file, JSON.stringify({ $meta: { version: 1 }, data: {} }));
      sandbox = await open();
    });

    describe("booleans", () => {
      it("are true and false to the application, and 1 and 0 in SQLite", async () => {
        const found = await roundTrip(Flag, { enabled: true, verified: false, plain: true });
        assert.deepEqual([found.enabled, found.verified, found.plain], [true, false, true]);
        assert.deepEqual(held('SELECT "enabled", "verified", "plain" FROM "flags"'), [{ enabled: 1, verified: 0, plain: 1 }]);
        assert.deepEqual([(await fixture("flags"))[0]?.enabled, (await fixture("flags"))[0]?.verified], [true, false]);
      });

      it("keep null as null, and take a declared default", async () => {
        const found = await roundTrip(Flag, { enabled: false });
        assert.deepEqual([found.enabled, found.verified, found.plain, found.active, found.archived], [false, null, null, true, false]);
        assert.deepEqual(held('SELECT "verified", "active", "archived" FROM "flags"'), [{ verified: null, active: 1, archived: 0 }]);
      });

      it("can be searched for as booleans", async () => {
        await repository(Flag).save([{ enabled: true }, { enabled: false }, { enabled: true, verified: true }]);
        assert.equal(await repository(Flag).countBy({ enabled: true }), 2);
        assert.deepEqual((await repository(Flag).findBy({ verified: typeorm.IsNull() })).map((flag: any) => flag.enabled), [true, false]);
        assert.equal(await repository(Flag).createQueryBuilder("flag").where("flag.enabled = :enabled", { enabled: false }).getCount(), 1);
      });
    });

    describe("dates and times", () => {
      it("returns a Date for every kind of date-time column, to the millisecond", async () => {
        const found = await roundTrip(Moment, { stamp: WHEN, stampZone: WHEN, stampLong: WHEN, dateTime: WHEN, plain: WHEN });
        for (const property of ["stamp", "stampZone", "stampLong", "dateTime", "plain"]) {
          assert.ok(found[property] instanceof Date, property);
          assert.equal(found[property].getTime(), WHEN.getTime(), property);
        }
        // SQLite holds its own date-time text, in UTC; the fixture holds ISO text.
        assert.deepEqual(held('SELECT "stamp", "stampZone", "plain" FROM "moments"'), [{ stamp: "2026-01-02 03:04:05.678", stampZone: "2026-01-02 03:04:05.678", plain: "2026-01-02 03:04:05.678" }]);
        assert.deepEqual([(await fixture("moments"))[0]?.stamp, (await fixture("moments"))[0]?.plain], ["2026-01-02T03:04:05.678Z", "2026-01-02T03:04:05.678Z"]);
      });

      it("returns a day as text, and a time of day as text, not as a Date", async () => {
        const found = await roundTrip(Moment, { day: "2026-01-02", clock: "03:04:05" });
        assert.deepEqual([found.day, found.clock], ["2026-01-02", "03:04:05"]);
        // Given a Date, TypeORM writes its day and its time of day, as it does on any database.
        const fromDate = await roundTrip(Moment, { day: new Date(2026, 4, 6, 7, 8, 9), clock: new Date(2026, 4, 6, 7, 8, 9) });
        assert.deepEqual([fromDate.day, fromDate.clock], ["2026-05-06", "07:08:09"]);
        // Text that only looks like a date is not turned into one.
        assert.deepEqual(held('SELECT typeof("day") AS day, typeof("clock") AS clock FROM "moments" LIMIT 1'), [{ day: "text", clock: "text" }]);
      });

      it("keeps a time of day with a zone as the text it was given", async () => {
        const found = await roundTrip(Clock, { zoned: "03:04:05+08", short: "23:59:59.123-05:30", local: "03:04:05" });
        assert.deepEqual([found.zoned, found.short, found.local], ["03:04:05+08", "23:59:59.123-05:30", "03:04:05"]);
      });

      it("fills the columns TypeORM maintains itself with Dates, and counts versions", async () => {
        const startedAt = Date.now();
        const saved = await repository(Moment).save({});
        const found = await repository(Moment).findOneByOrFail({ id: saved.id });
        assert.ok(found.createdAt instanceof Date && found.updatedAt instanceof Date);
        // SQLite's own clock, which TypeORM's SQLite dialect uses for these columns, counts whole seconds.
        assert.ok(Math.abs(found.createdAt.getTime() - startedAt) < 5000, found.createdAt.toISOString());
        assert.deepEqual([found.deletedAt, found.version], [null, 1]);

        found.clock = "10:00:00";
        const updated = await repository(Moment).save(found);
        assert.equal(updated.version, 2);
        await repository(Moment).softDelete({ id: saved.id });
        assert.equal(await repository(Moment).countBy({ id: saved.id }), 0);
        const deleted = await repository(Moment).findOne({ where: { id: saved.id }, withDeleted: true });
        assert.ok(deleted.deletedAt instanceof Date);
      });

      it("does not lose the time of a Date property that declares no column type when the database is opened again", async () => {
        const { id } = await repository(Moment).save({ plain: WHEN, stamp: WHEN, day: "2026-01-02" });
        await restart();
        const found = await repository(Moment).findOneByOrFail({ id });
        assert.deepEqual([found.plain, found.stamp, found.day], [WHEN, WHEN, "2026-01-02"]);
      });

      it("compares date-times as moments in searches", async () => {
        await repository(Moment).save([{ stamp: new Date("2026-01-01T00:00:00.000Z") }, { stamp: WHEN }, { stamp: new Date("2026-03-01T00:00:00.000Z") }]);
        assert.equal(await repository(Moment).countBy({ stamp: typeorm.MoreThan(new Date("2026-01-01T12:00:00.000Z")) }), 2);
        assert.equal(await repository(Moment).countBy({ stamp: WHEN }), 1);
        assert.equal(await repository(Moment).createQueryBuilder("moment").where("moment.stamp BETWEEN :from AND :to", { from: new Date("2026-01-02T00:00:00Z"), to: new Date("2026-01-03T00:00:00Z") }).getCount(), 1);
      });
    });

    describe("JSON", () => {
      it("returns objects, arrays, and null from every kind of JSON column", async () => {
        const object = { a: [1, { b: null }], c: "text", d: false };
        const array = [1, "two", { three: 3 }, [4]];
        for (const property of ["json", "jsonb", "simple"]) {
          assert.deepEqual((await roundTrip(Paper, { [property]: object }))[property], object, property);
          assert.deepEqual((await roundTrip(Paper, { [property]: array }))[property], array, property);
          assert.equal((await roundTrip(Paper, { [property]: null }))[property], null, property);
        }
        assert.deepEqual(held('SELECT typeof("jsonb") AS type, "jsonb" FROM "papers" WHERE "jsonb" IS NOT NULL LIMIT 1'), [{ type: "text", jsonb: JSON.stringify(object) }]);
        assert.deepEqual((await fixture("papers"))[0]?.json, object);
      });
    });

    describe("enums", () => {
      it("returns the enum's own values: text for a text enum, a number for a numeric one", async () => {
        const found = await roundTrip(Choice, { status: Status.Published, priority: Priority.High, simple: Status.Draft, several: [Status.Draft, Status.Published] });
        assert.deepEqual([found.status, found.priority, found.simple, found.several], ["published", 2, "draft", ["draft", "published"]]);
        assert.equal(typeof found.priority, "number");
      });

      it("takes the declared default, and keeps null", async () => {
        const found = await roundTrip(Choice, {});
        assert.deepEqual([found.status, found.priority, found.simple, found.several], ["draft", null, null, null]);
      });
    });

    describe("64-bit integers", () => {
      it("are text of their digits to the application, exact beyond what a number holds", async () => {
        const found = await roundTrip(Amount, { big: BEYOND, big8: "-9223372036854775808" });
        assert.deepEqual([found.big, found.big8], [BEYOND, "-9223372036854775808"]);
        // SQLite holds them as integers, not as text.
        assert.deepEqual(held('SELECT typeof("big") AS type, CAST("big" AS TEXT) AS digits, "big" + 1 > "big" AS counts FROM "amounts"'), [{ type: "integer", digits: BEYOND, counts: 1 }]);
        // The fixture holds a number where a number is exact, and the digits where it is not.
        assert.deepEqual([(await fixture("amounts"))[0]?.big, (await fixture("amounts"))[0]?.big8], [BEYOND, "-9223372036854775808"]);
      });

      it("are text also when they are small, as PostgreSQL's and MySQL's drivers return them", async () => {
        const found = await roundTrip(Amount, { big: "42", big8: 7 });
        assert.deepEqual([found.big, found.big8], ["42", "7"]);
        assert.deepEqual([(await fixture("amounts"))[0]?.big, (await fixture("amounts"))[0]?.big8], [42, 7]);
      });

      it("are compared and ordered as numbers", async () => {
        await repository(Amount).save([{ big: "9" }, { big: "10" }, { big: BEYOND }, { big: "9007199254740992" }]);
        const ordered = await repository(Amount).find({ order: { big: "ASC" } });
        assert.deepEqual(ordered.map((amount: any) => amount.big), ["9", "10", "9007199254740992", BEYOND]);
        assert.deepEqual((await repository(Amount).findBy({ big: BEYOND })).map((amount: any) => amount.big), [BEYOND]);
        assert.equal(await repository(Amount).countBy({ big: typeorm.MoreThan("9") }), 3);
      });

      it("survive a restart exactly", async () => {
        const { id } = await repository(Amount).save({ big: BEYOND });
        await restart();
        assert.equal((await repository(Amount).findOneByOrFail({ id })).big, BEYOND);
      });
    });

    describe("decimals", () => {
      it("are text with the digits of the declared scale, as PostgreSQL's and MySQL's drivers return them", async () => {
        const found = await roundTrip(Amount, { price: "1234.5", rate: "0.1", loose: "0.1" });
        assert.deepEqual([found.price, found.rate, found.loose, found.balance], ["1234.50", "0.100000", "0.1", "0.00"]);
        assert.deepEqual(held('SELECT typeof("price") AS type, "price" FROM "amounts"'), [{ type: "real", price: 1234.5 }]);
      });

      it("are rounded to the declared scale when they are written, half away from zero, as the database does", async () => {
        const cases: [unknown, string][] = [[10.125, "10.13"], ["1.005", "1.01"], [1.005, "1.01"], ["-2.675", "-2.68"], ["0.004", "0.00"], ["-0.004", "0.00"], [7, "7.00"], ["99.995", "100.00"]];
        for (const [written, expected] of cases) {
          assert.equal((await roundTrip(Amount, { price: written })).price, expected, `${JSON.stringify(written)}`);
        }
        // What is stored is the rounded value, so SQL sees what the application sees.
        assert.deepEqual(held('SELECT "price" FROM "amounts" ORDER BY "id" LIMIT 2'), [{ price: 10.13 }, { price: 1.01 }]);
        assert.equal((await roundTrip(Amount, { rate: "1.0000005" })).rate, "1.000001");
      });

      it("are compared and added up as numbers", async () => {
        await repository(Amount).save([{ price: "9.50" }, { price: "10.00" }, { price: "100.25" }]);
        assert.deepEqual((await repository(Amount).find({ order: { price: "ASC" } })).map((amount: any) => amount.price), ["9.50", "10.00", "100.25"]);
        assert.equal(await repository(Amount).countBy({ price: typeorm.MoreThan("9.75") }), 2);
        assert.deepEqual((await repository(Amount).findBy({ price: "10" })).map((amount: any) => amount.price), ["10.00"]);
        const { total } = await repository(Amount).createQueryBuilder("amount").select('SUM(amount.price)', "total").getRawOne();
        assert.equal(total, 119.75);
      });

      it("give the application's own transformer the text it gets in production", async () => {
        const found = await roundTrip(Amount, { parsed: 12.345 });
        // Rounded to two digits, read as "12.35", and parsed by the application's transformer.
        assert.equal(found.parsed, 12.35);
        assert.equal(typeof found.parsed, "number");
      });

      it("hold about 15 significant digits, which is SQLite's number and not the declared precision", async () => {
        assert.equal((await roundTrip(Amount, { rate: "123456789.123456" })).rate, "123456789.123456");
        // Beyond that, digits are lost where SQLite stores the value. The value is still text, not a number that hides it.
        const found = await roundTrip(Amount, { loose: "12345678901234567.891" });
        assert.equal(typeof found.loose, "string");
        assert.notEqual(found.loose, "12345678901234567.891");
      });

      it("leave floating point columns as numbers", async () => {
        const found = await roundTrip(Amount, { ratio: 0.1, wide: 1e300, narrow: 1.5, count: 7, small: 3 });
        assert.deepEqual([found.ratio, found.wide, found.narrow, found.count, found.small], [0.1, 1e300, 1.5, 7, 3]);
      });
    });

    describe("arrays", () => {
      it("returns the elements of a simple-array as text, as TypeORM reads them from the text it stores", async () => {
        assert.deepEqual((await roundTrip(List, { simple: ["a", "b"] })).simple, ["a", "b"]);
        assert.deepEqual((await roundTrip(List, { simple: [1, 2] })).simple, ["1", "2"]);
        assert.deepEqual((await roundTrip(List, { simple: [] })).simple, []);
      });

      it("returns the elements of a PostgreSQL array with their own types, and date-times as Dates", async () => {
        const found = await roundTrip(List, { numbers: [1, 2], words: ["x", "y,z"], switches: [true, false], times: [WHEN, new Date("2027-01-01T00:00:00.000Z")] });
        assert.deepEqual([found.numbers, found.words, found.switches], [[1, 2], ["x", "y,z"], [true, false]]);
        assert.ok(found.times.every((element: unknown) => element instanceof Date));
        assert.deepEqual(found.times.map((element: Date) => element.toISOString()), ["2026-01-02T03:04:05.678Z", "2027-01-01T00:00:00.000Z"]);
        assert.deepEqual((await fixture("lists"))[0]?.times, ["2026-01-02T03:04:05.678Z", "2027-01-01T00:00:00.000Z"]);
      });

      it("keeps null arrays null", async () => {
        const found = await roundTrip(List, {});
        assert.deepEqual([found.simple, found.numbers, found.words, found.switches, found.times], [null, null, null, null, null]);
      });
    });

    describe("UUIDs and text", () => {
      it("generates UUIDs where the entity asks for them, and keeps the ones it is given", async () => {
        const given = "0b0e6f5e-7c1d-4c0a-9a4e-2f6f3b1d9c11";
        const saved = await repository(Identity).save({ ref: given, name: "Ada", email: "Ada@Example.Test", code: "HK" });
        assert.match(saved.id, UUID);
        assert.match(saved.token, UUID);
        assert.notEqual(saved.id, saved.token);

        const found = await repository(Identity).findOneByOrFail({ id: saved.id });
        assert.deepEqual([found.id, found.ref, found.token, found.name, found.email, found.code], [saved.id, given, saved.token, "Ada", "Ada@Example.Test", "HK"]);
        assert.deepEqual((await repository(Identity).findBy({ ref: given })).map((identity: any) => identity.id), [saved.id]);
        assert.deepEqual(await repository(Identity).createQueryBuilder("identity").where("identity.ref = :ref", { ref: given }).getOneOrFail(), found);
      });
    });

    describe("binary data", () => {
      const id = "3f2a9c1e-5b7d-4e8f-a1b2-c3d4e5f60718";
      const bytes = Buffer.from([0, 1, 2, 254, 255]);

      it("returns a Buffer with the bytes that were written, under each of its declared names", async () => {
        await repository(Attachment).save({ id, bytes, blob: Buffer.from("héllo", "utf8"), short: Buffer.alloc(0) });
        const found = await repository(Attachment).findOneByOrFail({ id });
        assert.deepEqual(await repository(Attachment).createQueryBuilder("row").where("row.id = :id", { id }).getOneOrFail(), found);
        for (const property of ["bytes", "blob", "short"]) {
          assert.ok(Buffer.isBuffer(found[property]), property);
        }
        assert.deepEqual([found.bytes.toString("hex"), found.blob.toString("utf8"), found.short.length], ["000102feff", "héllo", 0]);
        assert.deepEqual(held('SELECT typeof("bytes") AS type, length("bytes") AS length FROM "attachments"'), [{ type: "blob", length: 5 }]);
        // In the fixture, bytes are Base64 text.
        assert.deepEqual([(await fixture("attachments"))[0]?.bytes, (await fixture("attachments"))[0]?.blob], ["AAEC/v8=", Buffer.from("héllo", "utf8").toString("base64")]);
      });

      it("keeps null as null, and the bytes across a restart", async () => {
        await repository(Attachment).save({ id, bytes });
        await restart();
        const found = await repository(Attachment).findOneByOrFail({ id });
        assert.deepEqual([found.bytes.toString("hex"), found.blob, found.short], ["000102feff", null, null]);
      });
    });

    describe("null", () => {
      it("is null for every nullable column, whatever its type converts other values to", async () => {
        const nothing: [unknown, object, string[]][] = [
          [Flag, { enabled: true }, ["verified", "plain"]],
          [Moment, {}, ["stamp", "stampZone", "stampLong", "dateTime", "plain", "day", "clock", "deletedAt"]],
          [Clock, {}, ["zoned", "short", "local"]],
          [Paper, {}, ["json", "jsonb", "simple"]],
          [Choice, {}, ["priority", "simple", "several"]],
          [Amount, {}, ["big", "big8", "price", "rate", "loose", "ratio", "wide", "narrow", "count", "small", "parsed"]],
          [List, {}, ["simple", "numbers", "words", "switches", "times"]],
          [Identity, {}, ["ref", "name", "email", "code"]],
        ];
        for (const [entity, values, properties] of nothing) {
          const found = await roundTrip(entity, values);
          assert.deepEqual(properties.map((property) => [property, found[property]]), properties.map((property) => [property, null]));
        }
      });

      it("can be written over a value, and searched for", async () => {
        const saved = await repository(Amount).save({ big: "5", price: "1.50" });
        await repository(Amount).update({ id: saved.id }, { big: null, price: null });
        const found = await repository(Amount).findOneByOrFail({ id: saved.id });
        assert.deepEqual([found.big, found.price], [null, null]);
        assert.equal(await repository(Amount).countBy({ price: typeorm.IsNull() }), 1);
      });
    });

    describe("every way of reading and writing through TypeORM", () => {
      it("gives the same values from find, findOne, QueryBuilder getMany, and a relation-free select of columns", async () => {
        await repository(Amount).save([{ big: BEYOND, price: "1.5" }, { big: "2", price: 2.25 }]);
        const expected = [[BEYOND, "1.50"], ["2", "2.25"]];
        const pairs = (rows: any[]): unknown[] => rows.map((row) => [row.big, row.price]);

        assert.deepEqual(pairs(await repository(Amount).find({ order: { id: "ASC" } })), expected);
        assert.deepEqual(pairs(await repository(Amount).createQueryBuilder("amount").orderBy("amount.id").getMany()), expected);
        assert.deepEqual(pairs(await repository(Amount).find({ select: { id: true, big: true, price: true }, order: { id: "ASC" } })), expected);
        assert.deepEqual(pairs(await sandbox.dataSource.manager.find(Amount, { order: { id: "ASC" } })), expected);
      });

      it("writes the same values through insert, update, upsert-free save, and QueryBuilder", async () => {
        await repository(Flag).insert({ enabled: true });
        await sandbox.dataSource.createQueryBuilder().insert().into(Amount).values({ big: BEYOND, price: 2.005 }).execute();
        await repository(Amount).createQueryBuilder().update().set({ price: 3.335 }).where("big = :big", { big: BEYOND }).execute();
        await repository(Moment).insert({ stamp: WHEN });

        assert.deepEqual((await repository(Flag).find()).map((flag: any) => flag.enabled), [true]);
        assert.deepEqual((await repository(Amount).find()).map((amount: any) => [amount.big, amount.price]), [[BEYOND, "3.34"]]);
        assert.deepEqual((await repository(Moment).find()).map((moment: any) => moment.stamp), [WHEN]);
      });

      it("only binds values SQLite takes, and reports them as they were bound", async () => {
        await repository(Flag).save({ enabled: true, verified: false });
        await repository(Moment).save({ stamp: WHEN, day: "2026-01-02" });
        await repository(Amount).save({ big: BEYOND, price: 10.125 });
        await repository(Paper).save({ jsonb: { a: 1 } });
        const inserted = events.filter((event) => event.operation === "INSERT");
        assert.equal(inserted.length, 4);
        for (const event of inserted) {
          assert.ok(event.parameters.every((value) => value === null || ["string", "number", "bigint"].includes(typeof value)), JSON.stringify(event.parameters));
          assert.equal(event.errorCode, undefined);
        }
        // Each row was read back after its insert, and both statements belong to tables the runtime knows.
        assert.deepEqual([...new Set(events.flatMap((event) => event.tables ?? []))].sort(), ["amounts", "flags", "moments", "papers"]);
        assert.ok(inserted.every((event) => event.snapshotSaveMs === undefined || event.snapshotSaveMs >= 0));
      });
    });

    describe("raw results", () => {
      it("are what SQLite holds, from DataSource.query and from getRawOne: TypeORM converts nothing there on any database", async () => {
        await repository(Flag).save({ enabled: true, verified: false });
        await repository(Moment).save({ stamp: WHEN, day: "2026-01-02", clock: "03:04:05" });
        await repository(Paper).save({ jsonb: { a: 1 } });
        await repository(Amount).save({ big: "42", big8: BEYOND, price: "1234.5" });
        await repository(Choice).save({ priority: Priority.High });
        await repository(Attachment).save({ id: "3f2a9c1e-5b7d-4e8f-a1b2-c3d4e5f60718", bytes: Buffer.from([1, 2]) });

        assert.deepEqual(await sandbox.dataSource.query('SELECT "enabled", "verified", "plain" FROM "flags"'), [{ enabled: 1, verified: 0, plain: null }]);
        assert.deepEqual(await sandbox.dataSource.query('SELECT "stamp", "day", "clock" FROM "moments"'), [{ stamp: "2026-01-02 03:04:05.678", day: "2026-01-02", clock: "03:04:05" }]);
        assert.deepEqual(await sandbox.dataSource.query('SELECT "jsonb" FROM "papers"'), [{ jsonb: '{"a":1}' }]);
        // An integer that a number holds is a number; one that it does not hold is the text of its digits, never a rounded number.
        assert.deepEqual(await sandbox.dataSource.query('SELECT "big", "big8", "price" FROM "amounts"'), [{ big: 42, big8: BEYOND, price: 1234.5 }]);
        assert.deepEqual(await sandbox.dataSource.query('SELECT "status", "priority" FROM "choices"'), [{ status: "draft", priority: 2 }]);
        const [{ bytes }] = await sandbox.dataSource.query('SELECT "bytes" FROM "attachments"');
        assert.ok(bytes instanceof Uint8Array && !Buffer.isBuffer(bytes));

        const raw = await repository(Flag).createQueryBuilder("flag").getRawOne();
        assert.deepEqual([raw.flag_enabled, raw.flag_verified], [1, 0]);
        const rawMoment = await repository(Moment).createQueryBuilder("moment").select(["moment.stamp", "moment.day"]).getRawOne();
        assert.deepEqual(rawMoment, { moment_stamp: "2026-01-02 03:04:05.678", moment_day: "2026-01-02" });
        const rawAmount = await repository(Amount).createQueryBuilder("amount").select("amount.price", "price").addSelect("amount.big8", "big8").getRawMany();
        assert.deepEqual(rawAmount, [{ price: 1234.5, big8: BEYOND }]);
        // The same query read as entities is converted.
        const entity = await repository(Flag).createQueryBuilder("flag").getOneOrFail();
        assert.deepEqual([entity.enabled, entity.verified], [true, false]);
      });

      it("takes the parameters of a raw query as they are given, with dates and booleans bound as SQLite holds them", async () => {
        await repository(Flag).save([{ enabled: true }, { enabled: false }]);
        await repository(Moment).save({ stamp: WHEN });
        assert.deepEqual(await sandbox.dataSource.query('SELECT COUNT(*) AS n FROM "flags" WHERE "enabled" = ?', [true]), [{ n: 1 }]);
        assert.deepEqual(await sandbox.dataSource.query('SELECT COUNT(*) AS n FROM "moments" WHERE "stamp" = $1', [WHEN]), [{ n: 1 }]);
      });
    });

    describe("TO_CHAR in the application's own SQL", () => {
      const moments = async (): Promise<void> => {
        await repository(Moment).save([
          { stamp: new Date("2026-01-02T03:04:05.678Z"), day: "2026-01-02" },
          { stamp: new Date("2026-01-20T22:00:00.000Z"), day: "2026-01-20" },
          { stamp: new Date("2026-02-14T13:07:09.000Z"), day: "2026-02-14" },
          { stamp: null, day: null },
        ]);
        events.length = 0;
      };

      it("formats, groups, and orders by a date in a QueryBuilder, as an application written for PostgreSQL asks", async () => {
        await moments();
        const monthly = await repository(Moment)
          .createQueryBuilder("moment")
          .select(`TO_CHAR(moment."stamp", 'YYYY-MM')`, "yearMonth")
          .addSelect("COUNT(moment.id)", "count")
          .where('moment."stamp" >= :from', { from: new Date("2026-01-01T00:00:00.000Z") })
          .groupBy(`TO_CHAR(moment."stamp", 'YYYY-MM')`)
          .orderBy(`TO_CHAR(moment."stamp", 'YYYY-MM')`, "ASC")
          .getRawMany();
        assert.deepEqual(monthly, [{ yearMonth: "2026-01", count: 2 }, { yearMonth: "2026-02", count: 1 }]);

        const daily = await repository(Moment)
          .createQueryBuilder("moment")
          .select(`TO_CHAR(moment."stamp", 'YYYY-MM-DD')`, "date")
          .addSelect("COUNT(moment.id)", "count")
          .groupBy(`TO_CHAR(moment."stamp", 'YYYY-MM-DD')`)
          .orderBy(`TO_CHAR(moment."stamp", 'YYYY-MM-DD')`, "DESC")
          .getRawMany();
        assert.deepEqual(daily, [{ date: "2026-02-14", count: 1 }, { date: "2026-01-20", count: 1 }, { date: "2026-01-02", count: 1 }, { date: null, count: 1 }]);

        // The statement that ran, and that is reported, is the one TypeORM wrote: TO_CHAR is still in it.
        const [first] = events.filter((event) => event.operation === "SELECT");
        assert.match(first?.sql ?? "", /^SELECT TO_CHAR\(moment\."stamp", 'YYYY-MM'\) AS "yearMonth", COUNT\("moment"\."id"\) AS "count" FROM "moments" "moment" WHERE .* GROUP BY TO_CHAR\(moment\."stamp", 'YYYY-MM'\) ORDER BY TO_CHAR\(moment\."stamp", 'YYYY-MM'\) ASC$/);
        assert.deepEqual([first?.tables, first?.returnedRows, first?.errorCode], [["moments"], 2, undefined]);
      });

      it("formats in a raw query with numbered parameters, and next to entity columns", async () => {
        await moments();
        assert.deepEqual(await sandbox.dataSource.query(`SELECT TO_CHAR("stamp", $1) AS at, TO_CHAR("day", 'DD/MM/YYYY') AS day FROM "moments" WHERE "id" = $2`, ["HH24:MI:SS.MS", 1]), [{ at: "03:04:05.678", day: "02/01/2026" }]);
        const withEntity = await repository(Moment).createQueryBuilder("moment").addSelect(`TO_CHAR(moment."stamp", 'YYYY')`, "year").where("moment.id = :id", { id: 3 }).getRawAndEntities();
        assert.equal(withEntity.raw[0].year, "2026");
        // The entity next to it is converted as ever.
        assert.deepEqual([withEntity.entities[0].stamp, withEntity.entities[0].day], [new Date("2026-02-14T13:07:09.000Z"), "2026-02-14"]);
      });

      it("fails with the sandbox's dialect error for a format it does not provide, inside TypeORM's own error", async () => {
        await moments();
        await assert.rejects(
          repository(Moment).createQueryBuilder("moment").select(`TO_CHAR(moment."stamp", 'Mon YYYY')`, "month").getRawMany(),
          (error: any) => {
            assert.equal(error.name, "QueryFailedError");
            assert.equal(error.driverError?.code, "SANDBOX_DIALECT_UNSUPPORTED");
            assert.match(error.message, /TO_CHAR: the pattern "Mon" in the format "Mon YYYY" is not supported/);
            return true;
          },
        );
        assert.equal(events.at(-1)?.errorCode, "SANDBOX_DIALECT_UNSUPPORTED");
        // The DataSource is as usable as before.
        assert.equal(await repository(Moment).count(), 4);
      });
    });

    describe("transactions", () => {
      it("commits converted values, and discards them with a rollback", async () => {
        await sandbox.dataSource.transaction(async (manager: any) => {
          await manager.save(Amount, { big: BEYOND, price: 10.125 });
          await manager.save(Flag, { enabled: true });
          await manager.save(Moment, { stamp: WHEN });
          // Inside the transaction the values already read as the application expects.
          assert.deepEqual((await manager.find(Amount)).map((amount: any) => [amount.big, amount.price]), [[BEYOND, "10.13"]]);
          assert.deepEqual(await fixture("amounts"), []);
        });
        assert.deepEqual((await fixture("amounts")).map((row) => [row.big, row.price]), [[BEYOND, 10.13]]);

        await assert.rejects(
          sandbox.dataSource.transaction(async (manager: any) => {
            await manager.save(Amount, { big: "1", price: "5" });
            await manager.update(Flag, { enabled: true }, { enabled: false });
            throw new Error("undo");
          }),
          /undo/,
        );
        assert.deepEqual((await repository(Amount).find()).map((amount: any) => [amount.big, amount.price]), [[BEYOND, "10.13"]]);
        assert.deepEqual((await repository(Flag).find()).map((flag: any) => flag.enabled), [true]);
        assert.deepEqual((await repository(Moment).find()).map((moment: any) => moment.stamp), [WHEN]);
      });
    });

    describe("persistence and a restart", () => {
      /** One row of every entity, and what an application reads of it. */
      const populate = async (): Promise<void> => {
        await repository(Flag).save({ enabled: true, verified: false });
        await repository(Moment).save({ stamp: WHEN, stampZone: WHEN, plain: WHEN, day: "2026-01-02", clock: "03:04:05" });
        await repository(Clock).save({ zoned: "03:04:05+08" });
        await repository(Paper).save({ json: { a: [1, 2] }, jsonb: [1, "two"], simple: { nested: true } });
        await repository(Choice).save({ status: Status.Published, priority: Priority.High, several: [Status.Draft] });
        await repository(Amount).save({ big: BEYOND, big8: "42", price: 10.125, rate: "0.5", ratio: 0.1, parsed: 2.5 });
        await repository(List).save({ simple: ["a", 1], numbers: [1, 2], times: [WHEN] });
        await repository(Identity).save({ ref: "0b0e6f5e-7c1d-4c0a-9a4e-2f6f3b1d9c11", name: "Ada" });
        await repository(Attachment).save({ id: "3f2a9c1e-5b7d-4e8f-a1b2-c3d4e5f60718", bytes: Buffer.from([0, 255]) });
      };
      const everything = async (): Promise<unknown[]> => {
        const rows: unknown[] = [];
        for (const entity of entities) {
          rows.push(await repository(entity).find({ withDeleted: true }));
        }
        return rows;
      };
      const expectLogical = async (): Promise<void> => {
        const [[flag], [moment], [clock], [paper], [choice], [amount], [list], [identity], [attachment]] = (await everything()) as any;
        assert.deepEqual([flag.enabled, flag.verified, flag.active], [true, false, true]);
        assert.deepEqual([moment.stamp, moment.stampZone, moment.plain, moment.day, moment.clock], [WHEN, WHEN, WHEN, "2026-01-02", "03:04:05"]);
        assert.ok(moment.createdAt instanceof Date && moment.updatedAt instanceof Date);
        assert.equal(clock.zoned, "03:04:05+08");
        assert.deepEqual([paper.json, paper.jsonb, paper.simple], [{ a: [1, 2] }, [1, "two"], { nested: true }]);
        assert.deepEqual([choice.status, choice.priority, choice.several], ["published", 2, ["draft"]]);
        assert.deepEqual([amount.big, amount.big8, amount.price, amount.rate, amount.ratio, amount.parsed, amount.balance], [BEYOND, "42", "10.13", "0.500000", 0.1, 2.5, "0.00"]);
        assert.deepEqual([list.simple, list.numbers, list.times], [["a", "1"], [1, 2], [WHEN]]);
        assert.deepEqual([identity.ref, identity.name], ["0b0e6f5e-7c1d-4c0a-9a4e-2f6f3b1d9c11", "Ada"]);
        assert.match(identity.id, UUID);
        assert.deepEqual([Buffer.isBuffer(attachment.bytes), attachment.bytes.toString("hex")], [true, "00ff"]);
      };

      it("reads the same application values from a single-file database after it is opened again", async () => {
        await populate();
        const before = await everything();
        await expectLogical();
        await restart();
        await expectLogical();
        assert.deepEqual(await everything(), before);

        // The file holds JSON values a person can read, not SQLite's.
        const data = JSON.parse(await readFile(file, "utf8")).data;
        assert.deepEqual([data.flags[0].enabled, data.moments[0].stamp, data.papers[0].jsonb, data.amounts[0].price, data.amounts[0].big, data.attachments[0].bytes], [true, "2026-01-02T03:04:05.678Z", [1, "two"], 10.13, BEYOND, "AP8="]);
      });

      it("reads the same application values from a database directory after it is opened again, and writes only the tables that changed", async () => {
        const directory = join(dir, "sandbox.db");
        await rm(directory, { recursive: true, force: true });
        await createDatabase(directory, { collections: {} });
        await sandbox.dataSource.destroy();
        sandbox = await open(directory);

        await populate();
        const before = await everything();
        await restart(directory);
        await expectLogical();
        assert.deepEqual(await everything(), before);
        assert.deepEqual([(await storedRows(directory, "flags"))[0]?.enabled, (await storedRows(directory, "amounts"))[0]?.big, (await storedRows(directory, "attachments"))[0]?.bytes], [true, BEYOND, "AP8="]);

        // A write to one table leaves the file of another as it is.
        const identity = (table: string): string => `${tableFile(directory, table)}:${statSync(tableFile(directory, table), { bigint: true }).mtimeNs}`;
        const untouched = identity("moments");
        const amounts = identity("amounts");
        await repository(Amount).update({ big: BEYOND }, { price: "20.005" });
        assert.equal(identity("moments"), untouched);
        assert.notEqual(identity("amounts"), amounts);
        assert.equal((await storedRows(directory, "amounts"))[0]?.price, 20.01);
        assert.ok(events.some((event) => event.operation === "UPDATE" && event.snapshotSaveMs !== undefined));
      });

      it("records the tables' storage types with the database, and the same ones each time it is opened", async () => {
        const directory = join(dir, "described.db");
        await createDatabase(directory, { collections: {} });
        await sandbox.dataSource.destroy();
        sandbox = await open(directory);
        const first = structuredClone(sandbox.runtime.schema);
        await repository(Flag).save({ enabled: true });
        await restart(directory);
        assert.deepEqual(sandbox.runtime.schema, first);

        const types = (table: string): Record<string, string> => Object.fromEntries((first.find((candidate) => candidate.name === table)?.columns ?? []).map((column) => [column.key ?? column.name, column.type]));
        assert.deepEqual(types("moments"), {
          id: "integer", stamp: "datetime", stampZone: "datetime", stampLong: "datetime", dateTime: "datetime", plain: "datetime",
          day: "date", clock: "text", createdAt: "datetime", updatedAt: "datetime", deletedAt: "datetime", version: "integer",
        });
        assert.deepEqual(types("amounts"), {
          id: "integer", big: "integer", big8: "integer", price: "numeric", rate: "numeric", loose: "numeric",
          ratio: "real", wide: "real", narrow: "real", count: "integer", small: "integer", balance: "numeric", parsed: "numeric",
        });
        assert.deepEqual(types("attachments"), { id: "text", bytes: "binary", blob: "binary", short: "binary" });
        assert.deepEqual(types("flags"), { id: "integer", enabled: "boolean", verified: "boolean", plain: "boolean", active: "boolean", archived: "boolean" });
      });
    });

    describe("the application's declarations", () => {
      it("are what they were once the sandbox is open: TypeORM's SQLite dialect got its types in the DataSource's own metadata", async () => {
        const declared = new Map<string, any>(
          (typeorm.getMetadataArgsStorage().columns as { target: unknown; propertyName: string; options: any }[]).map((column) => [`${(column.target as { name: string }).name}.${column.propertyName}`, column.options]),
        );
        const typeOf = (key: string): unknown => declared.get(key).type;
        assert.deepEqual(
          ["Moment.stampZone", "Moment.stampLong", "Paper.jsonb", "Choice.status", "Amount.big8", "Amount.price", "List.simple", "Identity.ref", "Attachment.bytes", "Clock.short"].map(typeOf),
          ["timestamptz", "timestamp with time zone", "jsonb", "enum", "int8", "decimal", "simple-array", "uuid", "bytea", "timetz"],
        );
        assert.deepEqual([declared.get("List.numbers").array, declared.get("Choice.several").array, typeof declared.get("Choice.several").enum], [true, true, "object"]);
        // No transformer of the sandbox's is left on the application's own declarations.
        assert.deepEqual([declared.get("Amount.price").transformer, declared.get("Identity.name").transformer, typeof declared.get("Amount.parsed").transformer.from], [undefined, undefined, "function"]);

        // The DataSource holds what its dialect was given instead.
        const built = (entity: unknown, property: string): unknown => sandbox.dataSource.getMetadata(entity).findColumnWithPropertyName(property).type;
        assert.deepEqual(
          [built(Moment, "stampZone"), built(Paper, "jsonb"), built(Choice, "status"), built(List, "simple"), built(Identity, "ref"), built(Attachment, "bytes"), built(Clock, "short")],
          ["datetime", "simple-json", "simple-enum", "simple-json", "varchar", "blob", "time"],
        );
      });

      it("give the same sandbox however often one is opened in the process", async () => {
        const first = structuredClone(sandbox.runtime.schema);
        await repository(Amount).save({ big: BEYOND, price: 10.125 });
        for (let round = 0; round < 3; round += 1) {
          await restart();
          assert.deepEqual(sandbox.runtime.schema, first);
          assert.deepEqual((await repository(Amount).find()).map((amount: any) => [amount.big, amount.price]), [[BEYOND, "10.13"]]);
        }
      });
    });
  });

  return version;
}
