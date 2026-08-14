import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@h59/db";
import { withAuth } from "@/lib/api";

export const GET = withAuth(async (_req, userId) => {
  const devices = await prisma.device.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ devices });
});

const registerSchema = z.object({
  bleId: z.string().min(1),
  name: z.string().min(1),
  firmwareVersion: z.string().optional(),
  hardwareVersion: z.string().optional(),
  capabilities: z
    .object({
      temperature: z.boolean(),
      spo2: z.boolean(),
      bloodPressure: z.boolean(),
      stress: z.boolean(),
      hrv: z.boolean(),
      sleep: z.boolean(),
    })
    .optional(),
  hasVibrationMotor: z.boolean().nullable().optional(),
});

/** Called once by the mobile app right after a successful pairing handshake. */
export const POST = withAuth(async (req, userId) => {
  const parsed = registerSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  const data = parsed.data;

  const device = await prisma.device.upsert({
    where: { userId_bleId: { userId, bleId: data.bleId } },
    update: {
      name: data.name,
      firmwareVersion: data.firmwareVersion,
      hardwareVersion: data.hardwareVersion,
      capabilities: data.capabilities,
      hasVibrationMotor: data.hasVibrationMotor ?? undefined,
      lastSeenAt: new Date(),
    },
    create: {
      userId,
      bleId: data.bleId,
      name: data.name,
      firmwareVersion: data.firmwareVersion,
      hardwareVersion: data.hardwareVersion,
      capabilities: data.capabilities,
      hasVibrationMotor: data.hasVibrationMotor ?? null,
      lastSeenAt: new Date(),
    },
  });
  return NextResponse.json({ device }, { status: 201 });
});
