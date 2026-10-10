import { domainOf, isNeverContact, isValidSyntax, mayContact } from "./deliverability";
import type { ComplianceConfig, ComplianceDecision, SenderIdentity, SendAttempt } from "./types";

/**
 * The send gate.
 *
 * Every outbound message passes `evaluateSend` and nothing in the codebase
 * has a path around it. Unsolicited bulk mail to harvested addresses is
 * unlawful under CAN-SPAM §7704, the GDPR and Argentina's Ley 25.326 — and,
 * just as fatally for the goal of selling anything, it burns the sending
 * domain within hours, after which even the wanted mail stops arriving.
 *
 * Pure and synchronous: the caller supplies the counters, so the rules can be
 * tested exhaustively without a database.
 */

export function senderIdentityProblems(sender: SenderIdentity): string[] {
  const problems: string[] = [];
  if (!sender?.fromName?.trim()) problems.push("fromName is empty");
  if (!isValidSyntax(sender?.fromEmail ?? "")) problems.push("fromEmail is not a valid address");
  // CAN-SPAM §7704(a)(5): commercial mail must carry a valid physical address.
  if (!sender?.postalAddress?.trim() || sender.postalAddress.trim().length < 10) {
    problems.push("postalAddress is required and must be a real postal address");
  }
  return problems;
}

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
 * The next instant sending is permitted.
 *
 * Walks forward hour by hour rather than doing calendar arithmetic — the
 * search space is a week at most, and this cannot get month boundaries,
 * leap days or offset wrapping wrong.
 */
export function nextWindowOpening(now: Date, config: ComplianceConfig): Date {
  if (config.sendDays.length === 0) return new Date(now.getTime() + 365 * 86_400_000);
  const cursor = new Date(now.getTime());
  cursor.setUTCMinutes(0, 0, 0);
  for (let i = 0; i <= 24 * 8; i++) {
    cursor.setTime(cursor.getTime() + 3_600_000);
    if (isInsideWindow(cursor, config)) return cursor;
  }
  return new Date(now.getTime() + 86_400_000);
}

export function nextUtcMidnight(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

export function evaluateSend(attempt: SendAttempt, config: ComplianceConfig): ComplianceDecision {
  // 1. We must be a lawful, identifiable sender before anything else matters.
  const identity = senderIdentityProblems(config.sender);
  if (identity.length > 0) {
    return { allowed: false, code: "missing_sender_identity", reason: `Sender identity is incomplete: ${identity.join("; ")}.` };
  }

  const email = attempt.toEmail.trim().toLowerCase();

  // 2. Is this a deliverable, contactable address at all?
  if (!isValidSyntax(email)) {
    return { allowed: false, code: "invalid_recipient", reason: `"${attempt.toEmail}" is not a valid email address.` };
  }
  if (isNeverContact(email)) {
    return { allowed: false, code: "invalid_recipient", reason: `${email} is an abuse, security or wrong-department address.` };
  }
  if (!mayContact(attempt.deliverability)) {
    return {
      allowed: false, code: "undeliverable",
      reason: attempt.deliverability
        ? `Pre-flight says undeliverable: ${attempt.deliverability.detail}`
        : "No deliverability pre-flight was run for this address.",
    };
  }

  // 3. Explicit opt-outs outrank everything, including caps and windows.
  if (attempt.suppressed) {
    return { allowed: false, code: "suppressed", reason: `${email} is suppressed (${attempt.suppressionReason ?? "unknown reason"}).` };
  }

  const domain = domainOf(email);
  if (config.blockedDomains.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`))) {
    return { allowed: false, code: "blocked_domain", reason: `${domain} is on the blocked-domain list.` };
  }

  // 4. Frequency and 5. volume are cold-cadence protections, so a reply is
  //    exempt. A prospect who asks a question at 10am must not be met with
  //    48 hours of silence because of an anti-pester throttle.
  if (attempt.lastTouchedAt && !attempt.isReply) {
    const hoursSince = (attempt.now.getTime() - attempt.lastTouchedAt.getTime()) / 3_600_000;
    if (hoursSince < config.minHoursBetweenTouches) {
      return {
        allowed: false, code: "too_soon",
        reason: `Last contacted ${hoursSince.toFixed(1)}h ago; the minimum gap is ${config.minHoursBetweenTouches}h.`,
        retryAt: new Date(attempt.lastTouchedAt.getTime() + config.minHoursBetweenTouches * 3_600_000),
      };
    }
  }

  if (attempt.sentToday >= config.dailySendCap) {
    return { allowed: false, code: "daily_cap", reason: `Daily send cap of ${config.dailySendCap} reached.`, retryAt: nextUtcMidnight(attempt.now) };
  }
  if (!attempt.isReply && attempt.sentTodayToDomain >= config.perDomainDailyCap) {
    return {
      allowed: false, code: "domain_cap",
      reason: `Already sent ${attempt.sentTodayToDomain} to ${domain} today (cap ${config.perDomainDailyCap}).`,
      retryAt: nextUtcMidnight(attempt.now),
    };
  }

  // 6. Business hours only.
  if (!isInsideWindow(attempt.now, config)) {
    return { allowed: false, code: "outside_window", reason: "Outside the configured sending window.", retryAt: nextWindowOpening(attempt.now, config) };
  }

  return { allowed: true };
}

/**
 * The footer every commercial message carries: who sent it, a real postal
 * address, and a working way out.
 */
export function buildFooter(sender: SenderIdentity): string {
  return [
    `${sender.fromName} · ${sender.postalAddress}`,
    sender.unsubscribeUrl
      ? `Not relevant? Unsubscribe: ${sender.unsubscribeUrl}`
      : `Not relevant? Reply "unsubscribe" and I will remove you immediately.`,
  ].join("\n");
}

export function hasOptOut(body: string): boolean {
  return /unsubscribe|opt[- ]?out|remove me|stop receiving/i.test(body);
}

export { domainOf, isRoleInbox, isValidSyntax as isValidEmail, isNeverContact } from "./deliverability";
