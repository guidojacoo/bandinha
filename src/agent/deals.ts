import type { PrismaClient } from "@/generated/prisma";
import { logEvent, prisma as defaultPrisma } from "../infra/db";

/**
 * Closing.
 *
 * The agent can carry a deal all the way to a signature — it finds the
 * company, starts the conversation, handles the objection, answers the
 * pricing question and puts the paperwork in front of someone. What it
 * cannot do is decide that money arrived.
 *
 * So `won` is only ever set by an observed external fact: a payment webhook,
 * a signed-contract callback, or an operator saying so. An agent allowed to
 * mark its own deals won produces a pipeline that measures its own optimism
 * and nothing else.
 */

export type CloseConfirmation =
  | { by: "operator"; userId: string }
  | { by: "payment"; provider: string; reference: string }
  | { by: "contract"; provider: string; reference: string };

export async function markWon(
  dealId: string,
  confirmation: CloseConfirmation,
  options: { valueCents?: number; note?: string; db?: PrismaClient } = {},
): Promise<void> {
  const db = options.db ?? defaultPrisma;
  const deal = await db.deal.update({
    where: { id: dealId },
    data: {
      stage: "won",
      closedAt: new Date(),
      valueCents: options.valueCents,
      notes: options.note,
    },
    include: { lead: true },
  });

  // Stop every cadence for this company the moment it becomes a customer.
  await db.enrollment.updateMany({
    where: { leadId: deal.leadId, state: { notIn: ["unsubscribed", "bounced"] } },
    data: { state: "won", nextDueAt: null },
  });

  const how =
    confirmation.by === "operator"
      ? "confirmed by the operator"
      : `confirmed by ${confirmation.by} (${confirmation.provider} ${confirmation.reference})`;
  await logEvent(deal.campaignId, "deal.won", `${deal.lead.companyName} — won, ${how}.`, confirmation);
}

export async function markLost(
  dealId: string,
  reason: string,
  options: { db?: PrismaClient } = {},
): Promise<void> {
  const db = options.db ?? defaultPrisma;
  const deal = await db.deal.update({
    where: { id: dealId },
    data: { stage: "lost", closedAt: new Date(), lostReason: reason },
    include: { lead: true },
  });
  await db.enrollment.updateMany({
    where: { leadId: deal.leadId, state: { notIn: ["unsubscribed", "bounced"] } },
    data: { state: "lost", nextDueAt: null },
  });
  await logEvent(deal.campaignId, "deal.lost", `${deal.lead.companyName} — lost: ${reason}.`);
}

/** Releases a drafted reply that was held for human review. */
export async function approveMessage(
  messageId: string,
  options: { db?: PrismaClient } = {},
): Promise<void> {
  const db = options.db ?? defaultPrisma;
  const message = await db.message.update({
    where: { id: messageId },
    data: { status: "queued" },
  });
  await logEvent(message.campaignId, "message.approved", `Approved reply to ${message.toEmail}.`);
}

export async function discardMessage(
  messageId: string,
  options: { db?: PrismaClient } = {},
): Promise<void> {
  const db = options.db ?? defaultPrisma;
  const message = await db.message.update({
    where: { id: messageId },
    data: { status: "blocked", blockedCode: "discarded", blockedReason: "Discarded by the operator." },
  });
  await logEvent(message.campaignId, "message.discarded", `Operator discarded a reply to ${message.toEmail}.`);
}
