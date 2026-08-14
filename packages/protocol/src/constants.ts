/**
 * H59 / Colmi-QC BLE protocol constants.
 *
 * Cross-validated against three independent open-source reverse-engineering
 * efforts before being treated as SUPPORTED here:
 *   - OpenH59 (LudovicoPiccolo/OpenH59) — band.py, docs/APPUNTI-TECNICI.md
 *   - Gadgetbridge (Freeyourgadget/Gadgetbridge) — devices/colmi/ColmiR0xConstants.java
 *   - colmi_r02_client (tahnok/colmi_r02_client) — same Nordic-UART service/framing
 *
 * See docs/BLE_PROTOCOL.md for the full SUPPORTED / EXPERIMENTAL / UNKNOWN
 * breakdown and citations. Anything not listed here as SUPPORTED should be
 * treated as unverified even if it appears in one of the source projects.
 */

// ---------------------------------------------------------------------------
// GATT UUIDs
// ---------------------------------------------------------------------------

/** Nordic UART-style service carrying the main 16-byte command channel. */
export const SERVICE_UART = "6e40fff0-b5a3-f393-e0a9-e50e24dcca9e";
/** Write commands here (RX from the device's point of view). */
export const CHARACTERISTIC_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
/** Subscribe here for 16-byte command responses (TX from the device). */
export const CHARACTERISTIC_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";

/** "bc" / big-data service: variable-length frames for sleep + SpO2 history. */
export const SERVICE_BIGDATA = "de5bf728-d711-4e47-af26-65e3012a5dc7";
export const CHARACTERISTIC_BIGDATA_WRITE = "de5bf72a-d711-4e47-af26-65e3012a5dc7";
export const CHARACTERISTIC_BIGDATA_NOTIFY = "de5bf729-d711-4e47-af26-65e3012a5dc7";

/** First byte of every "bc" channel frame. */
export const BC_MAGIC = 0xbc;

// ---------------------------------------------------------------------------
// Main channel commands (byte 0 of the 16-byte frame)
// ---------------------------------------------------------------------------

export const CMD = {
  SET_TIME: 0x01,
  PHONE_NAME: 0x04, // Gadgetbridge only; not exercised by OpenH59
  BATTERY: 0x03,
  POWER_OFF: 0x08,
  PREFERENCES: 0x0a, // user profile (age/height/weight/gender) — Gadgetbridge only
  SLEEP_HISTORY_LEGACY: 0x0d, // superseded by the bc 0x27 channel; segment semantics unconfirmed
  HR_HISTORY: 0x15,
  HR_LOG_SETTINGS: 0x16,
  GOALS: 0x21, // daily step/calorie/distance/sport/sleep goals — Gadgetbridge only
  BP_HISTORY_UNRESPONSIVE: 0x14, // device does not answer this; BP has no real on-device history
  STRESS_HISTORY: 0x37,
  HRV_HISTORY: 0x39,
  STEPS: 0x43,
  TODAY_SUMMARY: 0x48,
  FIND_DEVICE: 0x50, // EXPERIMENTAL for H59 — see experimental/findDevice.ts
  NOTIFICATION: 0x73, // incoming-only: device announcing new data is ready to sync
  REALTIME: 0x69,
  REALTIME_STOP: 0x6a,
  FACTORY_RESET: 0xff,
} as const;

/** Realtime measurement sub-types for CMD.REALTIME / CMD.REALTIME_STOP. */
export const REALTIME_TYPE = {
  HEART_RATE: 1,
  BLOOD_PRESSURE: 2,
  SPO2: 3,
  STRESS: 8,
  HRV: 10, // response byte offset for the value is unconfirmed — see docs/BLE_PROTOCOL.md
} as const;

/** "bc" channel frame types. */
export const BC_TYPE = {
  LOGIN: 0x4a,
  INIT: 0x30,
  SLEEP: 0x27,
  SPO2: 0x2a,
} as const;

export const SLEEP_STAGE_CODE = {
  2: "light",
  3: "deep",
  4: "rem",
  5: "awake",
} as const satisfies Record<number, "light" | "deep" | "rem" | "awake">;

/** Incoming NOTIFICATION (0x73) sub-types. */
export const NOTIFICATION_KIND = {
  NEW_HR_DATA: 0x01,
  NEW_SPO2_DATA: 0x03,
  NEW_STEPS_DATA: 0x04,
  BATTERY_LEVEL: 0x0c,
  LIVE_ACTIVITY: 0x12,
} as const;

export const FRAME_LENGTH = 16;
