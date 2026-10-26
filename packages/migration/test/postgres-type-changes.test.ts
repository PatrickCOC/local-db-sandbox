import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CanonicalType } from "../../runtime/src/index.ts";
import { classifyTypeChange } from "../src/postgres/type-changes.ts";

/*
 * What becomes of the rows when a column's type changes (D-039). A change is
 * `safe` only when PostgreSQL converts every value that the old type can
 * hold, and keeps it: then the statement cannot fail because of the rows and
 * loses nothing. Each rule here was tried on PostgreSQL 18.
 */

const int = (bits: 16 | 32 | 64): CanonicalType => ({ kind: "integer", bits });
const decimal = (precision?: number, scale?: number): CanonicalType => ({ kind: "decimal", ...(precision !== undefined && { precision }), ...(scale !== undefined && { scale }) });
const float = (bits: 32 | 64): CanonicalType => ({ kind: "float", bits });
const varchar = (length?: number): CanonicalType => ({ kind: "varchar", ...(length !== undefined && { length }) });
const char = (length?: number): CanonicalType => ({ kind: "char", ...(length !== undefined && { length }) });
const timestamp = (withTimeZone: boolean, precision?: number): CanonicalType => ({ kind: "timestamp", withTimeZone, ...(precision !== undefined && { precision }) });
const enumOf = (name: string): CanonicalType => ({ kind: "enum", name });
const array = (element: CanonicalType): CanonicalType => ({ kind: "array", element });
const TEXT: CanonicalType = { kind: "text" };
const BOOLEAN: CanonicalType = { kind: "boolean" };
const UUID: CanonicalType = { kind: "uuid" };
const DATE: CanonicalType = { kind: "date" };
const JSON_TEXT: CanonicalType = { kind: "json", binary: false };
const JSONB: CanonicalType = { kind: "json", binary: true };
const INET: CanonicalType = { kind: "other", dialect: "postgresql", name: "inet" };

const ENUMS: Record<string, string[]> = { mood: ["sad", "ok"], mood_more: ["ok", "sad", "happy"], mood_less: ["ok"], long: ["a", "abcdefgh"] };

const change = (from: CanonicalType, to: CanonicalType): string => {
  const result = classifyTypeChange(from, to, (name) => ENUMS[name]);
  return `${result.safety}${"reason" in result ? `: ${result.reason}` : ""}${"using" in result && result.using !== undefined ? ` (using ${result.using})` : ""}`;
};

/** The sentence a change comes with, when it is not safe. */
const detail = (from: CanonicalType, to: CanonicalType): string | undefined => {
  const result = classifyTypeChange(from, to, (name) => ENUMS[name]);
  return "detail" in result ? result.detail : undefined;
};

