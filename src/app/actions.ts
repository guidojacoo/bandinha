"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSession, destroySession, ownedCampaign, readSession, verifyPassword } from "../lib/auth";
import { db, logEvent } from "../infra/db";
import { toJson, fromJson } from "../lib/json";
import { enqueue, revive } from "../infra/queue";
import { smtpConfigFromEnv } from "../infra/transport";
import { DEFAULT_TERMS, monthOf, type PricingTerms } from "../core/billing";
import { closeDeal, confirmMeeting, markInvoiced } from "../agent/billing";
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
 * The crawl does not happen here. It used to, and a dozen pages fetched
 * politely is ten to thirty seconds of work inside a form submission — long
 * enough to hit the request timeout of every hosting platform worth deploying
 * on, and a timeout there left a campaign that existed but had never been
 * read. Now the campaign is created in one statement and an `ingest` job is
 * queued; a worker picks it up within a second or two and the campaign page
 * shows the crawl happening.
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

  const campaign = await db.campaign.create({
    data: {
      userId: session.userId,
      sourceUrl: url,
      // A placeholder until the crawl finds the company's real name. Showing
      // the host is better than showing nothing, and better than showing a
      // name the agent has not actually read anywhere.
      name: hostOf(url),
      status: "ingesting",
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

  await logEvent(campaign.id, "campaign.created", `Created from ${url}. Reading the site now.`, {
    level: "success",
  });
  await enqueue({ kind: "ingest", campaignId: campaign.id });

  redirect(`/campaigns/${campaign.id}`);
}

/** The host, for a name to show until the crawl finds the real one. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * Run a tick now.
 *
 * Queued, not run. A tick is seconds of crawling and composing and the
 * occasional model call, and doing that inside a server action means a page
 * that hangs and a platform that may cut the request halfway through a send.
 *
 * It is also the safest possible button. The campaign has exactly one tick
 * row, so this pulls that row's schedule forward rather than adding a second
 * job: pressing it twice cannot send anything twice, and pressing it while a
 * tick is running changes nothing at all.
 */
export async function runTick(formData: FormData): Promise<void> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const campaign = await ownedCampaign(campaignId);
  if (!campaign) redirect("/");

  const kind = campaign.offering && campaign.icp ? "tick" : "ingest";
  await enqueue({ kind, campaignId: campaign.id });
  revalidatePath(`/campaigns/${campaign.id}`);
  revalidatePath("/queue");
}

/**
 * Put a job that gave up back on the queue.
 *
 * The dead letter is where a job lands after it has used its attempts, and
 * the console shows it because that is the one queue state that wants a
 * person. This is the other half: having looked at the error and fixed
 * whatever it was, put the work back.
 */
export async function reviveJob(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session) redirect("/login");

  const jobId = String(formData.get("jobId") ?? "");
  const job = await db.job.findUnique({
    where: { id: jobId },
    select: { id: true, campaign: { select: { userId: true } } },
  });
  // A job id in a form field is a client-supplied value. One belonging to
  // somebody else's campaign is simply not there.
  if (!job || (job.campaign && job.campaign.userId !== session.userId)) redirect("/queue");

  await revive(job.id);
  revalidatePath("/queue");
}

export async function setStatus(formData: FormData): Promise<void> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!["running", "paused"].includes(status)) return;

  const campaign = await ownedCampaign(campaignId);
  if (!campaign) redirect("/");

  await db.campaign.update({ where: { id: campaign.id }, data: { status } });
  await logEvent(campaign.id, "campaign.status", `Campaign ${status}.`, { level: status === "paused" ? "warn" : "info" });
  // A paused campaign's tick is scheduled a long way out, so resuming has to
  // pull it forward or the campaign would appear to do nothing for an hour.
  if (status === "running") await enqueue({ kind: "tick", campaignId: campaign.id });
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

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

/**
 * Creating a client to bill.
 *
 * The webhook secret is generated here rather than asked for. A secret
 * somebody types is a secret somebody reuses.
 */
export async function createClient(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session) redirect("/login");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) redirect("/billing?error=name");

  const client = await db.client.create({
    data: {
      userId: session.userId,
      name,
      contactEmail: String(formData.get("contactEmail") ?? "").trim() || null,
      billingAddress: String(formData.get("billingAddress") ?? "").trim() || null,
      webhookSecret: randomBytes(24).toString("hex"),
      terms: toJson(termsFromForm(formData)),
    },
  });
  redirect(`/billing?client=${client.id}`);
}

