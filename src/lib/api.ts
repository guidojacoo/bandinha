import { NextResponse } from "next/server";
import { UnauthorizedError } from "./auth";

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Only errors this app raises deliberately get their message forwarded.
 * Anything unexpected is logged server-side and reported generically, so
 * database and driver internals never reach the client.
 */
export function handleApiError(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) return jsonError("Not signed in.", 401);
  console.error("[rainmaker] unhandled API error:", err);
  return jsonError("Something went wrong. Please try again.", 500);
}
