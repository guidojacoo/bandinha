import { describe, expect, it } from "vitest";
import { resolveSyncPlan } from "../src/syncPlan.js";

/**
 * Dates are built with the local `new Date(y, m, d, h, min)` constructor
 * (not ISO/UTC strings) throughout this file. resolveSyncPlan compares
 * *local* calendar dates (matching OpenH59's LOCAL_TZ-anchored day math —
 * the device's clock is local, not UTC). Using the local constructor keeps
 * these tests deterministic under any CI/dev machine timezone, since both
 * the test input and the function's internal date-component extraction
 * share the same local reference frame.
 */

describe("resolveSyncPlan", () => {
  it("defaults to 7 days when there is no prior sync (first-ever sync)", () => {
    const plan = resolveSyncPlan({ lastSyncedAt: null, now: new Date(2026, 7, 14, 9, 0) });
    expect(plan.days).toBe(7);
  });

  it("requests 0 extra days for a same-day (daily) sync", () => {
    const now = new Date(2026, 7, 14, 20, 0);
    const lastSyncedAt = new Date(2026, 7, 14, 8, 0);
    expect(resolveSyncPlan({ lastSyncedAt, now }).days).toBe(0);
  });

  it("requests exactly the gap after being away a few days", () => {
    const now = new Date(2026, 7, 14, 9, 0);
    const lastSyncedAt = new Date(2026, 7, 11, 9, 0); // 3 calendar days ago
    expect(resolveSyncPlan({ lastSyncedAt, now }).days).toBe(3);
  });

  it("caps at 14 days when away far longer than the device's onboard buffer", () => {
    const now = new Date(2026, 7, 14, 9, 0);
    const lastSyncedAt = new Date(2026, 5, 1, 9, 0); // ~2.5 months ago
    const plan = resolveSyncPlan({ lastSyncedAt, now });
    expect(plan.days).toBe(14);
    expect(plan.reason).toContain("capped");
  });

  it("an explicit override always wins, even over a recent sync", () => {
    const now = new Date(2026, 7, 14, 9, 0);
    const lastSyncedAt = new Date(2026, 7, 14, 8, 0);
    expect(resolveSyncPlan({ lastSyncedAt, now, overrideDays: 5 }).days).toBe(5);
  });

  it("never returns a negative day count for a negative override", () => {
    expect(resolveSyncPlan({ lastSyncedAt: null, now: new Date(2026, 7, 14), overrideDays: -3 }).days).toBe(0);
  });

  it("counts a crossed local midnight as 1 day even when less than an hour apart", () => {
    const lastSyncedAt = new Date(2026, 7, 13, 23, 30);
    const now = new Date(2026, 7, 14, 0, 30); // 1 hour later, but a new local calendar day
    expect(resolveSyncPlan({ lastSyncedAt, now }).days).toBe(1);
  });
});
