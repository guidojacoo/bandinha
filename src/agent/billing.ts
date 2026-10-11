import { db, logEvent } from "../infra/db";
import { fromJson } from "../lib/json";
import {
  BILLABLE_EVIDENCE, DEFAULT_TERMS, FREE_TERMS, buildInvoice, monthOf,
  type BillableFact, type BillableKind, type Invoice, type PricingTerms,
} from "../core/billing";
import { advanceStage } from "./deals";
import type { DealStage } from "../core/types";

/**
 * Raising charges from facts.
 *
 * Every function here is called *after* the thing it bills for has already
 * happened and been recorded. Nothing predicts, nothing estimates. The
 * guarantee is dull and it is the whole product: if there is a charge on the
 * invoice, there is a row in the database that caused it, and the client can
 * read it.
 *
 * `@@unique([clientId, leadId, kind])` does the heavy lifting. A four-touch
 * sequence raises one `contact_delivered`, not four. A prospect who replies
 * three times raises one `reply_received`. Double-billing is prevented by the
 * schema rather than by remembering to check, because remembering to check is
 * how people get billed twice.
 */

export async function termsFor(clientId: string | null): Promise<PricingTerms> {
  if (!clientId) return FREE_TERMS;
  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client) return FREE_TERMS;
  return { ...DEFAULT_TERMS, ...fromJson<Partial<PricingTerms>>(client.terms, {}) };
}

interface RaiseInput {
  campaignId: string;
  clientId: string | null;
  leadId: string;
  kind: BillableKind;
  occurredAt: Date;
  messageId?: string;
  valueCents?: number;
  /** Overrides the stock wording when there is something more specific to say. */
  evidence?: string;
}

/**
 * Records a chargeable unit, once.
 *
 * Returns false when there was nothing to record — no client, or this unit
 * has already been raised for this lead. Both are ordinary, so neither is an
 * error: a campaign with no client still runs, it just bills nobody.
 */
export async function raise(input: RaiseInput): Promise<boolean> {
  if (!input.clientId) return false;

  try {
    await db.billableEvent.create({
      data: {
        clientId: input.clientId,
        campaignId: input.campaignId,
        leadId: input.leadId,
        kind: input.kind,
        occurredAt: input.occurredAt,
        evidence: input.evidence ?? BILLABLE_EVIDENCE[input.kind],
        messageId: input.messageId,
        valueCents: input.valueCents,
      },
    });
    return true;
  } catch {
    // The unique constraint fired: already billed for this lead and kind.
    return false;
  }
}

/**
 * A delivered first contact.
 *
 * Only the first touch bills. Charging per message would pay the operator to
 * send a fourth email to somebody who ignored three, which is precisely the
 * behaviour the product's own gates exist to prevent — the price list should
 * not pull against them.
 */
export async function billContactDelivered(args: {
  campaignId: string;
  clientId: string | null;
  leadId: string;
  messageId: string;
  toEmail: string;
  sentAt: Date;
}): Promise<boolean> {
  return raise({
    campaignId: args.campaignId,
    clientId: args.clientId,
    leadId: args.leadId,
    kind: "contact_delivered",
    occurredAt: args.sentAt,
    messageId: args.messageId,
    evidence: `A message left for ${args.toEmail} on ${args.sentAt.toISOString().slice(0, 10)}, to an address that passed the deliverability pre-flight.`,
  });
}

/**
 * A reply from a human.
 *
 * Bounces and out-of-office notices are excluded by the caller, because
 * billing for a mailer-daemon response would be indefensible.
 */
export async function billReplyReceived(args: {
  campaignId: string;
  clientId: string | null;
  leadId: string;
  fromEmail: string;
  receivedAt: Date;
  intent: string;
}): Promise<boolean> {
  return raise({
    campaignId: args.campaignId,
    clientId: args.clientId,
    leadId: args.leadId,
    kind: "reply_received",
    occurredAt: args.receivedAt,
    evidence: `${args.fromEmail} replied on ${args.receivedAt.toISOString().slice(0, 10)}; read as "${args.intent}".`,
  });
}

/**
 * A meeting, once a person has confirmed it.
 *
 * Deliberately not raised from the classifier. `classifyReply` reading
 * "happy to chat, what times suit?" as a meeting request is right most of the
 * time, and most of the time is not a standard you can bill a client to.
 */
export async function billMeetingConfirmed(args: {
  campaignId: string;
  clientId: string | null;
  leadId: string;
  confirmedAt: Date;
  confirmedBy: string;
}): Promise<boolean> {
  return raise({
    campaignId: args.campaignId,
    clientId: args.clientId,
    leadId: args.leadId,
    kind: "meeting_confirmed",
    occurredAt: args.confirmedAt,
    evidence: `Confirmed as a real meeting by ${args.confirmedBy} on ${args.confirmedAt.toISOString().slice(0, 10)}.`,
  });
}

/**
 * A won deal.
 *
 * Reachable from exactly two places: the payment webhook, and an operator
 * closing it by hand in the console. The agent has no path to this function,
 * which is the same reason `agent/deals.ts` will not let it write `won`.
 */
