import type { ParsedFrame } from "../frame";

export interface BatteryReading {
  level: number; // 0-100
  charging: boolean;
}

export function parseBattery(frame: ParsedFrame): BatteryReading {
  const raw = frame.raw;
  return { level: raw[1] ?? 0, charging: (raw[2] ?? 0) !== 0 };
}
