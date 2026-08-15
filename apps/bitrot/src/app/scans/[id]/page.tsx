import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FindingRow, type FindingView } from "@/components/FindingRow";
import { GradeBadge, ScoreDial } from "@/components/Grade";
import { Nav } from "@/components/Nav";
import { getUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Signal } from "@/lib/rot";
import { gradeFor, scorePortfolio } from "@/lib/rot";

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
    scores: findings
      .filter((f) => f.rotScore !== null && !f.acknowledged)
      .map((f) => f.rotScore as number),
    acknowledgedCount: findings.filter((f) => f.acknowledged).length,
    unresolvedCount: findings.filter((f) => f.lookupError).length,
  });

  const actionable = findings.filter(
    (f) => !f.acknowledged && f.rotScore !== null && f.rotScore >= 60,
  );

  return (
    <>
      <Nav />
      <main className="container" style={{ padding: "40px 24px 80px" }}>
        <Link href="/dashboard" className="tiny faint">
          ← Dashboard
        </Link>

        <div className="card" style={{ marginTop: 16 }}>
          <div className="row" style={{ gap: 28, alignItems: "center", flexWrap: "wrap" }}>
            <ScoreDial score={portfolio.score} grade={portfolio.grade} />

            <div className="stack" style={{ gap: 10, flex: "1 1 300px", minWidth: 0 }}>
              <div className="row" style={{ gap: 10 }}>
                <GradeBadge grade={portfolio.grade} />
                <h1 className="mono truncate" style={{ fontSize: 19 }}>
                  {scan.label}
                </h1>
              </div>
              <p className="small muted" style={{ margin: 0 }}>
                {portfolio.verdict} · {scan.resolvedPackages} of {scan.totalPackages} dependencies
                resolved from {scan.ecosystem === "npm" ? "npm" : "PyPI"} ·{" "}
                {scan.createdAt.toISOString().slice(0, 10)}
              </p>

              <div className="row" style={{ gap: 7, flexWrap: "wrap", marginTop: 2 }}>
                {(["F", "D", "C", "B", "A"] as const).map((grade) =>
                  portfolio.counts[grade] > 0 ? (
                    <span key={grade} className="row" style={{ gap: 6 }}>
                      <GradeBadge grade={grade} />
                      <span className="small muted">{portfolio.counts[grade]}</span>
                    </span>
                  ) : null,
                )}
                {portfolio.acknowledgedCount > 0 && (
                  <span className="badge">{portfolio.acknowledgedCount} acknowledged</span>
                )}
                {portfolio.unresolvedCount > 0 && (
                  <span className="badge" data-tone="warn">
                    {portfolio.unresolvedCount} unresolved
                  </span>
                )}
              </div>
            </div>
          </div>

          {actionable.length > 0 && (
            <div className="alert" data-tone="warn" style={{ marginTop: 20 }}>
              <strong>Deal with these first:</strong>{" "}
              {actionable
                .slice(0, 5)
                .map((f) => f.packageName)
                .join(", ")}
              {actionable.length > 5 && ` and ${actionable.length - 5} more`}.
            </div>
          )}
        </div>

        {scan.status === "failed" && (
          <div className="alert" data-tone="error" style={{ marginTop: 20 }}>
            This scan failed: {scan.error ?? "unknown error"}
          </div>
        )}

        <h2 style={{ fontSize: 17, margin: "32px 0 14px" }}>
          Findings <span className="faint">({findings.length})</span>
        </h2>

        <div className="stack" style={{ gap: 9 }}>
          {findings.map((finding) => (
            <FindingRow key={finding.id} finding={finding} />
          ))}
        </div>

        <p className="tiny faint" style={{ marginTop: 26, maxWidth: 620 }}>
          Scores are computed from public registry metadata at scan time. A high score means
          lifecycle risk, not that a package is bad — see the reasoning on each finding, and
          acknowledge anything that is a deliberate choice. Grade bands:{" "}
          {["A", "B", "C", "D", "F"].map((g, i) => (
            <span key={g}>
              {i > 0 && ", "}
              {g} {bandLabel(g)}
            </span>
          ))}
          .
        </p>
      </main>
    </>
  );
}

function bandLabel(grade: string): string {
  const midpoints: Record<string, number> = { A: 10, B: 30, C: 50, D: 70, F: 90 };
  return `(${gradeFor(midpoints[grade] ?? 0).verdict})`;
}
