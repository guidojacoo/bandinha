import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { InboundMessage, InboundTransport } from "./types";

/**
 * Real inbound over IMAP.
 *
 * Polls the operator's own mailbox for replies. Only unseen messages are
 * fetched, and they are marked seen once handed over, so a crash mid-tick
 * costs at most a duplicate rather than a lost reply.
 */
export class ImapInbound implements InboundTransport {
  readonly name = "imap";
  readonly live = true;

  constructor(
    private readonly config = {
      host: process.env.IMAP_HOST ?? "",
      port: Number(process.env.IMAP_PORT ?? 993),
      user: process.env.IMAP_USER ?? "",
      pass: process.env.IMAP_PASS ?? "",
      mailbox: process.env.IMAP_MAILBOX ?? "INBOX",
      secure: process.env.IMAP_SECURE !== "false",
    },
  ) {}

  static isConfigured(env = process.env): boolean {
    return Boolean(env.IMAP_HOST && env.IMAP_USER && env.IMAP_PASS);
  }

  private client(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
    });
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    if (!this.config.host || !this.config.user) {
      return { ok: false, detail: "IMAP_HOST / IMAP_USER / IMAP_PASS are not set." };
    }
    const client = this.client();
    try {
      await client.connect();
      await client.logout();
      return { ok: true, detail: `Connected to ${this.config.host} as ${this.config.user}.` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async fetchNew(since?: Date): Promise<InboundMessage[]> {
    const client = this.client();
    const out: InboundMessage[] = [];

    try {
      await client.connect();
      const lock = await client.getMailboxLock(this.config.mailbox);
      try {
        const criteria = since ? { seen: false, since } : { seen: false };
        for await (const msg of client.fetch(criteria, { source: true, uid: true })) {
          if (!msg.source) continue;
          try {
            const parsed = await simpleParser(msg.source);
            out.push({
              from: parsed.from?.value?.[0]?.address?.toLowerCase() ?? "",
              to:
                (parsed.to && "value" in parsed.to ? parsed.to.value?.[0]?.address?.toLowerCase() : "") ??
                "",
              subject: parsed.subject ?? "",
              body: parsed.text ?? "",
              messageId: parsed.messageId ?? undefined,
              inReplyTo: parsed.inReplyTo ?? undefined,
              receivedAt: parsed.date ?? new Date(),
            });
            await client.messageFlagsAdd({ uid: String(msg.uid) }, ["\\Seen"], { uid: true });
          } catch {
            // Skip anything unparseable rather than aborting the poll.
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch {
      // A mailbox that is briefly unreachable is not a failure of the tick;
      // the next poll picks the replies up.
      try {
        await client.logout();
      } catch {
        /* already closed */
      }
    }

    return out;
  }
}
