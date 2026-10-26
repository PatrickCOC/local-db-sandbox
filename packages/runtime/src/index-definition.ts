import type { IndexKey } from "./runtime.ts";

/*
 * The keys of an index (D-040).
 *
 * An index says its keys in one of two ways. `columns` and `expressions` are
 * the plain way: an index over columns alone, or over expressions alone, each
 * key ascending and with nothing else said of it. `keys` is the full way: the
 * keys in their order, each a column or an expression, with its order, where
 * its NULLs stand, its operator class, and its collation.
 *
 * So that one index is said in one way, `keys` is there only when the plain
 * way cannot say the index, and then `columns` and `expressions` are its
 * columns and its expressions in the order of the keys. These functions hold
 * that rule, for whoever reads, writes, or compares an index.
 */

/** The parts of an index that say its keys. */
export interface IndexKeyLists {
  columns: readonly string[];
  expressions?: readonly string[] | undefined;
  keys?: readonly IndexKey[] | undefined;
}

const OPTIONS = ["order", "nulls", "operatorClass", "collation"] as const;

/** Whether a key says more of itself than which column or expression it is. */
export function indexKeyHasOptions(key: IndexKey): boolean {
  return OPTIONS.some((option) => key[option] !== undefined);
}

/** A key with its parts in one order, and nothing that says nothing. */
export function copyIndexKey(key: IndexKey): IndexKey {
  return {
    ...(key.column !== undefined && { column: key.column }),
    ...(key.expression !== undefined && { expression: key.expression }),
    ...(key.order !== undefined && { order: key.order }),
    ...(key.nulls !== undefined && { nulls: key.nulls }),
    ...(key.operatorClass !== undefined && { operatorClass: key.operatorClass }),
    ...(key.collation !== undefined && { collation: key.collation }),
  };
}

/**
 * The keys of an index in their order, or `undefined` when the index does
 * not say the order: it has columns and expressions both, and no `keys`.
 */
export function indexKeys(index: IndexKeyLists): IndexKey[] | undefined {
  if (index.keys !== undefined) {
    return index.keys.map(copyIndexKey);
  }
  const expressions = index.expressions ?? [];
  if (index.columns.length > 0 && expressions.length > 0) {
    return undefined;
  }
  return [...index.columns.map((column): IndexKey => ({ column })), ...expressions.map((expression): IndexKey => ({ expression }))];
}

/**
 * Keys as an index holds them: its columns and its expressions in the order
 * of the keys, and `keys` itself only when those two do not say the index.
 */
export function indexKeyLists(keys: readonly IndexKey[]): { columns: string[]; expressions?: string[]; keys?: IndexKey[] } {
  const columns = keys.flatMap((key) => (key.column === undefined ? [] : [key.column]));
  const expressions = keys.flatMap((key) => (key.expression === undefined ? [] : [key.expression]));
  const plain = !keys.some(indexKeyHasOptions) && (columns.length === 0 || expressions.length === 0);
  return { columns, ...(expressions.length > 0 && { expressions }), ...(!plain && { keys: keys.map(copyIndexKey) }) };
}

/**
 * What is wrong with the keys of an index, as a sentence; `undefined` when
 * nothing is. A key is a column or an expression, never both and never
 * neither; a place for NULLs is given only when it is not the order's own;
 * and `columns` and `expressions` beside `keys` are the keys' own.
 */
export function indexKeysProblem(index: IndexKeyLists): string | undefined {
  const { keys } = index;
  if (keys === undefined) {
    return undefined;
  }
  if (keys.length === 0) {
    return '"keys" has no key';
  }
  for (const [place, key] of keys.entries()) {
    const what = `key ${place + 1}`;
    if ((key.column === undefined) === (key.expression === undefined)) {
      return `${what} must be a "column" or an "expression", and not both`;
    }
    if (key.order !== undefined && key.order !== "desc") {
      return `"order" of ${what} must be "desc"; ascending is said by leaving it out`;
    }
    if (key.nulls !== undefined && key.nulls !== "first" && key.nulls !== "last") {
      return `"nulls" of ${what} must be "first" or "last"`;
    }
    if (key.nulls === (key.order === "desc" ? "first" : "last")) {
      return `"nulls" of ${what} says where NULLs stand anyway in ${key.order === "desc" ? "descending" : "ascending"} order; it is left out then`;
    }
  }
  const lists = indexKeyLists(keys);
  const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, place) => item === b[place]);
  if (!same(lists.columns, index.columns)) {
    return `"columns" must be the columns of "keys" in their order (${lists.columns.join(", ") || "none"})`;
  }
  if (!same(lists.expressions ?? [], index.expressions ?? [])) {
    return '"expressions" must be the expressions of "keys" in their order';
  }
  if (lists.keys === undefined) {
    return '"keys" says nothing that "columns" and "expressions" do not say; it is left out then';
  }
  return undefined;
}
