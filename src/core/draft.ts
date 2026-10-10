import { verifyProvenance, type SourceCorpus } from "./provenance";
import { isValidSyntax } from "./deliverability";
import type {
  DraftMessage,
  DraftValidation,
  LeadEvidence,
  SenderIdentity,
} from "./types";

/**
 * The last gate before an address is used.
 *
 * Everything an LLM writes passes through here. The checks fall into three
 * groups, and all three have cost us a real failure in testing:
 *
 *  1. Mechanics — unfilled placeholders, missing unsubscribe, a subject line
 *     that was really a paragraph. Cheap to check, embarrassing to send.
 *  2. Fabrication — provenance verification plus a blacklist of phrasings
 *     that *invite* invention ("as seen in", "trusted by 500+"). A model told
 *     to cite proof will manufacture proof if none exists.
 *  3. Specificity — the message must actually use the evidence that earned
 *     the right to send it. Attaching a quote to the provenance list and then
 *     writing a generic email defeats the gate.
 */

export const MAX_SUBJECT_CHARS = 90;
export const MIN_BODY_CHARS = 180;
export const MAX_BODY_CHARS = 1400;

/** Template syntax that escaped substitution. */
const PLACEHOLDER_PATTERNS = [
  /\{\{\s*[\w.]+\s*\}\}/,
  /\[\s*(first[_ ]?name|company|insert|your|name|title|x)\b[^\]]*\]/i,
  /\bFIRSTNAME\b|\bCOMPANYNAME\b/,
  /<\s*(name|company|insert)[^>]*>/i,
  /\bTODO\b|\bLorem ipsum\b/i,
];

/**
 * Phrasings that are false unless backed by something we do not have.
 *
 * These are not style preferences. Each one asserts a fact about third
 * parties — customers, publications, headcounts — that a crawl of a
 * marketing site cannot establish.
 */
const UNSUPPORTABLE_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\btrusted by\s+(over\s+)?[\d,]+/i, why: "customer-count claim" },
  { pattern: /\b(as (seen|featured) in|featured on)\b/i, why: "press claim" },
  { pattern: /\b(fortune\s*\d+|yc[- ]backed|y combinator)\b/i, why: "affiliation claim" },
  { pattern: /\b(award[- ]winning|industry[- ]leading|#1\b|number one\b)\b/i, why: "superlative" },
  { pattern: /\b(we|i)\s+(saw|noticed|read)\s+(your|that you).{0,40}\b(funding|raised|series [a-e]|acquisition|layoffs?)\b/i, why: "company-news claim" },
  { pattern: /\b(?:\d{1,3}(?:\.\d+)?%|\d+(?:\.\d+)?x)\s+(?:more|less|fewer|lower|higher|faster|cheaper|better|increase|decrease|reduction|improvement|growth|savings?|roi|uplift)\b/i, why: "quantified outcome" },
  // The same claim stated the other way round. Without this, "reduces pages
  // by 60%" sailed through while "60% fewer pages" was caught.
  { pattern: /\b(?:cut|cuts|reduce[sd]?|increase[sd]?|improve[sd]?|boost(?:ed|s)?|save[sd]?|grew|grows?|drop(?:ped|s)?)\b[^.]{0,40}\bby\s+\d{1,3}(?:\.\d+)?%/i, why: "quantified outcome" },
  { pattern: /\bguarantee(d)?\b/i, why: "guarantee" },
  { pattern: /\bour (clients?|customers?) (like|such as|including)\b/i, why: "named-customer claim" },
];

/** Behaviour that gets mail marked as spam regardless of content. */
const SPAM_PATTERNS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\b(act now|limited time|last chance|urgent)\b/i, why: "false urgency" },
  { pattern: /\b(risk[- ]free|no obligation|100% free)\b/i, why: "spam-filter trigger" },
  { pattern: /!{2,}/, why: "repeated exclamation marks" },
  { pattern: /\b[A-Z]{6,}\b/, why: "shouting" },
];

