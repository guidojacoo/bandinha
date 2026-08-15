import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, jsonError } from "@/lib/api";
import { requireUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { parseManifest } from "@/lib/parse";
import { runScan } from "@/lib/scanner";

/** Large enough for a real package-lock.json, small enough to bound parsing. */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const bodySchema = z.object({
  manifest: z.string().min(1, "Paste a manifest to scan."),
  filename: z.string().max(200).optional(),
  label: z.string().max(200).optional(),
});

/** POST /api/scans — parse a manifest, resolve it against the registries, score it. */
export async function POST(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId();
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid request body.", 400);
    }
    const { manifest: text, filename, label } = parsed.data;

    if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
      return jsonError(
        `Manifest is larger than ${MAX_MANIFEST_BYTES / (1024 * 1024)} MB.`,
        413,
      );
    }

    // Throws ManifestParseError -> 400, handled below.
    const manifest = parseManifest(text, filename);
    const scanId = await runScan({
      userId,
      label: label?.trim() || filename?.trim() || manifest.kind,
      manifest,
    });

    return NextResponse.json({
      scanId,
      kind: manifest.kind,
      ecosystem: manifest.ecosystem,
      dependencyCount: manifest.dependencies.length,
      warnings: manifest.warnings,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

/** GET /api/scans — the signed-in user's scan history. */
export async function GET(): Promise<Response> {
  try {
    const userId = await requireUserId();
    const scans = await prisma.scan.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        label: true,
        ecosystem: true,
        status: true,
        totalPackages: true,
        resolvedPackages: true,
        portfolioScore: true,
        grade: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ scans });
  } catch (err) {
    return handleApiError(err);
  }
}
