import { NextResponse } from "next/server";
import { handleApiError, jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

interface Context {
  params: Promise<{ id: string }>;
}

/** GET /api/scans/:id — one scan with its findings, worst rot first. */
export async function GET(_req: Request, ctx: Context): Promise<Response> {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;

    // Scoped by userId, so another user's scan id is a 404, not a 403.
    const scan = await prisma.scan.findFirst({
      where: { id, userId },
      include: {
        findings: { orderBy: [{ rotScore: "desc" }, { packageName: "asc" }] },
      },
    });
    if (!scan) return jsonError("Scan not found.", 404);

    return NextResponse.json({ scan });
  } catch (err) {
    return handleApiError(err);
  }
}

/** DELETE /api/scans/:id */
export async function DELETE(_req: Request, ctx: Context): Promise<Response> {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;

    const deleted = await prisma.scan.deleteMany({ where: { id, userId } });
    if (deleted.count === 0) return jsonError("Scan not found.", 404);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
