import { PrismaClient } from "@/generated/prisma";

// Next's dev server re-evaluates modules on every change; without this the
// process accumulates a pool per reload until Postgres refuses connections.
const globalForPrisma = globalThis as unknown as { rainmakerPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.rainmakerPrisma ??
  new PrismaClient({ log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.rainmakerPrisma = prisma;

/** Appends to the campaign's audit log. Never throws into the caller. */
export async function logEvent(
  campaignId: string,
  kind: string,
  message: string,
  data?: unknown,
  level: "info" | "warn" | "error" = "info",
): Promise<void> {
  try {
    await prisma.event.create({
      data: {
        campaignId,
        kind,
        level,
        message,
        data: data === undefined ? undefined : (JSON.parse(JSON.stringify(data)) as object),
      },
    });
  } catch {
    // The audit log must never be the reason a tick fails.
  }
}
