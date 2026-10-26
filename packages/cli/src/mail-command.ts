import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RUNTIME_FILE_NAME } from "../../nest-typeorm/src/index.ts";
import { MailClient } from "../../side-effects/src/index.ts";
import type { CapturedMail } from "../../side-effects/src/index.ts";
import type { CliIo } from "./cli.ts";
import { formatBytes } from "./inspect-command.ts";

export const MAIL_USAGE = `Usage: local-db-sandbox mail list [options]        the captured messages
       local-db-sandbox mail show <id> [options]   one message
       local-db-sandbox mail clear [options]       forget every captured message

Shows the mail that a running sandbox captured. A sandbox captures mail when
its configuration (.local-db-sandbox/sandbox.config.json) has
"smtp": { "mode": "capture" }. The mail is kept in the memory of the sandbox
process ("npm run sandbox"), was sent to no one, and is gone when it stops.

Options:
      --config <file>  The sandbox configuration (default: .local-db-sandbox/sandbox.config.json
                       in the current directory or one above it)
      --json           Print the result as JSON
      --text           show: print the whole plain-text body, and nothing else
      --html           show: print the whole HTML body, and nothing else
      --headers        show: also print every header
  -h, --help           Show this help

"show" prints the first lines of the text body. Attachments are listed by
name, type, and size; their content is not kept and never printed.
`;

/** How many lines of a body `show` prints unless the whole body is asked for. */
const PREVIEW_LINES = 20;
const PREVIEW_LINE_LENGTH = 160;

/** The sandbox configuration at or above a directory, where `init-nest` put it. */
function findConfig(from: string): string | undefined {
  for (let directory = resolve(from); ; directory = dirname(directory)) {
    const candidate = join(directory, ".local-db-sandbox", "sandbox.config.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dirname(directory) === directory) {
      return undefined;
    }
  }
}

function headerOf(mail: CapturedMail, name: string): string | undefined {
  return mail.headers.find((header) => header.name.toLowerCase() === name)?.value;
}

/** Text that cannot move the cursor or change the terminal: control characters other than tabs become visible. */
function printable(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g, (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function when(mail: CapturedMail): string {
  return mail.capturedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** The lines `mail list` prints. */
export function formatMailList(messages: CapturedMail[]): string[] {
  if (messages.length === 0) {
    return ["No mail has been captured."];
  }
  const short = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
  const rows = [
    ["ID", "Captured", "From", "To", "Subject", "Request"],
    ...messages.map((mail) => [
      mail.id,
      when(mail),
      short(printable(mail.from), 32),
      short(printable(`${mail.to[0] ?? ""}${mail.to.length > 1 ? ` (+${mail.to.length - 1})` : ""}`), 36),
      short(printable(mail.subject), 48),
      mail.requestId ?? "unknown",
    ]),
  ];
  const widths = rows[0]?.map((_cell, column) => Math.max(...rows.map((row) => (row[column] as string).length))) ?? [];
  return [...rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] as number)).join("  ").trimEnd()), `(${messages.length} ${messages.length === 1 ? "message" : "messages"})`];
}

