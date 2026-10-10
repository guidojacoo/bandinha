import { describe, expect, it } from "vitest";
import {
  bandFor, containsKeyword, contactabilitySignal, findDisqualifier,
  industrySignal, painSignal, scoreFit, sizeSignal,
} from "../src/core/fit";
import { icp, lead } from "./fixtures";

describe("containsKeyword", () => {
  it("matches on whole words only", () => {
    expect(containsKeyword("we use AI heavily", "ai")).toBe(true);
    // The bug this prevents: substring matching turns "said" into an AI signal.
    expect(containsKeyword("she said hello", "ai")).toBe(false);
    expect(containsKeyword("our CRM is messy", "crm")).toBe(true);
    expect(containsKeyword("scrm tooling", "crm")).toBe(false);
  });

  it("matches multi-word phrases", () => {
    expect(containsKeyword("we run an on-call rota", "on-call rota")).toBe(true);
    expect(containsKeyword("Kubernetes Microservices", "kubernetes")).toBe(true);
  });

  it("is safe against regex metacharacters in keywords", () => {
    expect(() => containsKeyword("c++ shop", "c++")).not.toThrow();
    expect(containsKeyword("we are a c++ shop", "c++")).toBe(true);
  });

  it("returns false for empty keywords", () => {
    expect(containsKeyword("anything", "")).toBe(false);
  });
});

describe("individual fit signals", () => {
  it("scores a matching industry", () => {
    expect(industrySignal(lead(), icp()).value).toBeGreaterThan(0.7);
  });

  it("scores zero for a non-matching industry", () => {
    const l = lead({ description: "A family bakery in Leeds.", industry: "food", technologies: [], evidence: [] });
    expect(industrySignal(l, icp()).value).toBe(0);
  });

  it("gives full marks inside the size band and partial credit near its edges", () => {
    expect(sizeSignal(lead({ employeeEstimate: 120 }), icp()).value).toBe(1);
    const near = sizeSignal(lead({ employeeEstimate: 40 }), icp()).value!;   // 80% of min
    const far = sizeSignal(lead({ employeeEstimate: 2 }), icp()).value!;     // 4% of min
    expect(near).toBeGreaterThan(0.5);
    expect(far).toBe(0);
  });

  /**
   * Regression: tolerance used to be derived from the band's *width*, so a
   * wide 50-500 ICP gave a 225-person tolerance and a 2-person startup scored
   * 0.79 on size fit. Tolerance is a ratio to the missed boundary now, which
   * behaves the same at every scale.
   */
  it("scores size misses by ratio, not by the band's width", () => {
    const wide = icp({ sizeMin: 50, sizeMax: 500 });
    const narrow = icp({ sizeMin: 50, sizeMax: 60 });
    // 40 employees is 80% of the minimum in both cases, so both must agree.
    expect(sizeSignal(lead({ employeeEstimate: 40 }), wide).value)
      .toBeCloseTo(sizeSignal(lead({ employeeEstimate: 40 }), narrow).value!, 6);

    // And the falloff is monotonic all the way down.
    const values = [45, 35, 25, 15, 5].map((n) => sizeSignal(lead({ employeeEstimate: n }), wide).value!);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeLessThanOrEqual(values[i - 1]!);
    expect(values.at(-1)).toBe(0);
  });

  it("penalises companies far above the band as well as far below", () => {
    expect(sizeSignal(lead({ employeeEstimate: 5000 }), icp()).value).toBe(0);
    expect(sizeSignal(lead({ employeeEstimate: 600 }), icp()).value!).toBeGreaterThan(0.5);
  });

  it("leaves size unscored when headcount is unknown rather than guessing", () => {
    expect(sizeSignal(lead({ employeeEstimate: undefined }), icp()).value).toBeNull();
  });

  it("saturates pain signals so three strong hits is already a full score", () => {
    const l = lead({
      description: "microservices incident on-call postmortem kubernetes observability",
    });
    expect(painSignal(l, icp()).value).toBe(1);
  });

  it("ranks a named buying-role contact above a role inbox", () => {
    const named = contactabilitySignal(lead(), icp()).value!;
    const roleOnly = contactabilitySignal(
      lead({ publicContacts: [{ email: "info@x.example", source: "https://x.example", kind: "role" }] }),
      icp(),
    ).value!;
    const none = contactabilitySignal(lead({ publicContacts: [] }), icp()).value!;
    expect(named).toBeGreaterThan(roleOnly);
    expect(roleOnly).toBeGreaterThan(none);
    expect(none).toBe(0);
  });
});

describe("scoreFit", () => {
  it("rates an on-profile prospect highly", () => {
    const result = scoreFit(lead(), icp());
    expect(result.score).toBeGreaterThan(70);
    expect(["strong", "good"]).toContain(result.band);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("rates an off-profile prospect poorly", () => {
    const l = lead({
      companyName: "Leeds Bakery",
      description: "Family bakery selling sourdough.",
      industry: "food retail",
      employeeEstimate: 4,
      location: "Leeds, United Kingdom",
      technologies: [],
      evidence: [],
      publicContacts: [],
    });
    expect(scoreFit(l, icp()).score).toBeLessThan(35);
  });

  /**
   * The design decision this pins: a disqualifier is an override, not a
   * weighted term. As a weighted term, an obvious competitor still scored in
   * the 60s on the strength of industry and size, and got mailed.
   */
  it("hard-disqualifies regardless of how good every other signal is", () => {
    const competitor = lead({
      description: "We are an error budget tracking platform for kubernetes microservices on-call teams.",
    });
    const result = scoreFit(competitor, icp());
    expect(result.band).toBe("disqualified");
    expect(result.score).toBe(0);
    expect(result.disqualifiedBecause).toContain("error budget tracking platform");
  });

  it("drops unknown signals from the weighting instead of scoring them zero", () => {
    const known = scoreFit(lead(), icp()).score;
    // Same lead with headcount and location simply not published.
    const unknown = scoreFit(
      lead({ employeeEstimate: undefined, location: undefined }),
      icp(),
    ).score;
    // Removing two signals it scored *well* on must not raise the score, and
    // must not crater it the way scoring them 0 would.
    expect(unknown).toBeLessThanOrEqual(known);
    expect(unknown).toBeGreaterThan(known - 25);
  });

  it("keeps every score inside 0-100", () => {
    for (const l of [lead(), lead({ publicContacts: [], evidence: [], technologies: [] })]) {
      const s = scoreFit(l, icp()).score;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  it("maps scores to bands at the documented thresholds", () => {
    expect(bandFor(80)).toBe("strong");
    expect(bandFor(75)).toBe("strong");
    expect(bandFor(60)).toBe("good");
    expect(bandFor(40)).toBe("marginal");
    expect(bandFor(10)).toBe("poor");
  });

  it("finds no disqualifier when the ICP lists none", () => {
    expect(findDisqualifier(lead(), icp({ negativeSignals: [] }))).toBeNull();
  });
});
