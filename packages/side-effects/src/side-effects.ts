import { smtpAddress, smtpEnvironment } from "./config.ts";
import type { NetworkConfig, SmtpConfig } from "./config.ts";
import { MailCapture } from "./mail-capture.ts";
import type { CapturedMail } from "./mail-capture.ts";
import { startMailControl } from "./mail-control.ts";
import type { MailControl } from "./mail-control.ts";
import { installNetworkHook } from "./network-guard.ts";
import type { ConnectingSocket, NetworkEvent, NetworkGuardMode } from "./network-guard.ts";
import { isLoopbackHost } from "./smtp-server.ts";

/*
 * What an application does besides using its database, as far as the sandbox
 * deals with it: the mail it sends, and the network connections it opens.
 *
 * This is separate from the relational runtime and knows nothing of it, nor
 * of any web framework or ORM. Whoever runs an application in a sandbox
 * calls `startSideEffects` in the application's process before the
 * application is loaded, and says how to find the request that code is
 * running for (`context`).
 */

/** The request of mail and connections that no request was being handled for. */
export const BACKGROUND = "background";

/** A message was captured. */
export interface MailCapturedEvent {
  kind: "smtp";
  id: string;
  from: string;
  to: string[];
  subject: string;
  sizeBytes: number;
  attachments: number;
  /** The request the message was sent for, `background`, or absent when that is not known. */
  requestId?: string;
}

/** Something an application did that reaches outside its database. Log lines are formatted from these. */
export type SideEffectEvent = MailCapturedEvent | NetworkEvent;

export function mailCapturedEvent(mail: CapturedMail): MailCapturedEvent {
  return {
    kind: "smtp",
    id: mail.id,
    from: mail.from,
    to: mail.to,
    subject: mail.subject,
    sizeBytes: mail.sizeBytes,
    attachments: mail.attachments.length,
    ...(mail.requestId !== undefined && { requestId: mail.requestId }),
  };
}

const short = (text: string, length = 80): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/** One terminal line for an event, starting with the request it belongs to, as SQL log lines do. */
export function formatSideEffectEvent(event: SideEffectEvent): string {
  if (event.kind === "smtp") {
    return `[${event.requestId ?? "unknown"}] SMTP captured id=${event.id} to=${event.to.join(",")} subject=${JSON.stringify(short(event.subject))}`;
  }
  if (event.operation === "resolve") {
    return `[${event.requestId}] NETWORK blocked: the name ${event.host} was not looked up, so nothing connects to it`;
  }
  const target = `${event.host}:${event.port}${event.address === undefined ? "" : ` [${event.address}]`}${event.protocol === undefined ? "" : ` (${event.protocol})`}`;
  if (event.action === "blocked") {
    return `[${event.requestId}] NETWORK blocked: the connection to ${target} was refused before it was opened`;
  }
  return event.action === "warned"
    ? `[${event.requestId}] NETWORK warning: a connection to ${target} leaves this machine`
    : `[${event.requestId}] NETWORK allowed: ${target}`;
}

/**
 * What of an application's side effects a sandbox keeps on this machine, as
 * it was started. It says what is in place, and not what an application
 * does: whether its mail reaches a capture depends on the settings it reads.
 */
export interface SideEffectStatus {
  /**
   * `captured`: a capture takes the application's mail, and environment
   * variables were set to lead the application to it. `listening`: a capture
   * listens, and nothing was set: the application's own settings decide.
   * `off`: the sandbox does nothing about mail.
   */
  mail: "captured" | "listening" | "off";
  /** Where the capture listens, when there is one. */
  smtp?: { host: string; port: number };
  /** The environment variables that were set for the application, by name. */
  variables: string[];
  /** What happens to a TCP connection that leaves this machine: `allow`, nothing is looked at; `warn`, it is reported, and opened; `block`, it is refused. */
  network: NetworkGuardMode;
  /** Hosts beyond this machine that the guard lets through. */
  allow: string[];
}

/**
 * The lines that say what is not kept on this machine, for whoever starts
 * an application in a sandbox. Where connections that leave this machine are
 * refused there is no warning: none of these lines when a capture runs, and
 * one that says that mail is not captured when none does. Where mail or
 * calls to other services can reach real ones, a warning says so, with the
 * keys of the configuration that change it. What is in place has its own
 * lines, which `startSideEffects` prints.
 *
 * The guard is named for what it is here too: a development aid.
 */
