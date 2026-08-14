import { SLEEP_STAGE_CODE } from "../constants";
import type { SleepStage } from "@h59/shared";

export interface SleepNightSegment {
  stage: SleepStage;
  minutes: number;
}

export interface SleepNight {
  /** 0 = most recent night ending today, 1 = the night before, ... */
  daysAgo: number;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
  totalMinutes: number;
  segments: SleepNightSegment[];
}

/**
 * Parses the body of a bc-channel type 0x27 (sleep) response. The device
 * packs EVERY stored night into one blob regardless of the requested day
 * (see commands.ts `requestSleepNights`) — this returns all of them.
 *
 * Format (verified byte-per-byte against the official app — see
 * docs/BLE_PROTOCOL.md): body[0] = night count N, then per night:
 *   [idx(1)][reserved(1)][startMin u16 LE][endMin u16 LE]
 *   followed by (stage, durationMin) byte pairs that sum exactly to
 *   (endMin - startMin) mod 1440 — that sum is what delimits one night's
 *   segments from the next night's header.
 *
 * Mirrors OpenH59's `Band._parse_sleep_blob`.
 */
export function parseSleepBlob(body: Uint8Array): SleepNight[] {
  const out: SleepNight[] = [];
  if (body.length < 8) return out;

  const n = body[0] ?? 0;
  let i = 1;
  for (let night = 0; night < n; night++) {
    if (i + 6 > body.length) break;
    const daysAgo = body[i] ?? 0;
    const startMinuteOfDay = (body[i + 2] ?? 0) | ((body[i + 3] ?? 0) << 8);
    const endMinuteOfDay = (body[i + 4] ?? 0) | ((body[i + 5] ?? 0) << 8);
    const totalMinutes = (endMinuteOfDay - startMinuteOfDay + 1440) % 1440;
    i += 6;

    const segments: SleepNightSegment[] = [];
    let acc = 0;
    while (i + 2 <= body.length && acc < totalMinutes) {
      const stageCode = body[i]!;
      const minutes = body[i + 1]!;
      const stage = (SLEEP_STAGE_CODE as Record<number, SleepStage>)[stageCode];
      if (!stage) break;
      if (minutes) segments.push({ stage, minutes });
      acc += minutes;
      i += 2;
    }

    if (segments.length === 0) continue;
    out.push({ daysAgo, startMinuteOfDay, endMinuteOfDay, totalMinutes, segments });
  }
  return out;
}
