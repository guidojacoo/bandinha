import * as cheerio from "cheerio";
import { isUsableQuote } from "../core/evidence";
import { containsKeyword } from "../core/fit";
import { isNeverContact, isValidSyntax } from "../core/deliverability";
import type { DiscoveredContact, LeadEvidence } from "../core/types";

/**
 * HTML into facts.
 *
 * Pure: takes markup and a URL, returns structure. No network, so every
 * extraction rule is testable against a saved page — which matters, because
 * this is where the agent's picture of a company comes from, and a wrong
 * reading here produces a confidently wrong email.
 */

export interface PageText {
  url: string;
  title: string;
  description: string;
  /** Visible body text, scripts and navigation chrome removed. */
  text: string;
  /**
   * The chrome that `text` excludes: nav, header, footer, cookie banners.
   *
   * Kept separately rather than discarded, because it is boilerplate for one
   * purpose and the best source for another — a company's postal address is
   * almost always in the footer, and the footer is the last place we would
   * look for a sentence worth quoting.
   */
  chrome: string;
  headings: string[];
  /** Same-origin links worth following, absolute and de-duplicated. */
  links: string[];
  lang?: string;
}

/** Chrome whose text is worth keeping for addresses, though not for quotes. */
const CHROME_SELECTORS = new Set(["footer", "header", "aside"]);

const STRIP_SELECTORS = [
  "script", "style", "noscript", "template", "svg", "iframe", "form",
  "nav", "header", "footer", "aside", "[aria-hidden=true]",
  ".cookie", "#cookie", ".cookie-banner", ".newsletter", ".breadcrumb",
];

export function parsePage(html: string, url: string): PageText {
  const $ = cheerio.load(html);

  const title = ($("title").first().text() || $('meta[property="og:title"]').attr("content") || "").trim();
  const description = (
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    ""
  ).trim();
  const lang = $("html").attr("lang")?.trim();

  const headings = $("h1, h2, h3")
    .map((_, el) => collapse($(el).text()))
    .get()
    .filter((h) => h.length > 2 && h.length < 160);

  const links = new Set<string>();
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch { /* relative-only extraction below still works */ }

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const absolute = absolutise(href, url);
    if (!absolute) return;
    try {
      if (origin && new URL(absolute).origin !== origin) return;
    } catch {
      return;
    }
    links.add(stripFragment(absolute));
  });

  // Strip chrome *after* harvesting links and headings: the nav is the best
  // source of which pages exist, and a company's h1 often lives in a header.
  const chromeParts: string[] = [];
  for (const selector of STRIP_SELECTORS) {
    if (CHROME_SELECTORS.has(selector)) {
      $(selector).each((_, el) => { chromeParts.push(blockText($, el)); });
    }
    $(selector).remove();
  }

  const root = $("body").length > 0 ? $("body").get(0)! : $.root().get(0)!;
  const text = collapseBlocks(blockText($, root));

  return { url, title, description, text, chrome: collapseBlocks(chromeParts.join("\n")), headings, links: [...links], lang };
}

/**
 * Text with block boundaries preserved as newlines.
 *
 * Cheerio's `.text()` concatenates block contents with no separator, so two
 * paragraphs come back as "…these days.We have an on-call…". Sentence
 * splitting then produces quotes welded together across a block boundary,
 * which is precisely the kind of mangled "quote" that makes outreach look
 * fabricated.
 */
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "li", "tr", "td", "th", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "figcaption",
  "dt", "dd", "address", "main", "header", "footer", "aside", "nav", "ul", "ol", "table",
]);

