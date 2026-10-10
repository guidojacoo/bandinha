import type { Icp, Offering, SourcedClaim } from "./types";

/**
 * Turning "what we sell" into "who to go find, and where".
 *
 * Two jobs, both pure:
 *
 *  1. Derive an ICP from a crawl of the seller's own site. An LLM does this
 *     better, so its output is normalised here rather than replaced — but the
 *     heuristic path has to stand on its own, because the free LLM tier runs
 *     out and the agent must keep working when it does.
 *
 *  2. Route the ICP to discovery sources. This is where "100% free" is won or
 *     lost. Paid tools buy one universal database; we have several free,
 *     partial ones, so the ICP has to pick. A developer tool prospects
 *     GitHub, a local service prospects OpenStreetMap, and getting that
 *     choice wrong wastes the whole run.
 */

// ---------------------------------------------------------------------------
// Competitor detection
// ---------------------------------------------------------------------------

/**
 * Words with no business meaning, stripped before phrase extraction.
 *
 * Deliberately grammatical only. An earlier version stripped "service",
 * "platform" and "solution" as filler, which destroyed the phrase "service
 * level objectives" — the seller's actual category — and the agent then
 * enrolled a direct competitor as a lead.
 */
const GRAMMATICAL = new Set([
  "a", "an", "the", "and", "or", "but", "for", "of", "to", "in", "on", "at",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "that", "this", "these", "those", "it", "its", "we", "our", "us", "you",
  "your", "they", "their", "all", "any", "more", "most", "other", "into",
  "than", "then", "so", "no", "not", "can", "will", "just", "about", "over",
  "up", "out", "if", "when", "while", "each", "every", "both", "own",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Two- and three-word phrases, grammatical words trimmed from the edges. */
function phrases(text: string): string[] {
  const w = words(text);
  const out: string[] = [];
  for (let n = 3; n >= 2; n--) {
    for (let i = 0; i + n <= w.length; i++) {
      const span = w.slice(i, i + n);
      const first = span[0] ?? "";
      const last = span[span.length - 1] ?? "";
      if (GRAMMATICAL.has(first) || GRAMMATICAL.has(last)) continue;
      if (span.some((x) => x.length < 3)) continue;
      out.push(span.join(" "));
    }
  }
  return out;
}

/**
 * Phrases that mean "this company sells what we sell".
 *
 * Weighted by where they appear. Page titles and taglines describe what a
 * company *is*; body prose describes what it talks about. Without the
 * weighting, a seller's own product name repeated across three page titles
 * crowds out the category phrase that actually identifies competitors.
 */
export function competitorPhrases(offering: Offering, limit = 10): string[] {
  const scores = new Map<string, number>();
  // Each phrase scores at most once per text. Raw repetition is not
  // evidence: a word said twenty times in one paragraph of marketing prose
  // used to outrank the category phrase in the company's own tagline.
  const bump = (text: string, weight: number) => {
    for (const phrase of new Set(phrases(text))) {
      scores.set(phrase, (scores.get(phrase) ?? 0) + weight);
    }
  };

  for (const p of offering.positioningPhrases) bump(p, 8);
  bump(offering.oneLiner, 6);
  for (const c of offering.categories) bump(c, 6);
  for (const product of offering.products) {
    bump(product.name, 3);
    bump(product.summary, 1);
    for (const capability of product.capabilities) bump(capability, 2);
  }
  for (const claim of offering.valueProps) bump(claim.text, 1);

  // The seller's own name is not a category; matching on it flags anyone who
  // merely mentions them.
  const ownName = words(offering.companyName);
  const isSelfReference = (phrase: string) =>
    phrase.split(" ").some((token) => ownName.includes(token));

  const ranked = [...scores.entries()]
    .filter(([phrase]) => !isSelfReference(phrase))
    // On a tie the longer phrase wins: it is the more specific category, and
    // the shorter one is usually just a window onto it.
    .sort((a, b) =>
      b[1] - a[1] ||
      b[0].split(" ").length - a[0].split(" ").length ||
      a[0].localeCompare(b[0]));

  // Drop phrases wholly contained in one already kept. "budget tracking"
  // adds nothing next to "error budget tracking" and costs a slot.
  const kept: string[] = [];
  for (const [phrase] of ranked) {
    if (kept.some((k) => k.includes(phrase))) continue;
    kept.push(phrase);
    if (kept.length >= limit) break;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Source routing
// ---------------------------------------------------------------------------

export type SourceId =
  | "github" | "npm" | "pypi" | "osm" | "directory" | "search" | "seed";

/**
 * Which free sources can plausibly find this ICP, and what to ask them.
 *
 * Each entry has a cheap test against the seller's own language. Order
 * matters: the first matching profile wins the top slot, and discovery works
 * down the list until it has enough leads.
 */
interface SourceProfile {
  id: SourceId;
  /** Words in the seller's copy that imply this source has the buyers. */
  cues: RegExp;
  /** Where its queries come from. */
  hint: (offering: Offering, icp: Partial<Icp>) => string[];
}

const DEV_CUES =
  /\b(api|sdk|cli|developer|devops|sre|engineer|engineering|kubernetes|docker|ci\/?cd|pipeline|repo(sitor(y|ies))?|open ?source|library|framework|typescript|javascript|python|golang|rust|observability|microservices?|webhook|oauth|latency|deploy(ment)?s?|backend|frontend|infrastructure|database|serverless|terraform|runtime|compiler|package)\b/i;

const LOCAL_CUES =
  /\b(restaurant|cafe|caf[eé]|bar|hotel|salon|barber|clinic|dentist|dental|gym|fitness|studio|store|shop|retail|boutique|bakery|plumb(er|ing)|electrician|contractor|landscap(er|ing)|roofing|hvac|garage|mechanic|veterinar|pharmacy|florist|laundry|local business|walk[- ]in|foot traffic|storefront|neighbourhood|neighborhood)\b/i;

const NPM_CUES = /\b(npm|node\.?js|javascript|typescript|react|next\.?js|frontend|web app)\b/i;
const PYPI_CUES = /\b(pypi|python|django|flask|fastapi|pandas|data ?science|machine learning|notebook)\b/i;

const SOURCE_PROFILES: SourceProfile[] = [
  {
    id: "github",
    cues: DEV_CUES,
    hint: (offering, icp) => uniqueLower([
      ...offering.categories,
      ...(icp.painSignals ?? []).filter((s) => DEV_CUES.test(s)),
      ...technologyTerms(offering),
    ]).slice(0, 12),
  },
  {
    id: "npm",
    cues: NPM_CUES,
    hint: (offering) => uniqueLower(technologyTerms(offering)).slice(0, 8),
  },
  {
    id: "pypi",
    cues: PYPI_CUES,
    hint: (offering) => uniqueLower(technologyTerms(offering)).slice(0, 8),
  },
  {
    id: "osm",
    cues: LOCAL_CUES,
    hint: (offering, icp) => uniqueLower([
      ...osmTags(`${offering.oneLiner} ${offering.categories.join(" ")} ${(icp.industries ?? []).join(" ")}`),
    ]).slice(0, 10),
  },
  {
    id: "directory",
    // Always plausible: someone has published a list of these companies.
    cues: /.*/,
    hint: (offering, icp) => uniqueLower([
      ...(icp.industries ?? []),
      ...offering.categories,
    ]).slice(0, 10),
  },
  {
    id: "search",
    cues: /.*/,
    hint: (offering, icp) => searchQueries(offering, icp).slice(0, 8),
  },
];

/** OpenStreetMap tag values, which are a fixed vocabulary we must map onto. */
const OSM_TAG_MAP: Array<[RegExp, string]> = [
  [/\brestaurants?\b|\bdining\b|\bmenu\b/i, "amenity=restaurant"],
  [/\bcaf[eé]s?\b|\bcoffee\b/i, "amenity=cafe"],
  [/\bbars?\b|\bpubs?\b/i, "amenity=bar"],
  [/\bhotels?\b|\bhospitality\b|\bguesthouse\b/i, "tourism=hotel"],
  [/\bsalons?\b|\bhairdress|\bbarber/i, "shop=hairdresser"],
  [/\bdent(al|ist)/i, "amenity=dentist"],
  [/\bclinics?\b|\bdoctors?\b|\bmedical\b/i, "amenity=clinic"],
  [/\bveterinar/i, "amenity=veterinary"],
  [/\bgyms?\b|\bfitness\b/i, "leisure=fitness_centre"],
  [/\bbakery|\bbakeries\b/i, "shop=bakery"],
  [/\bpharmac/i, "amenity=pharmacy"],
  [/\bflorists?\b/i, "shop=florist"],
  [/\bgarages?\b|\bmechanics?\b|\bauto ?repair\b/i, "shop=car_repair"],
  [/\bplumb/i, "craft=plumber"],
  [/\belectrician/i, "craft=electrician"],
  [/\broofing\b/i, "craft=roofer"],
  [/\blandscap/i, "craft=gardener"],
  [/\bretail\b|\bstores?\b|\bshops?\b|\bboutique\b/i, "shop=*"],
];

function osmTags(text: string): string[] {
  return OSM_TAG_MAP.filter(([pattern]) => pattern.test(text)).map(([, tag]) => tag);
}

const TECH_VOCAB = [
  "kubernetes", "docker", "terraform", "prometheus", "grafana", "datadog",
  "opentelemetry", "postgres", "postgresql", "mysql", "redis", "kafka",
  "typescript", "javascript", "python", "golang", "rust", "java", "ruby",
  "php", "react", "nextjs", "vue", "django", "flask", "fastapi", "rails",
  "aws", "gcp", "azure", "vercel", "cloudflare", "lambda", "serverless",
  "graphql", "grpc", "rest", "webhook", "oauth", "saml", "openapi",
  "microservices", "observability", "sre", "devops", "cicd", "github",
  "gitlab", "jenkins", "airflow", "dbt", "snowflake", "spark",
];

function technologyTerms(offering: Offering): string[] {
  const haystack = [
    offering.oneLiner,
    offering.categories.join(" "),
    offering.positioningPhrases.join(" "),
    ...offering.products.flatMap((p) => [p.summary, ...p.capabilities]),
    ...offering.valueProps.map((v) => v.text),
  ].join(" ").toLowerCase();
  return TECH_VOCAB.filter((term) => new RegExp(`\\b${escapeRegex(term)}\\b`).test(haystack));
}

function searchQueries(offering: Offering, icp: Partial<Icp>): string[] {
  const industries = (icp.industries ?? offering.categories).slice(0, 4);
  const geographies = (icp.geographies ?? []).slice(0, 2);
  const out: string[] = [];
  for (const industry of industries) {
    out.push(`${industry} companies`);
    for (const geo of geographies) out.push(`${industry} companies ${geo}`);
  }
  for (const signal of (icp.painSignals ?? []).slice(0, 3)) out.push(`"${signal}"`);
  return uniqueLower(out);
}

/**
 * Picks sources for an ICP, best first.
 *
 * `seed` is always last and always present: an operator-supplied list of
 * domains is the one source that cannot fail, and the agent must never be
 * stuck with nowhere to look.
 */
export function routeSources(
  offering: Offering,
  icp: Partial<Icp> = {},
): { preferredSources: string[]; sourceHints: Record<string, string[]> } {
  const haystack = [
    offering.oneLiner,
    offering.categories.join(" "),
    offering.positioningPhrases.join(" "),
    (icp.industries ?? []).join(" "),
    (icp.painSignals ?? []).join(" "),
    (icp.buyerTitles ?? []).join(" "),
    ...offering.products.flatMap((p) => [p.name, p.summary, ...p.capabilities]),
  ].join(" ");

  const preferredSources: string[] = [];
  const sourceHints: Record<string, string[]> = {};

  for (const profile of SOURCE_PROFILES) {
    if (!profile.cues.test(haystack)) continue;
    const hints = profile.hint(offering, icp);
    // A source with nothing to ask for is worse than no source: it returns
    // whatever is popular, and the agent writes to strangers.
    if (hints.length === 0 && profile.id !== "seed") continue;
    preferredSources.push(profile.id);
    sourceHints[profile.id] = hints;
  }

  preferredSources.push("seed");
  sourceHints.seed ??= [];
  return { preferredSources, sourceHints };
}

// ---------------------------------------------------------------------------
// ICP derivation
// ---------------------------------------------------------------------------

/** Buyer titles implied by the seller's own vocabulary. */
const TITLE_RULES: Array<[RegExp, string[]]> = [
  [DEV_CUES, ["VP Engineering", "Head of Engineering", "Engineering Manager", "CTO", "Platform Lead", "SRE Lead"]],
  [/\b(security|compliance|soc ?2|iso ?27001|vulnerab|pentest|threat)\b/i, ["CISO", "Head of Security", "Security Engineer", "Head of Compliance"]],
  [/\b(marketing|seo|campaign|brand|content|social media|ads?)\b/i, ["Head of Marketing", "Marketing Manager", "Growth Lead", "CMO"]],
  [/\b(sales|pipeline|crm|quota|outbound|lead gen)\b/i, ["VP Sales", "Head of Sales", "Sales Manager", "Revenue Operations"]],
  [/\b(support|helpdesk|ticket|customer success|csat)\b/i, ["Head of Support", "Customer Success Manager", "Support Lead"]],
  [/\b(payroll|invoic|accounting|bookkeep|finance|expense)\b/i, ["Finance Director", "Controller", "Head of Finance", "CFO"]],
  [/\b(recruit|hiring|onboarding|hr\b|people ops)\b/i, ["Head of People", "Talent Lead", "HR Manager"]],
  [/\b(logistics|shipping|warehouse|inventory|supply chain)\b/i, ["Operations Director", "Head of Logistics", "Supply Chain Manager"]],
  [LOCAL_CUES, ["Owner", "General Manager", "Operations Manager"]],
];

/**
 * A baseline ICP from the seller's own site, with no LLM.
 *
 * Note what it refuses to do: if the crawl does not establish an industry, it
 * leaves `industries` empty rather than filling it with frequent keywords.
 * An earlier version guessed from word frequency and produced
 * `["bristol", "budget", "kingdom"]` — scraped from the seller's own postal
 * address — so every UK company scored as a perfect industry match. An empty
 * list costs one scoring signal; a wrong list silently corrupts every score.
 */
export function inferIcp(offering: Offering): Icp {
  const haystack = [
    offering.oneLiner,
    offering.categories.join(" "),
    offering.positioningPhrases.join(" "),
    ...offering.products.flatMap((p) => [p.name, p.summary, ...p.capabilities]),
    ...offering.valueProps.map((v) => v.text),
  ].join(" ");

  const buyerTitles = uniqueKeepCase(
    TITLE_RULES.filter(([pattern]) => pattern.test(haystack)).flatMap(([, titles]) => titles),
  );

  const painSignals = uniqueLower([
    ...offering.products.flatMap((p) => p.capabilities),
    ...offering.valueProps.map((v) => v.text),
  ].flatMap(problemPhrases)).slice(0, 14);

  const positiveSignals = uniqueLower([
    ...technologyTerms(offering),
    ...offering.categories,
  ]).slice(0, 12);

  const base: Icp = {
    industries: uniqueLower(offering.categories).slice(0, 8),
    sizeMin: LOCAL_CUES.test(haystack) ? 2 : 20,
    sizeMax: LOCAL_CUES.test(haystack) ? 80 : 800,
    buyerTitles: buyerTitles.length > 0 ? buyerTitles : ["Founder", "Owner", "Operations Manager"],
    painSignals,
    positiveSignals,
    negativeSignals: competitorPhrases(offering),
    geographies: [],
    summary: offering.categories.length > 0
      ? `Companies in ${offering.categories.slice(0, 3).join(", ")} showing the problems ${offering.companyName} solves.`
      : `Companies showing the problems ${offering.companyName} solves, by the words on their own site.`,
    preferredSources: [],
    sourceHints: {},
  };

  return { ...base, ...routeSources(offering, base) };
}

/**
 * Short phrases describing a problem, pulled from benefit copy.
 *
 * "Stop losing deals to slow follow-up" yields "slow follow-up": the words a
 * prospect with that problem writes on their own careers page.
 */
function problemPhrases(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:stop|avoid|prevent|eliminate|reduce|cut|fix|solve|replace)\s+((?:\w+\s+){0,3}\w+)/gi,
    /\b(?:without|no more|tired of|struggling with|instead of)\s+((?:\w+\s+){0,3}\w+)/gi,
    /\b(?:slow|manual|broken|missing|outdated|expensive|unreliable|inconsistent)\s+((?:\w+\s+){0,2}\w+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const phrase = (match[1] ?? "")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !GRAMMATICAL.has(w.toLowerCase()))
        .join(" ")
        .toLowerCase();
      if (phrase.length >= 5) out.push(phrase);
    }
  }
  return out;
}

/**
 * Sanitises an ICP that came from an LLM.
 *
 * The model is good at this and wrong about it often enough to matter: it
 * returns size bands backwards, keyword lists of 200 entries, and industries
 * copied verbatim from the seller's address block. Everything it returns is
 * clamped, trimmed, and re-routed to sources here rather than trusted.
 */
export function normaliseIcp(partial: Partial<Icp>, offering: Offering): Icp {
  const fallback = inferIcp(offering);

  const industries = uniqueLower(partial.industries ?? []).filter(isPlausibleIndustry).slice(0, 10);
  let sizeMin = clampInt(partial.sizeMin, 1, 500_000, fallback.sizeMin);
  let sizeMax = clampInt(partial.sizeMax, 1, 500_000, fallback.sizeMax);
  if (sizeMin > sizeMax) [sizeMin, sizeMax] = [sizeMax, sizeMin];

  const icp: Icp = {
    industries,
    sizeMin,
    sizeMax,
    buyerTitles: uniqueKeepCase(partial.buyerTitles ?? []).slice(0, 12).length > 0
      ? uniqueKeepCase(partial.buyerTitles ?? []).slice(0, 12)
      : fallback.buyerTitles,
    painSignals: uniqueLower(partial.painSignals ?? []).filter(isPlausibleSignal).slice(0, 16),
    positiveSignals: uniqueLower(partial.positiveSignals ?? []).filter(isPlausibleSignal).slice(0, 16),
    // Competitor phrases are always merged in, never replaced: the model is
    // reliably bad at naming its own operator's competitors, and the cost of
    // missing one is an email to a rival.
    negativeSignals: uniqueLower([
      ...(partial.negativeSignals ?? []),
      ...fallback.negativeSignals,
    ]).filter(isPlausibleSignal).slice(0, 16),
    geographies: uniqueLower(partial.geographies ?? []).slice(0, 8),
    summary: (partial.summary ?? fallback.summary).slice(0, 400),
    preferredSources: [],
    sourceHints: {},
  };

  if (icp.painSignals.length === 0) icp.painSignals = fallback.painSignals;
  if (icp.positiveSignals.length === 0) icp.positiveSignals = fallback.positiveSignals;

  const routed = routeSources(offering, icp);
  // An explicit source preference from the caller is honoured, but only for
  // sources that actually exist.
  const requested = (partial.preferredSources ?? []).filter((s) =>
    routed.preferredSources.includes(s) || s === "seed",
  );
  return {
    ...icp,
    preferredSources: uniqueLower([...requested, ...routed.preferredSources]),
    sourceHints: { ...routed.sourceHints, ...(partial.sourceHints ?? {}) },
  };
}

/** Rejects address fragments and single letters masquerading as industries. */
function isPlausibleIndustry(value: string): boolean {
  if (value.length < 3 || value.length > 40) return false;
  if (/^\d/.test(value)) return false;
  if (/\b(street|road|avenue|suite|floor|bldg|building|po box|postcode|zip)\b/.test(value)) return false;
  return !GRAMMATICAL.has(value);
}

function isPlausibleSignal(value: string): boolean {
  return value.length >= 4 && value.length <= 60 && !GRAMMATICAL.has(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function uniqueLower(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function uniqueKeepCase(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type { SourcedClaim };
