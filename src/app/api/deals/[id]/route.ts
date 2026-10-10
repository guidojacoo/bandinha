import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/auth";
import { prisma } from "@/infra/db";
import { markLost, markWon } from "@/agent/deals";

const schema = z.object({
  action: z.enum(["won", "lost"]),
  valueCents: z.number().int().min(0).optional(),
  note: z.string().max(500).optional(),
  reason: z.string().max(200).optional(),
});

/**
 * POST /api/deals/:id — close a deal.
 *
 * The agent never marks its own deals won. `won` is set here: by a person,
 * or by a payment/contract webhook posting to this endpoint with the
 * provider's reference. An agent allowed to declare its own wins produces a
 * pipeline that measures its own optimism.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid request.", 400);

    const deal = await prisma.deal.findFirst({ where: { id, campaign: { userId } }, select: { id: true } });
    if (!deal) return jsonError("Deal not found.", 404);

    if (parsed.data.action === "won") {
      await markWon(id, { by: "operator", userId }, { valueCents: parsed.data.valueCents, note: parsed.data.note });
    } else {
      await markLost(id, parsed.data.reason ?? "Closed by the operator.");
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
