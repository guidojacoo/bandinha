import { describe, expect, it } from "vitest";
import * as cmds from "../src/commands.js";
import { experimentalFindDeviceOrVibrate } from "../src/experimental/findDeviceVibration.js";
import { CMD } from "../src/constants.js";

describe("command builders", () => {
  it("setTime BCD-encodes the date fields and appends the trailing 1", () => {
    const frame = cmds.setTime(new Date(2026, 7, 13, 15, 4, 9)); // 2026-08-13 15:04:09
    expect([...frame.subarray(0, 8)]).toEqual([
      CMD.SET_TIME,
      0x26, // year%100=26 BCD
      0x08, // month
      0x13, // day
      0x15, // hour
      0x04, // minute
      0x09, // second
      1,
    ]);
  });

  it("requestStepsHistory matches the byte layout confirmed in both OpenH59 and Gadgetbridge", () => {
    const frame = cmds.requestStepsHistory(2);
    expect([...frame.subarray(0, 6)]).toEqual([CMD.STEPS, 2, 0x0f, 0x00, 0x5f, 0x01]);
  });

  it("requestHeartRateHistory little-endian-encodes the timestamp", () => {
    const frame = cmds.requestHeartRateHistory(0x00112233);
    expect([...frame.subarray(1, 5)]).toEqual([0x33, 0x22, 0x11, 0x00]);
  });

  it("startRealtimeMeasurement / stopRealtimeMeasurement use the documented sub-bytes", () => {
    expect([...cmds.startRealtimeMeasurement(1).subarray(0, 3)]).toEqual([CMD.REALTIME, 1, 1]);
    expect([...cmds.stopRealtimeMeasurement(1).subarray(0, 4)]).toEqual([CMD.REALTIME_STOP, 1, 0, 0]);
  });

  it("requestSpo2History two's-complements the day into a single byte", () => {
    const frame = cmds.requestSpo2History(1);
    // BC frame: [0xBC, type, lenLE(2), crcLE(2), body...] — body[0] should be (-1)&0xFF = 0xFF
    expect(frame[6]).toBe(0xff);
  });
});

describe("experimental commands", () => {
  it("experimentalFindDeviceOrVibrate sends [0x50, 0x55, 0xAA] — UNCONFIRMED on real H59", () => {
    const frame = experimentalFindDeviceOrVibrate();
    expect([...frame.subarray(0, 3)]).toEqual([CMD.FIND_DEVICE, 0x55, 0xaa]);
  });
});