function blockText($: cheerio.CheerioAPI, node: unknown): string {
  const out: string[] = [];
  const walk = (el: any) => {
    if (!el) return;
    if (el.type === "text") {
      out.push(el.data ?? "");
      return;
    }
    const isBlock = typeof el.name === "string" && BLOCK_TAGS.has(el.name);
    if (isBlock) out.push("\n");
    for (const child of el.children ?? []) walk(child);
    if (isBlock) out.push("\n");
  };
  walk(node);
  return out.join("");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Collapses whitespace but keeps paragraph boundaries, which sentence splitting needs. */
function collapseBlocks(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{2,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function absolutise(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(mailto|tel|javascript|data):/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

function stripFragment(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/** Addresses that are obviously examples, not people. */
const EXAMPLE_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "domain.com", "yourcompany.com",
  "company.com", "email.com", "sentry.io", "wixpress.com", "googlemail.com",
]);

const EXAMPLE_LOCALS = new Set(["your", "youremail", "name", "email", "user", "someone", "firstname", "test"]);

const TITLE_WORDS = /\b(ceo|cto|coo|cfo|cmo|ciso|founder|co-?founder|owner|director|head of [a-z ]{3,30}|vp(?: of)? [a-z ]{3,24}|chief [a-z ]{3,24}|manager|lead|principal|partner)\b/i;

/**
 * Every published address on a page, with whatever name and title sit near it.
 *
 * Deliberately conservative: addresses obfuscated by a script are not
 * harvested, and anything that looks like placeholder copy is dropped. The
 * agent would rather find two real people than twenty strings that look like
 * addresses.
 */
export function extractContacts(html: string, pageUrl: string, companyDomain?: string): DiscoveredContact[] {
  const $ = cheerio.load(html);
  const found = new Map<string, DiscoveredContact>();

  const consider = (rawEmail: string, context: string) => {
    const email = rawEmail.trim().toLowerCase().replace(/[.,;:)\]]+$/, "");
    if (!isValidSyntax(email)) return;
    const [local = "", domain = ""] = email.split("@");
    if (EXAMPLE_DOMAINS.has(domain) || EXAMPLE_LOCALS.has(local)) return;
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(domain)) return;
    // A tracking or vendor address on someone's site is not their employee.
    if (companyDomain && !domainMatches(domain, companyDomain) && !isRoleish(local)) return;
    if (isNeverContact(email)) return;

    const existing = found.get(email);
    const candidate: DiscoveredContact = {
      email,
      name: nameNear(context, email),
      title: titleNear(context),
      source: pageUrl,
      kind: isRoleish(local) ? "role" : "individual",
    };
    // Keep whichever reading knows more about the person.
    if (!existing || score(candidate) > score(existing)) found.set(email, candidate);
  };

  // mailto links are the highest-confidence source: someone meant them.
  $('a[href^="mailto:" i]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const email = href.replace(/^mailto:/i, "").split("?")[0] ?? "";
    const context = collapse($(el).closest("li, p, div, td, article, section").text() || $(el).text());
    consider(email, context);
  });

  // Then plain text, which catches "write to dana at …" style listings.
  const bodyText = collapse($.root().text());
  for (const match of bodyText.matchAll(EMAIL_RE)) {
    const at = match.index ?? 0;
    consider(match[0], bodyText.slice(Math.max(0, at - 160), at + 160));
  }

  return [...found.values()];
}

function score(contact: DiscoveredContact): number {
  return (contact.name ? 2 : 0) + (contact.title ? 2 : 0) + (contact.kind === "individual" ? 1 : 0);
}

const ROLE_LOCALS = new Set([
  "info", "hello", "hi", "contact", "sales", "support", "team", "office",
  "enquiries", "inquiries", "admin", "help", "mail", "general", "booking",
  "bookings", "reservations", "service", "customerservice",
]);

function isRoleish(local: string): boolean {
  return ROLE_LOCALS.has(local.replace(/[.\-_]/g, ""));
}

function domainMatches(domain: string, companyDomain: string): boolean {
  const company = companyDomain.toLowerCase().replace(/^www\./, "");
  return domain === company || domain.endsWith(`.${company}`) || company.endsWith(`.${domain}`);
}

/**
 * A person's name sitting next to their address.
 *
 * Two capitalised words, not matching known non-name words. Deliberately
 * cautious: addressing someone by the wrong name is worse than not using one.
 */
