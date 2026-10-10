import Link from "next/link";
import { redirect } from "next/navigation";
import { Nav } from "@/components/Nav";
import { NewCampaignForm } from "@/components/NewCampaignForm";
import { FunnelBar } from "@/components/Pipeline";
import { getUserId } from "@/lib/auth";
import { prisma } from "@/infra/db";
import { transportStatus } from "@/infra/transport";
import { llm } from "@/infra/llm/client";
import type { DealStage } from "@/core/types";

export const metadata = { title: "Campaigns" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  running: "ok", ingesting: "info", paused: "warn", failed: "danger", finished: "",
};

export default async function CampaignsPage() {
  const userId = await getUserId();
  if (!userId) redirect("/login");

  const campaigns = await prisma.campaign.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { leads: true, messages: true } }, deals: { select: { stage: true } } },
  });

  return (
    <>
      <Nav />
      <main className="container" style={{ padding: "40px 24px 80px" }}>
        <div className="spread" style={{ marginBottom: 22 }}>
          <div>
            <h1 style={{ fontSize: 26 }}>Campaigns</h1>
            <p className="small muted" style={{ marginTop: 5 }}>
              {campaigns.length === 0 ? "Nothing running yet." : `${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>

        <div className="alert" data-tone={transportStatus().startsWith("LIVE") ? "live" : "info"} style={{ marginBottom: 20 }}>
          <strong>Sending:</strong> {transportStatus()}
          {!llm().enabled && " · No ANTHROPIC_API_KEY — research and copy fall back to deterministic logic."}
        </div>

        <NewCampaignForm />

        {campaigns.length > 0 && (
          <div className="stack" style={{ gap: 12, marginTop: 26 }}>
            {campaigns.map((c) => {
              const counts = c.deals.reduce<Partial<Record<DealStage, number>>>((acc, d) => {
                acc[d.stage] = (acc[d.stage] ?? 0) + 1;
                return acc;
              }, {});
              return (
                <Link key={c.id} href={`/campaigns/${c.id}`} className="card card-hover" style={{ display: "block" }}>
                  <div className="spread">
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 9 }}>
                        <span style={{ fontWeight: 620 }}>{c.name}</span>
                        <span className="badge" data-tone={STATUS_TONE[c.status]}>{c.status}</span>
                        {c.liveSending && <span className="badge" data-tone="danger">live</span>}
                      </div>
                      <div className="tiny faint mono truncate" style={{ marginTop: 4 }}>{c.sourceUrl}</div>
                    </div>
                    <div className="row tiny muted tnum" style={{ gap: 16 }}>
                      <span>{c._count.leads} companies</span>
                      <span>{c._count.messages} messages</span>
                      <span>{c.createdAt.toISOString().slice(0, 10)}</span>
                    </div>
                  </div>
                  {c.deals.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <FunnelBar counts={counts} />
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
