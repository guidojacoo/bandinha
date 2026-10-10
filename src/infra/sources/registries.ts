import { fetchJson } from "../http";
import {
  companyDomainOf, dedupeCandidates, emptyOutput,
  type DiscoveryInput, type DiscoveryOutput, type ProspectCandidate,
  type ProspectSource, type SourceConfidence,
} from "./types";

/**
 * Companies found through public package registries.
 *
 * The insight, and it is the same one five times over: a company that
 * publishes a package in your problem space has already told you three things
 * for free — that it exists, what it works on, and the domain of its website.
 * A homepage on its own domain is the filter that separates a business from a
 * weekend project, and it costs nothing, because every registry below is
 * public, keyless and documented.
 *
 * Written as one code path with per-registry adapters rather than five
 * near-identical files. Only the response shape differs, and the parts that
 * are easy to get wrong — the company-domain filter, de-duplication, the
 * staleness cutoff, the query builder — should be got right once.
 *
 * Coverage is honest: this finds software companies. For a developer-tools or
 * infrastructure ICP that is most of the market; for a dental practice it
 * finds nothing, which is why `core/icp.ts` routes by what the seller sells.
 */

export interface RegistryHit {
  name: string;
  /** The registry's own page for this package, for the contact paper trail. */
  pageUrl?: string;
  description?: string;
  /** Whatever the registry thinks the project's website is. */
  homepage?: string;
  /** Checked only when `homepage` is absent or is a code host. */
  repository?: string;
  keywords?: string[];
  /** ISO date of the last release, for the staleness cutoff. */
  publishedAt?: string;
  contactEmail?: string;
}

export interface RegistryAdapter {
  id: string;
  label: string;
  /** The language or platform, for the operator-facing note. */
  ecosystem: string;
  confidence: SourceConfidence;
  coverage: string;
  /**
   * Hosts this registry itself owns, which must never become candidates.
   *
   * Every registry hands back packages whose "homepage" is a page on the
   * registry or its documentation site. A generic platform-host list catches
   * most of it, but a registry knows its own domains better than a shared
   * list does, and a new adapter should not be able to start recommending
   * its own homepage as a lead.
   */
  ownHosts?: string[];
  /** The registry's public page for a package, for the contact paper trail. */
  packagePageUrl?(hit: RegistryHit): string | null;
  searchUrl(query: string, limit: number): string;
  parse(data: unknown): RegistryHit[];
  /**
   * Second call for registries whose search results omit the homepage.
   *
   * Packagist is the case: its search gives a repository and nothing else,
   * while the package document carries both the homepage and the author's
   * email. Worth one extra request per candidate; not worth one per result,
   * so it runs only after the cheap filters have cut the list down.
   */
  detailUrl?(hit: RegistryHit): string | null;
  parseDetail?(data: unknown, hit: RegistryHit): RegistryHit;
}

/** Packages this old are unlikely to belong to a company still selling. */
const MAX_AGE_DAYS = Number(process.env.REGISTRY_MAX_PACKAGE_AGE_DAYS ?? process.env.NPM_MAX_PACKAGE_AGE_DAYS ?? 1_095);

/** How many detail lookups one discovery run may spend. */
const MAX_DETAIL_LOOKUPS = Number(process.env.REGISTRY_MAX_DETAIL_LOOKUPS ?? 12);

