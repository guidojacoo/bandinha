import { advance, DEFAULT_SEQUENCE, initialEnrollment, isDue, isTerminal, nextDueAt, ROLE_INBOX_SEQUENCE, stepAt } from "../core/sequence";
import { evaluateSend } from "../core/compliance";
import { budgetSummary } from "../core/budget";
import { checkDeliverability } from "../core/deliverability";
import { fromJson, toJson } from "../lib/json";
import { db, logEvent } from "../infra/db";
import { discoverProspects } from "../infra/sources";
import { createInbox, createTransport } from "../infra/transport";
import { compose } from "./compose";
import { converse } from "./converse";
import { enrollmentEventFor, stageFor, summarise } from "./deals";
import { qualify } from "./qualify";
import { billContactDelivered, billReplyReceived } from "./billing";
import { warmupVerdict, type SendingHistory, type WarmupVerdict } from "../core/warmup";
import type { Llm } from "../infra/llm/types";
import type { Inbox, Transport } from "../infra/transport/types";
import type {
  ComplianceConfig, DealStage, DeliverabilityCheck, EnrollmentSnapshot,
  EnrollmentState, FitResult, Icp, LeadProfile, Offering, SenderIdentity, Sequence,
} from "../core/types";

/**
 * The autonomous loop.
 *
 * One tick does the whole job in a fixed order, and the order is the design:
 *
 *   1. **Read replies first.** Always. A tick that sends before reading can
 *      mail someone who asked to be left alone thirty seconds earlier.
 *   2. **Discover** only if the pipeline is short of its target.
 *   3. **Qualify** what was discovered, which is where most candidates die.
 *   4. **Enrol** the ones that survived.
 *   5. **Send** what is due, each send cleared by the compliance gate.
 *
 * Everything is idempotent and resumable: state lives in the database, not in
 * this function, so a tick can be a cron job, a CLI invocation or a loop in a
 * terminal, and crashing halfway through loses at most one message.
 *
 * Each phase has a budget in units of work, so one slow phase cannot starve
 * the others. A tick that spends its whole allowance crawling discovers
 * nothing and sends nothing, which looks exactly like a broken agent.
 */

export interface TickBudget {
  maxDiscover: number;
  maxQualify: number;
  maxSends: number;
  maxReplies: number;
}

export const DEFAULT_TICK_BUDGET: TickBudget = {
  maxDiscover: 20,
  maxQualify: 6,
  maxSends: 10,
  maxReplies: 25,
};

export interface TickSummary {
  repliesRead: number;
  suppressed: number;
  escalated: number;
  answered: number;
  discovered: number;
  qualified: number;
  rejected: number;
  enrolled: number;
  sent: number;
  blocked: number;
  failed: number;
  /** Lines the operator sees. The agent explaining itself as it works. */
  log: string[];
  llm: string;
  /** Today's sending allowance and why it is what it is. */
  warmup?: WarmupVerdict;
}

export interface TickOptions {
  campaignId: string;
  llm: Llm;
  budget?: Partial<TickBudget>;
  transport?: Transport;
  inbox?: Inbox;
  /** False in environments with no resolver. */
  useDns?: boolean;
  now?: Date;
  onProgress?: (message: string) => void;
}

