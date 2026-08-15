"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Ecosystem } from "@/lib/registry/types";
import type { Grade, Signal } from "@/lib/rot/types";
import { GradeBadge, RotMeter } from "./Grade";
import { SignalList } from "./SignalList";

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
          body: JSON.stringify({ ecosystem: finding.ecosystem, packageName: finding.packageName }),
        });
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const behind = finding.latestVersion && finding.latestVersion !== finding.resolvedVersion;

  return (
    <div className="finding" data-open={open} data-acknowledged={finding.acknowledged}>
      <button
        type="button"
        className="finding-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${finding.packageName}, rot score ${finding.rotScore ?? "unknown"}`}
      >
        <div className="row" style={{ gap: 13, alignItems: "center" }}>
          {finding.lookupError ? (
            <span className="grade" data-grade="C" title="Registry lookup failed">
              ?
            </span>
          ) : (
            <GradeBadge grade={grade} />
          )}

          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <div className="row" style={{ gap: 7, flexWrap: "wrap" }}>
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

            <div className="tiny faint tnum" style={{ marginTop: 3 }}>
              {finding.lookupError ? (
                finding.lookupError
              ) : (
                <>
                  <span className={behind ? "muted" : undefined}>
                    {finding.resolvedVersion ?? finding.requestedRange ?? "—"}
                  </span>
                  {behind && <> → {finding.latestVersion}</>}
                  {finding.lastPublishAt && <> · last release {finding.lastPublishAt.slice(0, 10)}</>}
                </>
              )}
            </div>
          </div>

          {finding.rotScore !== null && (
            <div style={{ width: 92, flex: "none" }}>
              <RotMeter score={finding.rotScore} grade={grade} />
              <div className="tiny faint mono tnum" style={{ textAlign: "right", marginTop: 4 }}>
                {finding.rotScore}
              </div>
            </div>
          )}

          <span
            className="faint"
            style={{
              flex: "none",
              fontSize: 11,
              transition: "transform 0.18s var(--ease)",
              transform: open ? "rotate(90deg)" : "none",
            }}
            aria-hidden="true"
          >
            ▶
          </span>
        </div>
      </button>

      {open && (
        <div className="finding-body stack" style={{ gap: 16 }}>
          <hr className="divider" />

          {finding.reasons && finding.reasons.length > 0 && (
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                Why
              </div>
              <ul className="stack small" style={{ gap: 5, margin: 0, paddingLeft: 18 }}>
                {finding.reasons.map((reason) => (
                  <li key={reason} className="muted">
                    {reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {finding.signals && <SignalList signals={finding.signals} note={false} />}

          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
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
            <button type="button" className="btn btn-ghost btn-sm" onClick={toggleAcknowledged} disabled={busy}>
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
