import { describe, expect, it } from "vitest";
import { buildFrame, parseFrame } from "../src/frame.js";
import { parseRealtimeFrame } from "../src/parsers/realtime.js";
import { REALTIME_TYPE } from "../src/constants.js";

describe("parseRealtimeFrame", () => {
  it("parses a heart rate reading from byte[3]", () => {
    const frame = parseFrame(buildFrame(0x69, [REALTIME_TYPE.HEART_RATE, 0, 72]));
    const r = parseRealtimeFrame(frame);
    expect(r).toMatchObject({ ok: true, heartRate: 72 });
  });

  it("parses SpO2 from byte[3]", () => {
    const frame = parseFrame(buildFrame(0x69, [REALTIME_TYPE.SPO2, 0, 98]));
    expect(parseRealtimeFrame(frame)).toMatchObject({ ok: true, spo2: 98 });
  });

  it("parses blood pressure from byte[4]=systolic, byte[5]=diastolic, byte[3]=heart rate", () => {
    const frame = parseFrame(buildFrame(0x69, [REALTIME_TYPE.BLOOD_PRESSURE, 0, 73, 117, 79]));
    const r = parseRealtimeFrame(frame);
    expect(r.bloodPressure).toEqual({ systolic: 117, diastolic: 79, heartRate: 73 });
  });

  it("reports not-ok when the device returns a non-zero error code", () => {
    const frame = parseFrame(buildFrame(0x69, [REALTIME_TYPE.HEART_RATE, 2, 0]));
    expect(parseRealtimeFrame(frame).ok).toBe(false);
  });
});
