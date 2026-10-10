import { readFile } from "node:fs/promises";
import {
  companyDomainOf, dedupeCandidates, emptyOutput,
  type DiscoveryInput, type DiscoveryOutput, type ProspectCandidate, type ProspectSource,
} from "./types";

/**
 * Domains the operator supplied directly.
 *
 * Always present, always last, and the only source that cannot fail. Two
 * reasons it exists. First, an operator usually has a list already — a
 * conference badge scan, a spreadsheet, twenty companies they have been
 * meaning to contact — and refusing to accept it would be absurd. Second, it
 * is the floor: if every open-data source is down, rate-limited or empty, the
 * agent still has somewhere to look, which is the difference between "slower
 * today" and "broken".
 *
 * Accepts a file path, a comma-separated list, or raw pasted text — anything
 * with domains in it.
 */

export const seedSource: ProspectSource = {
  id: "seed",
  label: "Seed list",
  confidence: "proven",
  coverage: "Exactly the companies the operator listed. Perfect precision, no discovery.",

  async discover(input: DiscoveryInput): Promise<DiscoveryOutput> {
    const raw = await collectRaw(input.hints);
    if (!raw.text.trim()) {
      return emptyOutput(
        raw.errors.length > 0
          ? raw.errors.join(" ")
          : "No seed list given. Set SEED_DOMAINS to a comma-separated list, or SEED_FILE to a file of domains, to contact companies you already know about.",
      );
    }

    const targets = extractTargets(raw.text);
    const candidates: ProspectCandidate[] = targets
      .filter((target) => !input.exclude.has(target.domain))
      .map((target) => ({
        domain: target.domain,
        url: target.url,
        via: "seed" as const,
        reason: "On the operator's seed list.",
      }));

    const notes = [`${targets.length} domain(s) in the seed list, ${candidates.length} not already in the pipeline.`];
    return {
      candidates: dedupeCandidates(candidates, input.exclude).slice(0, input.limit),
      notes,
      errors: raw.errors,
    };
  },
};

async function collectRaw(hints: string[]): Promise<{ text: string; errors: string[] }> {
  const parts: string[] = [];
  const errors: string[] = [];

  const inline = process.env.SEED_DOMAINS ?? "";
  if (inline.trim()) parts.push(inline);
  for (const hint of hints) if (hint.trim()) parts.push(hint);

  const file = process.env.SEED_FILE ?? "";
  if (file.trim()) {
    try {
      parts.push(await readFile(file.trim(), "utf8"));
    } catch (error) {
      errors.push(`Could not read SEED_FILE (${file}): ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  return { text: parts.join("\n"), errors };
}

/**
 * Every domain in a blob of text.
 *
 * Tolerant on purpose: a pasted spreadsheet column, a CSV with headers, a
 * markdown list and a comma-separated string all work. Anything that is not a
 * domain is quietly ignored rather than failing the run.
 */
export interface SeedTarget {
  domain: string;
  /** The URL to crawl, preserving whatever scheme and port were given. */
  url: string;
}

export function extractTargets(text: string): SeedTarget[] {
  const found = new Map<string, SeedTarget>();
  const tokens = text.split(/[\s,;|"'<>()\[\]]+/);

  for (const token of tokens) {
    const trimmed = token.trim().replace(/[.,;:]+$/, "");
    if (!trimmed || trimmed.length < 4 || !trimmed.includes(".")) continue;
    // Skip spreadsheet headers and prose that happens to contain a dot.
    if (/^(domain|website|url|company|name|email)$/i.test(trimmed)) continue;

    const domain = companyDomainOf(trimmed);
    if (!domain || found.has(domain)) continue;

    // The scheme and port the operator wrote are kept. `companyDomainOf`
    // strips them, by design, because a domain is the identity of a lead —
    // but a list entry of `http://intranet.example.com:8080` means crawl
    // exactly that, and rebuilding it as `https://intranet.example.com` is
    // a different machine.
    found.set(domain, { domain, url: toUrl(trimmed, domain) });
  }
  return [...found.values()];
}

function toUrl(token: string, domain: string): string {
  try {
    const parsed = new URL(/^https?:\/\//i.test(token) ? token : `https://${token}`);
    return parsed.toString();
  } catch {
    return `https://${domain}`;
  }
}

/** Just the domains, for callers that do not need the URLs. */
export function extractDomains(text: string): string[] {
  return extractTargets(text).map((target) => target.domain);
}
