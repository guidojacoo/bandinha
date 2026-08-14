import { NextResponse } from "next/server";
import { prisma } from "@h59/db";
import { withAuth, jsonError } from "@/lib/api";

/** GET /api/sleep/2026-08-12 — full detail including per-stage timeline. */
export const GET = withAuth(async (_req, userId, ctx) => {
  const { date } = await ctx.params;
  const session = await prisma.sleepSession.findFirst({
    where: { userId, date },
    include: { stages: { orderBy: { startAt: "asc" } } },
  });
  if (!session) return jsonError(404, "No sleep session for this date");
  return NextResponse.json({ session });
});
