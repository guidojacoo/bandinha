import type { ParsedFrame } from "../frame";

export interface SlotHistoryPoint {
  minuteOfDay: number;
  value: number;
}

export interface SlotHistoryResult {
  intervalMin: number;
  points: SlotHistoryPoint[];
}

/**
 * Shared parser for the "slot history" response shape used by both
 * CMD.STRESS_HISTORY (0x37) and CMD.HRV_HISTORY (0x39): a header frame
 * `[cmd, 0x00, count, intervalMin, ...]` followed by data frames
 * `[cmd, idx>=1, ...13 values...]`, one value per slot, 0 = no measurement.
 * Mirrors OpenH59's `Band._slot_history`.
 *
 * `frames` must be every frame received for a single day's request, in
 * arrival order, already filtered to the relevant cmd.
 */
export function parseSlotHistory(frames: ParsedFrame[]): SlotHistoryResult {
  let intervalMin = 30;
  const values = new Map<number, number>();

  for (const p of frames) {
    const raw = p.raw;
    const sub = raw[1] ?? 0;
    if (sub === 0xff) return { intervalMin, points: [] };
    if (sub === 0) {
      intervalMin = raw[3] || 30;
    } else {
      for (let i = 0; i < 13; i++) {
        const v = raw[2 + i] ?? 0;
        if (v) values.set((sub - 1) * 13 + i, v);
      }
    }
  }

  const points = [...values.entries()]
    .sort(([a], [b]) => a - b)
    .map(([slot, value]) => ({ minuteOfDay: slot * intervalMin, value }));
  return { intervalMin, points };
}
