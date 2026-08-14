import { describe, expect, it } from "vitest";
import { computeSleepScore } from "../src/sleepScore.js";

describe("computeSleepScore", () => {
  it("scores a textbook-good night (8h, minimal awakenings, deep/REM in range) near 100", () => {
    const result = computeSleepScore({
      totalMinutes: 480, // 8h, dead center of the 7-9h sweet spot
      awakeMinutes: 5,
      awakenings: 1,
      deepMinutes: 480 * 0.18, // 18%, inside 13-23%
      remMinutes: 480 * 0.22, // 22%, inside 20-25%
      lightMinutes: 480 * 0.6,
      bedtimeVarianceMinutes: 5,
    });
    expect(result.score).toBeGreaterThanOrEqual(90);
  });

  it("scores a short, fragmented night (4.5h, 6 awakenings) low", () => {
    const result = computeSleepScore({
      totalMinutes: 270,
      awakeMinutes: 60,
      awakenings: 6,
      deepMinutes: 270 * 0.05,
      remMinutes: 270 * 0.1,
      lightMinutes: 270 * 0.85,
    });
    expect(result.score).toBeLessThan(50);
  });

  it("a fragmented-but-long night scores between the two extremes", () => {
    const good = computeSleepScore({
      totalMinutes: 480,
      awakeMinutes: 5,
      awakenings: 1,
      deepMinutes: 480 * 0.18,
      remMinutes: 480 * 0.22,
      lightMinutes: 480 * 0.6,
    });
    const fragmented = computeSleepScore({
      totalMinutes: 480,
      awakeMinutes: 90,
      awakenings: 8,
      deepMinutes: 480 * 0.18,
      remMinutes: 480 * 0.22,
      lightMinutes: 480 * 0.6,
    });
    expect(fragmented.score).toBeLessThan(good.score);
  });

  it("does not crash and stays in [0,100] with only the required fields (no baselines/regularity)", () => {
    const result = computeSleepScore({
      totalMinutes: 400,
      awakeMinutes: 20,
      awakenings: 3,
      deepMinutes: 40,
      remMinutes: 60,
      lightMinutes: 280,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    // optional components should simply be absent, not zeroed out and dragging the score down
    expect(result.breakdown.nocturnalHrv).toBeUndefined();
    expect(result.breakdown.regularity).toBeUndefined();
  });

  it("redistributes weight so a missing HRV baseline does not silently zero out the score", () => {
    const withoutHrv = computeSleepScore({
      totalMinutes: 480,
      awakeMinutes: 5,
      awakenings: 1,
      deepMinutes: 480 * 0.18,
      remMinutes: 480 * 0.22,
      lightMinutes: 480 * 0.6,
    });
    const withNeutralHrv = computeSleepScore({
      totalMinutes: 480,
      awakeMinutes: 5,
      awakenings: 1,
      deepMinutes: 480 * 0.18,
      remMinutes: 480 * 0.22,
      lightMinutes: 480 * 0.6,
      nocturnalHrvMs: 40,
      nocturnalHrvBaselineMs: 40, // exactly at baseline -> neutral 50
    });
    // both should be high-scoring nights; the neutral HRV component shouldn't tank it
    expect(Math.abs(withoutHrv.score - withNeutralHrv.score)).toBeLessThan(15);
  });
});
