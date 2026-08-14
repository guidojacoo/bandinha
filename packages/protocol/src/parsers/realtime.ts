import { REALTIME_TYPE } from "../constants";
import type { ParsedFrame } from "../frame";

export interface RealtimeReading {
  type: number;
  errorCode: number;
  ok: boolean;
  heartRate?: number;
  spo2?: number;
  stress?: number;
  bloodPressure?: { systolic: number; diastolic: number; heartRate?: number };
  /** HRV real-time byte offset is UNCONFIRMED — see docs/BLE_PROTOCOL.md. Always undefined for now. */
  hrvMs?: undefined;
}

/**
 * Parses one response to CMD.REALTIME (0x69): `[0x69, type, errorCode, b3, b4, b5, ...]`.
 * Mirrors OpenH59's `Band.measure` byte offsets exactly. The optical sensors
 * (HR/SpO2) frequently answer with errorCode != 0 while acquiring a lock —
 * that is normal and the caller should keep listening, not treat it as fatal.
 */
export function parseRealtimeFrame(frame: ParsedFrame): RealtimeReading {
  const raw = frame.raw;
  const type = raw[1] ?? 0;
  const errorCode = raw[2] ?? 0;
  const b3 = raw[3] ?? 0;
  const b4 = raw[4] ?? 0;
  const b5 = raw[5] ?? 0;
  const ok = errorCode === 0;

  if (type === REALTIME_TYPE.BLOOD_PRESSURE) {
    return {
      type,
      errorCode,
      ok: ok && b4 > 0 && b5 > 0,
      bloodPressure: b4 && b5 ? { systolic: b4, diastolic: b5, heartRate: b3 || undefined } : undefined,
    };
  }

  const reading: RealtimeReading = { type, errorCode, ok: ok && b3 > 0 };
  if (type === REALTIME_TYPE.HEART_RATE) reading.heartRate = b3 || undefined;
  else if (type === REALTIME_TYPE.SPO2) reading.spo2 = b3 || undefined;
  else if (type === REALTIME_TYPE.STRESS) reading.stress = b3 || undefined;
  return reading;
}
