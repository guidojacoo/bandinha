import * as z from "zod/v4";
import { crawlCorpus, crawlSite, type SiteCrawl } from "../infra/crawler/crawl";
import { llm } from "../infra/llm/client";
import { containsKeyword, scoreFit } from "../core/fit";
import { isNeverContact, isValidEmail } from "../core/compliance";
import type { DiscoveredContact, FitResult, Icp, LeadEvidence, LeadProfile, Offering } from "../core/types";
import type { ProspectCandidate } from "../infra/sources/types";

/**
 * Stage 3 — look at a company properly and decide whether to approach it.
 *
 * The output that matters is not the score; it is `evidence`. Every piece is
 * a real sentence from a real page on the prospect's own site, and the
 * composer is only allowed to personalise using these. That constraint is
 * what makes the outreach specific rather than mail-merged, and it is why
 * qualification crawls rather than guessing from a domain name.
 */

const EnrichSchema = z.object({
  industry: z.string().describe("The single industry this company operates in, lowercase."),
  description: z.string().describe("One sentence on what the company does, from their own site."),
  isOperatingCompany: z
    .boolean()
    .describe("False for directories, blogs, agencies listing others, parked domains, news sites."),
  buyingSignals: z
    .array(z.string())
    .describe("Short verbatim quotes from the pages that indicate the pain the product solves. Max 4."),
});

/** Splits text into sentences suitable for quoting back to a prospect. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 25 && s.length <= 240);
}

/**
 * Finds the sentence each ICP signal actually appears in.
 *
 * A keyword hit alone is not usable in an email — "I saw you mentioned
 * kubernetes" is barely better than a mail merge. The quote is what lets the
 * first line reference something true and specific.
 */
export function gatherEvidence(crawl: SiteCrawl, icp: Icp, maxPerSignal = 1): LeadEvidence[] {
  const wanted = [...new Set([...icp.painSignals, ...icp.positiveSignals])];
  const evidence: LeadEvidence[] = [];
  const counts = new Map<string, number>();

  for (const page of crawl.pages) {
    for (const sentence of sentences(page.text)) {
      for (const signal of wanted) {
        if ((counts.get(signal) ?? 0) >= maxPerSignal) continue;
        if (!containsKeyword(sentence, signal)) continue;
        evidence.push({ signal, quote: sentence, source: page.url });
        counts.set(signal, (counts.get(signal) ?? 0) + 1);
      }
    }
  }

  return evidence;
}

/** Keeps only contacts that are safe and sensible to approach. */
export function usableContacts(crawl: SiteCrawl, host: string): DiscoveredContact[] {
  const out = new Map<string, DiscoveredContact>();
  for (const page of crawl.pages) {
    for (const contact of page.emails) {
      if (!isValidEmail(contact.email) || isNeverContact(contact.email)) continue;
      // Only addresses at the company's own domain: a contractor's gmail
      // scraped off a footer is a private individual, not a business contact.
      const domain = contact.email.split("@")[1] ?? "";
      if (!domain.endsWith(host) && !host.endsWith(domain)) continue;
      if (!out.has(contact.email)) out.set(contact.email, contact);
    }
  }
  // Named individuals first — they answer; role inboxes often do not.
  return [...out.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "individual" ? -1 : 1));
}

export interface QualifiedLead {
  profile: LeadProfile;
  fit: FitResult;
  crawl: SiteCrawl;
  candidate: ProspectCandidate;
  /** Set when the site is not an operating company worth selling to. */
  rejected?: string;
}

export async function qualify(
  candidate: ProspectCandidate,
  icp: Icp,
  offering: Offering,
  options: { maxPages?: number; hostDelayMs?: number } = {},
): Promise<QualifiedLead> {
  const crawl = await crawlSite(candidate.url, {
    maxPages: options.maxPages ?? 6,
    hostDelayMs: options.hostDelayMs,
  });

  const home = crawl.pages[0];
  const companyName =
    candidate.companyNameHint ||
    home?.title?.split(/[|–—\-:]/)[0]?.trim() ||
    candidate.domain;

  const technologies = [...new Set(crawl.pages.flatMap((p) => p.technologies))];
  const employeeEstimate = crawl.pages.find((p) => p.employeeEstimate)?.employeeEstimate;
  const location = crawl.pages.find((p) => p.location)?.location;

  const baseProfile: LeadProfile = {
    companyName,
    domain: candidate.domain,
    description: home?.description,
    industry: undefined,
    employeeEstimate,
    location,
    technologies,
    evidence: gatherEvidence(crawl, icp),
    publicContacts: usableContacts(crawl, candidate.domain),
  };

  if (crawl.pages.length === 0) {
    return {
      profile: baseProfile,
      fit: scoreFit(baseProfile, icp),
      crawl,
      candidate,
      rejected: "Nothing could be read from the site.",
    };
  }

  // LLM enrichment sharpens industry classification and filters out things
  // that are not companies at all — directories and blogs look superficially
  // on-profile because they *discuss* the right keywords.
  const enriched = await llm().extract(EnrichSchema, {
    label: "qualify:enrich",
    effort: "low",
    maxTokens: 2000,
    system:
      "You classify a company from its own website for a B2B sales team. " +
      "Only state what the pages support. buyingSignals must be verbatim quotes.",
    prompt:
      `We sell: ${offering.companyName} — ${offering.oneLiner}\n` +
      `We look for: ${icp.summary}\n\n` +
      `Company website (${candidate.domain}):\n\n${crawlCorpus(crawl, 12_000)}`,
  });

  const profile: LeadProfile = enriched
    ? {
        ...baseProfile,
        industry: enriched.industry || undefined,
        description: enriched.description || baseProfile.description,
        evidence: [
          ...baseProfile.evidence,
          // Quotes the model picked, kept only if they really are on a page.
          ...enriched.buyingSignals
            .filter((q) => crawl.pages.some((p) => p.text.includes(q.slice(0, 40))))
            .map((q) => ({
              signal: "llm:buying-signal",
              quote: q,
              source: crawl.pages.find((p) => p.text.includes(q.slice(0, 40)))?.url ?? crawl.rootUrl,
            })),
        ],
      }
    : baseProfile;

  const fit = scoreFit(profile, icp);
  const rejected =
    enriched && !enriched.isOperatingCompany
      ? "Not an operating company (directory, blog, or listing site)."
      : undefined;

  return { profile, fit, crawl, candidate, rejected };
}
