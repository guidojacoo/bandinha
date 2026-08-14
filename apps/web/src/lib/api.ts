import { NextResponse } from "next/server";
import { UnauthorizedError, requireUserId } from "./session";

export function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

type RouteContext = { params: Promise<Record<string, string>> };

/** Wraps a Route Handler with auth + a consistent error shape. Every /api/* route (except /api/auth/*) uses this. */
export function withAuth(
  handler: (req: Request, userId: string, ctx: RouteContext) => Promise<Response>,
) {
  return async (req: Request, ctx: RouteContext): Promise<Response> => {
    try {
      const userId = await requireUserId(req);
      return await handler(req, userId, ctx);
    } catch (e) {
      if (e instanceof UnauthorizedError) return jsonError(401, "Unauthorized");
      console.error(e);
      return jsonError(500, "Internal error");
    }
  };
}
