import { hasOptOut } from "./compliance";
import type { DraftMessage, DraftValidation, Offering } from "./types";

/**
 * The last gate before a draft reaches a transport.
 *
 * An LLM writing sales copy will, unprompted, invent a customer logo, promise
 * a discount nobody authorised, or leave `{{first_name}}` in the subject line.
 * None of that is caught by a compliance check about volume and consent, so it
 * is caught here: every factual claim must trace back to something the
 * seller's own site actually says.
 */

/** Template syntax that escaped un-rendered. */
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\{\{\s*[\w.]+\s*\}\}/,      // {{first_name}}
  /\{\s*[\w.]+\s*\}/,          // {first_name}
  /\[\s*(?:COMPANY|NAME|FIRST_?NAME|PRODUCT|X)\s*\]/i,
  /\bTODO\b/,
  /\bLOREM IPSUM\b/i,
  /\bINSERT [A-Z ]{3,}\b/,
];

/** Phrases that reveal the sender is a bot pretending otherwise, or are unsafe. */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; problem: string }> = [
  { pattern: /\bas an AI\b/i, problem: "reveals a raw model artifact ('as an AI')" },
  { pattern: /\bI (?:am|'m) an? (?:AI|language model|bot)\b/i, problem: "contains a model self-disclosure artifact" },
  { pattern: /\bguarantee[ds]?\b.{0,30}\b(?:ROI|revenue|results?|savings?)\b/i, problem: "makes a guaranteed-results claim" },
  { pattern: /\b(?:100%|fully) guaranteed\b/i, problem: "makes an absolute guarantee" },
  { pattern: /\brisk[- ]free\b/i, problem: "makes a risk-free claim" },
  { pattern: /\bact now\b|\blimited time only\b|\bonce[- ]in[- ]a[- ]lifetime\b/i, problem: "uses high-pressure spam language" },
  { pattern: /\bdear (?:sir|madam|sir\/madam)\b/i, problem: "uses a mail-merge salutation that signals bulk mail" },
];

/** Words that reliably push a message into spam folders. */
const SPAM_TRIGGER_WORDS = [
  "free money", "cash bonus", "no credit check", "click here now",
  "buy now", "order now", "winner", "congratulations you",
];

export const SUBJECT_MAX = 78;   // beyond this, clients truncate
export const SUBJECT_MIN = 10;
export const BODY_MAX_CHARS = 1600;
export const BODY_MIN_CHARS = 180;

function capsRatio(text: string): number {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 20) return 0;
  const caps = letters.replace(/[^A-Z]/g, "").length;
  return caps / letters.length;
}

/**
 * Checks that every proof point the copy leans on actually exists in the
 * offering extracted from the seller's own site.
 *
 * This is the anti-fabrication check: the composer must declare what it cited,
 * and each citation has to be a real substring of a real extracted fact.
 */
export function verifyCitations(
  draft: DraftMessage,
  offering: Offering,
): { ok: boolean; unknown: string[] } {
  const known = [
    ...offering.proofPoints,
    ...offering.valueProps,
    ...(offering.positioningPhrases ?? []),
    ...offering.products.map((p) => p.name),
    ...offering.products.flatMap((p) => p.capabilities),
    offering.oneLiner,
    offering.companyName,
  ]
    .filter(Boolean)
    .map((s) => s.toLowerCase());

  const unknown = draft.citedEvidence.filter((claim) => {
    const c = claim.toLowerCase().trim();
    if (c.length === 0) return false;
    return !known.some((k) => k.includes(c) || c.includes(k));
  });

  return { ok: unknown.length === 0, unknown };
}

export function validateDraft(draft: DraftMessage, offering: Offering): DraftValidation {
  const problems: string[] = [];
  const warnings: string[] = [];

  const subject = draft.subject?.trim() ?? "";
  const body = draft.body?.trim() ?? "";

  // --- Subject ---
  if (subject.length === 0) problems.push("subject is empty");
  else {
    if (subject.length < SUBJECT_MIN) warnings.push(`subject is very short (${subject.length} chars)`);
    if (subject.length > SUBJECT_MAX) problems.push(`subject is ${subject.length} chars; clients truncate past ${SUBJECT_MAX}`);
    if (/^(re|fwd):/i.test(subject)) problems.push("subject fakes a reply or forward ('Re:'/'Fwd:') on a cold message");
    if (capsRatio(subject) > 0.5) problems.push("subject is mostly capitals");
    if ((subject.match(/!/g) ?? []).length > 1) problems.push("subject has multiple exclamation marks");
  }

  // --- Body ---
  if (body.length === 0) problems.push("body is empty");
  else {
    if (body.length < BODY_MIN_CHARS) warnings.push(`body is very short (${body.length} chars)`);
    if (body.length > BODY_MAX_CHARS) problems.push(`body is ${body.length} chars; keep cold outreach under ${BODY_MAX_CHARS}`);
    if (capsRatio(body) > 0.3) problems.push("body uses an excessive proportion of capitals");
    if ((body.match(/!/g) ?? []).length > 2) warnings.push("body has several exclamation marks");
  }

  // --- Unrendered templates ---
  for (const p of PLACEHOLDER_PATTERNS) {
    if (p.test(subject) || p.test(body)) {
      problems.push(`unrendered template placeholder matching ${p} survived into the message`);
      break;
    }
  }

  // --- Forbidden / unsafe claims ---
  for (const { pattern, problem } of FORBIDDEN_PATTERNS) {
    if (pattern.test(subject) || pattern.test(body)) problems.push(problem);
  }

  // --- Spam triggers ---
  const lowered = `${subject}\n${body}`.toLowerCase();
  const triggers = SPAM_TRIGGER_WORDS.filter((w) => lowered.includes(w));
  if (triggers.length > 0) problems.push(`contains spam-trigger phrases: ${triggers.join(", ")}`);

  // --- Opt-out ---
  if (!hasOptOut(body)) {
    problems.push("body has no opt-out instruction (required on commercial mail)");
  }

  // --- Grounding ---
  const citations = verifyCitations(draft, offering);
  if (!citations.ok) {
    problems.push(
      `cites claims not found in the extracted offering: ${citations.unknown.slice(0, 3).join("; ")}`,
    );
  }

  // --- Link discipline ---
  const links = body.match(/https?:\/\/[^\s)>\]]+/g) ?? [];
  if (links.length > 3) warnings.push(`${links.length} links; more than ~2 hurts deliverability`);

  return { ok: problems.length === 0, problems, warnings };
}

/** Appends the compliance footer if the body does not already carry one. */
export function withFooter(body: string, footer: string): string {
  if (hasOptOut(body)) return body;
  return `${body.trimEnd()}\n\n—\n${footer}`;
}
