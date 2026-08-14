import { prisma } from "@h59/db";
import { computeRecoveryScore, compareToWeeklyAverage, regularityScoreFromVarianceMinutes } from "@h59/scoring";

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type RecoveryResult =
  | { available: true; recovery: Awaited<ReturnType<typeof prisma.recoveryScore.upsert>> }
  | { available: false; reason: string };

/**
 * Shared by /api/recovery and the dashboard Server Component so the
 * aggregation logic (see docs/SLEEP_ALGORITHM.md) lives in exactly one place.
 */
export async function getOrComputeRecovery(userId: string, date: string): Promise<RecoveryResult> {
  const cached = await prisma.recoveryScore.findUnique({ where: { userId_date: { userId, date } } });
  if (cached) return { available: true, recovery: cached };

  const sleepSession = await prisma.sleepSession.findFirst({ where: { userId, date } });
  if (!sleepSession || sleepSession.sleepScore === null) {
    return { available: false, reason: "No sleep session recorded for this date yet" };
  }

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);
  const baselineStart = new Date(dayStart.getTime() - 14 * 86400_000);

  const [todayHrv, baselineHrv, todayHr, baselineHr, todayStress, todaySteps, weekSteps, recentSessions, weekScores] =
    await Promise.all([
      prisma.healthSample.findMany({ where: { userId, metric: "hrv", ts: { gte: dayStart, lte: dayEnd } } }),
      prisma.healthSample.findMany({ where: { userId, metric: "hrv", ts: { gte: baselineStart, lt: dayStart } } }),
      prisma.healthSample.findMany({ where: { userId, metric: "heart_rate", ts: { gte: dayStart, lte: dayEnd } } }),
      prisma.healthSample.findMany({ where: { userId, metric: "heart_rate", ts: { gte: baselineStart, lt: dayStart } } }),
      prisma.healthSample.findMany({ where: { userId, metric: "stress", ts: { gte: dayStart, lte: dayEnd } } }),
      prisma.healthSample.findMany({ where: { userId, metric: "steps", ts: { gte: dayStart, lte: dayEnd } } }),
      prisma.healthSample.findMany({ where: { userId, metric: "steps", ts: { gte: baselineStart, lt: dayStart } } }),
      prisma.sleepSession.findMany({
        where: { userId, date: { gte: dateStr(new Date(dayStart.getTime() - 7 * 86400_000)), lte: date } },
        select: { startAt: true },
      }),
      prisma.recoveryScore.findMany({
        where: { userId, date: { gte: dateStr(new Date(dayStart.getTime() - 7 * 86400_000)), lt: date } },
        select: { score: true },
      }),
    ]);

  const avg = (samples: { value: number }[]) =>
    samples.length ? samples.reduce((s, x) => s + x.value, 0) / samples.length : undefined;

  const hrvMs = avg(todayHrv);
  const hrvBaselineMs = avg(baselineHrv);
  const restingHr = todayHr.length ? Math.min(...todayHr.map((s) => s.value)) : undefined;
  const restingHrBaselineMs = avg(baselineHr);
  const averageStress = avg(todayStress);

  const bedtimeMinutes = recentSessions.map((s) => s.startAt.getUTCHours() * 60 + s.startAt.getUTCMinutes());
  const regularityScore =
    bedtimeMinutes.length >= 2 ? regularityScoreFromVarianceMinutes(stdev(bedtimeMinutes)) : undefined;

  const todayStepsSum = todaySteps.reduce((s, x) => s + x.value, 0);
  const weekStepsByDay = new Map<string, number>();
  for (const s of weekSteps) {
    const d = dateStr(s.ts);
    weekStepsByDay.set(d, (weekStepsByDay.get(d) ?? 0) + s.value);
  }
  const weekAvgSteps =
    weekStepsByDay.size > 0 ? [...weekStepsByDay.values()].reduce((a, b) => a + b, 0) / weekStepsByDay.size : undefined;
  const acuteActivityLoadRatio =
    weekAvgSteps && weekAvgSteps > 0 && todaySteps.length > 0 ? todayStepsSum / weekAvgSteps : undefined;

  const { score, breakdown } = computeRecoveryScore({
    sleepScore: sleepSession.sleepScore,
    hrvMs,
    hrvBaselineMs,
    restingHr,
    restingHrBaselineMs,
    regularityScore,
    averageStress,
    acuteActivityLoadRatio,
  });

  const weeklyAvg = weekScores.length ? weekScores.reduce((s, x) => s + x.score, 0) / weekScores.length : 0;
  const comparedToWeeklyAvgPct = compareToWeeklyAverage(score, weeklyAvg);

  const recovery = await prisma.recoveryScore.upsert({
    where: { userId_date: { userId, date } },
    update: { score, breakdown, comparedToWeeklyAvgPct },
    create: { userId, date, score, breakdown, comparedToWeeklyAvgPct },
  });

  return { available: true, recovery };
}
