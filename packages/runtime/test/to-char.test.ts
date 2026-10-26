import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { DatabaseState, Row } from "../../core/src/index.ts";
import { SandboxDialectUnsupportedError, SqliteRuntime, formatSqlEvent } from "../src/index.ts";
import type { SnapshotStorage, SqlEvent, TableSchema } from "../src/index.ts";

/*
 * TO_CHAR for dates and date-times: the one function of another database
 * that the runtime provides itself, as a function SQLite calls. The SQL that
 * calls it is not rewritten. The tables here are made up for the test.
 */

/** A storage that can store single tables, and records which ones it was given. */
class TableStorage implements SnapshotStorage {
  saves: string[][] = [];
  collections: Record<string, Row[]>;

  constructor(collections: Record<string, Row[]>) {
    this.collections = structuredClone(collections);
  }

  async load(): Promise<DatabaseState> {
    return { meta: { version: 3 }, collections: structuredClone(this.collections) };
  }

  saveSync(state: DatabaseState): void {
    this.collections = structuredClone(state.collections);
    this.saves.push(Object.keys(state.collections));
  }

  saveTablesSync(tables: Record<string, Row[]>): void {
    this.collections = { ...this.collections, ...structuredClone(tables) };
    this.saves.push(Object.keys(tables));
  }
}

const SCHEMA: TableSchema[] = [
  {
    name: "visits",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "at", type: "datetime", nullable: true, primary: false },
      { name: "day", type: "date", nullable: true, primary: false },
      { name: "label", type: "text", nullable: true, primary: false },
      { name: "amount", type: "numeric", nullable: true, primary: false },
    ],
  },
  { name: "notes", columns: [{ name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true }, { name: "text", type: "text", nullable: true, primary: false }] },
];
const VISITS: Row[] = [
  { id: 1, at: "2026-01-02T03:04:05.678Z", day: "2026-01-02", label: "first", amount: 12.5 },
  { id: 2, at: "2026-01-02T23:59:59.000Z", day: "2026-01-02", label: "late", amount: 1 },
  { id: 3, at: "2026-02-14T13:07:09.045Z", day: "2026-02-14", label: "afternoon", amount: 2 },
  { id: 4, at: null, day: null, label: "never", amount: null },
];
/** 2026-01-02 03:04:05.678 and 2026-02-14 13:07:09.045, as SQLite holds the first and third rows. */
const MORNING = "2026-01-02 03:04:05.678";
const AFTERNOON = "2026-02-14 13:07:09.045";

