import Link from "next/link";
import { redirect } from "next/navigation";
import { GradeBadge, ScoreDial } from "@/components/Grade";
import { Nav } from "@/components/Nav";
import { getUserId } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import type { Grade } from "@/lib/rot";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const userId = await getUserId();
  if (!userId) redirect("/login");

  const [scans, acknowledgements] = await Promise.all([
    prisma.scan.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 25 }),
    prisma.acknowledgement.count({ where: { userId } }),
  ]);

  const latest = scans.find((s) => s.status === "complete" && s.portfolioScore !== null);

  return (
    <>
      <Nav />
      <main className="container" style={{ padding: "44px 24px 88px" }}>
        <div className="spread" style={{ marginBottom: 26 }}>
          <div>
            <h1 style={{ fontSize: 27 }}>Dashboard</h1>
            <p className="muted small" style={{ marginTop: 6 }}>
              {scans.length === 0
                ? "No scans yet."
                : `${scans.length} scan${scans.length === 1 ? "" : "s"}${
                    acknowledgements > 0
                      ? ` · ${acknowledgements} acknowledged package${acknowledgements === 1 ? "" : "s"}`
                      : ""
                  }`}
            </p>
          </div>
          <Link href="/scan" className="btn">
            New scan
          </Link>
        </div>

        {scans.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="stack" style={{ gap: 24 }}>
            {latest && (
              <Link href={`/scans/${latest.id}`} className="card card-hover" style={{ display: "block" }}>
                <div className="row" style={{ gap: 26, alignItems: "center", flexWrap: "wrap" }}>
                  <ScoreDial score={latest.portfolioScore ?? 0} grade={(latest.grade ?? "A") as Grade} />

                  <div className="stack" style={{ gap: 8, flex: "1 1 260px", minWidth: 0 }}>
                    <span className="eyebrow">Most recent scan</span>
                    <div className="row" style={{ gap: 10 }}>
                      <GradeBadge grade={(latest.grade ?? "A") as Grade} />
                      <span className="mono truncate" style={{ fontWeight: 600 }}>
                        {latest.label}
                      </span>
                    </div>
                    <p className="small muted" style={{ margin: 0 }}>
                      {latest.resolvedPackages} of {latest.totalPackages} dependencies resolved from{" "}
                      {latest.ecosystem === "npm" ? "npm" : "PyPI"} ·{" "}
                      {latest.createdAt.toISOString().slice(0, 10)}
                    </p>
                    <span className="link small">View findings →</span>
                  </div>
                </div>
              </Link>
            )}

            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ paddingLeft: 22 }}>Scan</th>
                      <th>Registry</th>
                      <th>Dependencies</th>
                      <th>Rot</th>
                      <th style={{ paddingRight: 22 }}>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map((scan) => (
                      <tr key={scan.id}>
                        <td style={{ paddingLeft: 22, maxWidth: 300 }}>
                          <Link
                            href={`/scans/${scan.id}`}
                            className="mono small truncate"
                            style={{ display: "block", fontWeight: 550 }}
                          >
                            {scan.label}
                          </Link>
                          {scan.status !== "complete" && (
                            <span
                              className="badge"
                              data-tone={scan.status === "failed" ? "danger" : undefined}
                              style={{ marginTop: 6 }}
                            >
                              {scan.status}
                            </span>
                          )}
                        </td>
                        <td className="small muted">{scan.ecosystem === "npm" ? "npm" : "PyPI"}</td>
                        <td className="small muted tnum">
                          {scan.resolvedPackages}/{scan.totalPackages}
                        </td>
                        <td>
                          {scan.portfolioScore !== null && scan.grade ? (
                            <span className="row" style={{ gap: 9 }}>
                              <GradeBadge grade={scan.grade as Grade} />
                              <span className="mono small tnum">{scan.portfolioScore}</span>
                            </span>
                          ) : (
                            <span className="faint small">—</span>
                          )}
                        </td>
                        <td className="small muted tnum" style={{ paddingRight: 22, whiteSpace: "nowrap" }}>
                          {scan.createdAt.toISOString().slice(0, 10)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

function EmptyState() {
  return (
    <div className="card" style={{ textAlign: "center", padding: "58px 26px" }}>
      <h2 style={{ fontSize: 20 }}>Run your first scan</h2>
      <p className="muted" style={{ maxWidth: 430, margin: "12px auto 0" }}>
        Paste a <code className="mono">package.json</code>,{" "}
        <code className="mono">package-lock.json</code> or{" "}
        <code className="mono">requirements.txt</code>. A sample manifest is one click away if you
        just want to see what it does.
      </p>
      <div className="row" style={{ justifyContent: "center", marginTop: 24 }}>
        <Link href="/scan" className="btn">
          New scan
        </Link>
      </div>
    </div>
  );
}
