import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, jsonError } from "@/lib/api";
import { hashPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const bodySchema = z.object({
  email: z.string().email("Enter a valid email address.").max(254),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
  name: z.string().min(1).max(120).optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Invalid request body.", 400);
    }
    const email = parsed.data.email.trim().toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) return jsonError("An account with this email already exists.", 409);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await hashPassword(parsed.data.password),
        name: parsed.data.name,
      },
      select: { id: true, email: true, name: true },
    });

    await setSessionCookie(user.id);
    return NextResponse.json({ user });
  } catch (err) {
    return handleApiError(err);
  }
}
