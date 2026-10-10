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
  "by", "with", "without", "from", "as", "is", "are", "was", "were", "be", "been",
  "that", "this", "these", "those", "it", "its", "we", "our", "us", "you",
  "your", "they", "their", "all", "any", "more", "most", "other", "into",
  "than", "then", "so", "no", "not", "can", "will", "just", "about", "over",
  "up", "out", "if", "when", "while", "each", "every", "both", "own",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    // Dots and hyphens are kept so "node.js" and "on-call" survive as single
    // tokens, then trimmed from the edges so a sentence-final token does not
    // become the phrase "actually breaking.".
    .replace(/[^a-z0-9+#.\- ]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter(Boolean);
}

/**
 * Nouns that name the *buyer*, not the category.
 *
 * "platform teams" came out of the seller's own tagline as a top competitor
 * phrase, and disqualifiers are matched against how a prospect describes
 * itself — so any prospect calling itself a platform team would have been
 * thrown away as a competitor.
 */
const BUYER_NOUNS = new Set([
  "teams", "team", "companies", "company", "customers", "clients", "users",
  "businesses", "business", "engineers", "developers", "operators",
  "organisations", "organizations", "orgs", "startups", "enterprises",
  "practices", "agencies", "firms", "brands", "owners", "managers", "people",
]);

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
  for (const c of offering.categories) bump(c, 8);
  for (const product of offering.products) {
    for (const capability of product.capabilities) bump(capability, 4);
    bump(product.name, 3);
  }
  // The one-liner and the benefit copy are deliberately NOT mined. They mix
  // what a company *is* with who it sells to and what it does for them, so
  // phrases drawn from them disqualify customers as often as competitors.

  // The seller's own name is not a category; matching on it flags anyone who
  // merely mentions them.
  const ownName = words(offering.companyName);
  const isSelfReference = (phrase: string) =>
    phrase.split(" ").some((token) => ownName.includes(token));

  const ranked = [...scores.entries()]
    .filter(([phrase]) => !isSelfReference(phrase))
    .filter(([phrase]) => !BUYER_NOUNS.has(phrase.split(" ").slice(-1)[0] ?? ""))
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
  | "github" | "npm" | "rubygems" | "crates" | "hex" | "packagist"
  | "osm" | "directory" | "search" | "seed";

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

/**
 * The package registries, and the words that mean one is worth asking first.
 *
 * npm is the default simply because it is an order of magnitude larger than
 * the rest; the others win when the seller's own copy says which ecosystem it
 * lives in. A Laravel vendor's buyers publish on Packagist, and asking npm
 * first wastes the run's best queries on the wrong market.
 */
const REGISTRY_ECOSYSTEM_CUES: Array<{ id: SourceId; cues: RegExp }> = [
  { id: "npm", cues: /\b(npm|node\.?js|javascript|typescript|react|next\.?js|vue|angular|svelte|deno|bun|frontend|web app)\b/i },
  { id: "packagist", cues: /\b(php|composer|packagist|laravel|symfony|wordpress|woocommerce|drupal|magento)\b/i },
  { id: "rubygems", cues: /\b(ruby|rubygems|rails|ruby on rails|sidekiq|hotwire|sinatra)\b/i },
  { id: "crates", cues: /\b(rust|crates?\.io|cargo|tokio|wasm|webassembly)\b/i },
  { id: "hex", cues: /\b(elixir|erlang|hex\.pm|phoenix|beam|otp)\b/i },
];

const REGISTRY_IDS: SourceId[] = REGISTRY_ECOSYSTEM_CUES.map((entry) => entry.id);

/**
 * Orders the registries by which ecosystem the seller actually sells into.
 *
 * Named cues beat size: a seller whose site says "Laravel" gets Packagist
 * first even though npm is larger, because npm's answer to a Laravel query is
 * mostly noise. With nothing to go on, the order is by registry size, since
 * recall is what matters when precision has nothing to work with.
 */
export function rankRegistries(haystack: string): SourceId[] {
  const named = REGISTRY_ECOSYSTEM_CUES.filter((entry) => entry.cues.test(haystack)).map((entry) => entry.id);
  const rest = REGISTRY_IDS.filter((id) => !named.includes(id));
  return [...named, ...rest];
}

const DEV_CUES =
  /\b(api|sdk|cli|developer|devops|sre|engineer|engineering|kubernetes|docker|ci\/?cd|pipeline|repo(sitor(y|ies))?|open ?source|library|framework|typescript|javascript|python|golang|rust|observability|microservices?|webhook|oauth|latency|deploy(ment)?s?|backend|frontend|infrastructure|database|serverless|terraform|runtime|compiler|package)\b/i;

const LOCAL_CUES =
  /\b(restaurant|cafe|caf[eé]|bar|hotel|salon|barber|clinic|dentist|dental|gym|fitness|studio|store|shop|retail|boutique|bakery|plumb(er|ing)|electrician|contractor|landscap(er|ing)|roofing|hvac|garage|mechanic|veterinar|pharmacy|florist|laundry|local business|walk[- ]in|foot traffic|storefront|neighbourhood|neighborhood)\b/i;

/**
 * PyPI is not a source here, and that is a finding rather than an omission.
 *
 * It was planned as the Python counterpart to npm, until its robots.txt
 * turned out to disallow both its search path and its per-project JSON
 * endpoint (`Disallow: /search*` and `Disallow: /pypi/<name>/json`) — and this
 * project's crawler honours robots.txt. There is no permitted search surface,
 * so Python-ecosystem prospects come from GitHub filtered by language
 * instead. Centralising robots handling in one fetch path is what surfaced
 * this before it shipped.
 */

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
  // Package registries. Every one of them is asked for a developer ICP, but
  // the order matters: a seller of a Rails tool should ask RubyGems before
  // npm, and `rankRegistries` below does that from the seller's own words.
  //
  // Deliberately the full developer cue, not the per-language one. The
  // question is not "does the seller talk about npm" but "do its buyers
  // publish packages", and for any developer tool they do. Routing an
  // observability ICP away from npm because its own copy never said
  // "javascript" once skipped the only discovery source proven to work.
  ...REGISTRY_IDS.map((id): SourceProfile => ({
    id,
    cues: DEV_CUES,
    hint: (offering, icp) => uniqueLower([
      ...technologyTerms(offering),
      ...offering.categories,
      ...(icp.positiveSignals ?? []).filter((s) => DEV_CUES.test(s)),
    ]).slice(0, 10),
  })),
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

  // Registries are ordered by ecosystem rather than by their position in
  // SOURCE_PROFILES, so a Rails seller asks RubyGems first.
  const registryOrder = rankRegistries(haystack);
  const registries = preferredSources.filter((id) => REGISTRY_IDS.includes(id as SourceId));
  if (registries.length > 1) {
    const ranked = registryOrder.filter((id) => registries.includes(id));
    let slot = 0;
    for (let i = 0; i < preferredSources.length; i++) {
      if (REGISTRY_IDS.includes(preferredSources[i] as SourceId)) {
        preferredSources[i] = ranked[slot++] ?? preferredSources[i]!;
      }
    }
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
/**
 * Head nouns that carry no meaning on their own.
 *
 * "Error budget tracking" is a useful signal; "tracking" matches every site
 * on the web. Dropping these from the tail of a phrase yields the part a
 * prospect with the problem would actually write.
 */
const GENERIC_HEADS = new Set([
  "tracking", "integration", "integrations", "management", "monitoring",
  "platform", "software", "tool", "tools", "solution", "solutions", "system",
  "systems", "service", "services", "suite", "api", "apis", "dashboard",
  "dashboards", "reporting", "reports", "analytics", "automation", "support",
]);

/**
 * Words too common to be a signal on their own.
 *
 * This matters more than it looks. A single-word signal becomes a search for
 * that word on a prospect's site, and the sentence it lands in becomes the
 * evidence that justifies writing to them. "Error budget tracking" correctly
 * yielded "error" and "budget", which would have matched a sentence about
 * marketing budgets and presented it as proof we understood their problem.
 */
const WEAK_SINGLE_WORDS = new Set([
  "error", "budget", "works", "work", "using", "used", "build", "built",
  "make", "made", "help", "helps", "data", "time", "scale", "speed", "cost",
  "costs", "price", "prices", "value", "quality", "growth", "process",
  "project", "product", "products", "first", "every", "better", "faster",
  "simple", "easy", "modern", "global", "across", "within", "around",
]);

/**
 * Keywords a prospect with this problem would have on their own site.
 *
 * Derived from what the product *does*, because that is the one thing the
 * seller's site always states plainly. A phrase contributes itself, itself
 * minus a generic head noun, and its distinctive single words — so "Burn rate
 * alerts" yields "burn rate alerts", "burn rate" and "alerts", and a prospect
 * mentioning any of them is found.
 */
function signalsFromCapabilities(offering: Offering): string[] {
  const out: string[] = [];
  const phrases = [
    ...offering.products.flatMap((p) => p.capabilities),
    ...offering.positioningPhrases,
    ...offering.categories,
  ];

  for (const raw of phrases) {
    const tokens = words(raw).filter((w) => w.length > 2 && !GRAMMATICAL.has(w));
    if (tokens.length === 0) continue;
    if (tokens.length <= 4) out.push(tokens.join(" "));

    const last = tokens[tokens.length - 1] ?? "";
    if (tokens.length >= 2 && GENERIC_HEADS.has(last)) {
      out.push(tokens.slice(0, -1).join(" "));
    }
    for (const token of tokens) {
      if (token.length < 5) continue;
      if (GENERIC_HEADS.has(token) || BUYER_NOUNS.has(token) || WEAK_SINGLE_WORDS.has(token)) continue;
      out.push(token);
    }
  }
  return out;
}

export function inferIcp(offering: Offering, corpusText = ""): Icp {
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

  // Two sources, deliberately different in kind. Capabilities say what the
  // product does, which is what a prospect with the problem writes about.
  // Problem-cue sentences in the seller's own copy say how they phrase the
  // status quo, which is often the prospect's phrasing too.
  const painSignals = uniqueLower([
    ...signalsFromCapabilities(offering),
    ...signalsFromProse(corpusText, offering),
    ...[...offering.valueProps.map((v) => v.text), offering.oneLiner].flatMap(problemPhrases),
  ])
    .filter(isPlausibleSignal)
    .filter((signal) => !isSellerBrandWord(signal, offering))
    .slice(0, 36);

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
 * Cues that mark a sentence as being about the problem.
 *
 * Two kinds. The first is the seller naming the status quo it replaces —
 * manual work, noise, things done by hand. The second is the seller naming
 * what its product watches, which is the same subject from the other side.
 * A sentence with neither is prose about the company, not the problem.
 */
const PROBLEM_SENTENCE_CUES =
  /\b(?:stop|stops|avoid|avoids|prevent|prevents|without|instead of|no reliable|by hand|manually|manual|spreadsheet|noise|wasted|woken|paged|pager|burning|breach|breached|miss|missed|fail|failing|broken|slow|outdated|struggle|struggling|painful|annoying|tedious|watches|watch|tracks|track|monitors|monitor|detects|detect|calculates|calculate|tells you|alerts you|warns|replaces|replace)\b/i;

/**
 * Noun phrases the seller uses when talking about the problem.
 *
 * This is the half of signal derivation that capabilities cannot provide. A
 * feature heading says "Burn rate alerts"; the prose around it says "your
 * on-call engineers stop being woken by alerts that nobody acts on" — and
 * "on-call engineers" is the phrase a prospect with the problem writes on
 * their own careers page.
 *
 * Restricted to problem-cue sentences on purpose. Ranking nouns by frequency
 * across the whole site is the heuristic that once scraped the seller's own
 * postal address into the ICP; requiring a cue means the phrases come from
 * where the seller discusses the problem, not from its address block.
 */
function signalsFromProse(corpusText: string, offering: Offering): string[] {
  if (!corpusText) return [];

  const counts = new Map<string, number>();
  const brand = new Set(words(offering.companyName));

  for (const sentence of corpusText.split(/(?<=[.!?])\s+|\n+/)) {
    if (sentence.length < 30 || sentence.length > 320) continue;
    if (!PROBLEM_SENTENCE_CUES.test(sentence)) continue;

    const tokens = words(sentence);
    let run: string[] = [];
    const flush = () => {
      for (let size = Math.min(3, run.length); size >= 2; size--) {
        for (let i = 0; i + size <= run.length; i++) {
          const phrase = run.slice(i, i + size).join(" ");
          counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
        }
      }
      // Distinctive single words too, but only long ones and only from a
      // problem sentence. "uptime" and "spreadsheet" are exactly what a
      // prospect with this problem writes; the six-character floor is what
      // keeps "error" and "budget" out, which would match a sentence about
      // marketing budgets and present it as proof we understood them.
      for (const token of run) {
        if (token.length >= 6 && !isWeakWord(token)) {
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      }
      run = [];
    };

    // Only grammar and the seller's own name break a run. An earlier version
    // also broke on generic and buyer nouns, which destroyed the two best
    // phrases on the page: "service level objectives" became "level
    // objectives" (broken at "service") and "on-call engineers" vanished
    // entirely (broken at "engineers"). Those words are weak alone and
    // perfectly good inside a phrase.
    for (const token of tokens) {
      if (token.length >= 4 && !GRAMMATICAL.has(token) && !brand.has(token)) run.push(token);
      else flush();
    }
    flush();
  }

  // Multi-word phrases first, then single words. Both are capped, and the
  // ordering is what the cap acts on: adding single words without this
  // evicted "service level objectives" from the list and the prospect who
  // had written that exact phrase stopped qualifying.
  const ranked = [...counts.entries()]
    .filter(([phrase]) => phrase.split(" ").some((w) => !isWeakWord(w)))
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([phrase]) => phrase);

  return [
    ...ranked.filter((phrase) => phrase.includes(" ")).slice(0, 14),
    ...ranked.filter((phrase) => !phrase.includes(" ")).slice(0, 8),
  ];
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
      // Truncate at the first grammatical word rather than deleting it.
      // Deleting produced "alert volume without turning" -> "alert volume
      // turning", and "stop paging engineers for alerts" -> "paging
      // engineers alerts": keyword soup that matches nothing on a real site.
      const tokens: string[] = [];
      for (const raw of (match[1] ?? "").split(/\s+/)) {
        const word = raw.toLowerCase();
        if (word.length <= 2 || GRAMMATICAL.has(word)) break;
        tokens.push(word);
      }
      // Two words minimum: a single word is too generic to be worth
      // matching against a prospect's site.
      const phrase = tokens.join(" ");
      if (tokens.length >= 2 && phrase.length >= 7) out.push(phrase);
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

/** True when a word carries no meaning on its own. */
function isWeakWord(word: string): boolean {
  return WEAK_SINGLE_WORDS.has(word) || GENERIC_HEADS.has(word) || BUYER_NOUNS.has(word);
}

/** The seller's own name is not a signal that a prospect has a problem. */
function isSellerBrandWord(signal: string, offering: Offering): boolean {
  const brand = new Set(words(offering.companyName));
  return signal.split(" ").some((token) => brand.has(token));
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
