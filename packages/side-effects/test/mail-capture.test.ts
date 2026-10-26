import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { MailCapture, SmtpServerError, installNetworkHook, isLoopbackHost, parseMail } from "../src/index.ts";
import type { CapturedMail, NetworkEvent } from "../src/index.ts";
import { smtpSession, transportTo } from "./support/smtp-clients.ts";
import type { Transport } from "./support/smtp-clients.ts";

/*
 * The mail capture, used the way an application uses an SMTP server: through
 * Nodemailer. What it must do is take what it is sent, show it faithfully,
 * and send nothing anywhere.
 */

const AT = new Date("2026-10-06T08:15:30.000Z");

describe("mail capture", () => {
  let capture: MailCapture;
  let transport: Transport;
  const captured: CapturedMail[] = [];
  const open: { close(): unknown }[] = [];

  const start = async (options: Parameters<typeof MailCapture.start>[0] = {}): Promise<MailCapture> => {
    const started = await MailCapture.start({ port: 0, now: () => AT, onCapture: (mail) => captured.push(mail), ...options });
    open.push(started);
    return started;
  };
  /** A body without the line break that ends it on the wire when it is the whole message, and not when it is one part of several. */
  const body = (text: string | undefined): string | undefined => text?.replace(/\n$/, "");
  const header = (mail: CapturedMail, name: string): string | undefined => mail.headers.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())?.value;

  beforeEach(async () => {
    captured.length = 0;
    capture = await start();
    transport = transportTo(capture);
  });
  afterEach(async () => {
    transport.close();
    for (const item of open.splice(0)) {
      await item.close();
    }
  });

  describe("a message", () => {
    it("is accepted, kept, and given a local id; the client is told that it went nowhere", async () => {
      const info = await transport.sendMail({ from: "app@example.com", to: "test@example.com", subject: "Verify account", text: "Your code is 123456." });
      assert.match(info.response, /^250 2\.0\.0 OK: captured as mail-1; not sent to anyone$/);
      assert.deepEqual(info.accepted, ["test@example.com"]);

      const [mail] = capture.list();
      assert.deepEqual(
        { id: mail?.id, capturedAt: mail?.capturedAt, from: mail?.from, to: mail?.to, subject: mail?.subject, text: body(mail?.text), html: mail?.html, attachments: mail?.attachments },
        { id: "mail-1", capturedAt: "2026-10-06T08:15:30.000Z", from: "app@example.com", to: ["test@example.com"], subject: "Verify account", text: "Your code is 123456.", html: undefined, attachments: [] },
      );
      assert.ok((mail?.sizeBytes as number) > 100);
      assert.deepEqual(captured, [mail]);
      assert.equal(capture.get("mail-1"), mail);
      assert.equal(capture.get("mail-2"), undefined);
    });

    it("keeps every recipient the server was given: To, Cc, and Bcc", async () => {
      await transport.sendMail({
        from: '"The App" <app@example.com>',
        to: ["ada@example.com", "Bo <bo@example.org>"],
        cc: "cy@example.net",
        bcc: ["hidden@example.com"],
        subject: "To several",
        text: "x",
      });
      const [mail] = capture.list();
      assert.equal(mail?.from, "app@example.com");
      assert.deepEqual(mail?.to, ["ada@example.com", "bo@example.org", "cy@example.net", "hidden@example.com"]);
      // The headers are the message's own: Bcc is in none of them.
      assert.deepEqual([header(mail as CapturedMail, "From"), header(mail as CapturedMail, "To"), header(mail as CapturedMail, "Cc"), header(mail as CapturedMail, "Bcc")], [
        "The App <app@example.com>",
        "ada@example.com, Bo <bo@example.org>",
        "cy@example.net",
        undefined,
      ]);
    });

    it("keeps a plain-text body as it was written", async () => {
      const text = [
        "Hello Ada,",
        "",
        ".a line that starts with a dot",
        "..and one with two",
        ".",
        "Umlauts äöü, 漢字, emoji 🎉, and a tab\tin a line.",
        `A line of more than a thousand characters: ${"word ".repeat(300)}end.`,
        "= signs and trailing spaces   ",
        "The end.",
      ].join("\n");
      await transport.sendMail({ from: "app@example.com", to: "ada@example.com", subject: "Text", text });
      assert.equal(body(capture.list()[0]?.text), text);
      assert.equal(capture.list()[0]?.html, undefined);

      // A body that is sent as it is, without an encoding that hides its lines.
      await transport.sendMail({ from: "app@example.com", to: "ada@example.com", subject: "Raw lines", text: ".\n..\n.dots\n", textEncoding: "8bit" });
      assert.equal(capture.list()[1]?.text, ".\n..\n.dots\n");
    });

    it("keeps an HTML body, alone or next to a text body", async () => {
      const html = '<h1>Welcome, Ada</h1>\n<p>Open <a href="https://example.com/verify?code=1&amp;x=2">this link</a>. Ünïcödé.</p>\n<img src="https://example.com/pixel.png">';
      await transport.sendMail({ from: "app@example.com", to: "ada@example.com", subject: "Both", text: "Welcome, Ada", html });
      await transport.sendMail({ from: "app@example.com", to: "ada@example.com", subject: "HTML only", html });
      const [both, only] = capture.list();
      assert.deepEqual([body(both?.text), body(both?.html), both?.attachments], ["Welcome, Ada", html, []]);
      assert.deepEqual([only?.text, body(only?.html)], [undefined, html]);
    });

    it("keeps the headers, decoded, in the order they were sent", async () => {
      await transport.sendMail({
        from: '"Ünïcödé Sender 漢" <app@example.com>',
        to: "ada@example.com",
        replyTo: "support@example.com",
        subject: "Rechnung für März – 漢字 🎉 and a subject that is long enough to be folded over several lines of the header",
        text: "x",
        headers: { "X-Template": "invoice-v2", "X-Tenant": "tenant 42" },
        messageId: "<fixed-id@example.com>",
        date: new Date("2026-03-01T10:00:00Z"),
      });
      const mail = capture.list()[0] as CapturedMail;
      assert.equal(mail.subject, "Rechnung für März – 漢字 🎉 and a subject that is long enough to be folded over several lines of the header");
      assert.equal(header(mail, "Subject"), mail.subject);
      assert.equal(header(mail, "From"), "Ünïcödé Sender 漢 <app@example.com>");
      assert.deepEqual(
        ["X-Template", "X-Tenant", "Reply-To", "Message-ID", "Date", "MIME-Version"].map((name) => header(mail, name)),
        ["invoice-v2", "tenant 42", "support@example.com", "<fixed-id@example.com>", "Sun, 01 Mar 2026 10:00:00 +0000", "1.0"],
      );
      assert.ok(mail.headers.every(({ name, value }) => name !== "" && !/[\r\n]/.test(value)));
    });

    it("lists what its attachments are, and keeps none of their content", async () => {
      const pdf = randomBytes(40_000);
      await transport.sendMail({
        from: "app@example.com",
        to: "ada@example.com",
        subject: "With attachments",
        text: "See attached.",
        html: '<p>See attached. <img src="cid:logo@app"></p>',
        attachments: [
          { filename: "report.pdf", content: pdf, contentType: "application/pdf" },
          { filename: "Übersicht März – 漢字.csv", content: "id;name\n1;Ada\n" },
          { filename: "logo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), cid: "logo@app" },
          { filename: "notes.txt", content: "a text attachment is not the body" },
        ],
      });
      const mail = capture.list()[0] as CapturedMail;
      assert.deepEqual([body(mail.text), body(mail.html)], ["See attached.", '<p>See attached. <img src="cid:logo@app"></p>']);
      assert.deepEqual(
        [...mail.attachments].sort((a, b) => (a.filename as string).localeCompare(b.filename as string)),
        [
          { filename: "logo.png", contentType: "image/png", sizeBytes: 7, disposition: "inline", contentId: "logo@app" },
          { filename: "notes.txt", contentType: "text/plain", sizeBytes: 33, disposition: "attachment" },
          { filename: "report.pdf", contentType: "application/pdf", sizeBytes: 40_000, disposition: "attachment" },
          { filename: "Übersicht März – 漢字.csv", contentType: "text/csv", sizeBytes: 14, disposition: "attachment" },
        ],
      );
      // 40,000 bytes were attached, and the kept message is a fraction of that: metadata only.
      assert.ok(mail.sizeBytes > 50_000);
      assert.ok(JSON.stringify(mail).length < 4000, `the kept message is ${JSON.stringify(mail).length} characters`);
      assert.ok(!JSON.stringify(mail).includes(pdf.toString("base64").slice(0, 40)));
    });
  });

  describe("safety", () => {
    it("never opens a connection: mail for any address is kept, and nothing is sent on", async () => {
      // Every TCP connection this process opens while mail for real-looking addresses is captured.
      const connections: NetworkEvent[] = [];
      const remove = installNetworkHook({ mode: "allow", onEvent: (event) => connections.push(event) });
      try {
        const client = transportTo(capture);
        for (const to of ["someone@gmail.com", "ceo@a-real-company.example", "list@mailinglist.example"]) {
          const info = await client.sendMail({ from: "app@example.com", to, cc: "audit@partner.example", subject: `For ${to}`, text: "x" });
          assert.match(info.response, /captured as mail-\d; not sent to anyone$/);
        }
        client.close();
        // Long enough for a relay that queued the messages to start on them.
        await new Promise((resolve) => setTimeout(resolve, 300));
      } finally {
        remove();
      }
      assert.equal(capture.list().length, 3);
      // The only connections are the client's own, to the capture on this machine.
      assert.ok(connections.length >= 1);
      assert.deepEqual([...new Set(connections.map(({ host, port, scope }) => `${host}:${port} ${scope}`))], [`127.0.0.1:${capture.port} loopback`]);
    });

    it("listens on this machine only", async () => {
      assert.equal(capture.host, "127.0.0.1");
      for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com", ""]) {
        await assert.rejects(MailCapture.start({ host, port: 0 }), (error: unknown) => error instanceof SmtpServerError && /listens on this machine only: ".*" is not a loopback address/.test(error.message), host);
      }
      assert.deepEqual(
        ["127.0.0.1", "127.8.9.10", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1", "0.0.0.0", "10.0.0.1", "127.example.com", "localhost.example.com"].map(isLoopbackHost),
        [true, true, true, true, true, true, true, false, false, false, false],
      );
      assert.equal((await start({ host: "localhost" })).host, "localhost");

      // Through another address of this machine, when it has one, there is nothing to connect to.
      const address = Object.values(networkInterfaces())
        .flat()
        .find((candidate) => candidate !== undefined && candidate.family === "IPv4" && !candidate.internal)?.address;
      if (address !== undefined) {
        const code = await new Promise<string>((resolve) => {
          const socket = connect({ host: address, port: capture.port });
          socket.setTimeout(1500, () => (socket.destroy(), resolve("no answer")));
          socket.once("connect", () => (socket.destroy(), resolve("connected")));
          socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
        });
        assert.notEqual(code, "connected", `the capture answered on ${address}`);
      }
    });

    it("does not offer AUTH or TLS unless told to, so a client does not send its credentials", async () => {
      const session = await smtpSession(capture.port);
      assert.match(session.greeting, /^220 local-db-sandbox ESMTP mail capture: nothing is sent on\r\n$/);
      const hello = await session.send("EHLO client.example\r\n");
      assert.deepEqual(hello.split("\r\n").filter(Boolean), ["250-local-db-sandbox mail capture: nothing is sent on", "250-SIZE 26214400", "250-8BITMIME", "250-SMTPUTF8", "250 PIPELINING"]);
      assert.match(await session.send("AUTH PLAIN AHVzZXIAc2VjcmV0\r\n"), /^502 5\.5\.1 Authentication is not offered and not needed/);
      assert.match(await session.send("STARTTLS\r\n"), /^502 5\.5\.1 TLS is not offered/);
      session.close();

      // An application that has a user and a password configured sends its mail without ever giving them.
      const withAccount = transportTo(capture, { auth: { user: "real-account@example.com", pass: "a-real-password" } });
      await withAccount.sendMail({ from: "app@example.com", to: "ada@example.com", subject: "No login", text: "x" });
      withAccount.close();
      assert.equal(capture.list()[0]?.subject, "No login");
    });

    it("accepts and drops any credentials when told to offer AUTH", async () => {
      const accepting = await start({ auth: "accept" });
      const session = await smtpSession(accepting.port);
      assert.match(await session.send("EHLO client.example\r\n"), /250-PIPELINING\r\n250 AUTH PLAIN LOGIN\r\n$/);
      assert.match(await session.send("AUTH PLAIN AHVzZXIAc2VjcmV0\r\n"), /^235 2\.7\.0 Accepted\. The credentials were not checked, are not kept, and are not used/);
      assert.equal(await session.send("AUTH PLAIN\r\n"), "334 \r\n");
      assert.match(await session.send("AHVzZXIAc2VjcmV0\r\n"), /^235 /);
      assert.equal(await session.send("AUTH LOGIN\r\n"), "334 VXNlcm5hbWU6\r\n");
      assert.equal(await session.send("dXNlcg==\r\n"), "334 UGFzc3dvcmQ6\r\n");
      assert.match(await session.send("c2VjcmV0\r\n"), /^235 /);
      assert.equal(await session.send("AUTH LOGIN\r\n"), "334 VXNlcm5hbWU6\r\n");
      assert.match(await session.send("*\r\n"), /^501 5\.7\.0 Authentication cancelled/);
      assert.match(await session.send("AUTH CRAM-MD5\r\n"), /^504 /);
      session.close();

      for (const method of ["PLAIN", "LOGIN"]) {
        const client = transportTo(accepting, { auth: { user: "account@example.com", pass: "the-password-123" }, authMethod: method });
        await client.sendMail({ from: "app@example.com", to: "ada@example.com", subject: `Logged in with ${method}`, text: "x" });
        client.close();
      }
      assert.deepEqual(accepting.list().map((mail) => mail.subject), ["Logged in with PLAIN", "Logged in with LOGIN"]);
      // Nothing of the credentials is anywhere in what was kept.
      const kept = JSON.stringify(accepting.list());
      for (const secret of ["the-password-123", Buffer.from("the-password-123").toString("base64"), Buffer.from("\0account@example.com\0the-password-123").toString("base64")]) {
        assert.ok(!kept.includes(secret));
      }
    });
  });

  describe("the SMTP conversation", () => {
    const message = "From: a@example.com\r\nTo: b@example.com\r\nSubject: By hand\r\n\r\nline one\r\n..a dot\r\n.\r\n";

    it("takes several messages on one connection, and commands sent in one go", async () => {
      const session = await smtpSession(capture.port);
      await session.send("HELO client.example\r\n");
      // PIPELINING: the envelope and DATA in one write.
      const replies = await session.sendAll("MAIL FROM:<a@example.com> SIZE=100 BODY=8BITMIME\r\nRCPT TO:<b@example.com>\r\nRCPT TO:<c@example.com>\r\nDATA\r\n", 4);
      assert.deepEqual(replies.map((reply) => reply.slice(0, 3)), ["250", "250", "250", "354"]);
      assert.match(await session.send(message), /^250 2\.0\.0 OK: captured as mail-1; not sent to anyone\r\n$/);
      // The next message, with the body and the next command in one write.
      await session.sendAll("MAIL FROM:<x@example.com>\r\nRCPT TO:<y@example.com>\r\nDATA\r\n", 3);
      const [second, noop] = await session.sendAll("Subject: Second\r\n\r\n\r\n.\r\nNOOP\r\n", 2);
      assert.match(second as string, /captured as mail-2/);
      assert.equal(noop, "250 2.0.0 OK\r\n");
      assert.match(await session.send("QUIT\r\n"), /^221 /);

      const [first, next] = capture.list();
      assert.deepEqual([first?.from, first?.to, first?.subject, first?.text], ["a@example.com", ["b@example.com", "c@example.com"], "By hand", "line one\n.a dot\n"]);
      assert.deepEqual([next?.from, next?.to, next?.subject, next?.text], ["x@example.com", ["y@example.com"], "Second", "\n"]);
    });

    it("answers what it does not do, and what comes out of order, without capturing anything", async () => {
      const session = await smtpSession(capture.port);
      const replies: Record<string, string> = {};
      for (const command of ["RCPT TO:<b@example.com>", "DATA", "MAIL FROM", "MAIL FROM:<a@example.com>", "DATA", "RCPT TO:<>", "RSET", "RCPT TO:<b@example.com>", "VRFY b@example.com", "HELP", "BDAT 5 LAST", "GET / HTTP/1.1", ""]) {
        replies[command] = (await session.send(`${command}\r\n`)).slice(0, 3);
      }
      assert.deepEqual(replies, {
        "RCPT TO:<b@example.com>": "503",
        DATA: "503",
        "MAIL FROM": "501",
        "MAIL FROM:<a@example.com>": "250",
        "RCPT TO:<>": "501",
        RSET: "250",
        "VRFY b@example.com": "252",
        HELP: "214",
        "BDAT 5 LAST": "500",
        "GET / HTTP/1.1": "500",
        "": "500",
      });
      session.close();
      assert.deepEqual(capture.list(), []);
    });

    it("takes an empty message, and a sender and recipients written without brackets", async () => {
      const session = await smtpSession(capture.port);
      await session.sendAll("EHLO x\r\nMAIL FROM: a@example.com\r\nRCPT TO: b@example.com\r\nDATA\r\n", 4);
      assert.match(await session.send(".\r\n"), /captured as mail-1/);
      await session.sendAll("MAIL FROM:<>\r\nRCPT TO:<postmaster@example.com>\r\nDATA\r\n", 3);
      assert.match(await session.send("no headers at all\r\n.\r\n"), /captured as mail-2/);
      session.close();
      const [empty, bounce] = capture.list();
      assert.deepEqual([empty?.from, empty?.to, empty?.subject, empty?.text, empty?.sizeBytes], ["a@example.com", ["b@example.com"], "", "", 0]);
      assert.deepEqual([bounce?.from, bounce?.to], ["", ["postmaster@example.com"]]);
    });

    it("refuses a message above its size limit, and goes on", async () => {
      const small = await start({ maxMessageBytes: 2000 });
      const session = await smtpSession(small.port);
      assert.match(await session.send("EHLO x\r\n"), /250-SIZE 2000\r\n/);
      assert.match(await session.send("MAIL FROM:<a@example.com> SIZE=5000\r\n"), /^552 5\.3\.4 The message is larger than this server takes \(2000 bytes\)/);
      await session.sendAll("MAIL FROM:<a@example.com>\r\nRCPT TO:<b@example.com>\r\nDATA\r\n", 3);
      // Sent in pieces, as a large message arrives.
      for (let piece = 0; piece < 9; piece += 1) {
        session.socket.write(`${"x".repeat(998)}\r\n`);
      }
      assert.match(await session.send(".\r\n"), /^552 5\.3\.4 .* it was not captured\r\n$/);
      await session.sendAll("MAIL FROM:<a@example.com>\r\nRCPT TO:<b@example.com>\r\nDATA\r\n", 3);
      assert.match(await session.send("Subject: Small enough\r\n\r\nx\r\n.\r\n"), /captured as mail-1/);
      session.close();
      assert.deepEqual(small.list().map((mail) => mail.subject), ["Small enough"]);
    });
  });

  describe("the mailbox", () => {
    const send = (subject: string): Promise<unknown> => transport.sendMail({ from: "app@example.com", to: "ada@example.com", subject, text: "x" });

    it("is cleared on request, and never uses an id twice", async () => {
      await send("one");
      await send("two");
      assert.deepEqual(capture.list().map((mail) => mail.id), ["mail-1", "mail-2"]);
      assert.equal(capture.clear(), 2);
      assert.deepEqual([capture.list(), capture.clear(), capture.get("mail-1")], [[], 0, undefined]);
      await send("three");
      assert.deepEqual(capture.list().map((mail) => [mail.id, mail.subject]), [["mail-3", "three"]]);
    });

    it("keeps the newest messages when there are more than it is told to keep", async () => {
      const limited = await start({ maxMessages: 3 });
      const client = transportTo(limited);
      for (const subject of ["1", "2", "3", "4", "5"]) {
        await client.sendMail({ from: "app@example.com", to: "ada@example.com", subject, text: "x" });
      }
      client.close();
      assert.deepEqual(limited.list().map((mail) => [mail.id, mail.subject]), [["mail-3", "3"], ["mail-4", "4"], ["mail-5", "5"]]);
      await assert.rejects(MailCapture.start({ port: 0, maxMessages: 0 }), /must be a whole number, 1 or more/);
    });

    it("says which request a message was sent for, when it was told", async () => {
      const session = await smtpSession(capture.port);
      const clientPort = session.socket.localPort as number;
      const sendOne = async (subject: string): Promise<void> => {
        await session.sendAll("MAIL FROM:<a@example.com>\r\nRCPT TO:<b@example.com>\r\nDATA\r\n", 3);
        await session.send(`Subject: ${subject}\r\n\r\nx\r\n.\r\n`);
      };
      await sendOne("not told");
      capture.noteConnection(clientPort, "req-abc");
      await sendOne("for a request");
      // The same connection, used for a later request.
      capture.noteConnection(clientPort, "background");
      await sendOne("for none");
      session.close();
      assert.deepEqual(capture.list().map((mail) => [mail.subject, mail.requestId]), [["not told", undefined], ["for a request", "req-abc"], ["for none", "background"]]);
    });

    it("does not let a failing listener fail the application's send", async () => {
      const failing = await start({
        onCapture: () => {
          throw new Error("listener");
        },
      });
      const client = transportTo(failing);
      assert.match((await client.sendMail({ from: "app@example.com", to: "ada@example.com", subject: "x", text: "x" })).response, /^250 /);
      client.close();
      assert.equal(failing.list().length, 1);
    });

    it("says so when its port is taken", async () => {
      const taken = createServer();
      await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", () => resolve()));
      const { port } = taken.address() as { port: number };
      await assert.rejects(
        MailCapture.start({ port }),
        (error: unknown) => error instanceof SmtpServerError && error.message === `The SMTP capture server cannot listen on 127.0.0.1:${port}: the port is in use. Another sandbox may be running; stop it, or choose another port.`,
      );
      await new Promise((resolve) => taken.close(resolve));
    });
  });
});

