import { describe, expect, it } from "vitest";
import { localMidnightAsDeviceSeconds } from "../src/deviceClock.js";

/**
 * These assertions are written to hold under ANY system timezone the test
 * runs in: we build "local midnight N days ago" with the local Date
 * constructor, then check that reinterpreting the function's output as a
 * *UTC* epoch reproduces the same wall-clock Y/M/D/H/M/S — which is exactly
 * the device's own (mis)interpretation this function has to match.
 */
describe("localMidnightAsDeviceSeconds", () => {
  it("reinterpreted as UTC, reproduces today's local midnight wall-clock date", () => {
    const now = new Date(2026, 7, 14, 15, 30); // 2026-08-14 15:30 local
    const seconds = localMidnightAsDeviceSeconds(0, now);
    const reinterpreted = new Date(seconds * 1000);
    expect(reinterpreted.getUTCFullYear()).toBe(2026);
    expect(reinterpreted.getUTCMonth()).toBe(7);
    expect(reinterpreted.getUTCDate()).toBe(14);
    expect(reinterpreted.getUTCHours()).toBe(0);
    expect(reinterpreted.getUTCMinutes()).toBe(0);
  });

  it("daysAgo shifts the wall-clock date back by that many local calendar days", () => {
    const now = new Date(2026, 7, 14, 15, 30);
    const seconds = localMidnightAsDeviceSeconds(3, now);
    const reinterpreted = new Date(seconds * 1000);
    expect(reinterpreted.getUTCFullYear()).toBe(2026);
    expect(reinterpreted.getUTCMonth()).toBe(7);
    expect(reinterpreted.getUTCDate()).toBe(11);
  });

  it("handles a daysAgo shift across a month boundary", () => {
    const now = new Date(2026, 8, 2, 10, 0); // 2026-09-02
    const seconds = localMidnightAsDeviceSeconds(3, now);
    const reinterpreted = new Date(seconds * 1000);
    expect(reinterpreted.getUTCMonth()).toBe(7); // August
    expect(reinterpreted.getUTCDate()).toBe(30);
  });
});
