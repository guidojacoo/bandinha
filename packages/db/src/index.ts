import { PrismaClient } from "@prisma/client";

/**
 * Singleton PrismaClient. In Next.js dev mode, modules get re-evaluated on
 * every hot reload; without caching the instance on `globalThis` each reload
 * would open a fresh pool of Postgres connections until they're exhausted.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "@prisma/client";
