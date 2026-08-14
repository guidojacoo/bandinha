import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@h59/db";
import { withAuth } from "@/lib/api";

export const GET = withAuth(async (_req, userId, ctx) => {
  const { id } = await ctx.params;
  const device = await prisma.device.findFirst({ where: { id, userId } });
  if (!device) return NextResponse.json({ error: "Device not found" }, { status: 404 });
  return NextResponse.json({ device });
});

const patchSchema = z.object({ name: z.string().min(1).optional() });

export const PATCH = withAuth(async (req, userId, ctx) => {
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  const existing = await prisma.device.findFirst({ where: { id, userId } });
  if (!existing) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  const device = await prisma.device.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ device });
});

export const DELETE = withAuth(async (_req, userId, ctx) => {
  const { id } = await ctx.params;
  const existing = await prisma.device.findFirst({ where: { id, userId } });
  if (!existing) return NextResponse.json({ error: "Device not found" }, { status: 404 });

  await prisma.device.delete({ where: { id } }); // cascades health samples / sleep sessions / alarms
  return NextResponse.json({ ok: true });
});
