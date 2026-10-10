import type {
  ComplianceConfig,
  ComplianceDecision,
  SenderIdentity,
  SendAttempt,
} from "./types";

/**
 * The compliance gate.
 *
 * Every outbound message passes through `evaluateSend` and nothing in the
 * codebase has a path around it. This is not decoration: unsolicited bulk mail
 * to harvested addresses is illegal under CAN-SPAM §7704, the GDPR, and
 * Argentina's Ley 25.326, and — just as fatally for the goal of selling
 * anything — it burns the sending domain's reputation within hours, after
 * which even the wanted mail stops arriving.
 *
 * Pure and synchronous: the caller supplies the counters, so the rules can be
 * tested exhaustively without a database.
 */

const ROLE_PREFIXES = new Set([
  "info", "hello", "contact", "sales", "support", "admin", "office",
  "team", "help", "enquiries", "inquiries", "mail", "hi",
]);

/** Addresses nobody should ever be cold-mailed at. */
const NEVER_CONTACT_PREFIXES = new Set([
  "abuse", "postmaster", "privacy", "security", "legal", "dpo",
  "noreply", "no-reply", "donotreply", "unsubscribe", "bounce", "mailer-daemon",
]);

export function isValidEmail(email: string): boolean {
  const e = email.trim();
  if (e.length === 0 || e.length > 254) return false;
  // Deliberately strict rather than RFC-complete: anything exotic enough to
  // need the full grammar is not an address we should be cold-mailing.
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(e);
}

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export function localPartOf(email: string): string {
  return email.trim().toLowerCase().split("@")[0] ?? "";
}

export function isRoleInbox(email: string): boolean {
  return ROLE_PREFIXES.has(localPartOf(email));
}

export function isNeverContact(email: string): boolean {
  const local = localPartOf(email);
  if (NEVER_CONTACT_PREFIXES.has(local)) return true;
  // abuse+anything@, security-reports@, etc.
  return [...NEVER_CONTACT_PREFIXES].some(
    (p) => local.startsWith(`${p}+`) || local.startsWith(`${p}-`),
  );
}

