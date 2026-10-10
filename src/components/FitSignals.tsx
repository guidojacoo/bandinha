import type { FitSignal } from "@/core/types";

const MAX_WEIGHT = 30;

function severity(value: number): string {
  if (value >= 0.75) return "var(--ok)";
  if (value >= 0.5) return "#a3e635";
  if (value >= 0.25) return "var(--warn)";
  return "var(--text-faint)";
}

/**
 * The fit breakdown, drawn rather than tabulated.
 *
 * Track length encodes how much a signal *can* move the score (its weight);
 * the filled portion encodes how much it did. A column of percentages hides
 * that ranking entirely — "100%" next to a weight-8 signal looks identical to
 * "100%" next to a weight-30 one.
 */
export function FitSignals({ signals }: { signals: FitSignal[] }) {
  return (
    <div>
      {signals
        .filter((s) => !(s.weight === 0 && s.value === 0))
        .map((s) => {
          const isOverride = s.weight === 0;
          const value = s.value;
          const trackPct = isOverride ? 100 : (s.weight / MAX_WEIGHT) * 100;
          const label =
            value === null ? "not scored" : isOverride ? "disqualifies" : `${Math.round(value * 100)}% match`;
          const colour = value === null ? "var(--border-strong)" : isOverride ? "var(--danger)" : severity(value);

          return (
            <div key={s.id} className="sig" data-state={value === null ? "unscored" : "scored"}>
              <div className="sig-n">
                <div className="small" style={{ fontWeight: 540 }}>{s.label}</div>
                <div className="tiny faint tnum">{isOverride ? "override" : `weight ${s.weight}`}</div>
              </div>
              <div className="sig-b">
                <div className="track" style={{ width: `${trackPct}%` }}>
                  {value !== null && value > 0 && (
                    <div className="fill" style={{ width: `${value * 100}%`, background: colour }} />
                  )}
                </div>
              </div>
              <span className="sig-v tnum">{label}</span>
              <div className="sig-d">{s.detail}</div>
            </div>
          );
        })}
      <p className="tiny faint" style={{ marginTop: 10, lineHeight: 1.5 }}>
        Bar length is how much a signal can move the score; the fill is how much it did. Signals the
        prospect&rsquo;s site does not answer read <span className="mono">not scored</span> and leave the
        weighting entirely — they are never counted as a match.
      </p>
    </div>
  );
}