export async function tick(options: TickOptions): Promise<TickSummary> {
  const budget = { ...DEFAULT_TICK_BUDGET, ...options.budget };
  /**
   * The clock, read per phase rather than once per tick.
   *
   * A single timestamp taken at the start looks tidier and is wrong: a lead
   * enrolled during the discovery phase has an `enrolledAt` *after* that
   * timestamp, so its first touch was never due in the tick that created it
   * and every lead silently waited a full cycle for its first email. Tests
   * still pin the clock by passing `now`.
   */
  const clock = () => options.now ?? new Date();
  const now = clock();

  const summary: TickSummary = {
    repliesRead: 0, suppressed: 0, escalated: 0, answered: 0,
    discovered: 0, qualified: 0, rejected: 0, enrolled: 0,
    sent: 0, blocked: 0, failed: 0, log: [], llm: "",
  };

  const say = (message: string) => {
    summary.log.push(message);
    options.onProgress?.(message);
  };

  const campaign = await db.campaign.findUnique({ where: { id: options.campaignId } });
  if (!campaign) throw new Error(`No campaign ${options.campaignId}.`);
  if (campaign.status === "paused") {
    say("Campaign is paused; nothing was done.");
    return summary;
  }

  const context = loadContext(campaign);
  if (!context) {
    say("Campaign has not finished ingesting yet — no offering or ICP stored.");
    return summary;
  }

  // The warmup verdict is computed once per tick and applied as the day's
  // cap. A new sending domain that emits its full configured volume on day
  // one is a new sending domain with a damaged reputation, and the damage is
  // invisible for weeks.
  const warmup = await warmupFor(campaign.id, context.compliance.dailySendCap);
  context.compliance = { ...context.compliance, dailySendCap: warmup.dailyCap };
  if (warmup.stage !== "warm") say(`Sending: ${warmup.reason}`);
  summary.warmup = warmup;

  const run = await db.agentRun.create({ data: { campaignId: campaign.id } });
  const transport = options.transport ?? createTransport({ liveSending: campaign.liveSending });
  const inbox = options.inbox ?? createInbox();

  try {
    await readReplies({ ...options, now: clock(), campaign, context, inbox, transport, budget, summary, say });
    await fillPipeline({ ...options, now: clock(), campaign, context, budget, summary, say });
    await sendDue({ ...options, now: clock(), campaign, context, transport, budget, summary, say });

    summary.llm = options.llm.available() ? budgetSummary(options.llm.budget()) : "no LLM configured (deterministic copy)";

    await db.agentRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: true, summary: toJson(summary) },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    say(`Tick failed: ${message}`);
    await db.agentRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, error: message, summary: toJson(summary) },
    });
    await logEvent(campaign.id, "tick.failed", message, { level: "error" });
    throw error;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Campaign context
// ---------------------------------------------------------------------------

interface CampaignContext {
  offering: Offering;
  icp: Icp;
  sender: SenderIdentity;
  compliance: ComplianceConfig;
}

/**
 * The domain's sending history, for the warmup ramp.
 *
 * Counted per campaign rather than per domain, which is the right scope for a
 * single-operator tool: one campaign is one sending identity. An operator
 * running several campaigns from one domain would want this widened, and the
 * console says so.
 */
export async function warmupFor(campaignId: string, configuredCap: number): Promise<WarmupVerdict> {
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const [first, totalSent, sentToday, bounced, complained] = await Promise.all([
    db.message.findFirst({
      where: { campaignId, direction: "outbound", status: "sent" },
      orderBy: { sentAt: "asc" },
      select: { sentAt: true },
    }),
    db.message.count({ where: { campaignId, direction: "outbound", status: "sent" } }),
    db.message.count({ where: { campaignId, direction: "outbound", status: "sent", sentAt: { gte: startOfDay } } }),
    db.enrollment.count({ where: { campaignId, state: "bounced" } }),
    // Opt-outs and "not interested" both count: a receiving system cannot
    // tell them apart, and neither can a reputation score.
    db.suppression.count({
      where: {
        sourceCampaignId: campaignId,
        reason: { in: ["unsubscribed", "complained", "not_interested"] },
      },
    }),
  ]);

  const history: SendingHistory = {
    daysSending: first?.sentAt
      ? Math.max(0, Math.floor((now.getTime() - first.sentAt.getTime()) / 86_400_000))
      : 0,
    totalSent,
    totalBounced: bounced,
    totalComplained: complained,
    sentToday,
  };
  return warmupVerdict(configuredCap, history);
}

export function loadContext(campaign: {
  offering: string | null;
  icp: string | null;
  senderIdentity: string | null;
  complianceConfig: string | null;
}): CampaignContext | null {
  const offering = fromJson<Offering | null>(campaign.offering, null);
  const icp = fromJson<Icp | null>(campaign.icp, null);
  const sender = fromJson<SenderIdentity | null>(campaign.senderIdentity, null);
  if (!offering || !icp || !sender) return null;

  const overrides = fromJson<Partial<ComplianceConfig>>(campaign.complianceConfig, {});
  return { offering, icp, sender, compliance: { ...defaultCompliance(sender), ...overrides, sender } };
}

