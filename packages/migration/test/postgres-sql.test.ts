import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CanonicalType } from "../../runtime/src/index.ts";
import { Refusal } from "../src/postgres/safety.ts";
import { quoteIdentifier, quoteLiteral } from "../src/postgres/sql.ts";
import { defaultLiteral, postgresType } from "../src/postgres/types.ts";

/*
 * The leaves of generated SQL (D-039): names, texts, types, and constants.
 * A name is always quoted, so that no word of PostgreSQL's and no capital
 * letter changes what it names. A type is written from what it is, the
 * canonical type, never from how a source spelled it.
 */

const refusal = (reason: string) => (error: unknown) => error instanceof Refusal && error.safety === "unsupported" && error.reason === reason;

describe("PostgreSQL names and texts", () => {
  test("a name is quoted, whatever it is", () => {
    assert.equal(quoteIdentifier("users"), '"users"');
    assert.equal(quoteIdentifier("Order Items"), '"Order Items"');
    assert.equal(quoteIdentifier("select"), '"select"');
    assert.equal(quoteIdentifier('say "hi"'), '"say ""hi"""');
    assert.equal(quoteIdentifier("x'; drop table users; --"), `"x'; drop table users; --"`);
    assert.equal(quoteIdentifier("tête_à_tête"), '"tête_à_tête"');
  });

  test("a name that PostgreSQL would not keep as it is, is refused", () => {
    assert.throws(() => quoteIdentifier(""), refusal("name-not-representable"));
    assert.throws(() => quoteIdentifier("a\u0000b"), refusal("name-not-representable"));
    // 63 bytes is the longest name; PostgreSQL cuts a longer one short and says nothing.
    assert.equal(quoteIdentifier("n".repeat(63)), `"${"n".repeat(63)}"`);
    assert.throws(() => quoteIdentifier("n".repeat(64)), refusal("name-not-representable"));
    assert.throws(() => quoteIdentifier("é".repeat(32)), refusal("name-not-representable"));
    assert.equal(quoteIdentifier("é".repeat(31)), `"${"é".repeat(31)}"`);
  });

  test("a text is quoted so that it is the same text whatever the session says of backslashes", () => {
    assert.equal(quoteLiteral("plain"), "'plain'");
    assert.equal(quoteLiteral(""), "''");
    assert.equal(quoteLiteral("it's"), "'it''s'");
    assert.equal(quoteLiteral("'; drop table users; --"), "'''; drop table users; --'");
    assert.equal(quoteLiteral("a\\b"), "E'a\\\\b'");
    assert.equal(quoteLiteral("\\'"), "E'\\\\'''");
    assert.equal(quoteLiteral("line\nbreak"), "'line\nbreak'");
    assert.equal(quoteLiteral("$$ $tag$"), "'$$ $tag$'");
    assert.throws(() => quoteLiteral("a\u0000b"), refusal("value-not-representable"));
  });
});

