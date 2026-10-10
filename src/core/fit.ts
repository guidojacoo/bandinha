import { isUsableQuote } from "./evidence";
import type { FitBand, FitResult, FitSignal, FitSignalId, Icp, LeadProfile } from "./types";

/**
 * Fit scoring.
 *
 * `evidence` outweighs everything else, and that ordering is the product's
 * whole argument: a company visibly describing the problem you solve is a far
 * better prospect than one that merely sits in the right industry at the
 * right headcount. Firmographics are a filter; observed pain is a buying
 * signal.
 *
 * `disqualifiers` carries weight 0 — it is an override applied in `scoreFit`,
 * not a term in the average. As a weighted term, an obvious competitor still
 * cleared 60 on industry and size and got mailed.
 */
export const FIT_WEIGHTS: Record<FitSignalId, number> = {
  evidence: 32,
  industry: 22,
  contactability: 16,
  size: 14,
  technology: 10,
  geography: 6,
  disqualifiers: 0,
};

export function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whole-word keyword matching.
 *
 * Substring matching is unusable: "ai" hits "said", "crm" hits "scrm", and
 * the agent cheerfully mails a bakery about observability tooling.
 */
export function containsKeyword(haystack: string, keyword: string): boolean {
  const k = normalise(keyword);
  if (!k) return false;
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(normalise(haystack));
}

export function matchedKeywords(haystack: string, keywords: string[]): string[] {
  return [...new Set(keywords)].filter((k) => containsKeyword(haystack, k));
}

export function leadCorpus(lead: LeadProfile): string {
  return normalise([
    lead.companyName, lead.description ?? "", lead.industry ?? "", lead.location ?? "",
    lead.technologies.join(" "),
    lead.evidence.map((e) => `${e.signal} ${e.quote}`).join(" "),
  ].join(" "));
}

/**
 * How a company describes *itself* — name, tagline, industry.
 *
 * Disqualifiers match against this and not the whole crawl, because the two
 * mean opposite things: a prospect whose engineering blog discusses your
 * problem space is a textbook buyer, while a company whose homepage says it
 * *is* your product is a competitor.
 */
export function selfDescription(lead: LeadProfile): string {
  return normalise([lead.companyName, lead.description ?? "", lead.industry ?? ""].join(" "));
}

// --- signals ---------------------------------------------------------------

/** Quotable, specific observations about this company. The headline signal. */
export function evidenceSignal(lead: LeadProfile): FitSignal {
  const weight = FIT_WEIGHTS.evidence;
  const usable = lead.evidence.filter((e) => isUsableQuote(e.quote));
  const distinctSignals = new Set(usable.map((e) => e.signal)).size;

  if (usable.length === 0) {
    return {
      id: "evidence", label: "Evidence", value: 0, weight,
      detail: "Nothing specific enough to write about was found on their site.",
    };
  }
  // One usable quote is already enough to write a specific email — that is
  // exactly what the evidence gate in `core/evidence.ts` certifies. Scoring
  // it 0.33 would contradict the gate and bury good leads under
  // firmographics. Extra distinct signals mean we understand them better.
  const value = Math.min(1, 0.7 + 0.15 * (distinctSignals - 1));
  return {
    id: "evidence", label: "Evidence", value, weight,
    detail: `${usable.length} quotable observation${usable.length === 1 ? "" : "s"} covering ${distinctSignals} signal${distinctSignals === 1 ? "" : "s"}.`,
  };
}

export function industrySignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.industry;
  if (icp.industries.length === 0) {
    return { id: "industry", label: "Industry", value: null, weight, detail: "The ICP does not constrain industry." };
  }
  const hits = matchedKeywords(leadCorpus(lead), icp.industries);
  if (hits.length === 0) {
    return {
      id: "industry", label: "Industry", value: 0, weight,
      detail: `No match against ${icp.industries.slice(0, 4).join(", ")}.`,
    };
  }
  return {
    id: "industry", label: "Industry", value: Math.min(1, 0.75 + 0.25 * (hits.length - 1)), weight,
    detail: `Matches: ${hits.slice(0, 3).join(", ")}.`,
  };
}

export function sizeSignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.size;
  const n = lead.employeeEstimate;
  if (n === undefined) {
    return { id: "size", label: "Company size", value: null, weight, detail: "Headcount not published — not scored rather than guessed." };
  }
  if (n >= icp.sizeMin && n <= icp.sizeMax) {
    return { id: "size", label: "Company size", value: 1, weight, detail: `~${n} employees, inside ${icp.sizeMin}–${icp.sizeMax}.` };
  }
  // Ratio to the boundary that was missed, not to the band's width. Deriving
  // tolerance from width gave a wide 50–500 ICP a 225-person tolerance, so a
  // 2-person startup scored 0.79 on size fit.
  const ratio = n < icp.sizeMin ? n / icp.sizeMin : icp.sizeMax / n;
  const FLOOR = 0.3;
  return {
    id: "size", label: "Company size", value: Math.max(0, (ratio - FLOOR) / (1 - FLOOR)), weight,
    detail: `~${n} employees, outside ${icp.sizeMin}–${icp.sizeMax}.`,
  };
}

