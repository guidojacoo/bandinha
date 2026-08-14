import { describe, expect, it } from "vitest";
import { buildFrame } from "../src/frame.js";
import { parseFrame } from "../src/frame.js";
import { decodeCapabilities } from "../src/capability.js";

describe("decodeCapabilities", () => {
  it("decodes the SET_TIME response bitmap (spo2+bp+stress+hrv+sleep on, temperature off)", () => {
    // b[3] = spo2(bit1) | bloodPressure(bit2) = 0b110 = 6
    // b[8] = 1 -> sleep supported
    // b[13] = stress(bit4) | hrv(bit5) = 0b110000 = 48
    const payload = [0, 0, 0, 6, 0, 0, 0, 0, 1, 0, 0, 0, 0, 48];
    const frame = parseFrame(buildFrame(0x01, payload));
    const caps = decodeCapabilities(frame);
    expect(caps).toEqual({
      temperature: false,
      spo2: true,
      bloodPressure: true,
      stress: true,
      hrv: true,
      sleep: true,
    });
  });

  it("reports temperature unsupported even when b[0] is set to an unexpected value", () => {
    const frame = parseFrame(buildFrame(0x01, [0, 0, 0, 0]));
    expect(decodeCapabilities(frame).temperature).toBe(false);
  });
});
