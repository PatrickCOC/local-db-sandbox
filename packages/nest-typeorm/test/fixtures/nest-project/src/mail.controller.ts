import { Body, Controller, Get, OnApplicationBootstrap, Post, Query } from "@nestjs/common";
import { connect } from "node:net";

/**
 * Sends mail the way an application does: with Nodemailer, to the SMTP server
 * that its own settings name. The settings are environment variables of the
 * application's own choosing (`MAIL_HOST`, `MAIL_PORT`).
 */
@Controller("mail")
export class MailController implements OnApplicationBootstrap {
  private async send(to: string | string[], subject: string): Promise<string> {
    // Loaded when mail is sent, so that a project that sends none does not need the package.
    const loaded: any = await import("nodemailer");
    const transport = (loaded.default ?? loaded).createTransport({ host: process.env.MAIL_HOST, port: Number(process.env.MAIL_PORT), secure: false });
    try {
      return (await transport.sendMail({ from: "app@example.com", to, subject, text: `Sent by the application to ${String(to)}.` })).response;
    } finally {
      transport.close();
    }
  }

  /** Mail that no request asks for: sent when the application has started, if it is told to. */
  async onApplicationBootstrap(): Promise<void> {
    if (process.env.MAIL_ON_START === "1") {
      await this.send("ops@example.com", "Application started");
    }
  }

  @Get("settings")
  settings(): { host: string | null; port: string | null } {
    return { host: process.env.MAIL_HOST ?? null, port: process.env.MAIL_PORT ?? null };
  }

  @Post()
  async post(@Body() body: { to: string | string[]; subject: string }): Promise<{ response: string }> {
    return { response: await this.send(body.to, body.subject) };
  }

  /** Opens a TCP connection, as a client of some other service would, and says how that went. */
  @Get("reach")
  reach(@Query("host") host: string, @Query("port") port: string): Promise<{ connected: boolean; code?: string }> {
    return new Promise((resolve) => {
      const socket = connect({ host, port: Number(port) });
      socket.once("connect", () => {
        socket.destroy();
        resolve({ connected: true });
      });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve({ connected: false, code: error.code }));
    });
  }
}
