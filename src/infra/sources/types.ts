import type { Icp } from "../../core/types";
import type { SourceId } from "../../core/icp";

/**
 * Prospect discovery from open data.
 *
 * This is where the project either works or does not. Every open-source AI
 * SDR surveyed in docs/RESEARCH.md is open source *around a paid core*: the
 * agent loop is MIT-licensed and the lead list comes from Apollo, ZoomInfo or
 * Clearbit at $8k-30k a year. Nobody has solved discovery for free, because
 * free sources are partial, inconsistent and awkward.
 *
 * The approach here is to accept that and route around it: several partial
 * sources, each honest about its coverage, picked by what the ICP actually
 * is. A developer tool asks a package registry who publishes libraries in its
 * space. A salon booking tool asks OpenStreetMap what salons exist in a city.
 * Neither source could serve the other, and no single source covers everyone
 * — so the ICP chooses, and the operator's own seed list is always the floor.
 */

export interface ProspectCandidate {
  /** Registrable domain, lowercased, no www. The identity of a lead. */
  domain: string;
  /** Homepage to crawl. */
  url: string;
  companyName?: string;
  /** Which source found it — carried all the way to the console. */
  via: SourceId;
  /** Why this source thought it was worth a look. Not evidence. */
  reason: string;
  /** Anything else the source learned, for enrichment without a second call. */
  hints?: {
    description?: string;
    location?: string;
    technologies?: string[];
    employeeEstimate?: number;
    contactEmail?: string;
    /**
     * The page that published that address.
     *
     * Needed because "where did you get my email" is a question with a legal
     * answer, and `${source}:${domain}` is not one. A registry address was
     * published deliberately by the person who maintains the package, which
     * is a better paper trail than a crawl — but only if the trail is kept.
     */
    contactSource?: string;
  };
}

export interface DiscoveryInput {
  icp: Icp;
  /** `icp.sourceHints[source.id]`, already routed. */
  hints: string[];
  limit: number;
  /** Domains already in the pipeline, which must not be returned again. */
  exclude: ReadonlySet<string>;
}

export interface DiscoveryOutput {
  candidates: ProspectCandidate[];
  /** Operator-facing notes: what was searched, what was skipped and why. */
  notes: string[];
  errors: string[];
}

/**
 * How confident we are that a source works, stated in the code.
 *
 * `proven` means it has been run end to end against the live service.
 * `untested` means the implementation is complete and the endpoint was
 * unreachable from the machine it was written on. The console and the README
 * both show this, because a lead source that silently returns nothing looks
 * exactly like an ICP with no market.
 */
export type SourceConfidence = "proven" | "untested";

