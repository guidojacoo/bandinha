import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@h59/db";
import { withAuth, jsonError } from "@/lib/api";

const patchSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
  enabled: z.boolean().optional(),
  vibration: z.boolean().optional(),
  windowEndTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
});

export const PUT = withAuth(async (req, userId, ctx) => {
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request body");

  const existing = await prisma.alarm.findFirst({ where: { id, userId } });
  if (!existing) return jsonError(404, "Alarm not found");

  const alarm = await prisma.alarm.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ alarm });
});

export const DELETE = withAuth(async (_req, userId, ctx) => {
  const { id } = await ctx.params;
  const existing = await prisma.alarm.findFirst({ where: { id, userId } });
  if (!existing) return jsonError(404, "Alarm not found");

  await prisma.alarm.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});
