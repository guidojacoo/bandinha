import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The opt-out link, and why it has to be real.
 *
 * Every message this agent sends carries a line telling the recipient how to
 * stop hearing from us. For most of this project's life that line pointed at
 * a URL the operator was expected to host themselves, and if they had not,
 * the message was making a promise nothing kept. That is not a missing
 * feature, it is the one part of a cold email that is legally load-bearing:
 *
 *  - CAN-SPAM §7704(a)(3) requires a working opt-out mechanism, and requires
 *    it to keep working for at least thirty days after the message was sent.
 *  - Gmail and Yahoo's bulk-sender rules, since 2024, require one-click
 *    unsubscribe — which means the `List-Unsubscribe-Post` header has to be
 *    honoured by an endpoint that accepts a POST and does the thing. A header
 *    that advertises one-click and then 404s is worse than no header.
 *
 * So the link is per-recipient and signed. Per-recipient because a shared
 * link cannot tell who clicked it, and an opt-out that cannot identify its
 * subject is not an opt-out. Signed because the alternative is a database
 * lookup on an unauthenticated route, which is an enumeration oracle: feed it
 * ids until one stops 404ing and you have a customer list.
 */

export interface OptOutSubject {
  /** The operator whose suppression list this belongs to. */
  userId: string;
  email: string;
}

/**
 * Mints a token for one recipient.
 *
 * No expiry, deliberately. Thirty days is the legal floor, not a target, and
 * there is no version of "your unsubscribe link has expired, please contact
 * us" that is defensible. The worst a stale token can do is suppress an
 * address that somebody controls, which is the outcome we want anyway.
 */
export function mintToken(subject: OptOutSubject, secret: string): string {
  const payload = encode(`${subject.userId}:${normaliseEmail(subject.email)}`);
  return `${payload}.${sign(payload, secret)}`;
}

export type TokenResult =
  | { ok: true; subject: OptOutSubject }
  | { ok: false; reason: string };

export function readToken(token: string, secret: string): TokenResult {
  const parts = token.trim().split(".");
  if (parts.length !== 2) return { ok: false, reason: "Malformed token." };

  const [payload, signature] = parts as [string, string];
  if (!verify(payload, signature, secret)) return { ok: false, reason: "Signature does not match." };

  const decoded = decode(payload);
  const separator = decoded.indexOf(":");
  if (separator <= 0) return { ok: false, reason: "Token carries no subject." };

  const userId = decoded.slice(0, separator);
  const email = decoded.slice(separator + 1);
  if (!userId || !email.includes("@")) return { ok: false, reason: "Token carries no subject." };

  return { ok: true, subject: { userId, email } };
}

/**
 * The URL to put in a footer, or null when there is nowhere to point it.
 *
 * Returning null rather than a guess is the point: a footer with no link
 * falls back to "reply and I will remove you", which is a mechanism that
 * genuinely works because the agent reads its replies. A footer with a link
 * to a host that is not serving this app is a promise nothing keeps.
 */
export function optOutUrl(
  subject: OptOutSubject,
  options: { baseUrl?: string; secret?: string },
): string | null {
  const base = (options.baseUrl ?? "").trim().replace(/\/+$/, "");
  const secret = (options.secret ?? "").trim();
  if (!base || !secret) return null;
  if (!/^https?:\/\//i.test(base)) return null;

  return `${base}/api/unsubscribe/${mintToken(subject, secret)}`;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function verify(payload: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(sign(payload, secret), "utf8");
  const provided = Buffer.from(signature, "utf8");
  // Length check first: timingSafeEqual throws on a mismatch, and comparing
  // with === would leak the signature one byte at a time to anyone patient
  // enough to measure.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "";
  }
}
