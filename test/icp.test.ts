import { describe, expect, it } from "vitest";
import { competitorPhrases, inferIcp, normaliseIcp, routeSources } from "../src/core/icp";
import { claim, offering } from "./factories";

const DEV_TOOL = offering();

const LOCAL_SERVICE = offering({
  companyName: "Cobble",
  domain: "cobble.test",
  oneLiner: "Cobble handles bookings and reminders for hair salons and barber shops.",
  products: [{
    name: "Cobble Bookings",
    summary: "Online booking that cuts no-shows with automatic SMS reminders.",
    capabilities: ["online booking", "sms reminders", "walk-in queue"],
  }],
  categories: ["salon software", "appointment booking"],
  positioningPhrases: ["appointment booking", "salon management"],
  valueProps: [claim("Stop losing revenue to no-shows.", "https://cobble.test/features")],
  proofPoints: [],
});

describe("competitorPhrases", () => {
  it("surfaces the seller's actual category", () => {
    const phrases = competitorPhrases(DEV_TOOL);
    expect(phrases).toContain("error budget tracking");
    expect(phrases).toContain("service level objectives");
  });

  it("does not return the seller's own name as a category", () => {
    // Matching on the seller's name flagged every prospect that merely
    // mentioned them as a competitor.
    expect(competitorPhrases(DEV_TOOL).some((p) => p.includes("northwind"))).toBe(false);
  });

  it("ranks positioning above body prose", () => {
    // "Northwind SLO" in three page titles used to crowd out the phrase that
    // actually identifies a competitor.
    const noisy = offering({
      positioningPhrases: ["error budget tracking"],
      products: [{
        name: "Widget",
        summary: "lorem ipsum filler text ".repeat(20),
        capabilities: ["filler capability text"],
      }],
    });
    expect(competitorPhrases(noisy)[0]).toBe("error budget tracking");
  });

  it("keeps meaningful business words that a naive stopword list would strip", () => {
    // Stripping "service" as filler destroyed "service level objectives".
    expect(competitorPhrases(DEV_TOOL)).toContain("service level objectives");
  });
});

describe("routeSources", () => {
  it("sends a developer tool to GitHub", () => {
    const { preferredSources, sourceHints } = routeSources(DEV_TOOL);
    expect(preferredSources[0]).toBe("github");
    expect(sourceHints.github?.length).toBeGreaterThan(0);
  });

  it("sends a local service to OpenStreetMap with real OSM tags", () => {
    const { preferredSources, sourceHints } = routeSources(LOCAL_SERVICE);
    expect(preferredSources).toContain("osm");
    expect(sourceHints.osm).toContain("shop=hairdresser");
  });

  it("does not send a salon booking tool to GitHub", () => {
    expect(routeSources(LOCAL_SERVICE).preferredSources).not.toContain("github");
  });

  it("always ends with the operator's own seed list", () => {
    for (const o of [DEV_TOOL, LOCAL_SERVICE]) {
      const { preferredSources } = routeSources(o);
      expect(preferredSources[preferredSources.length - 1]).toBe("seed");
    }
  });

  it("drops a source it has nothing to ask for", () => {
    // A source with no query returns whatever is popular, and the agent
    // writes to strangers. Worse than having no source at all.
    const vague = offering({
      oneLiner: "We help teams.",
      categories: [],
      positioningPhrases: [],
      products: [{ name: "Thing", summary: "It helps.", capabilities: [] }],
      valueProps: [],
      proofPoints: [],
    });
    const { preferredSources, sourceHints } = routeSources(vague);
    for (const id of preferredSources) {
      if (id === "seed") continue;
      expect(sourceHints[id]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("inferIcp", () => {
  it("derives buyer titles from the seller's vocabulary", () => {
    expect(inferIcp(DEV_TOOL).buyerTitles.join(" ")).toMatch(/Engineering|CTO|SRE/);
    expect(inferIcp(LOCAL_SERVICE).buyerTitles.join(" ")).toMatch(/Owner|Manager/);
  });

  it("sizes a local business band differently from a software buyer", () => {
    expect(inferIcp(LOCAL_SERVICE).sizeMax).toBeLessThan(inferIcp(DEV_TOOL).sizeMax);
  });

  it("always carries competitor phrases as negative signals", () => {
    expect(inferIcp(DEV_TOOL).negativeSignals).toContain("error budget tracking");
  });

  it("extracts problem phrasings a prospect would use about themselves", () => {
    expect(inferIcp(LOCAL_SERVICE).painSignals.join(" ")).toMatch(/no-shows|revenue/);
  });

  it("leaves industries empty rather than guessing", () => {
    // Frequency-based guessing scraped the seller's own postal address and
    // produced ["bristol", "budget", "kingdom"], so every UK company scored
    // as a perfect industry match and the whole run was mistargeted.
    const noCategories = offering({ categories: [] });
    expect(inferIcp(noCategories).industries).toEqual([]);
  });

  it("routes sources as part of deriving the ICP", () => {
    expect(inferIcp(DEV_TOOL).preferredSources.length).toBeGreaterThan(0);
  });
});

describe("normaliseIcp", () => {
  it("swaps a size band given backwards", () => {
    const icp = normaliseIcp({ sizeMin: 500, sizeMax: 50 }, DEV_TOOL);
    expect(icp.sizeMin).toBe(50);
    expect(icp.sizeMax).toBe(500);
  });

  it("clamps absurd sizes", () => {
    const icp = normaliseIcp({ sizeMin: -20, sizeMax: 90_000_000 }, DEV_TOOL);
    expect(icp.sizeMin).toBeGreaterThanOrEqual(1);
    expect(icp.sizeMax).toBeLessThanOrEqual(500_000);
  });

  it("falls back to the heuristic band when the model omits sizes", () => {
    const icp = normaliseIcp({}, DEV_TOOL);
    expect(icp.sizeMin).toBe(inferIcp(DEV_TOOL).sizeMin);
  });

  it("drops address fragments the model mistook for industries", () => {
    const icp = normaliseIcp({ industries: ["observability", "12 Rue Example", "75001", "of"] }, DEV_TOOL);
    expect(icp.industries).toEqual(["observability"]);
  });

  it("truncates a runaway keyword list", () => {
    const icp = normaliseIcp({ painSignals: Array.from({ length: 200 }, (_, i) => `signal-${i}`) }, DEV_TOOL);
    expect(icp.painSignals.length).toBeLessThanOrEqual(16);
  });

  it("merges competitor phrases in rather than trusting the model's list", () => {
    const icp = normaliseIcp({ negativeSignals: ["something else entirely"] }, DEV_TOOL);
    expect(icp.negativeSignals).toContain("error budget tracking");
    expect(icp.negativeSignals).toContain("something else entirely");
  });

  it("ignores a requested source that does not exist", () => {
    const icp = normaliseIcp({ preferredSources: ["apollo", "zoominfo"] }, DEV_TOOL);
    expect(icp.preferredSources).not.toContain("apollo");
    expect(icp.preferredSources).toContain("seed");
  });

  it("keeps a source the ICP legitimately asked for", () => {
    const icp = normaliseIcp({ preferredSources: ["github"] }, DEV_TOOL);
    expect(icp.preferredSources[0]).toBe("github");
  });

  it("recovers from an entirely empty model response", () => {
    const icp = normaliseIcp({}, DEV_TOOL);
    expect(icp.buyerTitles.length).toBeGreaterThan(0);
    expect(icp.painSignals.length).toBeGreaterThan(0);
    expect(icp.preferredSources.length).toBeGreaterThan(0);
    expect(icp.summary.length).toBeGreaterThan(0);
  });
});
