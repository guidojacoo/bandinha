import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** Liveness probe: confirms the process is up and the database answers. */
export async function GET(): Promise<Response> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, database: "up" });
  } catch (err) {
    return NextResponse.json(
      { ok: false, database: "down", error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
