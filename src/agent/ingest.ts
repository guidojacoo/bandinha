import { inferIcp, normaliseIcp } from "../core/icp";
import { isUsableQuote } from "../core/evidence";
import { splitSentences, guessCompanyName, parsePage, type PageText } from "../infra/extract";
import { crawlSite, type CrawlResult } from "../infra/crawler";
import { estimateTokens } from "../core/budget";
import type { Llm } from "../infra/llm/types";
import type { Icp, Offering, Product, SourcedClaim } from "../core/types";

/**
 * One URL in, a sellable position out.
 *
 * This is the step that makes the product usable: the operator pastes their
 * own website and everything downstream — who to look for, where to look,
 * what to say — is derived from it. An LLM does the derivation when one is
 * available, and a deterministic reader does it when one is not, because the
 * free tier runs out and the agent has to keep working past that point.
 *
 * The strict rule here: nothing is invented. Every value prop and proof point
 * carries the URL it was read from, and `core/provenance.ts` later checks
 * outgoing copy against exactly these texts. That is why the heuristic path
 * is not a toy — it produces the same shape, with the same sourcing
 * guarantees, as the model path.
 */

export interface IngestResult {
  offering: Offering;
  icp: Icp;
  pages: PageText[];
  crawl: CrawlResult;
  /** How each half was produced, for the console and the audit log. */
  via: { offering: "llm" | "heuristic"; icp: "llm" | "heuristic" };
  notes: string[];
}

export async function ingest(
  sourceUrl: string,
  llm: Llm,
  options: { maxPages?: number; onProgress?: (message: string) => void } = {},
): Promise<IngestResult | { error: string }> {
  options.onProgress?.(`Reading ${sourceUrl}…`);

  const crawl = await crawlSite(sourceUrl, {
    maxPages: options.maxPages ?? 12,
    onPage: (page, index) => options.onProgress?.(`  ${index + 1}. ${page.url}`),
  });

  if (crawl.failed || crawl.pages.length === 0) {
    const detail = crawl.errors[0]?.error ?? "no readable pages";
    return { error: `Could not read ${sourceUrl}: ${detail}.` };
  }

  const notes: string[] = [];
  if (crawl.errors.length > 0) {
    notes.push(`${crawl.errors.length} page(s) could not be read: ${crawl.errors.slice(0, 3).map((e) => e.error).join("; ")}.`);
  }

  options.onProgress?.(`Working out what ${crawl.domain} sells…`);
  const heuristicOffering = readOffering(crawl);
  const modelOffering = await askForOffering(llm, crawl, heuristicOffering);

  const offering = modelOffering.offering ?? heuristicOffering;
  if (modelOffering.note) notes.push(modelOffering.note);

  options.onProgress?.("Working out who buys it…");
  const heuristicIcp = inferIcp(offering);
  const modelIcp = await askForIcp(llm, offering, crawl);

  const icp = modelIcp.icp ?? heuristicIcp;
  if (modelIcp.note) notes.push(modelIcp.note);

  return {
    offering,
    icp,
    pages: crawl.pages,
    crawl,
    via: { offering: modelOffering.offering ? "llm" : "heuristic", icp: modelIcp.icp ? "llm" : "heuristic" },
    notes,
  };
}

// ---------------------------------------------------------------------------
// The deterministic reader
// ---------------------------------------------------------------------------

/** Verbs that introduce a benefit rather than a feature list. */
const BENEFIT_CUES =
  /\b(help(?:s)?|let(?:s)?|enable(?:s)?|save(?:s)?|reduce(?:s)?|cut(?:s)?|stop(?:s)?|avoid(?:s)?|prevent(?:s)?|speed(?:s)? up|automate(?:s)?|eliminate(?:s)?|replace(?:s)?|improve(?:s)?|free(?:s)? up|remove(?:s)?|simplif(?:y|ies)|without)\b/i;

/**
 * Claims that can actually be checked by a reader: certifications, named
 * standards, published numbers. Deliberately narrow — a proof point is the
 * highest-risk thing outreach can assert about the seller, and a wrong one
 * is a false statement made under the operator's name.
 */
