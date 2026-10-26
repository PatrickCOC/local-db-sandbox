import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stringifyPostgresMigration } from "../src/postgres/index.ts";
import { historyPair } from "./support/history-generator.ts";
import type { HistoryOptions } from "./support/history-generator.ts";
import { arrives, generate, statementsOf } from "./support/postgres-round-trip.ts";

/*
 * The property the PostgreSQL generator stands on (D-039), over generated
 * migration histories. For the schema at two moments of a history, A and B,
 * whatever happened in between:
 *
 *   the generated migration from A to B, applied to A, gives B
 *
 * A is made by a generated migration too (from nothing), which the collector
 * applies; the migration from A to B is collected after it, and what comes
 * out has to mean B. The collector applies statements as PostgreSQL does and
 * refuses what PostgreSQL refuses of them: a name that is taken, a table or
 * column that is not there, a key that a foreign key rests on, a type that a
 * default still rests on. Every statement is also given to PostgreSQL's own
 * parser.
 *
 * The histories are of schemas that PostgreSQL can have (`postgres`), and
 * made from seeds, so every run tries the same ones. A migration that is not
 * generated has to be refused for a reason that such histories do have: a
 * type changed into one that PostgreSQL does not convert it to safely, or
 * numbering given to a column that is there.
 */

interface Run {
  title: string;
  options: HistoryOptions;
  from: number;
  count: number;
}

const RUNS: Run[] = [
  { title: "histories in which every name is new", options: { reuse: false, handEdits: false, postgres: true }, from: 1, count: 150 },
  { title: "histories in which names are used again, with values taken out of enumerated types and put in another order", options: { reuse: true, handEdits: true, postgres: true }, from: 1, count: 500 },
  { title: "histories in which tables, types, constraints, and indexes share their names", options: { reuse: true, handEdits: false, oneNamespace: true, postgres: true }, from: 9001, count: 350 },
];

/** What a migration of such a history may be refused for. */
const EXPECTED_REFUSALS = new Set(["no-safe-conversion", "numbering-not-representable"]);

/** What was seen over all the runs, so that the property is not trusted for cases it never met. */
const seen = {
  pairs: 0,
  generated: 0,
  refused: 0,
  statements: 0,
  /** Migrations with a statement that rests on what the rows are. */
  onTheCallersWord: 0,
  /** Migrations of two segments, and of three: a value added to an enumerated type, with what stands before or after it. */
  twoSegments: 0,
  threeSegments: 0,
  /** Migrations with a statement that PostgreSQL needs beyond its step, by the reason. */
  because: {} as Record<string, number>,
  /** Migrations that were refused, by the reason. */
  refusedFor: {} as Record<string, number>,
};

const count = (counts: Record<string, number>, keys: Iterable<string>): void => {
  for (const key of new Set(keys)) {
    counts[key] = (counts[key] ?? 0) + 1;
  }
};

describe("PostgreSQL migrations over generated histories: applied by the collector, each arrives at the schema it is for", () => {
  for (const run of RUNS) {
    test(`${run.title}: ${run.count} histories`, async () => {
      for (let seed = run.from; seed < run.from + run.count; seed += 1) {
        const { before, after, log } = historyPair(seed, run.options);
        for (const [direction, a, b] of [
          ["forwards", before, after],
          ["backwards", after, before],
        ] as const) {
          const context = `seed ${seed}, ${direction}, ${JSON.stringify(run.options)}\n${log.join("\n")}`;
          let result;
          try {
            result = await arrives(a, b, { assumeValidData: true });
          } catch (error) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}\n${context}`, { cause: error });
          }
          seen.pairs += 1;
          const { generation } = result;
          const onRows = generation.steps.filter((step) => step.safety === "requiresDataMigration");
          // Without the caller's word that the rows fit: the same migration when nothing rests on them, and otherwise none, for exactly the steps that do.
          const strict = generate(a, b).generation;
          if (generation.status === "refused") {
            seen.refused += 1;
            count(seen.refusedFor, generation.refusals.map((refusal) => refusal.reason as string));
            assert.deepEqual(generation.refusals.filter((refusal) => !EXPECTED_REFUSALS.has(refusal.reason as string)), [], context);
            assert.equal(strict.status, "refused", context);
            continue;
          }
          const statements = statementsOf(generation.migration);
          seen.generated += 1;
          seen.statements += statements.length;
          seen.onTheCallersWord += onRows.length > 0 ? 1 : 0;
          seen.twoSegments += generation.migration.segments.length === 2 ? 1 : 0;
          seen.threeSegments += generation.migration.segments.length === 3 ? 1 : 0;
          assert.ok(generation.migration.segments.length <= 3, context);
          count(seen.because, statements.flatMap((statement) => (statement.because === undefined ? [] : [statement.because])));
          if (onRows.length === 0) {
            assert.equal(strict.status === "generated" && stringifyPostgresMigration(strict.migration), stringifyPostgresMigration(generation.migration), context);
          } else {
            assert.deepEqual(strict.status === "refused" && strict.refusals, onRows, context);
          }
        }
      }
    });
  }

  test("the histories met what the generator has to work for", () => {
    /*
     * The seeds are fixed, so these are counts, not chances, and they are the
     * numbers D-039 states. A change of the history generator, of the diff, of
     * the planner, or of the generator that moves one shows here: then the
     * decision's numbers are to be stated again with these.
     */
    assert.deepEqual(seen, {
      pairs: 2000,
      generated: 1801,
      refused: 199,
      statements: 7815,
      onTheCallersWord: 337,
      twoSegments: 67,
      threeSegments: 192,
      because: {
        "enum-type-made-again": 288,
        "foreign-key-rests-on-dropped-key": 41,
        "type-name-taken-by-table": 9,
        "enum-default-across-type-change": 8,
        "numbering-kind-unknown": 12,
        "key-over-the-same-columns": 12,
      },
      refusedFor: { "no-safe-conversion": 192, "numbering-not-representable": 14 },
    });
  });
});
