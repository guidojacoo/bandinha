import Link from "next/link";
import { prisma } from "@h59/db";
import { requireSessionUser } from "@/lib/authServer";
import { SleepTimeline } from "@/components/SleepTimeline";
import { StatTile } from "@/components/StatTile";
import { ScoreRing } from "@/components/ScoreRing";

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export default async function SleepPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await requireSessionUser();
  const { date: requestedDate } = await searchParams;

  const recentSessions = await prisma.sleepSession.findMany({
    where: { userId: user.id },
    orderBy: { date: "desc" },
    take: 21,
  });

  if (recentSessions.length === 0) {
    return (
      <div className="card stack" style={{ padding: 40, alignItems: "center", textAlign: "center", gap: 8, marginTop: 40 }}>
        <span style={{ fontSize: 40 }}>☾</span>
        <h2 style={{ margin: 0 }}>No sleep data yet</h2>
        <p style={{ color: "var(--text-muted)" }}>Wear the band overnight, then sync from the mobile app.</p>
      </div>
    );
  }

  const active = recentSessions.find((s) => s.date === requestedDate) ?? recentSessions[0]!;
  const stages = await prisma.sleepStageSegment.findMany({
    where: { sleepSessionId: active.id },
    orderBy: { startAt: "asc" },
  });

  const totals = { light: 0, deep: 0, rem: 0, awake: 0 } as Record<string, number>;
  for (const s of stages) totals[s.stage] = (totals[s.stage] ?? 0) + s.durationMin;

  const last7 = recentSessions.slice(0, 7);
  const last30 = recentSessions;
  const avgMinutes = (list: typeof recentSessions) =>
    list.length ? Math.round(list.reduce((s, x) => s + x.totalMinutes, 0) / list.length) : 0;
  const avgScore = (list: typeof recentSessions) => {
    const withScore = list.filter((x) => x.sleepScore != null);
    return withScore.length ? Math.round(withScore.reduce((s, x) => s + (x.sleepScore ?? 0), 0) / withScore.length) : null;
  };

  return (
    <div className="stack" style={{ gap: 24 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Sleep</h1>

      <div className="card" style={{ padding: 24 }}>
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 20 }}>
          <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
            <ScoreRing score={active.sleepScore ?? 0} label="Sleep Score" size={110} />
            <div className="stack" style={{ gap: 4, justifyContent: "center" }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{fmtDate(active.date)}</span>
              <span style={{ fontSize: 22, fontWeight: 700 }}>
                {Math.floor(active.totalMinutes / 60)}h {active.totalMinutes % 60}m
              </span>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {fmtTime(active.startAt)} → {fmtTime(active.endAt)}
              </span>
            </div>
          </div>
          <span className={`pill ${active.source === "device_history" || active.source === "device_realtime" ? "pill-good" : "pill-muted"}`}>
            {active.source === "device_history" || active.source === "device_realtime" ? "From device" : active.source}
          </span>
        </div>

        <div style={{ marginTop: 24 }}>
          <SleepTimeline segments={stages} startAt={active.startAt} endAt={active.endAt} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 12, marginTop: 20 }}>
          <StatTile label="Deep" value={totals.deep ?? 0} unit="min" />
          <StatTile label="REM" value={totals.rem ?? 0} unit="min" />
          <StatTile label="Light" value={totals.light ?? 0} unit="min" />
          <StatTile label="Awake" value={totals.awake ?? 0} unit="min" />
        </div>
      </div>

      <div className="stack" style={{ gap: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0, color: "var(--text-muted)" }}>Averages</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
          <StatTile label="7-day avg duration" value={(avgMinutes(last7) / 60).toFixed(1)} unit="h" />
          <StatTile label="7-day avg score" value={avgScore(last7) ?? "–"} />
          <StatTile label="30-day avg duration" value={(avgMinutes(last30) / 60).toFixed(1)} unit="h" />
          <StatTile label="30-day avg score" value={avgScore(last30) ?? "–"} />
        </div>
      </div>

      <div className="stack" style={{ gap: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0, color: "var(--text-muted)" }}>Recent nights</h2>
        <div className="card stack" style={{ padding: 4 }}>
          {recentSessions.map((s) => (
            <Link
              key={s.id}
              href={`/sleep?date=${s.date}`}
              className="row"
              style={{
                justifyContent: "space-between",
                padding: "12px 16px",
                borderRadius: 12,
                textDecoration: "none",
                color: "var(--text)",
                background: s.id === active.id ? "var(--accent-soft)" : "transparent",
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600 }}>{fmtDate(s.date)}</span>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {Math.floor(s.totalMinutes / 60)}h {s.totalMinutes % 60}m
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: (s.sleepScore ?? 0) >= 75 ? "var(--good)" : (s.sleepScore ?? 0) >= 50 ? "var(--warn)" : "var(--bad)" }}>
                {s.sleepScore ?? "–"}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
