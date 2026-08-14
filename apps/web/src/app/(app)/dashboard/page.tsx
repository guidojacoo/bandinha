import Link from "next/link";
import { prisma } from "@h59/db";
import { requireSessionUser } from "@/lib/authServer";
import { getOrComputeRecovery, dateStr } from "@/lib/recovery";
import { ScoreRing } from "@/components/ScoreRing";
import { StatTile } from "@/components/StatTile";

function timeAgo(date: Date | null): string {
  if (!date) return "Never";
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function DashboardPage() {
  const user = await requireSessionUser();
  const today = dateStr(new Date());
  const dayStart = new Date(`${today}T00:00:00.000Z`);

  const [device, sleepSession, latestByMetric, todayStepsAgg, todayCaloriesAgg] = await Promise.all([
    prisma.device.findFirst({ where: { userId: user.id }, orderBy: { lastSyncAt: "desc" } }),
    prisma.sleepSession.findFirst({ where: { userId: user.id, date: today } }),
    Promise.all(
      (["heart_rate", "hrv", "spo2", "stress"] as const).map((metric) =>
        prisma.healthSample.findFirst({ where: { userId: user.id, metric }, orderBy: { ts: "desc" } }),
      ),
    ),
    prisma.healthSample.aggregate({
      where: { userId: user.id, metric: "steps", ts: { gte: dayStart } },
      _sum: { value: true },
    }),
    prisma.healthSample.aggregate({
      where: { userId: user.id, metric: "calories", ts: { gte: dayStart } },
      _sum: { value: true },
    }),
  ]);
  const [heartRate, hrv, spo2, stress] = latestByMetric;
  const recovery = await getOrComputeRecovery(user.id, today);

  if (!device) {
    return (
      <div className="card stack" style={{ padding: 40, alignItems: "center", textAlign: "center", gap: 12, marginTop: 40 }}>
        <span style={{ fontSize: 40 }}>📶</span>
        <h2 style={{ margin: 0 }}>No device connected yet</h2>
        <p style={{ color: "var(--text-muted)", maxWidth: 420 }}>
          Pairing and syncing happens from the H59 Health mobile app — Bluetooth only works from your
          phone, not from this web dashboard. Install the mobile app, pair your H59, sync once, and this
          page will fill in automatically.
        </p>
        <Link href="/devices" className="btn btn-primary">View device setup instructions</Link>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 24 }}>
      <div>
        <h1 style={{ margin: "0 0 2px", fontSize: 24 }}>Hi {user.name?.split(" ")[0] ?? "there"} 👋</h1>
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 14 }}>
          {device.name} · synced {timeAgo(device.lastSyncAt)}
        </p>
      </div>

      <div className="card row" style={{ padding: 24, gap: 40, flexWrap: "wrap", justifyContent: "center" }}>
        <ScoreRing score={sleepSession?.sleepScore ?? 0} label="Sleep Score" />
        <ScoreRing score={recovery.available ? recovery.recovery.score : 0} label="Recovery Score" />
        {recovery.available && recovery.recovery.comparedToWeeklyAvgPct != null && (
          <div className="stack" style={{ justifyContent: "center", gap: 4, maxWidth: 220 }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Your recovery is{" "}
              <strong style={{ color: recovery.recovery.comparedToWeeklyAvgPct >= 0 ? "var(--good)" : "var(--bad)" }}>
                {recovery.recovery.comparedToWeeklyAvgPct >= 0 ? "+" : ""}
                {recovery.recovery.comparedToWeeklyAvgPct}%
              </strong>{" "}
              vs. your weekly average.
            </span>
          </div>
        )}
        {!recovery.available && (
          <p style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 240 }}>{recovery.reason}</p>
        )}
      </div>

      <div className="stack" style={{ gap: 10 }}>
        <h2 style={{ fontSize: 15, margin: 0, color: "var(--text-muted)" }}>Today</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
          <StatTile
            icon="☾"
            label="Hours slept"
            value={sleepSession ? (sleepSession.totalMinutes / 60).toFixed(1) : "–"}
            unit="h"
          />
          <StatTile icon="♥" label="Heart rate" value={heartRate?.value ?? "–"} unit="bpm" />
          <StatTile icon="≈" label="HRV" value={hrv?.value ?? "–"} unit="ms" />
          <StatTile icon="◯" label="SpO2" value={spo2?.value ?? "–"} unit="%" />
          <StatTile icon="⚡" label="Stress" value={stress?.value ?? "–"} unit="/100" />
          <StatTile icon="👟" label="Steps" value={Math.round(todayStepsAgg._sum.value ?? 0)} />
          <StatTile icon="🔥" label="Calories" value={Math.round(todayCaloriesAgg._sum.value ?? 0)} unit="kcal" />
          <StatTile
            icon="🔋"
            label="Battery"
            value={device.batteryLevel ?? "–"}
            unit={device.batteryLevel != null ? "%" : undefined}
            hint={device.batteryCharging ? "Charging" : undefined}
          />
        </div>
      </div>
    </div>
  );
}
