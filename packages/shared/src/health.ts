/**
 * Domain types shared across protocol/, scoring/, db/, apps/web and apps/mobile.
 * Keeping these in one place avoids the mobile app, backend and parser drifting
 * into three slightly different definitions of "what is a heart rate sample".
 */

export type HealthMetric =
  | "heart_rate"
  | "spo2"
  | "blood_pressure"
  | "stress"
  | "hrv"
  | "steps"
  | "distance"
  | "calories"
  | "battery";

/**
 * Where a value came from. This distinction is required by the product spec:
 * never present a calculated/estimated number as if the device measured it.
 *
 * - device_realtime: on-demand measurement read live from the band (cmd 105).
 * - device_history:  pulled from the band's onboard buffer (~7 days).
 * - calculated:      derived deterministically from other device_* samples
 *                     (e.g. resting HR from a night of device_history HR).
 * - estimated:        modeled/approximated, not a direct sensor reading
 *                     (e.g. blood pressure trend the H59 does not actually log —
 *                     see docs/BLE_PROTOCOL.md, "no real on-device history").
 */
export type DataSource = "device_realtime" | "device_history" | "calculated" | "estimated";

export interface HealthSampleDTO {
  ts: string; // ISO 8601 UTC
  metric: HealthMetric;
  value: number;
  value2?: number; // diastolic BP, etc.
  unit: string;
  source: DataSource;
}

export type SleepStage = "light" | "deep" | "rem" | "awake";

export interface SleepStageSegmentDTO {
  stage: SleepStage;
  startTs: string; // ISO 8601 UTC
  durationMin: number;
}

export interface SleepSessionDTO {
  date: string; // local calendar date, YYYY-MM-DD
  startTs: string;
  endTs: string;
  totalMinutes: number;
  stages: SleepStageSegmentDTO[];
  sleepScore?: number; // 0-100, computed by @h59/scoring — never from the device
  source: DataSource;
}

/**
 * Bitmap decoded from the cmd 0x01 (set_time) response — the device's own
 * declaration of what it can actually do. See packages/protocol capability.ts.
 * Never assume capabilities from the model name; always prefer this.
 */
export interface DeviceCapabilities {
  temperature: boolean; // observed false on all known H59 units — marketing claim only
  spo2: boolean;
  bloodPressure: boolean;
  stress: boolean;
  hrv: boolean;
  sleep: boolean;
}

export interface DeviceDTO {
  id: string;
  bleId: string;
  name: string;
  firmwareVersion?: string;
  hardwareVersion?: string;
  capabilities?: DeviceCapabilities;
  hasVibrationMotor: boolean | null; // null = unknown until confirmed via ble-probe
  batteryLevel?: number;
  batteryCharging?: boolean;
  lastSeenAt?: string;
  lastSyncAt?: string;
}

export interface AlarmDTO {
  id: string;
  label: string;
  time: string; // "HH:MM", local device/user timezone
  days: number[]; // 0=Sunday .. 6=Saturday
  enabled: boolean;
  vibration: boolean;
  /**
   * true  = alarm is (or will be) written to the device's own firmware clock.
   * false = fallback: fires as a local notification on the phone at the
   *         scheduled time. This is the only kind we can currently GUARANTEE
   *         works, since the native device-alarm command is still UNKNOWN —
   *         see docs/BLE_PROTOCOL.md.
   */
  nativeDeviceAlarm: boolean;
  windowEndTime?: string; // for smart alarms: "HH:MM", end of the wake window
}

export interface RecoveryScoreDTO {
  date: string;
  score: number; // 0-100
  breakdown: {
    sleepQuality: number;
    hrv: number;
    restingHeartRate: number;
    regularity: number;
    stress: number;
    activity: number;
  };
  comparedToWeeklyAvgPct?: number;
}
