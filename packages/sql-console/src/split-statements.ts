export interface SplitResult {
  /** Complete statements, each without its terminating semicolon. */
  statements: string[];
  /** Text after the last semicolon: an unfinished statement, or nothing but space and comments. */
  rest: string;
}

/**
 * Splits text into SQL statements at semicolons.
 *
 * This only tracks what can hide a semicolon: quoted strings and identifiers
 * (`'...'`, `"..."`, `` `...` ``, `[...]`) and comments (`-- ...`, `/* ... *\/`).
 * It does not parse SQL. A statement that contains semicolons of its own,
 * such as CREATE TRIGGER, is not kept together.
 */
export function splitStatements(text: string): SplitResult {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  const skipTo = (end: string, from: number): number => {
    const found = text.indexOf(end, from);
    return found === -1 ? text.length : found + end.length;
  };

  while (index < text.length) {
    const char = text[index] as string;
    if (char === "'" || char === '"' || char === "`") {
      // A doubled quote inside a quoted run is an escaped quote: skipping run by run handles it.
      index = skipTo(char, index + 1);
    } else if (char === "[") {
      index = skipTo("]", index + 1);
    } else if (char === "-" && text[index + 1] === "-") {
      index = skipTo("\n", index + 2);
    } else if (char === "/" && text[index + 1] === "*") {
      index = skipTo("*/", index + 2);
    } else if (char === ";") {
      const statement = text.slice(start, index).trim();
      if (hasSql(statement)) {
        statements.push(statement);
      }
      index += 1;
      start = index;
    } else {
      index += 1;
    }
  }
  return { statements, rest: text.slice(start) };
}

/** Whether text contains anything other than space and comments. */
export function hasSql(text: string): boolean {
  return text.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim() !== "";
}
