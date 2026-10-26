import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MailCapture, startMailControl } from "../../side-effects/src/index.ts";
import type { MailControl } from "../../side-effects/src/index.ts";
import { transportTo } from "../../side-effects/test/support/smtp-clients.ts";
import { runCli } from "../src/index.ts";

/*
 * The `mail` command, against a capture that runs the way a sandbox runs
 * one: in a process of its own as far as the command knows, found through
 * the runtime file next to the sandbox configuration.
 */

describe("mail command", () => {
  let dir: string;
  let config: string;
  let capture: MailCapture;
  let control: MailControl;
  let tick = 0;

  const run = async (...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(["mail", ...argv], { stdout: { write: (text) => (stdout += text) }, stderr: { write: (text) => (stderr += text) }, signals: new EventEmitter() });
    return { code, stdout, stderr };
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-db-sandbox-mail-cli-"));
    await mkdir(join(dir, ".local-db-sandbox"));
    config = join(dir, ".local-db-sandbox", "sandbox.config.json");
    await writeFile(config, JSON.stringify({ entry: "../src/main.ts", database: "../sandbox.db", port: 3001, smtp: { mode: "capture" } }));
    // Each message a minute after the one before, so that what is printed does not depend on when the test runs.
    capture = await MailCapture.start({ port: 0, now: () => new Date(Date.UTC(2026, 9, 6, 8, 15 + tick++, 30)) });
    control = await startMailControl(capture, join(dir, ".local-db-sandbox", "sandbox.runtime.json"));

    const transport = transportTo(capture);
    await transport.sendMail({ from: '"The App" <app@example.com>', to: "test@example.com", subject: "Verify account", text: "Hello Ada,\n\nyour code is 123456.\n\nThe App" });
    capture.noteConnection(0, "unused");
    await transport.sendMail({
      from: "app@example.com",
      to: ["ada@example.com", "bo@example.org"],
      cc: "cy@example.net",
      bcc: "hidden@example.com",
      replyTo: "support@example.com",
      subject: "Your invoice for March – 漢字",
      html: "<html><head><style>p { color: red }</style></head><body><h1>Invoice</h1><p>Total:&nbsp;<b>42</b> EUR. <script>alert(1)</script></p></body></html>",
      attachments: [
        { filename: "invoice.pdf", content: Buffer.alloc(20_480, 7), contentType: "application/pdf" },
        { filename: "logo.png", content: Buffer.from([1, 2, 3]), cid: "logo" },
      ],
    });
    await transport.sendMail({ from: "app@example.com", to: "ops@example.com", subject: "Long", text: Array.from({ length: 30 }, (_value, line) => `line ${line + 1}`).join("\n") });
    transport.close();
    // The requests the application was handling, as the sandbox would have recorded them.
    Object.assign(capture.list()[0] as object, { requestId: "req-abc" });
    Object.assign(capture.list()[2] as object, { requestId: "background" });
  });
  after(async () => {
    await control.close();
    await capture.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the captured messages: id, time, sender, recipients, subject, and request", async () => {
    assert.deepEqual(await run("list", "--config", config), {
      code: 0,
      stderr: "",
      stdout:
        // Columns are as wide as their longest text, counted in characters.
        "ID      Captured                 From             To                    Subject                      Request\n" +
        "mail-1  2026-10-06 08:15:30 UTC  app@example.com  test@example.com      Verify account               req-abc\n" +
        "mail-2  2026-10-06 08:16:30 UTC  app@example.com  ada@example.com (+3)  Your invoice for March – 漢字  unknown\n" +
        "mail-3  2026-10-06 08:17:30 UTC  app@example.com  ops@example.com       Long                         background\n" +
        "(3 messages)\n",
    });
    const json = JSON.parse((await run("list", "--config", config, "--json")).stdout);
    assert.deepEqual(json.map((mail: { id: string; to: string[] }) => [mail.id, mail.to.length]), [["mail-1", 1], ["mail-2", 4], ["mail-3", 1]]);
  });

  it("shows a message: who it is from and for, when it was captured, and the start of its text", async () => {
    const { code, stdout, stderr } = await run("show", "mail-1", "--config", config);
    assert.deepEqual([code, stderr], [0, ""]);
    assert.match(stdout, /^Size: {6}\d+ bytes$/m);
    assert.equal(
      stdout.replace(/^Size: .*\n/m, ""),
      "ID:        mail-1\n" +
        "Captured:  2026-10-06 08:15:30 UTC\n" +
        "Request:   req-abc\n" +
        "From:      The App <app@example.com>\n" +
        "To:        test@example.com\n" +
        "Subject:   Verify account\n" +
        "Envelope:  app@example.com -> test@example.com\n" +
        "Attachments: none\n" +
        "Text:\n" +
        "  Hello Ada,\n" +
        "  \n" +
        "  your code is 123456.\n" +
        "  \n" +
        "  The App\n",
    );
  });

  it("shows attachments by name, type, and size, never their content, and an HTML body as its words", async () => {
    const { stdout } = await run("show", "mail-2", "--config", config);
    assert.equal(
      stdout.replace(/^(Size|HTML): .*\n/gm, ""),
      "ID:        mail-2\n" +
        "Captured:  2026-10-06 08:16:30 UTC\n" +
        "Request:   unknown\n" +
        "From:      app@example.com\n" +
        "To:        ada@example.com, bo@example.org\n" +
        "Cc:        cy@example.net\n" +
        "Reply-To:  support@example.com\n" +
        "Subject:   Your invoice for March – 漢字\n" +
        // The recipient that is in no header is only in what the server was told.
        "Envelope:  app@example.com -> ada@example.com, bo@example.org, cy@example.net, hidden@example.com\n" +
        "Attachments:\n" +
        "  logo.png  image/png  3 bytes  inline\n" +
        "  invoice.pdf  application/pdf  20.0 KB (20,480 bytes)\n" +
        // Neither the style sheet nor the script is part of the words, and nothing was run.
        "  Invoice Total: 42 EUR.\n",
    );
    assert.match(stdout, /^HTML: {6}\d+ bytes \(print it with --html\)$/m);
    assert.match(stdout, /^Size: {6}[\d.]+ KB \([\d,]+ bytes\)$/m);
    // 20 KB were attached; what is printed is a few lines.
    assert.ok(stdout.length < 1000);
  });

  it("prints a long text as a preview, and all of a body on request", async () => {
    const preview = (await run("show", "mail-3", "--config", config)).stdout;
    assert.match(preview, /\n {2}line 20\n {2}\.\.\. \(10 more lines; print all of it with --text\)\n$/);
    assert.ok(!preview.includes("line 21"));

    assert.equal((await run("show", "mail-3", "--config", config, "--text")).stdout, `${Array.from({ length: 30 }, (_value, line) => `line ${line + 1}`).join("\n")}\n`);
    assert.match((await run("show", "mail-2", "--config", config, "--html")).stdout, /^<html><head><style>p \{ color: red \}<\/style><\/head><body><h1>Invoice<\/h1>/);
    const headers = (await run("show", "mail-2", "--config", config, "--headers")).stdout;
    assert.match(headers, /\nHeaders:\n(?: {2}.+\n)* {2}Subject: Your invoice for March – 漢字\n/);
    assert.match(headers, /\n {2}MIME-Version: 1\.0\n/);

    const json = JSON.parse((await run("show", "mail-2", "--config", config, "--json")).stdout);
    assert.deepEqual([json.id, json.subject, json.attachments.map((attachment: { filename: string }) => attachment.filename)], ["mail-2", "Your invoice for March – 漢字", ["logo.png", "invoice.pdf"]]);
    assert.ok(json.attachments.every((attachment: object) => !("content" in attachment)));
  });

  it("does not let a message write to the terminal: control characters are shown, not sent", async () => {
    const transport = transportTo(capture);
    await transport.sendMail({ from: "app@example.com", to: "x@example.com", subject: "esc", text: "before \u001b[2J\u001b[31m after\u0007", textEncoding: "8bit" });
    transport.close();
    const shown = (await run("show", "mail-4", "--config", config)).stdout;
    assert.ok(!shown.includes("\u001b") && !shown.includes("\u0007"));
    assert.match(shown, /before \\x1b\[2J\\x1b\[31m after\\x07/);
  });

  it("finds the configuration of the project it is run in", async () => {
    const cwd = process.cwd();
    await mkdir(join(dir, "src", "deep"), { recursive: true });
    try {
      process.chdir(join(dir, "src", "deep"));
      assert.match((await run("list")).stdout, /\n\(4 messages\)\n$/);
      process.chdir(tmpdir());
      const nowhere = await run("list");
      // A temporary folder may itself be below a project; only its absence is an error.
      if (nowhere.code === 1) {
        assert.match(nowhere.stderr, /^Error: No \.local-db-sandbox\/sandbox\.config\.json was found here or above\. Run this in the project, or name the configuration with --config\./);
      }
    } finally {
      process.chdir(cwd);
    }
  });

  it("says what is wrong with its arguments", async () => {
    const errors: [string[], RegExp][] = [
      [[], /^Error: Missing what to do: "list", "show <id>", or "clear"\./],
      [["read"], /^Error: Unknown mail command "read": it is "list", "show <id>", or "clear"\./],
      [["show", "--config", config], /^Error: Give the id of one message, as "mail list" prints it: mail show mail-1/],
      [["show", "mail-1", "mail-2", "--config", config], /^Error: Give the id of one message/],
      [["list", "mail-1", "--config", config], /^Error: "mail list" takes no further argument\./],
      [["show", "mail-99", "--config", config], /^Error: There is no captured message "mail-99"\. "mail list" prints the ids\./],
      [["show", "mail-1", "--html", "--config", config], /^Error: mail-1 has no HTML body\./],
      [["show", "mail-2", "--text", "--config", config], /^Error: mail-2 has no plain-text body\./],
      [["show", "mail-1", "--text", "--html", "--config", config], /^Error: --text and --html cannot be used together\./],
      [["list", "--config", join(dir, "missing.json")], /^Error: .*missing\.json does not exist\./],
      [["list", "--nope"], /^Error: Unknown option '--nope'/],
    ];
    for (const [args, expected] of errors) {
      const { code, stdout, stderr } = await run(...args);
      assert.deepEqual([code, stdout], [1, ""], args.join(" "));
      assert.match(stderr, expected);
      assert.match(stderr, /Run "local-db-sandbox mail --help" for usage\.\n$/);
    }
    assert.match((await run("--help")).stdout, /^Usage: local-db-sandbox mail list \[options\]/);
    let main = "";
    await runCli(["--help"], { stdout: { write: (text) => (main += text) }, stderr: { write: () => undefined }, signals: new EventEmitter() });
    assert.match(main, /local-db-sandbox mail list \| show <id> \| clear \[options\]/);
  });

  it("clears the mailbox, and says that there is none when no sandbox is capturing", async () => {
    assert.deepEqual(await run("clear", "--config", config), { code: 0, stderr: "", stdout: "Removed 4 captured messages.\n" });
    assert.deepEqual(await run("list", "--config", config), { code: 0, stderr: "", stdout: "No mail has been captured.\n" });
    assert.equal((await run("clear", "--config", config, "--json")).stdout, '{"removed":0}\n');

    // The sandbox stops: its mail is gone with it, and the command says so.
    const other = join(dir, "other");
    await mkdir(join(other, ".local-db-sandbox"), { recursive: true });
    await writeFile(join(other, ".local-db-sandbox", "sandbox.config.json"), "{}");
    const stopped = await run("list", "--config", join(other, ".local-db-sandbox", "sandbox.config.json"));
    assert.equal(stopped.code, 1);
    assert.match(stopped.stderr, /^Error: No sandbox with mail capture is running here .*Captured mail is kept in memory by the running sandbox \("npm run sandbox"\) and is gone when it stops\. Mail is captured when the sandbox configuration has "smtp": \{ "mode": "capture" \}\.\n/);
    // A runtime file that outlived its process, as after a crash.
    await writeFile(join(other, ".local-db-sandbox", "sandbox.runtime.json"), JSON.stringify({ pid: 999999999, smtp: { host: "127.0.0.1", port: 1 }, control: { url: "http://127.0.0.1:9", token: "x" } }));
    assert.match((await run("list", "--config", join(other, ".local-db-sandbox", "sandbox.config.json"))).stderr, /^Error: The sandbox that wrote its runtime file \(process 999999999\) does not answer: it has stopped, and its captured mail went with it\./);
  });
});
