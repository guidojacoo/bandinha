import { bcdToByte } from "../bcd";
import type { ParsedFrame } from "../frame";

export interface StepsHistoryPoint {
  year: number;
  month: number;
  day: number;
  quarterHourOfDay: number; // 0..95 (15-minute slots)
  steps: number;
  calories: number;
  distanceM: number;
}

/**
 * Parses CMD.STEPS (0x43) response frames. Unlike HR/stress/HRV, this
 * command does not use a sub==0 header / sub==0xff-empty convention on
 * byte[1] — byte[1] is itself the BCD year of each data frame, with 0xff
 * (no data) and 0xf0 (initial packet, no data) as sentinels to skip.
 * Mirrors OpenH59's `Band.steps_history`.
 */
export function parseStepsHistory(frames: ParsedFrame[]): StepsHistoryPoint[] {
  const out: StepsHistoryPoint[] = [];
  for (const p of frames) {
    const raw = p.raw;
    const marker = raw[1] ?? 0;
    if (marker === 0xff || marker === 0xf0) continue;
    const year = bcdToByte(marker) + 2000;
    const month = bcdToByte(raw[2] ?? 0);
    const day = bcdToByte(raw[3] ?? 0);
    const quarterHourOfDay = raw[4] ?? 0;
    const calories = (raw[7] ?? 0) | ((raw[8] ?? 0) << 8);
    const steps = (raw[9] ?? 0) | ((raw[10] ?? 0) << 8);
    const distanceM = (raw[11] ?? 0) | ((raw[12] ?? 0) << 8);
    out.push({ year, month, day, quarterHourOfDay, steps, calories, distanceM });
  }
  return out;
}
