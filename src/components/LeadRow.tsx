"use client";
import { useState } from "react";
import type { DealStage, FitSignal, LeadProfile } from "@/core/types";
import { FitSignals } from "./FitSignals";
import { FitBadge, StageBadge } from "./Pipeline";

export interface LeadView {
  id: string;
  companyName: string;
  domain: string;
  url: string;
  status: string;
  discoveredVia: string;
  fitScore: number | null;
  fitBand: string | null;
  signals: FitSignal[] | null;
  reasons: string[] | null;
  rejectedReason: string | null;
  profile: LeadProfile | null;
  stage: DealStage | null;
  contacts: Array<{ email: string; name: string | null; title: string | null; kind: string }>;
}

export function LeadRow({ lead }: { lead: LeadView }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr onClick={() => setOpen((v) => !v)} style={{ cursor: "pointer" }}>
        <td style={{ maxWidth: 260 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="faint tiny" style={{ transform: open ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .18s" }}>▶</span>
            <div style={{ minWidth: 0 }}>
              <div className="truncate" style={{ fontWeight: 560 }}>{lead.companyName}</div>
              <div className="tiny faint mono truncate">{lead.domain}</div>
            </div>
          </div>
        </td>
        <td><FitBadge score={lead.fitScore} band={lead.fitBand} /></td>
        <td>{lead.stage ? <StageBadge stage={lead.stage} /> : <span className="tiny faint">{lead.status}</span>}</td>
        <td className="tiny muted" style={{ maxWidth: 240 }}>
          <span className="truncate" style={{ display: "block" }}>
            {lead.rejectedReason ?? lead.contacts[0]?.email ?? "—"}
          </span>
        </td>
      </tr>

      {open && (
        <tr>
          <td colSpan={4} style={{ background: "var(--bg-inset)" }}>
            <div className="stack" style={{ gap: 16, padding: "6px 4px 14px" }}>
              {lead.profile?.description && <p className="small muted">{lead.profile.description}</p>}

              <div className="row tiny faint" style={{ gap: 14, flexWrap: "wrap" }}>
                <a href={lead.url} target="_blank" rel="noreferrer noopener" className="link">{lead.url} ↗</a>
                {lead.profile?.employeeEstimate && <span>~{lead.profile.employeeEstimate} employees</span>}
                {lead.profile?.location && <span>{lead.profile.location}</span>}
                {lead.profile?.technologies?.length ? <span>{lead.profile.technologies.slice(0, 5).join(", ")}</span> : null}
                <span>found via {lead.discoveredVia}</span>
              </div>

              {lead.contacts.length > 0 && (
                <div>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>Contacts</div>
                  {lead.contacts.map((c) => (
                    <div key={c.email} className="row tiny" style={{ gap: 8 }}>
                      <span className="mono">{c.email}</span>
                      {c.name && <span className="muted">{c.name}</span>}
                      {c.title && <span className="faint">{c.title}</span>}
                      {c.kind === "role" && <span className="badge">shared inbox</span>}
                    </div>
                  ))}
                </div>
              )}

              {/* Evidence is what the outreach is allowed to reference, so it
                  is shown verbatim rather than summarised. */}
              {lead.profile?.evidence?.length ? (
                <div>
                  <div className="eyebrow" style={{ marginBottom: 6 }}>Evidence found on their site</div>
                  <ul className="stack small" style={{ gap: 5, margin: 0, paddingLeft: 18 }}>
                    {lead.profile.evidence.slice(0, 4).map((e, i) => (
                      <li key={i} className="muted">
                        &ldquo;{e.quote}&rdquo; <span className="tiny faint">— {e.signal}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {lead.signals && (
                <div>
                  <div className="eyebrow" style={{ marginBottom: 4 }}>Why this score</div>
                  <FitSignals signals={lead.signals} />
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
