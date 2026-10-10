import type {
  FitBand,
  FitResult,
  FitSignal,
  FitSignalId,
  Icp,
  LeadProfile,
} from "./types";

/**
 * Relative importance of each fit dimension.
 *
 * `painSignals` outweighs everything else on purpose: a company that is
 * visibly describing the problem you solve is a far better prospect than one
 * that merely sits in the right industry with the right headcount. Firmographic
 * match is a filter; observed pain is a buying signal.
 *
 * `disqualifiers` carries weight 0 — it is an override applied in `scoreFit`,
 * not a term in the average. Scored as a weighted term it would dilute: a lead
 * that is an obvious competitor would still clear 60 on the strength of a good
 * industry and size match, and "do not contact" is not a matter of degree.
 */
export const FIT_WEIGHTS: Record<FitSignalId, number> = {
  painSignals: 30,
  industry: 25,
  size: 15,
  contactability: 12,
  technology: 10,
  geography: 8,
  disqualifiers: 0,
};

export function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whole-word keyword match.
 *
 * Substring matching is unusable here: "ai" hits "said", "crm" hits "scrm",
 * and the agent would cheerfully mail a bakery about observability tooling.
 */
export function containsKeyword(haystack: string, keyword: string): boolean {
  const k = normalise(keyword);
  if (!k) return false;
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Multi-word keywords match as a phrase; single words need boundaries.
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(
    normalise(haystack),
  );
}

export function matchedKeywords(haystack: string, keywords: string[]): string[] {
  return keywords.filter((k) => containsKeyword(haystack, k));
}

/** All text we know about a lead, flattened for keyword matching. */
export function leadCorpus(lead: LeadProfile): string {
  return normalise(
    [
      lead.companyName,
      lead.description ?? "",
      lead.industry ?? "",
      lead.location ?? "",
      lead.technologies.join(" "),
      lead.evidence.map((e) => `${e.signal} ${e.quote}`).join(" "),
    ].join(" "),
  );
}

// ---------------------------------------------------------------------------
// Individual signals
// ---------------------------------------------------------------------------

export function industrySignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.industry;
  if (icp.industries.length === 0) {
    return {
      id: "industry",
      label: "Industry",
      value: null,
      weight,
      detail: "The ICP does not constrain industry.",
    };
  }
  const corpus = leadCorpus(lead);
  const hits = matchedKeywords(corpus, icp.industries);
  if (hits.length === 0) {
    return {
      id: "industry",
      label: "Industry",
      value: 0,
      weight,
      detail: `No match against target industries (${icp.industries.slice(0, 4).join(", ")}).`,
    };
  }
  // One clear industry match is most of the signal; more is mild confirmation.
  const value = Math.min(1, 0.75 + 0.25 * (hits.length - 1));
  return {
    id: "industry",
    label: "Industry",
    value,
    weight,
    detail: `Matches target industry: ${hits.slice(0, 3).join(", ")}.`,
  };
}

export function sizeSignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.size;
  const n = lead.employeeEstimate;
  if (n === undefined) {
    return {
      id: "size",
      label: "Company size",
      value: null,
      weight,
      detail: "Headcount not published — not scored rather than guessed.",
    };
  }
  if (n >= icp.sizeMin && n <= icp.sizeMax) {
    return {
      id: "size",
      label: "Company size",
      value: 1,
      weight,
      detail: `~${n} employees, inside the target band of ${icp.sizeMin}–${icp.sizeMax}.`,
    };
  }
  // Partial credit near the edges, measured as a *ratio* to the boundary that
  // was missed rather than against the band's width.
  //
  // Deriving tolerance from the width is wrong and a test caught it: a wide
  // 50–500 ICP produced a 225-person tolerance, so a 2-person startup scored
  // 0.79 on size fit. A ratio is scale-invariant — missing the boundary by
  // 20% scores the same whether the band starts at 50 or at 5,000.
  const ratio = n < icp.sizeMin ? n / icp.sizeMin : icp.sizeMax / n;
  const FLOOR = 0.3; // at ≤30% of the boundary, size fit is zero
  const value = Math.max(0, (ratio - FLOOR) / (1 - FLOOR));
  return {
    id: "size",
    label: "Company size",
    value,
    weight,
    detail: `~${n} employees, outside the target band of ${icp.sizeMin}–${icp.sizeMax}.`,
  };
}

export function painSignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.painSignals;
  // Deduplicated: painSignals and positiveSignals overlap heavily, and
  // without this a single match on "microservices" counted twice and
  // saturated the signal at 100% off one real observation.
  const wanted = [...new Set([...icp.painSignals, ...icp.positiveSignals])];
  if (wanted.length === 0) {
    return {
      id: "painSignals",
      label: "Pain signals",
      value: null,
      weight,
      detail: "The ICP lists no observable pain signals.",
    };
  }
  const corpus = leadCorpus(lead);
  const hits = matchedKeywords(corpus, wanted);
  if (hits.length === 0) {
    return {
      id: "painSignals",
      label: "Pain signals",
      value: 0,
      weight,
      detail: "No observable evidence of the problem this product solves.",
    };
  }
  // Saturating: three distinct signals is already a strong read.
  const value = Math.min(1, hits.length / 3);
  return {
    id: "painSignals",
    label: "Pain signals",
    value,
    weight,
    detail: `Found ${hits.length} signal${hits.length === 1 ? "" : "s"}: ${hits.slice(0, 4).join(", ")}.`,
  };
}

