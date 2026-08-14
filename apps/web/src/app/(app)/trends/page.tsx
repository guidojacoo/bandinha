import Link from "next/link";
import { prisma } from "@h59/db";
import { requireSessionUser } from "@/lib/authServer";
import { TrendChart, type TrendPoint } from "@/components/TrendChart";
import type { HealthMetric } from "@h59/db";

const METRICS: { key: HealthMetric | "sleep_score"; label: string; unit?: string }[] = [
  { key: "sleep_score", label: "Sleep Score" },
  { key: "heart_rate", label: "Heart rate", unit: "bpm" },
  { key: "hrv", label: "HRV", unit: "ms" },
  { key: "spo2", label: "SpO2", unit: "%" },
  { key: "stress", label: "Stress", unit: "/100" },
  { key: "steps", label: "Steps" },
];

const RANGES = [
  { key: "7d", label: "Week", days: 7 },
  { key: "30d", label: "Month", days: 30 },
  { key: "90d", label: "3 months", days: 90 },
  { key: "180d", label: "6 months", days: 180 },
  { key: "365d", label: "1 year", days: 365 },
] as const;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<{ metric?: string; range?: string }>;
}) {
  const user = await requireSessionUser();
  const { metric: metricParam, range: rangeParam } = await searchParams;

  const metric = METRICS.find((m) => m.key === metricParam) ?? METRICS[0]!;
  const range = RANGES.find((r) => r.key === rangeParam) ?? RANGES[0];

  const since = new Date(Date.now() - range.days * 86400_000);
  const byDay = new Map<string, number[]>();

  if (metric.key === "sleep_score") {
    const sessions = await prisma.sleepSession.findMany({
      where: { userId: user.id, date: { gte: dayKey(since) } },
      select: { date: true, sleepScore: true },
    });
    for (const s of sessions) {
      if (s.sleepScore == null) continue;
      byDay.set(s.date, [...(byDay.get(s.date) ?? []), s.sleepScore]);
    }
  } else {
    const samples = await prisma.healthSample.findMany({
      where: { userId: user.id, metric: metric.key, ts: { gte: since } },
      select: { ts: true, value: true },
    });
    for (const s of samples) {
      const d = dayKey(s.ts);
      byDay.set(d, [...(byDay.get(d) ?? []), s.value]);
    }
  }

  const data: TrendPoint[] = [];
  for (let i = range.days - 1; i >= 0; i--) {
    const d = dayKey(new Date(Date.now() - i * 86400_000));
    const values = byDay.get(d);
    const agg = values?.length
      ? metric.key === "steps"
        ? values.reduce((a, b) => a + b, 0) // total for the day
        : values.reduce((a, b) => a + b, 0) / values.length // average for the day
      : null;
    data.push({ date: d.slice(5), value: agg != null ? Math.round(agg * 10) / 10 : null });
  }

  const query = (overrides: Record<string, string>) => {
    const params = new URLSearchParams({ metric: metric.key, range: range.key, ...overrides });
    return `/trends?${params.toString()}`;
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <h1 style={{ margin: 0, fontSize: 24 }}>Trends</h1>

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {METRICS.map((m) => (
          <Link
            key={m.key}
            href={query({ metric: m.key })}
            className="pill"
            style={{
              background: m.key === metric.key ? "var(--accent)" : "var(--bg-inset)",
              color: m.key === metric.key ? "var(--accent-contrast)" : "var(--text-muted)",
              textDecoration: "none",
              padding: "8px 14px",
            }}
          >
            {m.label}
          </Link>
        ))}
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontWeight: 700 }}>
            {metric.label} {metric.unit && <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>({metric.unit})</span>}
          </span>
          <div className="row" style={{ gap: 4 }}>
            {RANGES.map((r) => (
              <Link
                key={r.key}
                href={query({ range: r.key })}
                style={{
                  fontSize: 12,
                  padding: "5px 10px",
                  borderRadius: 8,
                  textDecoration: "none",
                  fontWeight: 600,
                  color: r.key === range.key ? "var(--accent)" : "var(--text-muted)",
                  background: r.key === range.key ? "var(--accent-soft)" : "transparent",
                }}
              >
                {r.label}
              </Link>
            ))}
          </div>
        </div>
        {data.every((d) => d.value === null) ? (
          <div style={{ padding: "60px 0", textAlign: "center", color: "var(--text-muted)" }}>
            No {metric.label.toLowerCase()} data in this range yet.
          </div>
        ) : (
          <TrendChart data={data} unit={metric.unit} />
        )}
      </div>
    </div>
  );
}
