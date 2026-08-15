import { WEIGHTS } from "@/lib/rot/signals";
import type { Signal } from "@/lib/rot/types";

const MAX_WEIGHT = Math.max(...Object.values(WEIGHTS));

/**
 * Colour ramp matching the grade bands, so a signal's colour means the same
 * thing as a package's grade colour.
 */
function severityColor(value: number): string {
  if (value < 0.2) return "var(--grade-a)";
  if (value < 0.4) return "var(--grade-b)";
  if (value < 0.6) return "var(--grade-c)";
  if (value < 0.8) return "var(--grade-d)";
  return "var(--grade-f)";
}

function SignalRow({ signal }: { signal: Signal }) {
  const isOverride = signal.weight === 0;
  // Bound to a local so TypeScript narrows it across the branches below.
  const value = signal.value;

  // Track length encodes how much this signal *can* matter; the fill encodes
  // how much it *did*. An override has no weight, so it spans the full track.
  const trackPct = isOverride ? 100 : (signal.weight / MAX_WEIGHT) * 100;
  const fillPct = value === null ? 0 : value * 100;

  let valueLabel: string;
  if (value === null) valueLabel = "not scored";
  // The weight column already reads "override"; say what the override *does*
  // rather than repeating the word.
  else if (isOverride) valueLabel = value === 1 ? "sets F" : "clear";
  else valueLabel = `${Math.round(value * 100)}% risk`;

  const color =
    value === null
      ? "var(--border-strong)"
      : isOverride && value === 1
        ? "var(--grade-f)"
        : severityColor(value);

  return (
    <div className="signal" data-state={value === null ? "unscored" : "scored"}>
      <div className="signal-name-cell">
        <div className="signal-name">{signal.label}</div>
        <div className="tiny faint tnum">{isOverride ? "override" : `weight ${signal.weight}`}</div>
      </div>

      <div className="signal-bar-cell">
        <div
          className="signal-track"
          style={{ width: `${trackPct}%` }}
          role="img"
          aria-label={
            value === null
              ? `${signal.label}: not scored`
              : `${signal.label}: ${Math.round(value * 100)} percent risk contribution`
          }
        >
          {fillPct > 0 && (
            <div className="signal-fill" style={{ width: `${fillPct}%`, background: color }} />
          )}
        </div>
      </div>

      <span className="signal-value tnum">{valueLabel}</span>
      <div className="signal-detail">{signal.detail}</div>
    </div>
  );
}

export function SignalList({ signals, note = true }: { signals: Signal[]; note?: boolean }) {
  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 4 }}>
        Signal breakdown
      </div>
      {signals.map((signal) => (
        <SignalRow key={signal.id} signal={signal} />
      ))}
      {note && (
        <p className="tiny faint" style={{ marginTop: 12, lineHeight: 1.5 }}>
          Bar length shows how much a signal can move the score (its weight); the filled portion
          shows how much it did. Signals the registry cannot answer read{" "}
          <span className="mono">not scored</span> and are dropped from the weighting entirely —
          never counted as healthy.
        </p>
      )}
    </div>
  );
}
