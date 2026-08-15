import { describe, expect, it } from "vitest";
import {
  DEPRECATION_FLOOR,
  gradeFor,
  powerMean,
  scoreOne,
  scorePortfolio,
} from "../src/lib/rot/score";
import { NOW, daysAgo, pkg } from "./fixtures";

describe("scoreOne", () => {
  it("gives a maintained, multi-maintainer, licensed package a healthy score", () => {
    const result = scoreOne({ pkg: pkg(), resolvedVersion: "3.2.1", now: NOW });
    expect(result.score).toBeLessThan(20);
    expect(result.grade).toBe("A");
    expect(result.verdict).toBe("Healthy");
  });

  it("floors a deprecated package at Critical regardless of other signals", () => {
    // Everything else about this package looks excellent.
    const result = scoreOne({
      pkg: pkg({ deprecated: true, deprecationNote: "use bar" }),
      resolvedVersion: "3.2.1",
      now: NOW,
    });
    expect(result.score).toBeGreaterThanOrEqual(DEPRECATION_FLOOR);
    expect(result.grade).toBe("F");
    expect(result.reasons[0]).toContain("use bar");
  });

  /**
   * The calibration bug this pins down: deprecation used to be a weighted term,
   * so the ~40% of weight reserved for a flag almost nobody sets capped a
   * decade-dead package in the 40s ("Aging"). It is an override now.
   */
  it("rates a long-abandoned package that was never formally deprecated as At risk", () => {
    const abandoned = pkg({
      ecosystem: "pypi",
      maintainerCount: undefined, // PyPI does not publish this
      repositoryUrl: undefined,
      releaseDates: [daysAgo(4400), daysAgo(4200), daysAgo(4100)],
      firstPublishAt: daysAgo(4400),
      lastPublishAt: daysAgo(4100),
      releaseCount: 3,
      deprecated: false,
    });
    const result = scoreOne({ pkg: abandoned, now: NOW });
    expect(result.score).toBeGreaterThan(60);
    expect(["D", "F"]).toContain(result.grade);
  });

  it("excludes unscorable signals from the weighting instead of scoring them zero", () => {
    // Same package twice; the second hides the fields PyPI never exposes.
    const base = pkg({ releaseDates: [daysAgo(1500), daysAgo(1400)], lastPublishAt: daysAgo(1400) });
    const npmScore = scoreOne({ pkg: base, now: NOW }).score;
    const pypiScore = scoreOne({
      pkg: { ...base, ecosystem: "pypi", maintainerCount: undefined },
      now: NOW,
    }).score;

    // Dropping the bus-factor signal must not make a stale package look better
    // than one where that signal was merely healthy.
    expect(pypiScore).toBeGreaterThanOrEqual(npmScore);
  });

  it("does not let a single stale signal alone reach Critical", () => {
    const result = scoreOne({ pkg: pkg({ license: undefined }), resolvedVersion: "3.2.1", now: NOW });
    expect(result.score).toBeLessThan(80);
  });

  it("ranks a single-maintainer stale package above a well-staffed stale one", () => {
    const dates = [daysAgo(1600), daysAgo(1500)];
    const solo = scoreOne({
      pkg: pkg({ maintainerCount: 1, releaseDates: dates, lastPublishAt: daysAgo(1500) }),
      now: NOW,
    });
    const team = scoreOne({
      pkg: pkg({ maintainerCount: 8, releaseDates: dates, lastPublishAt: daysAgo(1500) }),
      now: NOW,
    });
    expect(solo.score).toBeGreaterThan(team.score);
  });

  it("keeps every score inside 0-100", () => {
    const worst = scoreOne({
      pkg: pkg({
        deprecated: true,
        license: undefined,
        repositoryUrl: undefined,
        maintainerCount: 1,
        releaseDates: [daysAgo(5000)],
        lastPublishAt: daysAgo(5000),
        firstPublishAt: daysAgo(5000),
      }),
      resolvedVersion: "1.0.0",
      now: NOW,
    });
    expect(worst.score).toBeLessThanOrEqual(100);
    expect(worst.score).toBeGreaterThanOrEqual(0);
  });

  it("lists reasons worst-first and omits healthy signals", () => {
    const result = scoreOne({
      pkg: pkg({ maintainerCount: 1, license: undefined }),
      resolvedVersion: "3.2.1",
      now: NOW,
    });
    expect(result.reasons.length).toBeGreaterThan(0);
    // Bus factor (weight 12) must outrank license clarity (weight 8).
    expect(result.reasons[0]).toMatch(/single account/i);
    expect(result.reasons.join(" ")).not.toMatch(/Declared license/);
  });
});

