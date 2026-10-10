import * as cheerio from "cheerio";
import type { DiscoveredContact } from "../../core/types";
import { normaliseUrl, registrableHost } from "./http";

/**
 * Turns one HTML page into the structured signals the agent reasons over.
 *
 * Deliberately extracts far more than "the text": headcount, location,
 * technology fingerprints and published contacts are what separate a real
 * qualification pass from a keyword match on a blob of marketing copy.
 */

export interface PageExtract {
  url: string;
  title: string;
  description?: string;
  /** Readable body text with navigation and boilerplate removed. */
  text: string;
  /** Internal links, absolute and normalised. */
  internalLinks: string[];
  externalLinks: string[];
  emails: DiscoveredContact[];
  technologies: string[];
  employeeEstimate?: number;
  location?: string;
  /** Organisation facts lifted from schema.org JSON-LD, when present. */
  jsonLd: Record<string, unknown>[];
  socialProfiles: string[];
}

/** Elements that are chrome rather than content. */
const BOILERPLATE = "script, style, noscript, svg, iframe, nav, header, form, template";

/**
 * Technology fingerprints.
 *
 * Each entry is a marker that only appears when the technology is actually in
 * use — a script host, a meta generator, or a framework-specific attribute.
 */
const TECH_MARKERS: Array<{ name: string; test: RegExp }> = [
  { name: "react", test: /__NEXT_DATA__|data-reactroot|react(?:-dom)?(?:\.min)?\.js/i },
  { name: "next.js", test: /__NEXT_DATA__|\/_next\//i },
  { name: "vue", test: /data-v-[0-9a-f]{8}|vue(?:\.min)?\.js/i },
  { name: "angular", test: /ng-version=|angular(?:\.min)?\.js/i },
  { name: "svelte", test: /svelte-[0-9a-z]{6}/i },
  { name: "wordpress", test: /wp-content|wp-includes|name="generator" content="WordPress/i },
  { name: "shopify", test: /cdn\.shopify\.com|Shopify\.theme/i },
  { name: "webflow", test: /webflow\.js|data-wf-page/i },
  { name: "squarespace", test: /squarespace\.com|static1\.squarespace/i },
  { name: "hubspot", test: /js\.hs-scripts\.com|hubspot/i },
  { name: "salesforce", test: /force\.com|salesforce\.com/i },
  { name: "intercom", test: /widget\.intercom\.io|intercomSettings/i },
  { name: "segment", test: /cdn\.segment\.(?:com|io)|analytics\.js/i },
  { name: "google analytics", test: /googletagmanager\.com|gtag\(|google-analytics\.com/i },
  { name: "stripe", test: /js\.stripe\.com|stripe\.com\/v3/i },
  { name: "cloudflare", test: /cdn-cgi\/|cloudflare/i },
  { name: "aws", test: /amazonaws\.com/i },
  { name: "kubernetes", test: /\bkubernetes\b|\bk8s\b/i },
  { name: "docker", test: /\bdocker\b/i },
  { name: "terraform", test: /\bterraform\b/i },
  { name: "datadog", test: /datadoghq|\bdatadog\b/i },
  { name: "sentry", test: /sentry\.io|\bsentry\b/i },
  { name: "postgres", test: /\bpostgre(?:s|sql)\b/i },
  { name: "mongodb", test: /\bmongodb\b/i },
  { name: "graphql", test: /\bgraphql\b/i },
];

const SOCIAL_HOSTS = /(?:linkedin\.com|twitter\.com|x\.com|github\.com|facebook\.com|instagram\.com|youtube\.com)/i;

/** Addresses that are never a sales contact. */
const NON_CONTACT_LOCAL = /^(?:noreply|no-reply|donotreply|postmaster|abuse|mailer-daemon|bounce|unsubscribe|privacy|security|dpo|legal|press|jobs|careers|recruiting)(?:[+-]|$)/i;

const ROLE_LOCAL = /^(?:info|hello|contact|sales|support|admin|office|team|help|enquiries|inquiries|mail|hi)$/i;

/**
 * Pulls a person's name and job title out of the markup around a mailto link.
 *
 * Worth doing properly: without it every email opens "Hi there", and the
 * contactability signal cannot tell a CTO from a generic inbox, so a
 * decision-maker scores the same as a careers address.
 */
export function readContactContext(context: string, email: string): { name?: string; title?: string } {
  const cleaned = context
    .replace(new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > 160) return {};

  // "Priya Raman, VP Engineering" — the overwhelmingly common shape.
  const m = /([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){0,2})\s*[,·|–—-]\s*([A-Za-z][A-Za-z /&-]{2,48})/.exec(cleaned);
  if (m?.[1]) {
    const title = m[2]?.trim().replace(/[.,;]+$/, "");
    return { name: m[1].trim(), title: title && title.length > 1 ? title : undefined };
  }

  const nameOnly = /^([A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,2})\b/.exec(cleaned);
  return nameOnly?.[1] ? { name: nameOnly[1] } : {};
}

export function extractEmails(
  html: string,
  text: string,
  sourceUrl: string,
  $?: cheerio.CheerioAPI,
): DiscoveredContact[] {
  const found = new Map<string, DiscoveredContact>();
  const add = (raw: string, context?: string) => {
    const email = raw.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0]!;
    if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) return;
    const local = email.split("@")[0]!;
    // Skip inboxes nobody should receive sales mail at, and image filenames
    // that happen to look like addresses.
    if (NON_CONTACT_LOCAL.test(local)) return;
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/i.test(email)) return;
    const isRole = ROLE_LOCAL.test(local);
    const { name, title } = context && !isRole ? readContactContext(context, email) : {};
    const existing = found.get(email);
    if (existing) {
      // A later mention may carry the name the first one lacked.
      if (!existing.name && name) existing.name = name;
      if (!existing.title && title) existing.title = title;
      return;
    }
    found.set(email, {
      email,
      name,
      title,
      source: sourceUrl,
      kind: isRole ? "role" : "individual",
    });
  };

  // Prefer the DOM: the surrounding element is where the name and title are.
  if ($) {
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const parentText = $(el).closest("li, p, td, div, article, section").first().text();
      add(href.replace(/^mailto:/i, ""), parentText);
    });
  }

  for (const m of html.matchAll(/mailto:([^"'\s>?]+)/gi)) add(m[1]!);
  for (const m of text.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/g)) add(m[0]);

  return [...found.values()];
}

/**
 * Pulls a headcount out of prose.
 *
 * Only accepts phrasings that unambiguously describe the company's own size —
 * "trusted by 5,000 customers" is not a headcount, and reading it as one
 * would put enterprise-sized companies in a startup ICP.
 */
export function extractEmployeeCount(text: string): number | undefined {
  const patterns: RegExp[] = [
    /\bteam of (?:over |more than |around |about |~)?([\d,]+)\b/i,
    /\b([\d,]+)\+?\s+(?:employees|staff|people work|team members)\b/i,
    /\bwe(?:'| a)re (?:a )?(?:team of )?(?:over |around |about |~)?([\d,]+)(?:\+| people| strong)\b/i,
    /\b(?:employees|headcount|company size)[:\s]+(?:approx\.?\s*)?([\d,]+)\b/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (!m?.[1]) continue;
    const n = Number(m[1].replace(/,/g, ""));
    // Sanity bounds: anything outside this is a misread, not a company.
    if (Number.isFinite(n) && n >= 1 && n <= 500_000) return n;
  }
  return undefined;
}

function collectJsonLd($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      // JSON-LD may be an object, an array, or an @graph wrapper.
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"])
          ? (parsed as { "@graph": unknown[] })["@graph"]
          : [parsed];
      for (const item of items) {
        if (item && typeof item === "object") out.push(item as Record<string, unknown>);
      }
    } catch {
      // Malformed JSON-LD is extremely common; ignore it rather than failing
      // the whole page extraction.
    }
  });
  return out;
}