export async function updateTerms(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session) redirect("/login");

  const clientId = String(formData.get("clientId") ?? "");
  const client = await db.client.findFirst({ where: { id: clientId, userId: session.userId } });
  if (!client) redirect("/billing");

  await db.client.update({
    where: { id: client.id },
    data: { terms: toJson({ ...DEFAULT_TERMS, ...fromJson<Partial<PricingTerms>>(client.terms, {}), ...termsFromForm(formData) }) },
  });
  revalidatePath("/billing");
}

/** Cents are parsed from whole currency units, which is what people type. */
function termsFromForm(formData: FormData): Partial<PricingTerms> {
  const money = (name: string) => {
    const value = Number(String(formData.get(name) ?? "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(value) ? Math.round(value * 100) : undefined;
  };
  const percent = Number(String(formData.get("dealSharePercent") ?? "").replace(/[^0-9.]/g, ""));

  const terms: Partial<PricingTerms> = {};
  const currency = String(formData.get("currency") ?? "").trim().toUpperCase();
  if (currency) terms.currency = currency;
  const assign = (key: keyof PricingTerms, value: number | undefined) => {
    if (value !== undefined) (terms as Record<string, number>)[key] = value;
  };
  assign("perContactCents", money("perContact"));
  assign("perReplyCents", money("perReply"));
  assign("perMeetingCents", money("perMeeting"));
  assign("perDealCents", money("perDeal"));
  assign("monthlyRetainerCents", money("monthlyRetainer"));
  assign("minimumInvoiceCents", money("minimumInvoice"));
  if (Number.isFinite(percent)) terms.dealSharePoints = Math.round(percent * 100);
  return terms;
}

export async function assignClient(formData: FormData): Promise<void> {
  const campaignId = String(formData.get("campaignId") ?? "");
  const campaign = await ownedCampaign(campaignId);
  if (!campaign) redirect("/");

  const session = await readSession();
  const raw = String(formData.get("clientId") ?? "");
  // An empty selection means "bill nobody", which is a legitimate choice.
  const clientId = raw
    ? (await db.client.findFirst({ where: { id: raw, userId: session!.userId } }))?.id ?? null
    : null;

  await db.campaign.update({ where: { id: campaign.id }, data: { clientId } });
  revalidatePath(`/campaigns/${campaign.id}`);
}

/**
 * Confirming a meeting, which is what makes one billable.
 *
 * Kept as an explicit operator action rather than derived from the reply
 * classifier. Reading "happy to chat, what times suit?" as a meeting request
 * is right most of the time, and most of the time is not a standard you can
 * bill somebody to.
 */
export async function confirmMeetingAction(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session) redirect("/login");

  const leadId = String(formData.get("leadId") ?? "");
  const lead = await db.lead.findFirst({ where: { id: leadId, campaign: { userId: session.userId } } });
  if (!lead) redirect("/");

  await confirmMeeting(lead.id, session.email);
  revalidatePath(`/campaigns/${lead.campaignId}`);
  revalidatePath("/billing");
}

/** Closing a deal by hand, for money that arrived outside any webhook. */
export async function closeDealAction(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session) redirect("/login");

  const leadId = String(formData.get("leadId") ?? "");
  const lead = await db.lead.findFirst({ where: { id: leadId, campaign: { userId: session.userId } } });
  if (!lead) redirect("/");

  const amount = Number(String(formData.get("amount") ?? "").replace(/[^0-9.]/g, ""));
  await closeDeal({
    leadId: lead.id,
    closedBy: "operator",
    valueCents: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : undefined,
    reference: String(formData.get("reference") ?? "").trim() || undefined,
  });

  revalidatePath(`/campaigns/${lead.campaignId}`);
  revalidatePath("/billing");
}

/** Issues the invoice, which is the only thing that stamps the events. */
export async function issueInvoice(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session) redirect("/login");

  const clientId = String(formData.get("clientId") ?? "");
  const client = await db.client.findFirst({ where: { id: clientId, userId: session.userId } });
  if (!client) redirect("/billing");

  const period = monthOf(new Date());
  const reference = `${period.start.toISOString().slice(0, 7)}-${client.id.slice(-6)}`;
  const count = await markInvoiced(client.id, period, reference);

  revalidatePath("/billing");
  redirect(`/billing?client=${client.id}&issued=${count}&ref=${encodeURIComponent(reference)}`);
}

export async function rotateWebhookSecret(formData: FormData): Promise<void> {
  const session = await readSession();
  if (!session) redirect("/login");

  const clientId = String(formData.get("clientId") ?? "");
  const client = await db.client.findFirst({ where: { id: clientId, userId: session.userId } });
  if (!client) redirect("/billing");

  await db.client.update({ where: { id: client.id }, data: { webhookSecret: randomBytes(24).toString("hex") } });
  revalidatePath("/billing");
}
