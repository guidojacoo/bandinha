/**
 * Charging for outbound, per contact or per sale.
 *
 * The commercial shape this makes possible: you run the agent for somebody
 * else and bill them for what it produced, rather than paying $36k a year for
 * a seat and hoping. For that to be worth anything to either side, the units
 * have to be things that can be *proved* — and this is where the agent's
 * design pays off, because every gate it already has is also a billing
 * guarantee.
 *
 * The rule, which is the whole of it:
 *
 *   **A unit is billable only when the system holds the evidence for it.**
 *
 * A contact is billable when a message actually left for a deliverable
 * address — not when one was drafted, not when a lead was found. A meeting is
 * billable when a person confirmed the reply really was a meeting, because
 * the classifier is good and not perfect, and billing a client off a
 * classifier is how you lose the client. A sale is billable when a payment or
 * a countersignature says so, which is the same reason `agent/deals.ts`
 * refuses to let the agent write `won` on its own.
 *
 * Everything here is pure arithmetic over recorded facts, so an invoice can
 * be recomputed from the event log and will come out the same.
 */

export type BillableKind =
  | "contact_delivered"
  | "reply_received"
  | "meeting_confirmed"
  | "deal_won";

/** What has to be true before each unit may be charged for. */
export const BILLABLE_EVIDENCE: Record<BillableKind, string> = {
  contact_delivered:
    "A first message left for this prospect, to an address that passed the deliverability pre-flight.",
  reply_received:
    "A human being at the prospect replied — not a bounce, not an out-of-office.",
  meeting_confirmed:
    "A person confirmed that the reply really was a meeting. The classifier alone is not enough to bill on.",
  deal_won:
    "A payment or a countersignature closed it. The agent is never allowed to assert this.",
};

export const BILLABLE_LABEL: Record<BillableKind, string> = {
  contact_delivered: "Contacts delivered",
  reply_received: "Replies received",
  meeting_confirmed: "Meetings confirmed",
  deal_won: "Deals won",
};

/**
 * What the operator charges, in cents, per unit.
 *
 * Cents and integers throughout: an invoice that disagrees with itself by a
 * rounding error in the third decimal place is an invoice nobody trusts.
 */
export interface PricingTerms {
  currency: string;
  perContactCents: number;
  perReplyCents: number;
  perMeetingCents: number;
  perDealCents: number;
  /**
   * Share of a won deal's value, in basis points (100 = 1%).
   *
   * Basis points rather than a percentage float, for the same reason as
   * cents: 2.5% of £7,999 should be one number, not whichever one the
   * floating point gives today.
   */
  dealSharePoints: number;
  /** Charged regardless of output. Zero by default, because that is the pitch. */
  monthlyRetainerCents: number;
  /** Nothing is invoiced below this. Covers the cost of raising an invoice. */
  minimumInvoiceCents: number;
}

export const FREE_TERMS: PricingTerms = {
  currency: "USD",
  perContactCents: 0,
  perReplyCents: 0,
  perMeetingCents: 0,
  perDealCents: 0,
  dealSharePoints: 0,
  monthlyRetainerCents: 0,
  minimumInvoiceCents: 0,
};

/**
 * A sensible starting point for performance-priced outbound.
 *
 * Deliberately shaped so most of the money arrives on outcomes. Charging
 * mostly per contact rewards volume, which is exactly the behaviour the
 * research says destroys a sending domain — the price list should not be
 * pulling against the product's own gates.
 */
export const DEFAULT_TERMS: PricingTerms = {
  currency: "USD",
  perContactCents: 50,
  perReplyCents: 500,
  perMeetingCents: 5_000,
  perDealCents: 0,
  dealSharePoints: 1_000,
  monthlyRetainerCents: 0,
  minimumInvoiceCents: 2_500,
};

export interface BillableFact {
  id: string;
  kind: BillableKind;
  /** When the thing being charged for happened, not when it was invoiced. */
  occurredAt: Date;
  /** The lead it belongs to, so a client can audit a line. */
  leadDomain: string;
  leadName: string;
  contactEmail?: string;
  /** What the system holds as proof. Shown on the invoice. */
  evidence: string;
  /** Deal value in cents, for a share-priced win. */
  valueCents?: number;
}

export interface InvoiceLine {
  kind: BillableKind;
  label: string;
  quantity: number;
  /** Zero for a share-priced line, where the rate is a percentage. */
  unitCents: number;
  amountCents: number;
  /** Every fact behind this line, for the audit trail. */
  facts: BillableFact[];
  note?: string;
}

export interface Invoice {
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  lines: InvoiceLine[];
  subtotalCents: number;
  /** Set when the subtotal is below the minimum and nothing is being charged. */
  belowMinimum?: string;
  totalCents: number;
}

/**
 * Prices a single fact.
 *
 * A won deal with a share price and no recorded value prices at zero and says
 * so on the invoice. Guessing a deal size to bill a percentage of it would be
 * the billing equivalent of fabricating a proof point.
 */
export function priceFor(fact: BillableFact, terms: PricingTerms): { cents: number; note?: string } {
  switch (fact.kind) {
    case "contact_delivered":
      return { cents: terms.perContactCents };
    case "reply_received":
      return { cents: terms.perReplyCents };
    case "meeting_confirmed":
      return { cents: terms.perMeetingCents };
    case "deal_won": {
      const flat = terms.perDealCents;
      if (terms.dealSharePoints <= 0) return { cents: flat };
      if (fact.valueCents === undefined || fact.valueCents <= 0) {
        return {
          cents: flat,
          note: "No deal value recorded, so the revenue share is not charged. Record the value to bill it.",
        };
      }
      // Integer arithmetic, rounded once, at the end.
      const share = Math.round((fact.valueCents * terms.dealSharePoints) / 10_000);
      return { cents: flat + share };
    }
  }
}