describe("PostgreSQL types, from canonical types", () => {
  const spelled = (type: CanonicalType): string => postgresType(type);

  test("every canonical kind has its spelling", () => {
    const cases: [CanonicalType, string][] = [
      [{ kind: "boolean" }, "boolean"],
      [{ kind: "integer", bits: 16 }, "smallint"],
      [{ kind: "integer", bits: 32 }, "integer"],
      [{ kind: "integer", bits: 64 }, "bigint"],
      [{ kind: "decimal" }, "numeric"],
      [{ kind: "decimal", precision: 12, scale: 2 }, "numeric(12,2)"],
      [{ kind: "decimal", precision: 10 }, "numeric(10,0)"],
      [{ kind: "decimal", precision: 5, scale: -2 }, "numeric(5,-2)"],
      [{ kind: "float", bits: 32 }, "real"],
      [{ kind: "float", bits: 64 }, "double precision"],
      [{ kind: "text" }, "text"],
      [{ kind: "varchar" }, "varchar"],
      [{ kind: "varchar", length: 20 }, "varchar(20)"],
      [{ kind: "char", length: 3 }, "char(3)"],
      // `char` alone is char(1) to PostgreSQL; the type without a length is bpchar.
      [{ kind: "char" }, "bpchar"],
      [{ kind: "uuid" }, "uuid"],
      [{ kind: "date" }, "date"],
      [{ kind: "time", withTimeZone: false }, "time"],
      [{ kind: "time", withTimeZone: true, precision: 3 }, "time(3) with time zone"],
      [{ kind: "timestamp", withTimeZone: false }, "timestamp"],
      [{ kind: "timestamp", withTimeZone: false, precision: 0 }, "timestamp(0)"],
      [{ kind: "timestamp", withTimeZone: true }, "timestamp with time zone"],
      [{ kind: "timestamp", withTimeZone: true, precision: 3 }, "timestamp(3) with time zone"],
      [{ kind: "interval" }, "interval"],
      [{ kind: "interval", precision: 3 }, "interval(3)"],
      [{ kind: "json", binary: false }, "json"],
      [{ kind: "json", binary: true }, "jsonb"],
      [{ kind: "binary" }, "bytea"],
      [{ kind: "enum", name: "order_status" }, '"order_status"'],
      [{ kind: "enum", name: "Mood" }, '"Mood"'],
      [{ kind: "array", element: { kind: "text" } }, "text[]"],
      [{ kind: "array", element: { kind: "timestamp", withTimeZone: true } }, "timestamp with time zone[]"],
      [{ kind: "array", element: { kind: "enum", name: "mood" } }, '"mood"[]'],
      [{ kind: "array", element: { kind: "decimal", precision: 12, scale: 2 } }, "numeric(12,2)[]"],
    ];
    for (const [type, expected] of cases) {
      assert.equal(spelled(type), expected, JSON.stringify(type));
    }
  });

  test("a type of PostgreSQL's own is written by its name, quoted, with its modifiers as constants", () => {
    assert.equal(spelled({ kind: "other", dialect: "postgresql", name: "inet" }), '"inet"');
    assert.equal(spelled({ kind: "other", dialect: "postgresql", name: "char" }), '"char"');
    assert.equal(spelled({ kind: "other", dialect: "postgresql", name: "bit", modifiers: [8] }), '"bit"(8)');
    assert.equal(spelled({ kind: "other", dialect: "postgresql", name: "geometry", modifiers: ["Point", 4326] }), `"geometry"('Point',4326)`);
    assert.equal(spelled({ kind: "other", dialect: "postgresql", name: "extensions.citext" }), '"extensions"."citext"');
    assert.equal(spelled({ kind: "array", element: { kind: "other", dialect: "postgresql", name: "inet" } }), '"inet"[]');
    // A name and a modifier are data: neither can end the type.
    assert.equal(spelled({ kind: "other", dialect: "postgresql", name: 'x"; drop table t; --', modifiers: ["'); drop table t; --"] }), `"x""; drop table t; --"('''); drop table t; --')`);
  });

  test("a type that cannot be written is refused", () => {
    assert.throws(() => spelled({ kind: "other", dialect: "mysql", name: "tinyint", modifiers: [1] }), refusal("type-not-representable"));
    // An interval of some fields: its modifiers are numbers of PostgreSQL's own, which its type syntax does not take.
    assert.throws(() => spelled({ kind: "other", dialect: "postgresql", name: "interval", modifiers: [1036] }), refusal("type-not-representable"));
    assert.throws(() => spelled({ kind: "other", dialect: "postgresql", name: "bit", modifiers: [1.5] }), refusal("type-not-representable"));
    assert.throws(() => spelled({ kind: "enum", name: "n".repeat(64) }), refusal("name-not-representable"));
  });
});