const PROOF_CUES =
  /\b(soc ?2|iso ?\d{4,5}|hipaa|gdpr|pci[- ]?dss|fedramp|certified|accredited|audited|patented|open ?source|uptime|sla|\d{2,3}(?:\.\d+)?%|\d+(?:,\d{3})+\s+(?:customers|users|teams|companies|developers))\b/i;

export function readOffering(crawl: CrawlResult): Offering {
  const pages = crawl.pages;
  const home = pages[0]!;
  const companyName = guessCompanyName(pages, crawl.domain);

  const oneLiner = pickOneLiner(home, companyName);
  const valueProps = collectClaims(pages, BENEFIT_CUES, 8);
  const proofPoints = collectClaims(pages, PROOF_CUES, 5);

  return {
    companyName,
    domain: crawl.domain,
    oneLiner,
    products: readProducts(pages, companyName, oneLiner),
    valueProps,
    proofPoints,
    pricingModel: readPricing(pages),
    // Left empty on purpose. An earlier version filled this from word
    // frequency and scraped the seller's own postal address into it, so every
    // company in the same country scored a perfect industry match. An empty
    // list costs one scoring signal; a wrong one corrupts every score.
    categories: [],
    toneOfVoice: "direct and specific, matching how they write about themselves",
    positioningPhrases: positioningPhrases(pages),
    sources: pages.map((p) => p.url),
  };
}

function pickOneLiner(home: PageText, companyName: string): string {
  const candidates = [
    home.description,
    home.headings[0],
    home.headings[1],
    splitSentences(home.text)[0],
  ];
  for (const candidate of candidates) {
    const text = (candidate ?? "").trim();
    if (text.length >= 25 && text.length <= 220) return text;
  }
  return `${companyName} — see ${home.url}`;
}

function readProducts(pages: PageText[], companyName: string, oneLiner: string): Product[] {
  const productPage = pages.find((p) => /\/(products?|services?|solutions?|features?|platform|pricing)\b/i.test(p.url));
  const capabilities = (productPage ?? pages[0]!).headings
    .filter((h) => h.length >= 8 && h.length <= 70 && !/^(pricing|faq|contact|about|blog|careers?|customers?)\b/i.test(h))
    .slice(0, 6);

  return [{
    name: companyName,
    summary: oneLiner,
    capabilities: capabilities.length > 0 ? capabilities : [],
  }];
}

function readPricing(pages: PageText[]): string | undefined {
  const page = pages.find((p) => /\/(pricing|plans|packages)\b/i.test(p.url));
  if (!page) return undefined;
  for (const sentence of splitSentences(page.text)) {
    if (/(?:[$€£]\s?\d|\bper (?:seat|user|month|year|service)\b|\bfree (?:tier|plan)\b)/i.test(sentence) && sentence.length <= 160) {
      return sentence;
    }
  }
  return undefined;
}

/**
 * Category phrases from titles and taglines.
 *
 * Weighted highest when `core/icp.ts` picks competitor phrases, because a
 * title says what a company *is* while body prose says what it talks about.
 */
function positioningPhrases(pages: PageText[]): string[] {
  const phrases = new Set<string>();
  for (const page of pages.slice(0, 5)) {
    const title = page.title.split(/[|–—:·]/).map((p) => p.trim()).filter((p) => p.length >= 8 && p.length <= 70);
    for (const part of title.slice(1)) phrases.add(part);
    for (const heading of page.headings.slice(0, 2)) {
      if (heading.length >= 8 && heading.length <= 70) phrases.add(heading);
    }
  }
  if (pages[0]?.description) phrases.add(pages[0].description.slice(0, 160));
  return [...phrases].slice(0, 12);
}

/** Sentences matching a cue, each tied to the page it came from. */
function collectClaims(pages: PageText[], cue: RegExp, limit: number): SourcedClaim[] {
  const claims: SourcedClaim[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    for (const sentence of splitSentences(page.text)) {
      if (sentence.length < 25 || sentence.length > 200) continue;
      if (!cue.test(sentence)) continue;
      // The same boilerplate test the evidence gate uses, rather than a
      // second list that drifts out of step with it. The first version here
      // matched "cookie" and sailed past "cookies", putting a cookie banner
      // in front of a prospect as a value proposition.
      if (!isUsableQuote(sentence)) continue;
      const key = sentence.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({ text: sentence, source: page.url });
      if (claims.length >= limit) return claims;
    }
  }
  return claims;
}

