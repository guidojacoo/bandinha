import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api";
import { getOrComputeRecovery, dateStr } from "@/lib/recovery";

/**
 * GET /api/recovery?date=YYYY-MM-DD (defaults to today, UTC).
 * Aggregation logic lives in src/lib/recovery.ts (shared with the dashboard
 * Server Component) — see docs/SLEEP_ALGORITHM.md for what it means.
 */
export const GET = withAuth(async (req, userId) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? dateStr(new Date());
  const result = await getOrComputeRecovery(userId, date);
  return NextResponse.json(result);
});
