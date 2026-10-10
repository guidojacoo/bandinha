import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/auth";
import { prisma } from "@/infra/db";
import { senderIdentityProblems } from "@/core/compliance";
import { SmtpTransport } from "@/infra/transport";
import type { SenderIdentity } from "@/core/types";

const schema = z.object({
  status: z.enum(["running", "paused"]).optional(),
  liveSending: z.boolean().optional(),
  minFitScore: z.number().int().min(0).max(100).optional(),
  targetLeads: z.number().int().min(1).max(500).optional(),
  meetingLink: z.string().max(500).optional(),
  senderIdentity: z
    .object({
      fromName: z.string().max(120),
      fromEmail: z.string().max(254),
      postalAddress: z.string().max(300),
      unsubscribeUrl: z.string().max(500).optional(),
      replyTo: z.string().max(254).optional(),
    })
    .optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const campaign = await prisma.campaign.findFirst({ where: { id, userId } });
    if (!campaign) return jsonError("Campaign not found.", 404);

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    const patch = parsed.data;

    // Arming live sending is the one irreversible-feeling action in the
    // product, so it is gated on both halves being genuinely ready rather
    // than on a toggle being clicked.
    if (patch.liveSending === true) {
      const sender = (patch.senderIdentity ?? campaign.senderIdentity) as SenderIdentity | null;
      const problems = sender ? senderIdentityProblems(sender) : ["no sender identity configured"];
      if (problems.length > 0) {
        return jsonError(`Cannot go live: ${problems.join("; ")}.`, 400);
      }
      if (!SmtpTransport.isConfigured()) {
        return jsonError(
          "Cannot go live: SMTP is not configured. Set SMTP_HOST, SMTP_USER and SMTP_PASS, and SEND_MODE=live.",
          400,
        );
      }
      const check = await new SmtpTransport().verify();
      if (!check.ok) return jsonError(`Cannot go live: ${check.detail}`, 400);
    }

    const updated = await prisma.campaign.update({
      where: { id },
      data: {
        status: patch.status,
        liveSending: patch.liveSending,
        minFitScore: patch.minFitScore,
        targetLeads: patch.targetLeads,
        meetingLink: patch.meetingLink,
        senderIdentity: patch.senderIdentity as unknown as object | undefined,
      },
      select: { id: true, status: true, liveSending: true },
    });
    return NextResponse.json({ campaign: updated });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    const deleted = await prisma.campaign.deleteMany({ where: { id, userId } });
    if (deleted.count === 0) return jsonError("Campaign not found.", 404);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
