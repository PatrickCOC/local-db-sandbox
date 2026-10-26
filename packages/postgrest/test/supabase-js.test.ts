import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { storedRows } from "../../storage-json/test/support/database-files.ts";
import { UNSUPPORTED } from "../src/index.ts";
import { clientFor, startHarness } from "./support.ts";
import type { Harness } from "./support.ts";

/*
 * The endpoint as an application sees it: every request here is made by
 * @supabase/supabase-js 2.116.0 (with @supabase/postgrest-js 2.116.0), the
 * version the validation target uses, created with a URL and a key only.
 */

/** Tests that change rows get a database of their own. */
async function withHarness(work: (harness: Harness) => Promise<void>, options: Parameters<typeof startHarness>[0] = {}): Promise<void> {
  const harness = await startHarness(options);
  try {
    await work(harness);
  } finally {
    await harness.close();
  }
}

describe("reads through supabase-js", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.close();
  });

  test("select returns the named columns only, in JSON's types", async () => {
    const { data, error, status } = await harness.client.from("teams").select("id, name, active").eq("id", 1);
    assert.equal(error, null);
    assert.equal(status, 200);
    assert.deepEqual(data, [{ id: 1, name: "Alpha", active: true }]);
  });

  test("select * returns every column of the table", async () => {
    const { data } = await harness.client.from("teams").select("*").eq("id", 2);
    assert.deepEqual(Object.keys(data?.[0] ?? {}), ["id", "name", "active", "founded", "meta", "budget", "big", "logo", "seen_at"]);
  });

  test("eq filters on a text and on a boolean column", async () => {
    assert.deepEqual((await harness.client.from("teams").select("id").eq("name", "Gamma")).data, [{ id: 3 }]);
    assert.deepEqual((await harness.client.from("teams").select("id").eq("active", false)).data, [{ id: 2 }, { id: 5 }]);
  });

  test("gte includes the bound", async () => {
    const { data } = await harness.client.from("teams").select("id").gte("id", 4);
    assert.deepEqual(data, [{ id: 4 }, { id: 5 }]);
  });

  test("lt excludes the bound", async () => {
    const { data } = await harness.client.from("teams").select("id").lt("id", 2);
    assert.deepEqual(data, [{ id: 1 }]);
  });

  test("filters combine with AND", async () => {
    const { data } = await harness.client.from("teams").select("id").eq("active", true).gte("id", 2).lt("id", 5);
    assert.deepEqual(data, [{ id: 3 }, { id: 4 }]);
  });

  test("range(from, to) is offset and limit, both ends included", async () => {
    const { data, error } = await harness.client.from("teams").select("id").range(1, 3);
    assert.equal(error, null);
    assert.deepEqual(data, [{ id: 2 }, { id: 3 }, { id: 4 }]);
    assert.deepEqual((await harness.client.from("teams").select("id").range(4, 9)).data, [{ id: 5 }]);
    assert.deepEqual((await harness.client.from("teams").select("id").range(10, 19)).data, []);
  });

  test("single() with one row returns the row as an object", async () => {
    const { data, error, status } = await harness.client.from("teams").select("name").eq("id", 3).single();
    assert.equal(error, null);
    assert.equal(status, 200);
    assert.deepEqual(data, { name: "Gamma" });
  });

  test("single() with no row is PostgREST's 406 PGRST116", async () => {
    const { data, error, status } = await harness.client.from("teams").select("name").eq("id", 99).single();
    assert.equal(data, null);
    assert.equal(status, 406);
    assert.deepEqual(error, { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "Cannot coerce the result to a single JSON object" });
  });

  test("single() with more than one row is PostgREST's 406 PGRST116", async () => {
    const { data, error, status } = await harness.client.from("teams").select("name").eq("active", true).single();
    assert.equal(data, null);
    assert.equal(status, 406);
    assert.equal(error?.code, "PGRST116");
    assert.equal(error?.details, "The result contains 3 rows");
  });

  test("maybeSingle() with no row gives null and no error", async () => {
    const { data, error, status } = await harness.client.from("teams").select("name").eq("id", 99).maybeSingle();
    assert.equal(data, null);
    assert.equal(error, null);
    assert.equal(status, 200);
  });

  test("maybeSingle() with one row gives the object", async () => {
    const { data, error } = await harness.client.from("teams").select("name").eq("id", 1).maybeSingle();
    assert.equal(error, null);
    assert.deepEqual(data, { name: "Alpha" });
  });

  test("maybeSingle() with several rows is the client's own PGRST116", async () => {
    const { data, error } = await harness.client.from("teams").select("name").eq("active", true).maybeSingle();
    assert.equal(data, null);
    assert.equal(error?.code, "PGRST116");
  });

  test("an unknown table and an unknown column are PostgREST's errors", async () => {
    const table = await harness.client.from("nope").select("*");
    assert.equal(table.status, 404);
    assert.equal(table.error?.code, "PGRST205");
    const column = await harness.client.from("teams").select("nope");
    assert.equal(column.status, 400);
    assert.equal(column.error?.code, "42703");
    assert.equal((await harness.client.from("teams").select("id").eq("nope", 1)).error?.code, "42703");
  });

  test("a filter value that does not fit the column is PostgreSQL's invalid input", async () => {
    const { error, status } = await harness.client.from("teams").select("id").eq("id", "abc");
    assert.equal(status, 400);
    assert.equal(error?.code, "22P02");
    assert.match(error?.message ?? "", /invalid input syntax for type int4: "abc"/);
    assert.equal((await harness.client.from("readings").select("sensor").gte("taken_at", "not a time")).error?.code, "22007");
  });
});

