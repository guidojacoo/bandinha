import type { Icp } from "../../core/types";
import type { SourceId } from "../../core/icp";
import { directorySource } from "./directory";
import { githubSource } from "./github";
import { npmSource } from "./npm";
import { osmSource } from "./osm";
import { searchSource } from "./search";
import { seedSource } from "./seed";
import { dedupeCandidates, type DiscoveryOutput, type ProspectCandidate, type ProspectSource } from "./types";

export * from "./types";
export { directorySource, githubSource, npmSource, osmSource, searchSource, seedSource };

export const ALL_SOURCES: ProspectSource[] = [
  githubSource, npmSource, osmSource, directorySource, searchSource, seedSource,
];

const BY_ID = new Map<SourceId, ProspectSource>(ALL_SOURCES.map((s) => [s.id, s]));

export function sourceById(id: string): ProspectSource | undefined {
  return BY_ID.get(id as SourceId);
}

export interface DiscoveryRun {
  candidates: ProspectCandidate[];
  /** What each source did, in the order it was tried. */
  perSource: Array<{ id: SourceId; label: string; confidence: string; found: number; notes: string[]; errors: string[] }>;
  notes: string[];
}

export interface DiscoverOptions {
  icp: Icp;
  limit: number;
  exclude?: ReadonlySet<string>;
  /** Override the ICP's own routing, e.g. from the console. */
  only?: string[];
  /** Extra hints per source, merged over the ICP's. */
  hints?: Record<string, string[]>;
  onProgress?: (message: string) => void;
}

/**
 * Runs the sources the ICP chose, best first, until there are enough leads.
 *
 * Each source is tried in turn and its failure is recorded rather than
 * thrown: the whole point of several partial sources is that one being down
 * degrades the run instead of ending it. Exclusions accumulate across
 * sources, so the second source never spends its quota returning what the
 * first already found.
 */
export async function discoverProspects(options: DiscoverOptions): Promise<DiscoveryRun> {
  const requested = options.only?.length
    ? options.only
    : options.icp.preferredSources.length > 0
      ? options.icp.preferredSources
      : ALL_SOURCES.map((s) => s.id);

  const exclude = new Set(options.exclude ?? []);
  const collected: ProspectCandidate[] = [];
  const perSource: DiscoveryRun["perSource"] = [];
  const notes: string[] = [];

  for (const id of requested) {
    if (collected.length >= options.limit) break;

    const source = sourceById(id);
    if (!source) {
      notes.push(`Unknown source "${id}", skipped.`);
      continue;
    }

    const hints = [
      ...(options.icp.sourceHints[source.id] ?? []),
      ...(options.hints?.[source.id] ?? []),
    ];

    options.onProgress?.(`Asking ${source.label} (${collected.length}/${options.limit} so far)…`);

    let output: DiscoveryOutput;
    try {
      output = await source.discover({
        icp: options.icp,
        hints,
        limit: options.limit - collected.length,
        exclude,
      });
    } catch (error) {
      // A source throwing is a bug in that source, not a reason to abandon
      // the run. Record it and move to the next one.
      output = {
        candidates: [],
        notes: [],
        errors: [`${source.label} threw: ${error instanceof Error ? error.message : String(error)}`],
      };
    }

    for (const candidate of output.candidates) {
      if (exclude.has(candidate.domain)) continue;
      exclude.add(candidate.domain);
      collected.push(candidate);
    }

    perSource.push({
      id: source.id,
      label: source.label,
      confidence: source.confidence,
      found: output.candidates.length,
      notes: output.notes,
      errors: output.errors,
    });
  }

  if (collected.length === 0) {
    notes.push(
      "No prospects were found. The usual causes, in order: the ICP has no keywords a source can query, " +
      "the sources it routed to need configuration (DIRECTORY_URLS, SEED_DOMAINS, SEARXNG_URL), or the ICP really is too narrow.",
    );
  }

  return {
    candidates: dedupeCandidates(collected, new Set()).slice(0, options.limit),
    perSource,
    notes,
  };
}

/** For the console and the doctor: what each source can do right now. */
export function describeSources(): Array<{ id: SourceId; label: string; confidence: string; coverage: string; configured: boolean; needs?: string }> {
  return ALL_SOURCES.map((source) => {
    const requirement = REQUIREMENTS[source.id];
    const configured = requirement ? requirement.satisfied() : true;
    return {
      id: source.id,
      label: source.label,
      confidence: source.confidence,
      coverage: source.coverage,
      configured,
      needs: configured ? undefined : requirement?.hint,
    };
  });
}

const REQUIREMENTS: Partial<Record<SourceId, { satisfied: () => boolean; hint: string }>> = {
  directory: {
    satisfied: () => Boolean((process.env.DIRECTORY_URLS ?? "").trim()),
    hint: "DIRECTORY_URLS — pages that list companies in your market",
  },
  search: {
    satisfied: () => Boolean((process.env.SEARXNG_URL ?? "").trim()),
    hint: "SEARXNG_URL — a SearXNG instance, ideally one you run yourself",
  },
  seed: {
    satisfied: () => Boolean((process.env.SEED_DOMAINS ?? "").trim() || (process.env.SEED_FILE ?? "").trim()),
    hint: "SEED_DOMAINS or SEED_FILE — companies you already want to contact",
  },
};