function stripSignature(body: string, sender: SenderIdentity): string {
  // The compliance footer legitimately contains an address and an
  // unsubscribe link; fabrication checks must not see it as body copy.
  const markers = [sender.postalAddress, "Unsubscribe", "unsubscribe:"];
  let cut = body.length;
  for (const marker of markers) {
    if (!marker) continue;
    const at = body.indexOf(marker);
    if (at >= 0) cut = Math.min(cut, at);
  }
  return body.slice(0, cut);
}

export interface DraftContext {
  sender: SenderIdentity;
  /** The quotes that justified contacting this prospect. */
  evidence: LeadEvidence[];
  /** Every page crawled, for provenance verification. */
  corpus: SourceCorpus;
  /** Names the copy may legitimately mention. */
  allowedNames: string[];
  /** True when the draft answers something the prospect sent us. */
  isReply?: boolean;
  /**
   * True for the first message in a thread.
   *
   * The specificity requirement below applies here and nowhere else. The
   * quote is what earns the right to write at all, and it earns it once: a
   * second touch that re-reads the prospect's own sentence back to them is
   * the agent forgetting it has already spoken to this person. The evidence
   * gate still blocks the lead outright if there was never a quote.
   */
  isFirstTouch?: boolean;
  /** Off only when the operator has explicitly disabled the evidence gate. */
  requireEvidenceUse?: boolean;
}

/**
 * Validates a draft. `problems` block the send; `warnings` do not.
 *
 * The split matters: a hard block on anything merely *suspicious* means the
 * agent sends nothing and the operator turns the checks off. Only claims that
 * would be untrue, unlawful, or broken get to block.
 */
