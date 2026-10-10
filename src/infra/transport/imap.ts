import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Inbox, IncomingMessage } from "./types";

/**
 * Replies read from the operator's own mailbox over IMAP.
 *
 * The loop has to close somewhere: an agent that sends and never reads is a
 * mail merge. Reading the same inbox the mail was sent from means bounces,
 * out-of-office notices and real replies all arrive through one path, which
 * is what the classifier in `core/classify.ts` expects.
 *
 * Status: untested. No IMAP server was reachable from the sandbox this was
 * written in. `npm run doctor` checks the connection before a run.
 */

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox: string;
}

export function imapConfigFromEnv(): ImapConfig | null {
  const host = (process.env.IMAP_HOST ?? "").trim();
  const user = (process.env.IMAP_USER ?? "").trim();
  const pass = process.env.IMAP_PASS ?? "";
  if (!host || !user || !pass) return null;
  const port = Number(process.env.IMAP_PORT ?? 993);
  return {
    host,
    port,
    secure: process.env.IMAP_SECURE ? process.env.IMAP_SECURE === "true" : port === 993,
    user,
    pass,
    mailbox: (process.env.IMAP_MAILBOX ?? "INBOX").trim(),
  };
}

export class ImapInbox implements Inbox {
  readonly name = "imap";

  constructor(private readonly config: ImapConfig) {}

  describe(): string {
    return `Reads unseen mail from ${this.config.mailbox} on ${this.config.host}.`;
  }

  private connect(): ImapFlow {
    return new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
    });
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    const client = this.connect();
    try {
      await client.connect();
      const mailbox = await client.mailboxOpen(this.config.mailbox, { readOnly: true });
      return { ok: true, detail: `${this.config.mailbox} has ${mailbox.exists} message(s).` };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async fetch(limit: number): Promise<IncomingMessage[]> {
    const client = this.connect();
    const messages: IncomingMessage[] = [];

    try {
      await client.connect();
      const lock = await client.getMailboxLock(this.config.mailbox);
      try {
        const unseen = await client.search({ seen: false });
        const uids = (unseen || []).slice(-limit);
        if (uids.length === 0) return [];

        for await (const row of client.fetch(uids, { source: true, uid: true })) {
          if (!row.source) continue;
          const parsed = await simpleParser(row.source);
          const from = parsed.from?.value?.[0]?.address;
          if (!from) continue;

          messages.push({
            from: from.toLowerCase(),
            to: addressOf(parsed.to),
            subject: parsed.subject ?? "",
            // Prefer plain text: an HTML-only reply is converted rather than
            // classified as markup, which read as "unclear" every time.
            body: (parsed.text ?? htmlToText(parsed.html)).trim(),
            messageId: parsed.messageId,
            inReplyTo: parsed.inReplyTo,
            receivedAt: parsed.date ?? new Date(),
          });

          // Marked seen only after it parsed. A message that cannot be read
          // stays unread, so a parser bug does not silently drop a reply
          // from somebody asking to be left alone.
          await client.messageFlagsAdd({ uid: String(row.uid) }, ["\\Seen"], { uid: true }).catch(() => {});
        }
      } finally {
        lock.release();
      }
    } catch {
      // A mailbox that cannot be read is a degraded tick, not a crash: the
      // agent should still send what it has queued.
      return messages;
    } finally {
      await client.logout().catch(() => {});
    }
    return messages;
  }
}

function addressOf(field: unknown): string {
  if (!field) return "";
  const first = Array.isArray(field) ? field[0] : field;
  const value = (first as { value?: Array<{ address?: string }> })?.value?.[0]?.address;
  return (value ?? "").toLowerCase();
}

function htmlToText(html: string | false | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