export function defaultCompliance(sender: SenderIdentity): ComplianceConfig {
  return {
    sender,
    // Deliberately low. A new sending domain that emits two hundred messages
    // on its first day is a new sending domain with a ruined reputation.
    dailySendCap: Number(process.env.DAILY_SEND_CAP ?? 30),
    perDomainDailyCap: Number(process.env.PER_DOMAIN_DAILY_CAP ?? 2),
    minHoursBetweenTouches: Number(process.env.MIN_HOURS_BETWEEN_TOUCHES ?? 48),
    timezoneOffsetMinutes: Number(process.env.SEND_TZ_OFFSET_MINUTES ?? 0),
    sendWindowStartHour: Number(process.env.SEND_WINDOW_START ?? 8),
    sendWindowEndHour: Number(process.env.SEND_WINDOW_END ?? 17),
    sendDays: [1, 2, 3, 4, 5],
    blockedDomains: (process.env.BLOCKED_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean),
  };
}

interface PhaseArgs extends TickOptions {
  now: Date;
  campaign: { id: string; userId: string; clientId: string | null; targetLeads: number; minFitScore: number; meetingLink: string | null };
  context: CampaignContext;
  budget: TickBudget;
  summary: TickSummary;
  say: (message: string) => void;
}

// ---------------------------------------------------------------------------
// 1. Replies
// ---------------------------------------------------------------------------