export function nameNear(context: string, email: string): string | undefined {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]/).filter((p) => p.length > 1 && /^[a-z]+$/i.test(p));

  // The local part itself is the most reliable signal: dana.reyes@ is a name.
  if (parts.length >= 2) {
    return parts.slice(0, 2).map(capitalise).join(" ");
  }

  const candidates = context.match(/\b[A-Z][a-z]{1,15}\s+[A-Z][a-z]{1,15}\b/g) ?? [];
  for (const candidate of candidates) {
    if (NON_NAMES.test(candidate)) continue;
    // Only trust a nearby name when the address itself corroborates it.
    const [first = ""] = candidate.toLowerCase().split(" ");
    if (parts.length === 1 && parts[0]?.toLowerCase() === first) return candidate;
    if (local.toLowerCase().startsWith(first.slice(0, 3))) return candidate;
  }
  return undefined;
}

const NON_NAMES = /\b(Privacy|Policy|Terms|Cookie|Contact|About|Email|Phone|Address|Head Office|Our Team|Get Started|Sign Up|Log In|All Rights|Customer Service|United States|United Kingdom|New York|San Francisco|Los Angeles)\b/i;

export function titleNear(context: string): string | undefined {
  const match = context.match(TITLE_WORDS);
  if (!match) return undefined;
  return collapse(match[0])
    .split(" ")
    .map((w) => (w.length <= 4 && w === w.toLowerCase() && /^[a-z]+$/.test(w) ? w : capitalise(w)))
    .join(" ");
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Splits text into sentences well enough to quote one back to its author.
 *
 * Not a general-purpose splitter: it keeps abbreviations and decimals intact,
 * because a quote cut mid-number reads as sloppy at best and fabricated at
 * worst.
 */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|LLC|GmbH|Co|vs|etc|e\.g|i\.e|No|Fig|approx)\.\s/gi, (m) => m.replace(".", "\u0001"))
    .replace(/(\d)\.(\d)/g, "$1\u0001$2");

  return protectedText
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\u0001/g, ".").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

/**
 * Finds sentences on the prospect's own pages that match an ICP signal.
 *
 * This is the function that makes or breaks the evidence gate: it is the only
 * source of the quotes that justify contacting anyone. It returns at most one
 * quote per signal per page, best first, so a page that repeats a keyword
 * fifteen times does not look like fifteen pieces of evidence.
 */
