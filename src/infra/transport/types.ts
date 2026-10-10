import type { SenderIdentity } from "../../core/types";

export interface OutgoingMessage {
  to: string;
  subject: string;
  body: string;
  sender: SenderIdentity;
  /**
   * The per-recipient opt-out link, for the `List-Unsubscribe` header.
   *
   * Separate from the body's footer so the header and the footer cannot drift
   * apart, and per-recipient because a one-click POST to a shared URL cannot
   * identify who sent it.
   */
  optOutUrl?: string;
  /** RFC 5322 Message-ID of the message this answers. */
  inReplyTo?: string;
  references?: string[];
}

export interface SendOutcome {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** Where it went: a file, an SMTP server, nowhere. */
  via: string;
}

export interface Transport {
  readonly name: string;
  /** False when this transport cannot reach a real mailbox. */
  readonly live: boolean;
  describe(): string;
  send(message: OutgoingMessage): Promise<SendOutcome>;
  verify(): Promise<{ ok: boolean; detail: string }>;
}

export interface IncomingMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId?: string;
  inReplyTo?: string;
  receivedAt: Date;
}

export interface Inbox {
  readonly name: string;
  describe(): string;
  /** Unread replies, oldest first. Implementations mark them read. */
  fetch(limit: number): Promise<IncomingMessage[]>;
  verify(): Promise<{ ok: boolean; detail: string }>;
}
