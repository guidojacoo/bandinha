import { DirectorySource } from "./directory";
import { SearchSource } from "./search";
import { SeedSource } from "./seed";
import type { DiscoveryContext, ProspectCandidate, ProspectSource } from "./types";

export * from "./types";
export * from "./seed";
export * from "./directory";
export * from "./search";

function listFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Builds the source registry from configuration, in priority order. */
export function sourcesFromEnv(env = process.env): ProspectSource[] {
  return [
    new SeedSource(listFromEnv(env.SEED_DOMAINS)),
    new DirectorySource(listFromEnv(env.DIRECTORY_URLS), {
      hostDelayMs: env.CRAWLER_HOST_DELAY_MS ? Number(env.CRAWLER_HOST_DELAY_MS) : undefined,
    }),
    new SearchSource(),
  ];
}

export interface DiscoveryReport {
  candidates: ProspectCandidate[];
  /** Per-source outcome, so an empty run is explainable rather than mysterious. */
  bySource: Array<{ source: string; found: number; skipped?: string }>;
}

/**
 * Runs every available source until the limit is met.
 *
 * Sources run in order and later ones only fill the remaining gap, so a
 * precise source (a seed list) is never diluted by a broad one (search).
 */
export async function discoverProspects(
  sources: ProspectSource[],
  ctx: DiscoveryContext,
): Promise<DiscoveryReport> {
  const seen = new Set(ctx.exclude);
  const candidates: ProspectCandidate[] = [];
  const bySource: DiscoveryReport["bySource"] = [];

  for (const source of sources) {
    const remaining = ctx.limit - candidates.length;
    if (remaining <= 0) break;

    if (!source.available()) {
      bySource.push({
        source: source.name,
        found: 0,
        skipped: source.unavailableReason?.() ?? "unavailable",
      });
      continue;
    }

    let found: ProspectCandidate[] = [];
    try {
      found = await source.discover({ ...ctx, limit: remaining, exclude: seen });
    } catch (err) {
      bySource.push({
        source: source.name,
        found: 0,
        skipped: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const fresh = found.filter((c) => !seen.has(c.domain));
    for (const c of fresh) seen.add(c.domain);
    candidates.push(...fresh);
    bySource.push({ source: source.name, found: fresh.length });
  }

  return { candidates, bySource };
}
