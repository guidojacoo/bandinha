import { PrismaClient } from "@/generated/prisma";

// Next's dev server re-evaluates modules on every change; without this the
// process accumulates a new pool per reload until Postgres refuses connections.
const globalForPrisma = globalThis as unknown as { bitrotPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.bitrotPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.bitrotPrisma = prisma;