export function createRegistrySource(adapter: RegistryAdapter): ProspectSource {
  return {
    id: adapter.id as ProspectSource["id"],
    label: adapter.label,
    confidence: adapter.confidence,
    coverage: adapter.coverage,

    async discover(input: DiscoveryInput): Promise<DiscoveryOutput> {
      const queries = buildQueries(input);
      if (queries.length === 0) {
        return emptyOutput(
          `No ${adapter.label} query could be built from this ICP — it has no technology or category keywords.`,
        );
      }

      const notes: string[] = [];
      const errors: string[] = [];
      const found: ProspectCandidate[] = [];
      const needDetail: RegistryHit[] = [];
      const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
      const seenNames = new Set<string>();

      for (const query of queries) {
        if (found.length >= input.limit * 3) break;

        const response = await fetchJson<unknown>(adapter.searchUrl(query, Math.min(100, Math.max(10, input.limit * 4))), {
          timeoutMs: 20_000,
        });
        if (!response.ok) {
          errors.push(`${adapter.label} search for "${query}" failed: ${response.error}`);
          continue;
        }

        let hits: RegistryHit[];
        try {
          hits = adapter.parse(response.data);
        } catch (error) {
          // A registry changing its response shape is a bug in one adapter,
          // not a reason to abandon the run.
          errors.push(`${adapter.label} returned a shape this adapter does not understand: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }

        let kept = 0;
        let skippedPlatform = 0;
        let skippedStale = 0;

        for (const hit of hits) {
          if (seenNames.has(hit.name)) continue;
          seenNames.add(hit.name);

          const published = hit.publishedAt ? Date.parse(hit.publishedAt) : NaN;
          if (Number.isFinite(published) && published < cutoff) {
            skippedStale++;
            continue;
          }

          const domain = resolveDomain(adapter, hit);
          if (!domain) {
            // No company domain in the search result. Worth a detail lookup
            // when the registry has one, otherwise it is a personal project.
            if (adapter.detailUrl && needDetail.length < MAX_DETAIL_LOOKUPS) needDetail.push(hit);
            else skippedPlatform++;
            continue;
          }
          if (input.exclude.has(domain)) continue;

          found.push(candidateFrom(adapter, hit, domain, query));
          kept++;
        }

        notes.push(
          `"${query}": ${hits.length} package(s), ${kept} on a company domain` +
          (skippedPlatform > 0 ? `, ${skippedPlatform} personal or platform-hosted` : "") +
          (skippedStale > 0 ? `, ${skippedStale} abandoned` : "") + ".",
        );
      }

      // The second pass, for registries that hide the homepage behind a
      // package document.
      if (adapter.detailUrl && adapter.parseDetail && found.length < input.limit) {
        let resolved = 0;
        for (const hit of needDetail) {
          if (found.length >= input.limit) break;
          const url = adapter.detailUrl(hit);
          if (!url) continue;

          const response = await fetchJson<unknown>(url, { timeoutMs: 15_000 });
          if (!response.ok) continue;

          let enriched: RegistryHit;
          try {
            enriched = adapter.parseDetail(response.data, hit);
          } catch {
            continue;
          }
          const domain = resolveDomain(adapter, enriched);
          if (!domain || input.exclude.has(domain)) continue;

          found.push(candidateFrom(adapter, enriched, domain, `${hit.name} (package document)`));
          resolved++;
        }
        if (needDetail.length > 0) {
          notes.push(`${resolved} of ${needDetail.length} package(s) resolved to a company domain on a second lookup.`);
        }
      }

      const candidates = dedupeCandidates(found, input.exclude).slice(0, input.limit);
      if (candidates.length === 0 && errors.length === 0) {
        notes.push(`Every ${adapter.label} result was a personal project or already in the pipeline.`);
      }
      return { candidates, notes, errors };
    },
  };
}

/** The company domain a hit implies, with the registry's own hosts refused. */
function resolveDomain(adapter: RegistryAdapter, hit: RegistryHit): string | null {
  const own = new Set((adapter.ownHosts ?? []).map((host) => host.toLowerCase()));
  for (const candidate of [hit.homepage, hit.repository]) {
    const domain = companyDomainOf(candidate ?? "");
    if (domain && !own.has(domain)) return domain;
  }
  return null;
}

function candidateFrom(
  adapter: RegistryAdapter,
  hit: RegistryHit,
  domain: string,
  query: string,
): ProspectCandidate {
  return {
    domain,
    url: `https://${domain}`,
    via: adapter.id as ProspectCandidate["via"],
    reason: `Publishes "${hit.name}" on ${adapter.label}, found searching "${query}".`,
    hints: {
      description: hit.description?.slice(0, 400),
      technologies: [...new Set([...(hit.keywords ?? []), adapter.ecosystem])].slice(0, 12),
      contactEmail: usableEmail(hit.contactEmail),
      contactSource: hit.pageUrl ?? adapter.packagePageUrl?.(hit) ?? undefined,
    },
  };
}

/**
 * Turns ICP hints into registry queries.
 *
 * Single terms first, then pairs. Running the pairs first made every query
 * start with the same leading term, so one keyword dominated the whole run
 * and the narrower hints were never asked.
 */
export function buildQueries(input: DiscoveryInput): string[] {
  const terms = [...new Set([
    ...input.hints,
    ...input.icp.positiveSignals,
    ...input.icp.industries,
  ].map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3 && t.length <= 30 && !/\s{2,}/.test(t)))];

  if (terms.length === 0) return [];

  const queries: string[] = terms.slice(0, 3);
  for (let gap = 1; gap < Math.min(4, terms.length); gap++) {
    for (let i = 0; i + gap < Math.min(5, terms.length); i++) {
      queries.push(`${terms[i]} ${terms[i + gap]}`);
      if (queries.length >= 6) return queries;
    }
  }
  return queries;
}

/** Bot and no-reply publisher addresses are not people. */
function usableEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const clean = email.trim().toLowerCase();
  if (!clean.includes("@")) return undefined;
  if (/(no-?reply|noreply|bot@|-bot|actions@|oidc|example\.(com|org))/.test(clean)) return undefined;
  return clean;
}

// ---------------------------------------------------------------------------
// The adapters
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** JavaScript and TypeScript. The largest registry, and the first proven one. */
export const npmAdapter: RegistryAdapter = {
  id: "npm",
  label: "npm",
  ecosystem: "javascript",
  confidence: "proven",
  coverage:
    "Companies publishing JavaScript or TypeScript packages. The largest registry by far; strong for developer tools, infrastructure and anything web-facing.",

  ownHosts: ["npmjs.com", "npmjs.org", "nodejs.org"],
  packagePageUrl: (hit) => `https://www.npmjs.com/package/${hit.name}`,
  searchUrl: (query, limit) =>
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`,

  parse: (data) =>
    arr(obj(data).objects).map((entry) => {
      const pkg = obj(obj(entry).package);
      const links = obj(pkg.links);
      const author = obj(pkg.author);
      return {
        name: str(pkg.name) ?? "",
        description: str(pkg.description),
        homepage: str(links.homepage) ?? str(author.url),
        keywords: arr(pkg.keywords).filter((k): k is string => typeof k === "string"),
        publishedAt: str(pkg.date),
        contactEmail: str(author.email) ?? str(obj(pkg.publisher).email),
      };
    }).filter((hit) => hit.name),
};

/** Ruby, which means Rails, which means a great many small businesses. */
export const rubygemsAdapter: RegistryAdapter = {
  id: "rubygems",
  label: "RubyGems",
  ecosystem: "ruby",
  confidence: "proven",
  coverage:
    "Companies publishing Ruby gems. Smaller than npm and unusually commercial: Rails shops and the vendors who sell to them.",

  ownHosts: ["rubygems.org", "rubydoc.info", "rubyforge.org", "ruby-lang.org", "rubyonrails.org"],
  packagePageUrl: (hit) => `https://rubygems.org/gems/${hit.name}`,
  // RubyGems has no result-count parameter; it returns a fixed page.
  searchUrl: (query) => `https://rubygems.org/api/v1/search.json?query=${encodeURIComponent(query)}`,

  parse: (data) =>
    arr(data).map((entry) => {
      const gem = obj(entry);
      return {
        name: str(gem.name) ?? "",
        description: str(gem.info),
        homepage: str(gem.homepage_uri) ?? str(gem.documentation_uri),
        repository: str(gem.source_code_uri),
        publishedAt: str(gem.version_created_at),
      };
    }).filter((hit) => hit.name),
};

/** Rust. Small, and almost entirely infrastructure. */
export const cratesAdapter: RegistryAdapter = {
  id: "crates",
  label: "crates.io",
  ecosystem: "rust",
  confidence: "proven",
  coverage:
    "Companies publishing Rust crates. A small registry that skews heavily toward infrastructure, databases and systems tooling.",

  ownHosts: ["crates.io", "docs.rs", "rust-lang.org"],
  packagePageUrl: (hit) => `https://crates.io/crates/${hit.name}`,
  searchUrl: (query, limit) =>
    `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${Math.min(100, limit)}`,

  parse: (data) =>
    arr(obj(data).crates).map((entry) => {
      const crate = obj(entry);
      return {
        name: str(crate.name) ?? "",
        description: str(crate.description),
        homepage: str(crate.homepage) ?? str(crate.documentation),
        repository: str(crate.repository),
        keywords: arr(crate.keywords).filter((k): k is string => typeof k === "string"),
        publishedAt: str(crate.updated_at) ?? str(crate.created_at),
      };
    }).filter((hit) => hit.name),
};

/** Elixir and Erlang. Tiny, and the companies in it are nearly all real. */
export const hexAdapter: RegistryAdapter = {
  id: "hex",
  label: "Hex.pm",
  ecosystem: "elixir",
  confidence: "proven",
  coverage:
    "Companies publishing Elixir or Erlang packages. The smallest registry here, with correspondingly little noise.",

  ownHosts: ["hex.pm", "hexdocs.pm", "elixir-lang.org", "erlang.org"],
  packagePageUrl: (hit) => `https://hex.pm/packages/${hit.name}`,
  searchUrl: (query) => `https://hex.pm/api/packages?search=${encodeURIComponent(query)}`,

  parse: (data) =>
    arr(data).map((entry) => {
      const pkg = obj(entry);
      const links = obj(obj(pkg.meta).links);
      // Hex stores links under human labels, so the website is whichever key
      // is not a code host or a docs site.
      const website = Object.entries(links).find(([label]) =>
        /^(website|home ?page|site|docs?|homepage)$/i.test(label) && !/github|gitlab/i.test(label));
      const anyLink = Object.values(links).find((value) => typeof value === "string");
      return {
        name: str(pkg.name) ?? "",
        description: str(obj(pkg.meta).description),
        homepage: str(website?.[1]) ?? str(anyLink),
        publishedAt: str(pkg.updated_at) ?? str(pkg.inserted_at),
      };
    }).filter((hit) => hit.name),
};

/**
 * PHP and Composer. The one that needs a second lookup.
 *
 * Packagist's search returns a repository and a description and no homepage
 * at all, while the package document carries the homepage *and* the author's
 * email address — which is a named contact, published deliberately, by the
 * person who maintains the thing. Worth the extra request.
 */
export const packagistAdapter: RegistryAdapter = {
  id: "packagist",
  label: "Packagist",
  ecosystem: "php",
  confidence: "proven",
  coverage:
    "Companies publishing PHP packages. Large, commercial, and skewed toward agencies and the vendors selling to them. The only registry here whose maintainer contact is published in the package itself.",

  ownHosts: ["packagist.org", "getcomposer.org", "php.net", "laravel.com", "symfony.com"],
  packagePageUrl: (hit) => `https://packagist.org/packages/${hit.name}`,
  searchUrl: (query, limit) =>
    `https://packagist.org/search.json?q=${encodeURIComponent(query)}&per_page=${Math.min(100, limit)}`,

  parse: (data) =>
    arr(obj(data).results).map((entry) => {
      const pkg = obj(entry);
      return {
        name: str(pkg.name) ?? "",
        description: str(pkg.description),
        // Deliberately not `pkg.url`: that is the Packagist listing page,
        // which `companyDomainOf` correctly refuses as a platform host.
        repository: str(pkg.repository),
      };
    }).filter((hit) => hit.name),

  detailUrl: (hit) =>
    /^[\w.-]+\/[\w.-]+$/.test(hit.name)
      ? `https://packagist.org/packages/${hit.name}.json`
      : null,

  parseDetail: (data, hit) => {
    const pkg = obj(obj(data).package);
    const versions = Object.values(obj(pkg.versions)).map(obj);
    // Newest first: an old release's homepage may be a domain they have lost.
    const sorted = versions.sort((a, b) =>
      String(b.time ?? "").localeCompare(String(a.time ?? "")));

    for (const version of sorted.slice(0, 5)) {
      const homepage = str(version.homepage);
      const authors = arr(version.authors).map(obj);
      const author = authors.find((a) => str(a.email) || str(a.homepage));
      const candidate = homepage ?? str(author?.homepage);
      if (candidate) {
        return {
          ...hit,
          homepage: candidate,
          contactEmail: str(author?.email),
          publishedAt: str(version.time),
        };
      }
    }
    return { ...hit, publishedAt: str(sorted[0]?.time) };
  },
};

export const REGISTRY_ADAPTERS: RegistryAdapter[] = [
  npmAdapter, packagistAdapter, rubygemsAdapter, cratesAdapter, hexAdapter,
];

export const REGISTRY_SOURCES = REGISTRY_ADAPTERS.map(createRegistrySource);

/** Which ecosystem each registry covers, for the ICP router. */
export const REGISTRY_ECOSYSTEMS: Record<string, string> = Object.fromEntries(
  REGISTRY_ADAPTERS.map((adapter) => [adapter.id, adapter.ecosystem]),
);
