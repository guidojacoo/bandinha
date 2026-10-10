import { fetchJson } from "../http";
import {
  companyDomainOf, dedupeCandidates, emptyOutput,
  type DiscoveryInput, type DiscoveryOutput, type ProspectCandidate, type ProspectSource,
} from "./types";

/**
 * Web search through SearXNG.
 *
 * The general-purpose fallback for ICPs that no registry or map covers. Every
 * commercial search API costs money per thousand queries; SearXNG is a
 * self-hostable metasearch engine with a JSON API, and dozens of public
 * instances run it for free. `SEARXNG_URL` can point at a public instance or
 * at one the operator runs in Docker — the second being the only
 * configuration anyone should rely on, since public instances rate-limit
 * aggressively and come and go.
 *
 * Status: untested. Every public instance tried was unreachable from the
 * sandbox this was written in. The JSON API shape is stable across SearXNG
 * releases; this code against a live instance is not proven.
 */

const INSTANCES = (process.env.SEARXNG_URL ?? "").split(",").map((u) => u.trim().replace(/\/$/, "")).filter(Boolean);

interface SearxResponse {
  results?: Array<{ url?: string; title?: string; content?: string; engine?: string }>;
  number_of_results?: number;
}

export const searchSource: ProspectSource = {
  id: "search",
  label: "Web search (SearXNG)",
  confidence: "untested",
  coverage:
    "Anything the web indexes, so coverage is broad and precision is low. Needs a SearXNG instance — set SEARXNG_URL, ideally to one you run yourself.",

  async discover(input: DiscoveryInput): Promise<DiscoveryOutput> {
    if (INSTANCES.length === 0) {
      return emptyOutput(
        "No SearXNG instance configured. Set SEARXNG_URL to one you run (docker run -p 8080:8080 searxng/searxng) or a public instance that allows the JSON API.",
      );
    }
    const queries = input.hints.filter((h) => h.length >= 4 && !/^https?:\/\//i.test(h));
    if (queries.length === 0) {
      return emptyOutput("No search queries were derived for this ICP.");
    }

    const notes: string[] = [];
    const errors: string[] = [];
    const found: ProspectCandidate[] = [];

    for (const query of queries.slice(0, 6)) {
      if (found.length >= input.limit * 2) break;

      const result = await searchOnce(query);
      if (!result.ok) {
        errors.push(`Search for "${query}" failed: ${result.error}`);
        continue;
      }

      const results = result.data?.results ?? [];
      let kept = 0;
      for (const hit of results) {
        if (!hit.url) continue;
        const domain = companyDomainOf(hit.url);
        if (!domain || input.exclude.has(domain)) continue;
        // A result that is an article *about* companies is not a company.
        if (isEditorial(hit.url)) continue;

        found.push({
          domain,
          url: `https://${domain}`,
          companyName: hit.title ? hit.title.split(/[|–—:]/)[0]?.trim() : undefined,
          via: "search",
          reason: `Search result for "${query}".`,
          hints: { description: hit.content?.slice(0, 300) },
        });
        kept++;
      }
      notes.push(`"${query}": ${results.length} result(s), ${kept} new compan${kept === 1 ? "y" : "ies"}.`);
    }

    return { candidates: dedupeCandidates(found, input.exclude).slice(0, input.limit), notes, errors };
  },
};

async function searchOnce(query: string): Promise<{ ok: boolean; data?: SearxResponse; error?: string }> {
  let lastError = "no instance tried";
  for (const instance of INSTANCES) {
    const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=0`;
    const response = await fetchJson<SearxResponse>(url, { timeoutMs: 20_000 });
    if (response.ok) return { ok: true, data: response.data };
    lastError = response.error ?? `HTTP ${response.status}`;
  }
  return { ok: false, error: lastError };
}

/** URLs that are coverage of a market rather than a participant in it. */
function isEditorial(url: string): boolean {
  return /\/(blog|news|article|press|magazine|wiki|forum|thread|questions|answers|reviews?)\//i.test(url) ||
    /(wikipedia|reddit|quora|stackoverflow|g2|capterra|trustpilot|crunchbase|glassdoor|indeed)\./i.test(url);
}
