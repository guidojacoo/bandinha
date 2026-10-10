import { describe, expect, it } from "vitest";
import { containsKeyword, findDisqualifier, scoreFit, selfDescription } from "../src/core/fit";
import { icp, lead } from "./factories";

describe("containsKeyword", () => {
  it("matches whole words only", () => {
    // Substring matching made "ai" hit "said" and mailed a bakery about
    // observability tooling.
    expect(containsKeyword("he said nothing", "ai")).toBe(false);
    expect(containsKeyword("we use ai for routing", "ai")).toBe(true);
  });

  it("matches across punctuation and hyphens", () => {
    expect(containsKeyword("our on-call rotation", "on-call")).toBe(true);
    expect(containsKeyword("uptime, latency, cost", "latency")).toBe(true);
  });

  it("ignores an empty keyword", () => {
    expect(containsKeyword("anything", "")).toBe(false);
  });

  it("does not match a keyword inside a longer word", () => {
    expect(containsKeyword("scrambled", "crm")).toBe(false);
  });
});

describe("scoreFit", () => {
  it("scores an on-target lead highly", () => {
    const result = scoreFit(lead(), icp());
    expect(result.score).toBeGreaterThan(70);
    expect(["strong", "good"]).toContain(result.band);
  });

  it("gives evidence more weight than any firmographic", () => {
    const withEvidence = scoreFit(lead(), icp()).score;
    const withoutEvidence = scoreFit(lead({ evidence: [] }), icp()).score;
    expect(withEvidence - withoutEvidence).toBeGreaterThan(20);
  });

  it("disqualifies a direct competitor outright", () => {
    const competitor = lead({
      companyName: "Burnrate",
      description: "Burnrate is error budget tracking and service level objectives for platform teams.",
      industry: "observability",
    });
    const result = scoreFit(competitor, icp());
    expect(result.band).toBe("disqualified");
    expect(result.score).toBe(0);
    expect(result.disqualifiedBecause).toBeTruthy();
  });

  it("does not disqualify a prospect that merely mentions the category", () => {
    // A prospect's engineering blog discussing error budgets is a buying
    // signal. Matching disqualifiers against the whole crawl flagged it as a
    // competitor and skipped the best lead in the run.
    const prospect = lead({
      evidence: [{
        signal: "on-call",
        quote: "We tried rolling our own error budget tracking in spreadsheets and gave up after a quarter.",
        source: "https://fableworks.test/blog",
      }],
    });
    expect(scoreFit(prospect, icp()).band).not.toBe("disqualified");
  });

  it("penalises a company far outside the size band", () => {
    const tiny = scoreFit(lead({ employeeEstimate: 2 }), icp()).score;
    const right = scoreFit(lead({ employeeEstimate: 180 }), icp()).score;
    expect(tiny).toBeLessThan(right);
    const sizeSignal = scoreFit(lead({ employeeEstimate: 2 }), icp()).signals.find((s) => s.id === "size");
    // A 2-person startup is not a 0.79 match for a 50-500 ICP, however wide
    // the band is.
    expect(sizeSignal?.value ?? 1).toBeLessThan(0.4);
  });

  it("drops unknown signals from the denominator instead of scoring them zero", () => {
    const unknown = lead({ employeeEstimate: undefined, location: undefined, technologies: [] });
    const result = scoreFit(unknown, icp());
    for (const id of ["size", "geography", "technology"]) {
      expect(result.signals.find((s) => s.id === id)?.value).toBeNull();
    }
    // Still scoreable on what we do know.
    expect(result.score).toBeGreaterThan(40);
  });

  it("counts a signal matched twice only once", () => {
    const duplicated = icp({ painSignals: ["on-call"], positiveSignals: ["on-call"] });
    const result = scoreFit(lead(), duplicated);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("requires a contactable address to score contactability", () => {
    const noContacts = scoreFit(lead({ publicContacts: [] }), icp());
    expect(noContacts.signals.find((s) => s.id === "contactability")?.value).toBe(0);
  });

  it("never returns a score outside 0..100", () => {
    for (const candidate of [lead(), lead({ evidence: [] }), lead({ publicContacts: [] })]) {
      const { score } = scoreFit(candidate, icp());
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it("explains itself", () => {
    expect(scoreFit(lead(), icp()).reasons.length).toBeGreaterThan(0);
  });
});

describe("selfDescription", () => {
  it("covers name, tagline and industry but not the whole crawl", () => {
    const text = selfDescription(lead());
    expect(text).toMatch(/fableworks/i);
    expect(text).not.toMatch(/paged more than forty times/i);
  });
});

describe("findDisqualifier", () => {
  it("returns null for a clean lead", () => {
    expect(findDisqualifier(lead(), icp())).toBeNull();
  });

  it("does not flag a company merely for sharing the seller's name", () => {
    // Matching the seller's own name flagged every prospect that linked to us.
    const mentions = lead({ description: "We evaluated Northwind last year for logistics telemetry." });
    expect(findDisqualifier(mentions, icp())).toBeNull();
  });
});
