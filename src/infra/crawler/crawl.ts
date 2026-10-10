import { FetchError, fetchPage, normaliseUrl, registrableHost } from "./http";
import { extractPage, type PageExtract } from "./extract";
import { isAllowed, loadRobots, type RobotsRules } from "./robots";

/**
 * Whole-site crawl.
 *
 * Budget is small on purpose — a dozen well-chosen pages tell you far more
 * about a company than a hundred blog posts — so link selection is where the
 * value is: pricing, about, team, customers and contact pages carry almost
 * all of the qualifying signal.
 */

export interface SiteCrawl {
  rootUrl: string;
  host: string;
  pages: PageExtract[];
  robots: RobotsRules;
  errors: Array<{ url: string; reason: string }>;
  /** Pages skipped because robots.txt disallowed them. */
  disallowed: string[];
}

export interface CrawlOptions {
  maxPages?: number;
  timeoutMs?: number;
  /** Overrides the robots-derived delay; used by tests and local fixtures. */
  hostDelayMs?: number;
}

/**
 * Link priority. Higher is crawled sooner.
 *
 * A careers page is worth crawling not for the jobs but because it is the
 * most reliable public signal of a company's size and tech stack.
 */
const PATH_PRIORITY: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /\/(pricing|plans)(\/|$)/i, score: 100 },
  { pattern: /\/(about|company|who-we-are)(\/|$)/i, score: 90 },
  { pattern: /\/(product|products|platform|solutions?|features?)(\/|$)/i, score: 85 },
  { pattern: /\/(customers?|case-stud(?:y|ies)|success-stories|clients?)(\/|$)/i, score: 80 },
  { pattern: /\/(team|people|leadership)(\/|$)/i, score: 75 },
  { pattern: /\/(contact|get-in-touch|talk-to-(?:us|sales))(\/|$)/i, score: 70 },
  { pattern: /\/(engineering|tech|developers?|docs?|api)(\/|$)/i, score: 60 },
  { pattern: /\/(careers?|jobs|hiring)(\/|$)/i, score: 55 },
  { pattern: /\/(security|compliance|trust)(\/|$)/i, score: 40 },
  { pattern: /\/(blog|news|press|resources)(\/|$)/i, score: 15 },
];

/** Paths that are never worth the budget. */
const SKIP = /\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|webm|css|js|xml|ico|woff2?)$|\/(privacy|terms|cookie|legal|login|signin|signup|cart|checkout|account)(\/|$)|\/(tag|category|author|page)\/\d*/i;

export function linkPriority(url: string): number {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return -1;
  }
  if (SKIP.test(url)) return -1;
  if (pathname === "/" || pathname === "") return 95;

  for (const { pattern, score } of PATH_PRIORITY) {
    if (pattern.test(pathname)) {
      // Shallow pages beat deep ones at the same category.
      const depth = pathname.split("/").filter(Boolean).length;
      return score - Math.max(0, depth - 1) * 5;
    }
  }
  // Unknown shallow pages are worth a look; deep ones are not.
  const depth = pathname.split("/").filter(Boolean).length;
  return depth <= 1 ? 25 : 5;
}

export async function crawlSite(rootInput: string, options: CrawlOptions = {}): Promise<SiteCrawl> {
  const maxPages = options.maxPages ?? 12;
  const root = normaliseUrl(rootInput.startsWith("http") ? rootInput : `https://${rootInput}`);
  if (!root) throw new FetchError(`"${rootInput}" is not a usable URL`, "network");

  const host = registrableHost(root);
  const robots = await loadRobots(root);
  const hostDelayMs =
    options.hostDelayMs ??
    (robots.crawlDelaySeconds ? Math.min(5000, robots.crawlDelaySeconds * 1000) : undefined);

  const pages: PageExtract[] = [];
  const errors: SiteCrawl["errors"] = [];
  const disallowed: string[] = [];
  const seen = new Set<string>([root]);
  // Frontier of {url, priority}, popped highest-first.
  let frontier: Array<{ url: string; priority: number }> = [{ url: root, priority: 1000 }];

  while (frontier.length > 0 && pages.length < maxPages) {
    frontier.sort((a, b) => b.priority - a.priority);
    const next = frontier.shift()!;

    if (!isAllowed(next.url, robots)) {
      disallowed.push(next.url);
      continue;
    }

    try {
      const page = await fetchPage(next.url, {
        timeoutMs: options.timeoutMs,
        hostDelayMs,
      });
      const extract = extractPage(page.html, page.finalUrl);
      pages.push(extract);

      for (const link of extract.internalLinks) {
        if (seen.has(link)) continue;
        if (registrableHost(link) !== host) continue;
        const priority = linkPriority(link);
        if (priority < 0) continue;
        seen.add(link);
        frontier.push({ url: link, priority });
      }
    } catch (err) {
      errors.push({
        url: next.url,
        reason: err instanceof Error ? err.message : String(err),
      });
      // A failed root is fatal; a failed sub-page is not.
      if (pages.length === 0 && next.url === root) break;
    }
  }

  return { rootUrl: root, host, pages, robots, errors, disallowed };
}

/** Flattens a crawl into one corpus for keyword matching and LLM input. */
export function crawlCorpus(crawl: SiteCrawl, maxChars = 24_000): string {
  const parts: string[] = [];
  for (const page of crawl.pages) {
    parts.push(`## ${page.title || page.url}\n${page.url}\n${page.description ?? ""}\n${page.text}`);
  }
  const joined = parts.join("\n\n---\n\n");
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}\n…[truncated]`;
}

export * from "./http";
export * from "./robots";
export * from "./extract";
