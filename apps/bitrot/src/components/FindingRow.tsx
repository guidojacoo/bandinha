"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Ecosystem } from "@/lib/registry/types";
import type { Grade, Signal } from "@/lib/rot/types";
import { GradeBadge, RotMeter } from "./Grade";

export interface FindingView {
  id: string;
  ecosystem: Ecosystem;
  packageName: string;
  section: string | null;
  requestedRange: string | null;
  resolvedVersion: string | null;
  latestVersion: string | null;
  rotScore: number | null;
  grade: string | null;
  signals: Signal[] | null;
  reasons: string[] | null;
  lastPublishAt: string | null;
  maintainerCount: number | null;
  releaseCount: number | null;
  deprecated: boolean;
  license: string | null;
  repositoryUrl: string | null;
  lookupError: string | null;
  acknowledged: boolean;
}

export function FindingRow({ finding }: { finding: FindingView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const grade = (finding.grade ?? "A") as Grade;
  const registryUrl =
    finding.ecosystem === "npm"
      ? `https://www.npmjs.com/package/${finding.packageName}`
      : `https://pypi.org/project/${finding.packageName}/`;

  async function toggleAcknowledged() {
    setBusy(true);
    try {
      if (finding.acknowledged) {
        await fetch(
          `/api/acknowledgements?ecosystem=${finding.ecosystem}&packageName=${encodeURIComponent(finding.packageName)}`,
          { method: "DELETE" },
        );
      } else {
        await fetch("/api/acknowledgements", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ecosystem: finding.ecosystem,
            packageName: finding.packageName,
          }),
        });
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="card card-tight"
      style={{ opacity: finding.acknowledged ? 0.6 : 1, padding: "14px 16px" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "block",
          width: "100%",
          boxSizing: "border-box",
        }}
        aria-expanded={open}
      >
        <div className="row" style={{ gap: 14, alignItems: "center" }}>
          {finding.lookupError ? (
            <span className="grade" data-grade="C" title="Lookup failed">
              ?
            </span>
          ) : (
            <GradeBadge grade={grade} />
          )}

          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="mono small truncate" style={{ fontWeight: 600 }}>
                {finding.packageName}
              </span>
              {finding.deprecated && (
                <span className="badge" data-tone="danger">
                  deprecated
                </span>
              )}
              {finding.acknowledged && <span className="badge">acknowledged</span>}
              {finding.section === "devDependencies" && <span className="badge">dev</span>}
            </div>
            <div className="tiny faint" style={{ marginTop: 3 }}>
              {finding.lookupError ? (
                finding.lookupError
              ) : (
                <>
                  {finding.resolvedVersion ?? finding.requestedRange ?? "—"}
                  {/* Only show the arrow when it actually points somewhere. */}
                  {finding.latestVersion && finding.latestVersion !== finding.resolvedVersion && (
                    <> → {finding.latestVersion}</>
                  )}
                  {finding.lastPublishAt && <> · last release {finding.lastPublishAt.slice(0, 10)}</>}
                </>
              )}
            </div>
          </div>

          {finding.rotScore !== null && (
            <div style={{ width: 96, flex: "none" }}>
              <RotMeter score={finding.rotScore} grade={grade} />
              <div className="tiny faint mono" style={{ textAlign: "right", marginTop: 4 }}>
                {finding.rotScore}
              </div>
            </div>
          )}
        </div>
      </button>

      {open && (
        <div className="stack" style={{ gap: 14, marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
          {finding.reasons && finding.reasons.length > 0 && (
            <ul className="stack small" style={{ gap: 5, margin: 0, paddingLeft: 18 }}>
              {finding.reasons.map((reason) => (
                <li key={reason} className="muted">
                  {reason}
                </li>
              ))}
            </ul>
          )}

          {finding.signals && (
            <div className="stack" style={{ gap: 7 }}>
              {finding.signals.map((signal) => (
                <div key={signal.id} className="row tiny" style={{ gap: 10, alignItems: "baseline" }}>
                  <span style={{ width: 108, flex: "none" }} className="muted">
                    {signal.label}
                  </span>
                  <span className="faint" style={{ flex: "1 1 auto", minWidth: 0 }}>
                    {signal.detail}
                  </span>
                  <span className="mono faint" style={{ width: 66, textAlign: "right", flex: "none" }}>
                    {signal.value === null
                      ? "n/a"
                      : signal.weight === 0
                        ? "override"
                        : `${Math.round(signal.value * 100)}%`}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <a href={registryUrl} target="_blank" rel="noreferrer noopener" className="btn btn-secondary btn-sm">
              Registry ↗
            </a>
            {finding.repositoryUrl && (
              <a
                href={finding.repositoryUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="btn btn-secondary btn-sm"
              >
                Source ↗
              </a>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={toggleAcknowledged}
              disabled={busy}
            >
              {busy
                ? "Saving…"
                : finding.acknowledged
                  ? "Remove acknowledgement"
                  : "Acknowledge — accepted risk"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
