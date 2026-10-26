import type { MigrationFile } from "./migrations.ts";

/*
 * PostgreSQL's own parser, through libpg-query: the parser of the PostgreSQL
 * server (libpg_query), compiled to WebAssembly. It is the one runtime
 * dependency of the package (D-034), and it is loaded only here, when
 * migrations are collected, so no other command pays for it.
 *
 * It returns PostgreSQL's parse tree, in which every statement and most nodes
 * carry their position in the text as a byte offset. Nothing is analysed
 * here; the collector reads the tree.
 */

/** A node of PostgreSQL's parse tree, as JSON: `{ "CreateStmt": { ... } }` and so on. */
export type PgNode = Record<string, any>;

export interface ParsedStatement {
  /** The statement's node: one key, the node type, e.g. `CreateStmt`. */
  node: PgNode;
  kind: string;
  /** Position in the file's bytes. */
  start: number;
  end: number;
  /** 1-based line of the statement's first character. */
  line: number;
  /** 1-based number of the statement in its file. */
  index: number;
  /** The statement's text, without the semicolon that ends it. */
  text: string;
}

/** A migration that PostgreSQL itself would refuse to parse. */
export class MigrationSyntaxError extends Error {
  readonly file: string;
  readonly line: number;
  readonly column: number;

  constructor(file: string, line: number, column: number, message: string) {
    super(`${file}:${line}:${column}: ${message}`);
    this.name = "MigrationSyntaxError";
    this.file = file;
    this.line = line;
    this.column = column;
  }
}

interface LibPgQuery {
  parse(query: string): Promise<{ version?: number; stmts?: { stmt?: PgNode; stmt_location?: number; stmt_len?: number }[] }>;
  scanSync(query: string): { tokens: { start: number; end: number; text: string; tokenName: string }[] };
  loadModule(): Promise<void>;
}

let loading: Promise<LibPgQuery> | undefined;

/** The parser, loaded once. */
export function loadParser(): Promise<LibPgQuery> {
  loading ??= (async () => {
    let module: LibPgQuery;
    try {
      module = (await import("libpg-query")) as unknown as LibPgQuery;
    } catch (cause) {
      throw new Error("The PostgreSQL parser (the package libpg-query) could not be loaded. Reinstall local-db-sandbox.", { cause });
    }
    await module.loadModule();
    return module;
  })();
  return loading;
}

/** Bytes as a Buffer, without copying. (Uint8Array in signatures: the published declarations name no Node type.) */
function buffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The 1-based line of a byte offset. */
export function lineAt(bytes: Uint8Array, offset: number): number {
  let line = 1;
  for (let index = bytes.indexOf(10); index !== -1 && index < offset; index = bytes.indexOf(10, index + 1)) {
    line += 1;
  }
  return line;
}

/** Parses one migration file into its statements. Throws `MigrationSyntaxError` when PostgreSQL could not parse it. */
export async function parseMigration(file: MigrationFile): Promise<ParsedStatement[]> {
  const parser = await loadParser();
  const bytes = buffer(file.bytes);
  const text = bytes.toString("utf8");
  let result;
  try {
    result = await parser.parse(text);
  } catch (error) {
    const details = (error as { sqlDetails?: { message?: string; cursorPosition?: number } }).sqlDetails;
    const message = details?.message ?? (error instanceof Error ? error.message : String(error));
    // The parser reports the position as a 0-based character offset.
    const before = text.slice(0, Math.max(0, details?.cursorPosition ?? 0));
    const line = before.split("\n").length;
    const column = before.length - before.lastIndexOf("\n");
    throw new MigrationSyntaxError(file.file, line, column, message);
  }
  return (result.stmts ?? []).map((entry, position) => {
    const node = entry.stmt ?? {};
    const start = entry.stmt_location ?? 0;
    // The last statement of a file without a final semicolon has no length: it runs to the end.
    const end = entry.stmt_len === undefined || entry.stmt_len === 0 ? bytes.length : start + entry.stmt_len;
    const raw = bytes.subarray(start, end).toString("utf8");
    const leading = raw.length - raw.trimStart().length;
    return {
      node,
      kind: Object.keys(node)[0] ?? "Unknown",
      start,
      end,
      line: lineAt(file.bytes, start + Buffer.byteLength(raw.slice(0, leading))),
      index: position + 1,
      text: raw.trim().replace(/;$/, "").trimEnd(),
    };
  });
}