describe("TO_CHAR", () => {
  let storage: TableStorage;
  let runtime: SqliteRuntime;
  let events: SqlEvent[];

  const one = (sql: string, parameters: (string | number | null | boolean | Date)[] = []): unknown => Object.values(runtime.execute(sql, parameters).rows[0] as Row)[0];
  const format = (value: string | null, pattern: string | null): unknown => one("SELECT TO_CHAR(?, ?)", [value, pattern]);
  const refused = (run: () => unknown, message: RegExp): void => {
    assert.throws(run, (error) => {
      assert.ok(error instanceof SandboxDialectUnsupportedError, String(error));
      assert.equal(error.code, "SANDBOX_DIALECT_UNSUPPORTED");
      assert.match(error.message, message);
      return true;
    });
  };

  beforeEach(async () => {
    storage = new TableStorage({ visits: VISITS, notes: [] });
    runtime = await SqliteRuntime.open({ schema: SCHEMA, storage });
    events = [];
    runtime.subscribe((event) => events.push(event));
  });

  describe("the patterns it provides", () => {
    it("formats each field of a date-time", () => {
      const cases: [string, string, string][] = [
        ["YYYY", MORNING, "2026"],
        ["YY", MORNING, "26"],
        ["MM", MORNING, "01"],
        ["DD", MORNING, "02"],
        ["HH24", MORNING, "03"],
        ["HH24", AFTERNOON, "13"],
        ["HH12", AFTERNOON, "01"],
        ["HH", AFTERNOON, "01"],
        ["HH12", "2026-01-02 00:30:00", "12"],
        ["HH12", "2026-01-02 12:30:00", "12"],
        ["MI", MORNING, "04"],
        ["SS", MORNING, "05"],
        ["MS", MORNING, "678"],
        ["MS", AFTERNOON, "045"],
        ["AM", MORNING, "AM"],
        ["PM", MORNING, "AM"],
        ["AM", AFTERNOON, "PM"],
        ["am", AFTERNOON, "pm"],
        ["pm", MORNING, "am"],
      ];
      for (const [pattern, value, expected] of cases) {
        assert.equal(format(value, pattern), expected, `TO_CHAR('${value}', '${pattern}')`);
      }
    });

    it("recognizes the numeric patterns in any case, as PostgreSQL does", () => {
      assert.equal(format(AFTERNOON, "yyyy-mm-dd hh24:mi:ss.ms"), "2026-02-14 13:07:09.045");
      assert.equal(format(AFTERNOON, "Yyyy/Mm/Dd"), "2026/02/14");
    });

    it("copies punctuation, spaces, digits, and text in double quotes", () => {
      assert.equal(format(MORNING, "YYYY-MM-DD"), "2026-01-02");
      assert.equal(format(MORNING, "YYYY-MM"), "2026-01");
      assert.equal(format(MORNING, "YYYY/MM/DD"), "2026/01/02");
      assert.equal(format(MORNING, "HH24:MI"), "03:04");
      assert.equal(format(MORNING, "DD.MM.YYYY, HH24:MI:SS"), "02.01.2026, 03:04:05");
      assert.equal(format(MORNING, "YYYYMMDD"), "20260102");
      assert.equal(format(MORNING, "YYYYMMDDHH24MISS"), "20260102030405");
      // A digit is copied: the first day of the value's month.
      assert.equal(format(MORNING, "YYYY-MM-01"), "2026-01-01");
      assert.equal(format(MORNING, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), "2026-01-02T03:04:05Z");
      assert.equal(format(MORNING, '"Day "DD" of month "MM'), "Day 02 of month 01");
      assert.equal(format(MORNING, '"a \\"quoted\\" word" YYYY'), 'a "quoted" word 2026');
      assert.equal(format(MORNING, "HH12:MI AM"), "03:04 AM");
      assert.equal(format(AFTERNOON, "HH12:MI am"), "01:07 pm");
      assert.equal(format(MORNING, ""), "");
      assert.equal(format(MORNING, "--"), "--");
    });
  });

  describe("the values it reads", () => {
    it("returns NULL for a NULL value or a NULL format", () => {
      assert.deepEqual([format(null, "YYYY-MM-DD"), format(MORNING, null), format(null, null)], [null, null, null]);
      assert.deepEqual(runtime.execute("SELECT id, TO_CHAR(at, 'YYYY-MM-DD') AS day FROM visits WHERE id IN (1, 4) ORDER BY id").rows, [{ id: 1, day: "2026-01-02" }, { id: 4, day: null }]);
    });

    it("reads SQLite's date-time text, ISO 8601 text, and a day alone", () => {
      const pattern = "YYYY-MM-DD HH24:MI:SS.MS";
      for (const [value, expected] of [
        ["2026-01-02 03:04:05.678", "2026-01-02 03:04:05.678"],
        ["2026-01-02 03:04:05", "2026-01-02 03:04:05.000"],
        ["2026-01-02 03:04", "2026-01-02 03:04:00.000"],
        ["2026-01-02T03:04:05.678Z", "2026-01-02 03:04:05.678"],
        ["2026-01-02T03:04:05Z", "2026-01-02 03:04:05.000"],
        ["2026-01-02T03:04:05.678901", "2026-01-02 03:04:05.678"],
        ["2026-01-02", "2026-01-02 00:00:00.000"],
        ["  2026-01-02 03:04:05  ", "2026-01-02 03:04:05.000"],
        ["2024-02-29 00:00:00", "2024-02-29 00:00:00.000"],
      ] as const) {
        assert.equal(format(value, pattern), expected, value);
      }
    });

    it("formats the fields as they are held, in UTC, and brings text with an offset to UTC first", () => {
      assert.equal(format("2026-01-02T03:04:05+00:00", "YYYY-MM-DD HH24:MI"), "2026-01-02 03:04");
      // 03:04 at +08:00 is 19:04 of the day before in UTC, as SQLite's own datetime() reads it.
      assert.equal(format("2026-01-02T03:04:05+08:00", "YYYY-MM-DD HH24:MI"), "2026-01-01 19:04");
      assert.equal(format("2026-01-02 03:04:05-0530", "YYYY-MM-DD HH24:MI"), "2026-01-02 08:34");
      assert.equal(one("SELECT TO_CHAR('2026-01-02T03:04:05+08:00', 'YYYY-MM-DD HH24:MI') = strftime('%Y-%m-%d %H:%M', '2026-01-02T03:04:05+08:00')"), 1);
    });

    it("reads a Date that is bound as a parameter, and the runtime's own date and date-time columns", () => {
      assert.equal(one("SELECT TO_CHAR(?, 'YYYY-MM-DD HH24:MI:SS.MS')", [new Date("2026-01-02T03:04:05.678Z")]), "2026-01-02 03:04:05.678");
      assert.deepEqual(runtime.execute("SELECT TO_CHAR(at, 'HH24:MI') AS time, TO_CHAR(day, 'DD/MM/YYYY') AS day FROM visits WHERE id = 3").rows, [{ time: "13:07", day: "14/02/2026" }]);
    });

    it("refuses text that is not a date, and a date that does not exist", () => {
      for (const value of ["yesterday", "", "12:30:00", "2026-13-01", "2026-02-30", "2025-02-29 00:00:00", "2026-01-02 24:00:00", "2026-01-02 03:60:00", "20260102", "02/01/2026"]) {
        refused(() => format(value, "YYYY-MM-DD"), /TO_CHAR: .* is not a date or a date-time it can read: it reads YYYY-MM-DD, alone or followed by a time\./);
      }
    });
  });

  describe("what it does not provide", () => {
    it("refuses every other pattern of PostgreSQL's TO_CHAR by name, and never answers with something close", () => {
      const patterns = [
        "Month", "MONTH", "Mon", "Day", "Dy", "D", "DDD", "ID", "IDDD", "IW", "WW", "W", "Q", "CC", "J", "RM", "YYY", "Y", "Y,YYY", "IYYY", "IY",
        "SSSS", "SSSSS", "US", "FF3", "TZ", "tz", "TZH", "OF", "A.M.", "p.m.", "BC", "AD",
      ];
      for (const pattern of patterns) {
        refused(() => format(MORNING, pattern), /TO_CHAR: the pattern ".+" in the format ".*" is not supported\. The sandbox's TO_CHAR formats a date or a date-time with YYYY, YY, MM, DD, HH24, HH12, HH, MI, SS, MS, AM, PM/);
      }
      // Seconds since midnight is not seconds twice, and a day with an ordinal suffix is not a day and some text.
      refused(() => format(MORNING, "SSSS"), /the pattern "SSSS"/);
      refused(() => format(MORNING, "DDth"), /the pattern "th"/);
      refused(() => format(MORNING, "FMMonth"), /the pattern "FM"/);
      refused(() => format(MORNING, "YYYY-MM-DD TZ"), /the pattern "TZ"/);
      refused(() => format(MORNING, "TMDay"), /the pattern "TM"/);
    });

    it("refuses letters that are no pattern, which have to be in double quotes to be copied", () => {
      refused(() => format(MORNING, "YYYY-MM-DDTHH24:MI"), /TO_CHAR: the pattern "TH" in the format "YYYY-MM-DDTHH24:MI" is not supported/);
      refused(() => format(MORNING, "YYYY-MM-DD at HH24:MI"), /TO_CHAR: "at" in the format "YYYY-MM-DD at HH24:MI" is not a pattern\. Text that is to be copied has to be in double quotes\./);
      refused(() => format(MORNING, "xyz"), /"xyz" in the format "xyz" is not a pattern/);
    });

    it("refuses to format a number", () => {
      refused(() => one("SELECT TO_CHAR(1234.5, '9999.99')"), /TO_CHAR: formatting a number \(1234\.5\) is not supported/);
      refused(() => one("SELECT TO_CHAR(amount, '999') FROM visits WHERE id = 1"), /formatting a number \(12\.5\) is not supported/);
      refused(() => one("SELECT TO_CHAR(42, 'YYYY')"), /formatting a number \(42\) is not supported/);
      refused(() => one("SELECT TO_CHAR(9007199254740993, '9')"), /formatting a number \(9007199254740993\) is not supported/);
      refused(() => one("SELECT TO_CHAR(at, 5) FROM visits WHERE id = 1"), /its format has to be text/);
      refused(() => one("SELECT TO_CHAR(x'0102', 'YYYY')"), /its value has to be a date or a date-time, as text/);
    });

    it("has two arguments, and no other function of PostgreSQL came with it", () => {
      refused(() => one("SELECT TO_CHAR('2026-01-02')"), /wrong number of arguments to function TO_CHAR/);
      refused(() => one("SELECT TO_DATE('2026-01-02', 'YYYY-MM-DD')"), /no such function: TO_DATE/);
      refused(() => one("SELECT DATE_TRUNC('month', '2026-01-02')"), /no such function: DATE_TRUNC/);
      refused(() => one("SELECT NOW()"), /no such function: NOW/);
    });
  });

  describe("in statements", () => {
    it("groups, orders, and filters rows by a formatted date, with the SQL as it was written", () => {
      const monthly = `SELECT TO_CHAR(v."at", 'YYYY-MM') AS "yearMonth", COUNT(v."id") AS "count" FROM "visits" v WHERE v."at" >= ? GROUP BY TO_CHAR(v."at", 'YYYY-MM') ORDER BY TO_CHAR(v."at", 'YYYY-MM') ASC`;
      assert.deepEqual(runtime.execute(monthly, [new Date("2026-01-01T00:00:00Z")]).rows, [{ yearMonth: "2026-01", count: 2 }, { yearMonth: "2026-02", count: 1 }]);
      const daily = `SELECT TO_CHAR(v."at", 'YYYY-MM-DD') AS "date", COUNT(v."id") AS "count" FROM "visits" v GROUP BY TO_CHAR(v."at", 'YYYY-MM-DD') ORDER BY TO_CHAR(v."at", 'YYYY-MM-DD') DESC`;
      assert.deepEqual(runtime.execute(daily).rows, [{ date: "2026-02-14", count: 1 }, { date: "2026-01-02", count: 2 }, { date: null, count: 1 }]);
      assert.deepEqual(runtime.execute("SELECT label FROM visits WHERE to_char(at, 'HH24') >= '12' ORDER BY id").rows, [{ label: "late" }, { label: "afternoon" }]);

      // What is reported is the application's statement, not something SQLite was given in its place.
      const [first] = events as [SqlEvent];
      assert.equal(first.sql, monthly);
      assert.deepEqual([first.operation, first.tables, first.returnedRows, first.errorCode], ["SELECT", ["visits"], 2, undefined]);
      assert.ok(formatSqlEvent(first, { mode: "verbose" }).includes(`sql: ${monthly}`));
    });

    it("takes its format from a parameter, also a numbered one, and from a column", () => {
      assert.equal(one('SELECT TO_CHAR("at", $1) FROM visits WHERE id = $2', ["DD/MM/YYYY", 1]), "02/01/2026");
      assert.equal(one('SELECT TO_CHAR($2, $1) || TO_CHAR($2, $1)', ["MM", MORNING]), "0101");
      runtime.execute("UPDATE visits SET label = 'YYYY' WHERE id = 1");
      assert.equal(one("SELECT TO_CHAR(at, label) FROM visits WHERE id = 1"), "2026");
      // A format that only shows what it is when the statement runs is refused then.
      refused(() => one("SELECT TO_CHAR(at, ?) FROM visits WHERE id = 1", ["Month"]), /the pattern "Month"/);
    });

    it("reports a refused call on the statement that made it, as a dialect error", () => {
      const sql = "SELECT TO_CHAR(at, 'Mon YYYY') FROM visits";
      refused(() => runtime.execute(sql), /the pattern "Mon"/);
      const failed = events.at(-1) as SqlEvent;
      assert.deepEqual([failed.sql, failed.errorCode, failed.rows], [sql, "SANDBOX_DIALECT_UNSUPPORTED", 0]);
      assert.match(failed.errorMessage ?? "", /^TO_CHAR: the pattern "Mon"/);
    });

    it("writes with it inside a transaction, and saves the table that was changed", () => {
      runtime.execute("BEGIN");
      runtime.execute("UPDATE visits SET label = TO_CHAR(at, 'YYYY-MM-DD') WHERE at IS NOT NULL");
      runtime.execute("INSERT INTO notes (text) SELECT TO_CHAR(at, 'HH24:MI') FROM visits WHERE id = 1");
      assert.deepEqual(storage.saves, []);
      runtime.execute("COMMIT");
      assert.deepEqual(storage.saves, [["visits", "notes"]]);
      assert.deepEqual((storage.collections.visits as Row[]).map((row) => row.label), ["2026-01-02", "2026-01-02", "2026-02-14", "never"]);
      assert.deepEqual(storage.collections.notes, [{ id: 1, text: "03:04" }]);

      runtime.execute("BEGIN");
      runtime.execute("UPDATE visits SET label = TO_CHAR(at, 'DD') WHERE id = 1");
      runtime.execute("ROLLBACK");
      assert.equal(storage.saves.length, 1);
    });

    it("leaves nothing of a statement whose call was refused, and saves nothing for it", () => {
      refused(() => runtime.execute("UPDATE visits SET label = TO_CHAR(at, 'Day')"), /the pattern "Day"/);
      assert.equal(runtime.inTransaction, false);
      assert.deepEqual(storage.saves, []);
      assert.deepEqual(runtime.snapshot().collections.visits, VISITS);
      // The next write is saved as usual.
      runtime.execute("UPDATE notes SET text = 'x'");
      runtime.execute("INSERT INTO notes (text) VALUES (TO_CHAR('2026-01-02', 'YY'))");
      assert.deepEqual(storage.saves, [["notes"]]);
    });

    it("is there in a read-only runtime, and in one without a storage", async () => {
      const readOnly = await SqliteRuntime.open({ schema: SCHEMA, state: { meta: { version: 1 }, collections: { visits: VISITS } }, readOnly: true });
      assert.deepEqual(readOnly.execute("SELECT TO_CHAR(at, 'YYYY') AS year FROM visits WHERE id = 1").rows, [{ year: "2026" }]);
      const plain = await SqliteRuntime.open({ schema: SCHEMA });
      assert.deepEqual(plain.execute("SELECT TO_CHAR('2026-01-02', 'DD.MM.YY') AS day").rows, [{ day: "02.01.26" }]);
    });
  });
});
