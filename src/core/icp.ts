import type { Icp, Offering } from "./types";

/**
 * Deterministic ICP derivation.
 *
 * The LLM path produces a much better ICP, but the agent must still function
 * without an API key — and more importantly, a deterministic floor means the
 * prospecting stage can be tested without mocking a model. This derives a
 * usable (if blunt) profile straight from the extracted offering.
 */

const STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "our", "that", "this", "from", "you",
  "are", "all", "can", "has", "have", "its", "into", "more", "than", "they",
  "will", "what", "when", "which", "while", "who", "why", "how", "any", "but",
  "not", "out", "use", "using", "used", "get", "gets", "make", "makes", "new",
  "best", "most", "every", "each", "also", "just", "one", "two", "per", "via",
  // Added after an end-to-end run produced pain signals like "across" and
  // "level", which then leaked into subject lines.
  "across", "over", "under", "level", "levels", "tracks", "track", "points",
  "point", "set", "sets", "way", "ways", "need", "needs", "lot", "much",
  "actually", "really", "simply", "quickly", "easily", "always", "never",
  "first", "last", "next", "many", "some", "few", "even", "still", "yet",
  "built", "build", "helps", "help", "team", "teams", "company", "companies",
  "platform", "software", "solution", "solutions", "service", "services",
]);

export function keywordsFrom(text: string, limit = 12): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([w]) => w);
}

const GENERIC_TITLES = ["Founder", "CEO", "Operations Manager"];

/**
 * Titles that plausibly hold budget, by product category.
 *
 * Order matters and finance is checked before engineering: an invoicing
 * product whose marketing copy happens to mention "engineering teams" sells
 * to a CFO, not a CTO.
 */
const TITLE_RULES: Array<{ pattern: RegExp; titles: string[] }> = [
  { pattern: /finance|account|invoice|billing|tax|payroll|expense/, titles: ["CFO", "Finance Director", "Financial Controller"] },
  { pattern: /hr|people|recruit|hiring|talent/, titles: ["Head of People", "HR Director", "Talent Lead"] },
  { pattern: /sales|crm|revenue|pipeline|outbound/, titles: ["VP Sales", "Head of Revenue", "Sales Director"] },
  { pattern: /market|growth|brand|content|seo|demand/, titles: ["CMO", "Head of Marketing", "Growth Lead"] },
  {
    pattern:
      /dev|engineer|api|infra|cloud|observab|security|software|platform|microservice|kubernetes|deploy|incident|on-call|uptime|reliab|monitor|latency|pager|outage/,
    titles: ["CTO", "VP Engineering", "Head of Platform", "Engineering Manager"],
  },
];

function matchTitles(text: string): string[] | null {
  const t = text.toLowerCase();
  return TITLE_RULES.find((r) => r.pattern.test(t))?.titles ?? null;
}

/**
 * Explicit categories decide the buyer; body keywords are only consulted when
 * the categories say nothing. Letting incidental prose outvote the stated
 * category picked a CTO for an accounting product.
 */
function titlesFor(categories: string[], keywords: string[]): string[] {
  const fromCategories = matchTitles(categories.join(" "));
  if (fromCategories) return [...fromCategories, ...GENERIC_TITLES];
  const fromKeywords = matchTitles(keywords.join(" "));
  if (fromKeywords) return [...fromKeywords, ...GENERIC_TITLES];
  return GENERIC_TITLES;
}

/**
 * Purely grammatical words.
 *
 * Phrase extraction uses this rather than STOPWORDS, which deliberately
 * strips business vocabulary ("service", "platform", "team"). Those words are
 * noise in a single-keyword list but load-bearing inside a category name —
 * dropping "service" turned "service level objectives" into
 * "level objectives", which matches nothing a competitor would ever write.
 */
const GRAMMAR_WORDS = new Set([
  "the", "and", "for", "with", "your", "our", "that", "this", "from", "you",
  "are", "all", "can", "has", "have", "its", "into", "more", "than", "they",
  "will", "what", "when", "which", "while", "who", "why", "how", "any", "but",
  "not", "out", "use", "using", "used", "get", "gets", "make", "makes", "new",
  "every", "each", "also", "just", "one", "two", "per", "via", "across", "over",
  "their", "them", "there", "here", "where", "been", "being", "was", "were",
]);

/**
 * Words too generic to carry meaning on their own.
 *
 * A phrase made entirely of these ("saas platform", "software solution")
 * would disqualify half the internet, so such phrases are discarded.
 */
const GENERIC_WORDS = new Set([
  "platform", "software", "solution", "solutions", "service", "services",
  "product", "products", "company", "companies", "business", "team", "teams",
  "customer", "customers", "tool", "tools", "system", "systems", "app", "apps",
  "saas", "cloud", "data", "online", "digital", "modern", "simple", "powerful",
  "built", "build", "help", "helps", "work", "works", "best", "leading",
]);

/** Tokens that describe the seller rather than its market. */
function sellerOwnTokens(offering: Offering): Set<string> {
  const own = [offering.companyName, offering.domain.replace(/\..*$/, ""), offering.domain]
    .join(" ")
    .toLowerCase();
  const tokens = new Set(own.match(/[a-z][a-z-]{1,}/g) ?? []);
  // Domain suffixes and hosting words are never market signals.
  for (const t of ["com", "io", "co", "net", "org", "test", "dev", "app", "ai"]) tokens.add(t);
  return tokens;
}

/**
 * Two- and three-word phrases describing how the seller positions itself.
 *
 * These become competitor disqualifiers: a company that describes itself the
 * way you describe yourself sells what you sell. Phrases rather than single
 * words, because one word ("budget", "routing") is far too broad and would
 * disqualify genuine buyers.
 */