export function findEvidence(pages: PageText[], signals: string[], limit = 8): LeadEvidence[] {
  const byKey = new Map<string, LeadEvidence & { weight: number }>();

  for (const page of pages) {
    const sentences = splitSentences(page.text);
    for (const signal of signals) {
      let best: { quote: string; weight: number } | null = null;
      for (const sentence of sentences) {
        if (!containsKeyword(sentence, signal)) continue;
        if (!isUsableQuote(sentence)) continue;
        // First person means they are describing themselves, not the market.
        const firstPerson = /\b(we|our|us|i'?m|i am)\b/i.test(sentence) ? 2 : 0;
        const weight = firstPerson + Math.min(2, sentence.length / 120);
        if (!best || weight > best.weight) best = { quote: sentence, weight };
      }
      if (!best) continue;
      const key = `${signal}::${page.url}`;
      byKey.set(key, { signal, quote: best.quote, source: page.url, weight: best.weight });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map(({ signal, quote, source }) => ({ signal, quote, source }));
}

// ---------------------------------------------------------------------------
// Firmographics
// ---------------------------------------------------------------------------

const TECH_FINGERPRINTS: Array<[string, RegExp]> = [
  ["kubernetes", /\bkubernetes\b|\bk8s\b/i],
  ["docker", /\bdocker\b/i],
  ["terraform", /\bterraform\b/i],
  ["prometheus", /\bprometheus\b/i],
  ["grafana", /\bgrafana\b/i],
  ["datadog", /\bdatadog\b/i],
  ["opentelemetry", /\bopentelemetry\b|\botel\b/i],
  ["aws", /\b(aws|amazon web services)\b/i],
  ["gcp", /\b(gcp|google cloud)\b/i],
  ["azure", /\bazure\b/i],
  ["postgres", /\bpostgres(?:ql)?\b/i],
  ["kafka", /\bkafka\b/i],
  ["react", /\breact(?:\.js)?\b/i],
  ["nextjs", /\bnext\.?js\b/i],
  ["typescript", /\btypescript\b/i],
  ["python", /\bpython\b/i],
  ["golang", /\b(golang|go programming)\b/i],
  ["rust", /\brust\b(?! belt)/i],
  ["django", /\bdjango\b/i],
  ["rails", /\b(ruby on )?rails\b/i],
  ["graphql", /\bgraphql\b/i],
  ["stripe", /\bstripe\b/i],
  ["shopify", /\bshopify\b/i],
  ["salesforce", /\bsalesforce\b/i],
  ["hubspot", /\bhubspot\b/i],
  ["microservices", /\bmicro-?services\b/i],
];

export function detectTechnologies(pages: PageText[]): string[] {
  const haystack = pages.map((p) => `${p.title} ${p.description} ${p.text}`).join("\n");
  return TECH_FINGERPRINTS.filter(([, pattern]) => pattern.test(haystack)).map(([name]) => name);
}

/**
 * Headcount, when a company states it.
 *
 * Only ever read from an explicit statement ("a team of 40", "120+
 * employees"). Guessing from page count or office photos produced numbers
 * that then drove a fit score, which is worse than admitting we do not know.
 */
export function guessEmployeeCount(pages: PageText[]): number | undefined {
  const haystack = pages.map((p) => p.text).join("\n");
  const patterns = [
    /\b(?:team of|staff of|we are|we're)\s+(?:over\s+|more than\s+|about\s+|around\s+)?(\d{1,5})\b/i,
    /\b(\d{1,5})\+?\s+(?:employees|people|staff|engineers|team members|colleagues)\b/i,
    /\b(?:employees|headcount|team size)\s*[:–-]\s*(\d{1,5})\b/i,
  ];
  for (const pattern of patterns) {
    const match = haystack.match(pattern);
    const n = Number(match?.[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 500_000) return n;
  }
  return undefined;
}

/**
 * Where a company is, from an address block or a locality meta tag.
 *
 * Note the *absence* of a frequency heuristic. Picking the most common
 * capitalised words scraped the seller's own postal address into the ICP's
 * industry list, and every UK company then scored a perfect industry match.
 */
export function guessLocation(pages: PageText[], html?: string): string | undefined {
  if (html) {
    const $ = cheerio.load(html);
    const locality = $('[itemprop="addressLocality"]').first().text().trim();
    const country = $('[itemprop="addressCountry"]').first().text().trim();
    if (locality) return country ? `${locality}, ${country}` : locality;
    const metaLocality = $('meta[property="business:contact_data:locality"]').attr("content")?.trim();
    if (metaLocality) return metaLocality;
  }

  // The footer is where an address lives, so chrome is included here even
  // though it is excluded from everything the agent quotes.
  const haystack = pages.map((p) => `${p.text}\n${p.chrome}`).join("\n");
  const patterns = [
    /\b(?:based in|headquartered in|offices? in|located in)\s+([A-Z][A-Za-z.'-]+(?:[ ,]+[A-Z][A-Za-z.'-]+){0,3})/,
    /\b\d{4,5}\s+([A-Z][A-Za-z.'-]+)(?:,\s*([A-Z][A-Za-z.'-]+))?\s*$/m,
  ];
  for (const pattern of patterns) {
    const match = haystack.match(pattern);
    if (match?.[1]) return [match[1], match[2]].filter(Boolean).join(", ").trim();
  }
  return undefined;
}

/** A company's own name, preferring what it calls itself over the domain. */
export function guessCompanyName(pages: PageText[], domain: string): string {
  const home = pages[0];
  const fallback = domain.replace(/^www\./, "").split(".")[0] ?? domain;

  const candidates = [
    home?.title?.split(/[|–—:·]/)[0],
    home?.headings?.[0],
  ];
  for (const candidate of candidates) {
    const name = (candidate ?? "").trim();
    if (name.length >= 2 && name.length <= 60 && !/^(home|welcome|index)$/i.test(name)) {
      return name;
    }
  }
  return capitalise(fallback);
}

/** The company's own description, for industry matching and disqualifiers. */
export function selfDescriptionFrom(pages: PageText[]): string {
  const home = pages[0];
  return [home?.description, home?.headings?.slice(0, 3).join(". "), home?.title]
    .filter(Boolean)
    .join(". ")
    .slice(0, 600);
}
