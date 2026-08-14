import { CMD, REALTIME_TYPE, BC_TYPE } from "./constants";
import { buildFrame } from "./frame";
import { buildBcFrame } from "./bcFrame";
import { byteToBcd } from "./bcd";
import { encodeUtf16WithBom } from "./encoding";

// ---------------------------------------------------------------------------
// Main channel — SUPPORTED (cross-validated OpenH59 + Gadgetbridge; the byte
// layouts below follow OpenH59 exactly, since that is the implementation
// proven against a physical H59 by its own author).
// ---------------------------------------------------------------------------

/** CMD.SET_TIME. The response doubles as the device's capability bitmap — see capability.ts. */
export function setTime(date: Date): Uint8Array {
  return buildFrame(CMD.SET_TIME, [
    byteToBcd(date.getFullYear() % 100),
    byteToBcd(date.getMonth() + 1),
    byteToBcd(date.getDate()),
    byteToBcd(date.getHours()),
    byteToBcd(date.getMinutes()),
    byteToBcd(date.getSeconds()),
    1,
  ]);
}

export function requestBattery(): Uint8Array {
  return buildFrame(CMD.BATTERY);
}

/** enabled=false stops 24/7 logging; intervalMin only matters when enabled. */
export function setHeartRateLogging(enabled: boolean, intervalMin = 5): Uint8Array {
  return buildFrame(CMD.HR_LOG_SETTINGS, [2, enabled ? 1 : 2, intervalMin]);
}

/**
 * dayMidnightUtcSeconds must be local midnight, but expressed as if it were a
 * UTC timestamp (i.e. local-wall-clock encoded as UTC seconds) — the device's
 * clock is naive/local and indexes history that way. See
 * `Band.heart_rate_history` in OpenH59 for why this offset trick is needed:
 * requesting a plain UTC midnight makes the device answer with the wrong day.
 */
export function requestHeartRateHistory(dayMidnightLocalAsUtcSeconds: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, dayMidnightLocalAsUtcSeconds, true);
  return buildFrame(CMD.HR_HISTORY, payload);
}

/** day: 0 = today, 1 = yesterday, ... */
export function requestStepsHistory(day: number): Uint8Array {
  return buildFrame(CMD.STEPS, [day, 0x0f, 0x00, 0x5f, 0x01]);
}

/** day: 0 = today, 1 = yesterday, ... 30-minute slots. */
export function requestStressHistory(day: number): Uint8Array {
  return buildFrame(CMD.STRESS_HISTORY, [day]);
}

/** day: 0 = today, 1 = yesterday, ... 30-minute slots, value in ms. */
export function requestHrvHistory(day: number): Uint8Array {
  return buildFrame(CMD.HRV_HISTORY, [day]);
}

/**
 * Legacy per-day sleep command. SUPPORTED as in "the device answers", but the
 * segment byte semantics were never confirmed (OpenH59 abandoned it in favor
 * of the bc 0x27 channel, which *is* fully decoded). Kept for completeness /
 * research use only — do not use for the product's sleep feature.
 */
export function requestSleepHistoryLegacy(): Uint8Array {
  return buildFrame(CMD.SLEEP_HISTORY_LEGACY);
}

export function startRealtimeMeasurement(type: (typeof REALTIME_TYPE)[keyof typeof REALTIME_TYPE]): Uint8Array {
  return buildFrame(CMD.REALTIME, [type, 1]);
}

export function stopRealtimeMeasurement(type: (typeof REALTIME_TYPE)[keyof typeof REALTIME_TYPE]): Uint8Array {
  return buildFrame(CMD.REALTIME_STOP, [type, 0, 0]);
}

// ---------------------------------------------------------------------------
// "bc" big-data channel — SUPPORTED (sleep + SpO2 history)
// ---------------------------------------------------------------------------

/** Must precede any bc-channel read. `account` is the QWatch username (part before the @ in the app's login email). */
export function bcLogin(account: string): Uint8Array {
  const body = new Uint8Array(3 + encodeUtf16WithBom(account).length);
  body.set([0x01, 0x01, 0x00], 0);
  body.set(encodeUtf16WithBom(account), 3);
  return buildBcFrame(BC_TYPE.LOGIN, body);
}

export function bcInit(): Uint8Array {
  return buildBcFrame(BC_TYPE.INIT);
}

/** day: 0 = today, 1 = yesterday, ... Returns 24 hourly (min,max) pairs. */
export function requestSpo2History(day: number): Uint8Array {
  return buildBcFrame(BC_TYPE.SPO2, [(-day) & 0xff]);
}

/**
 * Requests the full sleep blob. The device ignores the per-day parameter and
 * always returns every stored night in one response (see sleepBlob.ts) — this
 * mirrors OpenH59's `sleep_nights()`, which is why there is no per-day variant.
 */
export function requestSleepNights(): Uint8Array {
  return buildBcFrame(BC_TYPE.SLEEP, [0xff, 0x01]);
}
