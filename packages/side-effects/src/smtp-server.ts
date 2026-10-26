import { createServer, isIP } from "node:net";
import type { Server, Socket } from "node:net";

/*
 * A local SMTP server that accepts mail and hands it to its owner. It is the
 * end of the line: there is no client side in this file, nothing here opens
 * a connection, and what it accepts goes to `onMessage` and nowhere else.
 *
 * It speaks the part of SMTP (RFC 5321) that a mail library uses to submit a
 * message: EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, VRFY, HELP, QUIT, with
 * SIZE, 8BITMIME, SMTPUTF8, and PIPELINING. It has no TLS: it listens on
 * this machine only, and STARTTLS is not offered.
 *
 * AUTH is not offered by default either, so a client that does not insist on
 * authenticating never sends its credentials. With `auth: "accept"` it is
 * offered for clients that insist: whatever they send is accepted and
 * dropped. It is not checked, kept, logged, or used for anything.
 */

export class SmtpServerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SmtpServerError";
  }
}

/** One message as it was submitted. */
export interface SmtpMessage {
  /** The sender given with `MAIL FROM`. */
  from: string;
  /** Every recipient given with `RCPT TO`: also those that are in no header (Bcc). */
  to: string[];
  /** The message: headers and body, as sent. */
  data: Uint8Array;
  /** The port of the client's end of the connection, which tells connections from one machine apart. */
  clientPort: number;
}

export interface SmtpServerOptions {
  /** A loopback address or `localhost` (default 127.0.0.1). Anything else is refused. */
  host?: string;
  /** Default 2525; 0 for any free port. */
  port?: number;
  /** Largest message accepted, in bytes (default 25 MB). */
  maxMessageBytes?: number;
  /** `none` (default): AUTH is not offered. `accept`: it is, and any credentials are accepted and dropped. */
  auth?: "none" | "accept";
  /** Takes a message and returns the id it was given, which the client is told. */
  onMessage: (message: SmtpMessage) => string;
  /** Told when a connection ends, with the port of the client's end. */
  onDisconnect?: (clientPort: number) => void;
  /** How long a connection may be silent before it is closed, in ms (default 5 minutes). */
  idleTimeoutMs?: number;
}

export const DEFAULT_SMTP_HOST = "127.0.0.1";
export const DEFAULT_SMTP_PORT = 2525;
const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_COMMAND_LENGTH = 4096;
const MAX_RECIPIENTS = 1000;
const NAME = "local-db-sandbox";

/** Whether an address names this machine only. */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) {
    return true;
  }
  const version = isIP(name);
  if (version === 4) {
    return name.startsWith("127.");
  }
  return version === 6 && (name === "::1" || /^::ffff:127\.\d+\.\d+\.\d+$/.test(name));
}

/** The address in `MAIL FROM:<a@b> SIZE=1` or `RCPT TO:<a@b>`, and what follows it. */
function pathOf(line: string, keyword: RegExp): { address: string; parameters: string } | undefined {
  const rest = keyword.exec(line)?.[1];
  if (rest === undefined) {
    return undefined;
  }
  const bracketed = /^<([^>]*)>(.*)$/.exec(rest.trim());
  if (bracketed !== null) {
    return { address: bracketed[1] as string, parameters: bracketed[2] as string };
  }
  const [address = "", ...parameters] = rest.trim().split(/\s+/);
  return { address, parameters: parameters.join(" ") };
}

export class SmtpCaptureServer {
  readonly #options: SmtpServerOptions;
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  #address: { host: string; port: number } | undefined;

  constructor(options: SmtpServerOptions) {
    const host = options.host ?? DEFAULT_SMTP_HOST;
    if (!isLoopbackHost(host)) {
      throw new SmtpServerError(`The SMTP capture server listens on this machine only: "${host}" is not a loopback address. Use 127.0.0.1, ::1, or localhost.`);
    }
    this.#options = options;
    this.#server = createServer((socket) => this.#serve(socket));
    // Capturing mail is not a reason to keep a process running that has nothing else to do.
    this.#server.unref();
  }

  /** Where the server listens. Only known once `listen` has resolved. */
  get address(): { host: string; port: number } {
    if (this.#address === undefined) {
      throw new SmtpServerError("The SMTP capture server is not listening.");
    }
    return this.#address;
  }

