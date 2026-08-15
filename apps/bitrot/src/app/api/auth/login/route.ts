import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, jsonError } from "@/lib/api";
import { burnPasswordTime, verifyPassword } from "@/lib/auth/password";
import { setSessionCookie } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const bodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError("Enter your email and password.", 400);
    const email = parsed.data.email.trim().toLowerCase();

    const user = await prisma.user.findUnique({ where: { email } });

    // Same wording and comparable timing whether the email or the password was
    // wrong, so this endpoint cannot be used to enumerate accounts.
    if (!user) {
      await burnPasswordTime(parsed.data.password);
      return jsonError("Email or password is incorrect.", 401);
    }
    if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return jsonError("Email or password is incorrect.", 401);
    }

    await setSessionCookie(user.id);
    return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    return handleApiError(err);
  }
}
