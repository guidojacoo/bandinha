import { describe, expect, it } from "vitest";
import { brandOf, companyDomainOf, dedupeCandidates, isPlatformHost, registrableDomain, type ProspectCandidate } from "../src/infra/sources/types";
import { harvestOutboundLinks } from "../src/infra/sources/directory";
import { extractDomains, extractTargets } from "../src/infra/sources/seed";
import { buildQueries as buildNpmQueries } from "../src/infra/sources/npm";
import { buildQueries as buildGithubQueries } from "../src/infra/sources/github";
import { buildQuery as buildOverpassQuery } from "../src/infra/sources/osm";
import { describeSources, sourceById, ALL_SOURCES } from "../src/infra/sources";
import { icp } from "./factories";

describe("registrableDomain", () => {
  it.each([
    ["observe.nestjs.com", "nestjs.com"],
    ["www.fableworks.test", "fableworks.test"],
    ["cap.cloud.sap", "cloud.sap"],
    ["a.b.c.example.com", "example.com"],
    ["example.com", "example.com"],
  ])("reduces %s to %s", (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  it("keeps a multi-label public suffix intact", () => {
    // Without the suffix list, acme.co.uk reduces to co.uk and every British
    // company becomes the same lead.
    expect(registrableDomain("shop.acme.co.uk")).toBe("acme.co.uk");
    expect(registrableDomain("acme.com.au")).toBe("acme.com.au");
  });
});

describe("companyDomainOf", () => {
  it("accepts a company homepage", () => {
    expect(companyDomainOf("https://www.pulumi.com/docs")).toBe("pulumi.com");
  });

  it("accepts a bare domain", () => {
    expect(companyDomainOf("langfuse.com")).toBe("langfuse.com");
  });

  it.each([
    "https://github.com/someone/project",
    "https://someone.github.io/project",
    "https://medium.com/@someone/post",
    "https://my-app.vercel.app",
    "https://linkedin.com/company/x",
    "https://docs.readthedocs.io/en/latest",
  ])("refuses the platform URL %s", (url) => {
    expect(companyDomainOf(url)).toBeNull();
  });

  it("refuses a platform host reached through a subdomain", () => {
    expect(companyDomainOf("https://pages.github.com/x")).toBeNull();
  });

  it.each(["", "not a url", "https://192.168.1.1/", "https://localhost:3000"])("refuses %s", (url) => {
    expect(companyDomainOf(url)).toBeNull();
  });

  it("drops the port, which broke contact matching once", () => {
    expect(companyDomainOf("http://example.test:4000/pricing")).toBe("example.test");
  });
});

describe("isPlatformHost", () => {
  it("knows a platform from a company", () => {
    expect(isPlatformHost("github.io")).toBe(true);
    expect(isPlatformHost("mastra.ai")).toBe(false);
  });
});

describe("dedupeCandidates", () => {
  const candidate = (domain: string, extra: Partial<ProspectCandidate> = {}): ProspectCandidate => ({
    domain, url: `https://${domain}`, via: "npm", reason: "test", ...extra,
  });

  it("keeps the richest reading of a repeated domain", () => {
    const result = dedupeCandidates([
      candidate("acme.test"),
      candidate("acme.test", { companyName: "Acme", hints: { description: "They do things." } }),
    ], new Set());
    expect(result).toHaveLength(1);
    expect(result[0]?.companyName).toBe("Acme");
  });

  it("merges one company holding several TLDs", () => {
    // pulumi.com and pulumi.io both publish packages; mailing both means
    // writing to the same people twice.
    const result = dedupeCandidates([candidate("pulumi.io"), candidate("pulumi.com")], new Set());
    expect(result).toHaveLength(1);
    expect(result[0]?.domain).toBe("pulumi.com");
  });

  it("honours the exclusion set", () => {
    expect(dedupeCandidates([candidate("acme.test")], new Set(["acme.test"]))).toEqual([]);
  });
});

describe("brandOf", () => {
  it("strips the suffix", () => {
    expect(brandOf("pulumi.com")).toBe("pulumi");
    expect(brandOf("acme.co.uk")).toBe("acme");
  });
});

describe("harvestOutboundLinks", () => {
  const PAGE = "https://roundup.test/best-observability-tools";
  const HTML = `
    <nav><a href="https://roundup.test/about">About us</a></nav>
    <article>
      <h2><a href="https://grafana.test/">Grafana</a></h2>
      <p>Grafana does dashboards.</p>
      <h2><a href="https://honeycomb.test/pricing">Honeycomb</a></h2>
      <p>Honeycomb does tracing.</p>
      <p><a href="https://twitter.com/author">Follow the author</a></p>
      <p><a href="https://github.com/author/notes">source notes</a></p>
      <p><a href="/privacy">Privacy</a></p>
      <p><a href="https://honeycomb.test/docs">read more</a></p>
    </article>`;

  const links = harvestOutboundLinks(HTML, PAGE);
  const domains = links.map((l) => l.domain);

  it("finds the companies the page lists", () => {
    expect(domains).toContain("grafana.test");
    expect(domains).toContain("honeycomb.test");
  });

  it("excludes the page's own domain", () => {
    expect(domains).not.toContain("roundup.test");
  });

  it("excludes social and code-hosting links", () => {
    expect(domains.join(" ")).not.toMatch(/twitter|github/);
  });

  it("de-duplicates a company linked twice, keeping its name", () => {
    expect(domains.filter((d) => d === "honeycomb.test")).toHaveLength(1);
    expect(links.find((l) => l.domain === "honeycomb.test")?.anchor).toBe("Honeycomb");
  });

  it("drops a domain linked so often it must be infrastructure", () => {
    const spammy = Array.from({ length: 12 }, (_, i) => `<a href="https://cdn.test/asset-${i}.png">x</a>`).join("");
    expect(harvestOutboundLinks(spammy, PAGE).map((l) => l.domain)).not.toContain("cdn.test");
  });

  it("finds nothing on a page with no outbound links", () => {
    expect(harvestOutboundLinks("<p>nothing here</p>", PAGE)).toEqual([]);
  });
});

describe("extractDomains", () => {
  it("reads a comma-separated list", () => {
    expect(extractDomains("acme.test, beta.test,gamma.test")).toEqual(["acme.test", "beta.test", "gamma.test"]);
  });

  it("reads a pasted spreadsheet column with a header", () => {
    expect(extractDomains("domain\nacme.test\nbeta.test\n")).toEqual(["acme.test", "beta.test"]);
  });

  it("reads full URLs", () => {
    expect(extractDomains("https://www.acme.test/pricing")).toEqual(["acme.test"]);
  });

  it("ignores prose and platform links", () => {
    expect(extractDomains("Here are some leads I found on github.com/x yesterday")).toEqual([]);
  });

  it("handles an empty input", () => {
    expect(extractDomains("")).toEqual([]);
  });
});

describe("query building", () => {
  const input = {
    icp: icp({ positiveSignals: ["kubernetes", "prometheus"], industries: ["observability"] }),
    hints: ["observability", "kubernetes"],
    limit: 10,
    exclude: new Set<string>(),
  };

  it("builds npm queries as term pairs, not one long string", () => {
    const queries = buildNpmQueries(input);
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.every((q) => q.split(" ").length <= 2)).toBe(true);
  });

  it("builds nothing from an ICP with no keywords", () => {
    const empty = { ...input, hints: [], icp: icp({ positiveSignals: [], industries: [] }) };
    expect(buildNpmQueries(empty)).toEqual([]);
    expect(buildGithubQueries(empty)).toEqual([]);
  });

  it("uses GitHub topic search when a hint is a valid slug", () => {
    expect(buildGithubQueries(input)[0]).toMatch(/^topic:observability/);
  });

  it("filters out abandoned GitHub repos", () => {
    for (const query of buildGithubQueries(input)) {
      expect(query).toMatch(/stars:>/);
      expect(query).toMatch(/pushed:>/);
    }
  });

  it("builds a valid Overpass query from tags and an area", () => {
    const query = buildOverpassQuery(["shop=hairdresser", "amenity=cafe"], "Berlin", 100);
    expect(query).toContain('area["name"="Berlin"]->.searchArea');
    expect(query).toContain('nwr["shop"="hairdresser"](area.searchArea);');
    expect(query).toContain("out tags 100;");
  });

  it("handles a wildcard OSM tag", () => {
    expect(buildOverpassQuery(["shop=*"], "Lisbon", 50)).toContain('nwr["shop"](area.searchArea);');
  });

  it("escapes quotes out of an area name", () => {
    expect(buildOverpassQuery(["shop=*"], 'Ber"lin', 50)).not.toMatch(/Ber"lin/);
  });
});

describe("the source registry", () => {
  it("resolves every source the ICP router can name", () => {
    for (const id of ["github", "npm", "osm", "directory", "search", "seed"]) {
      expect(sourceById(id)).toBeDefined();
    }
  });

  it("returns undefined for a paid vendor nobody implemented", () => {
    expect(sourceById("apollo")).toBeUndefined();
  });

  it("states each source's confidence honestly", () => {
    // A source that silently returns nothing looks exactly like an ICP with
    // no market, so every source says whether it has been proven.
    for (const source of ALL_SOURCES) {
      expect(["proven", "untested"]).toContain(source.confidence);
      expect(source.coverage.length).toBeGreaterThan(20);
    }
  });

  it("tells the operator what each unconfigured source needs", () => {
    const described = describeSources();
    const search = described.find((s) => s.id === "search");
    expect(search?.configured).toBe(false);
    expect(search?.needs).toMatch(/SEARXNG_URL/);
  });
});

describe("extractTargets", () => {
  it("keeps the scheme and port the operator wrote", () => {
    // companyDomainOf strips them by design, because a domain is the identity
    // of a lead — but a seed entry naming a port means crawl that port.
    const targets = extractTargets("http://intranet.example.test:8080/");
    expect(targets[0]?.domain).toBe("example.test");
    expect(targets[0]?.url).toBe("http://intranet.example.test:8080/");
  });

  it("defaults to https for a bare domain", () => {
    expect(extractTargets("acme.test")[0]?.url).toBe("https://acme.test/");
  });

  it("keeps a path, so a seed entry can point at a subsection", () => {
    expect(extractTargets("https://acme.test/engineering")[0]?.url).toBe("https://acme.test/engineering");
  });
});
