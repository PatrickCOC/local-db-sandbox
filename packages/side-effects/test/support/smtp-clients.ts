import { createRequire } from "node:module";
import { connect } from "node:net";
import type { Socket } from "node:net";

/*
 * Two clients for the SMTP capture. Nodemailer is what applications send
 * mail with, so it is what a captured message is checked against; it is a
 * development dependency for these tests only, at the version of the
 * application the sandbox is tried against. The other client is a plain
 * socket, to say exactly what goes over the wire.
 */

export interface SentInfo {
  response: string;
  accepted: string[];
  rejected: string[];
  envelope: { from: string; to: string[] };
  messageId: string;
}

export interface Transport {
  sendMail(mail: Record<string, unknown>): Promise<SentInfo>;
  close(): void;
}

const nodemailer = createRequire(import.meta.url)("nodemailer") as { createTransport(options: Record<string, unknown>): Transport };

/** A Nodemailer transport to an SMTP server on this machine, set up the way an application sets one up. */
export function transportTo(address: { host: string; port: number }, options: Record<string, unknown> = {}): Transport {
  return nodemailer.createTransport({ host: address.host, port: address.port, secure: false, ...options });
}

export interface SmtpSession {
  /** The server's greeting. */
  greeting: string;
  /** Sends text as it is and resolves with the server's next complete reply. */
  send(text: string): Promise<string>;
  /** Sends text and resolves with the next `count` replies, for commands sent in one go. */
  sendAll(text: string, count: number): Promise<string[]>;
  socket: Socket;
  close(): void;
}

/** Opens a connection and speaks SMTP by hand. */
export async function smtpSession(port: number, host = "127.0.0.1"): Promise<SmtpSession> {
  const socket = connect({ host, port });
  socket.setEncoding("latin1");
  let buffer = "";
  const waiting: ((reply: string) => void)[] = [];
  const replies: string[] = [];
  const deliver = (): void => {
    while (waiting.length > 0 && replies.length > 0) {
      (waiting.shift() as (reply: string) => void)(replies.shift() as string);
    }
  };
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      // A reply ends with a line whose code is followed by a space; the lines before it have a hyphen there.
      const end = /^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/.exec(buffer);
      if (end === null) {
        break;
      }
      replies.push(end[0]);
      buffer = buffer.slice(end[0].length);
    }
    deliver();
  });
  const next = (): Promise<string> =>
    new Promise((resolve) => {
      waiting.push(resolve);
      deliver();
    });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const greeting = await next();
  return {
    greeting,
    socket,
    send(text) {
      socket.write(text, "latin1");
      return next();
    },
    async sendAll(text, count) {
      socket.write(text, "latin1");
      const all: string[] = [];
      for (let index = 0; index < count; index += 1) {
        all.push(await next());
      }
      return all;
    },
    close: () => socket.destroy(),
  };
}
