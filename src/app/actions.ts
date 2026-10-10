"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSession, destroySession, ownedCampaign, readSession, verifyPassword } from "../lib/auth";
import { db, logEvent } from "../infra/db";
import { toJson, fromJson } from "../lib/json";
import { ingest } from "../agent/ingest";
import { tick } from "../agent/orchestrator";
import { createLlm } from "../infra/llm";
import { PrismaBudgetStore, recordModelUsage } from "../infra/db";
import { smtpConfigFromEnv } from "../infra/transport";
import { dnsAvailable } from "../infra/dns";
import type { Icp, Offering } from "../core/types";

/**
 * Everything the console can do.
 *
 * Server actions rather than API routes, so the mutation and the page that
 * triggers it stay next to each other. Two rules hold throughout:
 *
 *  - Every action resolves the campaign through `ownedCampaign`, which scopes
 *    it to the session. A campaign id in a form field is a client-supplied
 *    value and is never trusted.
 *  - Arming live sending is the only irreversible thing in the product, so it
 *    is the only action that requires typing a confirmation.
 */

function llm() {
  return createLlm({
    store: new PrismaBudgetStore(),
    onCall: (info) => {
      void recordModelUsage({
        model: info.model,
        inputTokens: info.usage?.inputTokens ?? 0,
        outputTokens: info.usage?.outputTokens ?? 0,
        failed: Boolean(info.error) || info.status >= 400,
      });
    },
  });
}

export async function login(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const user = await verifyPassword(email, password);
  if (!user) redirect("/login?error=1");

  await createSession({ userId: user.id, email: user.email });
  redirect("/");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}

/**
 * The one input: a URL.
 *
 * Ingestion is synchronous here, which is a deliberate limitation rather than
 * an oversight — crawling a dozen pages takes ten to thirty seconds, and a
 * background job queue would be another moving part to run for free. The form
 * says it will take a moment.
 */
export async function createCampaign(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session) redirect("/login");

  const url = String(formData.get("url") ?? "").trim();
  const fromName = String(formData.get("fromName") ?? "").trim();
  const fromEmail = String(formData.get("fromEmail") ?? "").trim();
  const postalAddress = String(formData.get("postalAddress") ?? "").trim();
  const unsubscribeUrl = String(formData.get("unsubscribeUrl") ?? "").trim();
  const meetingLink = String(formData.get("meetingLink") ?? "").trim();
  const targetLeads = Number(formData.get("targetLeads") ?? 25);
  const minFitScore = Number(formData.get("minFitScore") ?? 55);

  if (!url) redirect("/new?error=url");
  if (!fromName || !fromEmail || !postalAddress) redirect("/new?error=sender");

  const result = await ingest(url, llm(), { maxPages: 12 });
  if ("error" in result) {
    redirect(`/new?error=ingest&detail=${encodeURIComponent(result.error)}`);
  }

  const campaign = await db.campaign.create({
    data: {
      userId: session.userId,
      sourceUrl: url,
      name: result.offering.companyName,
      status: "running",
      offering: toJson(result.offering),
      icp: toJson(result.icp),
      senderIdentity: toJson({
        fromName, fromEmail, postalAddress,
        unsubscribeUrl: unsubscribeUrl || undefined,
        replyTo: fromEmail,
      }),
      meetingLink: meetingLink || null,
      targetLeads: Number.isFinite(targetLeads) ? Math.min(500, Math.max(1, targetLeads)) : 25,
      minFitScore: Number.isFinite(minFitScore) ? Math.min(100, Math.max(0, minFitScore)) : 55,
      liveSending: false,
    },
  });

  await logEvent(campaign.id, "campaign.created", `Created from ${url}.`, {
    level: "success",
    data: { via: result.via, notes: result.notes },
  });

  redirect(`/campaigns/${campaign.id}`);
}

/** Runs one tick, synchronously, so the operator sees the result immediately. */
export async function runTick(formData: FormData): Promise<void> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const campaign = await ownedCampaign(campaignId);
  if (!campaign) redirect("/");

  const useDns = await dnsAvailable();
  await tick({ campaignId: campaign.id, llm: llm(), useDns }).catch(async (error) => {
    await logEvent(campaign.id, "tick.failed", error instanceof Error ? error.message : String(error), { level: "error" });
  });

  revalidatePath(`/campaigns/${campaign.id}`);
}

export async function setStatus(formData: FormData): Promise<void> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!["running", "paused"].includes(status)) return;

  const campaign = await ownedCampaign(campaignId);
  if (!campaign) redirect("/");

  await db.campaign.update({ where: { id: campaign.id }, data: { status } });
  await logEvent(campaign.id, "campaign.status", `Campaign ${status}.`, { level: status === "paused" ? "warn" : "info" });
  revalidatePath(`/campaigns/${campaign.id}`);
}

