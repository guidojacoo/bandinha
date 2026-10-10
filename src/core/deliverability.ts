import type { DeliverabilityCheck, DeliverabilityReasonCode, DeliverabilityVerdict } from "./types";

/**
 * Pre-flight deliverability.
 *
 * The research is blunt about this: if 20–40% of your prospect addresses
 * bounce, an autonomous sender burns its domain reputation inside 90 days,
 * after which even wanted mail stops arriving. Bulk tools that skip this are
 * self-terminating.
 *
 * So every address is checked before a transport ever sees it. The pure part
 * — syntax, role detection, disposable domains, never-contact addresses —
 * lives here and is fully testable. The MX lookup needs DNS and lives in
 * `infra/dns.ts`; this module accepts its result rather than performing it.
 */

const NEVER_CONTACT = new Set([
  "abuse", "postmaster", "privacy", "security", "legal", "dpo", "compliance",
  "noreply", "no-reply", "donotreply", "do-not-reply", "unsubscribe",
  "bounce", "bounces", "mailer-daemon", "root", "webmaster", "hostmaster",
  "spam", "phishing", "report", "reports",
]);

/** Shared inboxes. Contactable, but they get a gentler cadence. */
const ROLE_PREFIXES = new Set([
  "info", "hello", "contact", "sales", "support", "admin", "office", "team",
  "help", "enquiries", "inquiries", "mail", "hi", "ask", "general", "reception",
]);

/** Addresses nobody should be cold-mailed at for recruiting/PR reasons. */
const WRONG_DEPARTMENT = new Set([
  "jobs", "careers", "recruiting", "recruitment", "hr", "press", "media",
  "investors", "ir", "billing", "accounts", "accounting", "invoices",
]);

/**
 * Throwaway mailbox providers. An address here is either a test account or
 * someone who did not want to be reachable; either way it is not a prospect.
 */
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "throwawaymail.com", "yopmail.com", "trashmail.com",
  "sharklasers.com", "getnada.com", "maildrop.cc", "fakeinbox.com",
  "dispostable.com", "mailnesia.com", "spamgourmet.com", "mohmal.com",
  "tempr.email", "emailondeck.com", "burnermail.io", "example.com",
]);

/**
 * Consumer mailbox providers.
 *
 * Not undeliverable — plenty of small businesses genuinely run on Gmail — but
 * worth flagging: a B2B prospect at a free mailbox is more likely to be a
 * personal address, where unsolicited commercial mail is far more sensitive.
 */
const FREE_MAILBOXES = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "live.com", "aol.com", "icloud.com", "me.com", "protonmail.com", "proton.me",
  "gmx.com", "mail.com", "yandex.com", "zoho.com",
]);

export function localPartOf(email: string): string {
  return email.trim().toLowerCase().split("@")[0] ?? "";
}

export function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@")[1] ?? "";
}

export function isValidSyntax(email: string): boolean {
  const e = email.trim();
  if (e.length === 0 || e.length > 254) return false;
  const local = localPartOf(e);
  if (local.length === 0 || local.length > 64) return false;
  // Deliberately stricter than RFC 5322: anything needing the full grammar
  // is not an address we should be cold-mailing.
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(e) && !/\.\./.test(e);
}

export function isRoleInbox(email: string): boolean {
  return ROLE_PREFIXES.has(localPartOf(email));
}

export function isNeverContact(email: string): boolean {
  const local = localPartOf(email);
  if (NEVER_CONTACT.has(local) || WRONG_DEPARTMENT.has(local)) return true;
  // abuse+reports@, security-team@ …
  const prefix = local.split(/[+\-.]/)[0] ?? "";
  return NEVER_CONTACT.has(prefix) || WRONG_DEPARTMENT.has(prefix);
}

export function isDisposable(email: string): boolean {
  const d = domainOf(email);
  return DISPOSABLE_DOMAINS.has(d) || [...DISPOSABLE_DOMAINS].some((x) => d.endsWith(`.${x}`));
}

export function isFreeMailbox(email: string): boolean {
  return FREE_MAILBOXES.has(domainOf(email));
}

export interface MxResult {
  /** True when the domain has at least one MX (or a usable A) record. */
  hasMx: boolean;
  /** True when the lookup itself could not be performed. */
  errored: boolean;
  detail?: string;
}

/**
 * Classifies an address. `mx` is optional so the pure checks can run (and be
 * tested) without DNS; when DNS is unavailable the verdict is marked
 * `mxChecked: false` rather than silently assuming the domain is fine.
 */
export function checkDeliverability(
  email: string,
  mx?: MxResult,
  now: Date = new Date(),
): DeliverabilityCheck {
  const base = { email: email.trim().toLowerCase(), mxChecked: Boolean(mx && !mx.errored), checkedAt: now.toISOString() };
  const verdict = (v: DeliverabilityVerdict, code: DeliverabilityReasonCode, detail: string): DeliverabilityCheck =>
    ({ ...base, verdict: v, code, detail });

  if (!isValidSyntax(email)) return verdict("undeliverable", "syntax", "Not a valid email address.");
  if (isNeverContact(email)) {
    return verdict("undeliverable", "never_contact", `${localPartOf(email)}@ is an abuse, security or wrong-department address.`);
  }
  if (isDisposable(email)) return verdict("undeliverable", "disposable", `${domainOf(email)} is a disposable mailbox provider.`);

  if (mx) {
    if (mx.errored) {
      // A DNS failure is not evidence of a bad address, so this is "risky"
      // rather than "undeliverable" — we simply do not know yet.
      return verdict("risky", "dns_error", `MX lookup failed: ${mx.detail ?? "unknown error"}.`);
    }
    if (!mx.hasMx) {
      return verdict("undeliverable", "no_mx", `${domainOf(email)} publishes no MX record — mail to it will bounce.`);
    }
  }

  if (isRoleInbox(email)) {
    return verdict("risky", "role_inbox", "Shared inbox: deliverable, but gets a shorter cadence.");
  }
  if (isFreeMailbox(email)) {
    return verdict("risky", "free_mailbox", `${domainOf(email)} is a consumer mailbox — may be a personal address.`);
  }

  return verdict(
    "deliverable",
    mx ? "ok" : "unchecked",
    mx ? "Valid address at a domain that accepts mail." : "Valid address; MX not checked.",
  );
}

/**
 * Whether a checked address may be contacted at all.
 *
 * Fails closed on `undefined`. An unchecked address is not the same as a
 * checked-and-unknown one: `checkDeliverability` runs happily without DNS and
 * returns `mxChecked: false`, so the only way to get here with nothing is to
 * have skipped the gate. Returning `true` there would turn the whole
 * pre-flight into a no-op the first time a caller forgot to wire it up, which
 * is precisely the failure mode this module exists to prevent.
 */
export function mayContact(check: DeliverabilityCheck | undefined): boolean {
  if (!check) return false;
  return check.verdict !== "undeliverable";
}
