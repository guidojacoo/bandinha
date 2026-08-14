import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@h59/db";
import { withAuth, jsonError } from "@/lib/api";

export const GET = withAuth(async (_req, userId) => {
  const alarms = await prisma.alarm.findMany({ where: { userId }, orderBy: { time: "asc" } });
  return NextResponse.json({ alarms });
});

const alarmSchema = z.object({
  label: z.string().min(1).max(80),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "time must be HH:MM"),
  days: z.array(z.number().int().min(0).max(6)).min(1),
  enabled: z.boolean().default(true),
  vibration: z.boolean().default(true),
  deviceId: z.string().optional(),
  windowEndTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
});

export const POST = withAuth(async (req, userId) => {
  const parsed = alarmSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request body");
  const data = parsed.data;

  if (data.deviceId) {
    const device = await prisma.device.findFirst({ where: { id: data.deviceId, userId } });
    if (!device) return jsonError(404, "Device not found");
  }

  // nativeDeviceAlarm is always false at creation time — see
  // packages/protocol/src/experimental/alarm.ts. Promote this once a real
  // device command is confirmed; until then every alarm is phone-notification-based.
  const alarm = await prisma.alarm.create({
    data: { ...data, userId, nativeDeviceAlarm: false },
  });
  return NextResponse.json({ alarm }, { status: 201 });
});