describe("a column's type changes: what PostgreSQL does with the values", () => {
  test("a wider type of the same kind keeps every value", () => {
    assert.equal(change(int(16), int(32)), "safe");
    assert.equal(change(int(32), int(64)), "safe");
    assert.equal(change(float(32), float(64)), "safe");
    assert.equal(change(varchar(20), varchar(50)), "safe");
    assert.equal(change(varchar(20), varchar()), "safe");
    assert.equal(change(varchar(20), TEXT), "safe");
    assert.equal(change(varchar(), TEXT), "safe");
    assert.equal(change(TEXT, varchar()), "safe");
    assert.equal(change(char(3), char(5)), "safe");
    assert.equal(change(decimal(10, 2), decimal(12, 2)), "safe");
    assert.equal(change(decimal(10, 2), decimal(12, 4)), "safe");
    assert.equal(change(decimal(10, 2), decimal()), "safe");
    assert.equal(change(timestamp(true, 3), timestamp(true, 6)), "safe");
    assert.equal(change(timestamp(false, 3), timestamp(false)), "safe");
    assert.equal(change({ kind: "time", withTimeZone: false, precision: 0 }, { kind: "time", withTimeZone: false, precision: 3 }), "safe");
    assert.equal(change({ kind: "interval", precision: 0 }, { kind: "interval" }), "safe");
  });

  test("a type that holds every value of another keeps them", () => {
    assert.equal(change(int(16), decimal()), "safe");
    assert.equal(change(int(32), decimal(10, 0)), "safe");
    assert.equal(change(int(32), decimal(12, 2)), "safe");
    assert.equal(change(int(64), decimal(19, 0)), "safe");
    // Every whole number of 16 or 32 bits is a number of 64 bits of floating point, exactly.
    assert.equal(change(int(16), float(32)), "safe");
    assert.equal(change(int(32), float(64)), "safe");
    assert.equal(change(int(32), TEXT), "safe");
    assert.equal(change(decimal(10, 2), TEXT), "safe");
    assert.equal(change(BOOLEAN, TEXT), "safe");
    assert.equal(change(UUID, TEXT), "safe");
    assert.equal(change(UUID, varchar(36)), "safe");
    assert.equal(change(DATE, timestamp(false)), "safe");
    assert.equal(change(JSONB, JSON_TEXT), "safe");
    assert.equal(change(JSONB, TEXT), "safe");
    assert.equal(change(JSON_TEXT, TEXT), "safe");
  });

  test("a narrower type takes the values that fit, and PostgreSQL refuses the statement for one that does not", () => {
    const narrower = "requiresDataMigration: values-may-not-fit";
    assert.equal(change(int(64), int(32)), narrower);
    assert.equal(change(int(32), int(16)), narrower);
    assert.equal(change(varchar(50), varchar(20)), narrower);
    assert.equal(change(TEXT, varchar(20)), narrower);
    assert.equal(change(varchar(), varchar(20)), narrower);
    assert.equal(change(char(5), char(3)), narrower);
    assert.equal(change(decimal(12, 2), decimal(10, 2)), narrower);
    // More digits after the point, and so fewer before it.
    assert.equal(change(decimal(10, 2), decimal(10, 4)), narrower);
    assert.equal(change(int(32), decimal(8, 0)), narrower);
    assert.equal(change(int(32), decimal(10, 2)), narrower);
    assert.equal(change(int(64), decimal(12, 2)), narrower);
    assert.equal(change(int(32), varchar(5)), narrower);
    assert.equal(change(UUID, varchar(20)), narrower);
    assert.equal(change(BOOLEAN, varchar(4)), narrower);
  });

  test("a conversion that PostgreSQL makes by rounding, cutting, or the session's time zone is not made for the author", () => {
    const unknown = "requiresExplicitCast: no-safe-conversion";
    // Rounded to fewer digits after the point.
    assert.equal(change(decimal(10, 4), decimal(10, 2)), unknown);
    assert.equal(change(decimal(), decimal(10, 2)), unknown);
    assert.equal(change(decimal(10, 2), int(32)), unknown);
    assert.equal(change(float(64), int(32)), unknown);
    assert.equal(change(float(64), float(32)), unknown);
    assert.equal(change(float(64), decimal(10, 2)), unknown);
    assert.equal(change(decimal(10, 2), float(64)), unknown);
    assert.equal(change(int(64), float(64)), unknown);
    assert.equal(change(int(32), float(32)), unknown);
    assert.equal(change(timestamp(true, 6), timestamp(true, 3)), unknown);
    assert.equal(change(timestamp(false), timestamp(false, 3)), unknown);
    // The time of day is cut off.
    assert.equal(change(timestamp(false), DATE), unknown);
    // The values are read in the time zone of the session that runs the statement.
    assert.equal(change(timestamp(false), timestamp(true)), unknown);
    assert.equal(change(timestamp(true), timestamp(false)), unknown);
    assert.equal(change(DATE, timestamp(true)), unknown);
    // Keys that are there twice, and the order of keys, are lost.
    assert.equal(change(JSON_TEXT, JSONB), unknown);
    // Spaces at the end are taken off.
    assert.equal(change(char(3), TEXT), unknown);
    assert.equal(change(TEXT, char(3)), unknown);
  });

  test("where PostgreSQL has no conversion of its own, none is made up", () => {
    const unknown = "requiresExplicitCast: no-safe-conversion";
    assert.equal(change(TEXT, int(32)), unknown);
    assert.equal(change(TEXT, UUID), unknown);
    assert.equal(change(TEXT, BOOLEAN), unknown);
    assert.equal(change(TEXT, JSONB), unknown);
    assert.equal(change(TEXT, timestamp(true)), unknown);
    assert.equal(change(int(32), BOOLEAN), unknown);
    assert.equal(change(BOOLEAN, int(32)), unknown);
    assert.equal(change(TEXT, enumOf("mood")), unknown);
    assert.equal(change(varchar(20), enumOf("mood")), unknown);
    assert.equal(change(int(32), array(int(32))), unknown);
    assert.equal(change(array(TEXT), TEXT), unknown);
    assert.equal(change(INET, TEXT), unknown);
    assert.equal(change(TEXT, INET), unknown);
    assert.equal(change({ kind: "binary" }, TEXT), unknown);
    assert.equal(change({ kind: "other", dialect: "postgresql", name: "bit", modifiers: [8] }, { kind: "other", dialect: "postgresql", name: "bit", modifiers: [16] }), unknown);
  });

  test("an enumerated type becomes a text that holds its longest value", () => {
    assert.equal(change(enumOf("mood"), TEXT), "safe");
    assert.equal(change(enumOf("mood"), varchar()), "safe");
    assert.equal(change(enumOf("mood"), varchar(3)), "safe");
    assert.equal(change(enumOf("long"), varchar(8)), "safe");
    assert.equal(change(enumOf("long"), varchar(7)), "requiresDataMigration: values-may-not-fit");
    // A type whose values are not known: nothing is said to be safe of it.
    assert.equal(change(enumOf("nowhere"), varchar(3)), "requiresExplicitCast: no-safe-conversion");
  });

  test("an enumerated type becomes another by the names of its values, when the other has them all", () => {
    assert.equal(change(enumOf("mood"), enumOf("mood_more")), "safe (using text)");
    assert.equal(change(enumOf("mood"), enumOf("mood_less")), "requiresDataMigration: rows-may-hold-removed-value (using text)");
    assert.equal(change(enumOf("mood"), enumOf("nowhere")), "requiresExplicitCast: no-safe-conversion");
    assert.equal(change(enumOf("nowhere"), enumOf("mood")), "requiresExplicitCast: no-safe-conversion");
  });

  test("an array changes as its elements do", () => {
    assert.equal(change(array(int(32)), array(int(64))), "safe");
    assert.equal(change(array(varchar(20)), array(TEXT)), "safe");
    assert.equal(change(array(int(64)), array(int(32))), "requiresDataMigration: values-may-not-fit");
    assert.equal(change(array(TEXT), array(int(32))), "requiresExplicitCast: no-safe-conversion");
    assert.equal(change(array(enumOf("mood")), array(enumOf("mood_more"))), "safe (using text)");
    assert.equal(change(array(enumOf("mood")), array(enumOf("mood_less"))), "requiresDataMigration: rows-may-hold-removed-value (using text)");
    assert.equal(change(array(enumOf("mood")), array(TEXT)), "safe");
  });

  test("a reason comes with a sentence for people", () => {
    assert.equal(detail(int(32), int(64)), undefined);
    assert.match(detail(int(64), int(32)) ?? "", /bigint .* integer/);
    assert.match(detail(TEXT, int(32)) ?? "", /text .* integer/);
    assert.match(detail(enumOf("mood"), enumOf("mood_less")) ?? "", /"sad"/);
  });
});
