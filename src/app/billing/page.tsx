import { redirect } from "next/navigation";
import { db } from "../../infra/db";
import { readSession } from "../../lib/auth";
import { fromJson } from "../../lib/json";
import {
  BILLABLE_EVIDENCE, DEFAULT_TERMS, formatMoney, monthOf, renderInvoice,
  type PricingTerms,
} from "../../core/billing";
import { invoiceFor } from "../../agent/billing";
import { Empty, Metric, Pill, SectionHead, ago } from "../../components/ui";
import {
  closeDealAction, confirmMeetingAction, createClient, issueInvoice,
  rotateWebhookSecret, updateTerms,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * What the agent earned, and the evidence for every line of it.
 *
 * The page is built around the claim that makes performance pricing
 * defensible: each charge points at the thing that caused it. A client who
 * can read the bill against reality does not have to trust the bill.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string; issued?: string; ref?: string; error?: string }>;
}) {
  const session = await readSession().catch(() => null);
  if (!session) redirect("/login");

  const params = await searchParams;
  const clients = await db.client.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "asc" },
    take: 200,
    include: { _count: { select: { campaigns: true, events: true } } },
  });

  const selected = clients.find((c) => c.id === params.client) ?? clients[0];
  const period = monthOf(new Date());

  const billed = selected ? await invoiceFor(selected.id) : null;
  const terms: PricingTerms = selected
    ? { ...DEFAULT_TERMS, ...fromJson<Partial<PricingTerms>>(selected.terms, {}) }
    : DEFAULT_TERMS;

  const unpaidLeads = selected
    ? await db.deal.findMany({
        where: { campaign: { clientId: selected.id }, stage: { in: ["engaged", "meeting_booked", "proposal"] } },
        include: { lead: true },
        orderBy: { updatedAt: "desc" },
        take: 12,
      })
    : [];

  return (
    <main>
      <h1>Billing</h1>
      <p className="lede">
        Charge per contact delivered, per reply, per confirmed meeting, or as a share of a closed deal. Every
        unit on an invoice points at the thing that caused it — a message that actually sent, a reply a person
        wrote, a payment that actually arrived.
      </p>

      {params.issued && (
        <div className="banner good">
          Invoice <strong>{params.ref}</strong> issued; {params.issued} event(s) stamped. They will not appear
          on a later invoice.
        </div>
      )}
      {params.error === "name" && <div className="banner bad">A client needs a name.</div>}

      {clients.length === 0 ? (
        <section>
          <SectionHead title="No clients yet" />
          <div className="grid split">
            <div className="card">
              <p style={{ fontSize: 13 }}>
                A client is whoever gets the invoice. If you are selling your own product, add yourself with
                zero prices — the units are still counted, so you can see what the agent produced without
                charging anybody.
              </p>
              <p style={{ fontSize: 13, marginBottom: 0 }}>
                If you are running outbound for somebody else, this is where the money comes from: they pay for
                what the agent delivered rather than for a seat.
              </p>
            </div>
            <NewClientForm />
          </div>
        </section>
      ) : (
        <>
          <section>
            <SectionHead
              title="Clients"
              note={`${period.start.toISOString().slice(0, 7)} month to date`}
            />
            <div className="card" style={{ padding: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th className="num">Campaigns</th>
                    <th className="num">Units billed</th>
                    <th>Pricing</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {clients.map((client) => (
                    <tr key={client.id}>
                      <td>
                        <a href={`/billing?client=${client.id}`} style={{ fontWeight: client.id === selected?.id ? 600 : 400 }}>
                          {client.name}
                        </a>
                        {client.contactEmail && <span className="reason mono">{client.contactEmail}</span>}
                      </td>
                      <td className="num">{client._count.campaigns}</td>
                      <td className="num">{client._count.events}</td>
                      <td className="dim" style={{ fontSize: 12 }}>
                        {describeTerms({ ...DEFAULT_TERMS, ...fromJson<Partial<PricingTerms>>(client.terms, {}) })}
                      </td>
                      <td>{client.id === selected?.id && <Pill tone="info" dot>viewing</Pill>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {selected && billed && (
            <>
              <section>
                <SectionHead
                  title={`${selected.name} — month to date`}
                  note={billed.invoice.belowMinimum ? "below the minimum, so nothing is due" : undefined}
                />
                <div className="grid cols-4">
                  {billed.invoice.lines.map((line) => (
                    <Metric
                      key={line.label}
                      value={line.quantity}
                      label={line.label}
                      hint={formatMoney(line.amountCents, billed.invoice.currency)}
                      tone={line.kind === "deal_won" ? "good" : line.kind === "meeting_confirmed" ? "warn" : undefined}
                    />
                  ))}
                  <Metric
                    value={formatMoney(billed.invoice.totalCents, billed.invoice.currency)}
                    label="Due"
                    tone={billed.invoice.totalCents > 0 ? "good" : undefined}
                    hint={billed.invoice.belowMinimum ? "below minimum" : undefined}
                  />
                </div>
                {billed.invoice.lines.length === 0 && (
                  <Empty>Nothing billable this month yet. Units appear here as the agent produces them.</Empty>
                )}
              </section>

              {billed.invoice.lines.length > 0 && (
                <section>
                  <SectionHead title="The invoice" note="every line carries its evidence" />
                  <div className="card">
                    <pre className="email" style={{ margin: 0 }}>
                      {renderInvoice(billed.invoice, {
                        from: "You",
                        to: [selected.name, selected.billingAddress].filter(Boolean).join(", "),
                        reference: `${period.start.toISOString().slice(0, 7)}-${selected.id.slice(-6)}`,
                        notes: "Every line above can be checked against the messages in this console.",
                      })}
                    </pre>
                    <form action={issueInvoice} style={{ marginTop: 14 }}>
                      <input type="hidden" name="clientId" value={selected.id} />
                      <div className="actions">
                        <button type="submit">Issue this invoice</button>
                        <span className="dim" style={{ fontSize: 12 }}>
                          Stamps these events so they cannot appear on a later invoice. It does not send anything.
                        </span>
                      </div>
                    </form>
                  </div>
                </section>
              )}

              <section>
                <SectionHead title="Open deals" note="a meeting is billable once you confirm it really happened" />
                {unpaidLeads.length === 0 ? (
                  <Empty>No open deals for this client.</Empty>
                ) : (
                  <div className="card" style={{ padding: 0 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Company</th>
                          <th>Stage</th>
                          <th>Meeting</th>
                          <th>Updated</th>
                          <th>Close it</th>
                        </tr>
                      </thead>
                      <tbody>
                        {unpaidLeads.map((deal) => (
                          <tr key={deal.id}>
                            <td>
                              <strong style={{ fontWeight: 560 }}>{deal.lead.companyName}</strong>
                              <span className="reason mono">{deal.lead.domain}</span>
                            </td>
                            <td><Pill dot>{deal.stage.replace(/_/g, " ")}</Pill></td>
                            <td>
                              {deal.meetingConfirmedAt ? (
                                <Pill tone="good">confirmed</Pill>
                              ) : (
                                <ConfirmMeeting leadId={deal.leadId} />
                              )}
                            </td>
                            <td className="dim nowrap">{ago(deal.updatedAt)}</td>
                            <td><CloseDeal leadId={deal.leadId} currency={terms.currency} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <div className="grid split">
                <section>
                  <SectionHead title="Pricing" />
                  <div className="card">
                    <form action={updateTerms}>
                      <input type="hidden" name="clientId" value={selected.id} />
                      <div className="grid cols-2">
                        <MoneyField name="perContact" label="Per contact delivered" cents={terms.perContactCents} help="A first message that actually left for a deliverable address. Later touches in the same sequence are not charged." />
                        <MoneyField name="perReply" label="Per reply received" cents={terms.perReplyCents} help="From a human. Bounces and out-of-office notices are excluded." />
                        <MoneyField name="perMeeting" label="Per confirmed meeting" cents={terms.perMeetingCents} help="Only after you confirm it. The classifier alone is not a standard to bill on." />
                        <MoneyField name="perDeal" label="Flat fee per won deal" cents={terms.perDealCents} />
                        <div className="field">
                          <label htmlFor="dealSharePercent">Share of a won deal (%)</label>
                          <input id="dealSharePercent" name="dealSharePercent" type="text" defaultValue={(terms.dealSharePoints / 100).toString()} />
                          <div className="help">Charged only when a deal value was recorded. No value, no share — guessing one would be the billing version of inventing a proof point.</div>
                        </div>
                        <MoneyField name="monthlyRetainer" label="Monthly retainer" cents={terms.monthlyRetainerCents} help="Charged regardless of output. Zero by default, because that is the pitch." />
                        <MoneyField name="minimumInvoice" label="Minimum invoice" cents={terms.minimumInvoiceCents} help="Below this nothing is charged for the period." />
                        <div className="field">
                          <label htmlFor="currency">Currency</label>
                          <input id="currency" name="currency" type="text" defaultValue={terms.currency} maxLength={3} />
                        </div>
                      </div>
                      <button className="ghost" type="submit">Save pricing</button>
                    </form>
                  </div>
                </section>

                <section>
                  <SectionHead title="Getting paid" />
                  <div className="card">
                    <h3>The payment webhook</h3>
                    <p style={{ fontSize: 12 }}>
                      The only route that can mark a deal won. Point any provider at it — Stripe, Lemon Squeezy,
                      Mollie, a bank notification, or a script you run after a transfer clears. It signs with a
                      shared secret rather than a provider SDK, so no account is required to close the loop.
                    </p>
                    <div className="field">
                      <label>Endpoint</label>
                      <input readOnly value={`POST /api/payments/${selected.id}`} />
                    </div>
                    <div className="field">
                      <label>Signature header</label>
                      <input readOnly value="x-mercurio-signature: <hex HMAC-SHA256 of the raw body>" />
                    </div>
                    <div className="field">
                      <label>Secret</label>
                      <input readOnly type="password" value={selected.webhookSecret ?? ""} />
                      <div className="help">
                        Shown masked. Rotating it invalidates the old one immediately.
                      </div>
                    </div>
                    <form action={rotateWebhookSecret}>
                      <input type="hidden" name="clientId" value={selected.id} />
                      <button className="ghost" type="submit">Rotate secret</button>
                    </form>
                  </div>

                  <div className="card" style={{ marginTop: 14 }}>
                    <h3>What is billable, and why</h3>
                    {(Object.keys(BILLABLE_EVIDENCE) as Array<keyof typeof BILLABLE_EVIDENCE>).map((kind) => (
                      <div className="claim" key={kind}>
                        <span className="text">
                          <strong style={{ fontWeight: 560 }}>{kind.replace(/_/g, " ")}</strong>
                          <span className="reason">{BILLABLE_EVIDENCE[kind]}</span>
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="card" style={{ marginTop: 14 }}>
                    <h3>What costs money</h3>
                    <p style={{ fontSize: 12, marginBottom: 0 }}>
                      Running the agent is free: open data for leads, a free model tier, SQLite on disk, your own
                      SMTP. Raising an invoice is free — it is plain text with the evidence attached.{" "}
                      <strong>Collecting</strong> is the one thing that is not: every payment rail takes a
                      percentage. That is the honest edge of the claim, and no amount of engineering removes it.
                    </p>
                  </div>
                </section>
              </div>

              <section>
                <SectionHead title="Add another client" />
                <div className="grid split">
                  <NewClientForm />
                  <div />
                </div>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

function MoneyField({ name, label, cents, help }: { name: string; label: string; cents: number; help?: string }) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} type="text" defaultValue={(cents / 100).toFixed(2)} />
      {help && <div className="help">{help}</div>}
    </div>
  );
}

function NewClientForm() {
  return (
    <div className="card">
      <h3>New client</h3>
      <form action={createClient}>
        <div className="field">
          <label htmlFor="name">Name</label>
          <input id="name" name="name" type="text" placeholder="Northwind Software Ltd" required />
        </div>
        <div className="field">
          <label htmlFor="contactEmail">Billing email</label>
          <input id="contactEmail" name="contactEmail" type="email" placeholder="ap@northwind.test" />
        </div>
        <div className="field">
          <label htmlFor="billingAddress">Billing address</label>
          <input id="billingAddress" name="billingAddress" type="text" />
        </div>
        <div className="grid cols-2">
          <MoneyField name="perContact" label="Per contact" cents={DEFAULT_TERMS.perContactCents} />
          <MoneyField name="perReply" label="Per reply" cents={DEFAULT_TERMS.perReplyCents} />
          <MoneyField name="perMeeting" label="Per meeting" cents={DEFAULT_TERMS.perMeetingCents} />
          <div className="field">
            <label htmlFor="dealSharePercent">Deal share (%)</label>
            <input id="dealSharePercent" name="dealSharePercent" type="text" defaultValue={(DEFAULT_TERMS.dealSharePoints / 100).toString()} />
          </div>
        </div>
        <button type="submit">Add client</button>
      </form>
    </div>
  );
}

function ConfirmMeeting({ leadId }: { leadId: string }) {
  return (
    <form action={confirmMeetingAction}>
      <input type="hidden" name="leadId" value={leadId} />
      <button className="ghost" type="submit">Confirm</button>
    </form>
  );
}

function CloseDeal({ leadId, currency }: { leadId: string; currency: string }) {
  return (
    <form action={closeDealAction} className="actions">
      <input type="hidden" name="leadId" value={leadId} />
      <input name="amount" type="text" placeholder={`value (${currency})`} style={{ width: 110 }} aria-label="Deal value" />
      <button className="ghost" type="submit">Won</button>
    </form>
  );
}

function describeTerms(terms: PricingTerms): string {
  const parts: string[] = [];
  if (terms.perContactCents > 0) parts.push(`${formatMoney(terms.perContactCents, terms.currency)}/contact`);
  if (terms.perReplyCents > 0) parts.push(`${formatMoney(terms.perReplyCents, terms.currency)}/reply`);
  if (terms.perMeetingCents > 0) parts.push(`${formatMoney(terms.perMeetingCents, terms.currency)}/meeting`);
  if (terms.dealSharePoints > 0) parts.push(`${terms.dealSharePoints / 100}% of won deals`);
  if (terms.monthlyRetainerCents > 0) parts.push(`${formatMoney(terms.monthlyRetainerCents, terms.currency)}/month`);
  return parts.length > 0 ? parts.join(" · ") : "measurement only, nothing charged";
}
