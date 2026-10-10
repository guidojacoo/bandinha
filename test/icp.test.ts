import { describe, expect, it } from "vitest";
import { competitorPhrases, deriveIcpHeuristically, keywordsFrom, mergeIcp } from "../src/core/icp";
import { findDisqualifier, scoreFit, selfDescription } from "../src/core/fit";
import { icp, lead, offering } from "./fixtures";

describe("competitorPhrases", () => {
  it("extracts the seller's own positioning as multi-word phrases", () => {
    const phrases = competitorPhrases(
      offering({ oneLiner: "Error budget tracking for engineering teams running microservices." }),
    );
    expect(phrases.some((p) => p.includes("error budget"))).toBe(true);
    // Single words would be far too broad to use as disqualifiers.
    expect(phrases.every((p) => p.includes(" "))).toBe(true);
  });
});

describe("deriveIcpHeuristically", () => {
  it("does not put the seller's own name or domain into its target market", () => {
    const derived = deriveIcpHeuristically(
      offering({ companyName: "Northwind Analytics", domain: "northwind.example" }),
    );
    const everything = [...derived.industries, ...derived.painSignals, ...derived.positiveSignals].join(" ");
    expect(everything).not.toContain("northwind");
    expect(everything).not.toContain("example");
  });

  it("produces a usable profile with no model available", () => {
    const derived = deriveIcpHeuristically(offering());
    expect(derived.buyerTitles.length).toBeGreaterThan(0);
    expect(derived.painSignals.length).toBeGreaterThan(0);
    expect(derived.sizeMin).toBeLessThan(derived.sizeMax);
  });

  it("picks buyer titles appropriate to the product category", () => {
    const technical = deriveIcpHeuristically(offering({ categories: ["devops", "observability"] }));
    expect(technical.buyerTitles.join(" ")).toMatch(/CTO|Engineering/);
    const financial = deriveIcpHeuristically(offering({ categories: ["invoice", "accounting"] }));
    expect(financial.buyerTitles.join(" ")).toMatch(/CFO|Finance/);
  });
});

describe("mergeIcp", () => {
  it("keeps the heuristic floor where the override is empty", () => {
    const base = deriveIcpHeuristically(offering());
    const merged = mergeIcp(base, { industries: [], buyerTitles: ["CTO"] });
    expect(merged.industries).toEqual(base.industries);
    expect(merged.buyerTitles).toEqual(["CTO"]);
  });

  it("repairs an inverted size band rather than trusting it", () => {
    const merged = mergeIcp(deriveIcpHeuristically(offering()), { sizeMin: 900, sizeMax: 20 });
    expect(merged.sizeMin).toBeLessThanOrEqual(merged.sizeMax);
  });
});

describe("disqualifying competitors", () => {
  /**
   * The bug this pins: a direct competitor was enrolled and mailed at score
   * 77. Disqualifiers were matched on the seller's *name*, which a competitor
   * never mentions, and against the whole crawled corpus, which a genuine
   * buyer's engineering blog trips constantly. Both were wrong.
   */
  it("disqualifies a company that sells what we sell", () => {
    const seller = offering({ oneLiner: "Error budget tracking for engineering teams running microservices." });
    const derived = deriveIcpHeuristically(seller);
    const competitor = lead({
      companyName: "SLOScope",
      description: "SLOScope is an error budget tracking platform for microservices teams running an on-call rota.",
      industry: "observability",
    });
    const result = scoreFit(competitor, derived);
    expect(result.band).toBe("disqualified");
    expect(result.score).toBe(0);
  });

  it("does NOT disqualify a buyer who merely discusses the problem", () => {
    const seller = offering({ oneLiner: "Error budget tracking for engineering teams running microservices." });
    const derived = deriveIcpHeuristically(seller);
    const buyer = lead({
      companyName: "Hoverboard Logistics",
      description: "A SaaS platform for same-day fleet routing, built on kubernetes microservices.",
      industry: "saas",
      evidence: [
        {
          signal: "on-call",
          // Their blog talks about error budgets. That makes them a buyer.
          quote: "We have been trying to get error budget tracking working across 40 microservices.",
          source: "https://hoverboard.example/engineering",
        },
      ],
    });
    expect(scoreFit(buyer, derived).band).not.toBe("disqualified");
  });

  it("matches disqualifiers on self-description, not on page body text", () => {
    const withPhraseInBody = lead({
      description: "A SaaS platform for fleet routing.",
      evidence: [{ signal: "x", quote: "We evaluated an error budget tracking platform last year.", source: "u" }],
    });
    expect(findDisqualifier(withPhraseInBody, icp({ negativeSignals: ["error budget tracking"] }))).toBeNull();

    const withPhraseInDescription = lead({ description: "We are an error budget tracking platform." });
    expect(findDisqualifier(withPhraseInDescription, icp({ negativeSignals: ["error budget tracking"] }))).toBe(
      "error budget tracking",
    );
  });

  it("builds the self-description from name, description and industry only", () => {
    const d = selfDescription(lead({ companyName: "Acme", description: "We do things.", industry: "saas" }));
    expect(d).toBe("acme we do things. saas");
  });
});

describe("keywordsFrom", () => {
  it("ignores stopwords and ranks by frequency", () => {
    const words = keywordsFrom("kubernetes kubernetes kubernetes the and for routing routing bakery");
    expect(words[0]).toBe("kubernetes");
    expect(words).not.toContain("the");
  });
});
