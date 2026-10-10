import type { LeadEvidence, LeadProfile } from "./types";

/**
 * The evidence gate.
 *
 * The strongest finding in the market research: AI-written cold email gets
 * roughly 0.3% replies against 4%+ for human-written. The difference is not
 * prose quality, it is that the human knows something specific about the
 * person they are writing to.
 *
 * So this product makes specificity a precondition rather than an
 * aspiration. A message that cannot quote something the crawler actually
 * found on *that prospect's own site* is never sent. The lead is skipped.
 *
 * That is a deliberate trade: fewer prospects contacted, none of them
 * contacted generically. Volume without specificity is what produces a 0.3%
 * reply rate and a burned domain.
 */

/** Minimum length for a quote to be worth putting in front of a human. */
export const MIN_QUOTE_CHARS = 40;
export const MAX_QUOTE_CHARS = 240;

/** Quotes that are technically text but say nothing about the company. */
const BOILERPLATE = [
  /^(home|about|contact|products?|services?|pricing|blog|careers?)\b/i,
  /\ball rights reserved\b/i,
  /\bcookie(s)? (policy|notice|settings|consent|preferences)\b/i,
  // Consent banners are phrased a hundred ways and none of them are evidence.
  // Matching only "cookie policy" let "This site uses cookies to improve your
  // experience" through, and it was offered to a prospect as a value prop.
  /\b(?:use|uses|using|used)\s+cookies\b/i,
  /\bthis (?:site|website) (?:uses|stores|collects)\b/i,
  /\b(?:accept|manage|reject)\s+(?:all\s+)?cookies\b/i,
  /\bprivacy policy\b/i,
  /\bterms (of|and) (service|use|conditions)\b/i,
  /\bsign (up|in)\b.*\bnewsletter\b/i,
  /\bjavascript\b.*\benable/i,
  /^\s*(copyright|©)/i,
  /\bfollow us\b/i,
  /\bskip to (main )?content\b/i,
  // Recruiting copy addressed to a candidate. A careers page is one of the
  // best sources of evidence — a job ad is the most candid document a company
  // publishes about its own problems — but only where the company is speaking
  // about itself. "You would work on Kubernetes, Kafka and Go" became the
  // opening line of a cold email, addressed to the person who runs the team
  // rather than to the applicant it was written for.
  /\byou(?:'ll| will| would| can expect| should)\b/i,
  /\bwe(?:'re| are) (?:looking for|hiring|seeking)\b/i,
  /\b(?:the )?ideal candidate\b/i,
  /\byour (?:role|responsibilities|day|application|cv|r[eé]sum[eé])\b/i,
  /\bapply (?:now|today|here|online)\b/i,
  /\b(?:what|who) (?:we|you)(?:'re| are) (?:looking for|offer)\b/i,
];

/**
 * Function words. Their *presence* is what distinguishes prose from a menu.
 *
 * The first version of the test below counted short words instead, and
 * rejected "We get woken up by alerts from the one service we host ourselves
 * and it is genuinely annoying" — 55% short words, and a perfect piece of
 * evidence. English prose is full of short words; a navigation menu is a run
 * of capitalised labels with almost none.
 */
const FUNCTION_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at",
  "by", "for", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "being", "we", "our", "us", "i", "you", "your", "they", "their", "it", "its",
  "this", "that", "these", "those", "has", "have", "had", "do", "does", "did",
  "not", "no", "so", "than", "then", "when", "while", "because", "about",
  "into", "over", "up", "out", "down", "off", "more", "most", "very", "just",
]);

/** A quote that is a navigation menu rather than a sentence. */
function looksLikeNavigation(quote: string): boolean {
  const words = quote.split(/\s+/).filter(Boolean);
  if (words.length < 6) return true;

  const functionWords = words.filter((w) => FUNCTION_WORDS.has(w.toLowerCase().replace(/[^a-z']/g, ""))).length;
  const capitalised = words.filter((w) => /^[A-Z]/.test(w)).length;

  // Prose has connective tissue. A line with essentially none of it, and
  // mostly capitalised words, is a menu.
  if (functionWords / words.length < 0.12 && capitalised / words.length > 0.5) return true;
  // Pipe and bullet separators are a menu whatever the words are.
  return (quote.match(/[|·•»]/g) ?? []).length >= 2;
}

export function isUsableQuote(quote: string): boolean {
  const q = quote.trim();
  if (q.length < MIN_QUOTE_CHARS || q.length > MAX_QUOTE_CHARS) return false;
  if (BOILERPLATE.some((p) => p.test(q))) return false;
  if (looksLikeNavigation(q)) return false;
  // Must contain at least one verb-ish construction — a noun pile is a
  // heading, not a sentence we can quote back to someone.
  return /\b(is|are|was|were|has|have|run|runs|use|uses|using|build|builds|work|works|help|helps|manage|manages|serve|serves|support|supports|make|makes|need|needs|want|wants|provide|provides|deliver|delivers|operate|operates|handle|handles)\b/i.test(q);
}

export interface EvidenceVerdict {
  /** True when there is at least one quote worth writing about. */
  ok: boolean;
  /** The quotes that passed, best first. */
  usable: LeadEvidence[];
  reason: string;
}

/**
 * Decides whether we know enough about a prospect to write to them at all.
 *
 * `requireEvidence` is configurable but defaults on. Turning it off is how a
 * user opts into generic outreach, and the console says so plainly.
 */
export function assessEvidence(
  profile: LeadProfile,
  options: { requireEvidence?: boolean } = {},
): EvidenceVerdict {
  const required = options.requireEvidence ?? true;

  const usable = profile.evidence
    .filter((e) => isUsableQuote(e.quote))
    // Prefer longer, more specific quotes, and de-duplicate near-identical ones.
    .sort((a, b) => b.quote.length - a.quote.length)
    .filter((e, i, all) => all.findIndex((o) => similar(o.quote, e.quote)) === i);

  if (usable.length > 0) {
    return {
      ok: true,
      usable,
      reason: `${usable.length} quotable observation${usable.length === 1 ? "" : "s"} from their site.`,
    };
  }

  return {
    ok: !required,
    usable: [],
    reason: required
      ? "Nothing specific enough to write about was found on their site."
      : "No evidence found; sending generic outreach because the evidence gate is disabled.",
  };
}

/** True when two quotes are substantially the same sentence. */
export function similar(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const A = new Set(norm(a));
  const B = norm(b);
  if (A.size === 0 || B.length === 0) return false;
  const shared = B.filter((w) => A.has(w)).length;
  return shared / Math.min(A.size, B.length) > 0.8;
}
