interface Segment {
  stage: "light" | "deep" | "rem" | "awake";
  startAt: string | Date;
  durationMin: number;
}

const STAGE_ORDER = ["awake", "rem", "light", "deep"] as const;
const STAGE_LABEL: Record<(typeof STAGE_ORDER)[number], string> = {
  awake: "Awake",
  rem: "REM",
  light: "Light",
  deep: "Deep",
};
const STAGE_COLOR: Record<(typeof STAGE_ORDER)[number], string> = {
  awake: "var(--stage-awake)",
  rem: "var(--stage-rem)",
  light: "var(--stage-light)",
  deep: "var(--stage-deep)",
};

/** Hypnogram-style stacked timeline: one row per stage, segments placed by real elapsed time. */
export function SleepTimeline({ segments, startAt, endAt }: { segments: Segment[]; startAt: string | Date; endAt: string | Date }) {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  const totalMs = Math.max(1, end - start);
  const width = 800;
  const rowHeight = 34;
  const gap = 6;
  const height = STAGE_ORDER.length * rowHeight + (STAGE_ORDER.length - 1) * gap;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${width} ${height + 24}`} width="100%" style={{ minWidth: 480 }} role="img" aria-label="Sleep stage timeline">
        {STAGE_ORDER.map((stage, rowIndex) => {
          const y = rowIndex * (rowHeight + gap);
          return (
            <g key={stage}>
              <rect x={0} y={y} width={width} height={rowHeight} rx={8} fill="var(--bg-inset)" />
              <text x={-4} y={y + rowHeight / 2} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-muted)">
                {STAGE_LABEL[stage]}
              </text>
              {segments
                .filter((s) => s.stage === stage)
                .map((s, i) => {
                  const segStart = new Date(s.startAt).getTime();
                  const x = ((segStart - start) / totalMs) * width;
                  const w = Math.max(2, (s.durationMin * 60_000) / totalMs * width);
                  return <rect key={i} x={x} y={y} width={w} height={rowHeight} rx={6} fill={STAGE_COLOR[stage]} />;
                })}
            </g>
          );
        })}
        <text x={0} y={height + 18} fontSize={11} fill="var(--text-muted)">
          {new Date(start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </text>
        <text x={width} y={height + 18} textAnchor="end" fontSize={11} fill="var(--text-muted)">
          {new Date(end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </text>
      </svg>
    </div>
  );
}
