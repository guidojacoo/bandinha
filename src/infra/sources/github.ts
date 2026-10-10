import { fetchJson } from "../http";
import {
  companyDomainOf, dedupeCandidates, emptyOutput,
  type DiscoveryInput, type DiscoveryOutput, type ProspectCandidate, type ProspectSource,
} from "./types";

/**
 * Companies discovered through GitHub's public search.
 *
 * The richest free source for a software ICP, and the one with the best
 * signal-to-noise: an organisation with a starred repository, a `blog` URL on
 * its own domain and a recent push is, almost without exception, a real
 * company with engineers and a budget. GitHub's search API is free and
 * keyless at 10 requests per minute; a `GITHUB_TOKEN` raises that to 30 and
 * is the only optional credential in the project.
 *
 * Status: untested. The sandbox this was written in scopes GitHub API access
 * to a single repository, so `/search` and `/orgs` both return 403 there. The
 * endpoints, their rate limits and their response shapes are public and
 * stable; what has not been exercised is this code against them. Marked
 * `untested` so the console says so rather than reporting an empty market.
 */

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";

interface RepoSearchResponse {
  total_count?: number;
  items?: Array<{
    full_name?: string;
    description?: string;
    homepage?: string | null;
    stargazers_count?: number;
    pushed_at?: string;
    language?: string | null;
    topics?: string[];
    owner?: { login?: string; type?: string; html_url?: string };
  }>;
  message?: string;
}

interface OrgResponse {
  login?: string;
  name?: string | null;
  blog?: string | null;
  email?: string | null;
  location?: string | null;
  description?: string | null;
  public_repos?: number;
  type?: string;
}

function headers(): Record<string, string> {
  const token = (process.env.GITHUB_TOKEN ?? "").trim();
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export const githubSource: ProspectSource = {
  id: "github",
  label: "GitHub",
  confidence: "untested",
  coverage:
    "Organisations publishing code in the ICP's space. Best source for developer tools, infrastructure and data companies; finds nothing outside software.",

  async discover(input: DiscoveryInput): Promise<DiscoveryOutput> {
    const queries = buildQueries(input);
    if (queries.length === 0) {
      return emptyOutput("No GitHub query could be built from this ICP — it names no technologies or topics.");
    }

    const notes: string[] = [];
    const errors: string[] = [];
    const orgLogins = new Map<string, { reason: string; description?: string; topics: string[]; language?: string }>();

    for (const query of queries) {
      if (orgLogins.size >= input.limit * 2) break;

      const url = `${API}/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=50`;
      const response = await fetchJson<RepoSearchResponse>(url, { timeoutMs: 20_000, headers: headers() });
      if (!response.ok) {
        errors.push(`GitHub search for "${query}" failed: ${response.error}`);
        // 403 here is almost always the rate limit; further queries will fail too.
        if (response.status === 403 || response.status === 429) break;
        continue;
      }

      const items = response.data?.items ?? [];
      let kept = 0;
      for (const repo of items) {
        const login = repo.owner?.login;
        // A personal account is a developer, not a buying committee.
        if (!login || repo.owner?.type !== "Organization") continue;
        if (orgLogins.has(login)) continue;
        orgLogins.set(login, {
          reason: `Maintains ${repo.full_name} (${repo.stargazers_count ?? 0} stars), found searching "${query}".`,
          description: repo.description ?? undefined,
          topics: repo.topics ?? [],
          language: repo.language ?? undefined,
        });
        kept++;
      }
      notes.push(`"${query}": ${items.length} repo(s), ${kept} new organisation(s).`);
    }

    // The org profile is where the company domain lives; a repo's `homepage`
    // is usually its own docs site.
    const found: ProspectCandidate[] = [];
    for (const [login, context] of orgLogins) {
      if (found.length >= input.limit * 2) break;

      const response = await fetchJson<OrgResponse>(`${API}/orgs/${encodeURIComponent(login)}`, {
        timeoutMs: 15_000,
        headers: headers(),
      });
      if (!response.ok) {
        errors.push(`Could not read the ${login} organisation: ${response.error}`);
        if (response.status === 403 || response.status === 429) break;
        continue;
      }

      const org = response.data;
      const domain = org?.blog ? companyDomainOf(org.blog) : null;
      if (!domain || input.exclude.has(domain)) continue;

      found.push({
        domain,
        url: `https://${domain}`,
        companyName: org?.name ?? login,
        via: "github",
        reason: context.reason,
        hints: {
          description: (org?.description ?? context.description)?.slice(0, 400),
          location: org?.location ?? undefined,
          technologies: [...new Set([...context.topics, context.language].filter(Boolean) as string[])].slice(0, 12),
          contactEmail: org?.email ?? undefined,
        },
      });
    }

    const candidates = dedupeCandidates(found, input.exclude).slice(0, input.limit);
    if (candidates.length === 0 && errors.length === 0) {
      notes.push("Organisations were found, but none published a website on their own domain.");
    }
    return { candidates, notes, errors };
  },
};

/**
 * Builds GitHub search queries from the ICP.
 *
 * `stars:>25` and `pushed:>` filter out the long tail of abandoned
 * repositories, which is most of GitHub. `topic:` is used when a hint looks
 * like a real topic slug, because topic matches are far more precise than
 * full-text ones.
 */
export function buildQueries(input: DiscoveryInput): string[] {
  const terms = [...new Set([...input.hints, ...input.icp.positiveSignals, ...input.icp.industries])]
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3 && t.length <= 30);
  if (terms.length === 0) return [];

  const sinceYear = new Date().getUTCFullYear() - 1;
  const freshness = `pushed:>${sinceYear}-01-01`;
  const queries: string[] = [];

  for (const term of terms.slice(0, 5)) {
    const slug = term.replace(/\s+/g, "-");
    queries.push(/^[a-z0-9-]+$/.test(slug)
      ? `topic:${slug} stars:>25 ${freshness}`
      : `"${term}" in:description stars:>25 ${freshness}`);
  }
  return queries.slice(0, 5);
}
