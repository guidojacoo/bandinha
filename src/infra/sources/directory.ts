import { fetchAllowed } from "../http";
import { parsePage } from "../extract";
import {
  companyDomainOf, dedupeCandidates, emptyOutput,
  type DiscoveryInput, type DiscoveryOutput, type ProspectCandidate, type ProspectSource,
} from "./types";

/**
 * Companies harvested from a list somebody else already made.
 *
 * The most underrated free source there is. Every market has pages that
 * enumerate its participants — an association's member list, a conference's
 * exhibitors, a "best X tools in 2026" roundup, a city's trade register. One
 * page can yield fifty on-target domains, and no API, key or quota is
 * involved.
 *
 * The hard part is not fetching, it is telling the companies apart from the
 * furniture: a roundup page links to Twitter, the author's blog, a cookie
 * policy and forty companies. The scoring below is what makes the difference
 * between a usable list and a pile of noise.
 */

export const directorySource: ProspectSource = {
  id: "directory",
  label: "Directory pages",
  confidence: "proven",
  coverage:
    "Companies listed on pages the operator supplies — association members, conference exhibitors, market roundups. Precision depends entirely on the page chosen.",

  async discover(input: DiscoveryInput): Promise<DiscoveryOutput> {
    // Hints may carry URLs from the console; DIRECTORY_URLS is the standing
    // configuration. Keyword hints from the ICP are ignored here — this
    // source reads pages, it does not search for them.
    const urls = [
      ...input.hints,
      ...(process.env.DIRECTORY_URLS ?? "").split(","),
    ]
      .map((hint) => hint.trim())
      .filter((hint) => /^https?:\/\//i.test(hint));
    if (urls.length === 0) {
      return emptyOutput(
        "No directory pages configured. Point DIRECTORY_URLS at pages that list companies in your market — an association's member list, a conference's exhibitor list, a market roundup.",
      );
    }

    const notes: string[] = [];
    const errors: string[] = [];
    const found: ProspectCandidate[] = [];

    for (const url of urls.slice(0, 5)) {
      if (found.length >= input.limit * 2) break;

      const response = await fetchAllowed(url, { timeoutMs: 20_000 });
      if (!response.ok) {
        errors.push(`Could not read ${url}: ${response.error}`);
        continue;
      }

      const harvested = harvestOutboundLinks(response.body, response.finalUrl);
      let kept = 0;
      for (const link of harvested) {
        if (input.exclude.has(link.domain)) continue;
        found.push({
          domain: link.domain,
          url: `https://${link.domain}`,
          companyName: link.anchor && looksLikeName(link.anchor) ? link.anchor : undefined,
          via: "directory",
          reason: `Listed on ${hostOf(response.finalUrl)}${link.anchor ? ` as "${truncate(link.anchor, 60)}"` : ""}.`,
          hints: { description: link.context ? truncate(link.context, 300) : undefined },
        });
        kept++;
      }
      notes.push(`${hostOf(response.finalUrl)}: ${harvested.length} outbound compan${harvested.length === 1 ? "y" : "ies"}, ${kept} new.`);
    }

    return { candidates: dedupeCandidates(found, input.exclude).slice(0, input.limit), notes, errors };
  },
};

export interface HarvestedLink {
  domain: string;
  anchor: string;
  context: string;
}

/**
 * Outbound links on a page that plausibly point at companies.
 *
 * Three filters do the work. The page's own domain is excluded (navigation).
 * Platform hosts are excluded by `companyDomainOf` (social links, the
 * author's GitHub). And a domain linked many times is almost always the
 * page's own infrastructure — a CDN, the publisher's other properties — not
 * fifty separate mentions of one company.
 */
export function harvestOutboundLinks(html: string, pageUrl: string): HarvestedLink[] {
  const page = parsePage(html, pageUrl);
  const self = companyDomainOf(pageUrl);

  // parsePage keeps only same-origin links, which is the opposite of what a
  // directory needs, so the raw anchors are re-read here.
  const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];

  const counts = new Map<string, number>();
  const first = new Map<string, HarvestedLink>();

  for (const match of anchors) {
    const href = match[1] ?? "";
    const anchorText = stripTags(match[2] ?? "");
    if (!/^https?:\/\//i.test(href)) continue;

    const domain = companyDomainOf(href);
    if (!domain || domain === self) continue;

    counts.set(domain, (counts.get(domain) ?? 0) + 1);
    if (!first.has(domain)) {
      first.set(domain, { domain, anchor: anchorText, context: contextAround(page.text, anchorText) });
    } else if (anchorText && !first.get(domain)!.anchor) {
      first.get(domain)!.anchor = anchorText;
    }
  }

  const LINK_SPAM_THRESHOLD = Number(process.env.DIRECTORY_LINK_SPAM_THRESHOLD ?? 8);
  return [...first.values()].filter((link) => (counts.get(link.domain) ?? 0) <= LINK_SPAM_THRESHOLD);
}

function contextAround(text: string, anchor: string): string {
  if (!anchor || anchor.length < 3) return "";
  const at = text.indexOf(anchor);
  if (at < 0) return "";
  return text.slice(Math.max(0, at - 40), at + 260).replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

/** An anchor that is a company name, not "read more" or a bare URL. */
function looksLikeName(anchor: string): boolean {
  if (anchor.length < 2 || anchor.length > 60) return false;
  if (/^https?:\/\//i.test(anchor)) return false;
  if (/^(read more|learn more|click here|visit|website|here|link|more|view|see)\b/i.test(anchor)) return false;
  return /[A-Za-z]{2,}/.test(anchor);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
