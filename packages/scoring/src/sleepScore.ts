import { clamp, lerpClamp, weightedAverage } from "./weightedAverage";

/**
 * H59 Health's own Sleep Score (0-100). NOT a QWatch Pro value, NOT a
 * medical diagnostic — see docs/SLEEP_ALGORITHM.md for the full writeup and
 * the "no te lo tomes como diagnóstico" disclaimer that must ship alongside
 * every place this number is shown in the product.
 *
 * All thresholds below are our own product decision (based on commonly
 * cited sleep-science ranges — e.g. ~13-23% deep sleep, ~20-25% REM for
 * adults), not something the H59 or QWatch Pro told us. They are
 * deliberately isolated in named constants so they're easy to tune later
 * without touching the combination logic.
 */
export const SLEEP_SCORE_WEIGHTS = {
  duration: 30,
  continuity: 20,
  deepSleep: 15,
  remSleep: 15,
  regularity: 10,
  nocturnalHrv: 5,
  nocturnalHeartRate: 5,
} as const;

export interface SleepScoreInput {
  totalMinutes: number;
  awakeMinutes: number;
  awakenings: number;
  deepMinutes: number;
  remMinutes: number;
  lightMinutes: number;
  /** stdev (minutes) of sleep-onset time vs the last 7 nights, if known. */
  bedtimeVarianceMinutes?: number;
  /** average HRV (ms) during this sleep session, if the device reported it. */
  nocturnalHrvMs?: number;
  /** user's rolling nocturnal HRV baseline (ms), if enough history exists. */
  nocturnalHrvBaselineMs?: number;
  /** average resting HR (bpm) during this sleep session, if reported. */
  nocturnalRestingHr?: number;
  /** user's rolling nocturnal resting HR baseline (bpm), if known. */
  nocturnalRestingHrBaselineMs?: number;
}

export interface SleepScoreResult {
  score: number;
  breakdown: Record<string, { value: number; weight: number }>;
}

function durationScore(totalMinutes: number): number {
  // Piecewise: short nights are punished steeply (6h is a commonly-cited
  // "too little sleep" cutoff), the 7-9h band is the sweet spot, and
  // oversleeping tapers gently rather than cliff-dropping.
  if (totalMinutes < 360) return lerpClamp(totalMinutes, 0, 0, 360, 55);
  if (totalMinutes < 420) return lerpClamp(totalMinutes, 360, 55, 420, 85);
  if (totalMinutes <= 540) return 100; // 7h-9h sweet spot
  return lerpClamp(totalMinutes, 540, 100, 660, 50); // oversleeping tapers, floors at 11h
}

function continuityScore(totalMinutes: number, awakeMinutes: number, awakenings: number): number {
  if (totalMinutes <= 0) return 0;
  const efficiency = clamp((1 - awakeMinutes / totalMinutes) * 100, 0, 100);
  const penalty = Math.max(0, awakenings - 1) * 6; // first awakening is normal, don't punish it
  return clamp(efficiency - penalty, 0, 100);
}

/** Shared shape for "ideal band" metrics like deep/REM % of total sleep time. */
function bandScore(pct: number, low: number, high: number, falloffPerPoint: number): number {
  if (pct >= low && pct <= high) return 100;
  const distance = pct < low ? low - pct : pct - high;
  return clamp(100 - distance * falloffPerPoint, 0, 100);
}

/**
 * Exported so apps/web's recovery-score aggregation (which computes bedtime
 * variance across a week of sessions itself) can reuse the same curve
 * instead of re-deriving it.
 */
export function regularityScoreFromVarianceMinutes(bedtimeVarianceMinutes: number): number {
  return lerpClamp(bedtimeVarianceMinutes, 15, 100, 90, 20);
}

function regularityScore(bedtimeVarianceMinutes: number | undefined): number | undefined {
  if (bedtimeVarianceMinutes === undefined) return undefined;
  return regularityScoreFromVarianceMinutes(bedtimeVarianceMinutes);
}

/** Baseline-relative score: 50 = right at your own norm, higher/lower shifts from there. */
export function relativeToBaseline(value: number, baseline: number, sensitivity: number, invert: boolean): number {
  const ratio = value / baseline - 1;
  const delta = ratio * sensitivity * (invert ? -1 : 1);
  return clamp(50 + delta, 0, 100);
}

export function computeSleepScore(input: SleepScoreInput): SleepScoreResult {
  const totalNonAwake = input.deepMinutes + input.remMinutes + input.lightMinutes;
  const deepPct = totalNonAwake > 0 ? (input.deepMinutes / totalNonAwake) * 100 : 0;
  const remPct = totalNonAwake > 0 ? (input.remMinutes / totalNonAwake) * 100 : 0;

  const nocturnalHrv =
    input.nocturnalHrvMs !== undefined && input.nocturnalHrvBaselineMs
      ? relativeToBaseline(input.nocturnalHrvMs, input.nocturnalHrvBaselineMs, 100, false)
      : undefined;
  const nocturnalHeartRate =
    input.nocturnalRestingHr !== undefined && input.nocturnalRestingHrBaselineMs
      ? relativeToBaseline(input.nocturnalRestingHr, input.nocturnalRestingHrBaselineMs, 150, true)
      : undefined;

  const { score, contributions } = weightedAverage(
    {
      duration: durationScore(input.totalMinutes),
      continuity: continuityScore(input.totalMinutes, input.awakeMinutes, input.awakenings),
      deepSleep: bandScore(deepPct, 13, 23, 5),
      remSleep: bandScore(remPct, 20, 25, 5),
      regularity: regularityScore(input.bedtimeVarianceMinutes),
      nocturnalHrv,
      nocturnalHeartRate,
    },
    SLEEP_SCORE_WEIGHTS,
  );

  return { score, breakdown: contributions };
}
