import { describe, expect, it } from "vitest";
import { buildBcFrame, BcFrameReassembler } from "../src/bcFrame.js";

describe("buildBcFrame", () => {
  it("builds BC | type | len(LE) | crc16(LE) | body", () => {
    const body = Uint8Array.from([1, 2, 3]);
    const frame = buildBcFrame(0x2a, body);
    expect(frame[0]).toBe(0xbc);
    expect(frame[1]).toBe(0x2a);
    expect(frame[2]).toBe(3); // len low byte
    expect(frame[3]).toBe(0); // len high byte
    expect([...frame.subarray(6)]).toEqual([1, 2, 3]);
  });
});

describe("BcFrameReassembler", () => {
  it("parses a single frame delivered in one chunk", () => {
    const r = new BcFrameReassembler();
    const frame = buildBcFrame(0x27, [9, 8, 7]);
    const out = r.push(frame);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe(0x27);
    expect([...out[0]!.body]).toEqual([9, 8, 7]);
    expect(out[0]!.crcValid).toBe(true);
  });

  it("reassembles a frame split across multiple notification chunks", () => {
    const r = new BcFrameReassembler();
    const frame = buildBcFrame(0x2a, [1, 2, 3, 4, 5]);
    expect(r.push(frame.subarray(0, 4))).toHaveLength(0);
    expect(r.push(frame.subarray(4, 8))).toHaveLength(0);
    const out = r.push(frame.subarray(8));
    expect(out).toHaveLength(1);
    expect([...out[0]!.body]).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles two frames arriving back-to-back in one chunk", () => {
    const r = new BcFrameReassembler();
    const a = buildBcFrame(0x27, [1]);
    const b = buildBcFrame(0x2a, [2, 2]);
    const combined = new Uint8Array(a.length + b.length);
    combined.set(a, 0);
    combined.set(b, a.length);
    const out = r.push(combined);
    expect(out).toHaveLength(2);
    expect(out[0]!.type).toBe(0x27);
    expect(out[1]!.type).toBe(0x2a);
  });

  it("detects a corrupted body via CRC mismatch", () => {
    const r = new BcFrameReassembler();
    const frame = buildBcFrame(0x27, [1, 2, 3]);
    frame[6] = 0xff; // corrupt first body byte after framing
    const out = r.push(frame);
    expect(out[0]!.crcValid).toBe(false);
  });
});
