import type { PgNode } from "./parser.ts";

/*
 * The names PostgreSQL gives the objects a statement does not name, so that
 * the collected schema holds the names a real database would have, and no
 * later step has to assume them (D-036):
 *
 *   primary key        <table>_pkey
 *   unique constraint  <table>_<columns>_key
 *   index              <table>_<columns>_idx     (an expression by its function's name, else "expr")
 *   foreign key        <table>_<columns>_fkey
 *   check              <table>_<column>_check    (the one column it uses; else <table>_check)
 *   serial / identity  <table>_<column>_seq      (the sequence)
 *
 * Reproduced from PostgreSQL's makeObjectName, ChooseRelationName,
 * ChooseConstraintName, ChooseIndexNameAddition, ChooseIndexColumnNames, and
 * FigureColname: a name is at most 63 bytes, cut from the longer of its two
 * parts and at a character boundary, and a name already in use is tried
 * again with a number after the label (`_key1`, `_key2`, ...). Index and
 * constraint names are in use across the whole schema, not per table.
 */

/** PostgreSQL's NAMEDATALEN: names are at most NAMEDATALEN - 1 bytes. */
export const NAMEDATALEN = 64;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The longest start of `text` of at most `bytes` bytes that does not cut a character (pg_mbcliplen). */
function clip(text: string, bytes: number): string {
  let used = 0;
  let clipped = "";
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > bytes) {
      break;
    }
    clipped += character;
    used += size;
  }
  return clipped;
}

/** `name1_name2_label`, cut to fit 63 bytes, the longer of the two names first (makeObjectName). */
export function makeObjectName(name1: string, name2: string | undefined, label: string | undefined): string {
  let overhead = 0;
  let name1Bytes = byteLength(name1);
  let name2Bytes = 0;
  if (name2 !== undefined) {
    name2Bytes = byteLength(name2);
    overhead += 1;
  }
  if (label !== undefined) {
    overhead += byteLength(label) + 1;
  }
  const available = NAMEDATALEN - 1 - overhead;
  while (name1Bytes + name2Bytes > available) {
    if (name1Bytes > name2Bytes) {
      name1Bytes -= 1;
    } else {
      name2Bytes -= 1;
    }
  }
  let name = clip(name1, name1Bytes);
  if (name2 !== undefined) {
    name += `_${clip(name2, name2Bytes)}`;
  }
  if (label !== undefined) {
    name += `_${label}`;
  }
  return name;
}

/** Column names joined with `_`, as far as they fit (ChooseIndexNameAddition, ChooseForeignKeyConstraintNameAddition). */
export function nameAddition(columns: readonly string[]): string {
  let addition = "";
  for (const column of columns) {
    if (addition !== "") {
      addition += "_";
    }
    addition += clip(column, NAMEDATALEN - 1);
    if (byteLength(addition) >= NAMEDATALEN) {
      break;
    }
  }
  return addition;
}

/** The names in use in a schema: relations (tables, indexes, sequences) and constraints. */
export interface Namespace {
  relations: Set<string>;
  constraints: Set<string>;
}

/**
 * A name for an index or a sequence (ChooseRelationName). `isConstraint`: the
 * index belongs to a primary key or unique constraint, whose name is also a
 * constraint's.
 */
export function chooseRelationName(namespace: Namespace, name1: string, name2: string | undefined, label: string, isConstraint: boolean): string {
  for (let pass = 0; ; pass += 1) {
    const name = makeObjectName(name1, name2, pass === 0 ? label : `${label}${pass}`);
    if (!namespace.relations.has(name) && !(isConstraint && namespace.constraints.has(name))) {
      return name;
    }
  }
}

/** A name for a foreign key or check constraint (ChooseConstraintName). */
export function chooseConstraintName(namespace: Namespace, name1: string, name2: string | undefined, label: string): string {
  for (let pass = 0; ; pass += 1) {
    const name = makeObjectName(name1, name2, pass === 0 ? label : `${label}${pass}`);
    if (!namespace.constraints.has(name)) {
      return name;
    }
  }
}

function lastName(nodes: PgNode[] | undefined): string | undefined {
  const last = nodes?.at(-1)?.String?.sval;
  return typeof last === "string" ? last : undefined;
}