export function formatUnguardedSideEffects(status: SideEffectStatus, options: { /** What the sandbox's configuration is called, such as the path of its file. */ configuration?: string } = {}): string[] {
  const refused = status.network === "block";
  const lines: string[] = [];
  if (status.mail === "off") {
    lines.push(
      refused
        ? // A host that the guard lets through is reached, and a mail server may be one of them.
          `Local DB Sandbox: SMTP capture is off. Mail is not kept on this machine; a mail server outside it is refused by the network guard${status.allow.length > 0 ? ", unless it is among the hosts the guard lets through" : ""}.`
        : "Local DB Sandbox: SMTP capture is off. The application sends its mail wherever its own settings say.",
    );
  }
  if (refused) {
    return lines;
  }
  if (status.network === "allow") {
    lines.push('Local DB Sandbox: network guard is off ("allow"). TCP connections that leave this machine are opened, and are not reported.');
  }
  // A guard that reports opens the connection all the same.
  const reported = status.network === "warn" ? " Connections that leave this machine are reported here, and are still opened." : "";
  const how: string[] = [];
  if (status.mail === "captured") {
    lines.push(`Warning: the application's mail is captured, and nothing else keeps it from real services. Its calls to other services go where its own settings say, and may reach real ones.${reported}`);
  } else {
    const whose = status.mail === "listening" ? "A capture listens for its mail, and nothing leads the application to it: its" : "Its";
    lines.push(`Warning: nothing keeps this application from real services. ${whose} mail and its calls to other services go where its own settings say, and may reach real ones.${reported}`);
    how.push(
      status.mail === "listening"
        ? '  To lead its mail to the capture: name the variables your application reads in "smtp.env", such as { "SMTP_HOST": "{host}", "SMTP_PORT": "{port}" }.'
        : '  To keep mail on this machine: "smtp": { "mode": "capture", "env": { "SMTP_HOST": "{host}", "SMTP_PORT": "{port}" } }, with the names your application reads.',
    );
  }
  how.push(
    status.network === "warn"
      ? '  To refuse connections that leave this machine: "network": { "mode": "block" }.'
      : '  To report connections that leave this machine, or to refuse them: "network": { "mode": "warn" } or { "mode": "block" }.',
  );
  lines.push(...how, `  ${how.length > 1 ? "Both are" : "It is"} set in ${options.configuration ?? "the sandbox's configuration"}. The network guard is a development aid, not a security boundary.`);
  return lines;
}

/**
 * A capture that runs in another process: the one that starts and restarts
 * the application's, so that captured mail outlives a restart. The
 * application's process starts none of its own and tells that one which
 * request each of its connections is for.
 */
export interface SharedCapture {
  host: string;
  port: number;
  /** Which request the next message on a connection is for; `undefined` when that cannot be told. */
  note(clientPort: number, requestId: string | undefined): void;
}

export interface SideEffectsOptions {
  smtp?: SmtpConfig;
  network?: NetworkConfig;
  sharedCapture?: SharedCapture;
  /** Where to write the file that leads the `mail` command to a capture started here. Without it, none is written. */
  runtimeFile?: string;
  /** The request the caller is running for, if any. */
  context?: () => string | undefined;
  /** The environment to set the variables of `smtp.env` in. Default: `process.env`. */
  environment?: Record<string, string | undefined>;
  /** Receives every event: captured mail, and every connection the network hook saw. */
  onEvent?: (event: SideEffectEvent) => void;
  /** Receives status lines, and a line for each captured message and each connection that was reported or refused. */
  log?: (line: string) => void;
}

export interface SideEffects {
  /** The capture started here, if one was. */
  capture?: MailCapture;
  /** Where the application's mail goes: the capture started here, or the shared one. */
  smtp?: { host: string; port: number };
  /** The environment variables that were set, by name. */
  environment: Record<string, string>;
  /** What is kept on this machine, and what is not: the source of the lines that say so (`formatUnguardedSideEffects`). */
  status: SideEffectStatus;
  /** Stops the capture started here and removes the network hook. */
  close(): Promise<void>;
}

/** Whether a chunk the application writes to its SMTP connection starts a message. */
function startsMessage(chunk: unknown): boolean {
  const head = typeof chunk === "string" ? chunk.slice(0, 512) : Buffer.isBuffer(chunk) ? chunk.subarray(0, 512).toString("latin1") : "";
  return /(^|\r\n)MAIL FROM:/i.test(head);
}

/**
 * Starts what the configuration asks for, in the application's process and
 * before the application is loaded: the mail capture (unless a shared one is
 * given), the environment variables that lead the application to it, and the
 * network hook. With `smtp.mode` off and `network.mode` allow, which is what
 * a configuration without either says, this does nothing at all.
 */
