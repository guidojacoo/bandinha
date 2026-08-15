import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api";
import { clearSessionCookie } from "@/lib/auth/session";

export async function POST(): Promise<Response> {
  try {
    await clearSessionCookie();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
