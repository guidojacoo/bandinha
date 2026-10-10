import { FetchError, USER_AGENT, fetchPage, hostOf } from "./http";

/**
 * robots.txt support.
 *
 * Honouring robots is not optional for a crawler that identifies itself and
 * expects to keep working: ignoring it is how an IP gets blocked, and in
 * several jurisdictions it is evidence of unauthorised access. A site that
 * disallows us is simply not prospected.
 */

export interface RobotsRules {
  /** Path prefixes that are disallowed for our agent. */
  disallow: string[];
  /** Path prefixes explicitly allowed (these win over a longer disallow). */
  allow: string[];
  /** Seconds the site asks crawlers to wait between requests. */
  crawlDelaySeconds?: number;
  /** True when robots.txt could not be read; we then assume permission. */
  assumed: boolean;
}

export const PERMISSIVE: RobotsRules = { disallow: [], allow: [], assumed: true };

/**
 * Parses robots.txt, honouring the most specific matching user-agent group.
 *
 * A named `RainmakerBot` group wins over `*`, per the de-facto standard.
 */
export function parseRobots(text: string, agentToken = "rainmakerbot"): RobotsRules {
  const lines = text.split(/\r?\n/);
  const groups = new Map<string, { disallow: string[]; allow: string[]; delay?: number }>();
  let currentAgents: string[] = [];
  let sawDirective = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      // A new user-agent line after directives starts a fresh group.
      if (sawDirective) {
        currentAgents = [];
        sawDirective = false;
      }
      currentAgents.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) {
        groups.set(value.toLowerCase(), { disallow: [], allow: [] });
      }
      continue;
    }

    if (currentAgents.length === 0) continue;
    sawDirective = true;

    for (const agent of currentAgents) {
      const g = groups.get(agent)!;
      if (field === "disallow" && value) g.disallow.push(value);
      else if (field === "disallow" && !value) {
        /* "Disallow:" with no value means allow everything */
      } else if (field === "allow" && value) g.allow.push(value);
      else if (field === "crawl-delay") {
        const d = Number(value);
        if (Number.isFinite(d) && d >= 0) g.delay = d;
      }
    }
  }

  const specific = groups.get(agentToken);
  const wildcard = groups.get("*");
  const chosen = specific ?? wildcard;
  if (!chosen) return { disallow: [], allow: [], assumed: false };

  return {
    disallow: chosen.disallow,
    allow: chosen.allow,
    crawlDelaySeconds: chosen.delay,
    assumed: false,
  };
}

function pathMatches(pathname: string, rule: string): boolean {
  // robots.txt wildcards: * matches any run, $ anchors the end.
  if (!rule) return false;
  const hasEnd = rule.endsWith("$");
  const body = hasEnd ? rule.slice(0, -1) : rule;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${hasEnd ? "$" : ""}`).test(pathname);
}

export function isAllowed(url: string, rules: RobotsRules): boolean {
  let pathname: string;
  try {
    const u = new URL(url);
    pathname = u.pathname + u.search;
  } catch {
    return false;
  }

  const longestMatch = (patterns: string[]): number =>
    patterns.reduce((best, p) => (pathMatches(pathname, p) ? Math.max(best, p.length) : best), -1);

  const deny = longestMatch(rules.disallow);
  if (deny === -1) return true;
  // A more specific Allow overrides a Disallow.
  return longestMatch(rules.allow) >= deny;
}

const cache = new Map<string, RobotsRules>();

export async function loadRobots(siteUrl: string): Promise<RobotsRules> {
  const host = hostOf(siteUrl);
  const cached = cache.get(host);
  if (cached) return cached;

  let rules: RobotsRules;
  try {
    const origin = new URL(siteUrl).origin;
    const page = await fetchPage(`${origin}/robots.txt`, { timeoutMs: 6000 });
    rules = parseRobots(page.html, USER_AGENT.split("/")[0]!.toLowerCase());
  } catch (err) {
    // 404 (no robots.txt) means everything is permitted. A network failure is
    // treated the same way rather than blocking the crawl entirely, but it is
    // marked `assumed` so callers can tell the difference.
    if (err instanceof FetchError && err.kind === "http" && err.status === 404) {
      rules = { disallow: [], allow: [], assumed: false };
    } else {
      rules = PERMISSIVE;
    }
  }

  cache.set(host, rules);
  return rules;
}

/** Test seam: clears memoised robots rules. */
export function resetRobotsCache(): void {
  cache.clear();
}
