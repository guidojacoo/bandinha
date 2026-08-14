import { NextResponse } from "next/server";
import { prisma } from "@h59/db";
import { withAuth } from "@/lib/api";

/** GET /api/sleep?from=YYYY-MM-DD&to=YYYY-MM-DD — sessions newest first, without per-stage detail. */
export const GET = withAuth(async (req, userId) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;

  const sessions = await prisma.sleepSession.findMany({
    where: { userId, date: { gte: from, lte: to } },
    orderBy: { date: "desc" },
    take: 400,
  });
  return NextResponse.json({ sessions });
});