describe("gradeFor", () => {
  it("maps each band to its grade and verdict", () => {
    expect(gradeFor(0).grade).toBe("A");
    expect(gradeFor(19).grade).toBe("A");
    expect(gradeFor(20).grade).toBe("B");
    expect(gradeFor(59).grade).toBe("C");
    expect(gradeFor(60).grade).toBe("D");
    expect(gradeFor(80).grade).toBe("F");
    expect(gradeFor(100).verdict).toBe("Critical");
  });
});

describe("powerMean", () => {
  it("equals the value when every input is identical", () => {
    expect(powerMean([7, 7, 7], 4)).toBeCloseTo(7, 6);
  });

  it("sits above the arithmetic mean whenever inputs differ", () => {
    const values = [0, 10, 90];
    const arithmetic = values.reduce((a, b) => a + b, 0) / values.length;
    expect(powerMean(values, 4)).toBeGreaterThan(arithmetic);
  });

  it("handles single and empty inputs", () => {
    expect(powerMean([42], 4)).toBeCloseTo(42, 6);
    expect(powerMean([], 4)).toBe(0);
  });
});

describe("scorePortfolio", () => {
  /**
   * The regression that killed the earlier percentile blend: four rotten
   * packages among forty healthy ones sit *above* p90, so a p90-based score
   * read a healthy package and moved by 3 points.
   */
  it("does not let a crowd of healthy packages bury a few rotten ones", () => {
    const healthy = Array.from({ length: 40 }, () => 5);
    const clean = scorePortfolio({ scores: healthy });
    const withRot = scorePortfolio({ scores: [...healthy, 95, 92, 88, 85] });

    expect(clean.score).toBeLessThan(15);
    expect(withRot.score - clean.score).toBeGreaterThan(20);
    expect(["C", "D", "F"]).toContain(withRot.grade);
  });

  it("still keeps one bad dependency among many from reading as Critical", () => {
    const healthy = Array.from({ length: 200 }, () => 5);
    const result = scorePortfolio({ scores: [...healthy, 80] });
    expect(result.score).toBeGreaterThan(10);
    expect(result.score).toBeLessThan(40);
  });

  it("rises monotonically as packages rot", () => {
    const base = Array.from({ length: 20 }, () => 10);
    const scores = [0, 1, 2, 4, 8].map(
      (n) => scorePortfolio({ scores: [...base, ...Array.from({ length: n }, () => 90)] }).score,
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeGreaterThanOrEqual(scores[i - 1]!);
    }
  });

  it("counts each grade band", () => {
    const result = scorePortfolio({ scores: [5, 25, 45, 65, 85] });
    expect(result.counts).toEqual({ A: 1, B: 1, C: 1, D: 1, F: 1 });
    expect(result.scoredCount).toBe(5);
  });

  it("reports an empty portfolio without inventing a score", () => {
    const result = scorePortfolio({ scores: [] });
    expect(result.score).toBe(0);
    expect(result.scoredCount).toBe(0);
  });

  it("carries acknowledged and unresolved counts through", () => {
    const result = scorePortfolio({ scores: [10], acknowledgedCount: 3, unresolvedCount: 2 });
    expect(result.acknowledgedCount).toBe(3);
    expect(result.unresolvedCount).toBe(2);
  });

  it("stays within 0-100 for an all-critical portfolio", () => {
    const result = scorePortfolio({ scores: [100, 100, 100] });
    expect(result.score).toBe(100);
    expect(result.grade).toBe("F");
  });
});
