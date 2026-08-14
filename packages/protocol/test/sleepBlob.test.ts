import { describe, expect, it } from "vitest";
import { parseSleepBlob } from "../src/parsers/sleepBlob.js";

describe("parseSleepBlob", () => {
  /**
   * Synthetic body reconstructed to match the format documented in
   * docs/BLE_PROTOCOL.md AND reproduce the aggregate totals from OpenH59's
   * byte-per-byte-verified real example (night of 2026-06-14): light 352min,
   * deep 90min, REM 63min, awake 2min, start 00:41 — this is NOT a raw
   * capture (individual segment boundaries within "light" were not published),
   * it is hand-built to validate the parser against the documented spec and
   * that verified aggregate outcome.
   */
  it("parses one night matching OpenH59's verified aggregate example", () => {
    // n=1, idx=0, reserved=0, start=41 (0x29,0x00), end=548 (0x24,0x02),
    // then (stage,minutes) pairs summing to 507 = (548-41).
    const body = Uint8Array.from([
      1, 0, 0, 0x29, 0x00, 0x24, 0x02,
      2, 90, 2, 90, 2, 90, 2, 82, // light x4 = 352
      3, 90, // deep
      4, 63, // rem
      5, 2, // awake
    ]);

    const nights = parseSleepBlob(body);
    expect(nights).toHaveLength(1);
    const night = nights[0]!;
    expect(night.daysAgo).toBe(0);
    expect(night.startMinuteOfDay).toBe(41);
    expect(night.endMinuteOfDay).toBe(548);
    expect(night.totalMinutes).toBe(507);

    const totals = { light: 0, deep: 0, rem: 0, awake: 0 } as Record<string, number>;
    for (const seg of night.segments) totals[seg.stage] += seg.minutes;
    expect(totals).toEqual({ light: 352, deep: 90, rem: 63, awake: 2 });
  });

  it("returns [] for a too-short body", () => {
    expect(parseSleepBlob(Uint8Array.from([0, 0, 0]))).toEqual([]);
  });

  it("stops at an unrecognized stage code instead of reading garbage", () => {
    const body = Uint8Array.from([1, 0, 0, 10, 0, 20, 0, 9 /* invalid stage */, 5]);
    expect(parseSleepBlob(body)).toEqual([]);
  });
});