export function senderIdentityProblems(sender: SenderIdentity): string[] {
  const problems: string[] = [];
  if (!sender.fromName?.trim()) problems.push("fromName is empty");
  if (!isValidEmail(sender.fromEmail ?? "")) problems.push("fromEmail is not a valid address");
  // CAN-SPAM §7704(a)(5): commercial mail must carry a valid physical address.
  if (!sender.postalAddress?.trim() || sender.postalAddress.trim().length < 10) {
    problems.push("postalAddress is required and must be a real postal address");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Send window
// ---------------------------------------------------------------------------

/** The sending locale's wall clock for an instant. */
export function localParts(now: Date, offsetMinutes: number): { day: number; hour: number } {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  return { day: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

export function isInsideWindow(now: Date, config: ComplianceConfig): boolean {
  const { day, hour } = localParts(now, config.timezoneOffsetMinutes);
  if (!config.sendDays.includes(day)) return false;
  return hour >= config.sendWindowStartHour && hour < config.sendWindowEndHour;
}

/**
 * The next instant at which sending becomes permitted.
 *
 * Walks forward hour by hour rather than doing calendar arithmetic — the
 * search space is at most a week and this cannot get month boundaries,
 * leap days or offset wrapping wrong.
 */
export function nextWindowOpening(now: Date, config: ComplianceConfig): Date {
  if (config.sendDays.length === 0) {
    // Nothing is ever allowed; surface that as a far-future time.
    return new Date(now.getTime() + 365 * 24 * 3600_000);
  }
  const cursor = new Date(now.getTime());
  cursor.setUTCMinutes(0, 0, 0);
  for (let i = 0; i <= 24 * 8; i++) {
    cursor.setTime(cursor.getTime() + 3600_000);
    if (isInsideWindow(cursor, config)) return cursor;
  }
  return new Date(now.getTime() + 24 * 3600_000);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export function evaluateSend(
  attempt: SendAttempt,
  config: ComplianceConfig,
): ComplianceDecision {
  // 1. We must be a lawful, identifiable sender before anything else matters.
  const identityProblems = senderIdentityProblems(config.sender);
  if (identityProblems.length > 0) {
    return {
      allowed: false,
      code: "missing_sender_identity",
      reason: `Sender identity is incomplete: ${identityProblems.join("; ")}.`,
    };
  }

  const email = attempt.toEmail.trim().toLowerCase();

  // 2. Is this even a deliverable, contactable address?
  if (!isValidEmail(email)) {
    return { allowed: false, code: "invalid_recipient", reason: `"${attempt.toEmail}" is not a valid email address.` };
  }
  if (isNeverContact(email)) {
    return {
      allowed: false,
      code: "invalid_recipient",
      reason: `${email} is an abuse/security/no-reply address and must never receive outreach.`,
    };
  }

  // 3. Explicit opt-outs outrank every other consideration, including caps.
  if (attempt.suppressed) {
    return {
      allowed: false,
      code: "suppressed",
      reason: `${email} is on the suppression list (${attempt.suppressionReason ?? "unknown reason"}).`,
    };
  }

  const domain = domainOf(email);
  if (config.blockedDomains.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`))) {
    return { allowed: false, code: "blocked_domain", reason: `${domain} is on the blocked-domain list.` };
  }

  // 4. Frequency: do not pester.
  //
  //    Skipped for replies. Suppression, blocked domains and sender identity
  //    above still apply — those are about consent and legality, which a
  //    reply does not override. These are about cold-outreach cadence, which
  //    a reply is not.
  if (attempt.lastTouchedAt && !attempt.isReply) {
    const hoursSince = (attempt.now.getTime() - attempt.lastTouchedAt.getTime()) / 3600_000;
    if (hoursSince < config.minHoursBetweenTouches) {
      const retryAt = new Date(
        attempt.lastTouchedAt.getTime() + config.minHoursBetweenTouches * 3600_000,
      );
      return {
        allowed: false,
        code: "too_soon",
        reason: `Last contacted ${hoursSince.toFixed(1)}h ago; the minimum gap is ${config.minHoursBetweenTouches}h.`,
        retryAt,
      };
    }
  }

  // 5. Volume: protect the sending domain's reputation.
  if (attempt.sentToday >= config.dailySendCap) {
    return {
      allowed: false,
      code: "daily_cap",
      reason: `Daily send cap of ${config.dailySendCap} already reached.`,
      retryAt: nextUtcMidnight(attempt.now),
    };
  }
  if (!attempt.isReply && attempt.sentTodayToDomain >= config.perDomainDailyCap) {
    return {
      allowed: false,
      code: "domain_cap",
      reason: `Already sent ${attempt.sentTodayToDomain} message(s) to ${domain} today (cap ${config.perDomainDailyCap}).`,
      retryAt: nextUtcMidnight(attempt.now),
    };
  }

  // 6. Timing: business hours only.
  if (!isInsideWindow(attempt.now, config)) {
    return {
      allowed: false,
      code: "outside_window",
      reason: "Outside the configured sending window.",
      retryAt: nextWindowOpening(attempt.now, config),
    };
  }

  return { allowed: true };
}

export function nextUtcMidnight(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

// ---------------------------------------------------------------------------
// Required message furniture
// ---------------------------------------------------------------------------

/**
 * The footer every commercial message must carry: who sent it, a real postal
 * address, and a working way out. Appended by the composer, verified by
 * `validateDraft` — a message cannot reach a transport without it.
 */
export function buildFooter(sender: SenderIdentity): string {
  const lines = [
    `${sender.fromName} · ${sender.postalAddress}`,
    sender.unsubscribeUrl
      ? `Not relevant? Unsubscribe: ${sender.unsubscribeUrl}`
      : `Not relevant? Reply "unsubscribe" and I will remove you immediately.`,
  ];
  return lines.join("\n");
}

export function hasOptOut(body: string): boolean {
  return /unsubscribe|opt[- ]?out|remove me|stop receiving/i.test(body);
}
