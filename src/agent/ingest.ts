import * as z from "zod/v4";
import { crawlCorpus, crawlSite, type SiteCrawl } from "../infra/crawler/crawl";
import { llm } from "../infra/llm/client";
import { deriveIcpHeuristically, mergeIcp } from "../core/icp";
import type { Icp, Offering } from "../core/types";

/**
 * Stage 1 — learn what the operator sells, from their own website.
 *
 * Everything downstream is grounded in this: outreach may only make claims
 * that appear here, so extraction is deliberately conservative. The model is
 * told to copy, not to summarise or embellish, and anything it cannot find it
 * must leave empty rather than infer.
 */

const OfferingSchema = z.object({
  companyName: z.string().describe("The company's own name, exactly as written on the site."),
  oneLiner: z.string().describe("One sentence describing what the company does, in their words."),
  products: z
    .array(
      z.object({
        name: z.string(),
        summary: z.string(),
        capabilities: z.array(z.string()).describe("Concrete features as stated on the page."),
        priceLabel: z.string().describe("Published price, or empty string if none is published."),
      }),
    )
    .describe("Products or services actually offered for sale."),
  valueProps: z.array(z.string()).describe("Benefit claims the site makes, quoted or closely paraphrased."),
  proofPoints: z
    .array(z.string())
    .describe(
      "Verifiable evidence only: named customers, published metrics, certifications, awards. Never invent one.",
    ),
  pricingModel: z.string().describe("How they charge, e.g. 'per seat monthly'. Empty string if unclear."),
  categories: z.array(z.string()).describe("Market categories, lowercase, e.g. 'observability'."),
  toneOfVoice: z.string().describe("How the company writes: register, formality, jargon level."),
});

const IcpSchema = z.object({
  industries: z.array(z.string()).describe("Lowercase industries that buy this."),
  sizeMin: z.number().describe("Smallest sensible customer, in employees."),
  sizeMax: z.number().describe("Largest sensible customer, in employees."),
  buyerTitles: z.array(z.string()).describe("Job titles that hold the budget or feel the pain."),
  painSignals: z
    .array(z.string())
    .describe("Lowercase keywords observable on a prospect's own website that indicate this pain."),
  positiveSignals: z.array(z.string()).describe("Lowercase keywords that indicate a good fit."),
  negativeSignals: z
    .array(z.string())
    .describe("Lowercase keywords that disqualify: direct competitors, incompatible models."),
  geographies: z.array(z.string()).describe("Lowercase target regions, or empty for no constraint."),
  summary: z.string().describe("One sentence describing the ideal customer."),
});

const EXTRACT_SYSTEM = `You extract structured facts about a company from its own website.

Rules, in order of importance:
1. Only record what the pages actually say. If something is not stated, leave the field empty.
2. Never invent a customer name, metric, certification or award. A fabricated proof point
   will be used verbatim in sales emails to real people, so inventing one is the single
   worst thing you can do here.
3. Prefer the company's own wording over your paraphrase.
4. proofPoints must be verifiable claims (named customers, published numbers, certifications),
   not marketing adjectives.`;

const ICP_SYSTEM = `You define the ideal customer profile for a product, given what the product does.

Rules:
1. painSignals and positiveSignals must be words a prospect would plausibly have on their
   own public website. They are matched literally against crawled page text, so prefer
   concrete nouns ("on-call rota", "kubernetes", "invoice reconciliation") over abstractions
   ("efficiency", "growth").
2. negativeSignals must identify direct competitors and genuinely incompatible prospects.
3. Keep every keyword lowercase and under four words.
4. Size bounds should be realistic for the price point, not aspirational.`;

export interface IngestResult {
  offering: Offering;
  icp: Icp;
  crawl: SiteCrawl;
  /** True when the LLM produced the offering; false means heuristic fallback. */
  usedLlm: boolean;
  notes: string[];
  /**
   * The seller's own details, read off their own site.
   *
   * Lets the agent assemble a lawful sender identity (CAN-SPAM requires a
   * real postal address on commercial mail) without the operator having to
   * retype what is already published on their contact page.
   */
  sellerPostalAddress?: string;
  sellerEmails: string[];
}