describe("reading a message", () => {
  const read = (lines: string[]) => parseMail(Buffer.from(lines.join("\r\n"), "latin1"));
  after(() => undefined);

  it("follows parts within parts, and takes the first text and HTML bodies", () => {
    const mail = read([
      "Subject: =?ISO-8859-1?Q?Gr=FC=DFe?= =?UTF-8?B?IOKAkyDmvKLlrZc=?=",
      "Content-Type: multipart/mixed; boundary=outer",
      "",
      "This is the preamble, which is not shown.",
      "--outer",
      'Content-Type: multipart/alternative; boundary="in ner"',
      "",
      "--in ner",
      "Content-Type: text/plain; charset=iso-8859-1",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Gr=FC=DFe aus K=F6ln, soft =",
      "break.",
      "--in ner",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("<p>Grüße 漢字</p>").toString("base64"),
      "--in ner--",
      "--outer",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment;",
      " filename*0*=utf-8''%C3%9Cber;",
      " filename*1*=sicht%20M%C3%A4rz.bin",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from([1, 2, 3, 4, 5]).toString("base64"),
      "--outer",
      'Content-Type: image/gif; name="=?UTF-8?B?5ryi5a2XLmdpZg==?="',
      "Content-ID: <pic@local>",
      "Content-Disposition: inline",
      "",
      "GIF89a",
      "--outer",
      "Content-Type: message/rfc822",
      "",
      "Subject: a forwarded message",
      "",
      "inner body",
      "--outer--",
      "This is the epilogue.",
    ]);
    assert.equal(mail.subject, "Grüße – 漢字");
    assert.equal(mail.text, "Grüße aus Köln, soft break.");
    assert.equal(mail.html, "<p>Grüße 漢字</p>");
    assert.deepEqual(mail.attachments, [
      { filename: "Übersicht März.bin", contentType: "application/octet-stream", sizeBytes: 5, disposition: "attachment" },
      { filename: "漢字.gif", contentType: "image/gif", sizeBytes: 6, disposition: "inline", contentId: "pic@local" },
      { contentType: "message/rfc822", sizeBytes: 42, disposition: "attachment" },
    ]);
  });

  it("reads what it can of a message that is not well formed, and does not fail", () => {
    assert.deepEqual(read([]), { headers: [], subject: "", text: "", attachments: [] });
    assert.deepEqual(read(["just a line, no header and no body"]), { headers: [], subject: "", text: "", attachments: [] });
    assert.deepEqual(read(["", "a body without headers"]), { headers: [], subject: "", text: "a body without headers", attachments: [] });
    // A multipart message whose boundary never appears, an unknown character set, and an unknown encoding.
    assert.deepEqual(read(["Content-Type: multipart/mixed; boundary=missing", "", "no parts here"]).attachments, []);
    assert.equal(read(["Content-Type: text/plain; charset=x-no-such-charset", "", "caf\xe9"]).text, "caf\xe9");
    assert.equal(read(["Content-Type: text/plain", "Content-Transfer-Encoding: x-unknown", "", "as it is"]).text, "as it is");
    assert.equal(read(["Subject: =?UTF-8?B?not base64 at all!?= and =?nope?Q?x?=", "", ""]).subject.includes("and"), true);
    // Parts nested deeper than anything real.
    const deep = Array.from({ length: 60 }, (_value, level) => [`Content-Type: multipart/mixed; boundary=b${level}`, "", `--b${level}`]).flat();
    assert.doesNotThrow(() => read([...deep, "Content-Type: text/plain", "", "deep"]));
  });
});