const VALUE_FUNCTION_NAMES: Record<string, string> = {
  SVFOP_CURRENT_DATE: "current_date",
  SVFOP_CURRENT_TIME: "current_time",
  SVFOP_CURRENT_TIME_N: "current_time",
  SVFOP_CURRENT_TIMESTAMP: "current_timestamp",
  SVFOP_CURRENT_TIMESTAMP_N: "current_timestamp",
  SVFOP_LOCALTIME: "localtime",
  SVFOP_LOCALTIME_N: "localtime",
  SVFOP_LOCALTIMESTAMP: "localtimestamp",
  SVFOP_LOCALTIMESTAMP_N: "localtimestamp",
  SVFOP_CURRENT_ROLE: "current_role",
  SVFOP_CURRENT_USER: "current_user",
  SVFOP_USER: "user",
  SVFOP_SESSION_USER: "session_user",
  SVFOP_CURRENT_CATALOG: "current_catalog",
  SVFOP_CURRENT_SCHEMA: "current_schema",
};

/**
 * The name PostgreSQL gives an expression's result, and how sure it is
 * (FigureColnameInternal): 2 for a column or function name, 1 for a type or
 * `case`, 0 for none.
 */
function figureName(node: PgNode | undefined): { name?: string; strength: number } {
  if (node === undefined) {
    return { strength: 0 };
  }
  if (node.ColumnRef !== undefined) {
    const name = lastName(node.ColumnRef.fields);
    return name === undefined ? { strength: 0 } : { name, strength: 2 };
  }
  if (node.A_Indirection !== undefined) {
    const name = lastName(node.A_Indirection.indirection);
    return name === undefined ? figureName(node.A_Indirection.arg) : { name, strength: 2 };
  }
  if (node.FuncCall !== undefined) {
    const name = lastName(node.FuncCall.funcname);
    return name === undefined ? { strength: 0 } : { name, strength: 2 };
  }
  if (node.A_Expr !== undefined) {
    return node.A_Expr.kind === "AEXPR_NULLIF" ? { name: "nullif", strength: 2 } : { strength: 0 };
  }
  if (node.TypeCast !== undefined) {
    const inner = figureName(node.TypeCast.arg);
    if (inner.strength <= 1) {
      const name = lastName(node.TypeCast.typeName?.names);
      return name === undefined ? inner : { name, strength: 1 };
    }
    return inner;
  }
  if (node.CollateClause !== undefined) {
    return figureName(node.CollateClause.arg);
  }
  if (node.CaseExpr !== undefined) {
    const inner = figureName(node.CaseExpr.defresult);
    return inner.strength <= 1 ? { name: "case", strength: 1 } : inner;
  }
  if (node.A_ArrayExpr !== undefined) {
    return { name: "array", strength: 2 };
  }
  if (node.RowExpr !== undefined) {
    return { name: "row", strength: 2 };
  }
  if (node.CoalesceExpr !== undefined) {
    return { name: "coalesce", strength: 2 };
  }
  if (node.MinMaxExpr !== undefined) {
    return { name: node.MinMaxExpr.op === "IS_GREATEST" ? "greatest" : "least", strength: 2 };
  }
  if (node.SQLValueFunction !== undefined) {
    const name = VALUE_FUNCTION_NAMES[node.SQLValueFunction.op as string];
    return name === undefined ? { strength: 0 } : { name, strength: 2 };
  }
  if (node.GroupingFunc !== undefined) {
    return { name: "grouping", strength: 2 };
  }
  return { strength: 0 };
}

/** The column names PostgreSQL gives an index's elements, made distinct (ChooseIndexColumnNames). */
export function indexColumnNames(elements: readonly PgNode[]): string[] {
  const names: string[] = [];
  for (const element of elements) {
    const original = typeof element.indexcolname === "string" ? element.indexcolname : typeof element.name === "string" ? element.name : (figureName(element.expr).name ?? "expr");
    let candidate = original;
    for (let counter = 1; names.includes(candidate); counter += 1) {
      const suffix = String(counter);
      candidate = `${clip(original, NAMEDATALEN - 1 - suffix.length)}${suffix}`;
    }
    names.push(candidate);
  }
  return names;
}
