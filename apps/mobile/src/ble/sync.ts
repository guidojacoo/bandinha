import * as Protocol from "@h59/protocol";
import type { DataSource, DeviceCapabilities } from "@h59/shared";
import { H59Connection } from "./H59Connection";
import { localDb, type LocalHealthSample } from "../storage/localDb";
import { api } from "../api/client";

export interface SyncProgress {
  step: string;
  daysTotal: number;
  daysDone: number;
}

export interface SyncResult {
  capabilities: DeviceCapabilities;
  battery: { level: number; charging: boolean };
  daysSynced: number;
  uploaded: { healthSamples: number; sleepSessions: number };
  uploadedToBackend: boolean; // false = synced locally but offline, queued for later flush
}

function localMidnight(daysAgo: number, ref: Date): Date {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

/**
 * Full sync pipeline for one device: connect -> read capabilities/battery ->
 * decide how many days of history to pull (resolveSyncPlan) -> read every
 * history channel for each of those days -> cache locally (always works,
 * even offline) -> attempt to flush the cache to the backend.
 *
 * Mirrors OpenH59's collect.py end-to-end, but device I/O goes over
 * react-native-ble-plx instead of `bleak`, and every write lands in SQLite
 * first (see storage/localDb.ts) rather than going straight to a server.
 */
export async function syncDevice(
  deviceId: string,
  backendDeviceId: string,
  onProgress?: (p: SyncProgress) => void,
): Promise<SyncResult> {
  const conn = await H59Connection.connect(deviceId);
  try {
    onProgress?.({ step: "Reading device info", daysTotal: 0, daysDone: 0 });
    const capabilities = await conn.readCapabilities();
    const battery = await conn.readBattery();

    const lastSyncedAt = await localDb.getLastSyncedAt(deviceId);
    const plan = Protocol.resolveSyncPlan({ lastSyncedAt, now: new Date() });

    const now = new Date();
    for (let day = 0; day <= plan.days; day++) {
      onProgress?.({ step: `Syncing day -${day}`, daysTotal: plan.days + 1, daysDone: day });
      const dayStart = localMidnight(day, now);
      const samples: LocalHealthSample[] = [];

      const hr = await conn.readHeartRateHistory(Protocol.localMidnightAsDeviceSeconds(day, now));
      for (const p of hr) {
        samples.push(toSample(deviceId, addMinutes(dayStart, p.minuteOfDay), "heart_rate", p.bpm, "bpm"));
      }

      const steps = await conn.readStepsHistory(day);
      for (const p of steps) {
        const ts = new Date(p.year, p.month - 1, p.day, Math.floor(p.quarterHourOfDay / 4), (p.quarterHourOfDay % 4) * 15);
        samples.push(toSample(deviceId, ts, "steps", p.steps, ""));
        samples.push(toSample(deviceId, ts, "calories", p.calories, "kcal"));
        samples.push(toSample(deviceId, ts, "distance", p.distanceM, "m"));
      }

      if (capabilities.stress) {
        const stress = await conn.readStressHistory(day);
        for (const p of stress.points) samples.push(toSample(deviceId, addMinutes(dayStart, p.minuteOfDay), "stress", p.value, "/100"));
      }
      if (capabilities.hrv) {
        const hrv = await conn.readHrvHistory(day);
        for (const p of hrv.points) samples.push(toSample(deviceId, addMinutes(dayStart, p.minuteOfDay), "hrv", p.value, "ms"));
      }
      if (capabilities.spo2 && conn.supportsRichChannel) {
        const spo2 = await conn.readSpo2History(day);
        for (const p of spo2) {
          samples.push(toSample(deviceId, addMinutes(dayStart, p.hour * 60), "spo2", Math.round((p.min + p.max) / 2), "%"));
        }
      }

      await localDb.insertHealthSamples(samples);
    }

    if (capabilities.sleep && conn.supportsRichChannel) {
      onProgress?.({ step: "Syncing sleep", daysTotal: plan.days + 1, daysDone: plan.days + 1 });
      const nights = await conn.readSleepNights();
      for (const night of nights) {
        const date = localMidnight(night.daysAgo, now);
        const start = addMinutes(date, night.startMinuteOfDay);
        const end = addMinutes(date, night.endMinuteOfDay <= night.startMinuteOfDay ? night.endMinuteOfDay + 1440 : night.endMinuteOfDay);
        let cursor = start;
        const stages = night.segments.map((seg) => {
          const entry = { stage: seg.stage, startTs: cursor.toISOString(), durationMin: seg.minutes };
          cursor = addMinutes(cursor, seg.minutes);
          return entry;
        });
        await localDb.upsertSleepSession({
          deviceId,
          date: dateKey(date),
          startTs: start.toISOString(),
          endTs: end.toISOString(),
          totalMinutes: night.totalMinutes,
          source: "device_history",
          stages,
        });
      }
    }

    await localDb.setLastSyncedAt(deviceId, now);

    const uploaded = await flushPendingToBackend(deviceId, backendDeviceId, battery).catch(() => null);

    return {
      capabilities,
      battery,
      daysSynced: plan.days + 1,
      uploaded: uploaded ?? { healthSamples: 0, sleepSessions: 0 },
      uploadedToBackend: uploaded !== null,
    };
  } finally {
    await conn.disconnect();
  }
}

/** Uploads whatever is cached-but-not-yet-synced. Safe to call any time connectivity returns (e.g. app foreground). */
export async function flushPendingToBackend(
  deviceId: string,
  backendDeviceId: string,
  battery?: { level: number; charging: boolean },
): Promise<{ healthSamples: number; sleepSessions: number }> {
  const pendingSamples = await localDb.getUnsyncedHealthSamples(deviceId);
  const pendingSleep = await localDb.getUnsyncedSleepSessions(deviceId);
  if (!pendingSamples.length && !pendingSleep.length && !battery) {
    return { healthSamples: 0, sleepSessions: 0 };
  }

  await api.post("/api/devices/sync", {
    deviceId: backendDeviceId,
    battery,
    healthSamples: pendingSamples.map((s) => ({
      ts: s.ts,
      metric: s.metric,
      value: s.value,
      value2: s.value2,
      unit: s.unit,
      source: s.source,
    })),
    sleepSessions: pendingSleep.map((s) => ({
      date: s.date,
      startTs: s.startTs,
      endTs: s.endTs,
      totalMinutes: s.totalMinutes,
      source: s.source,
      stages: s.stages,
    })),
  });

  await localDb.markHealthSamplesSynced(pendingSamples.map((s) => s.id));
  await localDb.markSleepSessionsSynced(pendingSleep.map((s) => s.id));

  return { healthSamples: pendingSamples.length, sleepSessions: pendingSleep.length };
}

function toSample(deviceId: string, ts: Date, metric: string, value: number, unit: string): LocalHealthSample {
  return { deviceId, ts: ts.toISOString(), metric, value, unit, source: "device_history" satisfies DataSource };
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
