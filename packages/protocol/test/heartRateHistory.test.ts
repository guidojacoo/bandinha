import { describe, expect, it } from "vitest";
import { buildFrame, parseFrame } from "../src/frame.js";
import { parseHeartRateHistory } from "../src/parsers/heartRateHistory.js";
import { CMD } from "../src/constants.js";

describe("parseHeartRateHistory", () => {
  it("reassembles header + first data packet into sparse 5-minute points", () => {
    const header = parseFrame(buildFrame(CMD.HR_HISTORY, [0, 1])); // sub=0, packet count=1
    const data = parseFrame(
      buildFrame(CMD.HR_HISTORY, [
        1, // sub=1 (first data packet)
        0, 0, 0, 0, // bytes 2-5: sync timestamp, ignored by this parser
        60, 62, 0, 65, 0, 0, 70, 0, 72, // bytes 6-14: 9 values, 5-min apart
      ]),
    );
    const points = parseHeartRateHistory([header, data]);
    expect(points).toEqual([
      { minuteOfDay: 0, bpm: 60 },
      { minuteOfDay: 5, bpm: 62 },
      { minuteOfDay: 15, bpm: 65 },
      { minuteOfDay: 30, bpm: 70 },
      { minuteOfDay: 40, bpm: 72 },
    ]);
  });

  it("returns [] when the device reports no data (sub=0xff)", () => {
    const empty = parseFrame(buildFrame(CMD.HR_HISTORY, [0xff]));
    expect(parseHeartRateHistory([empty])).toEqual([]);
  });
});