/**
 * Arms live sending.
 *
 * The only action in the product that can reach a stranger's inbox, and the
 * only one that asks for a typed confirmation. It also refuses outright when
 * SMTP is not configured: silently staying in dry-run mode after the operator
 * believed they had armed it is worse than refusing.
 */
export async function armLiveSending(formData: FormData): Promise<void> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const confirmation = String(formData.get("confirm") ?? "").trim().toUpperCase();

  const campaign = await ownedCampaign(campaignId);
  if (!campaign) redirect("/");

  if (confirmation !== "SEND") {
    redirect(`/campaigns/${campaign.id}?error=confirm`);
  }
  if (!smtpConfigFromEnv()) {
    redirect(`/campaigns/${campaign.id}?error=smtp`);
  }

  await db.campaign.update({ where: { id: campaign.id }, data: { liveSending: true } });
  await logEvent(campaign.id, "campaign.live", "Live sending armed by the operator.", { level: "warn" });
  revalidatePath(`/campaigns/${campaign.id}`);
}

export async function disarmLiveSending(formData: FormData): Promise<void> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const campaign = await ownedCampaign(campaignId);
  if (!campaign) redirect("/");

  await db.campaign.update({ where: { id: campaign.id }, data: { liveSending: false } });
  await logEvent(campaign.id, "campaign.live", "Live sending disarmed; back to dry run.", { level: "info" });
  revalidatePath(`/campaigns/${campaign.id}`);
}

/** Adds an address to the global do-not-contact list, by hand. */
export async function suppress(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session) redirect("/login");

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const note = String(formData.get("note") ?? "").trim();
  if (!email.includes("@")) redirect("/suppressions?error=email");

  await db.suppression.upsert({
    where: { userId_email: { userId: session.userId, email } },
    create: { userId: session.userId, email, reason: "manual", note: note || undefined },
    update: { reason: "manual", note: note || undefined },
  });
  revalidatePath("/suppressions");
}

export async function unsuppress(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session) redirect("/login");

  const id = String(formData.get("id") ?? "");
  // Scoped to the session: a suppression id from a form is client-supplied.
  await db.suppression.deleteMany({ where: { id, userId: session.userId } });
  revalidatePath("/suppressions");
}

/** Edits the ICP by hand. The operator knows their market better than a crawl. */
export async function updateIcp(formData: FormData): Promise<void> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const campaign = await ownedCampaign(campaignId);
  if (!campaign) redirect("/");

  const current = fromJson<Icp | null>(campaign.icp, null);
  const offering = fromJson<Offering | null>(campaign.offering, null);
  if (!current || !offering) redirect(`/campaigns/${campaignId}`);

  const list = (name: string) =>
    String(formData.get(name) ?? "")
      .split(/[,\n]/)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);

  const sizeMin = Number(formData.get("sizeMin") ?? current.sizeMin);
  const sizeMax = Number(formData.get("sizeMax") ?? current.sizeMax);

  const next: Icp = {
    ...current,
    painSignals: list("painSignals").length > 0 ? list("painSignals") : current.painSignals,
    positiveSignals: list("positiveSignals"),
    negativeSignals: list("negativeSignals"),
    industries: list("industries"),
    geographies: list("geographies"),
    buyerTitles: String(formData.get("buyerTitles") ?? "").split(/[,\n]/).map((v) => v.trim()).filter(Boolean),
    sizeMin: Number.isFinite(sizeMin) ? Math.max(1, sizeMin) : current.sizeMin,
    sizeMax: Number.isFinite(sizeMax) ? Math.max(1, sizeMax) : current.sizeMax,
  };
  if (next.sizeMin > next.sizeMax) [next.sizeMin, next.sizeMax] = [next.sizeMax, next.sizeMin];

  await db.campaign.update({ where: { id: campaign.id }, data: { icp: toJson(next) } });
  await logEvent(campaign.id, "icp.updated", "ICP edited by the operator.", { data: next });
  revalidatePath(`/campaigns/${campaign.id}`);
}

/** Thresholds and volume. */
export async function updateTargets(formData: FormData): Promise<void> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const campaign = await ownedCampaign(campaignId);
  if (!campaign) redirect("/");

  const targetLeads = Number(formData.get("targetLeads") ?? campaign.targetLeads);
  const minFitScore = Number(formData.get("minFitScore") ?? campaign.minFitScore);
  const meetingLink = String(formData.get("meetingLink") ?? "").trim();

  await db.campaign.update({
    where: { id: campaign.id },
    data: {
      targetLeads: Number.isFinite(targetLeads) ? Math.min(500, Math.max(1, targetLeads)) : campaign.targetLeads,
      minFitScore: Number.isFinite(minFitScore) ? Math.min(100, Math.max(0, minFitScore)) : campaign.minFitScore,
      meetingLink: meetingLink || null,
    },
  });
  revalidatePath(`/campaigns/${campaign.id}`);
}