describe("PostgreSQL constants, for a default of a type", () => {
  const constant = (type: CanonicalType, value: unknown): string => defaultLiteral(type, value);

  test("numbers and truth values are written as they are", () => {
    assert.equal(constant({ kind: "integer", bits: 32 }, 0), "0");
    assert.equal(constant({ kind: "integer", bits: 64 }, -42), "-42");
    assert.equal(constant({ kind: "decimal", precision: 12, scale: 2 }, -5.5), "-5.5");
    assert.equal(constant({ kind: "float", bits: 64 }, 1e21), "1e+21");
    assert.equal(constant({ kind: "boolean" }, true), "true");
    assert.equal(constant({ kind: "boolean" }, false), "false");
  });

  test("texts, and what PostgreSQL reads from a text, are quoted", () => {
    assert.equal(constant({ kind: "text" }, "it's"), "'it''s'");
    assert.equal(constant({ kind: "varchar", length: 20 }, ""), "''");
    assert.equal(constant({ kind: "uuid" }, "00000000-0000-0000-0000-000000000001"), "'00000000-0000-0000-0000-000000000001'");
    assert.equal(constant({ kind: "date" }, "2020-01-02"), "'2020-01-02'");
    assert.equal(constant({ kind: "timestamp", withTimeZone: true }, "2020-01-02 03:04:05+00"), "'2020-01-02 03:04:05+00'");
    assert.equal(constant({ kind: "enum", name: "mood" }, "o'k"), "'o''k'");
    assert.equal(constant({ kind: "other", dialect: "postgresql", name: "inet" }, "10.0.0.1"), "'10.0.0.1'");
  });

  test("JSON is its text, bytes are hexadecimal digits, each with its type", () => {
    assert.equal(constant({ kind: "json", binary: true }, { a: [1, "x'y"] }), `'{"a":[1,"x''y"]}'::jsonb`);
    assert.equal(constant({ kind: "json", binary: false }, []), "'[]'::json");
    assert.equal(constant({ kind: "json", binary: true }, "text"), `'"text"'::jsonb`);
    assert.equal(constant({ kind: "json", binary: true }, 3), "'3'::jsonb");
    // The schema holds bytes as base64.
    assert.equal(constant({ kind: "binary" }, "AQI="), "E'\\\\x0102'::bytea");
    assert.equal(constant({ kind: "binary" }, ""), "E'\\\\x'::bytea");
  });

  test("an array is its elements, each of the element's type", () => {
    assert.equal(constant({ kind: "array", element: { kind: "text" } }, ["a", "b'c", null]), "ARRAY['a','b''c',NULL]::text[]");
    assert.equal(constant({ kind: "array", element: { kind: "integer", bits: 32 } }, []), "ARRAY[]::integer[]");
    assert.equal(constant({ kind: "array", element: { kind: "integer", bits: 32 } }, [[1, 2], [3, 4]]), "ARRAY[ARRAY[1,2],ARRAY[3,4]]::integer[]");
    assert.equal(constant({ kind: "array", element: { kind: "enum", name: "mood" } }, ["sad"]), `ARRAY['sad']::"mood"[]`);
    assert.equal(constant({ kind: "array", element: { kind: "json", binary: true } }, [{ a: 1 }]), `ARRAY['{"a":1}']::jsonb[]`);
    // A whole number that a JavaScript number does not hold exactly is kept as its digits.
    assert.equal(constant({ kind: "array", element: { kind: "integer", bits: 64 } }, ["9007199254740993", -1]), "ARRAY[9007199254740993,-1]::bigint[]");
  });

  test("a value that is no value of the type is refused, never written as something else", () => {
    const refused = refusal("value-not-representable");
    assert.throws(() => constant({ kind: "integer", bits: 32 }, "5"), refused);
    assert.throws(() => constant({ kind: "integer", bits: 32 }, 1.5), refused);
    // Beyond what a number holds exactly, the schema no longer says which number it was.
    assert.throws(() => constant({ kind: "integer", bits: 64 }, 2 ** 60), refused);
    assert.throws(() => constant({ kind: "float", bits: 64 }, Number.NaN), refused);
    assert.throws(() => constant({ kind: "decimal" }, Number.POSITIVE_INFINITY), refused);
    assert.throws(() => constant({ kind: "boolean" }, "true"), refused);
    assert.throws(() => constant({ kind: "text" }, { a: 1 }), refused);
    assert.throws(() => constant({ kind: "binary" }, "not base64!"), refused);
    assert.throws(() => constant({ kind: "array", element: { kind: "text" } }, "a,b"), refused);
    assert.throws(() => constant({ kind: "array", element: { kind: "integer", bits: 64 } }, ["1; drop table t"]), refused);
    assert.throws(() => constant({ kind: "json", binary: true }, undefined), refused);
  });
});
