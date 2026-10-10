import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Nav } from "@/components/Nav";
import { TickButton } from "@/components/TickButton";
import { ApprovalActions, DealActions } from "@/components/ApprovalActions";
import { FunnelBar, StageBadge } from "@/components/Pipeline";
import { LeadRow, type LeadView } from "@/components/LeadRow";
import { getUserId } from "@/lib/auth";
import { prisma } from "@/infra/db";
import { transportStatus } from "@/infra/transport";
import { llm } from "@/infra/llm/client";
import { senderIdentityProblems } from "@/core/compliance";
import type {
  DealStage, FitSignal, Icp, LeadProfile, Offering, ReplyAnalysis, SenderIdentity,
} from "@/core/types";

export const dynamic = "force-dynamic";

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="card card-tight">
      <div className="tnum" style={{ fontSize: 26, fontWeight: 660, letterSpacing: "-0.03em", color: tone }}>
        {value}
      </div>
      <div className="tiny faint" style={{ marginTop: 3 }}>{label}</div>
    </div>
  );
}

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId();
  if (!userId) redirect("/login");
  const { id } = await params;

  // Scoped by userId — another account's campaign id is a 404, not a 403.
  const campaign = await prisma.campaign.findFirst({
    where: { id, userId },
    include: {
      leads: {
        orderBy: [{ fitScore: "desc" }, { createdAt: "asc" }],
        include: { contacts: true, deals: true },
      },
    },
  });
  if (!campaign) notFound();

  const [awaiting, recentMessages, events, counts] = await Promise.all([
    prisma.message.findMany({
      where: { campaignId: id, direction: "outbound", status: "awaiting_approval" },
      orderBy: { createdAt: "asc" },
      include: { contact: { include: { lead: true } } },
    }),
    prisma.message.findMany({
      where: { campaignId: id },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { contact: { include: { lead: true } } },
    }),
    prisma.event.findMany({ where: { campaignId: id }, orderBy: { createdAt: "desc" }, take: 24 }),
    prisma.message.groupBy({ by: ["direction", "status"], where: { campaignId: id }, _count: true }),
  ]);

  const offering = campaign.offering as unknown as Offering | null;
  const icp = campaign.icp as unknown as Icp | null;
  const sender = campaign.senderIdentity as SenderIdentity | null;
  const senderProblems = sender ? senderIdentityProblems(sender) : ["no sender identity configured"];

  const sent = counts.filter((c) => c.direction === "outbound" && c.status === "sent").reduce((n, c) => n + c._count, 0);
  const blocked = counts.filter((c) => c.status === "blocked").reduce((n, c) => n + c._count, 0);
  const replies = counts.filter((c) => c.direction === "inbound").reduce((n, c) => n + c._count, 0);

  const stageCounts = campaign.leads.reduce<Partial<Record<DealStage, number>>>((acc, l) => {
    const stage = l.deals[0]?.stage;
    if (stage) acc[stage] = (acc[stage] ?? 0) + 1;
    return acc;
  }, {});

  const leadViews: LeadView[] = campaign.leads.map((l) => ({
    id: l.id,
    companyName: l.companyName,
    domain: l.domain,
    url: l.url,
    status: l.status,
    discoveredVia: l.discoveredVia,
    fitScore: l.fitScore,
    fitBand: l.fitBand,
    signals: ((l.fit as unknown as { signals?: FitSignal[] } | null)?.signals) ?? null,
    reasons: ((l.fit as unknown as { reasons?: string[] } | null)?.reasons) ?? null,
    rejectedReason: l.rejectedReason,
    profile: (l.profile as unknown as LeadProfile) ?? null,
    stage: l.deals[0]?.stage ?? null,
    contacts: l.contacts.map((c) => ({ email: c.email, name: c.name, title: c.title, kind: c.kind })),
  }));

  const openDeals = campaign.leads
    .map((l) => ({ lead: l, deal: l.deals[0] }))
    .filter((d): d is { lead: (typeof campaign.leads)[number]; deal: NonNullable<(typeof campaign.leads)[number]["deals"][number]> } =>
      Boolean(d.deal) && !["won", "lost", "prospect"].includes(d.deal!.stage));

  return (
    <>
      <Nav />
      <main className="container" style={{ padding: "32px 24px 80px" }}>
        <Link href="/campaigns" className="tiny faint nav-link" style={{ padding: 0 }}>← Campaigns</Link>

        {/* ---------------------------------------------------- header --- */}
        <div className="spread" style={{ margin: "14px 0 18px" }}>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 10 }}>
              <h1 style={{ fontSize: 24 }}>{campaign.name}</h1>
              <span className="badge" data-tone={campaign.status === "running" ? "ok" : campaign.status === "failed" ? "danger" : "info"}>
                {campaign.status}
              </span>
            </div>
            <a href={campaign.sourceUrl} target="_blank" rel="noreferrer noopener" className="tiny faint mono">
              {campaign.sourceUrl} ↗
            </a>
          </div>
          <TickButton campaignId={campaign.id} />
        </div>

        <div className="alert" data-tone={campaign.liveSending ? "live" : "info"} style={{ marginBottom: 18 }}>
          <strong>Sending:</strong> {transportStatus()}
          {senderProblems.length > 0 && (
            <>
              <br />
              <strong>Cannot transmit:</strong> {senderProblems.join("; ")}. Research, qualification and
              drafting continue; every send is blocked until this is fixed.
            </>
          )}
        </div>

        {campaign.error && <div className="alert" data-tone="error" style={{ marginBottom: 18 }}>{campaign.error}</div>}

        {/* ----------------------------------------------------- stats --- */}
        <div className="grid" style={{ marginBottom: 20 }}>
          <Stat label="Companies found" value={campaign.leads.length} />
          <Stat label="Messages sent" value={sent} tone="var(--ok)" />
          <Stat label="Replies" value={replies} tone="var(--info)" />
          <Stat label="Blocked by compliance" value={blocked} tone={blocked ? "var(--warn)" : undefined} />
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Pipeline</div>
          <FunnelBar counts={stageCounts} />
        </div>

        {/* --------------------------------------------- what it learned --- */}
        {offering && icp && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>What it learned from your site</div>
            <p className="small"><strong>{offering.companyName}</strong> — {offering.oneLiner}</p>
            <div className="stack small muted" style={{ gap: 5, marginTop: 11 }}>
              {offering.proofPoints.length > 0 && (
                <div><span className="faint">Can cite: </span>{offering.proofPoints.slice(0, 3).join(" · ")}</div>
              )}
              <div><span className="faint">Targets: </span>{icp.summary}</div>
              <div><span className="faint">Looks for: </span><span className="mono tiny">{icp.painSignals.slice(0, 8).join(", ")}</span></div>
              {icp.negativeSignals.length > 0 && (
                <div><span className="faint">Disqualifies: </span><span className="mono tiny">{icp.negativeSignals.slice(0, 5).join(", ")}</span></div>
              )}
              <div className="tiny faint" style={{ marginTop: 3 }}>
                Extracted {llm().enabled ? `with ${llm().model}` : "heuristically (no ANTHROPIC_API_KEY set)"}.
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------------- needs you --- */}
        {(awaiting.length > 0 || openDeals.length > 0) && (
          <div className="card" style={{ marginBottom: 20, borderColor: "var(--border-strong)" }}>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Waiting on you</div>

            {awaiting.length === 0 && <p className="small faint">No replies held for review.</p>}

            <div className="stack" style={{ gap: 14 }}>
              {awaiting.map((m) => (
                <div key={m.id} className="msg">
                  <div className="spread">
                    <div className="small">
                      <strong>{m.contact.lead.companyName}</strong>{" "}
                      <span className="faint mono tiny">{m.toEmail}</span>
                    </div>
                    <span className="badge" data-tone="warn">{m.stepIntent ?? "reply"}</span>
                  </div>
                  <div className="tiny faint" style={{ marginTop: 4 }}>{m.subject}</div>
                  <div className="msg-body">{m.body}</div>
                  <div style={{ marginTop: 11 }}><ApprovalActions messageId={m.id} /></div>
                </div>
              ))}

              {openDeals.map(({ lead, deal }) => (
                <div key={deal.id} className="row spread" style={{ gap: 10 }}>
                  <span className="small row" style={{ gap: 9 }}>
                    <strong>{lead.companyName}</strong>
                    <StageBadge stage={deal.stage} />
                  </span>
                  <DealActions dealId={deal.id} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ----------------------------------------------------- leads --- */}
        <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 20 }}>
          <div className="spread" style={{ padding: "16px 20px 10px" }}>
            <div className="eyebrow">Companies</div>
            <span className="tiny faint">Best fit first · click a row for the evidence</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 20 }}>Company</th>
                  <th>Fit</th>
                  <th>Stage</th>
                  <th style={{ paddingRight: 20 }}>Contact / why not</th>
                </tr>
              </thead>
              <tbody>
                {leadViews.length === 0 ? (
                  <tr><td colSpan={4} className="small faint" style={{ padding: 20 }}>
                    Nothing found yet. Run a pass, or configure a prospect source (SEED_DOMAINS, DIRECTORY_URLS, or a search key).
                  </td></tr>
                ) : (
                  leadViews.map((l) => <LeadRow key={l.id} lead={l} />)
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* --------------------------------------------- conversations --- */}
        {recentMessages.length > 0 && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="eyebrow" style={{ marginBottom: 12 }}>Recent messages</div>
            <div className="stack" style={{ gap: 10 }}>
              {recentMessages.map((m) => {
                const analysis = m.analysis as unknown as ReplyAnalysis | null;
                return (
                  <div key={m.id} className="msg" data-dir={m.direction}>
                    <div className="spread">
                      <span className="small row" style={{ gap: 8 }}>
                        <span className="faint tiny">{m.direction === "outbound" ? "→" : "←"}</span>
                        <strong>{m.contact.lead.companyName}</strong>
                        <span className="mono tiny faint">{m.direction === "outbound" ? m.toEmail : m.fromEmail}</span>
                      </span>
                      <span className="row" style={{ gap: 6 }}>
                        {analysis && <span className="badge" data-tone="info">{analysis.intent}</span>}
                        {analysis?.objection && analysis.objection !== "none" && (
                          <span className="badge">{analysis.objection}</span>
                        )}
                        {m.composedVia && <span className="badge">{m.composedVia}</span>}
                        <span className="badge" data-tone={m.status === "sent" ? "ok" : m.status === "blocked" ? "warn" : undefined}>
                          {m.status}
                        </span>
                      </span>
                    </div>
                    <div className="tiny faint" style={{ marginTop: 4 }}>{m.subject}</div>
                    {m.blockedReason && (
                      <div className="tiny" style={{ color: "var(--warn)", marginTop: 5 }}>{m.blockedReason}</div>
                    )}
                    <div className="msg-body">
                      {m.body.split("\n").filter(Boolean).slice(0, 3).join("\n")}
                      {m.body.split("\n").filter(Boolean).length > 3 && <span className="faint"> …</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* -------------------------------------------------- activity --- */}
        {events.length > 0 && (
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 10 }}>Activity</div>
            <div className="stack" style={{ gap: 6 }}>
              {events.map((e) => (
                <div key={e.id} className="row tiny" style={{ gap: 10, alignItems: "baseline" }}>
                  <span className="faint mono" style={{ flex: "none" }}>
                    {e.createdAt.toISOString().slice(11, 19)}
                  </span>
                  <span className="mono" style={{
                    flex: "none", width: 132,
                    color: e.level === "error" ? "var(--danger)" : e.level === "warn" ? "var(--warn)" : "var(--text-faint)",
                  }}>
                    {e.kind}
                  </span>
                  <span className="muted">{e.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
