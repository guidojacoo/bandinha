/**
 * Combines named 0-100 component scores using fixed target weights, but
 * redistributes the weight of any *missing* component proportionally across
 * the ones that ARE present. This matters a lot in practice: a brand-new
 * user has no HRV/HR baseline yet (needs a rolling history), and we don't
 * want their first week of scores to be artificially crushed by a missing
 * input defaulting to 0 — see docs/SLEEP_ALGORITHM.md.
 */
export function weightedAverage(
  components: Record<string, number | undefined>,
  weights: Record<string, number>,
): { score: number; contributions: Record<string, { value: number; weight: number }> } {
  const present = Object.entries(components).filter(
    (entry): entry is [string, number] => entry[1] !== undefined,
  );
  const totalWeight = present.reduce((sum, [key]) => sum + (weights[key] ?? 0), 0);
  if (totalWeight === 0 || present.length === 0) {
    return { score: 0, contributions: {} };
  }

  const contributions: Record<string, { value: number; weight: number }> = {};
  let score = 0;
  for (const [key, value] of present) {
    const normalizedWeight = (weights[key] ?? 0) / totalWeight;
    contributions[key] = { value, weight: Math.round(normalizedWeight * 100) };
    score += value * normalizedWeight;
  }
  return { score: Math.round(clamp(score, 0, 100)), contributions };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Linear interpolation, clamped at the endpoints. */
export function lerpClamp(x: number, x0: number, y0: number, x1: number, y1: number): number {
  if (x1 === x0) return y0;
  const t = clamp((x - x0) / (x1 - x0), 0, 1);
  return y0 + t * (y1 - y0);
}