async function readReplies(args: PhaseArgs & { inbox: Inbox; transport: Transport }): Promise<void> {
  const { campaign, context, inbox, summary, say } = args;

  const incoming = await inbox.fetch(args.budget.maxReplies);
  if (incoming.length === 0) return;
  say(`${incoming.length} reply(ies) waiting.`);

  for (const message of incoming) {
    const contact = await db.contact.findFirst({
      where: { email: message.from.toLowerCase(), lead: { campaignId: campaign.id } },
      include: { lead: true, enrollments: true },
    });
    if (!contact) {
      say(`  ${message.from}: not a contact in this campaign, ignored.`);
      continue;
    }

    summary.repliesRead += 1;
    const profile = fromJson<LeadProfile | null>(contact.lead.profile, null);
    if (!profile) continue;

    await db.message.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        enrollmentId: contact.enrollments[0]?.id,
        direction: "inbound",
        status: "received",
        toEmail: message.to || context.sender.fromEmail,
        fromEmail: message.from,
        subject: message.subject,
        body: message.body,
        messageId: message.messageId,
        inReplyTo: message.inReplyTo,
      },
    });

    const action = await converse(
      {
        body: message.body,
        subject: message.subject,
        offering: context.offering,
        profile,
        sender: context.sender,
        contactName: contact.name ?? undefined,
        meetingLink: campaign.meetingLink ?? undefined,
      },
      args.llm,
    );

    // The classification is stored on the inbound message so the console can
    // show why the agent did what it did.
    await db.message.updateMany({
      where: { contactId: contact.id, direction: "inbound", messageId: message.messageId ?? undefined },
      data: { analysis: toJson(action.analysis) },
    });

    // A reply from a human is chargeable; a mailer-daemon response is not,
    // and neither is a complaint — invoicing a client for somebody telling
    // them to go away is indefensible however the contract is worded.
    if (!["bounce", "auto_reply", "unsubscribe"].includes(action.analysis.intent)) {
      await billReplyReceived({
        campaignId: campaign.id,
        clientId: campaign.clientId,
        leadId: contact.leadId,
        fromEmail: contact.email,
        receivedAt: message.receivedAt,
        intent: action.analysis.intent,
      });
    }

    const enrollment = contact.enrollments[0];
    const event = enrollmentEventFor(action.analysis.intent);
    if (enrollment && event) {
      const sequence = fromJson<Sequence>(enrollment.sequence, DEFAULT_SEQUENCE);
      const next = advance(snapshotOf(enrollment), { type: event, at: message.receivedAt, intent: action.analysis.intent } as never, sequence);
      await saveEnrollment(enrollment.id, next, sequence, enrollment.enrolledAt);
    }

    switch (action.kind) {
      case "suppress": {
        // Global and permanent: an opt-out from one campaign is an opt-out
        // from every campaign this user ever runs.
        await db.suppression.upsert({
          where: { userId_email: { userId: campaign.userId, email: contact.email } },
          create: {
            userId: campaign.userId, email: contact.email, reason: action.reason,
            note: `From a reply: ${action.analysis.cues.slice(0, 3).join("; ")}`,
            sourceCampaignId: campaign.id,
          },
          update: { reason: action.reason },
        });
        summary.suppressed += 1;
        say(`  ${contact.email}: ${action.reason}. Suppressed everywhere, permanently.`);
        await logEvent(campaign.id, "reply.suppressed", `${contact.email} opted out (${action.reason}).`, { level: "warn", data: action.analysis });
        break;
      }

      case "escalate":
        summary.escalated += 1;
        say(`  ${contact.email}: needs a person — ${action.why}`);
        await logEvent(campaign.id, "reply.escalated", `${contact.email}: ${action.why}`, { level: "warn", data: { analysis: action.analysis, body: message.body.slice(0, 500) } });
        break;

      case "wait":
        say(`  ${contact.email}: ${action.why}`);
        break;

      case "reply": {
        if (!action.validation.ok) {
          summary.escalated += 1;
          say(`  ${contact.email}: a reply was drafted but failed validation — ${action.validation.problems[0]}`);
          await db.message.create({
            data: {
              campaignId: campaign.id, contactId: contact.id, enrollmentId: enrollment?.id,
              direction: "outbound", status: "blocked",
              toEmail: contact.email, fromEmail: context.sender.fromEmail,
              subject: `Re: ${message.subject}`.slice(0, 200), body: action.message.body,
              composedVia: action.via, provenance: toJson(action.message.provenance),
              qualityScore: action.quality.score,
              qualityChecks: toJson(action.quality.checks),
              blockedCode: "no_evidence", blockedReason: action.validation.problems.join("; "),
            },
          });
          break;
        }

        const outcome = await deliver({
          ...args,
          contact,
          leadId: contact.leadId,
          enrollmentId: enrollment?.id,
          subject: `Re: ${message.subject}`.replace(/^(Re:\s*)+/i, "Re: ").slice(0, 200),
          body: action.message.body,
          provenance: action.message.provenance,
          composedVia: action.via,
          quality: action.quality,
          isReply: true,
          inReplyTo: message.messageId,
        });
        if (outcome === "sent") {
          summary.answered += 1;
          say(`  ${contact.email}: answered (${action.analysis.intent}).`);
        }
        break;
      }
    }

    await updateDeal(campaign.id, contact.leadId, action.analysis);
  }
}

// ---------------------------------------------------------------------------
// 2 & 3. Discover and qualify
// ---------------------------------------------------------------------------

