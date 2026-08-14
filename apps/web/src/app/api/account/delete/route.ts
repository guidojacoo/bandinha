import { NextResponse } from "next/server";
import { prisma } from "@h59/db";
import { withAuth } from "@/lib/api";
import { SESSION_COOKIE } from "@/lib/session";

/** POST /api/account/delete — permanently deletes the account and every row that cascades from it. */
export const POST = withAuth(async (_req, userId) => {
  await prisma.user.delete({ where: { id: userId } });
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
});
