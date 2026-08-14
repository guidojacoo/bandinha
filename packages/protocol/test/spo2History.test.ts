import { describe, expect, it } from "vitest";
import { parseSpo2History } from "../src/parsers/spo2History.js";

describe("parseSpo2History", () => {
  it("parses hourly pairs, matching OpenH59's verified example for hours 07-16", () => {
    // Verified against the official app in docs/APPUNTI-TECNICI.md:
    // hours 07->16 = 99,97,97,97,96,99,99,98,99,98
    const verifiedHourly = [99, 97, 97, 97, 96, 99, 99, 98, 99, 98];
    const pairs: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      if (hour >= 7 && hour <= 16) {
        const v = verifiedHourly[hour - 7]!;
        pairs.push(v, v); // min synthesized == max; only the max was part of the verified example
      } else {
        pairs.push(0, 0);
      }
    }
    const body = Uint8Array.from([0, ...pairs]); // body[0] = day

    const points = parseSpo2History(body);
    expect(points).toHaveLength(10);
    expect(points.map((p) => p.hour)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(points.map((p) => p.max)).toEqual(verifiedHourly);
  });

  it("returns [] for a too-short body", () => {
    expect(parseSpo2History(Uint8Array.from([0, 1]))).toEqual([]);
  });
});
