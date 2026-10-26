/*
 * Reads a mail message (RFC 5322 with MIME) far enough to show it: the
 * headers, the plain-text and HTML bodies, and what the attachments are.
 *
 * It is a reader for inspection, not a mail library. Attachment content is
 * measured and dropped, nothing a message refers to is fetched, and nothing
 * in a message is executed or rendered.
 */

export interface MailHeader {
  name: string;
  /** Unfolded, with encoded words (`=?UTF-8?B?...?=`) decoded. */
  value: string;
}

/** What an attachment is. Its content is not kept. */
export interface MailAttachment {
  filename?: string;
  contentType: string;
  /** Size of the decoded content, in bytes. */
  sizeBytes: number;
  disposition: "attachment" | "inline";
  /** `Content-ID`, by which an HTML body refers to an inline image. */
  contentId?: string;
}

export interface ParsedMail {
  /** The message's own headers, in order. */
  headers: MailHeader[];
  subject: string;
  /** The plain-text body, with `\n` line breaks. Whether it ends with one depends on how the message was put together. */
  text?: string;
  /** The HTML body, as text. Nothing in it is fetched or run. */
  html?: string;
  attachments: MailAttachment[];
}

interface Part {
  headers: MailHeader[];
  /** The body as received: one character per byte. */
  body: string;
}

/** Parts within parts are followed this deep; anything deeper is counted as an attachment. */
const MAX_DEPTH = 20;

function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  for (const label of [charset, "utf-8"]) {
    if (label !== undefined) {
      try {
        return new TextDecoder(label, { fatal: true }).decode(bytes);
      } catch {
        // An unknown character set, or bytes that are not in it: try the next.
      }
    }
  }
  return bytes.toString("latin1");
}

function decodeQuotedPrintable(text: string, inHeader: boolean): Buffer {
  const source = inHeader ? text.replaceAll("_", " ") : text.replace(/=\r?\n/g, "");
  return Buffer.from(source.replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
}

/** Decodes `=?charset?B?...?=` and `=?charset?Q?...?=`. White space between two encoded words is not part of the text. */
function decodeEncodedWords(value: string): string {
  return value
    .replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, "$1")
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (_match, charset: string, encoding: string, text: string) => {
      const bytes = encoding.toUpperCase() === "B" ? Buffer.from(text, "base64") : decodeQuotedPrintable(text, true);
      // RFC 2231 allows a language after the character set: `utf-8*en`.
      return decodeBytes(bytes, charset.split("*")[0]);
    });
}

function parseHeaders(head: string): MailHeader[] {
  const headers: MailHeader[] = [];
  // A line that starts with white space continues the header before it.
  for (const line of head.replace(/\r?\n(?=[ \t])/g, "").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      // Header text that is not ASCII is UTF-8 (SMTPUTF8) when it is valid UTF-8.
      const raw = decodeBytes(Buffer.from(line.slice(colon + 1).trim(), "latin1"), undefined);
      headers.push({ name: line.slice(0, colon).trim(), value: decodeEncodedWords(raw) });
    }
  }
  return headers;
}

function splitPart(source: string): Part {
  // Headers end at the first empty line. A message may also have no headers at all.
  const match = /\r?\n\r?\n/.exec(source);
  if (/^\r?\n/.test(source)) {
    return { headers: [], body: source.replace(/^\r?\n/, "") };
  }
  return match === null ? { headers: parseHeaders(source), body: "" } : { headers: parseHeaders(source.slice(0, match.index)), body: source.slice(match.index + match[0].length) };
}

function header(part: Part, name: string): string | undefined {
  return part.headers.find((candidate) => candidate.name.toLowerCase() === name)?.value;
}