export async function startSideEffects(options: SideEffectsOptions): Promise<SideEffects> {
  const log = options.log ?? (() => undefined);
  const context = (): string => options.context?.() ?? BACKGROUND;
  const emit = (event: SideEffectEvent, print: boolean): void => {
    if (print) {
      log(formatSideEffectEvent(event));
    }
    try {
      options.onEvent?.(event);
    } catch {
      // A failing listener must not affect the application.
    }
  };
  const capturing = options.smtp?.mode === "capture";
  const mode = options.network?.mode ?? "allow";

  let capture: MailCapture | undefined;
  let control: MailControl | undefined;
  let smtp: { host: string; port: number } | undefined;
  let note: ((clientPort: number, requestId: string | undefined) => void) | undefined;
  let environment: Record<string, string> = {};
  if (capturing) {
    const config = options.smtp as SmtpConfig;
    if (options.sharedCapture !== undefined) {
      smtp = { host: options.sharedCapture.host, port: options.sharedCapture.port };
      note = options.sharedCapture.note;
    } else {
      const started = await MailCapture.start({ ...smtpAddress(config), auth: config.auth, maxMessages: config.maxMessages, onCapture: (mail) => emit(mailCapturedEvent(mail), true) });
      capture = started;
      smtp = { host: started.host, port: started.port };
      note = (clientPort, requestId) => started.noteConnection(clientPort, requestId);
      if (options.runtimeFile !== undefined) {
        control = await startMailControl(started, options.runtimeFile);
      }
      log(`Local DB Sandbox: SMTP capture on ${smtp.host}:${smtp.port}. Mail is kept in memory and sent to no one; see it with "local-db-sandbox mail list".`);
    }
    environment = smtpEnvironment(config.env, smtp);
    Object.assign(options.environment ?? process.env, environment);
    const names = Object.keys(environment);
    log(
      names.length > 0
        ? `  set for the application, to lead its mail to ${smtp.host}:${smtp.port}: ${names.join(", ")}`
        : `  no environment variable is set for the application ("smtp.env" is empty): its mail only reaches ${smtp.host}:${smtp.port} if its own settings say so.`,
    );
  }

  let removeHook: (() => void) | undefined;
  if (capturing || mode !== "allow") {
    const sink = smtp;
    /**
     * Tells the capture which request the messages on this connection are for.
     *
     * The first message is for the request that opened the connection. A
     * connection that is kept open (a pooled transport) sends the mail of
     * later requests too, and what it does then runs in the context it was
     * opened in, whoever asked for the mail. So a later message is only given
     * a request when it is written in another context than the one that
     * opened the connection, which can only be its sender's. Otherwise its
     * request is not known, and is not guessed.
     */
    const follow = (socket: ConnectingSocket): void => {
      const tell = (requestId: string | undefined): void => {
        if (socket.localPort !== undefined) {
          note?.(socket.localPort, requestId);
        }
      };
      const openedFor = context();
      let messages = 0;
      socket.once("connect", () => tell(openedFor));
      // Each message starts with MAIL FROM.
      const write = socket.write;
      socket.write = function (this: ConnectingSocket, ...args: unknown[]): boolean {
        if (startsMessage(args[0])) {
          messages += 1;
          if (messages > 1) {
            const writtenFor = context();
            tell(writtenFor === openedFor ? undefined : writtenFor);
          }
        }
        return write.apply(this, args);
      };
    };
    removeHook = installNetworkHook({
      mode,
      allow: options.network?.allow,
      context,
      // A connection that is simply allowed is an event for whoever listens, and not a line in the terminal.
      onEvent: (event) => emit(event, event.action !== "allowed"),
      onConnection: (target, socket) => {
        if (sink !== undefined && target.port === sink.port && (isLoopbackHost(target.host) || target.host === sink.host)) {
          follow(socket);
        }
      },
    });
    if (mode !== "allow") {
      const listed = options.network?.allow ?? [];
      log(
        `Local DB Sandbox: network guard "${mode}": TCP connections that leave this machine are ${mode === "block" ? "refused" : "reported"}` +
          `${listed.length > 0 ? `, except to ${listed.join(", ")}` : ""}. It is a development aid, not a security boundary.`,
      );
    }
  }

  const variables = Object.keys(environment);
  return {
    ...(capture !== undefined && { capture }),
    ...(smtp !== undefined && { smtp }),
    environment,
    status: {
      mail: !capturing ? "off" : variables.length > 0 ? "captured" : "listening",
      ...(smtp !== undefined && { smtp: { host: smtp.host, port: smtp.port } }),
      variables,
      network: mode,
      allow: [...(options.network?.allow ?? [])],
    },
    async close() {
      removeHook?.();
      await control?.close();
      await capture?.close();
    },
  };
}

/**
 * Starts a capture that application processes share (see `SharedCapture`),
 * with the endpoint and file that lead the `mail` command to it. For the
 * process that outlives them, such as a watcher that restarts the application.
 */
export async function startSharedMailCapture(options: { smtp: SmtpConfig; runtimeFile?: string; onEvent?: (event: SideEffectEvent) => void; log?: (line: string) => void }): Promise<{ capture: MailCapture; close(): Promise<void> }> {
  const capture = await MailCapture.start({
    ...smtpAddress(options.smtp),
    auth: options.smtp.auth,
    maxMessages: options.smtp.maxMessages,
    onCapture: (mail) => {
      const event = mailCapturedEvent(mail);
      options.log?.(formatSideEffectEvent(event));
      try {
        options.onEvent?.(event);
      } catch {
        // A failing listener must not affect the capture.
      }
    },
  });
  let control: MailControl | undefined;
  try {
    control = options.runtimeFile === undefined ? undefined : await startMailControl(capture, options.runtimeFile);
  } catch (error) {
    await capture.close();
    throw error;
  }
  options.log?.(`Local DB Sandbox: SMTP capture on ${capture.host}:${capture.port}. Mail is kept in memory and sent to no one; see it with "local-db-sandbox mail list".`);
  return {
    capture,
    async close() {
      await control?.close();
      await capture.close();
    },
  };
}
