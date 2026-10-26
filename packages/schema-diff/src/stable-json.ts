/*
 * JSON whose text depends only on the value: the keys of every object are
 * written in one fixed order, never in the order the object was built in.
 * Arrays keep their order; where the order of a list carries no meaning, the
 * diff sorts it before it gets here.
 *
 * The text is written here, key by key. Building an object with its keys in
 * order and handing it to `JSON.stringify` would not do: an object puts keys
 * that look like numbers first, in the order of the numbers, and a key named
 * `__proto__` is not a key when it is assigned.
 */

/** Keys written first, in this order, when an object has them; all others follow by code point. */
const LEADING_KEYS = [
  "diffVersion",
  "changes",
  "op",
  "enum",
  "table",
  "kind",
  "column",
  "constraint",
  "index",
  "value",
  "name",
  "now",
  "from",
  "to",
  "afterValue",
  "beforeValue",
  "comparedBy",
  "storage",
  "canonical",
  "declared",
  "type",
  "nullable",
  "default",
  "function",
  "strategy",
  "expression",
  "columns",
  "expressions",
  "unique",
  "where",
  "method",
  "keys",
  "order",
  "nulls",
  "operatorClass",
  "collation",
  "include",
  "references",
  "onDelete",
  "onUpdate",
  "deferrable",
  "nullsNotDistinct",
  "names",
  "mayBeStale",
  "sourceClauses",
  "values",
  "primaryKey",
  "uniques",
  "checks",
  "foreignKeys",
  "indexes",
  "before",
  "after",
  "evidence",
  "origin",
  "renames",
];

const RANK = new Map(LEADING_KEYS.map((key, index) => [key, index]));

/**
 * Two texts in the order of their code points, never by locale. (`<` on
 * JavaScript strings goes by UTF-16 units, which puts a character beyond
 * U+FFFF before some characters below it.)
 */
export function compareText(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  // Up to the first difference both texts have the same units, so one position serves both.
  for (let position = 0; position < shared; ) {
    const x = a.codePointAt(position) as number;
    const y = b.codePointAt(position) as number;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
    position += x > 0xffff ? 2 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function compareKeys(a: string, b: string): number {
  const rankA = RANK.get(a) ?? LEADING_KEYS.length;
  const rankB = RANK.get(b) ?? LEADING_KEYS.length;
  return rankA !== rankB ? rankA - rankB : compareText(a, b);
}

/**
 * JSON text of a value, the same for equal values: every object's keys in
 * the fixed order, and members that are `undefined` left out. With `indent`,
 * laid out as `JSON.stringify` lays it out.
 */
export function stableStringify(value: unknown, indent = 0): string {
  const line = (depth: number): string => (indent > 0 ? `\n${" ".repeat(indent * depth)}` : "");
  const write = (item: unknown, depth: number): string => {
    if (Array.isArray(item)) {
      return item.length === 0 ? "[]" : `[${item.map((entry) => `${line(depth + 1)}${write(entry, depth + 1)}`).join(",")}${line(depth)}]`;
    }
    if (typeof item === "object" && item !== null) {
      const members = item as Record<string, unknown>;
      if (typeof members.toJSON === "function") {
        return write((members.toJSON as () => unknown)(), depth);
      }
      const keys = Object.keys(members)
        .filter((key) => members[key] !== undefined)
        .sort(compareKeys);
      return keys.length === 0 ? "{}" : `{${keys.map((key) => `${line(depth + 1)}${JSON.stringify(key)}:${indent > 0 ? " " : ""}${write(members[key], depth + 1)}`).join(",")}${line(depth)}}`;
    }
    // What JSON has no text for (`undefined`, a function) is `null` where a value must stand, as in a list.
    return JSON.stringify(item) ?? "null";
  };
  return write(value, 0);
}
