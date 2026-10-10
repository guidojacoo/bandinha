import { assessEvidence } from "../core/evidence";
import { checkDeliverability } from "../core/deliverability";
import { scoreFit } from "../core/fit";
import { crawlSite } from "../infra/crawler";
import {
  detectTechnologies, extractContacts, findEvidence, guessCompanyName,
  guessEmployeeCount, guessLocation, selfDescriptionFrom, type PageText,
} from "../infra/extract";
import { lookupMx } from "../infra/dns";
import type { ProspectCandidate } from "../infra/sources/types";
import type {
  DeliverabilityCheck, DiscoveredContact, FitResult, Icp, LeadProfile,
} from "../core/types";

/**
 * A candidate domain into a decision.
 *
 * Four gates, in this order, because each one is cheaper than the next and
 * failing early saves the expensive work:
 *
 *  1. Can we read their site at all?
 *  2. Do they describe the problem we solve? (`core/evidence.ts`)
 *  3. Are they a competitor, the wrong size, the wrong place? (`core/fit.ts`)
 *  4. Is there a human we can lawfully reach, at an address that will not
 *     bounce? (`core/deliverability.ts`)
 *
 * The evidence gate sits second on purpose. It is the one that rejects most
 * leads, and the one whose rejections the operator most needs explained — so
 * it runs before the arithmetic and its verdict is carried in the result.
 */

export interface QualifiedLead {
  candidate: ProspectCandidate;
  profile: LeadProfile;
  fit: FitResult;
  contacts: Array<DiscoveredContact & { deliverability: DeliverabilityCheck }>;
  /** Contacts that passed the pre-flight, best first. */
  contactable: Array<DiscoveredContact & { deliverability: DeliverabilityCheck }>;
  pages: PageText[];
  accepted: boolean;
  /** Why it was rejected, in words an operator can act on. */
  reason: string;
}

export interface QualifyOptions {
  icp: Icp;
  minFitScore: number;
  requireEvidence?: boolean;
  maxPages?: number;
  /** False in environments with no resolver; the pre-flight then says so. */
  useDns?: boolean;
  onProgress?: (message: string) => void;
}

export async function qualify(
  candidate: ProspectCandidate,
  options: QualifyOptions,
): Promise<QualifiedLead> {
  const signals = [...new Set([...options.icp.painSignals, ...options.icp.positiveSignals])];

  options.onProgress?.(`Reading ${candidate.domain}…`);
  const crawl = await crawlSite(candidate.url, {
    maxPages: options.maxPages ?? 8,
    // Pages where a company is most candid about its problems.
    extraPriorities: ["careers", "jobs", "engineering", "blog"],
  });

  if (crawl.failed || crawl.pages.length === 0) {
    return reject(candidate, `Their site could not be read (${crawl.errors[0]?.error ?? "no readable pages"}).`);
  }

  const profile = buildProfile(candidate, crawl.pages, crawl.html, signals);

  // 2. The evidence gate.
  const evidence = assessEvidence(profile, { requireEvidence: options.requireEvidence });
  if (!evidence.ok) {
    return reject(candidate, evidence.reason, { profile, pages: crawl.pages });
  }
  // Only quotes that passed are kept, so nothing downstream can cite a
  // sentence the gate rejected.
  profile.evidence = evidence.usable;

  // 3. Fit.
  const fit = scoreFit(profile, options.icp);
  if (fit.band === "disqualified") {
    return reject(candidate, fit.disqualifiedBecause
      ? `Disqualified: they describe themselves as "${fit.disqualifiedBecause}".`
      : "Disqualified.", { profile, fit, pages: crawl.pages });
  }
  if (fit.score < options.minFitScore) {
    return reject(candidate, `Fit ${fit.score} is below the ${options.minFitScore} threshold. ${fit.reasons[0] ?? ""}`.trim(),
      { profile, fit, pages: crawl.pages });
  }

  // 4. Contactability.
  const contacts = await checkContacts(profile.publicContacts, options.useDns !== false);
  const contactable = contacts
    .filter((c) => c.deliverability.verdict !== "undeliverable")
    // A named individual outranks a shared inbox, and a checked address
    // outranks an unchecked one.
    .sort((a, b) => contactRank(b) - contactRank(a));

  if (contactable.length === 0) {
    return reject(
      candidate,
      contacts.length === 0
        ? "No public email address was published on their site."
        : `Every published address failed the deliverability pre-flight (${contacts[0]?.deliverability.detail}).`,
      { profile, fit, contacts, pages: crawl.pages },
    );
  }

  return {
    candidate,
    profile,
    fit,
    contacts,
    contactable,
    pages: crawl.pages,
    accepted: true,
    reason: `Fit ${fit.score} (${fit.band}), ${profile.evidence.length} quotable observation(s), ${contactable.length} contactable address(es).`,
  };
}