const ORDER: BillableKind[] = ["contact_delivered", "reply_received", "meeting_confirmed", "deal_won"];

export function buildInvoice(
  facts: BillableFact[],
  terms: PricingTerms,
  period: { start: Date; end: Date },
): Invoice {
  const inPeriod = facts.filter(
    (fact) => fact.occurredAt >= period.start && fact.occurredAt < period.end,
  );

  const lines: InvoiceLine[] = [];
  for (const kind of ORDER) {
    const matching = inPeriod.filter((fact) => fact.kind === kind);
    if (matching.length === 0) continue;

    let amount = 0;
    const notes = new Set<string>();
    for (const fact of matching) {
      const priced = priceFor(fact, terms);
      amount += priced.cents;
      if (priced.note) notes.add(priced.note);
    }

    // A zero-priced line is still shown. The client should be able to see
    // what was delivered even where nothing is charged for it.
    lines.push({
      kind,
      label: BILLABLE_LABEL[kind],
      quantity: matching.length,
      unitCents: unitRate(kind, terms),
      amountCents: amount,
      facts: matching.slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()),
      note: notes.size > 0 ? [...notes].join(" ") : undefined,
    });
  }

  if (terms.monthlyRetainerCents > 0) {
    lines.unshift({
      kind: "contact_delivered",
      label: "Retainer",
      quantity: 1,
      unitCents: terms.monthlyRetainerCents,
      amountCents: terms.monthlyRetainerCents,
      facts: [],
      note: "Charged for the period regardless of output.",
    });
  }

  const subtotal = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const belowMinimum =
    subtotal > 0 && subtotal < terms.minimumInvoiceCents
      ? `${formatMoney(subtotal, terms.currency)} is below the ${formatMoney(terms.minimumInvoiceCents, terms.currency)} minimum, so nothing is being charged for this period.`
      : undefined;

  return {
    periodStart: period.start,
    periodEnd: period.end,
    currency: terms.currency,
    lines,
    subtotalCents: subtotal,
    belowMinimum,
    totalCents: belowMinimum ? 0 : subtotal,
  };
}

function unitRate(kind: BillableKind, terms: PricingTerms): number {
  switch (kind) {
    case "contact_delivered": return terms.perContactCents;
    case "reply_received": return terms.perReplyCents;
    case "meeting_confirmed": return terms.perMeetingCents;
    case "deal_won": return terms.perDealCents;
  }
}

/** Calendar month containing `date`, in UTC. */
export function monthOf(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

export function formatMoney(cents: number, currency = "USD"): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const major = Math.floor(absolute / 100);
  const minor = String(absolute % 100).padStart(2, "0");
  const symbol = SYMBOLS[currency.toUpperCase()] ?? "";
  const grouped = major.toLocaleString("en-US");
  return symbol
    ? `${sign}${symbol}${grouped}.${minor}`
    : `${sign}${grouped}.${minor} ${currency.toUpperCase()}`;
}

const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", ARS: "$" };

/**
 * The invoice as plain text, for sending.
 *
 * Plain text rather than a PDF because a PDF needs a library and a renderer,
 * and this has to stay free to run. Every line carries its evidence, so the
 * client can check the bill against reality rather than taking it on trust —
 * which is the same argument the product makes about its own copy.
 */
export function renderInvoice(
  invoice: Invoice,
  details: { from: string; to: string; reference: string; notes?: string },
): string {
  const out: string[] = [];
  const period = `${invoice.periodStart.toISOString().slice(0, 10)} to ${new Date(invoice.periodEnd.getTime() - 1).toISOString().slice(0, 10)}`;

  out.push(`INVOICE ${details.reference}`);
  out.push("");
  out.push(`From:   ${details.from}`);
  out.push(`To:     ${details.to}`);
  out.push(`Period: ${period}`);
  out.push("");

  if (invoice.lines.length === 0) {
    out.push("Nothing to charge for this period.");
    return out.join("\n");
  }

  out.push("Item                          Qty        Rate        Amount");
  out.push("".padEnd(60, "-"));
  for (const line of invoice.lines) {
    const rate = line.unitCents > 0 ? formatMoney(line.unitCents, invoice.currency) : "share";
    out.push(
      line.label.padEnd(30) +
      String(line.quantity).padStart(3) +
      rate.padStart(12) +
      formatMoney(line.amountCents, invoice.currency).padStart(14),
    );
    if (line.note) out.push(`  ${line.note}`);
  }
  out.push("".padEnd(60, "-"));
  out.push("Total".padEnd(33) + formatMoney(invoice.subtotalCents, invoice.currency).padStart(26));

  if (invoice.belowMinimum) {
    out.push("");
    out.push(invoice.belowMinimum);
    out.push("Due".padEnd(33) + formatMoney(0, invoice.currency).padStart(26));
  }

  out.push("");
  out.push("What you are being charged for");
  out.push("".padEnd(60, "-"));
  for (const line of invoice.lines) {
    if (line.facts.length === 0) continue;
    out.push(`${line.label}:`);
    for (const fact of line.facts) {
      out.push(`  ${fact.occurredAt.toISOString().slice(0, 10)}  ${fact.leadName} (${fact.leadDomain})`);
      out.push(`      ${fact.evidence}`);
    }
    out.push("");
  }

  if (details.notes) {
    out.push(details.notes);
  }
  return out.join("\n").trimEnd();
}
