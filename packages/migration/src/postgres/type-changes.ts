import { formatCanonicalType } from "../../../runtime/src/canonical-type.ts";
import type { CanonicalType } from "../../../runtime/src/canonical-type.ts";

/*
 * What becomes of the rows when a column's type changes (D-039).
 *
 * `ALTER COLUMN ... TYPE` converts every value of the column. A change is
 * `safe` only when PostgreSQL makes that conversion on its own, for every
 * value the old type can hold, and keeps the value: then the statement
 * cannot fail because of the rows, and loses nothing.
 *
 * Otherwise it is one of two:
 *
 * - PostgreSQL makes the conversion on its own and refuses a value that does
 *   not fit the new type (`bigint` to `integer`, `text` to `varchar(20)`):
 *   the rows decide (`requiresDataMigration`).
 * - PostgreSQL has no conversion of its own (`text` to `integer`), or the
 *   one it has changes values without saying so: it rounds (`numeric` to
 *   `integer`), cuts (`timestamp` to `date`), or reads them in the time zone
 *   of whatever session runs the statement (`timestamp` to `timestamp with
 *   time zone`). How the values are to be converted is the author's to say
 *   (`requiresExplicitCast`).
 *
 * A pair that is not known here is of the last kind: nothing is called safe
 * by guessing. The rules were tried on PostgreSQL 18.
 */

/**
 * `using`: the values are converted by way of their text
 * (`USING column::text::type`): from one enumerated type to another, which
 * PostgreSQL does not convert on its own, each value by its name. `detail`:
 * a sentence for people, when the change is not safe.
 */
export type TypeChange =
  | { safety: "safe"; using?: "text" }
  | { safety: "requiresDataMigration"; reason: "values-may-not-fit" | "rows-may-hold-removed-value"; detail: string; using?: "text" }
  | { safety: "requiresExplicitCast"; reason: "no-safe-conversion"; detail: string };

const SAFE: TypeChange = { safety: "safe" };

/** The whole numbers of so many bits: the digits of the longest, and its length as text with its sign. */
const DIGITS = { 16: 5, 32: 10, 64: 19 } as const;
const TEXT_LENGTH = { 16: 6, 32: 11, 64: 20 } as const;

/** How many characters a text type takes: `undefined` for a type that is no text of this kind. */
function capacity(type: CanonicalType): number | undefined {
  return type.kind === "text" ? Number.POSITIVE_INFINITY : type.kind === "varchar" ? (type.length ?? Number.POSITIVE_INFINITY) : undefined;
}

/** A precision of fractional seconds; without one, PostgreSQL keeps all six digits. */
const fraction = (precision: number | undefined): number => precision ?? 6;

/**
 * What a change of a column's type from `from` to `to` is. `valuesOf` gives
 * the values of an enumerated type of the schema at that moment, by name.
 */
