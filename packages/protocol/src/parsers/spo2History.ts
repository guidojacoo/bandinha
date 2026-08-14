export interface Spo2HourPoint {
  hour: number; // 0..23
  min: number;
  max: number;
}

/**
 * Parses the body of a bc-channel type 0x2a (SpO2 history) response:
 * `[day] + 24 (min,max) pairs`, one pair per hour 00..23; `(0,0)` means no
 * measurement that hour. Verified byte-per-byte against the official app —
 * see docs/BLE_PROTOCOL.md. Mirrors OpenH59's `Band.spo2_history`.
 *
 * OpenH59 stores only the hourly max; Gadgetbridge stores round((min+max)/2).
 * We return both and let the caller decide — see packages/scoring or the
 * sync layer for which one this product uses.
 */
export function parseSpo2History(body: Uint8Array): Spo2HourPoint[] {
  if (body.length < 3) return [];
  const pairs = body.subarray(1);
  const out: Spo2HourPoint[] = [];
  const hours = Math.min(24, Math.floor(pairs.length / 2));
  for (let h = 0; h < hours; h++) {
    const lo = pairs[2 * h] ?? 0;
    const hi = pairs[2 * h + 1] ?? 0;
    if (hi) out.push({ hour: h, min: lo, max: hi });
  }
  return out;
}