// ---------------------------------------------------------------------------
// The model path
// ---------------------------------------------------------------------------

const OFFERING_SYSTEM = `You read a company's own website and summarise what it sells, for a sales team.

Rules you must follow:
- Use ONLY what the pages say. Do not add industry knowledge, do not guess, do not embellish.
- Every value prop and proof point must be a near-verbatim sentence from the pages, with the exact URL it came from.
- proofPoints are only verifiable facts: certifications, published metrics, named standards. If the pages contain none, return an empty array. Never invent a customer name or a percentage.
- categories are the market categories this company sells INTO or competes in, two to five of them, lowercase.
- positioningPhrases are the two-to-four-word phrases this company uses to describe its own category.

Return JSON exactly like:
{"companyName":"","oneLiner":"","categories":[],"positioningPhrases":[],"pricingModel":"","toneOfVoice":"","products":[{"name":"","summary":"","capabilities":[]}],"valueProps":[{"text":"","source":""}],"proofPoints":[{"text":"","source":""}]}`;

async function askForOffering(
  llm: Llm,
  crawl: CrawlResult,
  fallback: Offering,
): Promise<{ offering?: Offering; note?: string }> {
  if (!llm.available()) return { note: "No LLM available, so the offering was read deterministically." };

  const corpus = pagesForPrompt(crawl.pages, 9_000);
  const result = await llm.json<Partial<Offering>>(
    {
      task: "extract",
      tier: "large",
      system: OFFERING_SYSTEM,
      user: `Website: ${crawl.domain}\n\n${corpus}`,
      maxTokens: 1_400,
    },
    (value) => value as Partial<Offering>,
  );

  if (!result.ok || !result.data) {
    return { note: `Offering read deterministically: ${result.reason ?? "the model did not answer"}.` };
  }
  return { offering: mergeOffering(result.data, fallback, crawl) };
}

/**
 * Takes what the model got right and keeps what it cannot be trusted with.
 *
 * Sources are re-validated against pages actually crawled, because a model
 * asked for a URL will produce a plausible one — and a claim attributed to a
 * page that does not exist fails provenance later, silently costing a good
 * message. Here it is corrected instead.
 */
export function mergeOffering(partial: Partial<Offering>, fallback: Offering, crawl: CrawlResult): Offering {
  const knownUrls = new Set(crawl.pages.map((p) => p.url));
  const corpus = new Map(crawl.pages.map((p) => [p.url, `${p.title}\n${p.description}\n${p.text}`]));

  const fixClaims = (claims: unknown, fallbackClaims: SourcedClaim[]): SourcedClaim[] => {
    if (!Array.isArray(claims)) return fallbackClaims;
    const out: SourcedClaim[] = [];
    for (const raw of claims) {
      const text = String((raw as SourcedClaim)?.text ?? "").trim();
      if (text.length < 15 || text.length > 260) continue;
      const declared = String((raw as SourcedClaim)?.source ?? "").trim();
      const source = knownUrls.has(declared) ? declared : findSource(text, corpus);
      // A claim we cannot locate on any crawled page is dropped here rather
      // than blocking a message later.
      if (!source) continue;
      out.push({ text, source });
    }
    return out.length > 0 ? out : fallbackClaims;
  };

  return {
    companyName: nonEmpty(partial.companyName, fallback.companyName).slice(0, 80),
    domain: fallback.domain,
    oneLiner: nonEmpty(partial.oneLiner, fallback.oneLiner).slice(0, 240),
    products: Array.isArray(partial.products) && partial.products.length > 0
      ? partial.products.slice(0, 4).map((p) => ({
          name: nonEmpty(p?.name, fallback.companyName).slice(0, 80),
          summary: nonEmpty(p?.summary, fallback.oneLiner).slice(0, 300),
          capabilities: strings(p?.capabilities).slice(0, 8),
          priceLabel: p?.priceLabel ? String(p.priceLabel).slice(0, 80) : undefined,
        }))
      : fallback.products,
    valueProps: fixClaims(partial.valueProps, fallback.valueProps),
    proofPoints: fixClaims(partial.proofPoints, fallback.proofPoints),
    pricingModel: partial.pricingModel ? String(partial.pricingModel).slice(0, 200) : fallback.pricingModel,
    categories: strings(partial.categories).map((c) => c.toLowerCase()).slice(0, 6),
    toneOfVoice: nonEmpty(partial.toneOfVoice, fallback.toneOfVoice).slice(0, 160),
    positioningPhrases: [...new Set([...strings(partial.positioningPhrases), ...fallback.positioningPhrases])].slice(0, 12),
    sources: fallback.sources,
  };
}

