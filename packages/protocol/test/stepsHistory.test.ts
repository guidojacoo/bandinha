import { describe, expect, it } from "vitest";
import { buildFrame, parseFrame } from "../src/frame.js";
import { parseStepsHistory } from "../src/parsers/stepsHistory.js";
import { CMD } from "../src/constants.js";

describe("parseStepsHistory", () => {
  it("decodes a BCD date, quarter-hour slot, calories/steps/distance", () => {
    // year=2026 (BCD 0x26=38), month=8 (BCD 0x08), day=13 (BCD 0x13=19),
    // quarterHourOfDay=40 -> 10:00, calories=250, steps=3200, distance=2400m
    const frame = parseFrame(
      buildFrame(CMD.STEPS, [38, 8, 19, 40, 0, 0, 250, 0, 128, 12, 96, 9, 0, 0]),
    );
    const points = parseStepsHistory([frame]);
    expect(points).toEqual([
      { year: 2026, month: 8, day: 13, quarterHourOfDay: 40, steps: 3200, calories: 250, distanceM: 2400 },
    ]);
  });

  it("skips 0xff (no data) and 0xf0 (initial packet) sentinel frames", () => {
    const noData = parseFrame(buildFrame(CMD.STEPS, [0xff]));
    const initial = parseFrame(buildFrame(CMD.STEPS, [0xf0]));
    expect(parseStepsHistory([noData, initial])).toEqual([]);
  });
});
