import { describe, expect, it } from "vitest";
import {
  BILLABLE_EVIDENCE, DEFAULT_TERMS, FREE_TERMS, buildInvoice, formatMoney,
  monthOf, priceFor, renderInvoice, type BillableFact, type PricingTerms,
} from "../src/core/billing";

const TERMS: PricingTerms = {
  ...DEFAULT_TERMS,
  currency: "USD",
  perContactCents: 50,
  perReplyCents: 500,
  perMeetingCents: 5_000,
  perDealCents: 0,
  dealSharePoints: 1_000,
  minimumInvoiceCents: 2_500,
};

const MARCH = monthOf(new Date("2026-03-15T00:00:00Z"));

function fact(over: Partial<BillableFact> = {}): BillableFact {
  return {
    id: Math.random().toString(36).slice(2),
    kind: "contact_delivered",
    occurredAt: new Date("2026-03-10T10:00:00Z"),
    leadDomain: "fableworks.test",
    leadName: "Fableworks",
    contactEmail: "lena@fableworks.test",
    evidence: BILLABLE_EVIDENCE.contact_delivered,
    ...over,
  };
}

describe("priceFor", () => {
  it.each([
    ["contact_delivered", 50],
    ["reply_received", 500],
    ["meeting_confirmed", 5_000],
  ] as const)("charges %s at its rate", (kind, cents) => {
    expect(priceFor(fact({ kind }), TERMS).cents).toBe(cents);
  });

  it("takes a share of a won deal", () => {
    // 10% of $8,000.
    const priced = priceFor(fact({ kind: "deal_won", valueCents: 800_000 }), TERMS);
    expect(priced.cents).toBe(80_000);
  });

  it("refuses to guess a deal value it was not given", () => {
    // Inventing a deal size to bill a percentage of it is the billing
    // equivalent of fabricating a proof point.
    const priced = priceFor(fact({ kind: "deal_won" }), TERMS);
    expect(priced.cents).toBe(0);
    expect(priced.note).toMatch(/No deal value recorded/);
  });

  it("charges a flat deal fee when there is no share", () => {
    const flat = { ...TERMS, dealSharePoints: 0, perDealCents: 25_000 };
    expect(priceFor(fact({ kind: "deal_won" }), flat).cents).toBe(25_000);
  });

  it("rounds a share once, at the end", () => {
    // 2.5% of $79.99 is 199.975 cents. One rounding, not three.
    const terms = { ...TERMS, dealSharePoints: 250 };
    expect(priceFor(fact({ kind: "deal_won", valueCents: 7_999 }), terms).cents).toBe(200);
  });

  it("charges nothing on free terms", () => {
    for (const kind of ["contact_delivered", "reply_received", "meeting_confirmed", "deal_won"] as const) {
      expect(priceFor(fact({ kind, valueCents: 500_000 }), FREE_TERMS).cents).toBe(0);
    }
  });
});

describe("buildInvoice", () => {
  const facts = [
    ...Array.from({ length: 40 }, () => fact()),
    fact({ kind: "reply_received", evidence: BILLABLE_EVIDENCE.reply_received }),
    fact({ kind: "reply_received", evidence: BILLABLE_EVIDENCE.reply_received }),
    fact({ kind: "meeting_confirmed", evidence: BILLABLE_EVIDENCE.meeting_confirmed }),
  ];

  const invoice = buildInvoice(facts, TERMS, MARCH);

  it("totals the period", () => {
    // 40 contacts at 50c, 2 replies at $5, 1 meeting at $50.
    expect(invoice.subtotalCents).toBe(40 * 50 + 2 * 500 + 5_000);
    expect(invoice.totalCents).toBe(invoice.subtotalCents);
  });

  it("groups by what was delivered, in pipeline order", () => {
    expect(invoice.lines.map((l) => l.kind)).toEqual([
      "contact_delivered", "reply_received", "meeting_confirmed",
    ]);
  });

  it("carries the evidence for every line", () => {
    for (const line of invoice.lines) {
      expect(line.facts).toHaveLength(line.quantity);
      for (const f of line.facts) expect(f.evidence.length).toBeGreaterThan(20);
    }
  });

  it("excludes anything outside the period", () => {
    const withStrays = [
      ...facts,
      fact({ occurredAt: new Date("2026-02-28T23:59:59Z") }),
      fact({ occurredAt: new Date("2026-04-01T00:00:00Z") }),
    ];
    expect(buildInvoice(withStrays, TERMS, MARCH).subtotalCents).toBe(invoice.subtotalCents);
  });

  it("includes the last instant of the period and excludes the first of the next", () => {
    const edge = [
      fact({ occurredAt: new Date("2026-03-01T00:00:00.000Z") }),
      fact({ occurredAt: new Date("2026-03-31T23:59:59.999Z") }),
      fact({ occurredAt: new Date("2026-04-01T00:00:00.000Z") }),
    ];
    expect(buildInvoice(edge, TERMS, MARCH).lines[0]!.quantity).toBe(2);
  });

  it("charges nothing below the minimum, and says why", () => {
    const thin = buildInvoice([fact(), fact()], TERMS, MARCH);
    expect(thin.subtotalCents).toBe(100);
    expect(thin.totalCents).toBe(0);
    expect(thin.belowMinimum).toMatch(/below the \$25\.00 minimum/);
  });

  it("produces an empty invoice rather than failing on a quiet month", () => {
    const empty = buildInvoice([], TERMS, MARCH);
    expect(empty.lines).toEqual([]);
    expect(empty.totalCents).toBe(0);
    expect(empty.belowMinimum).toBeUndefined();
  });

  it("shows a zero-priced line rather than hiding the work", () => {
    const free = buildInvoice([fact(), fact()], { ...FREE_TERMS, minimumInvoiceCents: 0 }, MARCH);
    expect(free.lines[0]!.quantity).toBe(2);
    expect(free.lines[0]!.amountCents).toBe(0);
  });

  it("adds a retainer above the delivered lines when there is one", () => {
    const withRetainer = buildInvoice(facts, { ...TERMS, monthlyRetainerCents: 50_000 }, MARCH);
    expect(withRetainer.lines[0]!.label).toBe("Retainer");
    expect(withRetainer.subtotalCents).toBe(invoice.subtotalCents + 50_000);
  });

  it("recomputes identically from the same facts", () => {
    // An invoice that cannot be rebuilt from the log is one nobody can audit.
    expect(buildInvoice(facts, TERMS, MARCH)).toEqual(invoice);
  });
});

