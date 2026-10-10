import type { DealStage, FitBand } from "../core/types";

/**
 * The console's vocabulary of small parts.
 *
 * Each one encodes a judgement rather than just a colour: a fit band, a
 * deal stage, whether a source has been proven. Keeping those mappings in one
 * place is what stops "rejected" being green on one page and grey on another.
 */

export function Pill({
  tone = "neutral",
  children,
  dot = false,
}: {
  tone?: "neutral" | "good" | "warn" | "bad" | "info";
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span className={`pill${tone === "neutral" ? "" : ` ${tone}`}`}>
      {dot && <span className="dot" aria-hidden />}
      {children}
    </span>
  );
}

const BAND_TONE: Record<FitBand, "good" | "warn" | "bad" | "neutral"> = {
  strong: "good",
  good: "good",
  marginal: "warn",
  poor: "bad",
  disqualified: "bad",
};

export function FitBadge({ score, band }: { score: number; band: FitBand }) {
  const tone = BAND_TONE[band] ?? "neutral";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="mono" style={{ fontVariantNumeric: "tabular-nums", minWidth: 22, textAlign: "right" }}>{score}</span>
      <span className={`bar${tone === "warn" ? " warn" : tone === "bad" ? " bad" : ""}`}>
        <span style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />
      </span>
    </span>
  );
}

const STAGE_TONE: Record<DealStage, "neutral" | "info" | "good" | "warn" | "bad"> = {
  prospect: "neutral",
  contacted: "neutral",
  engaged: "info",
  meeting_booked: "info",
  proposal: "warn",
  won: "good",
  lost: "bad",
};

export const STAGE_LABEL: Record<DealStage, string> = {
  prospect: "Prospect",
  contacted: "Contacted",
  engaged: "Engaged",
  meeting_booked: "Meeting booked",
  proposal: "Proposal",
  won: "Won",
  lost: "Lost",
};

export function StageBadge({ stage }: { stage: string }) {
  const key = stage as DealStage;
  return <Pill tone={STAGE_TONE[key] ?? "neutral"} dot>{STAGE_LABEL[key] ?? stage}</Pill>;
}

export function Metric({
  value,
  label,
  hint,
  tone,
}: {
  value: React.ReactNode;
  label: string;
  hint?: string;
  tone?: "good" | "warn" | "bad";
}) {
  return (
    <div className={`card metric${tone ? ` ${tone}` : ""}`}>
      <span className="value">{value}</span>
      <span className="label">{label}</span>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function SectionHead({ title, note }: { title: string; note?: React.ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {note && <span className="note">{note}</span>}
    </div>
  );
}

export function ago(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  // A timestamp in the future is not an error: a replay or a pinned-clock
  // demo writes them, and "in 0s" reads as a bug.
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function clock(date: Date): string {
  return date.toISOString().slice(11, 19);
}