/** The crawled page whose text actually contains a claim. */
function findSource(text: string, corpus: Map<string, string>): string | null {
  const needle = text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const words = needle.split(" ").filter((w) => w.length > 3);
  if (words.length === 0) return null;

  let best: { url: string; score: number } | null = null;
  for (const [url, pageText] of corpus) {
    const haystack = pageText.toLowerCase();
    if (haystack.includes(needle)) return url;
    const matched = words.filter((w) => haystack.includes(w)).length / words.length;
    if (!best || matched > best.score) best = { url, score: matched };
  }
  return best && best.score >= 0.8 ? best.url : null;
}

const ICP_SYSTEM = `You define the ideal customer profile for a company, for an outbound sales agent.

The agent finds prospects by crawling their websites and matching keywords, so your answer must be made of words that appear on a PROSPECT's own site — not abstract segments.

Rules:
- painSignals: lowercase phrases a company with this problem writes about ITSELF. "on-call rotation", "manual reconciliation", "no-shows". Not "needs efficiency".
- positiveSignals: technologies, standards or practices that indicate a fit.
- negativeSignals: phrases meaning "this company is a competitor, do not contact".
- buyerTitles: job titles of the person who would answer this email.
- geographies: only if the company clearly sells to specific places; otherwise empty.
- sizeMin/sizeMax: employee count range. Be realistic and narrow.

Return JSON exactly like:
{"summary":"","industries":[],"sizeMin":0,"sizeMax":0,"buyerTitles":[],"painSignals":[],"positiveSignals":[],"negativeSignals":[],"geographies":[]}`;

async function askForIcp(llm: Llm, offering: Offering, crawl: CrawlResult): Promise<{ icp?: Icp; note?: string }> {
  if (!llm.available()) return { note: "No LLM available, so the ICP was derived deterministically." };

  const brief = [
    `Company: ${offering.companyName} (${offering.domain})`,
    `What it sells: ${offering.oneLiner}`,
    offering.pricingModel ? `Pricing: ${offering.pricingModel}` : "",
    `Capabilities: ${offering.products.flatMap((p) => p.capabilities).slice(0, 10).join("; ")}`,
    `Its own words: ${offering.valueProps.map((v) => v.text).slice(0, 6).join(" ")}`,
    `Categories: ${offering.categories.join(", ") || "not stated"}`,
  ].filter(Boolean).join("\n");

  const result = await llm.json<Partial<Icp>>(
    {
      task: "classify",
      tier: "large",
      system: ICP_SYSTEM,
      user: `${brief}\n\nPages read: ${crawl.pages.map((p) => p.url).join(", ")}`,
      maxTokens: 900,
    },
    (value) => value as Partial<Icp>,
  );

  if (!result.ok || !result.data) {
    return { note: `ICP derived deterministically: ${result.reason ?? "the model did not answer"}.` };
  }
  // normaliseIcp clamps the sizes, drops address fragments, merges competitor
  // phrases in and re-routes the discovery sources. The model's answer is
  // material, not gospel.
  return { icp: normaliseIcp(result.data, offering) };
}

/** Pages flattened into a prompt, newest-first by priority, within a budget. */
export function pagesForPrompt(pages: PageText[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const page of pages) {
    const header = `--- ${page.url}\n${page.title}\n${page.description}\n`;
    const remaining = maxChars - used - header.length;
    if (remaining < 200) break;
    const body = page.text.slice(0, Math.min(2_400, remaining));
    parts.push(`${header}${body}`);
    used += header.length + body.length;
  }
  return parts.join("\n\n");
}

export function promptCost(pages: PageText[], maxChars: number): number {
  return estimateTokens(pagesForPrompt(pages, maxChars));
}

/** Re-parses a stored page, for a campaign resumed in another process. */
export function rehydratePage(html: string, url: string): PageText {
  return parsePage(html, url);
}

function nonEmpty(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : fallback;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0 && v.length <= 80))];
}
