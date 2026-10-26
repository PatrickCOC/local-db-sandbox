/*
 * PostgreSQL's text form of an array, as a migration writes it in a default
 * or an inserted row: `{}`, `{a,b}`, `{"a b",NULL}`, `{{1,2},{3,4}}`.
 *
 * The elements are returned as the texts they are; what a text is a value of
 * depends on the array's element type, which the collector knows. A text
 * that is not an array literal gives `undefined`, and so does what the
 * collector has no use for: a literal that says its own bounds
 * (`[1:2]={a,b}`), and one whose arrays within are not all of one length,
 * which PostgreSQL refuses.
 */

export type ArrayElement = string | null | ArrayElement[];

const SPACE = /[ \t\n\r\f\v]/;

/** The elements of an array literal, or `undefined` for a text that is not one. */
export function parseArrayLiteral(text: string): ArrayElement[] | undefined {
  let position = 0;
  const skipSpace = (): void => {
    while (position < text.length && SPACE.test(text[position] as string)) {
      position += 1;
    }
  };

  /** An array from its `{` to its `}`. */
  const array = (): ArrayElement[] | undefined => {
    position += 1;
    const elements: ArrayElement[] = [];
    skipSpace();
    if (text[position] === "}") {
      position += 1;
      return elements;
    }
    for (;;) {
      skipSpace();
      const element = text[position] === "{" ? array() : text[position] === '"' ? quoted() : bare();
      if (element === undefined) {
        return undefined;
      }
      elements.push(element);
      skipSpace();
      const next = text[position];
      position += 1;
      if (next === "}") {
        return elements;
      }
      if (next !== ",") {
        return undefined;
      }
    }
  };

  /** An element in double quotes: everything is itself, and a backslash makes the next character so. */
  const quoted = (): string | undefined => {
    position += 1;
    let value = "";
    while (position < text.length && text[position] !== '"') {
      if (text[position] === "\\") {
        position += 1;
      }
      if (position >= text.length) {
        return undefined;
      }
      value += text[position];
      position += 1;
    }
    if (position >= text.length) {
      return undefined;
    }
    position += 1;
    return value;
  };

  /**
   * An element without quotes: up to the next `,` or `}`, without the spaces
   * around it. A backslash makes the next character itself here too: such a
   * space is not one around the element, and such a `,` is no end. `NULL` is
   * no value, unless a backslash is in it.
   */
  const bare = (): string | null | undefined => {
    let value = "";
    // How much of the value is left when the spaces at its end are taken off.
    let kept = 0;
    let escaped = false;
    while (position < text.length && text[position] !== "," && text[position] !== "}") {
      const character = text[position] as string;
      if (character === '"' || character === "{") {
        return undefined;
      }
      if (character === "\\") {
        position += 1;
        if (position >= text.length) {
          return undefined;
        }
        value += text[position];
        kept = value.length;
        escaped = true;
      } else {
        value += character;
        if (!SPACE.test(character)) {
          kept = value.length;
        }
      }
      position += 1;
    }
    const trimmed = value.slice(0, kept);
    if (trimmed === "") {
      return undefined;
    }
    return !escaped && /^null$/i.test(trimmed) ? null : trimmed;
  };

  skipSpace();
  if (text[position] !== "{") {
    return undefined;
  }
  const elements = array();
  skipSpace();
  if (elements === undefined || position !== text.length || !rectangular(elements)) {
    return undefined;
  }
  return elements;
}

/** Whether the arrays within an array are all arrays, or none is, and those that are have one length and are rectangular themselves. */
function rectangular(elements: readonly ArrayElement[]): boolean {
  const arrays = elements.filter((element): element is ArrayElement[] => Array.isArray(element));
  if (arrays.length === 0) {
    return true;
  }
  return arrays.length === elements.length && arrays.every((inner) => inner.length === (arrays[0] as ArrayElement[]).length && rectangular(inner));
}
