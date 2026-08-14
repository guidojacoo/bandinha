import { NextResponse } from "next/server";
import { prisma } from "@h59/db";
import { withAuth, jsonError } from "@/lib/api";
import { parseMetricParam, parseRangeParams } from "@/lib/health";

/** GET /api/health/heart-rate | /api/health/hrv | /api/health/spo2 | ... ?from=&to=&deviceId=&limit= */
export const GET = withAuth(async (req, userId, ctx) => {
  const { metric: metricParam } = await ctx.params;
  const metric = parseMetricParam(metricParam);
  if (!metric) return jsonError(400, `Unknown metric: ${metricParam}`);

  const url = new URL(req.url);
  const { from, to, limit } = parseRangeParams(url);
  const deviceId = url.searchParams.get("deviceId") ?? undefined;

  const samples = await prisma.healthSample.findMany({
    where: { userId, deviceId, metric, ts: { gte: from, lte: to } },
    orderBy: { ts: "desc" },
    take: limit,
  });
  return NextResponse.json({ metric, samples });
});
