import { clamp, weightedAverage } from "./weightedAverage";
import { relativeToBaseline } from "./sleepScore";
import type { RecoveryScoreDTO } from "@h59/shared";

/**
 * H59 Health's own Recovery Score (0-100) — see docs/SLEEP_ALGORITHM.md.
 * Not a medical readiness/strain diagnostic; framed in the product as a
 * relative, personal signal ("X% above your weekly average"), the same way
 * the product brief asked for it.
 */
export const RECOVERY_SCORE_WEIGHTS = {
  sleepQuality: 30,
  hrv: 25,
  restingHeartRate: 15,
  regularity: 10,
  stress: 10,
  activity: 10,
} as const;

export interface RecoveryScoreInput {
  /** Today's Sleep Score (0-100), from computeSleepScore. */
  sleepScore: number;
  /** Morning/rolling HRV (ms), if available. */
  hrvMs?: number;
  hrvBaselineMs?: number;
  restingHr?: number;
  restingHrBaselineMs?: number;
  /** Same regularity input used by computeSleepScore, 0-100 if known. */
  regularityScore?: number;
  /** Average stress (device's own 0-100 scale) over the last 24h, if available. */
  averageStress?: number;
  /** Yesterday's activity (steps or calories) divided by the 7-day rolling average. 1.0 = normal. */
  acuteActivityLoadRatio?: number;
}

function stressScore(averageStress: number | undefined): number | undefined {
  if (averageStress === undefined) return undefined;
  return clamp(100 - averageStress, 0, 100);
}

function activityScore(ratio: number | undefined): number | undefined {
  if (ratio === undefined) return undefined;
  return clamp(100 - Math.abs(ratio - 1) * 40, 40, 100);
}

export function computeRecoveryScore(
  input: RecoveryScoreInput,
): Pick<RecoveryScoreDTO, "score" | "breakdown"> {
  const hrv =
    input.hrvMs !== undefined && input.hrvBaselineMs
      ? relativeToBaseline(input.hrvMs, input.hrvBaselineMs, 100, false)
      : undefined;
  const restingHeartRate =
    input.restingHr !== undefined && input.restingHrBaselineMs
      ? relativeToBaseline(input.restingHr, input.restingHrBaselineMs, 150, true)
      : undefined;

  const { score, contributions } = weightedAverage(
    {
      sleepQuality: input.sleepScore,
      hrv,
      restingHeartRate,
      regularity: input.regularityScore,
      stress: stressScore(input.averageStress),
      activity: activityScore(input.acuteActivityLoadRatio),
    },
    RECOVERY_SCORE_WEIGHTS,
  );

  return {
    score,
    breakdown: {
      sleepQuality: contributions.sleepQuality?.value ?? 0,
      hrv: contributions.hrv?.value ?? 0,
      restingHeartRate: contributions.restingHeartRate?.value ?? 0,
      regularity: contributions.regularity?.value ?? 0,
      stress: contributions.stress?.value ?? 0,
      activity: contributions.activity?.value ?? 0,
    },
  };
}

/**
 * "Tu recovery está 12% por encima de tu promedio semanal" — percentage
 * difference of today's score vs the trailing 7-day average. Kept as a
 * separate pure function so callers only need it once they have the
 * historical average on hand (see apps/web recovery API route).
 */
export function compareToWeeklyAverage(todayScore: number, weeklyAvgScore: number): number | undefined {
  if (!weeklyAvgScore) return undefined;
  return Math.round(((todayScore - weeklyAvgScore) / weeklyAvgScore) * 100);
}
