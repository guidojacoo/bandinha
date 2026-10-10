import { DryRunTransport } from "./dryRun";
import { ImapInbound } from "./imap";
import { MaildirInbound } from "./maildir";
import { SmtpTransport } from "./smtp";
import type { InboundTransport, OutboundTransport } from "./types";

export * from "./types";
export { DryRunTransport } from "./dryRun";
export { SmtpTransport } from "./smtp";
export { MaildirInbound } from "./maildir";
export { ImapInbound } from "./imap";

/**
 * Picks transports from configuration.
 *
 * Live sending requires two independent things to be true: SMTP credentials
 * exist *and* the operator set `SEND_MODE=live`. Credentials alone are not
 * consent — someone configuring their mailbox to test deliverability should
 * not thereby start mailing strangers.
 */
export function outboundFromEnv(env = process.env): OutboundTransport {
  const wantsLive = env.SEND_MODE === "live";
  if (wantsLive && SmtpTransport.isConfigured(env)) return new SmtpTransport();
  return new DryRunTransport();
}

export function inboundFromEnv(env = process.env): InboundTransport {
  if (env.SEND_MODE === "live" && ImapInbound.isConfigured(env)) return new ImapInbound();
  return new MaildirInbound();
}

/** Human-readable description of why the chosen mode is in force. */
export function transportStatus(env = process.env): string {
  if (env.SEND_MODE !== "live") {
    return "SEND_MODE is not 'live' — messages are written to ./outbox and nobody is contacted.";
  }
  if (!SmtpTransport.isConfigured(env)) {
    return "SEND_MODE=live but SMTP is not configured — falling back to dry run.";
  }
  return "LIVE — messages are delivered to real recipients over SMTP.";
}