/** What the scanner calls a comment. A comment is no part of an expression's extent. */
const COMMENT_TOKENS = new Set(["SQL_COMMENT", "C_COMMENT"]);

/**
 * The source text of an expression whose first node is at `offset` in
 * `bytes`: up to the first `,` or unmatched `)` outside parentheses, or a
 * word in `stopWords` outside parentheses. Read with PostgreSQL's own
 * scanner, so that strings, quoted names, and comments do not end it early.
 *
 * The parse tree has no node for a parenthesis, so an expression that starts
 * with one has its first node within it: `(a > 0) and (b > 0)` starts, to
 * the tree, at `a`. With `from` (where the statement starts), the
 * parentheses that open just before `offset` are looked at: one that closes
 * while the expression goes on is part of it, and one that closes where the
 * expression ends is around all of it, which says nothing, or belongs to the
 * statement (`CHECK (...)`), and is left out. A comment after the expression
 * is not part of it either.
 *
 * `lists`: how many of those parentheses, from the outside, are a list of
 * the statement's (the elements of an index): within them a `,` ends the
 * expression, as it does outside every parenthesis. An element of such a
 * list is an expression in parentheses of its own, or a call of a function,
 * and ends with that: what stands after it (`DESC`, an operator class, a
 * collation) is said of the element.
 */
export async function expressionText(bytes: Uint8Array, offset: number, end: number, stopWords: ReadonlySet<string> = new Set(), from = offset, lists = 0): Promise<string> {
  const parser = await loadParser();
  const sourceBytes = buffer(bytes).subarray(from, end);
  const tokens = parser.scanSync(sourceBytes.toString("utf8")).tokens.filter((token) => !COMMENT_TOKENS.has(token.tokenName));
  const first = tokens.findIndex((token) => token.start >= offset - from);
  if (first < 0) {
    return "";
  }
  const wordAt = (index: number): string | undefined => tokens[index]?.text.toLowerCase();
  /** The parentheses that open just before the expression's first node, and are not closed yet. */
  let pending = 0;
  while (wordAt(first - pending - 1) === "(") {
    pending += 1;
  }
  /** Whether the expression is an element of a list of the statement's. */
  const inList = lists > 0;
  // The list's own parentheses open before its first element alone: an element after a `,` has only its own before it.
  const ofList = inList && wordAt(first - pending - 1) !== "," ? Math.min(lists, pending) : 0;
  /** Of those, the ones that turned out to be part of the expression: the innermost ones. */
  let taken = 0;
  let depth = 0;
  let last = -1;
  for (let index = first; index < tokens.length; ) {
    const word = wordAt(index) as string;
    if (depth === 0 && word === ")") {
      // A parenthesis that is a list of the statement's is never the expression's: where it closes, the expression has ended.
      let closing = 0;
      while (closing < pending - ofList && wordAt(index + closing) === ")") {
        closing += 1;
      }
      const next = wordAt(index + closing);
      // Nothing of the expression follows: these parentheses are around all of it, or the statement's.
      if (closing === 0 || next === undefined || next === ";" || next === ")" || (pending - closing <= ofList && (next === "," || stopWords.has(next)))) {
        break;
      }
      // An element of a list is one expression in parentheses of its own: what follows those is said of the element (its order, its operator class), not by it.
      if (inList && pending - closing <= ofList) {
        break;
      }
      pending -= closing;
      taken += closing;
      index += closing;
      last = index - 1;
      continue;
    }
    if (depth === 0 && pending <= ofList && (word === "," || word === ";" || (last >= 0 && stopWords.has(word)))) {
      break;
    }
    if (word === "(" || word === "[") {
      depth += 1;
    } else if (word === ")" || word === "]") {
      depth -= 1;
      // An element of a list that is not in parentheses of its own is a call of a function: it ends where the call does.
      if (inList && pending <= ofList && depth === 0) {
        last = index;
        break;
      }
    }
    last = index;
    index += 1;
  }
  if (last < 0) {
    return "";
  }
  return sourceBytes.subarray((tokens[first - taken] as { start: number }).start, (tokens[last] as { end: number }).end).toString("utf8").trim();
}
