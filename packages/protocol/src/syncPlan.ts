/**
 * Incremental sync planning — how many days of on-device history to pull.
 * Mirrors OpenH59's `collect.py resolve_days` exactly (same precedence,
 * same defaults, same cap), reimplemented so the mobile app can run the
 * identical decision without shelling out to Python. See docs/BLE_PROTOCOL.md
 * and docs/API.md "Sync" for how this fits into the sync endpoint.
 *
 * Precedence: explicit override > last-synced-day math > empty-cache default.
 */

const DEFAULT_DAYS = 7; // fallback when we have no prior sync at all
const MAX_DAYS = 14; // beyond the device's ~7-day buffer, insisting further is wasted time

export interface SyncPlanInput {
  /** Most recent successfully-synced sample timestamp we have locally, if any. */
  lastSyncedAt: Date | null;
  now: Date;
  /** Explicit override, e.g. a user-triggered "resync last N days". */
  overrideDays?: number;
}

export interface SyncPlan {
  /** Number of additional days *before* today to also request (0 = today only). */
  days: number;
  reason: string;
}

function daysBetweenCalendarDates(a: Date, b: Date): number {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / 86_400_000);
}

export function resolveSyncPlan({ lastSyncedAt, now, overrideDays }: SyncPlanInput): SyncPlan {
  if (overrideDays !== undefined) {
    const days = Math.max(0, overrideDays);
    return { days, reason: `override: ${days} day(s)` };
  }

  if (lastSyncedAt === null) {
    return { days: DEFAULT_DAYS, reason: `no prior sync — defaulting to ${DEFAULT_DAYS} days` };
  }

  const span = daysBetweenCalendarDates(lastSyncedAt, now);
  const days = Math.max(0, Math.min(span, MAX_DAYS));
  const capped = span > MAX_DAYS ? ` (capped at ${MAX_DAYS}, beyond the device's onboard buffer)` : "";
  return {
    days,
    reason: `last sync ${lastSyncedAt.toISOString()} -> ${days} day(s)${capped}`,
  };
}
