import { registrableHost } from "../crawler/http";
import { looksLikeCompanyDomain, type DiscoveryContext, type ProspectCandidate, type ProspectSource } from "./types";

/**
 * Operator-supplied domains.
 *
 * The highest-precision source there is — a list someone already decided is
 * worth approaching — and the right way to feed in an existing CRM export or
 * a conference attendee list.
 */
export class SeedSource implements ProspectSource {
  readonly name = "seed-list";

  constructor(private readonly domains: string[]) {}

  available(): boolean {
    return this.domains.length > 0;
  }

  unavailableReason(): string {
    return "No seed domains configured.";
  }

  async discover(ctx: DiscoveryContext): Promise<ProspectCandidate[]> {
    const out: ProspectCandidate[] = [];
    for (const raw of this.domains) {
      const url = raw.startsWith("http") ? raw : `https://${raw}`;
      const domain = registrableHost(url);
      if (!domain || !looksLikeCompanyDomain(domain)) continue;
      if (ctx.exclude.has(domain)) continue;
      if (out.some((c) => c.domain === domain)) continue;
      out.push({ domain, url, discoveredVia: "seed list" });
      if (out.length >= ctx.limit) break;
    }
    return out;
  }
}
