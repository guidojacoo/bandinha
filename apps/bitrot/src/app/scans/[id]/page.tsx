import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FindingRow, type FindingView } from "@/components/FindingRow";
import { GradeBadge, GradeDistribution, ScoreDial } from "@/components/Grade";
import { Nav } from "@/components/Nav";
import { getUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Signal } from "@/lib/rot";
import { scorePortfolio } from "@/lib/rot";

export const dynamic = "force-dynamic";

export default async function ScanDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId();
  if (!userId) redirect("/login");
  const { id } = await params;

  // Scoped by userId: another user's scan id is simply not found.
  const scan = await prisma.scan.findFirst({
    where: { id, userId },
    include: { findings: { orderBy: [{ rotScore: "desc" }, { packageName: "asc" }] } },
  });
  if (!scan) notFound();

  const acknowledgements = await prisma.acknowledgement.findMany({
    where: { userId, ecosystem: scan.ecosystem },
    select: { packageName: true },
  });
  const acknowledged = new Set(acknowledgements.map((a) => a.packageName));

  const findings: FindingView[] = scan.findings.map((f) => ({
    id: f.id,
    ecosystem: f.ecosystem,
    packageName: f.packageName,
    section: f.section,
    requestedRange: f.requestedRange,
    resolvedVersion: f.resolvedVersion,
    latestVersion: f.latestVersion,
    rotScore: f.rotScore,
    grade: f.grade,
    signals: (f.signals as unknown as Signal[] | null) ?? null,
    reasons: (f.reasons as unknown as string[] | null) ?? null,
    lastPublishAt: f.lastPublishAt?.toISOString() ?? null,
    maintainerCount: f.maintainerCount,
    releaseCount: f.releaseCount,
    deprecated: f.deprecated,
    license: f.license,
    repositoryUrl: f.repositoryUrl,
    lookupError: f.lookupError,
    acknowledged: acknowledged.has(f.packageName),
  }));

  // Recomputed live rather than read from the scan row, so acknowledging a
  // package updates the headline number without needing a re-scan.
  const portfolio = scorePortfolio({
    scores: findings.filter((f) => f.rotScore !== null && !f.acknowledged).map((f) => f.rotScore as number),
    acknowledgedCount: findings.filter((f) => f.acknowledged).length,
    unresolvedCount: findings.filter((f) => f.lookupError).length,
  });

  const actionable = findings.filter((f) => !f.acknowledged && f.rotScore !== null && f.rotScore >= 60);

  return (
    <>
      <Nav />
      <main className="container" style={{ padding: "32px 24px 88px" }}>
        <Link href="/dashboard" className="tiny faint nav-link" style={{ padding: 0 }}>
          ← Dashboard
        </Link>

        <div className="card" style={{ marginTop: 14 }}>
          <div className="row" style={{ gap: 30, alignItems: "center", flexWrap: "wrap" }}>
            <ScoreDial score={portfolio.score} grade={portfolio.grade} />

            <div className="stack" style={{ gap: 12, flex: "1 1 320px", minWidth: 0 }}>
              <div>
                <div className="row" style={{ gap: 10 }}>
                  <GradeBadge grade={portfolio.grade} />
                  <h1 className="mono truncate" style={{ fontSize: 18 }}>
                    {scan.label}
                  </h1>
                </div>
                <p className="small muted" style={{ marginTop: 6 }}>
                  {portfolio.verdict} · {scan.resolvedPackages} of {scan.totalPackages} dependencies
                  resolved from {scan.ecosystem === "npm" ? "npm" : "PyPI"} ·{" "}
                  {scan.createdAt.toISOString().slice(0, 10)}
                </p>
              </div>

              <GradeDistribution counts={portfolio.counts} />

              {(portfolio.acknowledgedCount > 0 || portfolio.unresolvedCount > 0) && (
                <div className="row" style={{ gap: 7, flexWrap: "wrap" }}>
                  {portfolio.acknowledgedCount > 0 && (
                    <span className="badge">
                      {portfolio.acknowledgedCount} acknowledged · excluded from score
                    </span>
                  )}
                  {portfolio.unresolvedCount > 0 && (
                    <span className="badge" data-tone="warn">
                      {portfolio.unresolvedCount} unresolved
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {actionable.length > 0 && (
            <div className="alert" data-tone="warn" style={{ marginTop: 22 }}>
              <strong>Deal with these first:</strong>{" "}
              <span className="mono">
                {actionable.slice(0, 5).map((f) => f.packageName).join(", ")}
              </span>
              {actionable.length > 5 && ` and ${actionable.length - 5} more`}.
            </div>
          )}
        </div>

        {scan.status === "failed" && (
          <div className="alert" data-tone="error" style={{ marginTop: 20 }} role="alert">
            This scan failed: {scan.error ?? "unknown error"}
          </div>
        )}

        <div className="spread" style={{ margin: "34px 0 14px" }}>
          <h2 style={{ fontSize: 16 }}>
            Findings <span className="faint tnum">({findings.length})</span>
          </h2>
          <span className="tiny faint">Worst first · click any row for the breakdown</span>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          {findings.map((finding) => (
            <FindingRow key={finding.id} finding={finding} />
          ))}
        </div>

        <div className="card card-tight" style={{ marginTop: 28, maxWidth: 700 }}>
          <p className="tiny faint" style={{ lineHeight: 1.6 }}>
            Scores come from public registry metadata read at scan time. A high score means
            lifecycle risk, not that a package is bad — check the reasoning on each finding and
            acknowledge anything that is a deliberate choice. Bands:{" "}
            <span className="mono">0–19 A Healthy</span>, <span className="mono">20–39 B Watch</span>,{" "}
            <span className="mono">40–59 C Aging</span>, <span className="mono">60–79 D At risk</span>,{" "}
            <span className="mono">80–100 F Critical</span>.
          </p>
        </div>
      </main>
    </>
  );
}