describe("renderInvoice", () => {
  const invoice = buildInvoice(
    [
      fact(),
      fact({ kind: "reply_received", evidence: BILLABLE_EVIDENCE.reply_received, leadName: "Meridian Pay", leadDomain: "meridianpay.test" }),
      fact({ kind: "meeting_confirmed", evidence: BILLABLE_EVIDENCE.meeting_confirmed }),
    ],
    TERMS,
    MARCH,
  );

  const text = renderInvoice(invoice, {
    from: "You Ltd, 4 Dock Street, Bristol",
    to: "Northwind Software Ltd",
    reference: "2026-03-001",
    notes: "Payable within 14 days.",
  });

  it("names the parties, the period and the reference", () => {
    expect(text).toContain("INVOICE 2026-03-001");
    expect(text).toContain("Northwind Software Ltd");
    expect(text).toContain("2026-03-01 to 2026-03-31");
  });

  it("lists every charge with its rate", () => {
    expect(text).toMatch(/Contacts delivered\s+1\s+\$0\.50/);
    expect(text).toMatch(/Meetings confirmed\s+1\s+\$50\.00/);
  });

  it("shows the evidence for each line, so the bill can be checked", () => {
    expect(text).toContain("What you are being charged for");
    expect(text).toContain("Meridian Pay (meridianpay.test)");
    expect(text).toContain(BILLABLE_EVIDENCE.reply_received);
  });

  it("states a zero due when the period is below the minimum", () => {
    const thin = renderInvoice(buildInvoice([fact()], TERMS, MARCH), {
      from: "a", to: "b", reference: "r",
    });
    expect(thin).toMatch(/below the \$25\.00 minimum/);
    expect(thin).toMatch(/Due\s+\$0\.00/);
  });

  it("says plainly when there is nothing to bill", () => {
    expect(renderInvoice(buildInvoice([], TERMS, MARCH), { from: "a", to: "b", reference: "r" }))
      .toContain("Nothing to charge");
  });
});

describe("formatMoney", () => {
  it.each([
    [0, "$0.00"],
    [5, "$0.05"],
    [50, "$0.50"],
    [100, "$1.00"],
    [123_456, "$1,234.56"],
    [-250, "-$2.50"],
  ])("formats %i as %s", (cents, expected) => {
    expect(formatMoney(cents)).toBe(expected);
  });

  it("uses the right symbol per currency", () => {
    expect(formatMoney(1_000, "EUR")).toBe("€10.00");
    expect(formatMoney(1_000, "GBP")).toBe("£10.00");
  });

  it("falls back to a currency code it does not know", () => {
    expect(formatMoney(1_000, "JPY")).toBe("10.00 JPY");
  });
});

describe("monthOf", () => {
  it("spans a calendar month in UTC", () => {
    const march = monthOf(new Date("2026-03-15T12:00:00Z"));
    expect(march.start.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(march.end.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });

  it("rolls the year over in December", () => {
    expect(monthOf(new Date("2026-12-20T00:00:00Z")).end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("what may be billed", () => {
  it("states the evidence required for every unit", () => {
    for (const kind of ["contact_delivered", "reply_received", "meeting_confirmed", "deal_won"] as const) {
      expect(BILLABLE_EVIDENCE[kind].length).toBeGreaterThan(40);
    }
  });

  it("requires a human for a meeting and a payment for a win", () => {
    // The two units the agent is not allowed to assert on its own.
    expect(BILLABLE_EVIDENCE.meeting_confirmed).toMatch(/person confirmed/i);
    expect(BILLABLE_EVIDENCE.deal_won).toMatch(/never allowed to assert/i);
  });
});