export function validateDraft(draft: DraftMessage, ctx: DraftContext): DraftValidation {
  const problems: string[] = [];
  const warnings: string[] = [];

  const subject = draft.subject.trim();
  const body = draft.body.trim();
  const copy = stripSignature(body, ctx.sender);

  // --- 1. Mechanics ------------------------------------------------------
  if (!ctx.isReply && subject.length === 0) problems.push("Subject line is empty.");
  if (subject.length > MAX_SUBJECT_CHARS)
    problems.push(`Subject is ${subject.length} characters; keep it under ${MAX_SUBJECT_CHARS}.`);
  if (/\n/.test(draft.subject)) problems.push("Subject contains a line break.");
  if (body.length < MIN_BODY_CHARS)
    problems.push(`Body is ${body.length} characters; too short to say anything useful.`);
  if (body.length > MAX_BODY_CHARS)
    problems.push(`Body is ${body.length} characters; over the ${MAX_BODY_CHARS} limit.`);

  for (const pattern of PLACEHOLDER_PATTERNS) {
    const hit = body.match(pattern) ?? draft.subject.match(pattern);
    if (hit) problems.push(`Unfilled placeholder: ${JSON.stringify(hit[0])}.`);
  }

  // --- 2. Legal footer ---------------------------------------------------
  if (!ctx.sender.fromEmail || !isValidSyntax(ctx.sender.fromEmail))
    problems.push("Sender identity has no valid from-address.");
  if (!ctx.sender.postalAddress?.trim())
    problems.push("Sender identity has no postal address (required on commercial mail).");
  else if (!body.includes(ctx.sender.postalAddress.trim()))
    problems.push("Body does not carry the sender's postal address.");

  const hasOptOut =
    /\bunsubscribe\b/i.test(body) ||
    /\b(reply|let me know)\b[^.]{0,60}\b(stop|no thanks|not interested)\b/i.test(body) ||
    (ctx.sender.unsubscribeUrl ? body.includes(ctx.sender.unsubscribeUrl) : false);
  if (!hasOptOut) problems.push("Body gives the recipient no way to opt out.");

  // --- 3. Fabrication ----------------------------------------------------
  // Verification runs first, and the `verified` flag on the incoming records
  // is ignored. It is set by whatever composed the message — i.e. the model
  // would be grading its own homework, and a model that invents a statistic
  // will happily also mark it as sourced.
  const verdict = verifyProvenance(draft.provenance, ctx.corpus);
  for (const record of verdict.unverified) {
    problems.push(`Claim not traceable to any crawled page: ${JSON.stringify(trim(record.claim))}.`);
  }

  for (const { pattern, why } of UNSUPPORTABLE_PATTERNS) {
    const hit = copy.match(pattern);
    if (!hit) continue;
    const supportedByProvenance = verdict.records.some(
      (record) => record.verified && normaliseClaim(record.claim).includes(normaliseClaim(hit[0])),
    );
    if (supportedByProvenance) continue;
    problems.push(`Unsupported ${why}: ${JSON.stringify(hit[0])}.`);
  }

  // Proper nouns the copy invented. Checked against the corpus rather than a
  // list, because the only names it may use are ones somebody published.
  for (const name of inventedNames(copy, ctx)) {
    warnings.push(`Mentions "${name}", which was not found on any crawled page.`);
  }

  // --- 4. Specificity ----------------------------------------------------
  if (ctx.requireEvidenceUse !== false && !ctx.isReply && ctx.isFirstTouch !== false) {
    const used = ctx.evidence.some((e) => quoteIsUsed(e.quote, copy));
    const citesProspect = draft.provenance.some((r) => r.kind === "prospect" && r.verified);
    if (!used && !citesProspect)
      problems.push("Body does not use anything specific found on the prospect's site.");
  }

  // --- 5. Spam hygiene ---------------------------------------------------
  for (const { pattern, why } of SPAM_PATTERNS) {
    const hit = copy.match(pattern);
    if (hit) warnings.push(`${why}: ${JSON.stringify(hit[0])}.`);
  }

  const questions = (copy.match(/\?/g) ?? []).length;
  if (!ctx.isReply && questions === 0) warnings.push("No question, so no easy way to reply.");
  if (questions > 3) warnings.push(`${questions} questions in one email is an interrogation.`);

  const links = copy.match(/https?:\/\/\S+/g) ?? [];
  if (links.length > 2) warnings.push(`${links.length} links will trip spam filters.`);

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * True when the copy visibly draws on a specific quote.
 *
 * Not substring matching: good copy paraphrases rather than pasting. We look
 * for a run of distinctive words from the quote reappearing in the body.
 */
export function quoteIsUsed(quote: string, body: string): boolean {
  const STOP = new Set([
    "the", "and", "for", "that", "with", "you", "your", "our", "are", "was",
    "this", "from", "have", "has", "they", "their", "but", "not", "can", "all",
    "its", "his", "her", "who", "what", "when", "will", "how", "why", "any",
    "out", "get", "more", "than", "then", "into", "over", "also", "been",
  ]);
  const words = (text: string) =>
    text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));

  const q = words(quote);
  if (q.length === 0) return false;
  const b = new Set(words(body));
  const shared = new Set(q.filter((w) => b.has(w)));
  if (shared.size === 0) return false;

  // Two shared words is not enough on its own: a form letter about "most
  // teams and alert noise" shared exactly "most" and "noise" with a quote
  // about being paged forty times a week, and was scored as having used it.
  // At least one shared word has to be distinctive.
  const hasDistinctive = [...shared].some((w) => w.length >= 6);
  if (shared.size >= 2 && hasDistinctive) return true;
  return shared.size / new Set(q).size >= 0.34;
}

/** Capitalised multi-word names in the copy that nothing crawled mentions. */
function inventedNames(copy: string, ctx: DraftContext): string[] {
  const allowed = new Set(ctx.allowedNames.map((n) => n.toLowerCase()));
  const corpusText = [...ctx.corpus.values()].join("\n").toLowerCase();
  const found = new Set<string>();

  // Skip the first word of each sentence: capitalisation there is grammar.
  const candidates = copy.match(/(?<![.!?]\s)(?<!^)\b[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,})?\b/gm) ?? [];
  for (const raw of candidates) {
    const name = raw.trim();
    const lower = name.toLowerCase();
    if (allowed.has(lower)) continue;
    if (COMMON_CAPITALISED.has(lower)) continue;
    if (corpusText.includes(lower)) continue;
    found.add(name);
  }
  return [...found];
}

const COMMON_CAPITALISED = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "best", "thanks", "regards",
  "hi", "hello", "hey", "unsubscribe", "ps", "api", "ceo", "cto", "cfo", "vp",
  "eu", "us", "uk", "gdpr", "soc", "iso", "saas", "the", "and", "but",
]);

/** Loose enough that re-punctuation does not break the match. */
function normaliseClaim(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
}

function trim(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