/** A header of the form `value; name=x; other="y"`, with the parameter forms of RFC 2231 (`name*=utf-8''...`, `name*0=`, `name*1=`). */
function parseParameters(value: string | undefined): { value: string; parameters: Record<string, string> } {
  const [main = "", ...rest] = (value ?? "").match(/(?:[^;"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
  const pieces = new Map<string, { index: number; text: string; encoded: boolean }[]>();
  for (const piece of rest) {
    const equals = piece.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const match = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(piece.slice(0, equals).trim().toLowerCase());
    if (match === null) {
      continue;
    }
    let text = piece.slice(equals + 1).trim();
    if (text.startsWith('"')) {
      text = text.slice(1, text.endsWith('"') ? -1 : undefined).replace(/\\(.)/g, "$1");
    }
    const name = match[1] as string;
    pieces.set(name, [...(pieces.get(name) ?? []), { index: Number(match[2] ?? 0), text, encoded: match[3] === "*" }]);
  }
  const parameters: Record<string, string> = {};
  for (const [name, parts] of pieces) {
    parts.sort((a, b) => a.index - b.index);
    let charset: string | undefined;
    let bytes = "";
    for (const [position, part] of parts.entries()) {
      let text = part.text;
      if (part.encoded) {
        if (position === 0) {
          // charset'language'text
          const quotes = /^([^']*)'[^']*'(.*)$/.exec(text);
          if (quotes !== null) {
            charset = quotes[1] || undefined;
            text = quotes[2] as string;
          }
        }
        text = text.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      }
      bytes += text;
    }
    parameters[name] = parts.some((part) => part.encoded) ? decodeBytes(Buffer.from(bytes, "latin1"), charset) : decodeEncodedWords(bytes);
  }
  return { value: main.trim().toLowerCase(), parameters };
}

function decodeBody(part: Part): Buffer {
  const encoding = (header(part, "content-transfer-encoding") ?? "7bit").trim().toLowerCase();
  if (encoding === "base64") {
    return Buffer.from(part.body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  }
  return encoding === "quoted-printable" ? decodeQuotedPrintable(part.body, false) : Buffer.from(part.body, "latin1");
}

/** The parts of a multipart body: what is between its boundary lines. */
function splitMultipart(body: string, boundary: string): string[] {
  const parts: string[] = [];
  // Every boundary line is preceded by a line break, which belongs to the boundary and not to the part before it.
  const segments = `\r\n${body}`.split(new RegExp(`\\r?\\n--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  for (const segment of segments.slice(1)) {
    if (segment.startsWith("--")) {
      break;
    }
    parts.push(segment.replace(/^[ \t]*\r?\n/, ""));
  }
  return parts;
}

function walk(part: Part, mail: ParsedMail, depth: number): void {
  const type = parseParameters(header(part, "content-type") ?? "text/plain");
  const boundary = type.parameters.boundary;
  if (type.value.startsWith("multipart/") && boundary !== undefined && depth < MAX_DEPTH) {
    for (const child of splitMultipart(part.body, boundary)) {
      walk(splitPart(child), mail, depth + 1);
    }
    return;
  }

  const disposition = parseParameters(header(part, "content-disposition"));
  const filename = disposition.parameters.filename ?? type.parameters.name;
  const content = decodeBody(part);
  const isBody = disposition.value !== "attachment" && filename === undefined && (type.value === "text/plain" || type.value === "text/html");
  if (isBody) {
    // Lines end with CR LF on the wire, whatever the application wrote; a body is shown with plain line breaks.
    const text = decodeBytes(content, type.parameters.charset).replace(/\r\n/g, "\n");
    const key = type.value === "text/html" ? "html" : "text";
    // A second body of the same kind continues the first, as mail readers show it.
    mail[key] = mail[key] === undefined ? text : `${mail[key]}\n${text}`;
    return;
  }
  const contentId = header(part, "content-id")?.replace(/^<|>$/g, "");
  mail.attachments.push({
    ...(filename !== undefined && { filename }),
    contentType: type.value || "application/octet-stream",
    sizeBytes: content.length,
    disposition: disposition.value === "inline" ? "inline" : "attachment",
    ...(contentId !== undefined && { contentId }),
  });
}

/**
 * Reads a message as it was received over SMTP, from its bytes. A message
 * that is not well formed is read as far as it goes; this does not throw.
 */
export function parseMail(raw: Uint8Array): ParsedMail {
  const message = splitPart(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("latin1"));
  const mail: ParsedMail = { headers: message.headers, subject: header(message, "subject") ?? "", attachments: [] };
  try {
    walk(message, mail, 0);
  } catch {
    // What was read so far is still worth showing.
  }
  return mail;
}
