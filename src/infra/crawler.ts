import { fetchAllowed } from "./http";
import { parsePage, type PageText } from "./extract";

/**
 * A polite, budgeted site crawler.
 *
 * Two ideas carry it. First, pages are *prioritised*, not queued in document
 * order: /about, /team and /contact are worth ten blog posts, and a crawl
 * capped at twelve pages that spends them on paginated archives learns
 * nothing. Second, the cap is hard — this runs against companies who did not
 * ask to be crawled, and a budget is the difference between research and a
 * nuisance.
 */

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  timeoutMs?: number;
  /** Extra path priorities, e.g. ICP-specific pages worth finding. */
  extraPriorities?: string[];
  onPage?: (page: PageText, index: number) => void;
}

export interface CrawlResult {
  domain: string;
  origin: string;
  pages: PageText[];
  /** Raw HTML of the first page, for structured-markup extraction. */
  homeHtml: string;
  /**
   * Raw HTML per page, capped per page and held only for this run.
   *
   * Needed because `mailto:` links do not survive the text extraction, and
   * /contact and /team are exactly where a company publishes the people
   * worth writing to. Dropped before anything is persisted — the parsed
   * `pages` are what the database stores.
   */
  html: Map<string, string>;
  errors: Array<{ url: string; error: string }>;
  /** True when the entry URL itself could not be read. */
  failed: boolean;
}

/**
 * Path fragments worth their place in the budget, best first.
 *
 * Ordered by what they tell a salesperson: who the company is, who works
 * there, how to reach them, what they charge, and what they are struggling
 * with. Careers pages are near the top on purpose — a job ad is the most
 * candid document a company publishes about its own problems.
 */
const PRIORITY_PATHS: Array<[RegExp, number]> = [
  [/^\/?$/, 100],
  [/\/(about|about-us|company|who-we-are)\b/i, 90],
  [/\/(team|people|leadership|management|staff|founders)\b/i, 85],
  [/\/(contact|contact-us|get-in-touch|reach-us)\b/i, 80],
  [/\/(careers?|jobs?|hiring|vacancies|join-us)\b/i, 75],
  [/\/(engineering|developers?|tech|platform|infrastructure)\b/i, 70],
  [/\/(pricing|plans|packages)\b/i, 65],
  [/\/(products?|services?|solutions?|features?|what-we-do)\b/i, 60],
  [/\/(customers?|case-stud(?:y|ies)|clients?|success)\b/i, 55],
  [/\/(security|compliance|trust|certifications?)\b/i, 50],
  [/\/(blog|news|insights|resources)\/.+/i, 30],
  [/\/(blog|news|insights|resources)\/?$/i, 25],
];

/** Paths that are never worth a slot. */
const SKIP_PATHS = [
  /\/(privacy|terms|legal|cookies?|imprint|impressum|gdpr|accessibility)\b/i,
  /\/(login|signin|sign-in|signup|sign-up|register|account|dashboard|admin|cart|checkout|basket)\b/i,
  /\/(wp-admin|wp-login|wp-json|xmlrpc)\b/i,
  /\/(tag|tags|category|categories|author|archive|page)\/\d*/i,
  /\/feed\/?$/i, /\/sitemap.*\.xml$/i, /\/rss/i,
  /\.(pdf|zip|docx?|xlsx?|pptx?|csv|png|jpe?g|gif|svg|webp|ico|mp4|mp3|woff2?|ttf|eot|css|js|json|xml)$/i,
];

export function priorityOf(pathname: string, extra: string[] = []): number {
  if (SKIP_PATHS.some((p) => p.test(pathname))) return -1;
  for (const hint of extra) {
    if (hint && pathname.toLowerCase().includes(hint.toLowerCase())) return 95;
  }
  for (const [pattern, score] of PRIORITY_PATHS) {
    if (pattern.test(pathname)) return score;
  }
  // Unknown shallow pages are worth something; deep ones almost never are.
  const depth = pathname.split("/").filter(Boolean).length;
  return depth <= 1 ? 20 : Math.max(1, 15 - depth * 4);
}

