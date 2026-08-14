import { describe, expect, it } from "vitest";
import { compareToWeeklyAverage, computeRecoveryScore } from "../src/recoveryScore.js";

describe("computeRecoveryScore", () => {
  it("scores well when sleep was good, HRV is above baseline, HR is below baseline, low stress", () => {
    const result = computeRecoveryScore({
      sleepScore: 90,
      hrvMs: 55,
      hrvBaselineMs: 45, // well above baseline -> good
      restingHr: 52,
      restingHrBaselineMs: 58, // below baseline -> good
      regularityScore: 90,
      averageStress: 15,
      acuteActivityLoadRatio: 1.0,
    });
    expect(result.score).toBeGreaterThanOrEqual(80);
  });

  it("scores poorly with bad sleep, depressed HRV, elevated HR and high stress", () => {
    const result = computeRecoveryScore({
      sleepScore: 30,
      hrvMs: 25,
      hrvBaselineMs: 45,
      restingHr: 68,
      restingHrBaselineMs: 58,
      regularityScore: 20,
      averageStress: 80,
      acuteActivityLoadRatio: 1.0,
    });
    expect(result.score).toBeLessThan(40);
  });

  it("works with only sleepScore present (new user, no baselines yet)", () => {
    const result = computeRecoveryScore({ sleepScore: 70 });
    expect(result.score).toBe(70); // sleepQuality is the only component -> its weight is 100%
  });

  it("flags extreme over- or under-activity as mildly worse than a normal load", () => {
    const normal = computeRecoveryScore({ sleepScore: 80, acuteActivityLoadRatio: 1.0 });
    const overload = computeRecoveryScore({ sleepScore: 80, acuteActivityLoadRatio: 3.0 });
    expect(overload.score).toBeLessThan(normal.score);
  });
});

describe("compareToWeeklyAverage", () => {
  it("computes a positive percentage when above the weekly average", () => {
    expect(compareToWeeklyAverage(84, 75)).toBe(12);
  });

  it("computes a negative percentage when below the weekly average", () => {
    expect(compareToWeeklyAverage(60, 75)).toBe(-20);
  });

  it("returns undefined when there is no weekly average yet", () => {
    expect(compareToWeeklyAverage(84, 0)).toBeUndefined();
  });
});
