import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { ECOSYSTEMS } from "@/lib/registry";

const bodySchema = z.object({
  ecosystem: z.enum(ECOSYSTEMS as unknown as [string, ...string[]]),
  packageName: z.string().min(1).max(214),
  note: z.string().max(500).optional(),
});

/**
 * POST /api/acknowledgements — "yes, this one is stale, and that is fine here."
 *
 * Acknowledged packages stay visible but drop out of the portfolio score, so a
 * team can drive the number to green without pretending the risk is gone.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId();
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError("Invalid request body.", 400);
    const { ecosystem, packageName, note } = parsed.data;

    const ack = await prisma.acknowledgement.upsert({
      where: {
        userId_ecosystem_packageName: {
          userId,
          ecosystem: ecosystem as "npm" | "pypi",
          packageName,
        },
      },
      create: { userId, ecosystem: ecosystem as "npm" | "pypi", packageName, note },
      update: { note },
    });
    return NextResponse.json({ acknowledgement: ack });
  } catch (err) {
    return handleApiError(err);
  }
}

/** GET /api/acknowledgements — everything the signed-in user has accepted. */
export async function GET(): Promise<Response> {
  try {
    const userId = await requireUserId();
    const acknowledgements = await prisma.acknowledgement.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ acknowledgements });
  } catch (err) {
    return handleApiError(err);
  }
}

/** DELETE /api/acknowledgements?ecosystem=npm&packageName=request */
export async function DELETE(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId();
    const url = new URL(req.url);
    const ecosystem = url.searchParams.get("ecosystem");
    const packageName = url.searchParams.get("packageName");
    if (!ecosystem || !packageName) return jsonError("ecosystem and packageName are required.", 400);

    const deleted = await prisma.acknowledgement.deleteMany({
      where: { userId, ecosystem: ecosystem as "npm" | "pypi", packageName },
    });
    if (deleted.count === 0) return jsonError("Acknowledgement not found.", 404);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