async function fillPipeline(args: PhaseArgs): Promise<void> {
  const { campaign, context, summary, say } = args;

  const live = await db.lead.count({
    where: { campaignId: campaign.id, status: { in: ["discovered", "qualifying", "qualified", "enrolled"] } },
  });
  const enrolled = await db.lead.count({ where: { campaignId: campaign.id, status: "enrolled" } });
  if (enrolled >= campaign.targetLeads) {
    say(`Pipeline is full (${enrolled}/${campaign.targetLeads} enrolled).`);
    return;
  }

  // Discover only when there is nothing left to qualify: crawling a candidate
  // we already have beats finding another one we will not get to.
  const pending = await db.lead.findMany({
    where: { campaignId: campaign.id, status: "discovered" },
    take: args.budget.maxQualify,
    orderBy: { createdAt: "asc" },
  });

  if (args.budget.maxDiscover > 0 && pending.length === 0 && live < campaign.targetLeads * 2) {
    const known = new Set((await db.lead.findMany({
      where: { campaignId: campaign.id },
      select: { domain: true },
    })).map((l) => l.domain));
    // Never prospect the seller's own domain.
    known.add(context.offering.domain);

    const discovery = await discoverProspects({
      icp: context.icp,
      limit: Math.min(args.budget.maxDiscover, campaign.targetLeads * 2 - live),
      exclude: known,
      onProgress: say,
    });

    for (const entry of discovery.perSource) {
      say(`  ${entry.label}${entry.confidence === "untested" ? " (untested)" : ""}: ${entry.found} found. ${entry.notes.join(" ")}`);
      for (const error of entry.errors) say(`    ! ${error}`);
    }
    for (const note of discovery.notes) say(`  ${note}`);

    for (const candidate of discovery.candidates) {
      await db.lead.create({
        data: {
          campaignId: campaign.id,
          domain: candidate.domain,
          companyName: candidate.companyName ?? candidate.domain,
          url: candidate.url,
          status: "discovered",
          discoveredVia: `${candidate.via}: ${candidate.reason}`,
          profile: toJson({ hints: candidate.hints ?? {} }),
        },
      }).catch(() => { /* a race on the (campaignId, domain) unique index */ });
      summary.discovered += 1;
    }
    if (summary.discovered > 0) {
      say(`Discovered ${summary.discovered} new candidate(s).`);
      await logEvent(campaign.id, "discovery", `${summary.discovered} candidates from ${discovery.perSource.map((s) => s.id).join(", ")}.`, { data: discovery.perSource });
    }

    pending.push(...await db.lead.findMany({
      where: { campaignId: campaign.id, status: "discovered" },
      take: args.budget.maxQualify,
      orderBy: { createdAt: "asc" },
    }));
  }

  for (const lead of pending.slice(0, args.budget.maxQualify)) {
    const hints = fromJson<{ hints?: Record<string, unknown> }>(lead.profile, {}).hints ?? {};
    const result = await qualify(
      {
        domain: lead.domain,
        url: lead.url,
        companyName: lead.companyName === lead.domain ? undefined : lead.companyName,
        via: (lead.discoveredVia.split(":")[0] ?? "seed") as never,
        reason: lead.discoveredVia,
        hints: hints as never,
      },
      {
        icp: context.icp,
        minFitScore: campaign.minFitScore,
        useDns: args.useDns,
        onProgress: (message) => args.onProgress?.(`    ${message}`),
      },
    );

    if (!result.accepted) {
      summary.rejected += 1;
      say(`  ${lead.domain}: rejected — ${result.reason}`);
      await db.lead.update({
        where: { id: lead.id },
        data: {
          status: "rejected",
          rejectedReason: result.reason.slice(0, 500),
          profile: toJson(result.profile),
          fit: toJson(result.fit),
          fitScore: result.fit.score,
          fitBand: result.fit.band,
        },
      });
      continue;
    }

    summary.qualified += 1;
    say(`  ${lead.domain}: ${result.reason}`);

    await db.lead.update({
      where: { id: lead.id },
      data: {
        status: "qualified",
        companyName: result.profile.companyName,
        qualifiedAt: new Date(),
        profile: toJson(result.profile),
        fit: toJson(result.fit),
        fitScore: result.fit.score,
        fitBand: result.fit.band,
        rejectedReason: null,
      },
    });

    for (const contact of result.contacts) {
      await db.contact.upsert({
        where: { leadId_email: { leadId: lead.id, email: contact.email } },
        create: {
          leadId: lead.id, email: contact.email, name: contact.name, title: contact.title,
          kind: contact.kind, source: contact.source,
          deliverability: toJson(contact.deliverability),
          deliverable: contact.deliverability.verdict !== "undeliverable",
        },
        update: {
          name: contact.name ?? undefined, title: contact.title ?? undefined,
          deliverability: toJson(contact.deliverability),
          deliverable: contact.deliverability.verdict !== "undeliverable",
        },
      });
    }

    await enrol(args, lead.id, result.contactable[0]!.email, result.fit);
  }
}

