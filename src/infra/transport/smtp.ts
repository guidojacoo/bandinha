import nodemailer, { type Transporter } from "nodemailer";
import type { OutboundMessage, OutboundTransport, SendResult } from "./types";

/**
 * Real delivery over the operator's own SMTP server.
 *
 * The operator supplies the mailbox, which is the point: they are the
 * accountable sender on every message, their domain's reputation is the one
 * at stake, and their SPF/DKIM/DMARC records are what make the mail arrive.
 * There is no shared Rainmaker sending infrastructure to hide behind.
 */
export class SmtpTransport implements OutboundTransport {
  readonly name = "smtp";
  readonly live = true;
  private transporter: Transporter | null = null;

  constructor(
    private readonly config = {
      host: process.env.SMTP_HOST ?? "",
      port: Number(process.env.SMTP_PORT ?? 587),
      user: process.env.SMTP_USER ?? "",
      pass: process.env.SMTP_PASS ?? "",
      secure: process.env.SMTP_SECURE === "true",
    },
  ) {}

  static isConfigured(env = process.env): boolean {
    return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
  }

  private get(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure || this.config.port === 465,
        auth: { user: this.config.user, pass: this.config.pass },
        // A background agent should never wedge on a hung server.
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
    }
    return this.transporter;
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    if (!this.config.host || !this.config.user) {
      return { ok: false, detail: "SMTP_HOST / SMTP_USER / SMTP_PASS are not set." };
    }
    try {
      await this.get().verify();
      return { ok: true, detail: `Connected to ${this.config.host}:${this.config.port} as ${this.config.user}.` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const info = await this.get().sendMail({
        from: { name: message.fromName, address: message.from },
        to: message.toName ? { name: message.toName, address: message.to } : message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.body,
        inReplyTo: message.inReplyTo,
        references: message.references,
        headers: {
          // Honoured by Gmail and Outlook; makes opting out one click.
          ...(extractUnsubscribeUrl(message.body)
            ? {
                "List-Unsubscribe": `<${extractUnsubscribeUrl(message.body)}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : {}),
        },
      });
      return { ok: true, messageId: info.messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function extractUnsubscribeUrl(body: string): string | null {
  const m = /unsubscribe:?\s*(https?:\/\/\S+)/i.exec(body);
  return m?.[1]?.replace(/[.,)]$/, "") ?? null;
}
