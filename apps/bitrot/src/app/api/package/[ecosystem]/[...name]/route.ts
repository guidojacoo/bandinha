import { NextResponse } from "next/server";
import { handleApiError, jsonError } from "@/lib/api";
import { getPackage } from "@/lib/packageService";
import { clientKey, rateLimit } from "@/lib/rateLimit";
import { isEcosystem } from "@/lib/registry";
import { scoreOne } from "@/lib/rot";

interface Context {
  params: Promise<{ ecosystem: string; name: string[] }>;
}

/**
 * GET /api/package/npm/@babel/core — public, unauthenticated package lookup.
 *
 * This is the "paste a name, is it healthy?" check that Snyk Advisor used to
 * serve, so it deliberately needs no account. The name is a catch-all segment
 * because npm scopes contain a slash.
 */
export async function GET(req: Request, ctx: Context): Promise<Response> {
  try {
    const limited = rateLimit(`pkg:${clientKey(req)}`, 60, 60_000);
    if (!limited.ok) {
      return NextResponse.json(
        { error: "Too many lookups. Try again shortly." },
        { status: 429, headers: { "retry-after": String(limited.retryAfterSeconds) } },
      );
    }

    const { ecosystem, name: segments } = await ctx.params;
    if (!isEcosystem(ecosystem)) {
      return jsonError(`Unknown ecosystem "${ecosystem}". Use "npm" or "pypi".`, 400);
    }

    const name = segments.map(decodeURIComponent).join("/");
    if (!name) return jsonError("No package name given.", 400);

    const result = await getPackage(ecosystem, name);
    if (!result.ok) {
      return jsonError(result.error, result.kind === "not_found" ? 404 : 502);
    }

    const rot = scoreOne({ pkg: result.pkg, now: new Date() });
    return NextResponse.json({ package: result.pkg, rot, cached: result.cached });
  } catch (err) {
    return handleApiError(err);
  }
}
