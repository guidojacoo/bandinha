import type { RegistryPackage } from "../registry/types";

export type SignalId =
  | "deprecated"
  | "staleness"
  | "cadence"
  | "busFactor"
  | "drift"
  | "license"
  | "immaturity"
  | "provenance";

/**
 * One scored dimension of rot.
 *
 * `value` is the rot contribution in [0,1] — 0 means healthy on this
 * dimension, 1 means as bad as this dimension gets. A signal that cannot be
 * evaluated (the registry does not expose the input) is reported with
 * `value: null`, and its weight is removed from the denominator rather than
 * being scored as either healthy or rotten.
 */
export interface Signal {
  id: SignalId;
  label: string;
  value: number | null;
  weight: number;
  /** Short human-readable explanation of how `value` was reached. */
  detail: string;
}

export type Grade = "A" | "B" | "C" | "D" | "F";

export type Verdict = "Healthy" | "Watch" | "Aging" | "At risk" | "Critical";

export interface RotResult {
  /** 0-100. Higher = more rot. */
  score: number;
  grade: Grade;
  verdict: Verdict;
  signals: Signal[];
  /** Ordered worst-first, ready to render. */
  reasons: string[];
}

export interface RotInput {
  pkg: RegistryPackage;
  /** Range as written in the manifest, e.g. "^4.17.21". */
  requestedRange?: string;
  /** Concrete version in use, when the manifest pins one. */
  resolvedVersion?: string;
  /** Evaluation time. Injected so scoring is deterministic under test. */
  now: Date;
}

export interface PortfolioResult {
  /** 0-100. Higher = more rot. */
  score: number;
  grade: Grade;
  verdict: Verdict;
  counts: Record<Grade, number>;
  /** Packages that scored but were excluded from the score by the user. */
  acknowledgedCount: number;
  /** Packages whose registry lookup failed. */
  unresolvedCount: number;
  scoredCount: number;
}
