import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";
import type { InboundMessage, InboundTransport } from "./types";

/**
 * Directory-backed inbound mail.
 *
 * Reads RFC 5322 files out of `inbox/`, hands them to the agent, and moves
 * them to `inbox/processed/` so they are never handled twice. This is the
 * counterpart to the dry-run outbox and makes the whole reply path testable:
 * the buyer simulator writes here, and so can a human dropping in a real
 * `.eml` to see how the agent would have answered it.
 */
export class MaildirInbound implements InboundTransport {
  readonly name = "maildir";
  readonly live = false;

  constructor(private readonly dir = process.env.INBOX_DIR ?? "inbox") {}

  async verify(): Promise<{ ok: boolean; detail: string }> {
    await mkdir(join(this.dir, "processed"), { recursive: true });
    return { ok: true, detail: `Reading replies from ./${this.dir}.` };
  }

  async fetchNew(): Promise<InboundMessage[]> {
    await mkdir(join(this.dir, "processed"), { recursive: true });

    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith(".eml"));
    } catch {
      return [];
    }

    const out: InboundMessage[] = [];
    for (const name of names.sort()) {
      const path = join(this.dir, name);
      try {
        const raw = await readFile(path);
        const parsed = await simpleParser(raw);
        out.push({
          from: firstAddress(parsed.from?.value),
          to: firstAddress(parsed.to && "value" in parsed.to ? parsed.to.value : undefined),
          subject: parsed.subject ?? "",
          body: parsed.text ?? stripHtml(parsed.html || ""),
          messageId: parsed.messageId ?? undefined,
          inReplyTo: parsed.inReplyTo ?? undefined,
          receivedAt: parsed.date ?? new Date(),
        });
      } catch {
        // A malformed file must not wedge the inbox forever.
      }
      // Move it regardless of parse outcome so the loop always makes progress.
      await rename(path, join(this.dir, "processed", name)).catch(() => {});
    }
    return out;
  }

  /** Used by the buyer simulator and by tests to inject a reply. */
  async deliver(message: {
    from: string;
    to: string;
    subject: string;
    body: string;
    inReplyTo?: string;
  }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const headers = [
      `Message-ID: <${randomUUID()}@simulated.local>`,
      `Date: ${new Date().toUTCString()}`,
      `From: ${message.from}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      message.inReplyTo ? `In-Reply-To: ${message.inReplyTo}` : null,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
    ].filter(Boolean);
    const eml = `${headers.join("\r\n")}\r\n\r\n${message.body.replace(/\n/g, "\r\n")}\r\n`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await writeFile(join(this.dir, `${stamp}__${randomUUID().slice(0, 8)}.eml`), eml, "utf8");
  }
}

function firstAddress(value: Array<{ address?: string }> | undefined): string {
  return value?.[0]?.address?.toLowerCase() ?? "";
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
