import type { Offering, LeadProfile, ProvenanceRecord } from "./types";

/**
 * Provenance checking.
 *
 * Fabrication is a documented scandal in this category, not a hypothetical:
 * vendors have been reported for inventing customer logos and hallucinating
 * company news, with legal threats following. An agent that invents a proof
 * point does not merely send a weak email — it makes a false written
 * statement about a third party, under the operator's name.
 *
 * So every factual claim a message makes is recorded with the page it came
 * from, and checked against the text actually crawled from that page. A claim
 * that cannot be matched back fails, and the message does not go out.
 */

/** Normalises text for comparison without destroying word boundaries. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'" ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  return normalise(text).split(" ").filter((w) => w.length > 2);
}

/**
 * True when `claim` is supported by `source`.
 *
 * Exact substring first, then a high token-overlap fallback, because a model
 * legitimately re-punctuates or trims a quote it is citing. The bar is high
 * on purpose: this is the check standing between the operator and a false
 * statement about somebody else's company.
 */
export function isSupported(claim: string, source: string): boolean {
  const c = normalise(claim);
  const s = normalise(source);
  if (c.length === 0) return false;
  if (s.includes(c)) return true;

  const claimTokens = tokens(claim);
  if (claimTokens.length === 0) return false;
  // Short claims must match exactly; there is not enough signal to fuzz.
  if (claimTokens.length < 4) return false;

  const sourceTokens = new Set(tokens(source));
  const matched = claimTokens.filter((t) => sourceTokens.has(t)).length;
  return matched / claimTokens.length >= 0.85;
}

export interface ProvenanceVerdict {
  ok: boolean;
  records: ProvenanceRecord[];
  /** Claims that could not be traced to any crawled page. */
  unverified: ProvenanceRecord[];
}

/**
 * The corpus a claim may be checked against: every page that was crawled,
 * keyed by URL. Built by the agent from the seller's and prospect's crawls.
 */
export type SourceCorpus = Map<string, string>;

export function buildCorpus(
  offering: Offering,
  leadProfile?: LeadProfile,
  pages: Array<{ url: string; text: string }> = [],
): SourceCorpus {
  const corpus: SourceCorpus = new Map();
  for (const page of pages) {
    corpus.set(page.url, `${corpus.get(page.url) ?? ""}\n${page.text}`);
  }

  // Extracted facts count as their own source: the crawl that produced them
  // has usually been discarded by the time a message is composed.
  const add = (url: string, text: string) =>
    corpus.set(url, `${corpus.get(url) ?? ""}\n${text}`);

  add(`offering:${offering.domain}`, [
    offering.companyName,
    offering.oneLiner,
    offering.pricingModel ?? "",
    offering.categories.join(" "),
    offering.positioningPhrases.join(" "),
    ...offering.products.flatMap((p) => [p.name, p.summary, ...p.capabilities, p.priceLabel ?? ""]),
  ].join("\n"));

  for (const claim of [...offering.valueProps, ...offering.proofPoints]) {
    add(claim.source, claim.text);
  }
  for (const e of leadProfile?.evidence ?? []) {
    add(e.source, e.quote);
  }
  return corpus;
}

export function verifyProvenance(
  records: ProvenanceRecord[],
  corpus: SourceCorpus,
): ProvenanceVerdict {
  const checked = records.map((record) => {
    // Prefer the page the claim says it came from; fall back to any page,
    // because a model sometimes attributes a real fact to the wrong URL.
    const declared = corpus.get(record.source);
    const verified =
      (declared !== undefined && isSupported(record.claim, declared)) ||
      [...corpus.values()].some((text) => isSupported(record.claim, text));
    return { ...record, verified };
  });

  const unverified = checked.filter((r) => !r.verified);
  return { ok: unverified.length === 0, records: checked, unverified };
}
