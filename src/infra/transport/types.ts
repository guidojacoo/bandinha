export interface OutboundMessage {
  to: string;
  toName?: string;
  from: string;
  fromName: string;
  replyTo?: string;
  subject: string;
  body: string;
  /** RFC 5322 threading headers. */
  inReplyTo?: string;
  references?: string[];
}

export interface SendResult {
  ok: boolean;
  /** The Message-ID assigned, so replies can be threaded back. */
  messageId?: string;
  error?: string;
}

/**
 * Where outbound mail goes.
 *
 * `live` is the single most important flag in this codebase: it is the
 * difference between a simulation and a message arriving in a stranger's
 * inbox. Everything upstream behaves identically either way, so the agent can
 * be exercised in full without anyone being contacted.
 */
export interface OutboundTransport {
  readonly name: string;
  /** True when this transport delivers to real recipients. */
  readonly live: boolean;
  send(message: OutboundMessage): Promise<SendResult>;
  /** Pre-flight check, surfaced in the dashboard before arming live sending. */
  verify(): Promise<{ ok: boolean; detail: string }>;
}

export interface InboundMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId?: string;
  inReplyTo?: string;
  receivedAt: Date;
}

export interface InboundTransport {
  readonly name: string;
  readonly live: boolean;
  /** Returns messages received since the given instant. */
  fetchNew(since?: Date): Promise<InboundMessage[]>;
  verify(): Promise<{ ok: boolean; detail: string }>;
}
