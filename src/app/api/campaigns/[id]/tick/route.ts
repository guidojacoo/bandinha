import { NextResponse } from "next/server";
import { handleApiError, jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/auth";
import { prisma } from "@/infra/db";
import { tick } from "@/agent/orchestrator";

/**
 * POST /api/campaigns/:id/tick — advance the agent one pass.
 *
 * The console calls this so an operator can watch the agent work without
 * waiting for the background loop. Scoped by user: another account's
 * campaign id is a 404, not a 403.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const campaign = await prisma.campaign.findFirst({ where: { id, userId }, select: { id: true } });
    if (!campaign) return jsonError("Campaign not found.", 404);

    const summary = await tick(id);
    return NextResponse.json({ summary });
  } catch (err) {
    return handleApiError(err);
  }
}
