import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@h59/db";
import { hashPassword } from "@/lib/password";
import { signSessionToken } from "@/lib/jwt";
import { SESSION_COOKIE } from "@/lib/session";
import { jsonError } from "@/lib/api";

const bodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1).max(120).optional(),
  timezone: z.string().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request body");
  const { email, password, name, timezone } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return jsonError(409, "An account with this email already exists");

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, name, timezone: timezone ?? "UTC" },
  });

  const token = await signSessionToken(user.id);
  const res = NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name },
    token, // mobile stores this in SecureStore; web ignores it and relies on the cookie below
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