function locationFromJsonLd(nodes: Record<string, unknown>[]): string | undefined {
  for (const node of nodes) {
    const addr = node.address as Record<string, unknown> | string | undefined;
    if (typeof addr === "string" && addr.trim()) return addr.trim();
    if (addr && typeof addr === "object") {
      const parts = ["streetAddress", "addressLocality", "addressRegion", "addressCountry"]
        .map((k) => addr[k])
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      if (parts.length > 0) return parts.join(", ");
    }
  }
  return undefined;
}

function employeesFromJsonLd(nodes: Record<string, unknown>[]): number | undefined {
  for (const node of nodes) {
    const n = node.numberOfEmployees;
    if (typeof n === "number" && n > 0) return n;
    if (typeof n === "string" && /^\d+$/.test(n)) return Number(n);
    if (n && typeof n === "object") {
      const v = (n as Record<string, unknown>).value ?? (n as Record<string, unknown>).minValue;
      if (typeof v === "number" && v > 0) return v;
      if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
    }
  }
  return undefined;
}

export function extractPage(html: string, url: string): PageExtract {
  const $ = cheerio.load(html);
  const jsonLd = collectJsonLd($);

  const title = ($("title").first().text() || $("h1").first().text() || "").trim();
  const description =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    undefined;

  // Keep the footer: it is where postal addresses and contact emails live.
  const $body = $.root().clone();
  $body.find(BOILERPLATE).remove();
  const text = $body
    .find("body")
    .text()
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const host = registrableHost(url);
  const internal = new Set<string>();
  const external = new Set<string>();
  const socials = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    const abs = normaliseUrl(href, url);
    if (!abs) return;
    if (SOCIAL_HOSTS.test(abs)) socials.add(abs);
    if (registrableHost(abs) === host) internal.add(abs);
    else external.add(abs);
  });

  const technologies = TECH_MARKERS.filter((t) => t.test.test(html)).map((t) => t.name);

  const addressTag = $("address").first().text().replace(/\s+/g, " ").trim();

  return {
    url,
    title,
    description,
    text,
    internalLinks: [...internal],
    externalLinks: [...external],
    emails: extractEmails(html, text, url, $),
    technologies,
    employeeEstimate: employeesFromJsonLd(jsonLd) ?? extractEmployeeCount(text),
    location: locationFromJsonLd(jsonLd) ?? (addressTag.length > 5 ? addressTag : undefined),
    jsonLd,
    socialProfiles: [...socials],
  };
}
