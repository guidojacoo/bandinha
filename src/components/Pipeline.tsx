import type { DealStage } from "@/core/types";

/** Visual language for pipeline stages, shared across the console. */
export const STAGE_META: Record<DealStage, { label: string; colour: string }> = {
  prospect: { label: "Prospect", colour: "var(--text-faint)" },
  contacted: { label: "Contacted", colour: "var(--info)" },
  engaged: { label: "Engaged", colour: "var(--violet)" },
  meeting_booked: { label: "Meeting booked", colour: "var(--accent)" },
  proposal: { label: "Proposal", colour: "var(--warn)" },
  won: { label: "Won", colour: "var(--ok)" },
  lost: { label: "Lost", colour: "var(--danger)" },
};

export const STAGE_ORDER: DealStage[] = [
  "prospect", "contacted", "engaged", "meeting_booked", "proposal", "won", "lost",
];

export function StageBadge({ stage }: { stage: DealStage }) {
  const meta = STAGE_META[stage];
  return (
    <span className="row tiny" style={{ gap: 6 }}>
      <span className="dot" style={{ background: meta.colour }} />
      <span style={{ color: meta.colour }}>{meta.label}</span>
    </span>
  );
}

/**
 * Stacked bar of the pipeline.
 *
 * Reads faster than seven separate counts: the amount of green in the bar is
 * the amount of revenue, and the amount of red is the amount of churn.
 */
export function FunnelBar({ counts }: { counts: Partial<Record<DealStage, number>> }) {
  const total = STAGE_ORDER.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
  if (total === 0) {
    return <p className="tiny faint">No deals yet.</p>;
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="funnel" role="img"
        aria-label={STAGE_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${STAGE_META[s].label}`).join(", ")}>
        {STAGE_ORDER.map((stage) =>
          counts[stage] ? (
            <div key={stage} className="funnel-seg"
              style={{ width: `${((counts[stage] ?? 0) / total) * 100}%`, background: STAGE_META[stage].colour, opacity: 0.88 }}
              title={`${counts[stage]} × ${STAGE_META[stage].label}`} />
          ) : null,
        )}
      </div>
      <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
        {STAGE_ORDER.map((stage) =>
          counts[stage] ? (
            <span key={stage} className="row" style={{ gap: 6 }}>
              <span className="dot" style={{ background: STAGE_META[stage].colour }} />
              <span className="tiny muted tnum">{counts[stage]} <span className="faint">{STAGE_META[stage].label}</span></span>
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

const BAND_COLOUR: Record<string, string> = {
  strong: "var(--ok)",
  good: "#a3e635",
  marginal: "var(--warn)",
  poor: "var(--text-faint)",
  disqualified: "var(--danger)",
};

export function FitBadge({ score, band }: { score: number | null; band: string | null }) {
  const colour = BAND_COLOUR[band ?? "poor"] ?? "var(--text-faint)";
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="mono tnum" style={{ color: colour, fontWeight: 650, minWidth: 24, textAlign: "right" }}>
        {score ?? "—"}
      </span>
      <span className="tiny faint">{band ?? ""}</span>
    </span>
  );
}