export function technologySignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.technology;
  if (lead.technologies.length === 0) {
    return {
      id: "technology",
      label: "Technology",
      value: null,
      weight,
      detail: "No technology fingerprint detected.",
    };
  }
  const stack = normalise(lead.technologies.join(" "));
  const hits = matchedKeywords(stack, icp.positiveSignals);
  return {
    id: "technology",
    label: "Technology",
    value: hits.length > 0 ? Math.min(1, hits.length / 2) : 0.2,
    weight,
    detail:
      hits.length > 0
        ? `Stack overlaps the ICP: ${hits.slice(0, 3).join(", ")}.`
        : `Stack detected (${lead.technologies.slice(0, 3).join(", ")}) but no ICP overlap.`,
  };
}

export function geographySignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.geography;
  if (icp.geographies.length === 0) {
    return {
      id: "geography",
      label: "Geography",
      value: null,
      weight,
      detail: "The ICP does not constrain geography.",
    };
  }
  if (!lead.location) {
    return {
      id: "geography",
      label: "Geography",
      value: null,
      weight,
      detail: "Location not published.",
    };
  }
  const hits = matchedKeywords(lead.location, icp.geographies);
  return {
    id: "geography",
    label: "Geography",
    value: hits.length > 0 ? 1 : 0,
    weight,
    detail:
      hits.length > 0
        ? `${lead.location} is in the target geography.`
        : `${lead.location} is outside the target geography.`,
  };
}

/**
 * Can we actually reach a buyer here?
 *
 * A perfect-fit company with no reachable contact is worth nothing to a sales
 * agent, so this is scored rather than assumed. A named individual in a buying
 * role beats a generic info@ inbox.
 */
export function contactabilitySignal(lead: LeadProfile, icp: Icp): FitSignal {
  const weight = FIT_WEIGHTS.contactability;
  if (lead.publicContacts.length === 0) {
    return {
      id: "contactability",
      label: "Contactability",
      value: 0,
      weight,
      detail: "No publicly published contact address found.",
    };
  }
  const titles = icp.buyerTitles.map(normalise);
  const named = lead.publicContacts.filter((c) => c.kind === "individual");
  const onTarget = named.filter(
    (c) => c.title && titles.some((t) => containsKeyword(c.title!, t)),
  );

  if (onTarget.length > 0) {
    return {
      id: "contactability",
      label: "Contactability",
      value: 1,
      weight,
      detail: `Published contact in a buying role: ${onTarget[0]!.title}.`,
    };
  }
  if (named.length > 0) {
    return {
      id: "contactability",
      label: "Contactability",
      value: 0.7,
      weight,
      detail: "Named contact published, but not in a listed buying role.",
    };
  }
  return {
    id: "contactability",
    label: "Contactability",
    value: 0.4,
    weight,
    detail: "Only a shared role inbox is published.",
  };
}

/**
 * How a company describes *itself* — name, tagline, industry.
 *
 * Distinct from `leadCorpus` on purpose. Disqualifiers must be matched
 * against this and not against every word on the site, because the two mean
 * completely different things: a prospect whose engineering blog discusses
 * "error budget tracking" is a textbook buyer, while a company whose homepage
 * says it *is* an error budget tracking platform is a competitor.
 */
export function selfDescription(lead: LeadProfile): string {
  return normalise([lead.companyName, lead.description ?? "", lead.industry ?? ""].join(" "));
}

/**
 * Hard stops. Returns the matched disqualifier, or null.
 *
 * Matched against the self-description only. An earlier version searched the
 * whole crawled corpus and had the opposite failure: it disqualified good
 * prospects for discussing the problem, while still enrolling a direct
 * competitor whose homepage never happened to mention the seller by name.
 */
export function findDisqualifier(lead: LeadProfile, icp: Icp): string | null {
  if (icp.negativeSignals.length === 0) return null;
  const hits = matchedKeywords(selfDescription(lead), icp.negativeSignals);
  return hits[0] ?? null;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const BANDS: ReadonlyArray<{ min: number; band: FitBand }> = [
  { min: 75, band: "strong" },
  { min: 55, band: "good" },
  { min: 35, band: "marginal" },
  { min: 0, band: "poor" },
];

export function bandFor(score: number): FitBand {
  return (BANDS.find((b) => score >= b.min) ?? BANDS[BANDS.length - 1]!).band;
}

export function scoreFit(lead: LeadProfile, icp: Icp): FitResult {
  const disqualifier = findDisqualifier(lead, icp);

  const signals: FitSignal[] = [
    painSignal(lead, icp),
    industrySignal(lead, icp),
    sizeSignal(lead, icp),
    contactabilitySignal(lead, icp),
    technologySignal(lead, icp),
    geographySignal(lead, icp),
    {
      id: "disqualifiers",
      label: "Disqualifiers",
      value: disqualifier ? 1 : 0,
      weight: 0,
      detail: disqualifier
        ? `Hard disqualifier matched: "${disqualifier}".`
        : "No disqualifying signals.",
    },
  ];

  if (disqualifier) {
    return {
      score: 0,
      band: "disqualified",
      signals,
      reasons: [`Disqualified: "${disqualifier}" found on their site.`],
      disqualifiedBecause: disqualifier,
    };
  }

  // Weight-0 signals are overrides, not terms. Unknown signals leave the
  // denominator entirely so an unpublished headcount neither helps nor hurts.
  const scorable = signals.filter(
    (s): s is FitSignal & { value: number } => s.value !== null && s.weight > 0,
  );
  const totalWeight = scorable.reduce((sum, s) => sum + s.weight, 0);
  const score =
    totalWeight === 0
      ? 0
      : Math.round(
          (scorable.reduce((sum, s) => sum + s.value * s.weight, 0) / totalWeight) * 100,
        );

  const reasons = scorable
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value * b.weight - a.value * a.weight)
    .map((s) => s.detail);

  return {
    score: Math.min(100, Math.max(0, score)),
    band: bandFor(score),
    signals,
    reasons,
  };
}
