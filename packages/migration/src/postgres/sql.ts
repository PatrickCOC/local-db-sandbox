import { refuse } from "./safety.ts";

/*
 * Names and texts as PostgreSQL reads them (D-039). These two functions are
 * the only places where something of a schema becomes part of SQL text
 * without being a type or a number: whatever a name or a text holds, it is
 * that name or that text to PostgreSQL, and nothing else.
 */

/** PostgreSQL's NAMEDATALEN - 1. A longer name is cut short by PostgreSQL, which says so in a notice and goes on. */
const MAX_NAME_BYTES = 63;

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/**
 * A name, quoted. Always quoted: so no word of PostgreSQL's, no capital
 * letter, and no character of any kind changes what it names, and no list of
 * PostgreSQL's words has to be kept. Refuses a name that PostgreSQL would
 * not keep as it is.
 */
export function quoteIdentifier(name: string): string {
  if (name === "") {
    refuse("name-not-representable", "A name is empty.");
  }
  if (name.includes("\u0000")) {
    refuse("name-not-representable", `The name ${JSON.stringify(name)} has a NUL character, which no name of PostgreSQL has.`);
  }
  if (bytesOf(name) > MAX_NAME_BYTES) {
    refuse("name-not-representable", `The name "${name}" is ${bytesOf(name)} bytes long. PostgreSQL keeps ${MAX_NAME_BYTES} and cuts the rest off without an error, so the object would get another name than the schema says.`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * A text as a constant. As PostgreSQL's own `quote_literal` writes it: a
 * quote is doubled, and a text with a backslash is written in the escape
 * form with its backslashes doubled, which is the same text whether or not
 * the session reads backslashes in ordinary texts as escapes.
 */
export function quoteLiteral(text: string): string {
  if (text.includes("\u0000")) {
    refuse("value-not-representable", `The text ${JSON.stringify(text)} has a NUL character, which no text of PostgreSQL has.`);
  }
  const quoted = `'${text.replaceAll("'", "''")}'`;
  return text.includes("\\") ? `E${quoted.replaceAll("\\", "\\\\")}` : quoted;
}