export function classifyTypeChange(from: CanonicalType, to: CanonicalType, valuesOf: (name: string) => readonly string[] | undefined): TypeChange {
  const [was, is] = [formatCanonicalType(from), formatCanonicalType(to)];
  const narrower = (why: string): TypeChange => ({ safety: "requiresDataMigration", reason: "values-may-not-fit", detail: `Not every value of ${was} fits ${is}: ${why}. PostgreSQL refuses the statement when a row holds one that does not.` });
  const unknown = (why: string): TypeChange => ({ safety: "requiresExplicitCast", reason: "no-safe-conversion", detail: `${why}. How the values of ${was} become values of ${is} has to be said (USING), and is not made up.` });
  const none = (): TypeChange => unknown(`PostgreSQL has no conversion from ${was} to ${is} that it makes on its own and that is known to keep every value`);

  if (from.kind === "array" || to.kind === "array") {
    // An array changes as its elements do; an array and a single value are not converted into each other.
    return from.kind === "array" && to.kind === "array" ? classifyTypeChange(from.element, to.element, valuesOf) : none();
  }

  const room = capacity(to);
  if (room !== undefined) {
    /** The longest text a value of the old type becomes. */
    let longest: number | undefined;
    switch (from.kind) {
      case "text":
      case "varchar":
        longest = capacity(from);
        break;
      case "integer":
        longest = TEXT_LENGTH[from.bits];
        break;
      case "boolean":
        longest = "false".length;
        break;
      case "uuid":
        longest = 36;
        break;
      case "decimal":
      case "json":
        longest = Number.POSITIVE_INFINITY;
        break;
      case "enum": {
        const values = valuesOf(from.name);
        longest = values === undefined ? undefined : Math.max(0, ...values.map((value) => [...value].length));
        break;
      }
      default:
        break;
    }
    if (longest === undefined) {
      // A text with spaces at its end loses them; a time is written as the session's settings say.
      return from.kind === "char" ? unknown(`PostgreSQL takes the spaces at the end of a value of ${was} off when it makes it ${is}`) : none();
    }
    return longest <= room ? SAFE : narrower(`a value may be longer than ${room} characters`);
  }

  switch (to.kind) {
    case "integer":
      if (from.kind === "integer") {
        return to.bits > from.bits ? SAFE : narrower(`${is} holds smaller numbers`);
      }
      return from.kind === "decimal" || from.kind === "float" ? unknown(`PostgreSQL rounds a value of ${was} to a whole number`) : none();
    case "decimal": {
      if (from.kind === "integer") {
        if (to.precision === undefined) {
          return SAFE;
        }
        const scale = to.scale ?? 0;
        if (scale < 0) {
          return unknown(`PostgreSQL rounds a value of ${was} to ${is}`);
        }
        return to.precision - scale >= DIGITS[from.bits] ? SAFE : narrower(`${is} has ${to.precision - scale} digits before the point, and ${was} up to ${DIGITS[from.bits]}`);
      }
      if (from.kind === "decimal") {
        if (to.precision === undefined) {
          return SAFE;
        }
        const [scaleWas, scaleIs] = [from.scale ?? 0, to.scale ?? 0];
        if (from.precision === undefined || scaleIs < scaleWas) {
          return unknown(`PostgreSQL rounds a value of ${was} to the digits ${is} has after the point`);
        }
        return to.precision - scaleIs >= from.precision - scaleWas ? SAFE : narrower(`${is} has fewer digits before the point`);
      }
      return from.kind === "float" ? unknown(`PostgreSQL rounds a value of ${was} to ${is}`) : none();
    }
    case "float":
      if (from.kind === "float") {
        return to.bits > from.bits ? SAFE : unknown(`A value of ${was} is rounded to the digits ${is} holds`);
      }
      if (from.kind === "integer") {
        // Whole numbers of 16 bits are numbers of 32 bits of floating point, and those of 32 bits are numbers of 64, exactly.
        return from.bits === 16 || (from.bits === 32 && to.bits === 64) ? SAFE : unknown(`Not every value of ${was} is a value of ${is} exactly: PostgreSQL rounds it`);
      }
      return from.kind === "decimal" ? unknown(`A value of ${was} is rounded to the digits ${is} holds`) : none();
    case "char":
      if (from.kind === "char") {
        return to.length === undefined || (from.length !== undefined && to.length >= from.length) ? SAFE : narrower(`a value may be longer than ${to.length} characters`);
      }
      return capacity(from) !== undefined ? unknown(`PostgreSQL fills a value of ${was} with spaces to make it ${is}`) : none();
    case "timestamp":
      if (from.kind === "timestamp") {
        if (from.withTimeZone !== to.withTimeZone) {
          return unknown(`PostgreSQL reads a value of ${was} in the time zone of the session that runs the statement to make it ${is}`);
        }
        return fraction(to.precision) >= fraction(from.precision) ? SAFE : unknown(`PostgreSQL rounds a value of ${was} to the digits ${is} has after the second`);
      }
      if (from.kind === "date") {
        return to.withTimeZone ? unknown(`PostgreSQL reads a value of ${was} in the time zone of the session that runs the statement to make it ${is}`) : SAFE;
      }
      return none();
    case "time":
      if (from.kind === "time") {
        if (from.withTimeZone !== to.withTimeZone) {
          return unknown(`PostgreSQL reads a value of ${was} in the time zone of the session that runs the statement to make it ${is}`);
        }
        return fraction(to.precision) >= fraction(from.precision) ? SAFE : unknown(`PostgreSQL rounds a value of ${was} to the digits ${is} has after the second`);
      }
      return none();
    case "interval":
      if (from.kind === "interval") {
        return fraction(to.precision) >= fraction(from.precision) ? SAFE : unknown(`PostgreSQL rounds a value of ${was} to the digits ${is} has after the second`);
      }
      return none();
    case "date":
      return from.kind === "timestamp" ? unknown(`PostgreSQL cuts the time of day off a value of ${was}`) : none();
    case "json":
      if (from.kind === "json") {
        // The decomposed form keeps one of the keys that are there twice, and no order of keys.
        return to.binary ? unknown(`A value of ${was} loses the keys it has twice, and the order of its keys, when it becomes ${is}`) : SAFE;
      }
      return none();
    case "enum": {
      if (from.kind !== "enum") {
        return none();
      }
      const [valuesWere, valuesAre] = [valuesOf(from.name), valuesOf(to.name)];
      if (valuesWere === undefined || valuesAre === undefined) {
        return none();
      }
      // PostgreSQL converts no enumerated type into another; by way of its text a value becomes the value of the same name.
      const missing = valuesWere.filter((value) => !valuesAre.includes(value));
      return missing.length === 0
        ? { safety: "safe", using: "text" }
        : {
            safety: "requiresDataMigration",
            reason: "rows-may-hold-removed-value",
            detail: `The type ${is} has no value ${missing.map((value) => JSON.stringify(value)).join(", ")}, which ${was} has. PostgreSQL refuses the statement when a row holds one.`,
            using: "text",
          };
    }
    default:
      return none();
  }
}
