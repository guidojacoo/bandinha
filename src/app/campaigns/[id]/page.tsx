import { notFound, redirect } from "next/navigation";
import { db } from "../../../infra/db";
import { ownedCampaign, readSession } from "../../../lib/auth";
import { fromJson } from "../../../lib/json";
import { describeMailSetup, smtpConfigFromEnv } from "../../../infra/transport";
import { pipelineSummary } from "../../../agent/orchestrator";
import { budgetSummary, utcDay } from "../../../core/budget";
import { STAGE_LABEL } from "../../../components/ui";
import { Empty, FitBadge, Metric, Pill, SectionHead, StageBadge, ago, clock } from "../../../components/ui";
import {
  armLiveSending, assignClient, disarmLiveSending, runTick, setStatus,
  updateIcp, updateTargets,
} from "../../actions";
import { formatMoney } from "../../../core/billing";
import { describeRate } from "../../../core/warmup";
import { monthToDate } from "../../../agent/billing";
import { warmupFor, defaultCompliance } from "../../../agent/orchestrator";
import { peek } from "../../../infra/lock";
import type {
  DealStage, FitResult, Icp, LeadProfile, Offering, ProvenanceRecord, ReplyAnalysis, SenderIdentity,
} from "../../../core/types";

export const dynamic = "force-dynamic";

/**
 * The instrument panel.
 *
 * Organised around one question: *why did it do that?* Every rejected lead
 * shows its reason, every message shows how it was composed and which claims
 * it made, every blocked message shows which rule stopped it, and the
 * escalation queue is above everything else because it is the only part that
 * needs a person.
 */