async function enrol(
  args: PhaseArgs,
  leadId: string,
  email: string,
  fit: FitResult,
): Promise<void> {
  const contact = await db.contact.findUnique({ where: { leadId_email: { leadId, email } } });
  if (!contact) return;

  const suppressed = await db.suppression.findUnique({
    where: { userId_email: { userId: args.campaign.userId, email: contact.email } },
  });
  if (suppressed) {
    args.say(`  ${contact.email}: on the suppression list (${suppressed.reason}), not enrolled.`);
    return;
  }

  // A shared inbox is read by someone who did not choose to hear from us, so
  // it gets two touches rather than four.
  const sequence = contact.kind === "role" ? ROLE_INBOX_SEQUENCE : DEFAULT_SEQUENCE;
  const snapshot = initialEnrollment();

  await db.enrollment.upsert({
    where: { contactId: contact.id },
    create: {
      campaignId: args.campaign.id, leadId, contactId: contact.id,
      sequenceName: sequence.name,
      // Frozen at enrollment: changing the default cadence later must not
      // rewrite the history of a sequence already in flight.
      sequence: toJson(sequence),
      state: snapshot.state, nextStepIndex: snapshot.nextStepIndex,
      nextDueAt: nextDueAt(snapshot, sequence, new Date()),
    },
    update: {},
  });

  await db.lead.update({ where: { id: leadId }, data: { status: "enrolled" } });
  await db.deal.upsert({
    where: { leadId },
    create: { campaignId: args.campaign.id, leadId, stage: "prospect" },
    update: {},
  });

  args.summary.enrolled += 1;
  args.say(`  ${contact.email}: enrolled on "${sequence.name}" (fit ${fit.score}).`);
}

// ---------------------------------------------------------------------------
// 5. Sending
// ---------------------------------------------------------------------------

async function sendDue(args: PhaseArgs & { transport: Transport }): Promise<void> {
  const { campaign, context, now, summary, say } = args;

  const due = await db.enrollment.findMany({
    where: { campaignId: campaign.id, state: { in: ["pending", "active"] } },
    include: { contact: true, lead: true },
    orderBy: [{ nextDueAt: "asc" }],
    take: args.budget.maxSends * 3,
  });

  let sent = 0;
  for (const enrollment of due) {
    if (sent >= args.budget.maxSends) break;

    const sequence = fromJson<Sequence>(enrollment.sequence, DEFAULT_SEQUENCE);
    const snapshot = snapshotOf(enrollment);
    if (!isDue(snapshot, sequence, enrollment.enrolledAt, now)) continue;

    const step = stepAt(sequence, snapshot.nextStepIndex);
    if (!step) {
      await saveEnrollment(enrollment.id, { ...snapshot, state: "exhausted" }, sequence, enrollment.enrolledAt);
      continue;
    }

    const profile = fromJson<LeadProfile | null>(enrollment.lead.profile, null);
    if (!profile) continue;

    const previous = await db.message.findMany({
      where: { contactId: enrollment.contactId, direction: "outbound", status: "sent" },
      select: { subject: true, body: true },
      orderBy: { createdAt: "asc" },
    });

    const drafted = await compose(
      {
        offering: context.offering,
        profile,
        contact: {
          email: enrollment.contact.email,
          name: enrollment.contact.name ?? undefined,
          title: enrollment.contact.title ?? undefined,
          source: enrollment.contact.source,
          kind: enrollment.contact.kind === "role" ? "role" : "individual",
        },
        step,
        sender: context.sender,
        meetingLink: campaign.meetingLink ?? undefined,
        previousMessages: previous,
      },
      args.llm,
    );

    if (!drafted.validation.ok) {
      // A draft that cannot be made truthful is not sent, and the cadence
      // does not advance — the step is retried on a later tick, when the
      // model may be available or the budget replenished.
      summary.blocked += 1;
      say(`  ${enrollment.contact.email}: step ${step.index + 1} blocked — ${drafted.validation.problems[0]}`);
      await db.message.create({
        data: {
          campaignId: campaign.id, contactId: enrollment.contactId, enrollmentId: enrollment.id,
          direction: "outbound", status: "blocked",
          toEmail: enrollment.contact.email, fromEmail: context.sender.fromEmail,
          subject: drafted.message.subject, body: drafted.message.body,
          stepIndex: step.index, stepIntent: step.intent, composedVia: drafted.via,
          provenance: toJson(drafted.message.provenance),
          qualityScore: drafted.quality.score,
          qualityChecks: toJson(drafted.quality.checks),
          attempts: toJson(drafted.attempts),
          blockedCode: "no_evidence", blockedReason: drafted.validation.problems.join("; ").slice(0, 1_000),
        },
      });
      await logEvent(campaign.id, "message.blocked", `${enrollment.contact.email}: ${drafted.validation.problems[0]}`, {
        level: "warn", data: drafted,
      });
      continue;
    }

    const outcome = await deliver({
      ...args,
      contact: enrollment.contact,
      leadId: enrollment.leadId,
      enrollmentId: enrollment.id,
      subject: drafted.message.subject,
      body: drafted.message.body,
      provenance: drafted.message.provenance,
      composedVia: drafted.via,
      quality: drafted.quality,
      attempts: drafted.attempts,
      stepIndex: step.index,
      stepIntent: step.intent,
    });

    if (outcome === "sent") {
      sent += 1;
      summary.sent += 1;
      const next = advance(snapshot, { type: "sent", at: now }, sequence);
      await saveEnrollment(enrollment.id, next, sequence, enrollment.enrolledAt);
      await updateDeal(campaign.id, enrollment.leadId, undefined);
      say(`  ${enrollment.contact.email}: step ${step.index + 1}/${sequence.steps.length} (${step.intent}, ${drafted.via}, copy ${drafted.quality.score}/100) — "${drafted.message.subject}"`);
    }
  }
}

