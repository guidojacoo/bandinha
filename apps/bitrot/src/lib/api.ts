import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { UnauthorizedError } from "./auth/session";
import { ManifestParseError } from "./parse";

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Maps a thrown error to a response.
 *
 * Only errors this app raises deliberately get their message forwarded; an
 * unexpected throw is logged server-side and reported generically, so database
 * and driver internals never reach the client.
 */
export function handleApiError(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError) return jsonError("Not signed in.", 401);
  if (err instanceof ManifestParseError) return jsonError(err.message, 400);
  if (err instanceof ZodError) {
    const first = err.errors[0];
    return jsonError(first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.", 400);
  }
  console.error("[bitrot] unhandled API error:", err);
  return jsonError("Something went wrong. Please try again.", 500);
}
