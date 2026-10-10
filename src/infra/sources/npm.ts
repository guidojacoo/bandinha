import { fetchJson } from "../http";
import {
  companyDomainOf, dedupeCandidates, emptyOutput,
  type DiscoveryInput, type DiscoveryOutput, type ProspectCandidate, type ProspectSource,
} from "./types";

/**
 * Companies discovered through the npm registry.
 *
 * The insight: a company that publishes an npm package in your problem space
 * has already told you three things for free — that it exists, what it works
 * on, and the domain of its website. `links.homepage` on its own domain is
 * the filter that separates a business from a weekend project, and it costs
 * nothing: `registry.npmjs.org/-/v1/search` is public, keyless and
 * documented.
 *
 * Coverage is honest: this finds companies in and around the JavaScript
 * ecosystem. For a developer-tools ICP that is most of the market. For a
 * dental practice it finds nothing, which is why `core/icp.ts` routes.
 */

const SEARCH = "https://registry.npmjs.org/-/v1/search";

interface NpmSearchResponse {
  total?: number;
  objects?: Array<{
    package?: {
      name?: string;
      description?: string;
      keywords?: string[];
      date?: string;
      links?: { homepage?: string; repository?: string; npm?: string };
      publisher?: { username?: string; email?: string };
      author?: { name?: string; email?: string; url?: string } | null;
    };
    score?: { final?: number; detail?: { quality?: number; popularity?: number; maintenance?: number } };
  }>;
}

/** Packages this old are unlikely to belong to a company still selling. */
const MAX_AGE_DAYS = Number(process.env.NPM_MAX_PACKAGE_AGE_DAYS ?? 1_095);

export const npmSource: ProspectSource = {
  id: "npm",
  label: "npm registry",
  confidence: "proven",
  coverage:
    "Companies publishing JavaScript or TypeScript packages. Strong for developer tools and infrastructure; finds nothing outside software.",

  async discover(input: DiscoveryInput): Promise<DiscoveryOutput> {
    const queries = buildQueries(input);
    if (queries.length === 0) {
      return emptyOutput("No npm query could be built from this ICP — it has no technology or category keywords.");
    }

    const notes: string[] = [];
    const errors: string[] = [];
    const found: ProspectCandidate[] = [];
    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;

    for (const query of queries) {
      if (found.length >= input.limit * 3) break;

      const url = `${SEARCH}?text=${encodeURIComponent(query)}&size=${Math.min(100, input.limit * 4)}`;
      const response = await fetchJson<NpmSearchResponse>(url, { timeoutMs: 15_000 });
      if (!response.ok) {
        errors.push(`npm search for "${query}" failed: ${response.error}`);
        continue;
      }

      const objects = response.data?.objects ?? [];
      let kept = 0;
      let skippedPlatform = 0;

      for (const object of objects) {
        const pkg = object.package;
        const homepage = pkg?.links?.homepage ?? pkg?.author?.url;
        if (!homepage) continue;

        const domain = companyDomainOf(homepage);
        if (!domain) {
          skippedPlatform++;
          continue;
        }
        if (input.exclude.has(domain)) continue;

        // A package nobody has touched in three years is not evidence of a
        // company with a current budget.
        const published = pkg?.date ? Date.parse(pkg.date) : NaN;
        if (Number.isFinite(published) && published < cutoff) continue;

        found.push({
          domain,
          url: `https://${domain}`,
          companyName: undefined,
          via: "npm",
          reason: `Publishes "${pkg?.name}" on npm, found searching "${query}".`,
          hints: {
            description: pkg?.description?.slice(0, 400),
            technologies: dedupe([...(pkg?.keywords ?? []), "javascript"]).slice(0, 12),
            contactEmail: usableEmail(pkg?.author?.email) ?? usableEmail(pkg?.publisher?.email),
          },
        });
        kept++;
      }

      notes.push(
        `"${query}": ${objects.length} package(s), ${kept} on a company domain` +
        (skippedPlatform > 0 ? `, ${skippedPlatform} skipped as personal or platform-hosted` : "") + ".",
      );
    }

    const candidates = dedupeCandidates(found, input.exclude).slice(0, input.limit);
    if (candidates.length === 0 && errors.length === 0) {
      notes.push("Every result was a personal project or already in the pipeline.");
    }
    return { candidates, notes, errors };
  },
};

/**
 * Turns ICP hints into npm queries.
 *
 * Pairs of terms rather than one long string: npm's search ranks on text
 * relevance, and a six-word query matches nothing. Two technology words find
 * the companies working at their intersection, which is usually the ICP.
 */
export function buildQueries(input: DiscoveryInput): string[] {
  const terms = dedupe([
    ...input.hints,
    ...input.icp.positiveSignals,
    ...input.icp.industries,
  ].map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3 && t.length <= 30 && !/\s{2,}/.test(t)));

  if (terms.length === 0) return [];

  // The strongest hints on their own first, then intersections. Running the
  // pairs first made every query start with the same leading term, so one
  // keyword dominated the whole run and the narrower hints were never asked.
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
  if (/(no-?reply|noreply|bot@|-bot|actions@|oidc)/.test(clean)) return undefined;
  return clean;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