export function technologySignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.technology;
  if (lead.technologies.length === 0) {
    return { id: "technology", label: "Technology", value: null, weight, detail: "No technology fingerprint detected." };
  }
  const hits = matchedKeywords(lead.technologies.join(" "), icp.positiveSignals);
  return {
    id: "technology", label: "Technology", value: hits.length > 0 ? Math.min(1, hits.length / 2) : 0.2, weight,
    detail: hits.length > 0
      ? `Stack overlaps the ICP: ${hits.slice(0, 3).join(", ")}.`
      : `Stack detected (${lead.technologies.slice(0, 3).join(", ")}) but no ICP overlap.`,
  };
}

export function geographySignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.geography;
  if (icp.geographies.length === 0) {
    return { id: "geography", label: "Geography", value: null, weight, detail: "The ICP does not constrain geography." };
  }
  if (!lead.location) {
    return { id: "geography", label: "Geography", value: null, weight, detail: "Location not published." };
  }
  const hits = matchedKeywords(lead.location, icp.geographies);
  return {
    id: "geography", label: "Geography", value: hits.length > 0 ? 1 : 0, weight,
    detail: hits.length > 0 ? `${lead.location} is in the target geography.` : `${lead.location} is outside it.`,
  };
}

/** A perfect-fit company with nobody reachable is worth nothing to a seller. */
export function contactabilitySignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.contactability;
  if (lead.publicContacts.length === 0) {
    return { id: "contactability", label: "Contactability", value: 0, weight, detail: "No published contact address found." };
  }
  const named = lead.publicContacts.filter((c) => c.kind === "individual");
  const onTarget = named.filter((c) => c.title && icp.buyerTitles.some((t) => containsKeyword(c.title!, t)));

  if (onTarget.length > 0) {
    return { id: "contactability", label: "Contactability", value: 1, weight, detail: `Published contact in a buying role: ${onTarget[0]!.title}.` };
  }
  if (named.length > 0) {
    return { id: "contactability", label: "Contactability", value: 0.7, weight, detail: "Named contact published, but not in a listed buying role." };
  }
  return { id: "contactability", label: "Contactability", value: 0.4, weight, detail: "Only a shared role inbox is published." };
}

export function findDisqualifier(lead: LeadProfile, icp: Icp): string | null {
  if (icp.negativeSignals.length === 0) return null;
  return matchedKeywords(selfDescription(lead), icp.negativeSignals)[0] ?? null;
}

// --- composition -----------------------------------------------------------

const BANDS: ReadonlyArray<{ min: number; band: FitBand }> = [
  { min: 75, band: "strong" }, { min: 55, band: "good" },
  { min: 35, band: "marginal" }, { min: 0, band: "poor" },
];

export function bandFor(score: number): FitBand {
  return (BANDS.find((b) => score >= b.min) ?? BANDS[BANDS.length - 1]!).band;
}

export function scoreFit(lead: LeadProfile, icp: Icp): FitResult {
  const disqualifier = findDisqualifier(lead, icp);

  const signals: FitSignal[] = [
    evidenceSignal(lead),
    industrySignal(lead, icp),
    contactabilitySignal(lead, icp),
    sizeSignal(lead, icp),
    technologySignal(lead, icp),
    geographySignal(lead, icp),
    {
      id: "disqualifiers", label: "Disqualifiers", value: disqualifier ? 1 : 0, weight: 0,
      detail: disqualifier ? `Matched "${disqualifier}" in how they describe themselves.` : "No disqualifying signals.",
    },
  ];

  if (disqualifier) {
    return {
      score: 0, band: "disqualified", signals,
      reasons: [`Disqualified: they describe themselves as "${disqualifier}".`],
      disqualifiedBecause: disqualifier,
    };
  }

  // Weight-0 signals are overrides, not terms. Unknown signals leave the
  // denominator entirely, so an unpublished headcount neither helps nor hurts.
  const scorable = signals.filter((s): s is FitSignal & { value: number } => s.value !== null && s.weight > 0);
  const totalWeight = scorable.reduce((sum, s) => sum + s.weight, 0);
  const score = totalWeight === 0 ? 0
    : Math.round((scorable.reduce((sum, s) => sum + s.value * s.weight, 0) / totalWeight) * 100);

  return {
    score: Math.min(100, Math.max(0, score)),
    band: bandFor(score),
    signals,
    reasons: scorable.filter((s) => s.value > 0)
      .sort((a, b) => b.value * b.weight - a.value * a.weight)
      .map((s) => s.detail),
  };
}