  listen(): Promise<{ host: string; port: number }> {
    const host = this.#options.host ?? DEFAULT_SMTP_HOST;
    const port = this.#options.port ?? DEFAULT_SMTP_PORT;
    return new Promise((resolve, reject) => {
      this.#server.once("error", (cause: NodeJS.ErrnoException) => {
        reject(
          new SmtpServerError(
            cause.code === "EADDRINUSE"
              ? `The SMTP capture server cannot listen on ${host}:${port}: the port is in use. Another sandbox may be running; stop it, or choose another port.`
              : `The SMTP capture server cannot listen on ${host}:${port}: ${cause.message}`,
            { cause },
          ),
        );
      });
      this.#server.listen(port, host, () => {
        const bound = this.#server.address();
        this.#address = { host, port: typeof bound === "object" && bound !== null ? bound.port : port };
        resolve(this.#address);
      });
    });
  }

  /** Stops listening and ends every connection. */
  close(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.destroy();
    }
    return new Promise((resolve) => {
      if (this.#address === undefined) {
        resolve();
      } else {
        this.#server.close(() => resolve());
      }
    });
  }

  #serve(socket: Socket): void {
    const maxBytes = this.#options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    const offersAuth = this.#options.auth === "accept";
    const clientPort = socket.remotePort ?? 0;
    this.#sockets.add(socket);

    // One character per byte, so that a message's bytes come through as they were sent.
    socket.setEncoding("latin1");
    let buffer = "";
    let from: string | undefined;
    let to: string[] = [];
    /** Set while the message itself is being received. */
    let data: { text: string; searchedTo: number; tooLarge: boolean } | undefined;
    /** Set while the client is answering an AUTH challenge. What it sends is dropped. */
    let authStep: "plain" | "login-user" | "login-password" | undefined;

    const reply = (line: string): void => {
      if (!socket.destroyed) {
        socket.write(`${line}\r\n`);
      }
    };
    const reset = (): void => {
      from = undefined;
      to = [];
    };

    const command = (line: string): boolean => {
      if (authStep !== undefined) {
        // The line is a credential, or "*" to cancel. It is not looked at beyond that.
        if (line === "*") {
          authStep = undefined;
          reply("501 5.7.0 Authentication cancelled");
        } else if (authStep === "login-user") {
          authStep = "login-password";
          reply("334 UGFzc3dvcmQ6");
        } else {
          authStep = undefined;
          reply("235 2.7.0 Accepted. The credentials were not checked, are not kept, and are not used: this server sends nothing on.");
        }
        return true;
      }
      const verb = (/^[A-Za-z]+/.exec(line)?.[0] ?? "").toUpperCase();
      switch (verb) {
        case "EHLO":
          reset();
          reply(`250-${NAME} mail capture: nothing is sent on`);
          reply(`250-SIZE ${maxBytes}`);
          reply("250-8BITMIME");
          reply("250-SMTPUTF8");
          reply(offersAuth ? "250-PIPELINING" : "250 PIPELINING");
          if (offersAuth) {
            reply("250 AUTH PLAIN LOGIN");
          }
          return true;
        case "HELO":
          reset();
          reply(`250 ${NAME} mail capture: nothing is sent on`);
          return true;
        case "MAIL": {
          const path = pathOf(line, /^MAIL FROM:(.*)$/i);
          if (path === undefined) {
            reply("501 5.5.4 Syntax: MAIL FROM:<address>");
            return true;
          }
          const size = /\bSIZE=(\d+)/i.exec(path.parameters)?.[1];
          if (size !== undefined && Number(size) > maxBytes) {
            reply(`552 5.3.4 The message is larger than this server takes (${maxBytes} bytes)`);
            return true;
          }
          reset();
          from = path.address;
          reply("250 2.1.0 OK");
          return true;
        }
        case "RCPT": {
          const path = pathOf(line, /^RCPT TO:(.*)$/i);
          if (from === undefined) {
            reply("503 5.5.1 MAIL FROM comes first");
          } else if (path === undefined || path.address === "") {
            reply("501 5.5.4 Syntax: RCPT TO:<address>");
          } else if (to.length >= MAX_RECIPIENTS) {
            reply("452 4.5.3 Too many recipients");
          } else {
            // Every address is taken: nothing is delivered, so there is no mailbox that could be missing.
            to.push(path.address);
            reply("250 2.1.5 OK");
          }
          return true;
        }
        case "DATA":
          if (from === undefined || to.length === 0) {
            reply("503 5.5.1 MAIL FROM and RCPT TO come first");
            return true;
          }
          // As if a line break came before it, so that a message that is empty ends like any other.
          data = { text: "\r\n", searchedTo: 0, tooLarge: false };
          reply("354 End the message with a line that holds a single dot");
          return true;
        case "RSET":
          reset();
          reply("250 2.0.0 OK");
          return true;
        case "NOOP":
          reply("250 2.0.0 OK");
          return true;
        case "VRFY":
          reply("252 2.1.5 Nothing is verified here: every address is accepted, and no mail is delivered");
          return true;
        case "HELP":
          reply("214 2.0.0 Local mail capture. Commands: EHLO HELO MAIL RCPT DATA RSET NOOP VRFY QUIT");
          return true;
        case "AUTH": {
          if (!offersAuth) {
            reply("502 5.5.1 Authentication is not offered and not needed: this server keeps mail on this machine");
            return true;
          }
          const [, mechanism = "", initial] = line.split(/\s+/);
          if (mechanism.toUpperCase() === "PLAIN") {
            if (initial === undefined) {
              authStep = "plain";
              reply("334 ");
            } else {
              reply("235 2.7.0 Accepted. The credentials were not checked, are not kept, and are not used: this server sends nothing on.");
            }
          } else if (mechanism.toUpperCase() === "LOGIN") {
            authStep = initial === undefined ? "login-user" : "login-password";
            reply(initial === undefined ? "334 VXNlcm5hbWU6" : "334 UGFzc3dvcmQ6");
          } else {
            reply("504 5.5.4 Only PLAIN and LOGIN are offered");
          }
          return true;
        }
        case "STARTTLS":
          reply("502 5.5.1 TLS is not offered: this server listens on this machine only");
          return true;
        case "QUIT":
          reply("221 2.0.0 Bye");
          socket.end();
          return false;
        default:
          reply("500 5.5.2 Command not recognized");
          return true;
      }
    };

    /** Takes what has arrived of a message. Returns false while its end has not arrived. */
    const receive = (): boolean => {
      const message = data as NonNullable<typeof data>;
      message.text += buffer;
      buffer = "";
      const end = message.text.indexOf("\r\n.\r\n", message.searchedTo);
      if (end === -1) {
        if (message.text.length > maxBytes + 2) {
          // Too large to keep. Only its end is still looked for, so that the client can be told.
          message.tooLarge = true;
          message.text = message.text.slice(-4);
        }
        message.searchedTo = Math.max(0, message.text.length - 4);
        return false;
      }
      buffer = message.text.slice(end + 5);
      // Without the line break that was put before it, with the one that ends its last line, and with the dots that guard lines starting with one taken off.
      const text = message.text.slice(2, end + 2).replace(/(^|\r\n)\./g, "$1");
      data = undefined;
      if (message.tooLarge || text.length > maxBytes) {
        reply(`552 5.3.4 The message is larger than this server takes (${maxBytes} bytes); it was not captured`);
      } else {
        try {
          const id = this.#options.onMessage({ from: from ?? "", to, data: Buffer.from(text, "latin1"), clientPort });
          reply(`250 2.0.0 OK: captured as ${id}; not sent to anyone`);
        } catch {
          reply("451 4.3.0 The message could not be captured");
        }
      }
      reset();
      return true;
    };

    socket.setTimeout(this.#options.idleTimeoutMs ?? 5 * 60_000, () => {
      reply("421 4.4.2 Closing the connection: nothing was sent for too long");
      socket.end();
    });
    // A client that goes away is not this server's problem.
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.#sockets.delete(socket);
      this.#options.onDisconnect?.(clientPort);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (data !== undefined) {
          if (!receive()) {
            return;
          }
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol === -1) {
          if (buffer.length > MAX_COMMAND_LENGTH) {
            reply("500 5.5.2 Line too long");
            socket.end();
          }
          return;
        }
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        if (line.length > MAX_COMMAND_LENGTH) {
          reply("500 5.5.2 Line too long");
        } else if (!command(line)) {
          return;
        }
      }
    });

    reply(`220 ${NAME} ESMTP mail capture: nothing is sent on`);
  }
}
