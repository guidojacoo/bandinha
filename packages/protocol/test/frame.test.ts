import { describe, expect, it } from "vitest";
import { buildFrame, parseFrame } from "../src/frame.js";

describe("buildFrame", () => {
  it("builds a battery request byte-for-byte (hand-computed, cmd=3, no payload)", () => {
    const frame = buildFrame(3);
    // [3, 0*14, checksum=3]
    expect([...frame]).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
  });

  it("places payload right after the command byte and computes the checksum", () => {
    const frame = buildFrame(0x15, [1, 2, 3]);
    expect(frame[0]).toBe(0x15);
    expect(frame[1]).toBe(1);
    expect(frame[2]).toBe(2);
    expect(frame[3]).toBe(3);
    expect(frame[15]).toBe((0x15 + 1 + 2 + 3) & 0xff);
  });

  it("rejects a payload longer than 14 bytes", () => {
    expect(() => buildFrame(1, new Array(15).fill(0))).toThrow();
  });

  it("rejects an out-of-range command byte", () => {
    expect(() => buildFrame(256)).toThrow();
    expect(() => buildFrame(-1)).toThrow();
  });
});

describe("parseFrame", () => {
  it("round-trips buildFrame output with a valid checksum", () => {
    const built = buildFrame(0x50, [0x55, 0xaa]);
    const parsed = parseFrame(built);
    expect(parsed.cmd).toBe(0x50);
    expect(parsed.checksumValid).toBe(true);
    expect([...parsed.payload.subarray(0, 2)]).toEqual([0x55, 0xaa]);
  });

  it("flags a tampered checksum as invalid without throwing", () => {
    const built = buildFrame(3);
    built[15] = (built[15]! + 1) & 0xff;
    expect(parseFrame(built).checksumValid).toBe(false);
  });

  it("rejects frames that are not exactly 16 bytes", () => {
    expect(() => parseFrame(new Uint8Array(10))).toThrow();
  });
});
