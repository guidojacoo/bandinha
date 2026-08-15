import type { Grade } from "@/lib/rot";

export const GRADE_COLOR: Record<Grade, string> = {
  A: "var(--grade-a)",
  B: "var(--grade-b)",
  C: "var(--grade-c)",
  D: "var(--grade-d)",
  F: "var(--grade-f)",
};

export function GradeBadge({ grade }: { grade: Grade }) {
  return (
    <span className="grade" data-grade={grade} title={`Grade ${grade}`}>
      {grade}
    </span>
  );
}

/** Horizontal 0-100 rot meter, coloured by grade. */
export function RotMeter({ score, grade }: { score: number; grade: Grade }) {
  return (
    <div className="meter" role="img" aria-label={`Rot score ${score} of 100`}>
      <div
        className="meter-fill"
        style={{ width: `${Math.max(2, score)}%`, background: GRADE_COLOR[grade] }}
      />
    </div>
  );
}

/** Big circular score used for the portfolio headline. */
export function ScoreDial({
  score,
  grade,
  size = 132,
}: {
  score: number;
  grade: Grade;
  size?: number;
}) {
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.min(100, Math.max(0, score)) / 100) * circumference;

  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--bg-inset)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={GRADE_COLOR[grade]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 1,
        }}
      >
        <span style={{ fontSize: size * 0.29, fontWeight: 680, letterSpacing: "-0.03em" }}>
          {score}
        </span>
        <span className="tiny faint" style={{ letterSpacing: "0.08em" }}>
          ROT
        </span>
      </div>
    </div>
  );
}
