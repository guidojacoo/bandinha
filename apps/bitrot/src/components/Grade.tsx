import type { Grade } from "@/lib/rot";

export const GRADE_COLOR: Record<Grade, string> = {
  A: "var(--grade-a)",
  B: "var(--grade-b)",
  C: "var(--grade-c)",
  D: "var(--grade-d)",
  F: "var(--grade-f)",
};

export function GradeBadge({ grade, title }: { grade: Grade; title?: string }) {
  return (
    <span className="grade" data-grade={grade} title={title ?? `Grade ${grade}`}>
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

const GRADE_ORDER: Grade[] = ["A", "B", "C", "D", "F"];

/**
 * Stacked bar of the grade mix across a scan.
 *
 * Reads faster than five separate counts: the amount of red in the bar *is*
 * the amount of risk in the tree.
 */
export function GradeDistribution({ counts }: { counts: Record<Grade, number> }) {
  const total = GRADE_ORDER.reduce((sum, g) => sum + counts[g], 0);
  if (total === 0) return null;

  return (
    <div className="stack" style={{ gap: 9 }}>
      <div
        style={{ display: "flex", height: 8, borderRadius: 999, overflow: "hidden", gap: 2 }}
        role="img"
        aria-label={GRADE_ORDER.filter((g) => counts[g] > 0)
          .map((g) => `${counts[g]} grade ${g}`)
          .join(", ")}
      >
        {GRADE_ORDER.map((grade) =>
          counts[grade] > 0 ? (
            <div
              key={grade}
              style={{
                width: `${(counts[grade] / total) * 100}%`,
                background: GRADE_COLOR[grade],
                opacity: 0.85,
              }}
              title={`${counts[grade]} × ${grade}`}
            />
          ) : null,
        )}
      </div>

      <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
        {GRADE_ORDER.map((grade) =>
          counts[grade] > 0 ? (
            <span key={grade} className="row" style={{ gap: 6 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: GRADE_COLOR[grade],
                  flex: "none",
                }}
              />
              <span className="tiny muted tnum">
                {counts[grade]} <span className="faint">{grade}</span>
              </span>
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

/**
 * Circular score used for headline numbers.
 *
 * The arc is drawn with a rounded cap and a faint track so a low score still
 * reads as "a small amount of a whole" rather than as a broken ring.
 */
export function ScoreDial({
  score,
  grade,
  size = 132,
  label = "ROT",
}: {
  score: number;
  grade: Grade;
  size?: number;
  label?: string;
}) {
  const stroke = Math.max(7, Math.round(size * 0.072));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, score));
  // Keep a sliver visible at 0 so the dial never looks like it failed to render.
  const filled = Math.max(clamped === 0 ? 0.5 : 0, (clamped / 100) * circumference);

  return (
    <div
      style={{ position: "relative", width: size, height: size, flex: "none" }}
      role="img"
      aria-label={`Rot score ${score} of 100, grade ${grade}`}
    >
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)", display: "block" }} aria-hidden="true">
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
          opacity={0.95}
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
          gap: 0,
        }}
      >
        <span
          className="tnum"
          style={{
            fontSize: size * 0.3,
            fontWeight: 680,
            letterSpacing: "-0.04em",
            lineHeight: 1,
          }}
        >
          {score}
        </span>
        <span
          className="faint"
          style={{ fontSize: Math.max(9, size * 0.077), letterSpacing: "0.12em", marginTop: 4 }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}