export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await readSession().catch(() => null);
  if (!session) redirect("/login");

  const { id } = await params;
  const query = await searchParams;

  const campaign = await ownedCampaign(id);
  if (!campaign) notFound();

  const offering = fromJson<Offering | null>(campaign.offering, null);
  const icp = fromJson<Icp | null>(campaign.icp, null);
  const sender = fromJson<SenderIdentity | null>(campaign.senderIdentity, null);

  const clients = await db.client.findMany({ where: { userId: session.userId }, orderBy: { name: "asc" } });
  const billed = campaign.clientId ? await monthToDate(campaign.clientId) : null;

  const configuredCap = sender
    ? { ...defaultCompliance(sender), ...fromJson<{ dailySendCap?: number }>(campaign.complianceConfig, {}) }.dailySendCap
    : 30;
  const [warmup, lock] = await Promise.all([
    warmupFor(campaign.id, configuredCap),
    // Read-only: looking must not become the thing that stops a tick.
    peek(campaign.id),
  ]);

  const [leads, messages, deals, events, escalations, runs, pipeline, ledger, suppressions] = await Promise.all([
    db.lead.findMany({
      where: { campaignId: campaign.id },
      include: { contacts: true, enrollments: true, deals: true },
      orderBy: [{ fitScore: "desc" }, { createdAt: "asc" }],
    }),
    db.message.findMany({
      where: { campaignId: campaign.id },
      include: { contact: { include: { lead: true } } },
      orderBy: { createdAt: "desc" },
      take: 60,
    }),
    db.deal.findMany({ where: { campaignId: campaign.id }, include: { lead: true }, orderBy: { updatedAt: "desc" } }),
    db.event.findMany({ where: { campaignId: campaign.id }, orderBy: { createdAt: "desc" }, take: 60 }),
    db.event.findMany({ where: { campaignId: campaign.id, kind: "reply.escalated" }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.agentRun.findMany({ where: { campaignId: campaign.id }, orderBy: { startedAt: "desc" }, take: 1 }),
    pipelineSummary(campaign.id),
    db.tokenLedger.findMany({ where: { day: utcDay() } }),
    db.suppression.count({ where: { userId: session.userId } }),
  ]);

  const mail = describeMailSetup(campaign.liveSending);
  const sentCount = messages.filter((m) => m.direction === "outbound" && m.status === "sent").length;
  const blocked = messages.filter((m) => m.status === "blocked");
  const inbound = messages.filter((m) => m.direction === "inbound");
  const enrolled = leads.filter((l) => l.status === "enrolled");
  const rejected = leads.filter((l) => l.status === "rejected");
  const lastSent = messages.find((m) => m.direction === "outbound" && m.status === "sent");

  const budgetRow = ledger.find((row) => row.model === "*");
  const modelRows = ledger.filter((row) => row.model !== "*");

  return (
    <main>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <h1 style={{ margin: 0 }}>{campaign.name}</h1>
        <div className="actions">
          <form action={runTick}>
            <input type="hidden" name="campaignId" value={campaign.id} />
            <button type="submit">Run a tick</button>
          </form>
          <form action={setStatus}>
            <input type="hidden" name="campaignId" value={campaign.id} />
            <input type="hidden" name="status" value={campaign.status === "paused" ? "running" : "paused"} />
            <button className="ghost" type="submit">{campaign.status === "paused" ? "Resume" : "Pause"}</button>
          </form>
        </div>
      </div>
      <p className="lede">
        <span className="mono dim">{campaign.sourceUrl}</span>
        {" · "}
        {campaign.status === "paused" ? "Paused." : "Running."}
        {" "}Reads replies first, then discovers, qualifies and sends — in that order, every tick.
      </p>

      {/* ── state of play ──────────────────────────────────────────── */}

      {query.error === "confirm" && (
        <div className="banner bad">Type SEND exactly to arm live sending. Nothing was changed.</div>
      )}
      {query.error === "smtp" && (
        <div className="banner bad">
          SMTP is not configured, so arming live sending would have left this campaign silently in dry run.
          Set <span className="mono">SMTP_HOST</span> and the rest, then try again.
        </div>
      )}
      {campaign.error && <div className="banner bad">{campaign.error}</div>}
      {mail.warning && <div className="banner warn">{mail.warning}</div>}

      <div className={`banner ${campaign.liveSending ? "bad" : ""}`}>
        <div style={{ flex: 1 }}>
          <strong>{campaign.liveSending ? "Live sending is armed." : "Dry run."}</strong>{" "}
          {mail.transport}
          <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>{mail.inbox}</div>
        </div>
        {campaign.liveSending ? (
          <form action={disarmLiveSending}>
            <input type="hidden" name="campaignId" value={campaign.id} />
            <button className="ghost" type="submit">Back to dry run</button>
          </form>
        ) : (
          <form action={armLiveSending} className="actions">
            <input type="hidden" name="campaignId" value={campaign.id} />
            <input
              name="confirm"
              type="text"
              placeholder="type SEND"
              style={{ width: 120 }}
              aria-label="Type SEND to confirm"
              disabled={!smtpConfigFromEnv()}
            />
            <button className="danger" type="submit" disabled={!smtpConfigFromEnv()}>Arm live sending</button>
          </form>
        )}
      </div>

      {lock.held && (
        <div className="banner good">
          A tick is running right now — {lock.by}. Overlapping ticks would double every send cap, so a second
          one skips rather than queues.
        </div>
      )}

      {warmup.stage === "halted" && (
        <div className="banner bad">
          <div>
            <strong>Sending is stopped.</strong> {warmup.reason}
          </div>
        </div>
      )}
      {warmup.stage === "throttled" && (
        <div className="banner warn">
          <div>
            <strong>Volume halved.</strong> {warmup.reason}
          </div>
        </div>
      )}

      <section>
        <div className="grid cols-4">
          <Metric value={enrolled.length} label="Being worked" hint={`of ${campaign.targetLeads} target`} tone={enrolled.length > 0 ? "good" : undefined} />
          <Metric value={sentCount} label="Sent" hint={lastSent ? `last ${ago(lastSent.sentAt ?? lastSent.createdAt)}` : "none yet"} />
          <Metric value={inbound.length} label="Replies" hint={`${pipeline.open} open deal(s)`} />
          <Metric
            value={escalations.length}
            label="Waiting for you"
            tone={escalations.length > 0 ? "warn" : undefined}
            hint={escalations.length > 0 ? "the agent will not answer these" : "nothing needs a person"}
          />
        </div>
      </section>

      <section>
        <SectionHead
          title="Sending reputation"
          note="the damage a cold domain does is invisible for weeks, so the cap ramps"
        />
        <div className="grid cols-4">
          <Metric
            value={`${warmup.dailyCap}`}
            label="Today's cap"
            hint={`${warmup.remainingToday} left · configured ${configuredCap}`}
            tone={warmup.stage === "halted" ? "bad" : warmup.stage === "throttled" ? "warn" : undefined}
          />
          <Metric value={warmup.stage.replace(/_/g, " ")} label="Stage" />
          <Metric
            value={describeRate(warmup.bounceRate, warmup.sampled)}
            label="Bounces"
            hint="over 2% halves the volume, over 5% stops it"
            tone={warmup.sampled && warmup.bounceRate >= 0.02 ? "bad" : undefined}
          />
          <Metric
            value={describeRate(warmup.complaintRate, warmup.sampled)}
            label="Complaints"
            hint="Gmail publishes 0.3% as the ceiling"
            tone={warmup.sampled && warmup.complaintRate >= 0.0015 ? "bad" : undefined}
          />
        </div>
        <p className="dim" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>{warmup.reason}</p>
      </section>

      {/* ── the queue that matters ─────────────────────────────────── */}

      {escalations.length > 0 && (
        <section>
          <SectionHead
            title="Needs a person"
            note="commitments, pricing and referrals — the agent stops here on purpose"
          />
          <div className="stack">
            {escalations.map((event) => {
              const data = fromJson<{ analysis?: ReplyAnalysis; body?: string }>(event.data, {});
              return (
                <div className="card" key={event.id}>
                  <div className="row-between" style={{ marginBottom: 8 }}>
                    <strong style={{ fontSize: 13 }}>{event.message}</strong>
                    <span className="dim mono" style={{ fontSize: 11 }}>{ago(event.createdAt)}</span>
                  </div>
                  {data.body && <div className="email inbound">{data.body}</div>}
                  {data.analysis && (
                    <div className="tags" style={{ marginTop: 10 }}>
                      <Pill tone="info">{data.analysis.intent}</Pill>
                      {data.analysis.objection !== "none" && <Pill>{data.analysis.objection}</Pill>}
                      <Pill>confidence {data.analysis.confidence.toFixed(2)}</Pill>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── pipeline ───────────────────────────────────────────────── */}

      <section>
        <SectionHead
          title="Pipeline"
          note={pipeline.won === 0 ? "the agent never marks a deal won — that needs a payment or a person" : undefined}
        />
        <div className="grid cols-4">
          {(Object.keys(pipeline.byStage) as DealStage[])
            .filter((stage) => pipeline.byStage[stage] > 0)
            .map((stage) => (
              <Metric
                key={stage}
                value={pipeline.byStage[stage]}
                label={STAGE_LABEL[stage]}
                tone={stage === "won" ? "good" : stage === "lost" ? "bad" : stage === "proposal" ? "warn" : undefined}
              />
            ))}
          {pipeline.open === 0 && pipeline.won === 0 && pipeline.lost === 0 && (
            <Empty>No deals yet. Run a tick.</Empty>
          )}
        </div>
      </section>

      {/* ── leads ──────────────────────────────────────────────────── */}

      <section>
        <SectionHead
          title="Leads"
          note={`${enrolled.length} being worked · ${rejected.length} rejected · threshold ${campaign.minFitScore}`}
        />
        {leads.length === 0 ? (
          <Empty>Nothing discovered yet. Run a tick, and check <a href="/sources">Sources</a> if it finds nothing.</Empty>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Fit</th>
                  <th>Status</th>
                  <th>Found by</th>
                  <th>Contact</th>
                  <th>Deal</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => {
                  const fit = fromJson<FitResult | null>(lead.fit, null);
                  const profile = fromJson<LeadProfile | null>(lead.profile, null);
                  // The address actually being written to, not merely the
                  // first one found: a company publishing info@ before a named
                  // lead would otherwise show the wrong person.
                  const enrolledIds = new Set(lead.enrollments.map((e) => e.contactId));
                  const contact =
                    lead.contacts.find((c) => enrolledIds.has(c.id)) ??
                    lead.contacts.find((c) => c.deliverable) ??
                    lead.contacts[0];
                  const deal = lead.deals[0];
                  const evidence = profile?.evidence?.[0];

                  return (
                    <tr key={lead.id}>
                      <td>
                        <a href={`https://${lead.domain}`} rel="noreferrer nofollow" target="_blank" style={{ fontWeight: 560 }}>
                          {lead.companyName}
                        </a>
                        <span className="reason mono">{lead.domain}</span>
                        {evidence && lead.status === "enrolled" && (
                          <span className="reason">“{evidence.quote.slice(0, 150)}{evidence.quote.length > 150 ? "…" : ""}”</span>
                        )}
                        {lead.rejectedReason && <span className="reason">{lead.rejectedReason}</span>}
                      </td>
                      <td className="nowrap">
                        {fit ? <FitBadge score={fit.score} band={fit.band} /> : <span className="dim">–</span>}
                      </td>
                      <td>
                        <Pill
                          tone={lead.status === "enrolled" ? "good" : lead.status === "rejected" ? "neutral" : "info"}
                          dot
                        >
                          {lead.status}
                        </Pill>
                      </td>
                      <td className="mono dim" style={{ maxWidth: 220 }}>
                        {lead.discoveredVia.split(":")[0]}
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {contact ? (
                          <>
                            {contact.email}
                            {contact.name && <span className="reason">{contact.name}{contact.title ? `, ${contact.title}` : ""}</span>}
                            {!contact.deliverable && <span className="reason">pre-flight: undeliverable</span>}
                          </>
                        ) : (
                          <span className="dim">none published</span>
                        )}
                      </td>
                      <td>{deal ? <StageBadge stage={deal.stage} /> : <span className="dim">–</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── what it wrote ──────────────────────────────────────────── */}

      <section>
        <SectionHead
          title="Messages"
          note={`${sentCount} sent · ${blocked.length} blocked · ${inbound.length} received`}
        />
        {messages.length === 0 ? (
          <Empty>Nothing written yet.</Empty>
        ) : (
          <div className="stack">
            {messages.slice(0, 12).map((message) => {
              const provenance = fromJson<ProvenanceRecord[]>(message.provenance, []);
              const analysis = fromJson<ReplyAnalysis | null>(message.analysis, null);
              const tone = message.status === "blocked" ? "blocked" : message.direction === "inbound" ? "inbound" : "outbound";

              return (
                <div className="card" key={message.id}>
                  <div className="email-head">
                    <strong>{message.direction === "inbound" ? message.fromEmail : message.toEmail}</strong>
                    <span>{message.subject || <em className="dim">(no subject — a reply in thread)</em>}</span>
                    <span className="spacer" style={{ flex: 1 }} />
                    {message.stepIntent && <Pill>{message.stepIntent}</Pill>}
                    {message.composedVia && <Pill tone={message.composedVia === "template" ? "neutral" : "info"}>{message.composedVia}</Pill>}
                    {analysis && <Pill tone="info">{analysis.intent}</Pill>}
                    <Pill tone={message.status === "sent" ? "good" : message.status === "blocked" ? "bad" : message.status === "received" ? "info" : "warn"} dot>
                      {message.status}
                    </Pill>
                    <span className="dim nowrap">{ago(message.sentAt ?? message.createdAt)}</span>
                  </div>

                  {message.blockedReason && (
                    <div className="banner bad" style={{ marginBottom: 10, fontSize: 12 }}>
                      <div>
                        <strong>{message.blockedCode}</strong> — {message.blockedReason}
                      </div>
                    </div>
                  )}

                  <div className={`email ${tone}`}>{message.body}</div>

                  {provenance.length > 0 && (
                    <details style={{ marginTop: 10 }}>
                      <summary className="dim" style={{ fontSize: 12, cursor: "pointer" }}>
                        {provenance.length} claim(s), each checked against a crawled page
                      </summary>
                      <div style={{ marginTop: 8 }}>
                        {provenance.map((record, index) => (
                          <div className="claim" key={index}>
                            <Pill tone={record.verified ? "good" : "bad"}>{record.verified ? "verified" : "unverified"}</Pill>
                            <span className="text">{record.claim}</span>
                            <a href={record.source} rel="noreferrer nofollow" target="_blank">{shortUrl(record.source)}</a>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── the agent's own reasoning ──────────────────────────────── */}

      <div className="grid split">
        <section>
          <SectionHead title="What you sell, as it read it" note={`from ${offering?.sources.length ?? 0} page(s)`} />
          {offering ? (
            <div className="card">
              <dl className="kv">
                <dt>One line</dt>
                <dd>{offering.oneLiner}</dd>
                {offering.pricingModel && (
                  <>
                    <dt>Pricing</dt>
                    <dd>{offering.pricingModel}</dd>
                  </>
                )}
                <dt>Categories</dt>
                <dd>{offering.categories.join(", ") || <span className="dim">not determined — industry is not scored</span>}</dd>
              </dl>

              <h3 style={{ marginTop: 18 }}>Claims outreach may make</h3>
              {offering.valueProps.length === 0 ? (
                <p className="dim" style={{ fontSize: 12 }}>None found, so the copy will stick to the one-liner.</p>
              ) : (
                offering.valueProps.map((claim, index) => (
                  <div className="claim" key={index}>
                    <span className="text">{claim.text}</span>
                    <a href={claim.source} rel="noreferrer nofollow" target="_blank">{shortUrl(claim.source)}</a>
                  </div>
                ))
              )}

              <h3 style={{ marginTop: 18 }}>Proof points</h3>
              {offering.proofPoints.length === 0 ? (
                <p className="dim" style={{ fontSize: 12 }}>
                  None verifiable on your site, so the agent will say nothing about other customers. That is the
                  intended behaviour, not a gap to fill with something plausible.
                </p>
              ) : (
                offering.proofPoints.map((claim, index) => (
                  <div className="claim" key={index}>
                    <span className="text">{claim.text}</span>
                    <a href={claim.source} rel="noreferrer nofollow" target="_blank">{shortUrl(claim.source)}</a>
                  </div>
                ))
              )}
            </div>
          ) : (
            <Empty>Ingestion has not finished.</Empty>
          )}
        </section>

        <section>
          <SectionHead title="Today's model budget" />
          <div className="card">
            {budgetRow ? (
              <>
                <p style={{ fontSize: 12 }}>
                  {budgetSummary({
                    day: budgetRow.day,
                    tokensUsed: budgetRow.inputTokens + budgetRow.outputTokens,
                    requestsUsed: budgetRow.requests,
                    byTask: {},
                    dailyTokenLimit: Number(process.env.LLM_DAILY_TOKEN_LIMIT ?? 180_000),
                    dailyRequestLimit: Number(process.env.LLM_DAILY_REQUEST_LIMIT ?? 900),
                  })}
                </p>
                {modelRows.map((row) => (
                  <div className="claim" key={row.id}>
                    <span className="text mono">{row.model}</span>
                    <span className="dim mono" style={{ fontSize: 11 }}>
                      {row.requests} req · {(row.inputTokens + row.outputTokens).toLocaleString()} tok
                      {row.failures > 0 ? ` · ${row.failures} failed` : ""}
                    </span>
                  </div>
                ))}
              </>
            ) : (
              <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>
                No model calls today. Either no key is set, or every message so far was written deterministically.
              </p>
            )}
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <h3>Who gets billed</h3>
            <form action={assignClient}>
              <input type="hidden" name="campaignId" value={campaign.id} />
              <div className="field">
                <label htmlFor="clientId">Client</label>
                <select id="clientId" name="clientId" defaultValue={campaign.clientId ?? ""}>
                  <option value="">Nobody — measurement only</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>{client.name}</option>
                  ))}
                </select>
                <div className="help">
                  {billed
                    ? <>Month to date: <strong>{formatMoney(billed.invoice.totalCents, billed.invoice.currency)}</strong> from this client&apos;s campaigns. <a href="/billing">Billing</a></>
                    : <>Nothing is billed for this campaign. <a href="/billing">Set up a client</a> to charge per contact or per sale.</>}
                </div>
              </div>
              <button className="ghost" type="submit">Save</button>
            </form>
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <h3>Thresholds</h3>
            <form action={updateTargets}>
              <input type="hidden" name="campaignId" value={campaign.id} />
              <div className="field">
                <label htmlFor="targetLeads">Leads to work</label>
                <input id="targetLeads" name="targetLeads" type="number" min={1} max={500} defaultValue={campaign.targetLeads} />
              </div>
              <div className="field">
                <label htmlFor="minFitScore">Minimum fit score</label>
                <input id="minFitScore" name="minFitScore" type="number" min={0} max={100} defaultValue={campaign.minFitScore} />
              </div>
              <div className="field">
                <label htmlFor="meetingLink">Booking link</label>
                <input id="meetingLink" name="meetingLink" type="url" defaultValue={campaign.meetingLink ?? ""} />
              </div>
              <button className="ghost" type="submit">Save</button>
            </form>
          </div>

          {sender && (
            <div className="card" style={{ marginTop: 14 }}>
              <h3>Sender</h3>
              <dl className="kv">
                <dt>From</dt>
                <dd className="mono" style={{ fontSize: 12 }}>{sender.fromName} &lt;{sender.fromEmail}&gt;</dd>
                <dt>Address</dt>
                <dd style={{ fontSize: 12 }}>{sender.postalAddress}</dd>
                <dt>Opt-out</dt>
                <dd className="mono" style={{ fontSize: 11 }}>
                  {sender.unsubscribeUrl ?? <span className="dim">reply-to-stop only</span>}
                </dd>
                <dt>Suppressed</dt>
                <dd><a href="/suppressions">{suppressions} address(es)</a></dd>
              </dl>
            </div>
          )}
        </section>
      </div>

      {/* ── the ICP, editable ──────────────────────────────────────── */}

      {icp && (
        <section>
          <SectionHead title="Who it is looking for" note="you know your market better than a crawl does — edit freely" />
          <div className="card">
            <p style={{ fontSize: 13 }}>{icp.summary}</p>
            <div className="tags" style={{ marginBottom: 16 }}>
              {icp.preferredSources.map((source) => (
                <Pill key={source} tone="info">{source}</Pill>
              ))}
            </div>

            <form action={updateIcp}>
              <input type="hidden" name="campaignId" value={campaign.id} />
              <div className="grid cols-2">
                <div className="field">
                  <label htmlFor="painSignals">Pain signals</label>
                  <textarea id="painSignals" name="painSignals" rows={3} defaultValue={icp.painSignals.join(", ")} />
                  <div className="help">
                    Words a company with this problem writes about itself. These are what the evidence gate looks
                    for, so they matter more than anything else on this page.
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="negativeSignals">Competitor phrases</label>
                  <textarea id="negativeSignals" name="negativeSignals" rows={3} defaultValue={icp.negativeSignals.join(", ")} />
                  <div className="help">A company describing itself this way is a competitor and is never contacted.</div>
                </div>
                <div className="field">
                  <label htmlFor="positiveSignals">Positive signals</label>
                  <textarea id="positiveSignals" name="positiveSignals" rows={2} defaultValue={icp.positiveSignals.join(", ")} />
                </div>
                <div className="field">
                  <label htmlFor="industries">Industries</label>
                  <textarea id="industries" name="industries" rows={2} defaultValue={icp.industries.join(", ")} />
                  <div className="help">Leave empty and industry simply is not scored, rather than guessed.</div>
                </div>
                <div className="field">
                  <label htmlFor="buyerTitles">Buyer titles</label>
                  <textarea id="buyerTitles" name="buyerTitles" rows={2} defaultValue={icp.buyerTitles.join(", ")} />
                </div>
                <div className="field">
                  <label htmlFor="geographies">Geographies</label>
                  <textarea id="geographies" name="geographies" rows={2} defaultValue={icp.geographies.join(", ")} />
                  <div className="help">OpenStreetMap needs at least one place name to search.</div>
                </div>
                <div className="field">
                  <label htmlFor="sizeMin">Smallest company (people)</label>
                  <input id="sizeMin" name="sizeMin" type="number" min={1} defaultValue={icp.sizeMin} />
                </div>
                <div className="field">
                  <label htmlFor="sizeMax">Largest company (people)</label>
                  <input id="sizeMax" name="sizeMax" type="number" min={1} defaultValue={icp.sizeMax} />
                </div>
              </div>
              <button className="ghost" type="submit">Save ICP</button>
            </form>
          </div>
        </section>
      )}

      {/* ── audit log ──────────────────────────────────────────────── */}

      <section>
        <SectionHead
          title="What it did, and why"
          note={runs[0] ? `last tick ${ago(runs[0].startedAt)}${runs[0].ok ? "" : " — failed"}` : "never run"}
        />
        {events.length === 0 ? (
          <Empty>Nothing logged yet.</Empty>
        ) : (
          <div className="card scroll">
            <div className="log">
              {events.map((event) => (
                <div className="row" key={event.id} data-level={event.level}>
                  <span className="at">{clock(event.createdAt)}</span>
                  <span className="kind">{event.kind}</span>
                  <span className="msg">{event.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url.replace(/^offering:/, "");
  }
}
