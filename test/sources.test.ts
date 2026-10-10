import { describe, expect, it } from "vitest";
import { brandOf, companyDomainOf, dedupeCandidates, isPlatformHost, registrableDomain, type ProspectCandidate } from "../src/infra/sources/types";
import { harvestOutboundLinks } from "../src/infra/sources/directory";
import { extractDomains, extractTargets } from "../src/infra/sources/seed";
import {
  buildQueries as buildRegistryQueries, createRegistrySource, cratesAdapter,
  hexAdapter, npmAdapter, packagistAdapter, rubygemsAdapter,
} from "../src/infra/sources/registries";
import { buildQueries as buildGithubQueries } from "../src/infra/sources/github";
import { buildQuery as buildOverpassQuery } from "../src/infra/sources/osm";
import { describeSources, sourceById, ALL_SOURCES } from "../src/infra/sources";
import { rankRegistries } from "../src/core/icp";
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

  it("builds registry queries as single terms and pairs, not one long string", () => {
    const queries = buildRegistryQueries(input);
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.every((query: string) => query.split(" ").length <= 2)).toBe(true);
  });

  it("builds nothing from an ICP with no keywords", () => {
    const empty = { ...input, hints: [], icp: icp({ positiveSignals: [], industries: [] }) };
    expect(buildRegistryQueries(empty)).toEqual([]);
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

describe("the package registries", () => {
  const ADAPTERS = [npmAdapter, packagistAdapter, rubygemsAdapter, cratesAdapter, hexAdapter];

  it("all five are proven and say what they cover", () => {
    for (const adapter of ADAPTERS) {
      expect(adapter.confidence).toBe("proven");
      expect(adapter.coverage.length).toBeGreaterThan(40);
      expect(adapter.ecosystem).toBeTruthy();
    }
  });

  it("none of them can recommend its own documentation site as a lead", () => {
    // Every one of these arrived as a "company homepage" in a live run: a
    // gem whose homepage is its own RubyDoc page, a crate pointing at
    // docs.rs, Hex packages pointing at HexDocs.
    //
    // Asserted against the *global* platform list rather than each adapter's
    // own, which is the stronger invariant: a registry's own host can never
    // leak through any source, not only through itself.
    for (const adapter of ADAPTERS) {
      for (const host of adapter.ownHosts ?? []) {
        expect(companyDomainOf(`https://${host}/some/package`), `${adapter.id} → ${host}`).toBeNull();
      }
    }
  });

  it("asks for a result count where the registry supports one", () => {
    for (const adapter of ADAPTERS) {
      const url = adapter.searchUrl("observability", 25);
      expect(url).toMatch(/^https:\/\//);
      expect(url).toContain("observability");
    }
  });

  it("escapes a query that would otherwise break the URL", () => {
    for (const adapter of ADAPTERS) {
      const url = new URL(adapter.searchUrl("error budget & slo?", 10));
      // The query has to survive intact rather than being chopped at the &.
      const values = [...url.searchParams.values()];
      expect(values, adapter.id).toContain("error budget & slo?");
    }
  });

  describe("parsing", () => {
    it("reads an npm result", () => {
      const hits = npmAdapter.parse({
        objects: [{
          package: {
            name: "@acme/tracing", description: "Tracing for Acme.", date: "2026-08-01T00:00:00Z",
            keywords: ["tracing"], links: { homepage: "https://acme.test/docs" },
            author: { email: "dev@acme.test" },
          },
        }],
      });
      expect(hits[0]).toMatchObject({
        name: "@acme/tracing", homepage: "https://acme.test/docs", contactEmail: "dev@acme.test",
      });
    });

    it("reads a RubyGems result", () => {
      const hits = rubygemsAdapter.parse([
        { name: "acme-slo", info: "SLOs for Rails.", homepage_uri: "https://acme.test", version_created_at: "2026-07-01T00:00:00Z" },
      ]);
      expect(hits[0]).toMatchObject({ name: "acme-slo", homepage: "https://acme.test" });
    });

    it("reads a crates.io result", () => {
      const hits = cratesAdapter.parse({
        crates: [{ name: "acme-otel", description: "OTel for Acme.", homepage: "https://acme.test", keywords: ["otel"] }],
      });
      expect(hits[0]).toMatchObject({ name: "acme-otel", homepage: "https://acme.test" });
    });

    it("reads a Hex result, picking the website over the code host", () => {
      const hits = hexAdapter.parse([
        {
          name: "acme_obs", updated_at: "2026-09-01T00:00:00Z",
          meta: { description: "Observability for Acme.", links: { GitHub: "https://github.com/acme/obs", Website: "https://acme.test" } },
        },
      ]);
      expect(hits[0]!.homepage).toBe("https://acme.test");
    });

    it("reads a Packagist result without mistaking the listing page for a homepage", () => {
      const hits = packagistAdapter.parse({
        results: [{
          name: "acme/laravel-slo", description: "SLOs for Laravel.",
          url: "https://packagist.org/packages/acme/laravel-slo",
          repository: "https://github.com/acme/laravel-slo",
        }],
      });
      expect(hits[0]!.homepage).toBeUndefined();
      expect(hits[0]!.repository).toBe("https://github.com/acme/laravel-slo");
    });

    it("resolves a Packagist homepage and contact from the package document", () => {
      // The one registry that publishes a named maintainer's address.
      const hit = { name: "acme/laravel-slo" };
      expect(packagistAdapter.detailUrl!(hit)).toBe("https://packagist.org/packages/acme/laravel-slo.json");

      const enriched = packagistAdapter.parseDetail!({
        package: {
          name: "acme/laravel-slo",
          versions: {
            "1.0.0": { time: "2024-01-01T00:00:00Z", homepage: "https://old-domain.test" },
            "2.0.0": { time: "2026-06-01T00:00:00Z", homepage: "https://acme.test/", authors: [{ name: "Ana", email: "ana@acme.test" }] },
          },
        },
      }, hit);

      // Newest first: an old release's homepage may be a domain they lost.
      expect(enriched.homepage).toBe("https://acme.test/");
      expect(enriched.contactEmail).toBe("ana@acme.test");
    });

    it("refuses a detail lookup for a name that is not vendor/package", () => {
      expect(packagistAdapter.detailUrl!({ name: "../../etc/passwd" })).toBeNull();
      expect(packagistAdapter.detailUrl!({ name: "no-slash" })).toBeNull();
    });

    it.each([
      ["npm", npmAdapter], ["rubygems", rubygemsAdapter], ["crates", cratesAdapter],
      ["hex", hexAdapter], ["packagist", packagistAdapter],
    ] as const)("survives a %s response of the wrong shape", (_id, adapter) => {
      for (const junk of [null, undefined, {}, [], "a string", { results: "not an array" }, { objects: [null] }]) {
        expect(() => adapter.parse(junk)).not.toThrow();
      }
    });
  });
});

describe("rankRegistries", () => {
  it("sends a Laravel seller to Packagist before npm", () => {
    // npm is larger, and its answer to a Laravel query is mostly noise.
    expect(rankRegistries("A monitoring tool for Laravel and Symfony applications")[0]).toBe("packagist");
  });

  it("sends a Rails seller to RubyGems first", () => {
    expect(rankRegistries("Error budgets for Ruby on Rails teams")[0]).toBe("rubygems");
  });

  it("sends a Rust seller to crates.io first", () => {
    expect(rankRegistries("Zero-copy parsing for Rust and WebAssembly")[0]).toBe("crates");
  });

  it("defaults to npm when the seller names no ecosystem", () => {
    expect(rankRegistries("Error budget tracking for platform teams")[0]).toBe("npm");
  });

  it("always returns every registry, so nothing is unreachable", () => {
    for (const haystack of ["ruby", "php", "nothing in particular"]) {
      expect(new Set(rankRegistries(haystack)).size).toBe(5);
    }
  });
});

describe("the contact paper trail", () => {
  it("records the registry page that published an address", () => {
    // "Where did you get my email" is a question with a legal answer, and
    // `npm:acme.test` is not one.
    expect(npmAdapter.packagePageUrl!({ name: "@acme/tracing" })).toBe("https://www.npmjs.com/package/@acme/tracing");
    expect(rubygemsAdapter.packagePageUrl!({ name: "acme-slo" })).toBe("https://rubygems.org/gems/acme-slo");
    expect(packagistAdapter.packagePageUrl!({ name: "acme/laravel-slo" })).toBe("https://packagist.org/packages/acme/laravel-slo");
  });

  it("builds a source from any adapter without touching the network to do it", () => {
    // The factory is what makes adding a registry a fifteen-line adapter
    // rather than a fifth copy of the same file.
    const source = createRegistrySource({
      ...npmAdapter, id: "npm", label: "Test Registry",
      coverage: "A registry used only to prove the factory is generic enough.",
    });
    expect(source.label).toBe("Test Registry");
    expect(source.confidence).toBe("proven");
    expect(typeof source.discover).toBe("function");
  });
});
