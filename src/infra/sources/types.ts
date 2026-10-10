import type { Icp, Offering } from "../../core/types";

export interface ProspectCandidate {
  /** Registrable host, lowercase, no `www.`. */
  domain: string;
  /** A URL to start crawling from. */
  url: string;
  companyNameHint?: string;
  /** Provenance — which source found this and how. Shown in the UI. */
  discoveredVia: string;
}

export interface DiscoveryContext {
  icp: Icp;
  offering: Offering;
  /** How many new candidates are wanted. */
  limit: number;
  /** Domains already in the pipeline; sources must not return these. */
  exclude: ReadonlySet<string>;
}

/**
 * A way of finding companies.
 *
 * Lead discovery is the part of outbound that vendors charge the most for,
 * and there is no single good free source — so it is an interface with
 * several implementations rather than one hardcoded provider. Each one is
 * independently switchable, and a deployment can add its own (Apollo,
 * Clearbit, an internal CRM export) by implementing this.
 */
export interface ProspectSource {
  readonly name: string;
  /** False when the source is missing configuration it needs. */
  available(): boolean;
  /** Why it is unavailable, for the dashboard. */
  unavailableReason?(): string;
  discover(ctx: DiscoveryContext): Promise<ProspectCandidate[]>;
}

/** Hosts that are never a prospect: infrastructure, social, platforms. */
const NON_COMPANY = [
  "google.com", "googleapis.com", "gstatic.com", "youtube.com", "facebook.com",
  "twitter.com", "x.com", "linkedin.com", "instagram.com", "tiktok.com",
  "github.com", "gitlab.com", "medium.com", "substack.com", "wordpress.com",
  "wikipedia.org", "amazonaws.com", "cloudfront.net", "cloudflare.com",
  "apple.com", "microsoft.com", "adobe.com", "gravatar.com", "w3.org",
  "schema.org", "mozilla.org", "creativecommons.org", "bit.ly", "goo.gl",
  "eventbrite.com", "meetup.com", "crunchbase.com", "glassdoor.com", "indeed.com",
  "stripe.com", "paypal.com", "shopify.com", "squarespace.com", "wix.com",
  "hubspot.com", "mailchimp.com", "zoom.us", "slack.com", "notion.so",
];

const NON_COMPANY_TLD = /\.(gov|mil|edu)(\.[a-z]{2})?$/i;

export function looksLikeCompanyDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  if (!d.includes(".")) return false;
  if (NON_COMPANY_TLD.test(d)) return false;
  return !NON_COMPANY.some((bad) => d === bad || d.endsWith(`.${bad}`));
}
