export interface PositionalParameters {
  /** The statement with each `$N` placeholder written as `?N`. The statement itself, unchanged, when it has none. */
  sql: string;
  /** The distinct numbers of the statement's `$N` placeholders, in ascending order; empty when it has none. */
  numbers: number[];
  /** Whether the statement has `?` placeholders as well. Only looked for in a statement that has `$N` placeholders. */
  questionMarks: boolean;
}

/** A run of the characters SQLite takes as part of one name or number, which includes `$`. */
const WORD = /[\w$\u0080-￿]+/y;
/** `$N` that is not the start of a longer name such as `$1abc`. */
const PLACEHOLDER = /\$(\d+)(?![\w$\u0080-￿])/y;

/**
 * Writes PostgreSQL-style positional placeholders (`$1`, `$2`, ...) the way
 * SQLite spells the same thing: `?1`, `?2`, ... The number is kept, so the
 * order of the placeholders, repeated numbers, and the parameter array all
 * keep their meaning: SQLite binds the Nth parameter to every `?N`.
 *
 * Without this, SQLite reads `$1` as a parameter that is named `$1`, which a
 * positional parameter array does not bind.
 *
 * Only the spelling of the placeholder changes. Nothing else of the
 * statement is read or translated, and the text is not parsed: it is scanned
 * for what can hold a `$N` that is not a placeholder, which is quoted
 * strings and identifiers (`'...'`, `"..."`, `` `...` ``, `[...]`), comments
 * (`-- ...`, `/* ... *\/`), and names that contain `$` (`price$1`, `:p$1`).
 * These are recognized as SQLite recognizes them, because SQLite is what
 * reads the result.
 */
export function rewritePositionalParameters(sql: string): PositionalParameters {
  if (!sql.includes("$")) {
    return { sql, numbers: [], questionMarks: false };
  }
  const numbers = new Set<number>();
  let questionMarks = false;
  let rewritten = "";
  let copied = 0;
  let index = 0;
  const skipTo = (end: string, from: number): number => {
    const found = sql.indexOf(end, from);
    return found === -1 ? sql.length : found + end.length;
  };

  while (index < sql.length) {
    const char = sql[index] as string;
    if (char === "'" || char === '"' || char === "`") {
      // A doubled quote inside a quoted run is an escaped quote: skipping run by run handles it.
      index = skipTo(char, index + 1);
    } else if (char === "[") {
      index = skipTo("]", index + 1);
    } else if (char === "-" && sql[index + 1] === "-") {
      index = skipTo("\n", index + 2);
    } else if (char === "/" && sql[index + 1] === "*") {
      index = skipTo("*/", index + 2);
    } else if (char === "$") {
      PLACEHOLDER.lastIndex = index;
      const match = PLACEHOLDER.exec(sql);
      if (match === null) {
        index += 1;
        continue;
      }
      numbers.add(Number(match[1]));
      rewritten += `${sql.slice(copied, index)}?${match[1]}`;
      index += match[0].length;
      copied = index;
    } else {
      questionMarks ||= char === "?";
      // A name is skipped whole, so that a `$N` inside it is not taken for a placeholder. So is the name of a `:name`, `@name`, or `#name` parameter.
      WORD.lastIndex = char === ":" || char === "@" || char === "#" ? index + 1 : index;
      index = WORD.test(sql) ? WORD.lastIndex : index + 1;
    }
  }
  return { sql: numbers.size === 0 ? sql : rewritten + sql.slice(copied), numbers: [...numbers].sort((a, b) => a - b), questionMarks };
}
