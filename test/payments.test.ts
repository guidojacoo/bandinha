import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "../src/infra/db";
import { POST } from "../src/app/api/payments/[clientId]/route";
import { toJson } from "../src/lib/json";
import { DEFAULT_TERMS } from "../src/core/billing";
import { invoiceFor } from "../src/agent/billing";

/**
 * The payment webhook.
 *
 * The only route in the system that can mark a deal won, which makes its
 * signature check the one piece of security in the product that is doing
 * load-bearing work. Everything else here is advisory; this decides whether
 * money gets recorded.
 */

const SECRET = randomBytes(24).toString("hex");
let clientId = "";
let leadId = "";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

async function post(body: string, signature: string) {
  return POST(
    new Request(`http://localhost/api/payments/${clientId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mercurio-signature": signature },
      body,
    }),
    { params: Promise.resolve({ clientId }) },
  );
}

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { email: "payments-test@mercurio.test" },
    create: { email: "payments-test@mercurio.test", passwordHash: await bcrypt.hash("x".repeat(12), 4) },
    update: {},
  });

  const client = await db.client.create({
    data: {
      userId: user.id,
      name: "Payments Test Client",
      webhookSecret: SECRET,
      terms: toJson({ ...DEFAULT_TERMS, minimumInvoiceCents: 0, dealSharePoints: 1_000 }),
    },
  });
  clientId = client.id;

  const campaign = await db.campaign.create({
    data: {
      userId: user.id,
      clientId: client.id,
      sourceUrl: "http://seller.test/",
      name: "Payments Test",
      status: "running",
    },
  });

  const lead = await db.lead.create({
    data: {
      campaignId: campaign.id,
      domain: "payer.test",
      companyName: "Payer Ltd",
      url: "http://payer.test/",
      status: "enrolled",
      discoveredVia: "seed: test",
    },
  });
  leadId = lead.id;

  await db.deal.create({ data: { campaignId: campaign.id, leadId: lead.id, stage: "proposal" } });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: "payments-test@mercurio.test" } });
  await db.$disconnect();
});

describe("the signature is load-bearing", () => {
  it("refuses a request with no signature at all", async () => {
    const response = await post(JSON.stringify({ leadId }), "");
    expect(response.status).toBe(401);
    expect((await db.deal.findUnique({ where: { leadId } }))!.stage).toBe("proposal");
  });

  it("refuses a signature of the right length but the wrong value", async () => {
    const response = await post(JSON.stringify({ leadId }), "0".repeat(64));
    expect(response.status).toBe(401);
  });

  it("refuses a signature made with a different secret", async () => {
    const body = JSON.stringify({ leadId });
    const response = await post(body, sign(body, "not-the-secret"));
    expect(response.status).toBe(401);
  });

  it("refuses a valid signature over a different body", async () => {
    // Replaying a signature from one payload onto another is the attack the
    // raw-body read exists to stop.
    const signed = sign(JSON.stringify({ leadId, amountCents: 100 }));
    const response = await post(JSON.stringify({ leadId, amountCents: 10_000_000 }), signed);
    expect(response.status).toBe(401);
  });

  it("gives the same answer for an unknown client as for a bad signature", async () => {
    // A probe should not be able to enumerate which client ids exist.
    const response = await POST(
      new Request("http://localhost/api/payments/does-not-exist", {
        method: "POST",
        headers: { "x-mercurio-signature": "0".repeat(64) },
        body: "{}",
      }),
      { params: Promise.resolve({ clientId: "does-not-exist" }) },
    );
    expect(response.status).toBe(401);
  });

  it("accepts a sha256= prefix, which several providers send", async () => {
    const body = JSON.stringify({ domain: "nothing.test" });
    const response = await post(body, `sha256=${sign(body)}`);
    // 404 means the signature passed and the lead lookup failed.
    expect(response.status).toBe(404);
  });
});

describe("closing a deal", () => {
  it("closes it, records who closed it, and bills the share", async () => {
    const body = JSON.stringify({ leadId, amountCents: 500_000, reference: "pi_test_1" });
    const response = await post(body, sign(body));
    expect(response.status).toBe(200);

    const deal = await db.deal.findUnique({ where: { leadId } });
    expect(deal!.stage).toBe("won");
    expect(deal!.closedBy).toBe("payment");
    expect(deal!.paymentReference).toBe("pi_test_1");
    expect(deal!.valueCents).toBe(500_000);

    // 10% of $5,000.
    const { invoice } = await invoiceFor(clientId);
    const line = invoice.lines.find((l) => l.kind === "deal_won");
    expect(line!.amountCents).toBe(50_000);
    expect(line!.facts[0]!.evidence).toMatch(/Closed by a payment \(pi_test_1\)/);
  });

  it("treats a retried webhook as success, not a conflict", async () => {
    // Providers retry. A retry that looks like a failure gets retried harder.
    const body = JSON.stringify({ leadId, amountCents: 500_000, reference: "pi_test_1" });
    const response = await post(body, sign(body));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  });

  it("does not bill the same win twice", async () => {
    const { invoice } = await invoiceFor(clientId);
    expect(invoice.lines.find((l) => l.kind === "deal_won")!.quantity).toBe(1);
  });

  it("finds the lead by domain as well as by id", async () => {
    const body = JSON.stringify({ domain: "www.payer.test" });
    const response = await post(body, sign(body));
    // Already won, so 200 with the reason — but it resolved the lead.
    expect(response.status).toBe(200);
    expect((await response.json()).lead).toBe("payer.test");
  });

  it("404s for a lead that is not this client's", async () => {
    const body = JSON.stringify({ domain: "somebody-elses.test" });
    const response = await post(body, sign(body));
    expect(response.status).toBe(404);
  });

  it("rejects a body that is not JSON, after the signature passes", async () => {
    const body = "not json at all";
    const response = await post(body, sign(body));
    expect(response.status).toBe(400);
  });
});
