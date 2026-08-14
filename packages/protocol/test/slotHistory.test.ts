import { describe, expect, it } from "vitest";
import { buildFrame, parseFrame } from "../src/frame.js";
import { parseSlotHistory } from "../src/parsers/slotHistory.js";
import { CMD } from "../src/constants.js";

describe("parseSlotHistory (shared by stress + HRV)", () => {
  it("reads the interval from the header and slots from data frames", () => {
    const header = parseFrame(buildFrame(CMD.STRESS_HISTORY, [0, 5, 30])); // interval=30min
    const data = parseFrame(
      buildFrame(CMD.STRESS_HISTORY, [1, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // slot 3 = value 20
    );
    const result = parseSlotHistory([header, data]);
    expect(result.intervalMin).toBe(30);
    expect(result.points).toEqual([{ minuteOfDay: 90, value: 20 }]);
  });

  it("defaults interval to 30 when the header omits it", () => {
    const header = parseFrame(buildFrame(CMD.HRV_HISTORY, [0, 1, 0]));
    expect(parseSlotHistory([header]).intervalMin).toBe(30);
  });

  it("returns no points for sub=0xff (no data that day)", () => {
    const empty = parseFrame(buildFrame(CMD.HRV_HISTORY, [0xff]));
    expect(parseSlotHistory([empty]).points).toEqual([]);
  });
});