describe("rows per read are capped at maxRows, as db-max-rows on Supabase", () => {
  test("a read without a limit, or with a larger one, returns at most maxRows rows", async () => {
    await withHarness(
      async ({ client }) => {
        assert.deepEqual((await client.from("teams").select("id")).data, [{ id: 1 }, { id: 2 }]);
        assert.deepEqual((await client.from("teams").select("id").range(0, 999)).data, [{ id: 1 }, { id: 2 }]);
        assert.deepEqual((await client.from("teams").select("id").range(2, 3)).data, [{ id: 3 }, { id: 4 }]);
      },
      { maxRows: 2 },
    );
  });
});

describe("unsupported PostgREST features are refused, never ignored", () => {
  let harness: Harness;
  before(async () => {
    harness = await startHarness();
  });
  after(async () => {
    await harness.close();
  });

  const refused = async (result: PromiseLike<{ error: { code: string; message: string } | null; status: number; data: unknown }>, what: RegExp): Promise<void> => {
    const { error, status, data } = await result;
    assert.equal(status, 501, `status ${status}: ${JSON.stringify(error)}`);
    assert.equal(data, null);
    assert.equal(error?.code, UNSUPPORTED);
    assert.match(error?.message ?? "", what);
  };

  test("other filter operators", async () => {
    const teams = () => harness.client.from("teams").select("id");
    await refused(teams().neq("id", 1), /"neq"/);
    await refused(teams().gt("id", 1), /"gt"/);
    await refused(teams().lte("id", 1), /"lte"/);
    await refused(teams().like("name", "A%"), /"like"/);
    await refused(teams().ilike("name", "a%"), /"ilike"/);
    await refused(teams().in("id", [1, 2]), /"in"/);
    await refused(teams().is("founded", null), /"is"/);
    await refused(teams().contains("meta", { tags: ["a"] }), /"cs"/);
    await refused(teams().textSearch("name", "alpha"), /"fts"/);
  });

  test("negation, logical trees, and modifiers", async () => {
    const teams = () => harness.client.from("teams").select("id");
    await refused(teams().not("id", "eq", 1), /Negated filters/);
    await refused(teams().or("id.eq.1,id.eq.2"), /Logical filters \(or=\)/);
    await refused(teams().likeAnyOf("name", ["A%"]), /Filter modifiers/);
  });

  test("an operator PostgREST does not have is its parse error", async () => {
    const { error, status } = await harness.client.from("teams").select("id").filter("id", "zz", "1");
    assert.equal(status, 400);
    assert.equal(error?.code, "PGRST100");
  });

  test("embedded resources, renames, casts, and JSON paths in select", async () => {
    await refused(harness.client.from("teams").select("id, readings(*)"), /Embedded resources/);
    await refused(harness.client.from("readings").select("sensor, teams!inner(name)"), /Embedded resources/);
    await refused(harness.client.from("teams").select("label:name"), /Renamed columns/);
    await refused(harness.client.from("teams").select("id::text"), /Casts/);
    await refused(harness.client.from("teams").select("meta->tags"), /JSON paths/);
    await refused(harness.client.from("teams").select("count()"), /Aggregate functions/);
  });

  test("order and count", async () => {
    await refused(harness.client.from("teams").select("id").order("id"), /Ordering/);
    await refused(harness.client.from("teams").select("id", { count: "exact" }), /Counting rows/);
    const head = await harness.client.from("teams").select("id", { head: true });
    assert.equal(head.status, 501);
  });

  test("writes outside upsert by primary key", async () => {
    await refused(harness.client.from("teams").insert({ id: 9, name: "New" }), /An insert without Prefer: resolution=merge-duplicates/);
    await refused(harness.client.from("teams").update({ name: "X" }).eq("id", 1), /Updating rows \(PATCH/);
    await refused(harness.client.from("teams").upsert({ id: 1, name: "X" }, { ignoreDuplicates: true }), /resolution=ignore-duplicates/);
    await refused(harness.client.from("teams").upsert({ id: 1, name: "X" }).select(), /Returning the written rows/);
    await refused(harness.client.from("teams").upsert({ id: 1, name: "X" }, { onConflict: "name" }), /on_conflict=name/);
    await refused(harness.client.from("teams").upsert({ id: 1, name: "X" }, { count: "exact" }), /Counting rows/);
    await refused(harness.client.from("teams").upsert({ id: 1, name: "X" }, { defaultToNull: false }), /missing=default/);
    await refused(harness.client.from("teams").delete().eq("id", 1).select(), /Returning the deleted rows/);
    // Nothing of these was written.
    assert.deepEqual((await harness.client.from("teams").select("name").eq("id", 1)).data, [{ name: "Alpha" }]);
  });

  test("RPC, Storage, Edge Functions, and Auth are other services the sandbox does not provide", async () => {
    await refused(harness.client.rpc("anything", { a: 1 }), /Calling database functions/);
    const storage = await harness.client.storage.from("bucket").list();
    assert.equal(storage.data, null);
    assert.ok(storage.error);
    const invoked = await harness.client.functions.invoke("sync");
    assert.equal(invoked.data, null);
    assert.equal(((await (invoked.response as Response | undefined)?.json()) as { code?: string } | undefined)?.code, UNSUPPORTED);
    const signIn = await harness.client.auth.signInWithPassword({ email: "a@example.com", password: "x" });
    assert.equal(signIn.data.user, null);
    assert.ok(signIn.error);
  });
});

describe("upsert by primary key", () => {
  test("a row whose key is new is inserted; a missing nullable column is NULL", async () => {
    await withHarness(async ({ client }) => {
      const { error, status, data } = await client.from("teams").upsert({ id: 6, name: "Zeta", active: true });
      assert.equal(error, null);
      assert.equal(status, 201);
      assert.equal(data, null);
      assert.deepEqual((await client.from("teams").select("id, name, active, founded").eq("id", 6).single()).data, { id: 6, name: "Zeta", active: true, founded: null });
    });
  });

  test("a row whose key exists updates the columns it gives and leaves the others", async () => {
    await withHarness(async ({ client }) => {
      assert.equal((await client.from("teams").upsert({ id: 1, name: "Alpha 2" })).error, null);
      assert.deepEqual((await client.from("teams").select("id, name, budget, active").eq("id", 1).single()).data, { id: 1, name: "Alpha 2", budget: 12.5, active: true });
      assert.equal((await client.from("teams").select("id")).data?.length, 5);
    });
  });

  test("an array updates and inserts on a composite key; keys a row lacks are NULL, as with columns=", async () => {
    await withHarness(async ({ client }) => {
      const { error } = await client.from("readings").upsert([
        { taken_at: "2026-10-06T08:00:00Z", sensor: "s1", value: 10, team_id: 3 },
        { taken_at: "2026-10-08T00:00:00Z", sensor: "s3", value: 11 },
      ]);
      assert.equal(error, null);
      const { data } = await client.from("readings").select("taken_at, sensor, value, team_id").gte("taken_at", "2026-10-06T08:00:00Z").lt("taken_at", "2026-10-06T09:00:00Z");
      assert.deepEqual(data, [{ taken_at: "2026-10-06T08:00:00+00:00", sensor: "s1", value: 10, team_id: 3 }]);
      assert.deepEqual((await client.from("readings").select("value, team_id").eq("sensor", "s3").single()).data, { value: 11, team_id: null });
      assert.equal((await client.from("readings").select("sensor")).data?.length, 5);
    });
  });

  test("on_conflict naming the primary key is accepted; an empty array writes nothing", async () => {
    await withHarness(async ({ client }) => {
      assert.equal((await client.from("readings").upsert({ taken_at: "2026-10-06T08:00:00Z", sensor: "s1", value: 5 }, { onConflict: "sensor,taken_at" })).error, null);
      assert.deepEqual((await client.from("readings").select("value").eq("sensor", "s1").lt("taken_at", "2026-10-06T09:00:00Z").single()).data, { value: 5 });
      const empty = await client.from("readings").upsert([]);
      assert.equal(empty.error, null);
      assert.equal(empty.status, 201);
    });
  });

  test("a column the table does not have is PostgREST's PGRST204", async () => {
    await withHarness(async ({ client }) => {
      const { error, status } = await client.from("teams").upsert({ id: 1, nope: 1 });
      assert.equal(status, 400);
      assert.equal(error?.code, "PGRST204");
      assert.equal(error?.message, "Could not find the 'nope' column of 'teams' in the schema cache");
    });
  });
});

describe("delete", () => {
  test("deletes the rows the filters match, and no others", async () => {
    await withHarness(async ({ client }) => {
      const { error, status, data } = await client.from("readings").delete().lt("taken_at", "2026-10-06T12:00:00Z");
      assert.equal(error, null);
      assert.equal(status, 204);
      assert.equal(data, null);
      assert.deepEqual((await client.from("readings").select("value")).data, [{ value: 2 }, { value: 3 }, { value: 4 }]);
      assert.equal((await client.from("readings").delete().eq("sensor", "s1").eq("value", 3)).error, null);
      assert.deepEqual((await client.from("readings").select("value")).data, [{ value: 2 }, { value: 4 }]);
    });
  });

  test("foreign keys cascade as declared", async () => {
    await withHarness(async ({ client }) => {
      assert.equal((await client.from("teams").delete().eq("id", 2)).error, null);
      assert.deepEqual((await client.from("readings").select("value")).data, [{ value: 1 }, { value: 2 }]);
    });
  });

  test("a delete without a filter is refused, as Supabase's pg-safeupdate does", async () => {
    await withHarness(async ({ client }) => {
      const { error, status } = await client.from("readings").delete();
      assert.equal(status, 400);
      assert.equal(error?.code, "21000");
      assert.equal((await client.from("readings").select("value")).data?.length, 4);
    });
  });
});

describe("date-time values", () => {
  test("every spelling of a moment is stored in the runtime's one form", async () => {
    await withHarness(async ({ client, sandbox }) => {
      const spellings = ["2026-10-09T12:00:00Z", "2026-10-09 12:00:00+00", "2026-10-09T20:00:00+08:00", "2026-10-09T12:00:00.000000+00:00", "2026-10-09 12:00:00"];
      for (const [index, spelling] of spellings.entries()) {
        assert.equal((await client.from("readings").upsert({ taken_at: spelling, sensor: "same", value: index })).error, null);
      }
      // The same key every time: one row, updated by each.
      assert.deepEqual(sandbox.runtime.execute(`SELECT taken_at, value FROM readings WHERE sensor = 'same'`).rows, [{ taken_at: "2026-10-09 12:00:00.000", value: 4 }]);
      // Rows of the fixture and rows written through the endpoint are held alike.
      for (const { taken_at } of sandbox.runtime.execute("SELECT taken_at FROM readings").rows) {
        assert.match(String(taken_at), /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/);
      }
      const updated = await client.from("teams").upsert({ id: 1, name: "Alpha", seen_at: "2026-10-06T23:59:59.5+01:00" });
      assert.equal(updated.error, null);
      assert.deepEqual(sandbox.runtime.execute("SELECT seen_at FROM teams WHERE id = 1").rows, [{ seen_at: "2026-10-06 22:59:59.500" }]);
      assert.deepEqual((await client.from("teams").select("seen_at").eq("id", 1).single()).data, { seen_at: "2026-10-06T22:59:59.5+00:00" });
    });
  });

  test("comparisons on the same day are by moment, whatever the spelling of the bound", async () => {
    await withHarness(async ({ client }) => {
      // Written through the endpoint, between the fixture's rows of the same day.
      assert.equal((await client.from("readings").upsert({ taken_at: "2026-10-06T11:59:59.999Z", sensor: "s9", value: 9 })).error, null);
      for (const bound of ["2026-10-06T12:00:00Z", "2026-10-06 12:00:00", "2026-10-06 12:00:00+00", "2026-10-06T14:00:00+02:00"]) {
        const later = await client.from("readings").select("value").gte("taken_at", bound);
        assert.deepEqual(later.data, [{ value: 2 }, { value: 3 }, { value: 4 }], `gte ${bound}`);
        const earlier = await client.from("readings").select("value").lt("taken_at", bound);
        assert.deepEqual(earlier.data, [{ value: 1 }, { value: 9 }], `lt ${bound}`);
      }
      assert.deepEqual((await client.from("readings").select("value").eq("taken_at", "2026-10-06T12:00:00.000+00:00")).data, [{ value: 2 }]);
    });
  });
});

describe("values of each column type", () => {
  test("boolean, JSON, decimal, 64-bit integer, binary, and date go in and come out as PostgREST's JSON has them", async () => {
    await withHarness(async ({ client, sandbox }) => {
      const { error } = await client.from("teams").upsert({
        id: 7,
        name: 42,
        active: false,
        founded: "1999-12-31",
        meta: { nested: { list: [1, "two", null] }, flag: true },
        budget: "12.50",
        big: "9007199254740993",
        logo: "\\x00ff10",
        seen_at: null,
      });
      assert.equal(error, null);
      assert.deepEqual(sandbox.runtime.execute("SELECT name, active, meta, budget, big, typeof(big) AS bigType FROM teams WHERE id = 7").rows, [
        { name: "42", active: 0, meta: '{"nested":{"list":[1,"two",null]},"flag":true}', budget: 12.5, big: "9007199254740993", bigType: "integer" },
      ]);
      const { data } = await client.from("teams").select("*").eq("id", 7).single();
      assert.deepEqual(data, {
        id: 7,
        name: "42",
        active: false,
        founded: "1999-12-31",
        meta: { nested: { list: [1, "two", null] }, flag: true },
        budget: 12.5,
        big: "9007199254740993",
        logo: "\\x00ff10",
        seen_at: null,
      });
      // Filters on these types use the same conversion.
      assert.deepEqual((await client.from("teams").select("id").eq("big", "9007199254740993")).data, [{ id: 7 }]);
      assert.deepEqual((await client.from("teams").select("id").eq("budget", "12.500")).data, [{ id: 1 }, { id: 7 }]);
      assert.deepEqual((await client.from("teams").select("id").eq("active", "f").gte("id", 6)).data, [{ id: 7 }]);
      assert.deepEqual((await client.from("teams").select("id").eq("founded", "1999-12-31")).data, [{ id: 7 }]);
      assert.equal((await client.from("teams").select("id").eq("meta", "{}")).status, 501);
      // A 64-bit integer that a number holds is a number.
      assert.deepEqual((await client.from("teams").select("big").eq("id", 1).single()).data, { big: 7 });
    });
  });

  test("a body value that does not fit its column is PostgreSQL's invalid input, and nothing is written", async () => {
    await withHarness(async ({ client }) => {
      const rows: Record<string, unknown>[] = [{ id: 1.5, name: "x" }, { id: 8, name: "x", active: "maybe" }, { id: 8, name: "x", seen_at: "yesterday" }, { id: 8, name: "x", logo: "AAEC" }, { id: 8, name: "x", budget: {} }];
      for (const row of rows) {
        const { error, status } = await client.from("teams").upsert(row);
        assert.equal(status, 400, JSON.stringify(row));
        assert.match(error?.code ?? "", /^22(P02|007)$/);
      }
      assert.equal((await client.from("teams").select("id")).data?.length, 5);
    });
  });
});

describe("persistence and transactions", () => {
  test("committed writes are in the database directory and survive a restart", async () => {
    await withHarness(async (harness) => {
      await harness.client.from("teams").upsert({ id: 1, name: "Renamed", seen_at: "2026-10-06T12:00:00Z" });
      await harness.client.from("readings").delete().eq("sensor", "s2");
      const stored = await storedRows(harness.database, "teams");
      assert.deepEqual(stored.find((row) => row.id === 1), { id: 1, name: "Renamed", active: true, founded: "2001-02-03", meta: { tags: ["a"] }, budget: 12.5, big: 7, logo: null, seen_at: "2026-10-06T12:00:00.000Z" });
      await harness.restart();
      assert.deepEqual((await harness.client.from("teams").select("name, seen_at").eq("id", 1).single()).data, { name: "Renamed", seen_at: "2026-10-06T12:00:00+00:00" });
      assert.deepEqual((await harness.client.from("readings").select("sensor").eq("sensor", "s2")).data, []);
    });
  });

  test("with save: false nothing is written back", async () => {
    await withHarness(
      async (harness) => {
        assert.equal(harness.sandbox.saves, false);
        await harness.client.from("teams").upsert({ id: 1, name: "Gone" });
        assert.equal((await storedRows(harness.database, "teams")).find((row) => row.id === 1)?.name, "Alpha");
      },
      { save: false },
    );
  });

  test("an upsert of many rows that fails on one writes none of them", async () => {
    await withHarness(async (harness) => {
      const notNull = await harness.client.from("teams").upsert([
        { id: 20, name: "Fine" },
        { id: 21, name: null },
      ]);
      assert.equal(notNull.status, 400);
      assert.equal(notNull.error?.code, "23502");
      const foreignKey = await harness.client.from("readings").upsert([
        { taken_at: "2026-10-10T00:00:00Z", sensor: "ok", value: 1, team_id: 1 },
        { taken_at: "2026-10-10T00:00:00Z", sensor: "bad", value: 1, team_id: 404 },
      ]);
      assert.equal(foreignKey.status, 409);
      assert.equal(foreignKey.error?.code, "23503");
      assert.equal(harness.sandbox.runtime.inTransaction, false);
      assert.deepEqual((await harness.client.from("teams").select("id").gte("id", 20)).data, []);
      assert.deepEqual((await harness.client.from("readings").select("sensor").gte("taken_at", "2026-10-10T00:00:00Z")).data, []);
      await harness.restart();
      assert.equal((await harness.client.from("teams").select("id")).data?.length, 5);
      assert.equal((await harness.client.from("readings").select("sensor")).data?.length, 4);
    });
  });

  test("an upsert larger than SQLite's limit of bound values is split, and still one transaction", async () => {
    await withHarness(async (harness) => {
      const rows = Array.from({ length: 9000 }, (_, index) => ({ taken_at: new Date(Date.UTC(2027, 0, 1) + index * 1000).toISOString(), sensor: "bulk", value: index, team_id: index === 8999 ? 404 : 1 }));
      assert.equal((await harness.client.from("readings").upsert(rows)).error?.code, "23503");
      assert.deepEqual(harness.sandbox.runtime.execute("SELECT COUNT(*) AS n FROM readings WHERE sensor = 'bulk'").rows, [{ n: 0 }]);
      const last = rows.at(-1) as { team_id: number };
      last.team_id = 1;
      assert.equal((await harness.client.from("readings").upsert(rows)).error, null);
      assert.deepEqual(harness.sandbox.runtime.execute("SELECT COUNT(*) AS n FROM readings WHERE sensor = 'bulk'").rows, [{ n: 9000 }]);
    }, { maxRows: null });
  });
});

describe("SQL tracing", () => {
  test("each request's statements carry its request ID and are numbered; the request event counts them", async () => {
    await withHarness(async (harness) => {
      const client = clientFor(harness.sandbox.url, { "x-request-id": "trace-1" });
      await client.from("teams").select("id").eq("name", "Beta");
      const tagged = clientFor(harness.sandbox.url, { "x-request-id": "trace-2" });
      await tagged.from("teams").upsert({ id: 2, name: "Beta 2" });

      const read = harness.sql.filter((event) => event.requestId === "trace-1");
      assert.equal(read.length, 1);
      assert.equal(read[0]?.operation, "SELECT");
      assert.equal(read[0]?.sequence, 1);
      assert.equal(read[0]?.sql, 'SELECT "id" FROM "teams" WHERE "name" = ? LIMIT 1000');
      assert.deepEqual(read[0]?.parameters, ["Beta"]);
      assert.deepEqual(read[0]?.resultPreview, [{ id: 2 }]);

      const write = harness.sql.filter((event) => event.requestId === "trace-2");
      assert.deepEqual(write.map((event) => [event.sequence, event.operation, event.transaction]), [
        [1, "TRANSACTION", "BEGIN"],
        [2, "INSERT", undefined],
        [3, "TRANSACTION", "COMMIT"],
      ]);
      assert.ok((write[2]?.snapshotSaveMs ?? 0) > 0);

      const requests = harness.requests.filter((event) => event.requestId.startsWith("trace-"));
      assert.deepEqual(requests.map((event) => [event.requestId, event.method, event.status, event.sqlCount]), [
        ["trace-1", "GET", 200, 1],
        ["trace-2", "POST", 201, 3],
      ]);
      // The key a client sends is in no event.
      assert.doesNotMatch(JSON.stringify([harness.sql, harness.requests]), /local-anon-key/);
    });
  });

  test("a request without an ID gets one, and it is returned to the client", async () => {
    await withHarness(async (harness) => {
      const response = await fetch(`${harness.sandbox.url}/rest/v1/teams?select=id&id=eq.1`);
      const id = response.headers.get("x-request-id");
      assert.match(id ?? "", /^req-\d+$/);
      assert.equal(harness.sql.at(-1)?.requestId, id);
    });
  });
});