/** The lines `mail show` prints. The message stays the source of truth; `--json` prints it. */
export function formatMail(mail: CapturedMail, options: { headers?: boolean } = {}): string[] {
  const lines = [`ID:        ${mail.id}`, `Captured:  ${when(mail)}`, `Request:   ${mail.requestId ?? "unknown"}`];
  for (const [label, name] of [
    ["From", "from"],
    ["To", "to"],
    ["Cc", "cc"],
    ["Reply-To", "reply-to"],
  ] as const) {
    const value = headerOf(mail, name);
    if (value !== undefined) {
      lines.push(`${`${label}:`.padEnd(11)}${printable(value)}`);
    }
  }
  lines.push(`Subject:   ${printable(mail.subject)}`);
  // What the SMTP server was told, which is where the message would have gone: Bcc recipients are only here.
  lines.push(`Envelope:  ${printable(mail.from)} -> ${printable(mail.to.join(", "))}`);
  lines.push(`Size:      ${formatBytes(mail.sizeBytes)}`);
  if (options.headers) {
    lines.push("Headers:", ...mail.headers.map((header) => `  ${printable(header.name)}: ${printable(header.value)}`));
  }
  lines.push(mail.attachments.length === 0 ? "Attachments: none" : "Attachments:");
  for (const attachment of mail.attachments) {
    lines.push(`  ${printable(attachment.filename ?? "(no name)")}  ${printable(attachment.contentType)}  ${formatBytes(attachment.sizeBytes)}${attachment.disposition === "inline" ? "  inline" : ""}`);
  }
  if (mail.text !== undefined) {
    const all = mail.text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
    lines.push("Text:", ...all.slice(0, PREVIEW_LINES).map((line) => `  ${printable(line.length > PREVIEW_LINE_LENGTH ? `${line.slice(0, PREVIEW_LINE_LENGTH - 1)}…` : line)}`));
    if (all.length > PREVIEW_LINES) {
      lines.push(`  ... (${all.length - PREVIEW_LINES} more lines; print all of it with --text)`);
    }
  }
  if (mail.html !== undefined) {
    lines.push(`HTML:      ${formatBytes(Buffer.byteLength(mail.html))} (print it with --html)`);
    if (mail.text === undefined) {
      // Without a text body, the words of the HTML body are the preview. Nothing in it is fetched or run.
      const words = mail.html
        .replace(/<(style|script|head)\b[^]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      lines.push(`  ${printable(words.length > 400 ? `${words.slice(0, 399)}…` : words)}`);
    }
  }
  if (mail.text === undefined && mail.html === undefined) {
    lines.push("The message has no text or HTML body.");
  }
  return lines;
}

/** Runs `mail` and resolves with the process exit code. */
export async function runMail(argv: string[], io: CliIo): Promise<number> {
  const fail = (message: string): number => {
    io.stderr.write(`Error: ${message}\nRun "local-db-sandbox mail --help" for usage.\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        json: { type: "boolean" },
        text: { type: "boolean" },
        html: { type: "boolean" },
        headers: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const [action, id, ...extra] = positionals;
  if (values.help) {
    io.stdout.write(MAIL_USAGE);
    return 0;
  }
  if (action !== "list" && action !== "show" && action !== "clear") {
    return fail(action === undefined ? 'Missing what to do: "list", "show <id>", or "clear".' : `Unknown mail command "${action}": it is "list", "show <id>", or "clear".`);
  }
  if (action === "show" ? id === undefined || extra.length > 0 : id !== undefined) {
    return fail(action === "show" ? 'Give the id of one message, as "mail list" prints it: mail show mail-1' : `"mail ${action}" takes no further argument.`);
  }
  if (values.text && values.html) {
    return fail("--text and --html cannot be used together.");
  }
  const config = values.config === undefined ? findConfig(process.cwd()) : resolve(values.config);
  if (config === undefined || !existsSync(config)) {
    return fail(config === undefined ? "No .local-db-sandbox/sandbox.config.json was found here or above. Run this in the project, or name the configuration with --config." : `${config} does not exist.`);
  }

  try {
    const client = MailClient.open(join(dirname(config), RUNTIME_FILE_NAME));
    if (action === "list") {
      const messages = await client.list();
      io.stdout.write(values.json ? `${JSON.stringify(messages, null, 2)}\n` : `${formatMailList(messages).join("\n")}\n`);
    } else if (action === "clear") {
      const removed = await client.clear();
      io.stdout.write(values.json ? `${JSON.stringify({ removed })}\n` : `Removed ${removed} captured ${removed === 1 ? "message" : "messages"}.\n`);
    } else {
      const mail = await client.get(id as string);
      if (mail === undefined) {
        return fail(`There is no captured message "${id}". "mail list" prints the ids.`);
      }
      if (values.json) {
        io.stdout.write(`${JSON.stringify(mail, null, 2)}\n`);
      } else if (values.text || values.html) {
        const body = values.text ? mail.text : mail.html;
        if (body === undefined) {
          return fail(`${mail.id} has no ${values.text ? "plain-text" : "HTML"} body.`);
        }
        io.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
      } else {
        io.stdout.write(`${formatMail(mail, { headers: values.headers }).join("\n")}\n`);
      }
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  return 0;
}
