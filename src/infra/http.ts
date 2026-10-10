/**
 * The only place in the codebase that calls `fetch` against the open web.
 *
 * Centralised so politeness is not optional: a real user agent naming the
 * project, a timeout on every request, a per-host delay, a cap on response
 * size, and robots.txt honoured before a page is read. A crawler that
 * ignores these gets a project's IP blocked, which for a tool whose entire
 * lead supply is open data is fatal.
 */

export const USER_AGENT =
  process.env.MERCURIO_USER_AGENT ??
  "MercurioBot/1.0 (+https://github.com/mercurio-agent; open-data sales research)";

const DEFAULT_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS ?? 12_000);
const MAX_BYTES = Number(process.env.HTTP_MAX_BYTES ?? 2_000_000);
const PER_HOST_DELAY_MS = Number(process.env.HTTP_PER_HOST_DELAY_MS ?? 1_200);

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  contentType: string;
  body: string;
  error?: string;
  /** True when the response was cut off at the size cap. */
  truncated: boolean;
}

const lastRequestAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One request per host at a time, spaced by `PER_HOST_DELAY_MS`. */
async function waitForTurn(host: string): Promise<void> {
  const previous = lastRequestAt.get(host) ?? 0;
  const wait = previous + PER_HOST_DELAY_MS - Date.now();
  // Claim the slot before awaiting, so concurrent callers queue rather than
  // all reading the same stale timestamp and firing at once.
  lastRequestAt.set(host, Math.max(Date.now(), previous + PER_HOST_DELAY_MS));
  if (wait > 0) await sleep(wait);
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  accept?: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  /** Skip the politeness delay. For APIs with their own rate limits. */
  immediate?: boolean;
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const base: FetchResult = {
    ok: false, status: 0, url, finalUrl: url, contentType: "", body: "", truncated: false,
  };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...base, error: "Not a URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ...base, error: `Unsupported protocol ${parsed.protocol}` };
  }

  if (!options.immediate) await waitForTurn(parsed.host);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(parsed.toString(), {
      method: options.method ?? "GET",
      body: options.body,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": USER_AGENT,
        accept: options.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
        "accept-language": "en,*;q=0.5",
        ...options.headers,
      },
    });

    const contentType = response.headers.get("content-type") ?? "";
    const { text, truncated } = await readCapped(response, options.maxBytes ?? MAX_BYTES);
    return {
      ok: response.ok,
      status: response.status,
      url,
      finalUrl: response.url || url,
      contentType,
      body: text,
      truncated,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, error: controller.signal.aborted ? `Timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a body but stops at `maxBytes`.
 *
 * `response.text()` on a 200MB file is how a crawler runs a machine out of
 * memory. Streaming and cutting off is the difference between a slow page
 * and a dead process.
 */
async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: await response.text(), truncated: false };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      text += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (total - maxBytes))), { stream: false });
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  if (!truncated) text += decoder.decode();
  return { text, truncated };
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

interface RobotsRules {
  /** Disallowed path prefixes that apply to us. */
  disallow: string[];
  allow: string[];
  crawlDelayMs: number;
  /** True when robots.txt could not be read; we proceed, politely. */
  unknown: boolean;
}

const robotsCache = new Map<string, Promise<RobotsRules>>();

export function parseRobots(text: string, agent = "mercuriobot"): RobotsRules {
  const rules: RobotsRules = { disallow: [], allow: [], crawlDelayMs: 0, unknown: false };
  let applies = false;
  let sawSpecific = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(":");
    const key = (keyRaw ?? "").toLowerCase().trim();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      const ua = value.toLowerCase();
      const matchesUs = ua === agent || agent.includes(ua) || ua === "*";
      // A block naming us specifically overrides anything learned from `*`.
      if (ua !== "*" && matchesUs && !sawSpecific) {
        sawSpecific = true;
        rules.disallow = [];
        rules.allow = [];
      }
      applies = sawSpecific ? ua !== "*" && matchesUs : matchesUs;
      continue;
    }
    if (!applies) continue;
    if (key === "disallow" && value) rules.disallow.push(value);
    if (key === "allow" && value) rules.allow.push(value);
    if (key === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) rules.crawlDelayMs = Math.min(30_000, Math.max(0, seconds * 1000));
    }
  }
  return rules;
}

/** Longest-match wins, as in the robots exclusion standard. */
export function robotsAllows(rules: RobotsRules, pathname: string): boolean {
  const match = (patterns: string[]) =>
    patterns
      .filter((p) => pathname.startsWith(p.replace(/\*$/, "")))
      .reduce((longest, p) => (p.length > longest ? p.length : longest), -1);

  const disallowed = match(rules.disallow);
  if (disallowed < 0) return true;
  // A disallow of "/" with no allow blocks the whole site.
  return match(rules.allow) >= disallowed;
}

export async function loadRobots(origin: string): Promise<RobotsRules> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;

  const promise = (async (): Promise<RobotsRules> => {
    const result = await fetchText(`${origin}/robots.txt`, { timeoutMs: 6_000, maxBytes: 200_000, accept: "text/plain" });
    // A 404 means "no restrictions"; a network error means we could not ask,
    // which is recorded rather than treated as permission.
    if (!result.ok) {
      return { disallow: [], allow: [], crawlDelayMs: 0, unknown: result.status === 0 };
    }
    return parseRobots(result.body);
  })();

  robotsCache.set(origin, promise);
  return promise;
}

/** Fetch that asks robots.txt first. Used for every crawl of a third party. */
export async function fetchAllowed(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 0, url, finalUrl: url, contentType: "", body: "", truncated: false, error: "Not a URL." };
  }

  const rules = await loadRobots(parsed.origin);
  if (!robotsAllows(rules, parsed.pathname)) {
    return {
      ok: false, status: 0, url, finalUrl: url, contentType: "", body: "", truncated: false,
      error: "Disallowed by robots.txt",
    };
  }
  if (rules.crawlDelayMs > PER_HOST_DELAY_MS) await sleep(rules.crawlDelayMs - PER_HOST_DELAY_MS);
  return fetchText(url, options);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<{ ok: boolean; data?: T; error?: string; status: number }> {
  const result = await fetchText(url, {
    ...options,
    accept: options.accept ?? "application/json",
    immediate: options.immediate ?? true,
  });
  if (!result.ok) return { ok: false, error: result.error ?? `HTTP ${result.status}`, status: result.status };
  try {
    return { ok: true, data: JSON.parse(result.body) as T, status: result.status };
  } catch (error) {
    return { ok: false, error: `Response was not JSON: ${error instanceof Error ? error.message : String(error)}`, status: result.status };
  }
}
