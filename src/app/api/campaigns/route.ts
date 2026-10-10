import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/auth";
import { prisma } from "@/infra/db";

const schema = z.object({
  url: z.string().url("Enter a full URL, including https://"),
  targetLeads: z.number().int().min(1).max(500).optional(),
  minFitScore: z.number().int().min(0).max(100).optional(),
  meetingLink: z.string().max(500).optional(),
  senderName: z.string().max(120).optional(),
  senderEmail: z.string().max(254).optional(),
  postalAddress: z.string().max(300).optional(),
  unsubscribeUrl: z.string().max(500).optional(),
});

/**
 * POST /api/campaigns — the one input.
 *
 * Creates the campaign in `ingesting`. The first orchestrator tick crawls the
 * URL, extracts the offering and derives the ICP; nothing is contacted until
 * well after that, and never until a sender identity exists.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId();
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    const d = parsed.data;

    const sender =
      d.senderEmail && d.senderName
        ? {
            fromName: d.senderName,
            fromEmail: d.senderEmail,
            postalAddress: d.postalAddress ?? "",
            unsubscribeUrl: d.unsubscribeUrl,
            replyTo: d.senderEmail,
          }
        : undefined;

    const campaign = await prisma.campaign.create({
      data: {
        userId,
        sourceUrl: d.url,
        name: new URL(d.url).hostname.replace(/^www\./, ""),
        status: "ingesting",
        targetLeads: d.targetLeads ?? 25,
        minFitScore: d.minFitScore ?? 55,
        meetingLink: d.meetingLink,
        senderIdentity: sender as unknown as object,
      },
      select: { id: true },
    });
    return NextResponse.json({ campaignId: campaign.id });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function GET(): Promise<Response> {
  try {
    const userId = await requireUserId();
    const campaigns = await prisma.campaign.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, sourceUrl: true, status: true, liveSending: true, createdAt: true },
    });
    return NextResponse.json({ campaigns });
  } catch (err) {
    return handleApiError(err);
  }
}
