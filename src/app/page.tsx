import { redirect } from "next/navigation";
import { db } from "../infra/db";
import { readSession } from "../lib/auth";
import { describeMailSetup } from "../infra/transport";
import { Empty, Metric, Pill, SectionHead, ago } from "../components/ui";
import { WorkerNotice } from "../components/worker-notice";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  let session: Awaited<ReturnType<typeof readSession>> = null;
  try {
    session = await readSession();
  } catch {
    redirect("/login");
  }
  if (!session) redirect("/login");

  const campaigns = await db.campaign.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    // Capped like every list here. An agency running a campaign per client
    // has hundreds, and the newest are the ones being watched.
    take: 100,
    include: {
      _count: { select: { leads: true, messages: true, deals: true } },
    },
  });

  const [enrolled, sent, escalations] = await Promise.all([
    db.lead.count({ where: { status: "enrolled", campaign: { userId: session.userId } } }),
    db.message.count({ where: { direction: "outbound", status: "sent", campaign: { userId: session.userId } } }),
    db.event.count({ where: { kind: "reply.escalated", campaign: { userId: session.userId } } }),
  ]);

  const mail = describeMailSetup(campaigns.some((c) => c.liveSending));

  return (
    <main>
      <h1>Campaigns</h1>
      <p className="lede">
        One URL per campaign. The agent reads that site, works out who buys what it sells, finds those
        companies in open data, and writes only to the ones whose own pages show the problem.
      </p>

      <WorkerNotice />
      {mail.warning && <div className="banner warn">{mail.warning}</div>}
      {!mail.live && (
        <div className="banner">
          <strong>Dry run.</strong> Messages are written to <span className="mono">./outbox</span> as .eml files
          and nothing is sent. Configure SMTP and arm a campaign to change that.
        </div>
      )}

      <section>
        <div className="grid cols-4">
          <Metric value={campaigns.length} label="Campaigns" />
          <Metric value={enrolled} label="Leads being worked" tone={enrolled > 0 ? "good" : undefined} />
          <Metric value={sent} label="Messages sent" />
          <Metric
            value={escalations}
            label="Waiting for you"
            tone={escalations > 0 ? "warn" : undefined}
            hint={escalations > 0 ? "commitments, pricing, referrals" : "nothing needs a person"}
          />
        </div>
      </section>

      <section>
        <SectionHead title="All campaigns" note={<a href="/new">+ New campaign</a>} />
        {campaigns.length === 0 ? (
          <Empty>
            Nothing yet. <a href="/new">Start a campaign</a> from a website, or run{" "}
            <span className="mono">npm run demo</span> to watch a full run against the bundled fixture web.
          </Empty>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Sending</th>
                  <th className="num">Leads</th>
                  <th className="num">Messages</th>
                  <th className="num">Deals</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.id}>
                    <td>
                      <a href={`/campaigns/${campaign.id}`} style={{ fontWeight: 560 }}>{campaign.name}</a>
                      <span className="reason mono">{campaign.sourceUrl}</span>
                    </td>
                    <td>
                      <Pill tone={campaign.status === "running" ? "good" : campaign.status === "failed" ? "bad" : "neutral"} dot>
                        {campaign.status}
                      </Pill>
                    </td>
                    <td>
                      {campaign.liveSending
                        ? <Pill tone="bad" dot>live</Pill>
                        : <Pill dot>dry run</Pill>}
                    </td>
                    <td className="num">{campaign._count.leads}</td>
                    <td className="num">{campaign._count.messages}</td>
                    <td className="num">{campaign._count.deals}</td>
                    <td className="dim nowrap">{ago(campaign.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
