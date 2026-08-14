import { NextResponse } from "next/server";
import { prisma } from "@h59/db";
import { withAuth } from "@/lib/api";

/** GET /api/account/export — everything the product spec's "export all your data" promise covers. */
export const GET = withAuth(async (_req, userId) => {
  const [user, devices, healthSamples, sleepSessions, recoveryScores, alarms, aiInsights] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, timezone: true, createdAt: true },
    }),
    prisma.device.findMany({ where: { userId } }),
    prisma.healthSample.findMany({ where: { userId }, orderBy: { ts: "asc" } }),
    prisma.sleepSession.findMany({ where: { userId }, include: { stages: true }, orderBy: { date: "asc" } }),
    prisma.recoveryScore.findMany({ where: { userId }, orderBy: { date: "asc" } }),
    prisma.alarm.findMany({ where: { userId } }),
    prisma.aiInsight.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
  ]);

  const exportedAt = new Date().toISOString();
  return new NextResponse(
    JSON.stringify({ exportedAt, user, devices, healthSamples, sleepSessions, recoveryScores, alarms, aiInsights }, null, 2),
    {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="h59-health-export-${exportedAt.slice(0, 10)}.json"`,
      },
    },
  );
});
