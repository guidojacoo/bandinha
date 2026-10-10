import { NextResponse } from "next/server";
import { prisma } from "@/infra/db";
import { transportStatus } from "@/infra/transport";
import { llm } from "@/infra/llm/client";

/** Liveness, plus the two facts an operator most needs to know. */
export async function GET(): Promise<Response> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      ok: true,
      database: "up",
      sending: transportStatus(),
      model: llm().enabled ? llm().model : null,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, database: "down", error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }
}
