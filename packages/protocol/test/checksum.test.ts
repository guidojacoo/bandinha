import { describe, expect, it } from "vitest";
import { sumChecksum, crc16Modbus } from "../src/checksum.js";

describe("sumChecksum", () => {
  it("sums bytes mod 256", () => {
    expect(sumChecksum(Uint8Array.from([1, 2, 3]))).toBe(6);
    expect(sumChecksum(Uint8Array.from([0xff, 0xff, 0xff]))).toBe((0xff * 3) & 0xff);
  });
});

describe("crc16Modbus", () => {
  it("matches the standard CRC-16/MODBUS check value for ASCII '123456789'", () => {
    // Reference check value from the CRC catalogue (poly 0x8005/reflected 0xA001,
    // init 0xFFFF, refin/refout, xorout 0x0000) — independent of our own sources,
    // confirms the bit-banging port from OpenH59's `crc16_modbus` is correct.
    const bytes = Uint8Array.from("123456789".split("").map((c) => c.charCodeAt(0)));
    expect(crc16Modbus(bytes)).toBe(0x4b37);
  });

  it("returns 0xFFFF for an empty input (untouched init value)", () => {
    expect(crc16Modbus(new Uint8Array(0))).toBe(0xffff);
  });
});