export function competitorPhrases(offering: Offering, limit = 12): string[] {
  // Phrases containing the seller's own name are dropped: a competitor never
  // writes your name, and "northwind slo" appearing in every page title
  // crowded the genuinely diagnostic phrase ("error budget tracking") out of
  // the list entirely.
  const own = sellerOwnTokens(offering);

  /**
   * Not all copy positions equally.
   *
   * A tagline or page title states what the company *is*; body prose is full
   * of incidental word pairs. Ranking purely by frequency-then-length filled
   * every slot with long fragments of the one-liner ("objectives services
   * pager") and dropped the one phrase that actually identifies a rival.
   */
  const sources: Array<{ text: string; weight: number }> = [
    ...(offering.positioningPhrases ?? []).map((t) => ({ text: t, weight: 8 })),
    ...offering.categories.map((t) => ({ text: t, weight: 8 })),
    { text: offering.oneLiner, weight: 3 },
    ...offering.products.map((p) => ({ text: `${p.name}. ${p.summary}`, weight: 2 })),
    ...offering.valueProps.map((t) => ({ text: t, weight: 1 })),
  ];

  const scores = new Map<string, number>();
  for (const { text, weight } of sources) {
    for (const clause of text.toLowerCase().split(/[.,;:—–()!?]/)) {
      const words = (clause.match(/[a-z][a-z-]{2,}/g) ?? []).filter(
        (w) => !GRAMMAR_WORDS.has(w) && !own.has(w),
      );
      for (let i = 0; i + 1 < words.length; i++) {
        for (const n of [2, 3]) {
          if (i + n > words.length) continue;
          const parts = words.slice(i, i + n);
          // Discard phrases that are entirely generic business vocabulary.
          if (parts.every((w) => GENERIC_WORDS.has(w))) continue;
          const phrase = parts.join(" ");
          scores.set(phrase, (scores.get(phrase) ?? 0) + weight);
        }
      }
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, limit)
    .map(([phrase]) => phrase);
}

/**
 * Sentences in which the seller describes the problem rather than the cure.
 *
 * Keywords taken from marketing copy as a whole are solution vocabulary
 * ("budget", "objectives", "pager") — which is exactly what a competitor's
 * homepage says and what a prospect's does not. The words worth matching on
 * are the ones in the sentences about the pain.
 */
const PROBLEM_MARKERS =
  /\b(problem|struggle|struggling|hard|difficult|painful|noise|noisy|fatigue|constantly|guess|guessing|cannot|can't|fails?|failing|broken|waste|wasted|manual|manually|hours|nobody|never|too many)\b/i;

function painKeywords(offering: Offering, own: Set<string>): string[] {
  const all = [offering.oneLiner, ...offering.valueProps, ...offering.products.map((p) => p.summary)];
  const problemSentences = all.filter((s) => PROBLEM_MARKERS.test(s));

  // Problem sentences first, then everything else as a fallback, so an
  // offering that never names the pain still produces a usable profile.
  const ranked = [
    ...keywordsFrom(problemSentences.join(". "), 20),
    ...keywordsFrom(all.join(". "), 20),
  ];
  return [...new Set(ranked)].filter((k) => !own.has(k) && !PROBLEM_MARKERS.test(k)).slice(0, 12);
}

export function deriveIcpHeuristically(offering: Offering): Icp {
  const corpus = [
    offering.oneLiner,
    offering.valueProps.join(" "),
    offering.products.map((p) => `${p.name} ${p.summary} ${p.capabilities.join(" ")}`).join(" "),
    offering.categories.join(" "),
  ].join(" ");

  // Strip the seller's own name, domain and address out of the keyword set —
  // otherwise the ICP ends up looking for companies called "northwind" in
  // "bristol", which is the seller, not its market.
  const ownTokens = sellerOwnTokens(offering);
  const keywords = painKeywords(offering, ownTokens);
  // No explicit category means we genuinely do not know the target industry.
  // Falling back to frequency keywords produced "industries" like
  // ["budget", "objectives", "pager"] — the seller's own solution vocabulary,
  // which a direct competitor matches perfectly and a real buyer does not.
  const industries = offering.categories.filter((c) => !ownTokens.has(c));

  return {
    industries,
    // A deliberately wide band: guessing a narrow one from marketing copy
    // would silently exclude good prospects, and `sizeSignal` reports
    // "not scored" for unknown headcounts anyway.
    sizeMin: 10,
    sizeMax: 1000,
    buyerTitles: titlesFor(offering.categories, keywords),
    painSignals: keywords.slice(0, 8),
    positiveSignals: keywords.slice(0, 10),
    // Anyone describing themselves the way the seller does is a competitor,
    // not a customer. The seller's own name alone is not enough — a competitor
    // never mentions you — so the seller's own positioning phrases are used.
    negativeSignals: [
      ...new Set([offering.companyName.toLowerCase(), ...competitorPhrases(offering)]),
    ].filter((s) => s.length > 3),
    geographies: [],
    summary:
      `Companies in ${industries.slice(0, 3).join(", ") || "any sector"} that show signs of ` +
      `${keywords.slice(0, 3).join(", ") || "the problem this product solves"}.`,
  };
}

/** Merges an LLM-produced ICP over the heuristic floor, keeping sane bounds. */
export function mergeIcp(base: Icp, override: Partial<Icp>): Icp {
  const merged: Icp = {
    ...base,
    ...Object.fromEntries(
      Object.entries(override).filter(([, v]) =>
        Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "",
      ),
    ),
  } as Icp;

  // Guard against a model returning an inverted or absurd band.
  const min = Math.max(1, Math.min(merged.sizeMin, merged.sizeMax));
  const max = Math.max(min, Math.max(merged.sizeMin, merged.sizeMax));
  return { ...merged, sizeMin: min, sizeMax: max };
}
