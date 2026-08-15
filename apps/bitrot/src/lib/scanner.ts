import type { Prisma } from "@/generated/prisma";
import { prisma } from "./db";
import { getPackage } from "./packageService";
import type { ParsedManifest } from "./parse";
import { mapWithConcurrency } from "./registry";
import { scoreOne, scorePortfolio } from "./rot";

/**
 * Live registry requests in flight at once.
 *
 * High enough that a 200-package lockfile finishes in seconds, low enough to
 * stay a polite client of a free public registry.
 */
const REGISTRY_CONCURRENCY = 10;

export interface RunScanArgs {
  userId: string;
  label: string;
  manifest: ParsedManifest;
}

/**
 * Resolves every dependency in a parsed manifest against the registries,
 * scores each one, and persists the scan with its findings.
 *
 * A dependency that cannot be resolved is recorded with its error rather than
 * dropped — a package that vanished from the registry is a finding, not a gap.
 */
export async function runScan({ userId, label, manifest }: RunScanArgs): Promise<string> {
  const scan = await prisma.scan.create({
    data: {
      userId,
      label,
      ecosystem: manifest.ecosystem,
      status: "running",
      totalPackages: manifest.dependencies.length,
    },
  });

  try {
    const now = new Date();
    const acknowledged = await prisma.acknowledgement.findMany({
      where: { userId, ecosystem: manifest.ecosystem },
      select: { packageName: true },
    });
    const acknowledgedNames = new Set(acknowledged.map((a) => a.packageName));

    const rows = await mapWithConcurrency(
      manifest.dependencies,
      REGISTRY_CONCURRENCY,
      async (dep): Promise<Prisma.FindingCreateManyInput> => {
        const result = await getPackage(manifest.ecosystem, dep.name);

        if (!result.ok) {
          return {
            scanId: scan.id,
            ecosystem: manifest.ecosystem,
            packageName: dep.name,
            section: dep.section,
            requestedRange: dep.range,
            resolvedVersion: dep.resolvedVersion,
            lookupError: result.error,
          };
        }

        const { pkg } = result;
        const rot = scoreOne({
          pkg,
          requestedRange: dep.range,
          resolvedVersion: dep.resolvedVersion,
          now,
        });

        return {
          scanId: scan.id,
          ecosystem: manifest.ecosystem,
          packageName: pkg.name,
          section: dep.section,
          requestedRange: dep.range,
          resolvedVersion: dep.resolvedVersion,
          latestVersion: pkg.latestVersion,
          rotScore: rot.score,
          grade: rot.grade,
          signals: rot.signals as unknown as Prisma.InputJsonValue,
          reasons: rot.reasons as unknown as Prisma.InputJsonValue,
          lastPublishAt: pkg.lastPublishAt ? new Date(pkg.lastPublishAt) : null,
          firstPublishAt: pkg.firstPublishAt ? new Date(pkg.firstPublishAt) : null,
          maintainerCount: pkg.maintainerCount,
          releaseCount: pkg.releaseCount,
          deprecated: pkg.deprecated,
          deprecationNote: pkg.deprecationNote,
          license: pkg.license,
          repositoryUrl: pkg.repositoryUrl,
        };
      },
    );

    await prisma.finding.createMany({ data: rows });

    // Packages the user has explicitly accepted are left out of the headline
    // number — otherwise the score can never be acted on down to green.
    const scored = rows.filter(
      (r) => typeof r.rotScore === "number" && !acknowledgedNames.has(r.packageName),
    );
    const portfolio = scorePortfolio({
      scores: scored.map((r) => r.rotScore as number),
      acknowledgedCount: rows.filter((r) => acknowledgedNames.has(r.packageName)).length,
      unresolvedCount: rows.filter((r) => r.lookupError).length,
    });

    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: "complete",
        completedAt: new Date(),
        resolvedPackages: rows.filter((r) => !r.lookupError).length,
        portfolioScore: portfolio.score,
        grade: portfolio.grade,
      },
    });

    return scan.id;
  } catch (err) {
    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}
