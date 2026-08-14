import type { HealthMetric } from "@h59/db";

const KEBAB_TO_METRIC: Record<string, HealthMetric> = {
  "heart-rate": "heart_rate",
  spo2: "spo2",
  "blood-pressure": "blood_pressure",
  stress: "stress",
  hrv: "hrv",
  steps: "steps",
  distance: "distance",
  calories: "calories",
  battery: "battery",
};

export function parseMetricParam(param: string): HealthMetric | null {
  return KEBAB_TO_METRIC[param] ?? null;
}

export interface RangeParams {
  from?: Date;
  to?: Date;
  limit: number;
}

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 20000;

export function parseRangeParams(url: URL): RangeParams {
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? Math.min(Math.max(1, Number(limitStr) || DEFAULT_LIMIT), MAX_LIMIT) : DEFAULT_LIMIT;
  return {
    from: fromStr ? new Date(fromStr) : undefined,
    to: toStr ? new Date(toStr) : undefined,
    limit,
  };
}
