import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, type Prisma } from "@h59/db";
import { computeSleepScore } from "@h59/scoring";
import { withAuth, jsonError } from "@/lib/api";

/**
 * Incremental sync from the mobile app's local cache to the backend.
 *
 * - healthSamples use createMany + skipDuplicates: history readings for a
 *   given (device, metric, timestamp) never change once recorded, so
 *   "skip if it already exists" is both correct and fast — matching the
 *   idempotency behaviour verified in OpenH59's own `store.py` (re-running
 *   a sync over already-downloaded days creates no duplicates). See the
 *   @@unique([deviceId, metric, ts]) constraint in packages/db/prisma/schema.prisma.
 * - sleepSessions use delete-and-replace-segments-then-upsert, because a
 *   session for the same night can legitimately be re-synced with more
 *   complete data (e.g. a partial sync followed by a full one) — this
 *   mirrors OpenH59's `store.replace_sleep`. The Sleep Score is always
 *   recomputed server-side from the synced stages; the client never sends
 *   (or can override) a score.
 */

const healthSampleSchema = z.object({
  ts: z.string().datetime(),
  metric: z.enum([
    "heart_rate", "spo2", "blood_pressure", "stress", "hrv", "steps", "distance", "calories", "battery",
  ]),
  value: z.number(),
  value2: z.number().optional(),
  unit: z.string(),
  source: z.enum(["device_realtime", "device_history", "calculated", "estimated"]),
});

const sleepStageSchema = z.object({
  stage: z.enum(["light", "deep", "rem", "awake"]),
  startTs: z.string().datetime(),
  durationMin: z.number().int().positive(),
});

const sleepSessionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTs: z.string().datetime(),
  endTs: z.string().datetime(),
  totalMinutes: z.number().int().positive(),
  stages: z.array(sleepStageSchema),
  source: z.enum(["device_realtime", "device_history", "calculated", "estimated"]),
});

const bodySchema = z.object({
  deviceId: z.string().min(1),
  battery: z.object({ level: z.number().int().min(0).max(100), charging: z.boolean() }).optional(),
  healthSamples: z.array(healthSampleSchema).max(20000).default([]),
  sleepSessions: z.array(sleepSessionSchema).max(60).default([]),
});

export const POST = withAuth(async (req, userId) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request body");
  const { deviceId, battery, healthSamples, sleepSessions } = parsed.data;

  const device = await prisma.device.findFirst({ where: { id: deviceId, userId } });
  if (!device) return jsonError(404, "Device not found");

  const now = new Date();

  const healthResult = healthSamples.length
    ? await prisma.healthSample.createMany({
        data: healthSamples.map((s) => ({
          userId,
          deviceId,
          ts: new Date(s.ts),
          metric: s.metric,
          value: s.value,
          value2: s.value2,
          unit: s.unit,
          source: s.source,
        })),
        skipDuplicates: true,
      })
    : { count: 0 };

  const sleepScores: Record<string, number> = {};
  for (const session of sleepSessions) {
    const totalNonAwakeMin = session.stages
      .filter((s) => s.stage !== "awake")
      .reduce((sum, s) => sum + s.durationMin, 0);
    const minutesFor = (stage: "light" | "deep" | "rem" | "awake") =>
      session.stages.filter((s) => s.stage === stage).reduce((sum, s) => sum + s.durationMin, 0);
    const awakeMinutes = minutesFor("awake");
    const awakenings = session.stages.filter((s) => s.stage === "awake").length;

    const { score } = computeSleepScore({
      totalMinutes: session.totalMinutes,
      awakeMinutes,
      awakenings,
      deepMinutes: minutesFor("deep"),
      remMinutes: minutesFor("rem"),
      lightMinutes: minutesFor("light"),
    });
    void totalNonAwakeMin; // reserved for a future regularity/baseline pass across sessions

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const saved = await tx.sleepSession.upsert({
        where: { deviceId_date: { deviceId, date: session.date } },
        update: {
          startAt: new Date(session.startTs),
          endAt: new Date(session.endTs),
          totalMinutes: session.totalMinutes,
          sleepScore: score,
          source: session.source,
        },
        create: {
          userId,
          deviceId,
          date: session.date,
          startAt: new Date(session.startTs),
          endAt: new Date(session.endTs),
          totalMinutes: session.totalMinutes,
          sleepScore: score,
          source: session.source,
        },
      });
      await tx.sleepStageSegment.deleteMany({ where: { sleepSessionId: saved.id } });
      if (session.stages.length) {
        await tx.sleepStageSegment.createMany({
          data: session.stages.map((s) => ({
            sleepSessionId: saved.id,
            stage: s.stage,
            startAt: new Date(s.startTs),
            durationMin: s.durationMin,
          })),
        });
      }
    });
    sleepScores[session.date] = score;
  }

  await prisma.device.update({
    where: { id: deviceId },
    data: {
      lastSyncAt: now,
      lastSeenAt: now,
      ...(battery ? { batteryLevel: battery.level, batteryCharging: battery.charging } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    deviceLastSyncAt: now.toISOString(),
    upserted: { healthSamples: healthResult.count, sleepSessions: sleepSessions.length },
    sleepScores,
  });
});