/** Heuristic offering extraction, used when no model is available. */
export function deriveOfferingHeuristically(crawl: SiteCrawl): Offering {
  const home = crawl.pages[0];
  const corpus = crawlCorpus(crawl, 8000);
  const companyName =
    home?.title?.split(/[|–—\-:]/)[0]?.trim() || crawl.host.replace(/\..*$/, "");

  // Headline-ish lines make a serviceable value-prop list without a model.
  const sentences = corpus
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 180);

  /**
   * The descriptive tail of each page title.
   *
   * "Northwind SLO — error budget tracking for microservices teams" carries
   * the company's positioning in a way the meta description often does not,
   * and it is the single best source of the category phrases that identify a
   * competitor. Dropping it (by taking only the name before the dash) is why
   * an earlier version of this heuristic failed to recognise one.
   */
  const titleTails = crawl.pages
    .map((p) => p.title.split(/[|\u2013\u2014\-:]/).slice(1).join(" ").trim())
    .filter((t) => t.length > 8);

  return {
    companyName,
    domain: crawl.host,
    oneLiner: home?.description ?? sentences[0] ?? `${companyName} — see ${crawl.rootUrl}`,
    products: [],
    // Prose only — title fragments go to positioningPhrases below.
    valueProps: sentences.filter((s) => /^[A-Z]/.test(s)).slice(0, 5),
    positioningPhrases: titleTails,
    // Without a model, nothing is safely verifiable, so nothing is claimed.
    proofPoints: [],
    pricingModel: undefined,
    // Deliberately empty. Frequency keywords are not categories: an earlier
    // version filled this from the seller's own copy and produced
    // ["bristol", "budget", "kingdom"] — the seller's postal address. The ICP
    // then "matched industry" on any company in the United Kingdom, which
    // silently scored geography while claiming to score industry.
    // An unknown category is scored as unknown, not guessed.
    categories: [],
    toneOfVoice: "professional and plain",
    sources: crawl.pages.map((p) => p.url),
  };
}

export async function ingest(
  url: string,
  options: { maxPages?: number; hostDelayMs?: number } = {},
): Promise<IngestResult> {
  const notes: string[] = [];
  const crawl = await crawlSite(url, { maxPages: options.maxPages ?? 12, hostDelayMs: options.hostDelayMs });

  if (crawl.pages.length === 0) {
    const reason = crawl.errors[0]?.reason ?? "no pages could be read";
    throw new Error(`Could not read anything from ${url}: ${reason}`);
  }
  if (crawl.disallowed.length > 0) {
    notes.push(`${crawl.disallowed.length} page(s) skipped because robots.txt disallowed them.`);
  }

  const corpus = crawlCorpus(crawl);
  const model = llm();

  const extracted = await model.extract(OfferingSchema, {
    label: "ingest:offering",
    system: EXTRACT_SYSTEM,
    effort: "medium",
    maxTokens: 6000,
    prompt: `Website: ${crawl.rootUrl}\n\nPages crawled:\n\n${corpus}`,
  });

  let offering: Offering;
  let usedLlm = false;

  if (extracted) {
    usedLlm = true;
    offering = {
      companyName: extracted.companyName || crawl.host,
      domain: crawl.host,
      oneLiner: extracted.oneLiner,
      products: extracted.products.map((p) => ({
        name: p.name,
        summary: p.summary,
        capabilities: p.capabilities,
        priceLabel: p.priceLabel || undefined,
      })),
      valueProps: extracted.valueProps,
      proofPoints: extracted.proofPoints,
      pricingModel: extracted.pricingModel || undefined,
      categories: extracted.categories.map((c) => c.toLowerCase()),
      toneOfVoice: extracted.toneOfVoice,
      positioningPhrases: crawl.pages
        .map((p) => p.title.split(/[|\u2013\u2014\-:]/).slice(1).join(" ").trim())
        .filter((t) => t.length > 8),
      sources: crawl.pages.map((p) => p.url),
    };
  } else {
    offering = deriveOfferingHeuristically(crawl);
    notes.push(
      model.enabled
        ? "Offering extraction fell back to heuristics (the model call failed)."
        : "No ANTHROPIC_API_KEY — offering extracted heuristically, outreach will use templates.",
    );
  }

  // The heuristic ICP is always computed: it is the floor the LLM refines,
  // and it guarantees prospecting has something usable to work with.
  const baseIcp = deriveIcpHeuristically(offering);
  const refined = await model.extract(IcpSchema, {
    label: "ingest:icp",
    system: ICP_SYSTEM,
    effort: "medium",
    maxTokens: 4000,
    prompt:
      `Product: ${offering.companyName} — ${offering.oneLiner}\n` +
      `Categories: ${offering.categories.join(", ")}\n` +
      `Capabilities: ${offering.products.flatMap((p) => p.capabilities).join("; ")}\n` +
      `Value propositions: ${offering.valueProps.join("; ")}\n` +
      `Pricing: ${offering.pricingModel ?? "not published"}`,
  });

  const icp = refined
    ? mergeIcp(baseIcp, {
        ...refined,
        industries: refined.industries.map((s) => s.toLowerCase()),
        painSignals: refined.painSignals.map((s) => s.toLowerCase()),
        positiveSignals: refined.positiveSignals.map((s) => s.toLowerCase()),
        negativeSignals: refined.negativeSignals.map((s) => s.toLowerCase()),
        geographies: refined.geographies.map((s) => s.toLowerCase()),
      })
    : baseIcp;

  if (!refined && model.enabled) notes.push("ICP refinement fell back to heuristics.");

  const sellerPostalAddress = crawl.pages.find((p) => p.location)?.location;
  const sellerEmails = [
    ...new Set(crawl.pages.flatMap((p) => p.emails.map((e) => e.email))),
  ];
  if (!sellerPostalAddress) {
    notes.push(
      "No postal address found on the site — one must be configured before anything can be sent " +
        "(commercial email is required by law to carry one).",
    );
  }

  return { offering, icp, crawl, usedLlm, notes, sellerPostalAddress, sellerEmails };
}
