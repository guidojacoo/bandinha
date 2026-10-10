export * from "./types";
export { OutboxTransport, OutboxInbox, renderEml, parseEml, extractAddress } from "./outbox";
export { SmtpTransport, smtpConfigFromEnv, type SmtpConfig } from "./smtp";
export { ImapInbox, imapConfigFromEnv, type ImapConfig } from "./imap";

import { OutboxInbox, OutboxTransport } from "./outbox";
import { SmtpTransport, smtpConfigFromEnv } from "./smtp";
import { ImapInbox, imapConfigFromEnv } from "./imap";
import type { Inbox, Transport } from "./types";

/**
 * Picks the transport for a campaign.
 *
 * Two conditions, both required, before anything reaches a real person: SMTP
 * must be configured *and* the campaign must have live sending armed. Either
 * one alone gives a dry run. Defaulting to live if SMTP happened to be
 * configured would mean a stray environment variable mails three hundred
 * strangers.
 */
export function createTransport(options: { liveSending: boolean }): Transport {
  const smtp = smtpConfigFromEnv();
  if (!options.liveSending || !smtp) return new OutboxTransport();
  return new SmtpTransport(smtp);
}

export function createInbox(): Inbox {
  const imap = imapConfigFromEnv();
  return imap ? new ImapInbox(imap) : new OutboxInbox();
}

/** For the console and the doctor: what would happen if we sent right now. */
export function describeMailSetup(liveSending: boolean): {
  transport: string;
  inbox: string;
  live: boolean;
  warning?: string;
} {
  const transport = createTransport({ liveSending });
  const inbox = createInbox();
  const smtp = smtpConfigFromEnv();

  let warning: string | undefined;
  if (liveSending && !smtp) {
    warning = "Live sending is armed but SMTP_HOST is not set, so this is still a dry run.";
  } else if (!liveSending && smtp) {
    warning = "SMTP is configured but live sending is not armed for this campaign — nothing will be sent.";
  }

  return { transport: transport.describe(), inbox: inbox.describe(), live: transport.live, warning };
}
