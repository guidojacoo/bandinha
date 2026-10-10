import { crawlSite } from "../crawler/crawl";
import { registrableHost } from "../crawler/http";
import { looksLikeCompanyDomain, type DiscoveryContext, type ProspectCandidate, type ProspectSource } from "./types";

/**
 * Harvests company links from listing pages.
 *
 * This is how outbound teams actually prospect without a data vendor:
 * industry association member directories, marketplace and integration
 * catalogues, conference sponsor pages, "built with" showcases, review-site
 * category listings. One good directory for a vertical yields hundreds of
 * on-profile companies, each with a website to qualify against.
 *
 * It is also the source that needs no API key and no paid tier.
 */
export class DirectorySource implements ProspectSource {
  readonly name = "directory";

  constructor(
    private readonly directoryUrls: string[],
    private readonly options: { maxPagesPerDirectory?: number; hostDelayMs?: number } = {},
  ) {}

  available(): boolean {
    return this.directoryUrls.length > 0;
  }

  unavailableReason(): string {
    return "No directory URLs configured (DIRECTORY_URLS).";
  }

  async discover(ctx: DiscoveryContext): Promise<ProspectCandidate[]> {
    const found = new Map<string, ProspectCandidate>();

    for (const directory of this.directoryUrls) {
      if (found.size >= ctx.limit) break;
      let directoryHost: string;
      try {
        directoryHost = registrableHost(directory);
      } catch {
        continue;
      }

      let crawl;
      try {
        crawl = await crawlSite(directory, {
          maxPages: this.options.maxPagesPerDirectory ?? 4,
          hostDelayMs: this.options.hostDelayMs,
        });
      } catch {
        continue; // an unreachable directory is not a failure of the run
      }

      for (const page of crawl.pages) {
        for (const link of page.externalLinks) {
          const domain = registrableHost(link);
          if (!domain || domain === directoryHost) continue;
          if (!looksLikeCompanyDomain(domain)) continue;
          if (ctx.exclude.has(domain) || found.has(domain)) continue;
          // Prefer the site root: listing pages often deep-link to a profile.
          let root: string;
          try {
            root = new URL(link).origin;
          } catch {
            continue;
          }
          found.set(domain, {
            domain,
            url: root,
            discoveredVia: `directory: ${page.url}`,
          });
          if (found.size >= ctx.limit) break;
        }
        if (found.size >= ctx.limit) break;
      }
    }

    return [...found.values()];
  }
}
