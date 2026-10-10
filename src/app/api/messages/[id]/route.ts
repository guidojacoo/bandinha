import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/auth";
import { prisma } from "@/infra/db";
import { approveMessage, discardMessage } from "@/agent/deals";

const schema = z.object({ action: z.enum(["approve", "discard"]) });

/**
 * POST /api/messages/:id — release or bin a reply the agent held back.
 *
 * The agent deliberately parks anything it did not confidently understand,
 * anything that has gone too many rounds, and anything involving signing or
 * money. This is where a person resolves those.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid action.", 400);

    const message = await prisma.message.findFirst({
      where: { id, campaign: { userId } },
      select: { id: true, status: true },
    });
    if (!message) return jsonError("Message not found.", 404);
    if (message.status !== "awaiting_approval") {
      return jsonError(`This message is ${message.status}, not awaiting approval.`, 409);
    }

    if (parsed.data.action === "approve") await approveMessage(id);
    else await discardMessage(id);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
