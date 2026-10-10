import { USER_AGENT, registrableHost } from "../crawler/http";
import { looksLikeCompanyDomain, type DiscoveryContext, type ProspectCandidate, type ProspectSource } from "./types";

/**
 * Search-engine prospecting.
 *
 * Turns the ICP into the queries a human SDR would actually type, then takes
 * the company domains out of the results. Which engine sits behind it is
 * configuration, because every option is a tradeoff the operator should make:
 * Brave and Serper are paid but trivial, SearXNG is free but self-hosted.
 *
 * Scraping a consumer search engine's HTML is deliberately *not* an option
 * here — it violates their terms, breaks constantly, and gets the deployment's
 * IP banned.
 */

export type SearchProvider = "brave" | "serper" | "searxng";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchBackend {
  readonly provider: string;
  search(query: string, limit: number): Promise<SearchHit[]>;
}

export class BraveBackend implements SearchBackend {
  readonly provider = "brave";
  constructor(private readonly apiKey: string) {}

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(20, limit)));
    const res = await fetch(url, {
      headers: { "x-subscription-token": this.apiKey, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Brave search returned ${res.status}`);
    const body = (await res.json()) as { web?: { results?: Array<{ url: string; title: string; description: string }> } };
    return (body.web?.results ?? []).map((r) => ({ url: r.url, title: r.title, snippet: r.description }));
  }
}

export class SerperBackend implements SearchBackend {
  readonly provider = "serper";
  constructor(private readonly apiKey: string) {}

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ q: query, num: Math.min(20, limit) }),
    });
    if (!res.ok) throw new Error(`Serper returned ${res.status}`);
    const body = (await res.json()) as { organic?: Array<{ link: string; title: string; snippet: string }> };
    return (body.organic ?? []).map((r) => ({ url: r.link, title: r.title, snippet: r.snippet }));
  }
}

/** Self-hosted SearXNG — no API key, no per-query cost. */
export class SearxngBackend implements SearchBackend {
  readonly provider = "searxng";
  constructor(private readonly baseUrl: string) {}

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
    if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);
    const body = (await res.json()) as { results?: Array<{ url: string; title: string; content: string }> };
    return (body.results ?? []).slice(0, limit).map((r) => ({ url: r.url, title: r.title, snippet: r.content }));
  }
}

export function backendFromEnv(env = process.env): SearchBackend | null {
  const provider = (env.SEARCH_PROVIDER ?? "").toLowerCase() as SearchProvider | "";
  if (provider === "brave" && env.BRAVE_API_KEY) return new BraveBackend(env.BRAVE_API_KEY);
  if (provider === "serper" && env.SERPER_API_KEY) return new SerperBackend(env.SERPER_API_KEY);
  if (provider === "searxng" && env.SEARXNG_URL) return new SearxngBackend(env.SEARXNG_URL);
  // Infer when the provider was not named but a key exists.
  if (env.BRAVE_API_KEY) return new BraveBackend(env.BRAVE_API_KEY);
  if (env.SERPER_API_KEY) return new SerperBackend(env.SERPER_API_KEY);
  if (env.SEARXNG_URL) return new SearxngBackend(env.SEARXNG_URL);
  return null;
}

/**
 * Builds the queries an SDR would run.
 *
 * Crosses industries with pain signals rather than searching the product's
 * own category — searching "observability platform" finds competitors, while
 * "saas company on-call rota" finds people with the problem.
 */
export function buildQueries(ctx: DiscoveryContext, max = 6): string[] {
  const { icp } = ctx;
  const queries: string[] = [];
  const industries = icp.industries.slice(0, 3);
  const pains = icp.painSignals.slice(0, 3);
  const geos = icp.geographies.slice(0, 1);

  for (const industry of industries) {
    for (const pain of pains) {
      const geo = geos[0] ? ` ${geos[0]}` : "";
      queries.push(`"${industry}" company "${pain}"${geo}`);
      if (queries.length >= max) return queries;
    }
  }
  // Fall back to industry-only queries if the ICP has no pain signals.
  for (const industry of industries) {
    if (queries.length >= max) break;
    queries.push(`${industry} companies${geos[0] ? ` in ${geos[0]}` : ""}`);
  }
  return queries.slice(0, max);
}

export class SearchSource implements ProspectSource {
  readonly name = "search";

  constructor(private readonly backend: SearchBackend | null = backendFromEnv()) {}

  available(): boolean {
    return this.backend !== null;
  }

  unavailableReason(): string {
    return "No search backend configured (set BRAVE_API_KEY, SERPER_API_KEY or SEARXNG_URL).";
  }

  async discover(ctx: DiscoveryContext): Promise<ProspectCandidate[]> {
    if (!this.backend) return [];
    const found = new Map<string, ProspectCandidate>();

    for (const query of buildQueries(ctx)) {
      if (found.size >= ctx.limit) break;
      let hits: SearchHit[];
      try {
        hits = await this.backend.search(query, 20);
      } catch {
        continue; // one bad query must not abort discovery
      }

      for (const hit of hits) {
        const domain = registrableHost(hit.url);
        if (!domain || !looksLikeCompanyDomain(domain)) continue;
        if (ctx.exclude.has(domain) || found.has(domain)) continue;
        let root: string;
        try {
          root = new URL(hit.url).origin;
        } catch {
          continue;
        }
        found.set(domain, {
          domain,
          url: root,
          companyNameHint: hit.title.split(/[|–—\-:]/)[0]?.trim(),
          discoveredVia: `search: ${query}`,
        });
        if (found.size >= ctx.limit) break;
      }
    }

    return [...found.values()];
  }
}
