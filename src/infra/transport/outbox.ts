import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Inbox, IncomingMessage, OutgoingMessage, SendOutcome, Transport } from "./types";

/**
 * The default transport: mail written to disk, not sent.
 *
 * This is not a stub, it is the safe default, and it stays the default until
 * the operator explicitly arms live sending. Unsolicited bulk mail to
 * harvested addresses is unlawful in most of the world — CAN-SPAM §7704,
 * GDPR Art. 6, Ley 25.326 — and it destroys sending reputation. An agent that
 * mails strangers the moment it is installed is a liability, so the first run
 * produces a directory of .eml files the operator can read, forward, or
 * delete.
 *
 * Everything downstream of `send` is identical in both modes: the same
 * compliance gate, the same provenance check, the same cadence. A dry run is
 * a complete rehearsal of the real thing.
 */

const OUTBOX = process.env.OUTBOX_DIR ?? "./outbox";
const INBOX = process.env.INBOX_DIR ?? "./inbox";

export class OutboxTransport implements Transport {
  readonly name = "outbox";
  readonly live = false;

  constructor(private readonly dir: string = OUTBOX) {}

  describe(): string {
    return `Dry run: messages are written to ${this.dir} as .eml files and nothing is sent.`;
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      await mkdir(this.dir, { recursive: true });
      return { ok: true, detail: `Writing to ${this.dir}.` };
    } catch (error) {
      return { ok: false, detail: `Cannot write to ${this.dir}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    try {
      await mkdir(this.dir, { recursive: true });
      const messageId = `<${randomUUID()}@${domainOf(message.sender.fromEmail)}>`;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = join(this.dir, `${stamp}__${safeName(message.to)}.eml`);
      await writeFile(file, renderEml(message, messageId), "utf8");
      return { ok: true, messageId, via: file };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), via: this.dir };
    }
  }
}

/**
 * Replies read from a directory of .eml files.
 *
 * The counterpart to the outbox: it closes the loop without a mail server, so
 * the whole conversation engine — classification, objection handling, stage
 * transitions — can be exercised end to end on a laptop with no network. The
 * fixtures use it to play the part of prospects.
 */
export class OutboxInbox implements Inbox {
  readonly name = "inbox-dir";

  constructor(private readonly dir: string = INBOX) {}

  describe(): string {
    return `Reads replies from .eml files dropped in ${this.dir}.`;
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      await mkdir(this.dir, { recursive: true });
      const files = (await readdir(this.dir)).filter((f) => f.endsWith(".eml"));
      return { ok: true, detail: `${files.length} unread file(s) in ${this.dir}.` };
    } catch (error) {
      return { ok: false, detail: `Cannot read ${this.dir}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async fetch(limit: number): Promise<IncomingMessage[]> {
    await mkdir(this.dir, { recursive: true });
    const processed = join(this.dir, "processed");
    await mkdir(processed, { recursive: true });

    const files = (await readdir(this.dir)).filter((f) => f.endsWith(".eml")).sort();
    const messages: IncomingMessage[] = [];

    for (const file of files.slice(0, limit)) {
      const path = join(this.dir, file);
      try {
        const parsed = parseEml(await readFile(path, "utf8"));
        if (parsed) messages.push(parsed);
      } catch { /* an unreadable file is skipped, not fatal */ }
      // Moved rather than deleted: a misread reply is then recoverable, and
      // the alternative — leaving it — reprocesses it on every tick, which
      // once had the agent answer the same message forty times.
      await rename(path, join(processed, file)).catch(() => {});
    }
    return messages;
  }
}

/** The per-recipient link if there is one, else whatever the operator set. */
function optOut(message: OutgoingMessage): string | undefined {
  return message.optOutUrl ?? message.sender.unsubscribeUrl;
}

export function renderEml(message: OutgoingMessage, messageId: string): string {
  const headers = [
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `From: ${encodeName(message.sender.fromName)} <${message.sender.fromEmail}>`,
    `To: ${message.to}`,
    message.sender.replyTo ? `Reply-To: ${message.sender.replyTo}` : "",
    `Subject: ${encodeHeader(message.subject)}`,
    message.inReplyTo ? `In-Reply-To: ${message.inReplyTo}` : "",
    message.references?.length ? `References: ${message.references.join(" ")}` : "",
    // One-click unsubscribe, as required by bulk-sender rules at Gmail and
    // Yahoo since 2024. Without it, mail to either is throttled or binned —
    // and a header that advertises one-click and then 404s is worse than no
    // header at all, so it is only emitted when there is a link to emit.
    optOut(message) ? `List-Unsubscribe: <${optOut(message)}>` : "",
    optOut(message) ? "List-Unsubscribe-Post: List-Unsubscribe=One-Click" : "",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);

  return `${headers.join("\r\n")}\r\n\r\n${message.body.replace(/\r?\n/g, "\r\n")}\r\n`;
}

/**
 * Minimal RFC 5322 reader.
 *
 * It does not simply split on the first blank line. A message whose blank
 * line is missing — a mailer that dropped it, or a generator with an
 * over-eager filter — would otherwise have its first paragraph parsed as
 * headers and silently lost. That happened: every reply in the fixture run
 * came back as "unclear" because the sentence the prospect actually wrote had
 * been eaten by the header block. So headers end at the first line that is
 * neither `Name: value` nor a folded continuation, blank line or not.
 */
export function parseEml(raw: string): IncomingMessage | null {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  const headerLines: string[] = [];
  let bodyStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      bodyStart = i + 1;
      break;
    }
    if (/^[ \t]/.test(line) && headerLines.length > 0) {
      // A folded continuation of the previous header.
      headerLines[headerLines.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9-]*:/.test(line)) {
      bodyStart = i;
      break;
    }
    headerLines.push(line);
  }

  const body = lines.slice(bodyStart).join("\n");

  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }

  const from = extractAddress(headers.get("from") ?? "");
  if (!from) return null;

  const dateHeader = headers.get("date");
  const parsedDate = dateHeader ? new Date(dateHeader) : new Date();

  return {
    from,
    to: extractAddress(headers.get("to") ?? "") ?? "",
    subject: headers.get("subject") ?? "",
    body: body.trim(),
    messageId: headers.get("message-id"),
    inReplyTo: headers.get("in-reply-to"),
    receivedAt: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
  };
}

export function extractAddress(value: string): string | null {
  const angled = value.match(/<([^>]+)>/);
  const candidate = (angled?.[1] ?? value).trim().toLowerCase();
  return candidate.includes("@") ? candidate.replace(/^.*?([^\s<]+@[^\s>]+).*$/, "$1") : null;
}

function encodeName(name: string): string {
  return /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/"/g, "")}"` : encodeHeader(name);
}

/** RFC 2047 for non-ASCII headers, so accented names survive. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function domainOf(email: string): string {
  return email.split("@")[1] ?? "localhost";
}

function safeName(email: string): string {
  return email.replace(/[^a-z0-9._@-]/gi, "_").slice(0, 60);
}