export interface ProspectSource {
  readonly id: SourceId;
  readonly label: string;
  readonly confidence: SourceConfidence;
  /** One line for the operator: what this source covers and what it misses. */
  readonly coverage: string;
  discover(input: DiscoveryInput): Promise<DiscoveryOutput>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Hosts that are somebody's platform, not somebody's company.
 *
 * A homepage on github.io is a side project; a homepage on its own domain is
 * a business with a budget. This list is the single cheapest quality filter
 * in the whole discovery path.
 */
const PLATFORM_HOSTS = new Set([
  "github.com", "github.io", "gitlab.com", "bitbucket.org", "sourceforge.net",
  "readthedocs.io", "readthedocs.org", "npmjs.com", "pypi.org", "crates.io",
  // Code and documentation hosts the package registries actually hand back.
  // Every one of these arrived as a "company homepage" in a live run: a gem
  // whose homepage is its own RubyDoc page, a crate pointing at docs.rs, a
  // Hex package pointing at HexDocs, and several pointing at the registry
  // they were published to.
  "sr.ht", "sourcehut.org", "rubydoc.info", "rubyforge.org", "rubygems.org",
  "npmjs.org", "getcomposer.org", "yarnpkg.com", "jsr.io", "unpkg.com",
  "hexdocs.pm", "hex.pm", "packagist.org", "metacpan.org", "pkg.go.dev",
  "godoc.org", "nuget.org", "mvnrepository.com", "maven.org", "clojars.org",
  "cpan.org", "launchpad.net", "savannah.gnu.org", "gitea.com", "gitee.com",
  "git.sr.ht", "framagit.org", "salsa.debian.org", "androidfilehost.com",
  // Project and foundation sites, which are not companies with a budget.
  "wordpress.org", "gnu.org", "fsf.org", "eclipse.org", "linuxfoundation.org",
  "cncf.io", "openjsf.org", "python.org", "ruby-lang.org", "rust-lang.org",
  "php.net", "elixir-lang.org", "erlang.org", "golang.org", "nodejs.org",
  "rubyonrails.org", "laravel.com", "symfony.com", "jquery.com", "w3.org",
  "medium.com", "substack.com", "wordpress.com", "blogspot.com", "notion.site",
  "netlify.app", "vercel.app", "herokuapp.com", "pages.dev", "web.app",
  "firebaseapp.com", "surge.sh", "glitch.me", "repl.co", "codeberg.org",
  "linkedin.com", "twitter.com", "x.com", "facebook.com", "instagram.com",
  "youtube.com", "google.com", "sites.google.com", "wixsite.com", "weebly.com",
  "squarespace.com", "shopify.com", "myshopify.com", "etsy.com", "gumroad.com",
  "docs.rs", "apache.org", "mozilla.org", "example.com", "localhost",
]);

/**
 * Public suffixes made of more than one label.
 *
 * Without these, `acme.co.uk` reduces to `co.uk` and every British company
 * looks like the same lead. A full Public Suffix List is ~9,000 entries and a
 * dependency that needs updating; this covers the suffixes that actually
 * appear in business domains, and an unlisted one simply keeps a label more,
 * which costs a near-duplicate rather than a wrong merge.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "com.br", "net.br", "org.br", "gov.br",
  "com.ar", "net.ar", "org.ar", "gob.ar", "edu.ar",
  "com.mx", "org.mx", "gob.mx",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "ne.kr",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "co.in", "net.in", "org.in", "gov.in",
  "com.sg", "com.hk", "com.tw", "com.tr", "com.pl", "com.es", "com.pt",
  "co.za", "org.za", "co.il", "com.ua", "com.ng", "com.ph", "com.my",
  "com.co", "com.pe", "com.uy", "com.ec", "com.ve",
]);

/**
 * A host reduced to the domain somebody registered.
 *
 * `observe.nestjs.com` and `nestjs.com` are one company, and crawling both
 * means writing to the same people twice. Reducing to the registrable domain
 * is what makes de-duplication actually work on real data.
 */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  const keep = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

/**
 * The brand part of a domain: `pulumi` from both pulumi.com and pulumi.io.
 *
 * Used only to spot that two candidates are one company. Deliberately not
 * used as an identity — two unrelated companies can share a brand across
 * TLDs, so this merges candidates inside a single discovery run and never
 * merges leads already in the pipeline.
 */
export function brandOf(domain: string): string {
  const registrable = registrableDomain(domain);
  const labels = registrable.split(".");
  const suffixLabels = MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
  return labels.slice(0, Math.max(1, labels.length - suffixLabels)).join(".");
}

/** True when a host belongs to a hosting platform rather than a company. */
export function isPlatformHost(host: string): boolean {
  const clean = host.toLowerCase().replace(/^www\./, "");
  if (PLATFORM_HOSTS.has(clean)) return true;
  return [...PLATFORM_HOSTS].some((platform) => clean.endsWith(`.${platform}`));
}

/**
 * A URL reduced to the company domain it implies, or null.
 *
 * Returns null for platform hosts, IP addresses and anything unparseable.
 * Keeps the port out, which cost a debugging session once: contacts matched
 * by `@domain` silently failed against `example.com:4000`.
 */
export function companyDomainOf(url: string): string | null {
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".")) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
    if (isPlatformHost(host)) return null;
    const domain = registrableDomain(host);
    // A subdomain can be a platform even when the apex is not: a project page
    // on pages.github.com reduces to github.com, which we already refuse.
    return isPlatformHost(domain) ? null : domain;
  } catch {
    return null;
  }
}

/**
 * De-duplicates candidates, keeping the richest reading of each company.
 *
 * Two passes, because real registry data produces both kinds of duplicate:
 * the same domain found by two queries, and one company holding several
 * domains (pulumi.com and pulumi.io both publish packages).
 */
export function dedupeCandidates(candidates: ProspectCandidate[], exclude: ReadonlySet<string>): ProspectCandidate[] {
  const byDomain = new Map<string, ProspectCandidate>();
  for (const candidate of candidates) {
    if (exclude.has(candidate.domain)) continue;
    const existing = byDomain.get(candidate.domain);
    if (!existing || richness(candidate) > richness(existing)) {
      byDomain.set(candidate.domain, candidate);
    }
  }

  const byBrand = new Map<string, ProspectCandidate>();
  for (const candidate of byDomain.values()) {
    const brand = brandOf(candidate.domain);
    const existing = byBrand.get(brand);
    if (!existing) {
      byBrand.set(brand, candidate);
      continue;
    }
    const better =
      richness(candidate) > richness(existing) ||
      (richness(candidate) === richness(existing) && tldRank(candidate.domain) < tldRank(existing.domain));
    if (better) byBrand.set(brand, candidate);
  }
  return [...byBrand.values()];
}

/** Which domain a company treats as its front door, by convention. */
function tldRank(domain: string): number {
  const order = [".com", ".io", ".ai", ".dev", ".co", ".net", ".org", ".app"];
  const index = order.findIndex((tld) => domain.endsWith(tld));
  return index < 0 ? order.length : index;
}

function richness(candidate: ProspectCandidate): number {
  const hints = candidate.hints ?? {};
  return (
    (candidate.companyName ? 2 : 0) +
    (hints.description ? 2 : 0) +
    (hints.location ? 1 : 0) +
    (hints.contactEmail ? 2 : 0) +
    (hints.technologies?.length ? 1 : 0)
  );
}

export function emptyOutput(note: string): DiscoveryOutput {
  return { candidates: [], notes: [note], errors: [] };
}
