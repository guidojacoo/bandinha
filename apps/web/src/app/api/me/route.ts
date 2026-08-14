import { NextResponse } from "next/server";
import { prisma } from "@h59/db";
import { withAuth } from "@/lib/api";

export const GET = withAuth(async (_req, userId) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true, timezone: true, createdAt: true },
  });
  return NextResponse.json({ user });
});
