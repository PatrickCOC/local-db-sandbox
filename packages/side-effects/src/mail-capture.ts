import { parseMail } from "./mime.ts";
import type { MailAttachment, MailHeader } from "./mime.ts";
import { SmtpCaptureServer, SmtpServerError } from "./smtp-server.ts";
import type { SmtpServerOptions } from "./smtp-server.ts";

/** A message the application sent, as it was captured. It went nowhere else. */
export interface CapturedMail {
  /** Local id, counted from `mail-1` for as long as the capture runs. */
  id: string;
  /** When the message was accepted, as an ISO 8601 timestamp. */
  capturedAt: string;
  /** The sender the application gave to the SMTP server (`MAIL FROM`). */
  from: string;
  /** Every recipient it gave (`RCPT TO`): the addresses of To, Cc, and Bcc. */
  to: string[];
  subject: string;
  headers: MailHeader[];
  text?: string;
  html?: string;
  attachments: MailAttachment[];
  /** Size of the message as it was sent, in bytes. */
  sizeBytes: number;
  /**
   * The HTTP request the application was handling when it sent the message,
   * `background` when it was handling none, and absent when that is not
   * known (a message that did not come from the sandbox's application).
   */
  requestId?: string;
}

export interface MailCaptureOptions extends Pick<SmtpServerOptions, "host" | "port" | "maxMessageBytes" | "auth" | "idleTimeoutMs"> {
  /** Most messages kept; the oldest are dropped beyond that (default 500). */
  maxMessages?: number;
  /** Told about every captured message. */
  onCapture?: (mail: CapturedMail) => void;
  /** The clock; `Date` by default. */
  now?: () => Date;
}

export const DEFAULT_MAX_MESSAGES = 500;

/**
 * Captures the mail an application sends: a local SMTP server
 * (smtp-server.ts) and the messages it took, kept in memory.
 *
 * Nothing is relayed. This class has no way to send a message anywhere: it
 * parses what the server hands it, keeps it, and tells its listener.
 */
export class MailCapture {
  readonly #server: SmtpCaptureServer;
  readonly #options: MailCaptureOptions;
  #messages: CapturedMail[] = [];
  #count = 0;
  /** The request a connection is sending for, by the port of the client's end. */
  readonly #requests = new Map<number, string>();

  private constructor(options: MailCaptureOptions) {
    if (options.maxMessages !== undefined && (!Number.isInteger(options.maxMessages) || options.maxMessages < 1)) {
      throw new SmtpServerError("The number of captured messages to keep must be a whole number, 1 or more.");
    }
    this.#options = options;
    this.#server = new SmtpCaptureServer({
      host: options.host,
      port: options.port,
      maxMessageBytes: options.maxMessageBytes,
      auth: options.auth,
      idleTimeoutMs: options.idleTimeoutMs,
      onMessage: (message) => this.#take(message.from, message.to, message.data, message.clientPort),
      onDisconnect: (clientPort) => this.#requests.delete(clientPort),
    });
  }

  /** Starts listening. Rejects when the address cannot be listened on. */
  static async start(options: MailCaptureOptions = {}): Promise<MailCapture> {
    const capture = new MailCapture(options);
    await capture.#server.listen();
    return capture;
  }

  get host(): string {
    return this.#server.address.host;
  }

  get port(): number {
    return this.#server.address.port;
  }

  /**
   * Says which request the next message on a connection is sent for, or,
   * with `undefined`, that it is not known. The connection is named by the
   * port of the client's end, which is all the two ends of a local connection
   * both know.
   */
  noteConnection(clientPort: number, requestId: string | undefined): void {
    if (requestId === undefined) {
      this.#requests.delete(clientPort);
    } else {
      this.#requests.set(clientPort, requestId);
    }
  }

  /** The captured messages, oldest first. */
  list(): CapturedMail[] {
    return [...this.#messages];
  }

  get(id: string): CapturedMail | undefined {
    return this.#messages.find((mail) => mail.id === id);
  }

  /** Forgets every captured message, and returns how many there were. Ids are not used again. */
  clear(): number {
    const removed = this.#messages.length;
    this.#messages = [];
    return removed;
  }

  close(): Promise<void> {
    return this.#server.close();
  }

  #take(from: string, to: string[], data: Uint8Array, clientPort: number): string {
    const parsed = parseMail(data);
    const requestId = this.#requests.get(clientPort);
    this.#count += 1;
    const mail: CapturedMail = {
      id: `mail-${this.#count}`,
      capturedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      from,
      to: [...to],
      subject: parsed.subject,
      headers: parsed.headers,
      ...(parsed.text !== undefined && { text: parsed.text }),
      ...(parsed.html !== undefined && { html: parsed.html }),
      attachments: parsed.attachments,
      sizeBytes: data.length,
      ...(requestId !== undefined && { requestId }),
    };
    this.#messages.push(mail);
    const excess = this.#messages.length - (this.#options.maxMessages ?? DEFAULT_MAX_MESSAGES);
    if (excess > 0) {
      this.#messages.splice(0, excess);
    }
    try {
      this.#options.onCapture?.(mail);
    } catch {
      // A failing listener must not make the application's send fail.
    }
    return mail.id;
  }
}
