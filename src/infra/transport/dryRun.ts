import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OutboundMessage, OutboundTransport, SendResult } from "./types";

/**
 * The default outbound transport: writes a real RFC 5322 message to disk and
 * reports success, without delivering anything.
 *
 * Deliberately full-fidelity — the same headers, encoding and threading a real
 * send would produce — so the only difference between a dry run and a live run
 * is whether an SMTP socket is opened. An operator can read `outbox/` and see
 * exactly what their prospects would have received.
 */
export class DryRunTransport implements OutboundTransport {
  readonly name = "dry-run";
  readonly live = false;

  constructor(private readonly dir = process.env.OUTBOX_DIR ?? "outbox") {}

  async verify(): Promise<{ ok: boolean; detail: string }> {
    await mkdir(this.dir, { recursive: true });
    return { ok: true, detail: `Dry run — messages are written to ./${this.dir}, nothing is delivered.` };
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const messageId = `<${randomUUID()}@rainmaker.local>`;
    const headers = [
      `Message-ID: ${messageId}`,
      `Date: ${new Date().toUTCString()}`,
      `From: ${formatAddress(message.fromName, message.from)}`,
      `To: ${formatAddress(message.toName, message.to)}`,
      message.replyTo ? `Reply-To: ${message.replyTo}` : null,
      `Subject: ${message.subject}`,
      message.inReplyTo ? `In-Reply-To: ${message.inReplyTo}` : null,
      message.references?.length ? `References: ${message.references.join(" ")}` : null,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "X-Rainmaker-Transport: dry-run",
    ].filter(Boolean);

    const eml = `${headers.join("\r\n")}\r\n\r\n${message.body.replace(/\n/g, "\r\n")}\r\n`;

    try {
      await mkdir(this.dir, { recursive: true });
      const safe = message.to.replace(/[^a-z0-9.@_-]/gi, "_");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await writeFile(join(this.dir, `${stamp}__${safe}.eml`), eml, "utf8");
      return { ok: true, messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function formatAddress(name: string | undefined, email: string): string {
  if (!name) return email;
  // Quote per RFC 5322 if the display name contains specials.
  const needsQuote = /[(),.:;<>@[\]\\"]/.test(name);
  const display = needsQuote ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
  return `${display} <${email}>`;
}