/**
 * The single place a message can leave the system.
 *
 * Every outbound message, cadence step or reply, goes through this: the
 * compliance gate, then the transport, then the database. Having two paths to
 * the transport is how a system ends up with one of them missing the
 * suppression check.
 */
async function deliver(args: PhaseArgs & {
  transport: Transport;
  contact: { id: string; email: string; deliverability: string | null };
  /** The lead this contact belongs to, for billing. */
  leadId?: string;
  enrollmentId?: string;
  subject: string;
  body: string;
  provenance: unknown;
  composedVia: string;
  quality?: { score: number; checks: unknown };
  attempts?: unknown;
  stepIndex?: number;
  stepIntent?: string;
  isReply?: boolean;
  inReplyTo?: string;
}): Promise<"sent" | "blocked" | "failed"> {
  const { campaign, context, now, summary, say } = args;
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const domain = args.contact.email.split("@")[1] ?? "";

  const [sentToday, sentTodayToDomain, suppression, lastSent] = await Promise.all([
    db.message.count({ where: { campaignId: campaign.id, direction: "outbound", status: "sent", sentAt: { gte: startOfDay } } }),
    db.message.count({ where: { campaignId: campaign.id, direction: "outbound", status: "sent", sentAt: { gte: startOfDay }, toEmail: { endsWith: `@${domain}` } } }),
    db.suppression.findUnique({ where: { userId_email: { userId: campaign.userId, email: args.contact.email } } }),
    db.message.findFirst({
      where: { contactId: args.contact.id, direction: "outbound", status: "sent" },
      orderBy: { sentAt: "desc" }, select: { sentAt: true },
    }),
  ]);

  const decision = evaluateSend(
    {
      toEmail: args.contact.email,
      now,
      sentToday,
      sentTodayToDomain,
      lastTouchedAt: lastSent?.sentAt ?? undefined,
      suppressed: Boolean(suppression),
      suppressionReason: suppression?.reason as never,
      isReply: args.isReply,
      // Re-checked here rather than trusted from qualification: the stored
      // verdict can be weeks old, and `mayContact` fails closed on a missing
      // one so a wiring mistake cannot silently skip the pre-flight.
      deliverability: fromJson<DeliverabilityCheck | null>(args.contact.deliverability, null)
        ?? checkDeliverability(args.contact.email, undefined, now),
    },
    context.compliance,
  );

  const common = {
    campaignId: campaign.id, contactId: args.contact.id, enrollmentId: args.enrollmentId,
    direction: "outbound", toEmail: args.contact.email, fromEmail: context.sender.fromEmail,
    subject: args.subject, body: args.body,
    stepIndex: args.stepIndex, stepIntent: args.stepIntent,
    composedVia: args.composedVia, provenance: toJson(args.provenance),
    qualityScore: args.quality?.score,
    qualityChecks: args.quality ? toJson(args.quality.checks) : undefined,
    attempts: args.attempts === undefined ? undefined : toJson(args.attempts),
  };

  if (!decision.allowed) {
    summary.blocked += 1;
    say(`  ${args.contact.email}: ${decision.code} — ${decision.reason}`);
    await db.message.create({
      data: { ...common, status: "blocked", blockedCode: decision.code, blockedReason: decision.reason },
    });
    return "blocked";
  }

  const result = await args.transport.send({
    to: args.contact.email,
    subject: args.subject,
    body: args.body,
    sender: context.sender,
    inReplyTo: args.inReplyTo,
  });

  if (!result.ok) {
    summary.failed += 1;
    say(`  ${args.contact.email}: send failed — ${result.error}`);
    await db.message.create({ data: { ...common, status: "failed", error: result.error?.slice(0, 500) } });
    return "failed";
  }

  const stored = await db.message.create({
    // The tick's clock, not the wall clock. They are the same in production
    // and differ in a replay or a pinned-clock demo, where a message dated
    // "now" would fall outside the day the caps are counted over.
    data: { ...common, status: "sent", sentAt: now, messageId: result.messageId, inReplyTo: args.inReplyTo },
  });

  // Billing is raised from the send, not from the draft, and the unique
  // constraint on (client, lead, kind) makes the first touch the only one
  // that charges — so a four-touch sequence is one contact delivered.
  // Charging per message would pay the operator to send a fourth email to
  // somebody who ignored three, which is the behaviour this product's own
  // gates exist to prevent.
  if (!args.isReply && args.leadId) {
    await billContactDelivered({
      campaignId: campaign.id,
      clientId: campaign.clientId,
      leadId: args.leadId,
      messageId: stored.id,
      toEmail: args.contact.email,
      sentAt: now,
    });
  }
  return "sent";
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function snapshotOf(enrollment: {
  state: string; nextStepIndex: number; lastSentAt: Date | null; repliedAt: Date | null;
}): EnrollmentSnapshot {
  return {
    state: enrollment.state as EnrollmentState,
    nextStepIndex: enrollment.nextStepIndex,
    lastSentAt: enrollment.lastSentAt ?? undefined,
    repliedAt: enrollment.repliedAt ?? undefined,
  };
}

async function saveEnrollment(
  id: string,
  snapshot: EnrollmentSnapshot,
  sequence: Sequence,
  enrolledAt: Date,
): Promise<void> {
  await db.enrollment.update({
    where: { id },
    data: {
      state: snapshot.state,
      nextStepIndex: snapshot.nextStepIndex,
      lastSentAt: snapshot.lastSentAt,
      repliedAt: snapshot.repliedAt,
      nextDueAt: isTerminal(snapshot.state) ? null : nextDueAt(snapshot, sequence, enrolledAt),
    },
  });
}

async function updateDeal(campaignId: string, leadId: string, analysis?: { intent: string }): Promise<void> {
  const [deal, sentCount] = await Promise.all([
    db.deal.findUnique({ where: { leadId } }),
    db.message.count({ where: { contact: { leadId }, direction: "outbound", status: "sent" } }),
  ]);
  if (!deal) return;

  const stage = stageFor({
    current: deal.stage as DealStage,
    sentCount,
    lastReply: analysis as never,
  });
  if (stage === deal.stage) return;

  await db.deal.update({
    where: { leadId },
    data: {
      stage,
      closedAt: stage === "won" || stage === "lost" ? new Date() : null,
      meetingAt: stage === "meeting_booked" ? deal.meetingAt ?? new Date() : deal.meetingAt,
    },
  });
  await logEvent(campaignId, "deal.stage", `Deal moved to ${stage}.`, { data: { leadId, from: deal.stage, to: stage } });
}

/** The pipeline as the console shows it. */
export async function pipelineSummary(campaignId: string) {
  const [deals, escalations] = await Promise.all([
    db.deal.findMany({ where: { campaignId }, select: { stage: true } }),
    db.event.count({ where: { campaignId, kind: "reply.escalated" } }),
  ]);
  return summarise(deals, escalations);
}
