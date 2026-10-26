import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Socket, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { MailClient, SideEffectConfigError, formatSideEffectEvent, formatUnguardedSideEffects, parseSmtpConfig, smtpEnvironment, startSharedMailCapture, startSideEffects } from "../src/index.ts";
import type { SideEffectEvent, SideEffects, SideEffectsOptions } from "../src/index.ts";
import { smtpSession, transportTo } from "./support/smtp-clients.ts";

/*
 * What the sandbox starts in an application's process: the mail capture, the
 * environment that leads the application to it, and the network hook, with
 * the request that mail and connections belong to.
 */

describe("side effects of an application in the sandbox", () => {
  let dir: string;
  let running: { close(): Promise<void> }[] = [];
  const requests = new AsyncLocalStorage<string>();
  const original = Socket.prototype.connect;
  let lines: string[] = [];
  let events: SideEffectEvent[] = [];

  const start = async (options: SideEffectsOptions): Promise<SideEffects> => {
    lines = [];
    events = [];
    const started = await startSideEffects({ context: () => requests.getStore(), log: (line) => lines.push(line), onEvent: (event) => events.push(event), environment: {}, ...options });
    running.push(started);
    return started;
  };
  const send = async (address: { host: string; port: number }, mail: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<void> => {
    const transport = transportTo(address, options);
    await transport.sendMail({ from: "app@example.com", text: "x", ...mail });
    transport.close();
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-side-effects-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  afterEach(async () => {
    for (const item of running.splice(0).reverse()) {
      await item.close();
    }
    running = [];
    assert.equal(Socket.prototype.connect, original, "the network hook was not removed");
  });

  describe("when the configuration asks for nothing", () => {
    it("nothing is started, set, or replaced", async () => {
      for (const options of [{}, { smtp: { mode: "off" as const, env: { SMTP_HOST: "{host}" } }, network: { mode: "allow" as const } }]) {
        const environment: Record<string, string> = { SMTP_HOST: "smtp.real.example" };
        const effects = await start({ ...options, environment, runtimeFile: join(dir, "off.runtime.json") });
        assert.deepEqual([effects.capture, effects.smtp, effects.environment], [undefined, undefined, {}]);
        // The application's own setting stays, connections are Node's own, nothing is written, and nothing is said.
        assert.deepEqual(environment, { SMTP_HOST: "smtp.real.example" });
        assert.equal(Socket.prototype.connect, original);
        assert.equal(existsSync(join(dir, "off.runtime.json")), false);
        assert.deepEqual([lines, events], [[], []]);
      }
    });
  });

  describe("mail capture", () => {
    it("is started on this machine, and the application is led to it by the environment variables the configuration names", async () => {
      const environment: Record<string, string | undefined> = { MAIL_HOST: "smtp.real.example", MAIL_PORT: "587", OTHER: "kept" };
      const effects = await start({
        smtp: { mode: "capture", port: 0, env: { MAIL_HOST: "{host}", MAIL_PORT: "{port}", MAIL_URL: "{url}/inbox", MAIL_SECURE: "false", MAIL_FROM: "sandbox@example.com" } },
        environment,
      });
      const { host, port } = effects.smtp as { host: string; port: number };
      assert.equal(host, "127.0.0.1");
      assert.ok(port > 0);
      const set = { MAIL_HOST: "127.0.0.1", MAIL_PORT: String(port), MAIL_URL: `smtp://127.0.0.1:${port}/inbox`, MAIL_SECURE: "false", MAIL_FROM: "sandbox@example.com" };
      assert.deepEqual(effects.environment, set);
      // What was set replaces what was there; what is not named is not touched.
      assert.deepEqual(environment, { ...set, OTHER: "kept" });
      assert.deepEqual(lines, [
        `Local DB Sandbox: SMTP capture on 127.0.0.1:${port}. Mail is kept in memory and sent to no one; see it with "local-db-sandbox mail list".`,
        `  set for the application, to lead its mail to 127.0.0.1:${port}: MAIL_HOST, MAIL_PORT, MAIL_URL, MAIL_SECURE, MAIL_FROM`,
      ]);
    });

    it("sets nothing when the configuration names no variable, and says so", async () => {
      const environment: Record<string, string> = { SMTP_HOST: "smtp.real.example" };
      const effects = await start({ smtp: { mode: "capture", port: 0 }, environment });
      assert.deepEqual([effects.environment, environment], [{}, { SMTP_HOST: "smtp.real.example" }]);
      assert.match(lines[1] as string, /^ {2}no environment variable is set for the application \("smtp\.env" is empty\): its mail only reaches 127\.0\.0\.1:\d+ if its own settings say so\.$/);
    });

    it("says which request each message was sent for, and marks mail that no request sent as background", async () => {
      const effects = await start({ smtp: { mode: "capture", port: 0 } });
      const address = effects.smtp as { host: string; port: number };
      await requests.run("req-abc", () => send(address, { to: "test@example.com", subject: "Verify account" }));
      await send(address, { to: ["ops@example.com", "dev@example.com"], subject: "Nightly report" });

      assert.deepEqual(lines.slice(2), [
        '[req-abc] SMTP captured id=mail-1 to=test@example.com subject="Verify account"',
        '[background] SMTP captured id=mail-2 to=ops@example.com,dev@example.com subject="Nightly report"',
      ]);
      assert.deepEqual(
        events.filter((event) => event.kind === "smtp"),
        [
          { kind: "smtp", id: "mail-1", from: "app@example.com", to: ["test@example.com"], subject: "Verify account", sizeBytes: events.find((event) => event.kind === "smtp")?.sizeBytes, attachments: 0, requestId: "req-abc" },
          { kind: "smtp", id: "mail-2", from: "app@example.com", to: ["ops@example.com", "dev@example.com"], subject: "Nightly report", sizeBytes: (events.filter((event) => event.kind === "smtp")[1] as { sizeBytes: number }).sizeBytes, attachments: 0 , requestId: "background" },
        ],
      );
      assert.deepEqual(effects.capture?.list().map((mail) => mail.requestId), ["req-abc", "background"]);
    });

    it("does not give the later mail of a connection that is kept open to the request that opened it", async () => {
      const effects = await start({ smtp: { mode: "capture", port: 0 } });
      // One pooled connection, opened for the first request and used for the mail of the others. What a pooled
      // transport does on its connection runs in the context the connection was opened in, whoever asked for the mail.
      const transport = transportTo(effects.smtp as { host: string; port: number }, { pool: true, maxConnections: 1 });
      await requests.run("req-1", () => transport.sendMail({ from: "app@example.com", to: "a@example.com", subject: "first", text: "x" }));
      await requests.run("req-2", () => transport.sendMail({ from: "app@example.com", to: "b@example.com", subject: "second", text: "x" }));
      await transport.sendMail({ from: "app@example.com", to: "c@example.com", subject: "third", text: "x" });
      transport.close();
      // The first message is the opening request's. The others are not known, and are not said to be its.
      assert.deepEqual(effects.capture?.list().map((mail) => [mail.subject, mail.requestId]), [["first", "req-1"], ["second", undefined], ["third", undefined]]);
      assert.equal(lines.at(-1), '[unknown] SMTP captured id=mail-3 to=c@example.com subject="third"');
      // It was one connection.
      assert.equal(events.filter((event) => event.kind === "network").length, 1);
    });

    it("gives a later message of a kept connection to the request that wrote it, when that is another one", async () => {
      const effects = await start({ smtp: { mode: "capture", port: 0 } });
      const { port } = effects.smtp as { port: number };
      const message = (subject: string): string => `MAIL FROM:<a@example.com>\r\nRCPT TO:<b@example.com>\r\nDATA\r\nSubject: ${subject}\r\n\r\nx\r\n.\r\n`;
      const session = await requests.run("req-1", () => smtpSession(port));
      await requests.run("req-1", () => session.sendAll(message("by the opener"), 4));
      await requests.run("req-2", () => session.sendAll(message("by another request"), 4));
      await session.sendAll(message("by no request"), 4);
      await requests.run("req-1", () => session.sendAll(message("by the opener again"), 4));
      session.close();
      assert.deepEqual(effects.capture?.list().map((mail) => [mail.subject, mail.requestId]), [
        ["by the opener", "req-1"],
        ["by another request", "req-2"],
        ["by no request", "background"],
        // In the opening context, which is also where a pooled transport would write it for anyone: not known.
        ["by the opener again", undefined],
      ]);
    });

    it("does not guess the request of mail that did not come from this process's connections", async () => {
      const effects = await start({ smtp: { mode: "capture", port: 0 } });
      // A connection that was open before the hook could see it, as one from another program is.
      await effects.close();
      running = [];
      const again = await start({ smtp: { mode: "capture", port: 0 } });
      const address = again.smtp as { host: string; port: number };
      const socket = (original as (...args: unknown[]) => unknown).call(new Socket(), { host: address.host, port: address.port }) as Socket;
      socket.setEncoding("latin1");
      await new Promise((resolve) => socket.once("data", resolve));
      socket.write("HELO x\r\nMAIL FROM:<other@example.com>\r\nRCPT TO:<b@example.com>\r\nDATA\r\nSubject: From elsewhere\r\n\r\nx\r\n.\r\nQUIT\r\n");
      await new Promise((resolve) => socket.once("close", resolve));
      assert.deepEqual(lines.slice(2), ['[unknown] SMTP captured id=mail-1 to=b@example.com subject="From elsewhere"']);
      assert.equal(again.capture?.list()[0]?.requestId, undefined);
    });

    it("can be reached by the mail command through the file it writes, and removes the file when it stops", async () => {
      const runtimeFile = join(dir, "sandbox.runtime.json");
      const effects = await start({ smtp: { mode: "capture", port: 0 }, runtimeFile });
      const address = effects.smtp as { host: string; port: number };
      await send(address, { to: "ada@example.com", subject: "For the command" });

      const runtime = JSON.parse(await readFile(runtimeFile, "utf8"));
      assert.deepEqual([runtime.pid, runtime.smtp, Object.keys(runtime.control)], [process.pid, address, ["url", "token"]]);
      const client = MailClient.open(runtimeFile);
      assert.deepEqual((await client.list()).map((mail) => [mail.id, mail.subject]), [["mail-1", "For the command"]]);
      assert.equal((await client.get("mail-1"))?.to[0], "ada@example.com");
      assert.equal(await client.get("mail-9"), undefined);

      // Without the token of the file there is nothing to read and nothing to clear.
      for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: runtime.control.token }]) {
        assert.equal((await fetch(`${runtime.control.url}/mail`, { headers })).status, 401);
        assert.equal((await fetch(`${runtime.control.url}/mail`, { method: "DELETE", headers })).status, 401);
      }
      assert.equal((await client.list()).length, 1);
      assert.equal(await client.clear(), 1);
      assert.deepEqual(await client.list(), []);

      await effects.close();
      running = [];
      assert.equal(existsSync(runtimeFile), false);
      assert.throws(() => MailClient.open(runtimeFile), /No sandbox with mail capture is running here .*sandbox\.runtime\.json does not exist\)\. Captured mail is kept in memory by the running sandbox/);
      await assert.rejects(client.list(), /does not answer: it has stopped, and its captured mail went with it/);
    });
  });

  describe("a capture shared by the processes of an application", () => {
    it("is started once, outlives them, and is told by each which request its mail is for", async () => {
      const shared = await startSharedMailCapture({ smtp: { mode: "capture", port: 0, env: { MAIL_PORT: "{port}" } }, runtimeFile: join(dir, "shared.runtime.json"), log: (line) => lines.push(line), onEvent: (event) => events.push(event) });
      running.push(shared);
      const sharedLines: string[] = [];
      lines = sharedLines;
      const told: [number, string | undefined][] = [];
      const sharedCapture = {
        host: shared.capture.host,
        port: shared.capture.port,
        note: (clientPort: number, requestId: string | undefined) => {
          told.push([clientPort, requestId]);
          shared.capture.noteConnection(clientPort, requestId);
        },
      };

      // The first process of the application: it starts no capture, and its mail goes to the shared one.
      const environment: Record<string, string> = {};
      const first = await startSideEffects({ smtp: { mode: "capture", port: 0, env: { MAIL_PORT: "{port}" } }, sharedCapture, context: () => requests.getStore(), environment, runtimeFile: join(dir, "never-written.json"), log: (line) => sharedLines.push(line) });
      assert.deepEqual([first.capture, first.smtp, environment], [undefined, { host: "127.0.0.1", port: shared.capture.port }, { MAIL_PORT: String(shared.capture.port) }]);
      assert.equal(existsSync(join(dir, "never-written.json")), false);
      await requests.run("req-1", () => send({ host: sharedCapture.host, port: sharedCapture.port }, { to: "a@example.com", subject: "before the restart" }));
      await first.close();

      // The application restarts: a new process, the same capture, on the same port.
      const second = await startSideEffects({ smtp: { mode: "capture", port: 0 }, sharedCapture, context: () => requests.getStore() });
      await requests.run("req-2", () => send({ host: sharedCapture.host, port: sharedCapture.port }, { to: "b@example.com", subject: "after the restart" }));
      await second.close();

      assert.deepEqual(shared.capture.list().map((mail) => [mail.id, mail.subject, mail.requestId]), [["mail-1", "before the restart", "req-1"], ["mail-2", "after the restart", "req-2"]]);
      // One note per connection: a transport that opens a connection for each message needs no more.
      assert.deepEqual(told.map(([, requestId]) => requestId), ["req-1", "req-2"]);
      assert.deepEqual(
        sharedLines.filter((line) => line.includes("SMTP captured")),
        ['[req-1] SMTP captured id=mail-1 to=a@example.com subject="before the restart"', '[req-2] SMTP captured id=mail-2 to=b@example.com subject="after the restart"'],
      );
      assert.equal((await MailClient.open(join(dir, "shared.runtime.json")).list()).length, 2);
    });
  });

  describe("the network guard", () => {
    it("refuses connections that leave this machine in block mode, while mail still reaches the capture", async () => {
      const effects = await start({ smtp: { mode: "capture", port: 0 }, network: { mode: "block", allow: ["db.internal:5432"] } });
      assert.equal(lines[2], 'Local DB Sandbox: network guard "block": TCP connections that leave this machine are refused, except to db.internal:5432. It is a development aid, not a security boundary.');

      const code = await requests.run(
        "req-abc",
        () => new Promise<string | undefined>((resolve) => connect({ host: "smtp.gmail.com", port: 587 }).once("error", (error: NodeJS.ErrnoException) => resolve(error.code))),
      );
      assert.equal(code, "ESANDBOXNETWORK");
      await send(effects.smtp as { host: string; port: number }, { to: "ada@example.com", subject: "Still captured" });
      assert.deepEqual(lines.slice(3), [
        "[req-abc] NETWORK blocked: the connection to smtp.gmail.com:587 (smtp) was refused before it was opened",
        '[background] SMTP captured id=mail-1 to=ada@example.com subject="Still captured"',
      ]);
      // The connection to the capture was seen and allowed; it is an event, and not a line.
      assert.deepEqual(events.filter((event) => event.kind === "network").map((event) => `${event.scope} ${event.action}`), ["external blocked", "loopback allowed"]);
    });

    it("reports them in warn mode, and can be used without mail capture", async () => {
      await start({ network: { mode: "warn" } });
      assert.deepEqual(lines, ['Local DB Sandbox: network guard "warn": TCP connections that leave this machine are reported. It is a development aid, not a security boundary.']);
      // The connection is attempted on this machine: the name is resolved by the test, to a port nothing listens on.
      const lookup = (_host: string, options: { all?: boolean }, callback: (...result: unknown[]) => void): void => (options.all ? callback(null, [{ address: "127.0.0.1", family: 4 }]) : callback(null, "127.0.0.1", 4));
      await new Promise((resolve) => connect({ host: "api.partner.example", port: 443, lookup } as never).once("error", resolve).once("connect", resolve));
      assert.equal(lines[1], "[background] NETWORK warning: a connection to api.partner.example:443 (https) leaves this machine");
    });
  });

  describe("lines and configuration", () => {
    it("formats one line per event", () => {
      assert.equal(
        formatSideEffectEvent({ kind: "smtp", id: "mail-12", from: "a@example.com", to: ["test@example.com"], subject: "Verify account", sizeBytes: 1, attachments: 0, requestId: "req-abc" }),
        '[req-abc] SMTP captured id=mail-12 to=test@example.com subject="Verify account"',
      );
      assert.equal(
        formatSideEffectEvent({ kind: "smtp", id: "mail-1", from: "", to: [], subject: `a "quoted" subject ${"that is very long ".repeat(10)}`, sizeBytes: 1, attachments: 0 }),
        '[unknown] SMTP captured id=mail-1 to= subject="a \\"quoted\\" subject that is very long that is very long that is very long that i…"',
      );
      assert.equal(
        formatSideEffectEvent({ kind: "network", operation: "connect", host: "127.0.0.1", port: 6379, protocol: "redis", scope: "loopback", action: "allowed", requestId: "background", pid: 1 }),
        "[background] NETWORK allowed: 127.0.0.1:6379 (redis)",
      );
      assert.equal(
        formatSideEffectEvent({ kind: "network", operation: "connect", host: "smtp.example.com", address: "203.0.113.5", port: 587, protocol: "smtp", scope: "external", action: "warned", requestId: "req-1", pid: 1 }),
        "[req-1] NETWORK warning: a connection to smtp.example.com:587 [203.0.113.5] (smtp) leaves this machine",
      );
      assert.equal(
        formatSideEffectEvent({ kind: "network", operation: "resolve", host: "smtp.example.com", scope: "external", action: "blocked", requestId: "req-1", pid: 1 }),
        "[req-1] NETWORK blocked: the name smtp.example.com was not looked up, so nothing connects to it",
      );
    });

    it("fills in where the capture listens", () => {
      assert.deepEqual(smtpEnvironment({ A: "{host}:{port}", B: "{url}", C: "plain", D: "{other} {host}" }, { host: "::1", port: 2525 }), { A: "::1:2525", B: "smtp://[::1]:2525", C: "plain", D: "{other} ::1" });
      assert.deepEqual(smtpEnvironment(undefined, { host: "127.0.0.1", port: 1 }), {});
    });

    it("checks the smtp configuration", () => {
      assert.deepEqual(parseSmtpConfig({ mode: "capture", host: "localhost", port: 2525, env: { SMTP_PORT: 2525, SMTP_SECURE: false, SMTP_HOST: "{host}" }, auth: "accept", maxMessages: 10 }, '"smtp"'), {
        mode: "capture",
        host: "localhost",
        port: 2525,
        env: { SMTP_PORT: "2525", SMTP_SECURE: "false", SMTP_HOST: "{host}" },
        auth: "accept",
        maxMessages: 10,
      });
      assert.deepEqual(parseSmtpConfig({ mode: "off" }, '"smtp"'), { mode: "off" });
      const problems: [unknown, RegExp][] = [
        ["capture", /"smtp" must be an object, such as \{ "mode": "capture" \}/],
        [{}, /"mode" in "smtp" must be "off" or "capture"/],
        [{ mode: "relay" }, /"mode" in "smtp" must be "off" or "capture"/],
        [{ mode: "capture", host: "0.0.0.0" }, /"host" in "smtp" must be a loopback address \(127\.0\.0\.1, ::1, or localhost\)\. The capture is for the application that runs in the sandbox/],
        [{ mode: "capture", host: "mail.example.com" }, /"host" in "smtp" must be a loopback address/],
        [{ mode: "capture", port: 70000 }, /"port" in "smtp" must be a whole number from 0 to 65535/],
        [{ mode: "capture", port: "2525" }, /"port" in "smtp" must be a whole number/],
        [{ mode: "capture", env: ["SMTP_HOST"] }, /"env" in "smtp" must be an object of environment variable names and their values/],
        [{ mode: "capture", env: { "SMTP-HOST": "x" } }, /"SMTP-HOST" in "env" of "smtp" is not a name an environment variable can have/],
        [{ mode: "capture", env: { SMTP_HOST: null } }, /"SMTP_HOST" in "env" of "smtp" must be text, a number, or true or false/],
        [{ mode: "capture", auth: "required" }, /"auth" in "smtp" must be "none" or "accept"/],
        [{ mode: "capture", maxMessages: 0 }, /"maxMessages" in "smtp" must be a whole number, 1 or more/],
        [{ mode: "capture", relay: "smtp.example.com" }, /"smtp" has the unknown key "relay"\. Its keys are mode, host, port, env, auth, maxMessages\./],
      ];
      for (const [value, message] of problems) {
        assert.throws(() => parseSmtpConfig(value, '"smtp"'), (error: unknown) => error instanceof SideEffectConfigError && message.test(error.message), JSON.stringify(value));
      }
    });
  });

  describe("what is kept on this machine, and what is not", () => {
    const CAPTURE = `"smtp": { "mode": "capture", "env": { "SMTP_HOST": "{host}", "SMTP_PORT": "{port}" } }`;
    const MAIL_OFF = "Local DB Sandbox: SMTP capture is off. The application sends its mail wherever its own settings say.";
    const GUARD_OFF = 'Local DB Sandbox: network guard is off ("allow"). TCP connections that leave this machine are opened, and are not reported.';
    const NOTHING = "Warning: nothing keeps this application from real services. Its mail and its calls to other services go where its own settings say, and may reach real ones.";
    const ONLY_MAIL = "Warning: the application's mail is captured, and nothing else keeps it from real services. Its calls to other services go where its own settings say, and may reach real ones.";
    const STILL_OPENED = " Connections that leave this machine are reported here, and are still opened.";
    const HOW_MAIL = `  To keep mail on this machine: ${CAPTURE}, with the names your application reads.`;
    const HOW_GUARD = '  To report connections that leave this machine, or to refuse them: "network": { "mode": "warn" } or { "mode": "block" }.';
    const HOW_BLOCK = '  To refuse connections that leave this machine: "network": { "mode": "block" }.';
    const where = (count: "Both are" | "It is", configuration = "the sandbox's configuration"): string => `  ${count} set in ${configuration}. The network guard is a development aid, not a security boundary.`;

    it("is said by what was started: whether mail is captured and the application led to the capture, and what the guard does", async () => {
      assert.deepEqual((await start({})).status, { mail: "off", variables: [], network: "allow", allow: [] });
      assert.deepEqual((await start({ smtp: { mode: "off", env: { SMTP_HOST: "{host}" } }, network: { mode: "allow" } })).status, { mail: "off", variables: [], network: "allow", allow: [] });

      const led = await start({ smtp: { mode: "capture", port: 0, env: { MAIL_HOST: "{host}", MAIL_PORT: "{port}" } }, network: { mode: "block", allow: ["search.internal:9200"] } });
      assert.deepEqual(led.status, { mail: "captured", smtp: led.smtp, variables: ["MAIL_HOST", "MAIL_PORT"], network: "block", allow: ["search.internal:9200"] });
      // One network hook at a time: each is ended before the next is started.
      await led.close();
      running = [];

      // A capture that nothing leads the application to takes its mail only if its own settings say so.
      const listening = await start({ smtp: { mode: "capture", port: 0 }, network: { mode: "warn" } });
      assert.deepEqual(listening.status, { mail: "listening", smtp: listening.smtp, variables: [], network: "warn", allow: [] });
      await listening.close();
      running = [];

      // A capture that another process runs (the watcher's) is a capture all the same.
      const shared = await start({ smtp: { mode: "capture", env: { MAIL_PORT: "{port}" } }, sharedCapture: { host: "127.0.0.1", port: 2599, note: () => undefined } });
      assert.deepEqual(shared.status, { mail: "captured", smtp: { host: "127.0.0.1", port: 2599 }, variables: ["MAIL_PORT"], network: "allow", allow: [] });
    });

    it("says nothing when mail is captured and connections that leave this machine are refused", () => {
      for (const mail of ["captured", "listening"] as const) {
        assert.deepEqual(formatUnguardedSideEffects({ mail, smtp: { host: "127.0.0.1", port: 2525 }, variables: mail === "captured" ? ["SMTP_HOST"] : [], network: "block", allow: [] }), []);
      }
    });

    it("warns, when nothing is configured, that mail and calls to other services are real, and says how to keep them here", () => {
      assert.deepEqual(formatUnguardedSideEffects({ mail: "off", variables: [], network: "allow", allow: [] }), [MAIL_OFF, GUARD_OFF, NOTHING, HOW_MAIL, HOW_GUARD, where("Both are")]);
      // Whoever configures the sandbox says what its configuration is called.
      assert.equal(formatUnguardedSideEffects({ mail: "off", variables: [], network: "allow", allow: [] }, { configuration: ".local-db-sandbox/sandbox.config.json" }).at(-1), where("Both are", ".local-db-sandbox/sandbox.config.json"));
    });

    it("warns that calls to other services are real when only mail is captured", () => {
      const captured = { mail: "captured" as const, smtp: { host: "127.0.0.1", port: 2525 }, variables: ["SMTP_HOST"] };
      assert.deepEqual(formatUnguardedSideEffects({ ...captured, network: "allow", allow: [] }), [GUARD_OFF, ONLY_MAIL, HOW_GUARD, where("It is")]);
      // A guard that reports opens the connection all the same.
      assert.deepEqual(formatUnguardedSideEffects({ ...captured, network: "warn", allow: [] }), [`${ONLY_MAIL}${STILL_OPENED}`, HOW_BLOCK, where("It is")]);
    });

    it("warns that mail is real while a capture listens that nothing leads the application to", () => {
      assert.deepEqual(formatUnguardedSideEffects({ mail: "listening", smtp: { host: "127.0.0.1", port: 2525 }, variables: [], network: "allow", allow: [] }), [
        GUARD_OFF,
        "Warning: nothing keeps this application from real services. A capture listens for its mail, and nothing leads the application to it: its mail and its calls to other services go where its own settings say, and may reach real ones.",
        '  To lead its mail to the capture: name the variables your application reads in "smtp.env", such as { "SMTP_HOST": "{host}", "SMTP_PORT": "{port}" }.',
        HOW_GUARD,
        where("Both are"),
      ]);
    });

    it("says that mail is not captured where the guard refuses a mail server outside this machine, and warns where the guard only reports", () => {
      assert.deepEqual(formatUnguardedSideEffects({ mail: "off", variables: [], network: "block", allow: [] }), [
        "Local DB Sandbox: SMTP capture is off. Mail is not kept on this machine; a mail server outside it is refused by the network guard.",
      ]);
      assert.deepEqual(formatUnguardedSideEffects({ mail: "off", variables: [], network: "warn", allow: [] }), [MAIL_OFF, `${NOTHING}${STILL_OPENED}`, HOW_MAIL, HOW_BLOCK, where("Both are")]);
    });

    it("does not say that a mail server is refused which the guard lets through", () => {
      // A host that the configuration lets through is reached, and a mail server may be one of them: the line says no more than is so.
      assert.deepEqual(formatUnguardedSideEffects({ mail: "off", variables: [], network: "block", allow: ["smtp.provider.example:587", "*.svc.test"] }), [
        "Local DB Sandbox: SMTP capture is off. Mail is not kept on this machine; a mail server outside it is refused by the network guard, unless it is among the hosts the guard lets through.",
      ]);
      // Where mail is captured, nothing is said of a mail server, whatever is let through.
      assert.deepEqual(formatUnguardedSideEffects({ mail: "captured", smtp: { host: "127.0.0.1", port: 2525 }, variables: ["SMTP_HOST"], network: "block", allow: ["smtp.provider.example:587"] }), []);
    });

    it("never calls the guard more than it is", () => {
      for (const network of ["allow", "warn", "block"] as const) {
        for (const mail of ["off", "listening", "captured"] as const) {
          const text = formatUnguardedSideEffects({ mail, variables: [], network, allow: [] }).join("\n");
          assert.doesNotMatch(text, /isolat|secure|safe|sandboxed|cannot reach|guarantee/i, `${mail}, ${network}`);
          // Wherever the guard is offered, it is said what it is.
          assert.equal(/"network": \{ "mode"/.test(text), /development aid, not a security boundary/.test(text), `${mail}, ${network}`);
        }
      }
    });
  });

  it("keeps a session with the capture open across the checks above", async () => {
    // A capture that is closed ends its connections: a client is not left waiting.
    const effects = await start({ smtp: { mode: "capture", port: 0 } });
    const session = await smtpSession((effects.smtp as { port: number }).port);
    const closed = new Promise((resolve) => session.socket.once("close", resolve));
    await effects.close();
    running = [];
    await closed;
  });
});
