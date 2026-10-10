"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { TickSummary } from "@/agent/orchestrator";

/**
 * Runs one orchestrator pass on demand.
 *
 * The background loop does this on a timer; this is here so an operator can
 * watch the agent work rather than refreshing and hoping.
 */
export function TickButton({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<TickSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/tick`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body.error ?? "The pass failed.");
      setLast(body.summary as TickSummary);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  const parts = last
    ? [
        last.discovered && `${last.discovered} found`,
        last.qualified && `${last.qualified} qualified`,
        last.enrolled && `${last.enrolled} enrolled`,
        last.sent && `${last.sent} sent`,
        last.blocked && `${last.blocked} blocked`,
        last.repliesHandled && `${last.repliesHandled} replies`,
      ].filter(Boolean)
    : [];

  return (
    <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
      <button className="btn btn-secondary btn-sm" onClick={run} disabled={busy}>
        {busy ? "Running…" : "Run a pass"}
      </button>
      {last && (
        <span className="tiny faint">
          {parts.length ? parts.join(" · ") : "nothing to do"}
          {last.notes[0] ? ` — ${last.notes[0]}` : ""}
        </span>
      )}
      {error && <span className="tiny" style={{ color: "var(--danger)" }}>{error}</span>}
    </div>
  );
}
