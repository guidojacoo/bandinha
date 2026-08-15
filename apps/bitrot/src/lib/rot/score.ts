import {
  busFactorSignal,
  cadenceSignal,
  deprecationSignal,
  driftSignal,
  immaturitySignal,
  licenseSignal,
  provenanceSignal,
  stalenessSignal,
} from "./signals";
import type { Grade, PortfolioResult, RotInput, RotResult, Signal, Verdict } from "./types";

/**
 * A maintainer saying "this is dead" is ground truth, not evidence. When the
 * deprecation signal fires, the score is floored here so a deprecated package
 * can never present as merely "aging" on the strength of a recent release.
 */
export const DEPRECATION_FLOOR = 80;

const GRADE_BANDS: ReadonlyArray<{ max: number; grade: Grade; verdict: Verdict }> = [
  { max: 20, grade: "A", verdict: "Healthy" },
  { max: 40, grade: "B", verdict: "Watch" },
  { max: 60, grade: "C", verdict: "Aging" },
  { max: 80, grade: "D", verdict: "At risk" },
  { max: Infinity, grade: "F", verdict: "Critical" },
];

export function gradeFor(score: number): { grade: Grade; verdict: Verdict } {
  const band = GRADE_BANDS.find((b) => score < b.max) ?? GRADE_BANDS[GRADE_BANDS.length - 1]!;
  return { grade: band.grade, verdict: band.verdict };
}

/** Scores a single package against the live registry metadata gathered for it. */
export function scoreOne(input: RotInput): RotResult {
  const { pkg, now } = input;
  const inUse = input.resolvedVersion ?? input.requestedRange;

  const signals: Signal[] = [
    deprecationSignal(pkg),
    stalenessSignal(pkg, now),
    cadenceSignal(pkg, now),
    busFactorSignal(pkg),
    driftSignal(pkg.latestVersion, inUse),
    licenseSignal(pkg),
    immaturitySignal(pkg, now),
    provenanceSignal(pkg),
  ];

  // Weight-0 signals (deprecation) are overrides applied below, not terms in
  // the weighted average — including them would dilute every other signal.
  const applicable = signals.filter(
    (s): s is Signal & { value: number } => s.value !== null && s.weight > 0,
  );
  const totalWeight = applicable.reduce((sum, s) => sum + s.weight, 0);

  let score = 0;
  if (totalWeight > 0) {
    const weighted = applicable.reduce((sum, s) => sum + s.value * s.weight, 0);
    score = Math.round((weighted / totalWeight) * 100);
  }

  const deprecated = signals.find((s) => s.id === "deprecated")?.value === 1;
  if (deprecated) score = Math.max(score, DEPRECATION_FLOOR);
  score = Math.min(100, Math.max(0, score));

  const { grade, verdict } = gradeFor(score);
  return { score, grade, verdict, signals, reasons: reasonsFrom(signals) };
}

/**
 * Turns the scored signals into an ordered, human-readable list. Only signals
 * that actually contributed rot are included, worst contribution first, so the
 * UI can render "why" without re-deriving the weighting.
 */
export function reasonsFrom(signals: Signal[]): string[] {
  return signals
    .filter((s): s is Signal & { value: number } => s.value !== null && s.value > 0)
    .sort((a, b) => {
      // Deprecation carries no weight (it is an override), so it would sort
      // last on contribution alone — yet it is always the headline reason.
      if (a.id === "deprecated") return -1;
      if (b.id === "deprecated") return 1;
      return b.value * b.weight - a.value * a.weight;
    })
    .map((s) => s.detail);
}

/**
 * Exponent of the power mean used for the portfolio score.
 *
 * 1 would be the plain arithmetic mean; higher values pull the result toward
 * the worst packages. 4 was chosen so that a handful of critical dependencies
 * in a large healthy tree lands in "Aging"/"At risk" rather than disappearing,
 * while a single bad dev dependency among 200 does not scream "Critical".
 */
export const PORTFOLIO_EXPONENT = 4;

/**
 * Power mean: (Σ xᵢᵖ / n)^(1/p).
 *
 * Chosen over a percentile blend because a percentile has a blind spot exactly
 * where it matters: with 40 healthy dependencies and 4 rotten ones, the rotten
 * ones sit above p90, so p90 reads a healthy package and the score barely
 * moves. A power mean always sees every package.
 */
export function powerMean(values: number[], exponent: number): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + Math.max(0, v) ** exponent, 0);
  return (sum / values.length) ** (1 / exponent);
}

export interface PortfolioInput {
  /** Scores of packages that count toward the total. */
  scores: number[];
  acknowledgedCount?: number;
  unresolvedCount?: number;
}

/**
 * Rolls per-package scores into one number.
 *
 * A plain mean lets 200 healthy dependencies bury three abandoned ones, which
 * is exactly the failure mode this product exists to fix. The power mean keeps
 * the worst offenders visible in the headline number while still rewarding a
 * broadly healthy tree.
 */
export function scorePortfolio(input: PortfolioInput): PortfolioResult {
  const scores = input.scores;
  const counts: Record<Grade, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const s of scores) counts[gradeFor(s).grade] += 1;

  const score = Math.min(100, Math.max(0, Math.round(powerMean(scores, PORTFOLIO_EXPONENT))));

  const { grade, verdict } = gradeFor(score);
  return {
    score,
    grade,
    verdict,
    counts,
    acknowledgedCount: input.acknowledgedCount ?? 0,
    unresolvedCount: input.unresolvedCount ?? 0,
    scoredCount: scores.length,
  };
}
