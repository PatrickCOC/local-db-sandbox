import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { Socket, connect as openConnection } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { runCli } from "../../cli/src/index.ts";
import type { CapturedMail } from "../../cli/src/index.ts";
import { initNest, watchNestSandbox } from "../src/index.ts";
import type { NestSandboxWatch, SandboxWatchEvent } from "../src/index.ts";
import { createNestProject, freePort, start, until } from "./support/nest-project.ts";
import type { Running } from "./support/nest-project.ts";

/*
 * Mail capture and the network guard around a real application: a copy of
 * fixtures/nest-project, whose mail controller sends with Nodemailer to the
 * server that its own environment variables (MAIL_HOST, MAIL_PORT) name. The
 * application is not edited; only the sandbox configuration differs between
 * the cases.
 */
describe("mail and network of an application in the sandbox", { timeout: 240_000 }, () => {
  let dir: string;
  let port: number;
  let smtpPort: number;
  let config: string;
  let runtimeFile: string;
  let base: Record<string, unknown>;
  let watch: NestSandboxWatch | undefined;
  let output = "";
  const spawned: Running[] = [];
  const events: SandboxWatchEvent[] = [];
  const connect = Socket.prototype.connect;

  /** What the application would use if nothing led it elsewhere: a real-looking server, which must never be reached. */
  const applicationEnvironment = { MAIL_HOST: "smtp.mail-provider.example", MAIL_PORT: "587" };
  const url = (path: string): string => `http://localhost:${port}${path}`;
  const get = async (path: string): Promise<any> => (await fetch(url(path))).json();
  const sendMail = async (requestId: string, to: string | string[], subject: string): Promise<{ status: number; body: any; ms: number }> => {
    const startedAt = performance.now();
    const response = await fetch(url("/api/mail"), { method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId }, body: JSON.stringify({ to, subject }) });
    return { status: response.status, body: await response.json(), ms: performance.now() - startedAt };
  };
  /** Whether something accepts connections on a port of this machine. */
  const listening = (target: number): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = openConnection({ host: "127.0.0.1", port: target });
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
  const configure = async (more: Record<string, unknown>): Promise<void> => writeFile(config, JSON.stringify({ ...base, ...more }, null, 2));
  const mail = async (...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["mail", ...argv, "--config", config], { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  };
  const listed = async (): Promise<CapturedMail[]> => JSON.parse((await mail("list", "--json")).stdout);
  /** Starts the sandbox once, without watching, as CI does. */
  const startOnce = async (env: Record<string, string> = {}): Promise<Running> => {
    const running = start(dir, [".local-db-sandbox/sandbox.server.ts"], { ...applicationEnvironment, ...env });
    spawned.push(running);
    let ended = false;
    void running.exited.then(() => (ended = true));
    await until(async () => ended || (await fetch(url("/api/info"))).ok, () => `the sandbox did not start\n${running.output()}`);
    assert.equal(ended, false, running.output());
    return running;
  };
  /** Starts it the way `npm run sandbox` does: a watcher that restarts the sandbox process. */
  const startWatching = async (): Promise<void> => {
    events.length = 0;
    output = "";
    const saved = { ...process.env };
    // The watcher gives its environment to the sandbox process.
    Object.assign(process.env, applicationEnvironment);
    try {
      watch = watchNestSandbox({
        configFile: config,
        debounceMs: 100,
        log: (line) => (output += `${line}\n`),
        output: { stdout: { write: (text) => (output += text) }, stderr: { write: (text) => (output += text) } },
        signals: new EventEmitter(),
        onEvent: (event) => events.push(event),
      });
    } finally {
      for (const name of Object.keys(applicationEnvironment)) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
    }
    await until(async () => (await fetch(url("/api/info"))).ok, () => `the sandbox did not start\n${output}`);
  };

  before(async () => {
    dir = await createNestProject();
    [port, smtpPort] = [await freePort(), await freePort()];
    config = join(dir, ".local-db-sandbox", "sandbox.config.json");
    runtimeFile = join(dir, ".local-db-sandbox", "sandbox.runtime.json");
    await initNest({ cwd: dir, port });
    base = JSON.parse(await readFile(config, "utf8"));
  });
  afterEach(async () => {
    await watch?.stop();
    watch = undefined;
    for (const running of spawned.splice(0)) {
      running.child.kill();
      await running.exited;
    }
    await configure({});
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** What a sandbox says when it starts with neither kept on this machine: both states, a warning, and how each is turned on. */
  const UNGUARDED = new RegExp(
    "Local DB Sandbox: SMTP capture is off\\. The application sends its mail wherever its own settings say\\.\\n" +
      'Local DB Sandbox: network guard is off \\("allow"\\)\\. TCP connections that leave this machine are opened, and are not reported\\.\\n' +
      "Warning: nothing keeps this application from real services\\. Its mail and its calls to other services go where its own settings say, and may reach real ones\\.\\n" +
      '  To keep mail on this machine: "smtp": \\{ "mode": "capture", "env": \\{ "SMTP_HOST": "\\{host\\}", "SMTP_PORT": "\\{port\\}" \\} \\}, with the names your application reads\\.\\n' +
      '  To report connections that leave this machine, or to refuse them: "network": \\{ "mode": "warn" \\} or \\{ "mode": "block" \\}\\.\\n' +
      "  Both are set in \\.local-db-sandbox/sandbox\\.config\\.json\\. The network guard is a development aid, not a security boundary\\.\\n",
  );
  /** A warning of the sandbox's about real services, whichever it is. */
  const WARNED = /Warning: (nothing keeps this application from real services|the application's mail is captured, and nothing else keeps it from real services)/;

  it("are left alone when the configuration says nothing about them, and the sandbox says so when it starts", async () => {
    assert.deepEqual([base.smtp, base.network], [undefined, undefined]);
    const running = await startOnce();
    // The application has its own settings, nothing listens for its mail, and nothing was written.
    assert.deepEqual(await get("/api/mail/settings"), { host: "smtp.mail-provider.example", port: "587" });
    assert.equal(await listening(smtpPort), false);
    assert.equal(existsSync(runtimeFile), false);
    // It is said before the application is loaded: neither is kept on this machine, and how each is turned on.
    assert.match(running.output(), UNGUARDED);
    assert.ok(running.output().indexOf("Warning: nothing keeps this application") < running.output().indexOf("Local DB Sandbox: application running at"), running.output());
    // Saying it starts nothing: no capture, no guard, and nothing captured, reported, or refused.
    assert.doesNotMatch(running.output(), /SMTP capture on|SMTP captured|NETWORK|network guard "/);
    // A connection of the application's own goes where the application sends it: to a port of this machine here.
    assert.deepEqual(await get(`/api/mail/reach?host=127.0.0.1&port=${port}`), { connected: true });
    const none = await mail("list");
    assert.equal(none.code, 1);
    assert.match(none.stderr, /^Error: No sandbox with mail capture is running here/);

    // The same with both named and turned off.
    running.child.kill();
    await running.exited;
    await configure({ smtp: { mode: "off", env: { MAIL_HOST: "{host}" } }, network: { mode: "allow" } });
    const off = await startOnce();
    assert.deepEqual(await get("/api/mail/settings"), { host: "smtp.mail-provider.example", port: "587" });
    assert.equal(existsSync(runtimeFile), false);
    assert.match(off.output(), UNGUARDED);
    assert.doesNotMatch(off.output(), /SMTP capture on|SMTP captured|NETWORK|network guard "/);
  });

  it("capture the application's mail through the environment variables the configuration names, with the request each message was sent for", async () => {
    await configure({ smtp: { mode: "capture", port: smtpPort, env: { MAIL_HOST: "{host}", MAIL_PORT: "{port}" } } });
    const running = await startOnce({ MAIL_ON_START: "1" });

    // The application reads its settings as always, and finds the capture there.
    assert.deepEqual(await get("/api/mail/settings"), { host: "127.0.0.1", port: String(smtpPort) });
    assert.match(running.output(), new RegExp(`Local DB Sandbox: SMTP capture on 127\\.0\\.0\\.1:${smtpPort}\\. Mail is kept in memory and sent to no one; see it with "local-db-sandbox mail list"\\.\\n {2}set for the application, to lead its mail to 127\\.0\\.0\\.1:${smtpPort}: MAIL_HOST, MAIL_PORT\\n`));
    // Only its mail is kept here, and the sandbox says so: its calls to other services are not.
    assert.match(
      running.output(),
      /Local DB Sandbox: network guard is off \("allow"\)\. TCP connections that leave this machine are opened, and are not reported\.\nWarning: the application's mail is captured, and nothing else keeps it from real services\. Its calls to other services go where its own settings say, and may reach real ones\.\n {2}To report connections that leave this machine, or to refuse them: "network": \{ "mode": "warn" \} or \{ "mode": "block" \}\.\n {2}It is set in \.local-db-sandbox\/sandbox\.config\.json\. The network guard is a development aid, not a security boundary\.\n/,
    );
    assert.doesNotMatch(running.output(), /SMTP capture is off|To keep mail on this machine/);

    const sent = await sendMail("req-abc", "test@example.com", "Verify account");
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.match(sent.body.response, /^250 2\.0\.0 OK: captured as mail-2; not sent to anyone$/);
    // The mail server is on this machine: a request that sends mail does not wait for a network.
    assert.ok(sent.ms < 5000, `the request took ${sent.ms} ms`);
    await sendMail("req-two", ["ada@example.com", "bo@example.org"], "For two");

    // One line per message, with its request; mail sent while the application started has none.
    const lines = running.output().split(/\r?\n/).filter((line) => line.includes("SMTP captured"));
    assert.deepEqual(lines, [
      '[background] SMTP captured id=mail-1 to=ops@example.com subject="Application started"',
      '[req-abc] SMTP captured id=mail-2 to=test@example.com subject="Verify account"',
      '[req-two] SMTP captured id=mail-3 to=ada@example.com,bo@example.org subject="For two"',
    ]);

    assert.deepEqual((await listed()).map((message) => [message.id, message.requestId, message.to, message.subject]), [
      ["mail-1", "background", ["ops@example.com"], "Application started"],
      ["mail-2", "req-abc", ["test@example.com"], "Verify account"],
      ["mail-3", "req-two", ["ada@example.com", "bo@example.org"], "For two"],
    ]);
    const shown = await mail("show", "mail-2");
    assert.match(shown.stdout, /^ID: {8}mail-2\nCaptured: {2}\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\nRequest: {3}req-abc\nFrom: {6}app@example\.com\nTo: {8}test@example\.com\nSubject: {3}Verify account\n/);
    assert.match(shown.stdout, /\nText:\n {2}Sent by the application to test@example\.com\.\n$/);
    assert.equal((await mail("clear")).stdout, "Removed 3 captured messages.\n");

    // The mailbox is the process's: when it stops, so does the way to it.
    running.child.kill();
    await running.exited;
    assert.match((await mail("list")).stderr, /^Error: (No sandbox with mail capture is running here|The sandbox that wrote its runtime file .* does not answer)/);
  });

  it("refuse connections that leave this machine when the network guard blocks, and say which request tried", async () => {
    await configure({ smtp: { mode: "capture", port: smtpPort, env: { MAIL_PORT: "{port}" } }, network: { mode: "block" } });
    // Only the port is led to the capture: the host stays the application's own, a server somewhere else.
    const running = await startOnce();
    assert.deepEqual(await get("/api/mail/settings"), { host: "smtp.mail-provider.example", port: String(smtpPort) });
    assert.match(running.output(), /Local DB Sandbox: network guard "block": TCP connections that leave this machine are refused\. It is a development aid, not a security boundary\./);
    // Mail is captured and connections that leave this machine are refused: there is nothing to warn of.
    assert.doesNotMatch(running.output(), WARNED);
    assert.doesNotMatch(running.output(), /is off/);

    // The application's mail would have gone to that server. It fails at once, and nothing was sent.
    const sent = await sendMail("req-mail", "test@example.com", "Must not leave");
    assert.equal(sent.status, 500);
    assert.ok(sent.ms < 5000, `the request took ${sent.ms} ms`);
    assert.deepEqual(await listed(), []);

    const reach = await fetch(url("/api/mail/reach?host=203.0.113.10&port=443"), { headers: { "x-request-id": "req-api" } });
    assert.deepEqual(await reach.json(), { connected: false, code: "ESANDBOXNETWORK" });
    // This machine is still reachable: the sandbox's own port, by name and by address.
    assert.deepEqual(await get(`/api/mail/reach?host=localhost&port=${port}`), { connected: true });
    assert.deepEqual(await get(`/api/mail/reach?host=127.0.0.1&port=${smtpPort}`), { connected: true });

    assert.deepEqual(
      running.output().split(/\r?\n/).filter((line) => line.includes("NETWORK")),
      [
        // Nodemailer looks the name up itself before it connects: the look-up is where it stops.
        "[req-mail] NETWORK blocked: the name smtp.mail-provider.example was not looked up, so nothing connects to it",
        "[req-api] NETWORK blocked: the connection to 203.0.113.10:443 (https) was refused before it was opened",
      ],
    );
  });

  it("report such connections, and open them, when the network guard warns", async () => {
    await configure({ network: { mode: "warn" } });
    const running = await startOnce();
    // A guard that reports is no guard that refuses, and the sandbox says so, with what would refuse.
    assert.match(
      running.output(),
      /Local DB Sandbox: SMTP capture is off\. The application sends its mail wherever its own settings say\.\nWarning: nothing keeps this application from real services\. .* may reach real ones\. Connections that leave this machine are reported here, and are still opened\.\n {2}To keep mail on this machine: .*\n {2}To refuse connections that leave this machine: "network": \{ "mode": "block" \}\.\n {2}Both are set in \.local-db-sandbox\/sandbox\.config\.json\. The network guard is a development aid, not a security boundary\.\n/,
    );
    assert.doesNotMatch(running.output(), /network guard is off/);
    // A host that is not known to be this machine, although it is: this machine's own name. Nothing leaves it.
    const reached = await fetch(url(`/api/mail/reach?host=${encodeURIComponent(hostname())}&port=${port}`), { headers: { "x-request-id": "req-api" } });
    assert.notEqual(((await reached.json()) as { code?: string }).code, "ESANDBOXNETWORK");
    assert.deepEqual(
      running.output().split(/\r?\n/).filter((line) => line.includes("NETWORK")),
      [`[req-api] NETWORK warning: a connection to ${hostname()}:${port} leaves this machine`],
    );
    // To this machine by its loopback name, nothing is reported.
    assert.deepEqual(await get(`/api/mail/reach?host=localhost&port=${port}`), { connected: true });
    assert.equal(running.output().split(/\r?\n/).filter((line) => line.includes("NETWORK")).length, 1);
  });

  it("keep captured mail, and the port it is sent to, across a restart of the application; nothing is lost or captured twice", async () => {
    await configure({ smtp: { mode: "capture", port: smtpPort, env: { MAIL_HOST: "{host}", MAIL_PORT: "{port}" } } });
    await startWatching();
    assert.equal((await sendMail("req-before", "ada@example.com", "Before the restart")).status, 201);
    assert.equal(await listening(smtpPort), true);

    // The application is edited: the watcher restarts its process.
    const controller = join(dir, "src", "info.controller.ts");
    await writeFile(controller, `${await readFile(controller, "utf8")}\n// edited\n`);
    await until(() => events.filter((event) => event.type === "started").length === 2, () => `the sandbox was not restarted\n${output}`);
    // While it is down, the capture still listens: it belongs to the watcher.
    assert.equal(await listening(smtpPort), true);
    await until(async () => (await fetch(url("/api/mail/settings"))).ok, () => `the sandbox did not come back\n${output}`);
    assert.deepEqual(await get("/api/mail/settings"), { host: "127.0.0.1", port: String(smtpPort) });
    assert.equal((await sendMail("req-after", "bo@example.org", "After the restart")).status, 201);

    // Both messages, once each, numbered on; each with the request of the process that sent it.
    assert.deepEqual((await listed()).map((message) => [message.id, message.requestId, message.subject]), [
      ["mail-1", "req-before", "Before the restart"],
      ["mail-2", "req-after", "After the restart"],
    ]);
    assert.deepEqual(
      output.split(/\r?\n/).filter((line) => line.includes("SMTP capture")),
      [
        `Local DB Sandbox: SMTP capture on 127.0.0.1:${smtpPort}. Mail is kept in memory and sent to no one; see it with "local-db-sandbox mail list".`,
        '[req-before] SMTP captured id=mail-1 to=ada@example.com subject="Before the restart"',
        '[req-after] SMTP captured id=mail-2 to=bo@example.org subject="After the restart"',
      ],
    );
    assert.deepEqual(events.flatMap((event) => (event.type === "side-effect" && event.event.kind === "smtp" ? [event.event.id] : [])), ["mail-1", "mail-2"]);
    // The watcher itself opened no connection and replaced nothing in this process.
    assert.equal(Socket.prototype.connect, connect);

    // Stopping the watcher ends the capture: the port is free, and the mailbox is gone.
    await watch?.stop();
    watch = undefined;
    assert.equal(await listening(smtpPort), false);
    assert.equal(existsSync(runtimeFile), false);
    assert.match((await mail("list")).stderr, /^Error: No sandbox with mail capture is running here/);
  });

  it("do not start when the configuration is not usable, and say why", async () => {
    const refused = async (more: Record<string, unknown>, message: RegExp): Promise<void> => {
      await configure(more);
      const running = start(dir, [".local-db-sandbox/sandbox.server.ts"]);
      spawned.push(running);
      assert.equal(await running.exited, 1, running.output());
      assert.match(running.output(), message);
    };
    await refused({ smtp: { mode: "capture", host: "0.0.0.0" } }, /Error: "host" in "smtp" in .*sandbox\.config\.json must be a loopback address/);
    await refused({ smtp: { mode: "relay" } }, /Error: "mode" in "smtp" in .*sandbox\.config\.json must be "off" or "capture"\./);
    await refused({ network: { mode: "strict" } }, /Error: "mode" in "network" in .*sandbox\.config\.json must be "allow", "warn", or "block"\./);

    // A port that is taken: by the capture of a sandbox that is already running, for one.
    await configure({ smtp: { mode: "capture", port: smtpPort } });
    await startOnce();
    const second = start(dir, [".local-db-sandbox/sandbox.server.ts"]);
    spawned.push(second);
    assert.equal(await second.exited, 1, second.output());
    assert.match(second.output(), new RegExp(`Error: The SMTP capture server cannot listen on 127\\.0\\.0\\.1:${smtpPort}: the port is in use\\. Another sandbox may be running`));
  });
});
