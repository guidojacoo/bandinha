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
  /\bcookie(s)? (policy|notice|settings)\b/i,
  /\bprivacy policy\b/i,
  /\bterms (of|and) (service|use|conditions)\b/i,
  /\bsign (up|in)\b.*\bnewsletter\b/i,
  /\bjavascript\b.*\benable/i,
  /^\s*(copyright|©)/i,
  /\bfollow us\b/i,
  /\bskip to (main )?content\b/i,
];

/** A quote that is mostly navigation words is not evidence. */
function looksLikeNavigation(quote: string): boolean {
  const words = quote.split(/\s+/).filter(Boolean);
  if (words.length < 6) return true;
  // A run of short capitalised words separated by punctuation is a menu.
  const shortWords = words.filter((w) => w.length <= 3).length;
  return shortWords / words.length > 0.5;
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
