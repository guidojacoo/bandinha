import { NextResponse } from "next/server";
import { prisma } from "@h59/db";
import { withAuth } from "@/lib/api";
import { parseRangeParams } from "@/lib/health";

/** GET /api/health?from=&to=&deviceId=&limit= — all metrics in range, newest first. */
export const GET = withAuth(async (req, userId) => {
  const url = new URL(req.url);
  const { from, to, limit } = parseRangeParams(url);
  const deviceId = url.searchParams.get("deviceId") ?? undefined;

  const samples = await prisma.healthSample.findMany({
    where: {
      userId,
      deviceId,
      ts: { gte: from, lte: to },
    },
    orderBy: { ts: "desc" },
    take: limit,
  });
  return NextResponse.json({ samples });
});