export async function billDealWon(args: {
  campaignId: string;
  clientId: string | null;
  leadId: string;
  closedAt: Date;
  valueCents?: number;
  closedBy: "payment" | "operator";
  reference?: string;
}): Promise<boolean> {
  const how = args.closedBy === "payment"
    ? `Closed by a payment${args.reference ? ` (${args.reference})` : ""}`
    : "Closed by the operator";

  return raise({
    campaignId: args.campaignId,
    clientId: args.clientId,
    leadId: args.leadId,
    kind: "deal_won",
    occurredAt: args.closedAt,
    valueCents: args.valueCents,
    evidence: `${how} on ${args.closedAt.toISOString().slice(0, 10)}.`,
  });
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

export async function factsFor(clientId: string, period: { start: Date; end: Date }): Promise<BillableFact[]> {
  const rows = await db.billableEvent.findMany({
    where: { clientId, occurredAt: { gte: period.start, lt: period.end } },
    include: { lead: true },
    orderBy: { occurredAt: "asc" },
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as BillableKind,
    occurredAt: row.occurredAt,
    leadDomain: row.lead.domain,
    leadName: row.lead.companyName,
    evidence: row.evidence,
    valueCents: row.valueCents ?? undefined,
  }));
}

export async function invoiceFor(
  clientId: string,
  when: Date = new Date(),
): Promise<{ invoice: Invoice; terms: PricingTerms }> {
  const period = monthOf(when);
  const [terms, facts] = await Promise.all([termsFor(clientId), factsFor(clientId, period)]);
  return { invoice: buildInvoice(facts, terms, period), terms };
}

/**
 * Marks a period's events as invoiced.
 *
 * Separate from building the invoice so the console can show a running total
 * all month without stamping anything. Only called when an invoice is
 * actually issued.
 */
export async function markInvoiced(
  clientId: string,
  period: { start: Date; end: Date },
  reference: string,
): Promise<number> {
  const result = await db.billableEvent.updateMany({
    where: { clientId, occurredAt: { gte: period.start, lt: period.end }, invoicedAt: null },
    data: { invoicedAt: new Date(), invoiceRef: reference },
  });
  return result.count;
}

/** The running total, for the console's header. */
export async function monthToDate(clientId: string): Promise<{ invoice: Invoice; terms: PricingTerms }> {
  return invoiceFor(clientId, new Date());
}

/**
 * Closes a deal, and only from a source entitled to.
 *
 * The single place in the codebase that writes `stage: "won"`. It takes who
 * closed it as an argument rather than inferring it, so there is no default
 * that an agent code path could fall into.
 */
export async function closeDeal(args: {
  leadId: string;
  closedBy: "payment" | "operator";
  valueCents?: number;
  reference?: string;
  note?: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const deal = await db.deal.findUnique({
    where: { leadId: args.leadId },
    include: { lead: { include: { campaign: true } } },
  });
  if (!deal) return { ok: false, reason: "No deal for that lead." };
  if (deal.stage === "won") return { ok: false, reason: "Already won." };

  const closedAt = new Date();
  await db.deal.update({
    where: { leadId: args.leadId },
    data: {
      stage: "won",
      closedAt,
      closedBy: args.closedBy,
      paymentReference: args.reference,
      valueCents: args.valueCents ?? deal.valueCents,
      notes: args.note ?? deal.notes,
    },
  });

  await billDealWon({
    campaignId: deal.campaignId,
    clientId: deal.lead.campaign.clientId,
    leadId: args.leadId,
    closedAt,
    valueCents: args.valueCents ?? deal.valueCents ?? undefined,
    closedBy: args.closedBy,
    reference: args.reference,
  });

  await logEvent(deal.campaignId, "deal.won", `${deal.lead.companyName} closed by ${args.closedBy}.`, {
    level: "success",
    data: { leadId: args.leadId, valueCents: args.valueCents, reference: args.reference },
  });

  return { ok: true };
}

/** Confirms a meeting really happened, which is what makes it billable. */
export async function confirmMeeting(leadId: string, confirmedBy: string): Promise<{ ok: boolean; reason?: string }> {
  const deal = await db.deal.findUnique({
    where: { leadId },
    include: { lead: { include: { campaign: true } } },
  });
  if (!deal) return { ok: false, reason: "No deal for that lead." };
  if (deal.meetingConfirmedAt) return { ok: false, reason: "Already confirmed." };

  const confirmedAt = new Date();
  await db.deal.update({
    where: { leadId },
    data: {
      meetingConfirmedAt: confirmedAt,
      meetingAt: deal.meetingAt ?? confirmedAt,
      // Ratcheted through the same rule the derivation uses. This had its own
      // copy of it with only half the rule — "unless it is lost" — so
      // confirming a meeting on a prospect who had since asked for a contract
      // pulled the deal back a stage, and confirming one on a deal a payment
      // had already closed un-won it.
      stage: advanceStage(deal.stage as DealStage, "meeting_booked"),
    },
  });

  await billMeetingConfirmed({
    campaignId: deal.campaignId,
    clientId: deal.lead.campaign.clientId,
    leadId,
    confirmedAt,
    confirmedBy,
  });

  await logEvent(deal.campaignId, "meeting.confirmed", `Meeting with ${deal.lead.companyName} confirmed by ${confirmedBy}.`, {
    level: "success",
  });
  return { ok: true };
}