export function normaliseEntryUrl(input: string): { ok: true; url: string; origin: string; domain: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "No URL given." };
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) return { ok: false, error: `"${input}" is not a hostname.` };
    return { ok: true, url: url.toString(), origin: url.origin, domain: url.hostname.replace(/^www\./, "") };
  } catch {
    return { ok: false, error: `"${input}" is not a URL.` };
  }
}

export async function crawlSite(entry: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? 12;
  const maxDepth = options.maxDepth ?? 2;

  const parsedEntry = normaliseEntryUrl(entry);
  if (!parsedEntry.ok) {
    return { domain: "", origin: "", pages: [], homeHtml: "", html: new Map(), errors: [{ url: entry, error: parsedEntry.error }], failed: true };
  }

  const { origin, domain } = parsedEntry;
  const pages: PageText[] = [];
  const errors: CrawlResult["errors"] = [];
  const html = new Map<string, string>();
  const seen = new Set<string>();
  let homeHtml = "";

  // A priority queue kept as a sorted array: at twelve pages the constant
  // factor of a heap would be noise next to one HTTP request.
  const queue: Array<{ url: string; depth: number; priority: number }> = [
    { url: parsedEntry.url, depth: 0, priority: 100 },
  ];
  seen.add(canonical(parsedEntry.url));

  while (queue.length > 0 && pages.length < maxPages) {
    queue.sort((a, b) => b.priority - a.priority || a.depth - b.depth);
    const next = queue.shift()!;

    const result = await fetchAllowed(next.url, { timeoutMs: options.timeoutMs });
    if (!result.ok) {
      errors.push({ url: next.url, error: result.error ?? `HTTP ${result.status}` });
      // An unreadable entry page means there is nothing to sell from.
      if (next.depth === 0) {
        const retried = await retryWithoutWww(next.url, options.timeoutMs);
        if (!retried) return { domain, origin, pages, homeHtml, html, errors, failed: true };
        pages.push(parsePage(retried.body, retried.finalUrl));
        homeHtml = retried.body;
        html.set(retried.finalUrl, retried.body.slice(0, MAX_RETAINED_HTML));
        continue;
      }
      continue;
    }
    if (!/html/i.test(result.contentType) && result.contentType !== "") {
      continue;
    }

    const page = parsePage(result.body, result.finalUrl);
    if (next.depth === 0) homeHtml = result.body;
    html.set(result.finalUrl, result.body.slice(0, MAX_RETAINED_HTML));
    pages.push(page);
    options.onPage?.(page, pages.length - 1);

    if (next.depth >= maxDepth) continue;
    for (const link of page.links) {
      const key = canonical(link);
      if (seen.has(key)) continue;
      let pathname: string;
      try {
        const parsed = new URL(link);
        if (parsed.origin !== origin) continue;
        pathname = parsed.pathname;
      } catch {
        continue;
      }
      const priority = priorityOf(pathname, options.extraPriorities);
      if (priority < 0) continue;
      seen.add(key);
      queue.push({ url: link, depth: next.depth + 1, priority });
    }
  }

  return { domain, origin, pages, homeHtml, html, errors, failed: pages.length === 0 };
}

/**
 * One retry on the other side of the www prefix.
 *
 * Plenty of sites serve only `www.`, or only the apex, and a redirect is not
 * always configured. Failing the whole run because a user pasted the URL the
 * way their browser shows it would be a bad first impression.
 */
async function retryWithoutWww(url: string, timeoutMs?: number) {
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.startsWith("www.")
      ? parsed.hostname.slice(4)
      : `www.${parsed.hostname}`;
    const result = await fetchAllowed(parsed.toString(), { timeoutMs });
    return result.ok ? result : null;
  } catch {
    return null;
  }
}

/** Per page, to bound memory on a marketing site full of inlined assets. */
const MAX_RETAINED_HTML = Number(process.env.CRAWL_MAX_RETAINED_HTML ?? 400_000);

/** Trailing slashes and index files are the same page. */
function canonical(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/index\.(html?|php)$/i, "/").replace(/(.)\/$/, "$1");
    return parsed.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
