/**
 * Polite HTTP fetching.
 *
 * A sales agent that crawls the open web is a guest on other people's
 * servers. This layer enforces the manners: an honest User-Agent with a
 * contact URL, a hard timeout, a response-size ceiling, a per-host request
 * delay, and no following of redirects off to somewhere unexpected without
 * noticing.
 */

export const USER_AGENT =
  process.env.CRAWLER_USER_AGENT ??
  "RainmakerBot/1.0 (+https://github.com/rainmaker; B2B research crawler)";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB of HTML is already pathological
const MIN_HOST_DELAY_MS = Number(process.env.CRAWLER_HOST_DELAY_MS ?? 400);

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  fetchedAt: Date;
}

export class FetchError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "timeout" | "http" | "too_large" | "not_html" | "blocked",
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

/** Last request time per host, so we never hammer one server. */
const lastHit = new Map<string, number>();

async function waitForHostSlot(host: string, delayMs: number): Promise<void> {
  const previous = lastHit.get(host) ?? 0;
  const earliest = previous + delayMs;
  const now = Date.now();
  if (now < earliest) {
    await new Promise((r) => setTimeout(r, earliest - now));
  }
  lastHit.set(host, Date.now());
}

export function normaliseUrl(input: string, base?: string): string | null {
  try {
    const u = new URL(input, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // Tracking parameters create infinite crawl surface for one real page.
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(p)) u.searchParams.delete(p);
    }
    // Trailing slash is not a distinct page.
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return null;
  }
}

/** Host including port — the right key for per-host rate limiting. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * The site's identity: hostname without `www.` and without the port.
 *
 * Port must be excluded or `example.com:8080` and `example.com` read as two
 * different companies, and an address at `@example.com` stops matching the
 * domain it was published on.
 */
export function registrableHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function fetchPage(
  url: string,
  options: { timeoutMs?: number; hostDelayMs?: number } = {},
): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await waitForHostSlot(hostOf(url), options.hostDelayMs ?? MIN_HOST_DELAY_MS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en",
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new FetchError(`${url} timed out after ${timeoutMs}ms`, "timeout");
    }
    throw new FetchError(
      `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new FetchError(`${url} returned ${res.status}`, "http", res.status);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
    throw new FetchError(`${url} is ${contentType}, not HTML`, "not_html");
  }

  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) {
    throw new FetchError(`${url} is ${declared} bytes, over the ${MAX_BYTES} limit`, "too_large");
  }

  const html = await res.text();
  if (html.length > MAX_BYTES) {
    throw new FetchError(`${url} body is ${html.length} bytes, over the limit`, "too_large");
  }

  return {
    url,
    finalUrl: res.url || url,
    status: res.status,
    contentType,
    html,
    fetchedAt: new Date(),
  };
}

/** Bounded-concurrency map, preserving input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await worker(items[i]!, i);
      }
    },
  );
  await Promise.all(runners);
  return out;
}
