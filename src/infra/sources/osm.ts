import { fetchText } from "../http";
import {
  companyDomainOf, dedupeCandidates, emptyOutput,
  type DiscoveryInput, type DiscoveryOutput, type ProspectCandidate, type ProspectSource,
} from "./types";

/**
 * Local businesses from OpenStreetMap, via Overpass.
 *
 * The answer to the half of the market that has no GitHub organisation and no
 * npm packages: salons, clinics, restaurants, garages, contractors. OSM is
 * free, open-licensed (ODbL), and covers them because volunteers mapped the
 * high street. For a local-services ICP this is the whole addressable market
 * and it costs nothing — which is the part no paid competitor can match on
 * price, because they are reselling the same public data.
 *
 * Two honesties. First, OSM holds a `website` tag for a minority of places,
 * so expect to query a wide area for a usable list. Second: untested here.
 * Overpass is unreachable from the sandbox this was written in. The query
 * language, the endpoint and the JSON shape are documented and stable; this
 * code against them is not proven, and the console says so.
 */

const ENDPOINTS = (process.env.OVERPASS_URLS ?? [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
].join(",")).split(",").map((u) => u.trim()).filter(Boolean);

interface OverpassResponse {
  elements?: Array<{
    type?: string;
    id?: number;
    tags?: Record<string, string>;
  }>;
  remark?: string;
}

export const osmSource: ProspectSource = {
  id: "osm",
  label: "OpenStreetMap",
  confidence: "untested",
  coverage:
    "Local businesses with a mapped location: shops, clinics, restaurants, trades. Only those with a `website` tag can be contacted, which is a minority of entries.",

  async discover(input: DiscoveryInput): Promise<DiscoveryOutput> {
    const tags = input.hints.filter((h) => h.includes("="));
    if (tags.length === 0) {
      return emptyOutput("No OpenStreetMap tags were derived for this ICP, so there is nothing to ask Overpass for.");
    }
    const areas = input.icp.geographies.length > 0 ? input.icp.geographies : [];
    if (areas.length === 0) {
      return emptyOutput("OpenStreetMap needs a place to search. Add a city or country to the ICP's geographies.");
    }

    const notes: string[] = [];
    const errors: string[] = [];
    const found: ProspectCandidate[] = [];

    for (const area of areas.slice(0, 3)) {
      if (found.length >= input.limit * 2) break;

      const query = buildQuery(tags, area, Math.min(400, input.limit * 10));
      const response = await postOverpass(query);
      if (!response.ok) {
        errors.push(`Overpass query for ${area} failed: ${response.error}`);
        continue;
      }

      const elements = response.data?.elements ?? [];
      let withWebsite = 0;
      for (const element of elements) {
        const tagMap = element.tags ?? {};
        const website = tagMap.website ?? tagMap["contact:website"] ?? tagMap.url;
        if (!website) continue;
        const domain = companyDomainOf(website);
        if (!domain || input.exclude.has(domain)) continue;
        withWebsite++;

        found.push({
          domain,
          url: `https://${domain}`,
          companyName: tagMap.name,
          via: "osm",
          reason: `Mapped in ${area} as ${describeTags(tagMap)}.`,
          hints: {
            description: tagMap.description,
            location: [tagMap["addr:city"] ?? tagMap["addr:suburb"], tagMap["addr:country"]].filter(Boolean).join(", ") || area,
            contactEmail: tagMap.email ?? tagMap["contact:email"],
          },
        });
      }
      notes.push(`${area}: ${elements.length} mapped place(s), ${withWebsite} with a website.`);
    }

    return { candidates: dedupeCandidates(found, input.exclude).slice(0, input.limit), notes, errors };
  },
};

/**
 * An Overpass QL query for tagged places inside a named area.
 *
 * `area[name=...]` rather than a bounding box, because an operator types
 * "Berlin", not four coordinates. `out tags` keeps the response to tags only;
 * geometry would be megabytes we throw away.
 */
export function buildQuery(tags: string[], area: string, limit: number): string {
  const safeArea = area.replace(/["\\\\]/g, "");
  const clauses = tags
    .map((tag) => {
      const [key = "", value = ""] = tag.split("=");
      if (!key) return "";
      const selector = value === "*" || value === "" ? `["${key}"]` : `["${key}"="${value}"]`;
      return `  nwr${selector}(area.searchArea);`;
    })
    .filter(Boolean)
    .join("\n");

  return [
    `[out:json][timeout:60];`,
    `area["name"="${safeArea}"]->.searchArea;`,
    `(`,
    clauses,
    `);`,
    `out tags ${limit};`,
  ].join("\n");
}

async function postOverpass(query: string): Promise<{ ok: boolean; data?: OverpassResponse; error?: string }> {
  let lastError = "no endpoint tried";
  for (const endpoint of ENDPOINTS) {
    const response = await fetchText(endpoint, {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      accept: "application/json",
      timeoutMs: Number(process.env.OVERPASS_TIMEOUT_MS ?? 60_000),
      immediate: true,
    });
    if (!response.ok) {
      // Overpass mirrors shed load constantly; the next one usually answers.
      lastError = response.error ?? `HTTP ${response.status}`;
      continue;
    }
    try {
      return { ok: true, data: JSON.parse(response.body) as OverpassResponse };
    } catch {
      lastError = "Overpass returned a non-JSON body (usually a rate-limit page).";
    }
  }
  return { ok: false, error: lastError };
}

function describeTags(tags: Record<string, string>): string {
  for (const key of ["amenity", "shop", "craft", "office", "leisure", "healthcare", "tourism"]) {
    if (tags[key]) return `${key}=${tags[key]}`;
  }
  return "a mapped business";
}
