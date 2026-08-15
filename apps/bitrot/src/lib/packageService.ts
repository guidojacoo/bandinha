import type { Prisma } from "@/generated/prisma";
import { prisma } from "./db";
import { cacheTtlMs } from "./env";
import { canonicalName, fetchPackage, RegistryError, type Ecosystem, type RegistryPackage } from "./registry";

export interface PackageLookup {
  ok: true;
  pkg: RegistryPackage;
  /** True when served from the shared registry cache rather than a live call. */
  cached: boolean;
}

export interface PackageLookupFailure {
  ok: false;
  error: string;
  kind: RegistryError["kind"] | "unknown";
}

export type PackageResult = PackageLookup | PackageLookupFailure;

/**
 * Reads one package's registry metadata, preferring the shared cache.
 *
 * The cache is what makes a repeat scan cheap: registry metadata changes on
 * the order of days, and a 200-dependency lockfile otherwise means 200 live
 * requests every single time.
 */
export async function getPackage(
  ecosystem: Ecosystem,
  rawName: string,
  options: { forceRefresh?: boolean } = {},
): Promise<PackageResult> {
  const name = canonicalName(ecosystem, rawName);

  if (!options.forceRefresh) {
    try {
      const cached = await prisma.packageRecord.findUnique({
        where: { ecosystem_name: { ecosystem, name } },
      });
      if (cached && Date.now() - cached.fetchedAt.getTime() < cacheTtlMs()) {
        return { ok: true, pkg: cached.payload as unknown as RegistryPackage, cached: true };
      }
    } catch {
      // A cache read failure must not fail the scan — fall through to the live
      // registry and let the write below try again.
    }
  }

  let pkg: RegistryPackage;
  try {
    pkg = await fetchPackage(ecosystem, name);
  } catch (err) {
    if (err instanceof RegistryError) return { ok: false, error: err.message, kind: err.kind };
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      kind: "unknown",
    };
  }

  try {
    const payload = pkg as unknown as Prisma.InputJsonValue;
    await prisma.packageRecord.upsert({
      where: { ecosystem_name: { ecosystem, name } },
      create: { ecosystem, name, payload, fetchedAt: new Date() },
      update: { payload, fetchedAt: new Date() },
    });
  } catch {
    // Caching is an optimisation; a failed write should not fail the lookup.
  }

  return { ok: true, pkg, cached: false };
}
