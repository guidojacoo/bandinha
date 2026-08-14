import type { ParsedFrame } from "../frame";

export interface HrHistoryPoint {
  minuteOfDay: number; // 0..1435, in 5-minute steps
  bpm: number;
}

/**
 * Parses the full set of CMD.HR_HISTORY (0x15) response frames for one day
 * request into a sparse list of (minuteOfDay, bpm) points (288 slots/day,
 * 5-minute resolution; slots with no reading are omitted). Mirrors
 * OpenH59's `Band.heart_rate_history` byte-for-byte.
 *
 * `frames` must be every frame received in response to a single request,
 * in arrival order, already filtered to cmd === CMD.HR_HISTORY.
 * Returns [] if the device reports no data for the requested day.
 */
export function parseHeartRateHistory(frames: ParsedFrame[]): HrHistoryPoint[] {
  let size = 0;
  let raw: number[] = [];
  let index = 0;

  for (const p of frames) {
    const raw16 = p.raw;
    const sub = raw16[1] ?? 0;
    if (sub === 0xff) return [];
    if (sub === 0) {
      size = raw16[2] ?? 0;
      raw = new Array(size * 13).fill(0);
      index = 0;
    } else if (sub === 1) {
      for (let i = 0; i < 9; i++) raw[i] = raw16[6 + i] ?? 0;
      index = 9;
    } else {
      for (let i = 0; i < 13; i++) raw[index + i] = raw16[2 + i] ?? 0;
      index += 13;
    }
  }

  const out: HrHistoryPoint[] = [];
  for (let i = 0; i < Math.min(288, raw.length); i++) {
    const bpm = raw[i];
    if (bpm) out.push({ minuteOfDay: 5 * i, bpm });
  }
  return out;
}