/**
 * The prospect's profile, built from their pages and whatever the source knew.
 *
 * Source hints are used only where the crawl is silent. A registry's
 * description of a company is second-hand; the company's own site is not.
 */
export function buildProfile(
  candidate: ProspectCandidate,
  pages: PageText[],
  html: Map<string, string>,
  signals: string[],
): LeadProfile {
  const hints = candidate.hints ?? {};
  const homeHtml = html.get(pages[0]?.url ?? "") ?? "";
  const contacts = dedupeContacts([
    // Every page's markup, because `mailto:` links do not survive text
    // extraction and /contact and /team are where the people are.
    ...pages.flatMap((page) => extractContacts(html.get(page.url) ?? `${page.text}\n${page.chrome}`, page.url, candidate.domain)),
    // An address the discovery source published, with the page that published
    // it. Ranked below a named buyer found on their own site — a package
    // maintainer is a real person who chose to publish that address, but
    // they are usually not the person who buys things.
    ...(hints.contactEmail
      ? [{
          email: hints.contactEmail,
          source: hints.contactSource ?? `${candidate.via}:${candidate.domain}`,
          kind: "individual" as const,
        }]
      : []),
  ]);

  return {
    companyName: candidate.companyName?.trim() || guessCompanyName(pages, candidate.domain),
    domain: candidate.domain,
    description: selfDescriptionFrom(pages) || hints.description,
    industry: hints.description ? undefined : undefined,
    employeeEstimate: guessEmployeeCount(pages) ?? hints.employeeEstimate,
    location: guessLocation(pages, homeHtml) ?? hints.location,
    technologies: [...new Set([...detectTechnologies(pages), ...(hints.technologies ?? [])])],
    evidence: findEvidence(pages, signals),
    publicContacts: contacts,
  };
}

function dedupeContacts(contacts: DiscoveredContact[]): DiscoveredContact[] {
  const byEmail = new Map<string, DiscoveredContact>();
  for (const contact of contacts) {
    const key = contact.email.toLowerCase();
    const existing = byEmail.get(key);
    if (!existing || richness(contact) > richness(existing)) byEmail.set(key, contact);
  }
  return [...byEmail.values()];
}

function richness(contact: DiscoveredContact): number {
  return (contact.name ? 2 : 0) + (contact.title ? 2 : 0) + (contact.kind === "individual" ? 1 : 0);
}

async function checkContacts(
  contacts: DiscoveredContact[],
  useDns: boolean,
): Promise<Array<DiscoveredContact & { deliverability: DeliverabilityCheck }>> {
  const out: Array<DiscoveredContact & { deliverability: DeliverabilityCheck }> = [];
  // One lookup per domain, not per address.
  const mxByDomain = new Map<string, Awaited<ReturnType<typeof lookupMx>>>();

  for (const contact of contacts) {
    const domain = contact.email.split("@")[1] ?? "";
    if (useDns && domain && !mxByDomain.has(domain)) {
      mxByDomain.set(domain, await lookupMx(domain));
    }
    out.push({
      ...contact,
      deliverability: checkDeliverability(contact.email, useDns ? mxByDomain.get(domain) : undefined),
    });
  }
  return out;
}

function contactRank(contact: DiscoveredContact & { deliverability: DeliverabilityCheck }): number {
  return (
    (contact.kind === "individual" ? 4 : 0) +
    (contact.title ? 2 : 0) +
    (contact.name ? 1 : 0) +
    (contact.deliverability.verdict === "deliverable" ? 3 : 0) +
    (contact.deliverability.mxChecked ? 1 : 0)
  );
}

function reject(
  candidate: ProspectCandidate,
  reason: string,
  partial: Partial<QualifiedLead> = {},
): QualifiedLead {
  return {
    candidate,
    profile: partial.profile ?? {
      companyName: candidate.companyName ?? candidate.domain,
      domain: candidate.domain,
      technologies: [],
      evidence: [],
      publicContacts: [],
    },
    fit: partial.fit ?? { score: 0, band: "poor", signals: [], reasons: [] },
    contacts: partial.contacts ?? [],
    contactable: [],
    pages: partial.pages ?? [],
    accepted: false,
    reason,
  };
}
