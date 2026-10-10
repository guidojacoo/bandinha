import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, jsonError } from "@/lib/api";
import { hashPassword, setSessionCookie } from "@/lib/auth";
import { prisma } from "@/infra/db";

const schema = z.object({
  email: z.string().email("Enter a valid email address.").max(254),
  password: z.string().min(10, "Use at least 10 characters.").max(200),
  name: z.string().max(120).optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
    const email = parsed.data.email.trim().toLowerCase();

    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      return jsonError("An account with this email already exists.", 409);
    }
    const user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(parsed.data.password), name: parsed.data.name },
      select: { id: true, email: true, name: true },
    });
    await setSessionCookie(user.id);
    return NextResponse.json({ user });
  } catch (err) {
    return handleApiError(err);
  }
}
