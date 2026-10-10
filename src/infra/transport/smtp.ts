import nodemailer, { type Transporter } from "nodemailer";
import type { OutgoingMessage, SendOutcome, Transport } from "./types";

/**
 * Real sending, through the operator's own SMTP server.
 *
 * Their server, their domain, their reputation, their legal responsibility as
 * the sender — which is the only arrangement that is both free and lawful. A
 * shared sending domain would be cheaper to build and would be burnt inside a
 * week by whoever used it least carefully.
 *
 * Status: untested. No SMTP server was reachable from the sandbox this was
 * written in, so the configuration path and the nodemailer call are complete
 * but unproven. `npm run doctor` verifies the connection before the first
 * send, which is the right place to find out.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
}

export function smtpConfigFromEnv(): SmtpConfig | null {
  const host = (process.env.SMTP_HOST ?? "").trim();
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? 587);
  return {
    host,
    port,
    // Implicit TLS on 465, STARTTLS on 587. Getting this backwards is the
    // single most common SMTP misconfiguration.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
    user: (process.env.SMTP_USER ?? "").trim() || undefined,
    pass: process.env.SMTP_PASS ?? undefined,
  };
}

export class SmtpTransport implements Transport {
  readonly name = "smtp";
  readonly live = true;
  private transporter: Transporter | null = null;

  constructor(private readonly config: SmtpConfig) {}

  describe(): string {
    return `Live sending through ${this.config.host}:${this.config.port}${this.config.secure ? " (TLS)" : " (STARTTLS)"}.`;
  }

  private client(): Transporter {
    this.transporter ??= nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: this.config.user ? { user: this.config.user, pass: this.config.pass } : undefined,
      // One connection, messages sent one at a time. Blasting a hundred
      // parallel connections is what gets a new sending domain rate-limited
      // by the receiving side on its first day.
      pool: true,
      maxConnections: 1,
      maxMessages: 50,
      connectionTimeout: Number(process.env.SMTP_TIMEOUT_MS ?? 20_000),
    });
    return this.transporter;
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.client().verify();
      return { ok: true, detail: `Connected to ${this.config.host}:${this.config.port}.` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    const optOut = message.optOutUrl ?? message.sender.unsubscribeUrl;
    try {
      const info = await this.client().sendMail({
        from: { name: message.sender.fromName, address: message.sender.fromEmail },
        to: message.to,
        replyTo: message.sender.replyTo ?? message.sender.fromEmail,
        subject: message.subject,
        text: message.body,
        inReplyTo: message.inReplyTo,
        references: message.references,
        headers: optOut
          ? {
              // Required by Gmail and Yahoo's bulk-sender rules since 2024.
              // Per-recipient, because a one-click POST to a shared URL
              // cannot identify who sent it.
              "List-Unsubscribe": `<${optOut}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }
          : undefined,
      });
      return { ok: true, messageId: info.messageId, via: `${this.config.host}:${this.config.port}` };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        via: `${this.config.host}:${this.config.port}`,
      };
    }
  }
}
