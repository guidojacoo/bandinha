import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@h59/db";
import { verifyPassword } from "@/lib/password";
import { signSessionToken } from "@/lib/jwt";
import { SESSION_COOKIE } from "@/lib/session";
import { jsonError } from "@/lib/api";

const bodySchema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "Invalid request body");
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  // Deliberately identical error for "no such user" and "wrong password" — don't leak which one it was.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return jsonError(401, "Invalid email or password");
  }

  const token = await signSessionToken(user.id);
  const res = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
    token,
  });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
