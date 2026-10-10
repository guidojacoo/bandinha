import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "../../../../infra/db";
import { closeDeal } from "../../../../agent/billing";

/**
 * The payment webhook.
 *
 * The only thing in the system — other than an operator clicking a button —
 * that can mark a deal won. That is the point: `agent/deals.ts` refuses to
 * let the agent assert a close, and this is the counterpart that makes the
 * refusal workable rather than merely principled. Something that actually
 * took money says so, and the deal closes.
 *
 * Provider-agnostic on purpose. Stripe, Lemon Squeezy, Mollie, a bank's own
 * notification, or a shell script after a wire transfer clears — anything
 * that can POST JSON and sign it with a shared secret. Tying this to one
 * provider's SDK would put a dependency, and usually an account, in front of
 * the one feature that closes the loop.
 *
 * Signature: HMAC-SHA256 of the raw body, hex, in `x-mercurio-signature`.
 * Compared in constant time, because comparing with `===` leaks the secret
 * one byte at a time to anyone patient enough to measure.
 */

interface PaymentPayload {
  /** The lead whose deal this pays for. */
  leadId?: string;
  /** Or the domain, which is friendlier to configure by hand. */
  domain?: string;
  amountCents?: number;
  currency?: string;
  reference?: string;
  note?: string;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ clientId: string }> },
): Promise<NextResponse> {
  const { clientId } = await context.params;

  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client) {
    // Deliberately the same answer as a bad signature: a probe should not be
    // able to enumerate which client ids exist.
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }
  if (!client.webhookSecret) {
    return NextResponse.json(
      { error: "No webhook secret is set for this client, so payment notifications are refused." },
      { status: 403 },
    );
  }

  // The raw body, read once. Re-serialising parsed JSON before verifying
  // would compare a signature against different bytes than were signed.
  const raw = await request.text();
  const provided = request.headers.get("x-mercurio-signature") ?? "";
  if (!verify(raw, provided, client.webhookSecret)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 401 });
  }

  let payload: PaymentPayload;
  try {
    payload = JSON.parse(raw) as PaymentPayload;
  } catch {
    return NextResponse.json({ error: "Body was not JSON." }, { status: 400 });
  }

  const lead = payload.leadId
    ? await db.lead.findFirst({ where: { id: payload.leadId, campaign: { clientId } } })
    : payload.domain
      ? await db.lead.findFirst({
          where: { domain: payload.domain.toLowerCase().replace(/^www\./, ""), campaign: { clientId } },
          orderBy: { createdAt: "desc" },
        })
      : null;

  if (!lead) {
    return NextResponse.json(
      { error: "No lead of this client matches that leadId or domain." },
      { status: 404 },
    );
  }

  const result = await closeDeal({
    leadId: lead.id,
    closedBy: "payment",
    valueCents: typeof payload.amountCents === "number" && payload.amountCents > 0 ? Math.round(payload.amountCents) : undefined,
    reference: payload.reference,
    note: payload.note,
  });

  if (!result.ok) {
    // "Already won" is a success as far as the sender is concerned: webhooks
    // are retried, and a retry must not look like a failure.
    const already = result.reason === "Already won.";
    return NextResponse.json(
      { ok: already, lead: lead.domain, reason: result.reason },
      { status: already ? 200 : 409 },
    );
  }

  return NextResponse.json({ ok: true, lead: lead.domain, stage: "won" });
}

function verify(body: string, provided: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided.trim().replace(/^sha256=/, ""), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** A GET returns what to configure, which saves a trip to the docs. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ clientId: string }> },
): Promise<NextResponse> {
  const { clientId } = await context.params;
  const client = await db.client.findUnique({ where: { id: clientId } });
  if (!client) return NextResponse.json({ error: "Not found." }, { status: 404 });

  return NextResponse.json({
    client: client.name,
    configured: Boolean(client.webhookSecret),
    method: "POST",
    headers: { "x-mercurio-signature": "hex HMAC-SHA256 of the raw body, using the client's webhook secret" },
    body: { leadId: "or domain", amountCents: 0, currency: client.terms ? undefined : "USD", reference: "your payment id" },
    note: "This is the only route that can mark a deal won. The agent has no path to it.",
  });
}
