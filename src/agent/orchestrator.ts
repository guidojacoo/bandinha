import type { Campaign, PrismaClient } from "@/generated/prisma";
import { logEvent, prisma as defaultPrisma } from "../infra/db";
import { discoverProspects, sourcesFromEnv, type ProspectSource } from "../infra/sources";
import {
  inboundFromEnv, outboundFromEnv, type InboundTransport, type OutboundTransport,
} from "../infra/transport";
import {
  DEFAULT_SEQUENCE, ROLE_INBOX_SEQUENCE, advance, evaluateSend, domainOf,
  isRoleInbox, nextDueAt, type ComplianceConfig, type DiscoveredContact,
  type EnrollmentSnapshot, type FitResult, type Icp, type LeadProfile,
  type Offering, type SenderIdentity, type Sequence,
} from "../core";
import { ingest } from "./ingest";
import { qualify } from "./qualify";
import { compose } from "./compose";
import { analyseReply, composeReply, stageFor } from "./converse";

/**
 * The autonomous loop.
 *
 * One `tick` advances every stage of a campaign by a bounded amount and
 * returns. Called on a timer, that is the whole agent: give it a URL and it
 * will learn the product, find companies, qualify them, write to them, read
 * the replies and work the pipeline without anyone asking it to.
 *
 * Two properties make it safe to run unattended:
 *
 * - **Bounded.** Every stage has a per-tick ceiling, so one tick cannot crawl
 *   the internet or empty the send quota in a single pass.
 * - **Idempotent-ish.** Each stage selects work by database state and commits
 *   as it goes, so a crash mid-tick loses at most the item in flight and the
 *   next tick resumes from where it stopped.
 */

export interface TickLimits {
  discoverPerTick: number;
  qualifyPerTick: number;
  enrollPerTick: number;
  sendPerTick: number;
  repliesPerTick: number;
}

export const DEFAULT_LIMITS: TickLimits = {
  discoverPerTick: 10,
  qualifyPerTick: 5,
  enrollPerTick: 10,
  sendPerTick: 10,
  repliesPerTick: 20,
};

export interface TickDeps {
  db?: PrismaClient;
  sources?: ProspectSource[];
  outbound?: OutboundTransport;
  inbound?: InboundTransport;
  limits?: Partial<TickLimits>;
  now?: () => Date;
  /** Crawl politeness override, used by the fixture-backed demo. */
  hostDelayMs?: number;
}

export interface TickSummary {
  campaignId: string;
  status: string;
  discovered: number;
  qualified: number;
  rejected: number;
  enrolled: number;
  sent: number;
  blocked: number;
  repliesHandled: number;
  stopsHonoured: number;
  notes: string[];
}

function emptySummary(campaignId: string, status: string): TickSummary {
  return {
    campaignId, status, discovered: 0, qualified: 0, rejected: 0, enrolled: 0,
    sent: 0, blocked: 0, repliesHandled: 0, stopsHonoured: 0, notes: [],
  };
}

function defaultCompliance(sender: SenderIdentity): ComplianceConfig {
  return {
    sender,
    dailySendCap: Number(process.env.DAILY_SEND_CAP ?? 40),
    perDomainDailyCap: Number(process.env.PER_DOMAIN_DAILY_CAP ?? 2),
    minHoursBetweenTouches: Number(process.env.MIN_HOURS_BETWEEN_TOUCHES ?? 48),
    timezoneOffsetMinutes: Number(process.env.SEND_TZ_OFFSET_MINUTES ?? 0),
    sendWindowStartHour: Number(process.env.SEND_WINDOW_START ?? 8),
    sendWindowEndHour: Number(process.env.SEND_WINDOW_END ?? 18),
    sendDays: (process.env.SEND_DAYS ?? "1,2,3,4,5").split(",").map(Number),
    blockedDomains: (process.env.BLOCKED_DOMAINS ?? "").split(/[,\s]+/).filter(Boolean),
  };
}

function campaignConfig(campaign: Campaign): { sender: SenderIdentity; compliance: ComplianceConfig } | null {
  const sender = campaign.senderIdentity as SenderIdentity | null;
  if (!sender?.fromEmail) return null;
  const stored = campaign.complianceConfig as Partial<ComplianceConfig> | null;
  return { sender, compliance: { ...defaultCompliance(sender), ...(stored ?? {}), sender } };
}

// ---------------------------------------------------------------------------

export async function tick(campaignId: string, deps: TickDeps = {}): Promise<TickSummary> {
  const db = deps.db ?? defaultPrisma;
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());
  const outbound = deps.outbound ?? outboundFromEnv();
  const inbound = deps.inbound ?? inboundFromEnv();
  const sources = deps.sources ?? sourcesFromEnv();

  const run = await db.agentRun.create({ data: { campaignId } });
  let campaign = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const summary = emptySummary(campaignId, campaign.status);

  try {
    // 1. Learn the product, if we have not yet.
    if (campaign.status === "ingesting") {
      campaign = await runIngestion(db, campaign, deps);
      summary.status = campaign.status;
      if (campaign.status !== "running") return await finish(db, run.id, summary);
    }

    if (campaign.status !== "running") {
      summary.notes.push(`Campaign is ${campaign.status}; nothing to do.`);
      return await finish(db, run.id, summary);
    }

    const offering = campaign.offering as Offering | null;
    const icp = campaign.icp as Icp | null;
    if (!offering || !icp) {
      summary.notes.push("Campaign has no offering or ICP; re-run ingestion.");
      return await finish(db, run.id, summary);
    }

    // 2. Read replies BEFORE sending anything.
    //
    //    Ordering matters: a prospect who replied (or unsubscribed) two
    //    minutes ago must not receive the next cadence step this same tick.
    await handleInbound(db, campaign, inbound, limits, summary, now);

    // 3. Top up the funnel.
    await runDiscovery(db, campaign, icp, offering, sources, limits, summary);

    // 4. Qualify what we found.
    await runQualification(db, campaign, icp, offering, limits, summary, deps);

    // 5. Enrol the good ones.
    await runEnrollment(db, campaign, limits, summary, now);

    // 6. Send what is due, through the compliance gate.
    await runOutbound(db, campaign, offering, outbound, limits, summary, now);

    return await finish(db, run.id, summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.notes.push(`Tick failed: ${message}`);
    await logEvent(campaignId, "tick.failed", message, undefined, "error");
    await db.agentRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, error: message, summary: summary as object },
    });
    return summary;
  }
}

async function finish(db: PrismaClient, runId: string, summary: TickSummary): Promise<TickSummary> {
  await db.agentRun.update({
    where: { id: runId },
    data: { finishedAt: new Date(), ok: true, summary: summary as unknown as object },
  });
  return summary;
}

// ---------------------------------------------------------------------------
// Stage 1 — ingestion
// ---------------------------------------------------------------------------

async function runIngestion(db: PrismaClient, campaign: Campaign, deps: TickDeps): Promise<Campaign> {
  try {
    const result = await ingest(campaign.sourceUrl, { hostDelayMs: deps.hostDelayMs });
    await logEvent(campaign.id, "ingest.complete", `Learned ${result.offering.companyName} from ${result.crawl.pages.length} pages.`, {
      products: result.offering.products.length,
      proofPoints: result.offering.proofPoints.length,
      usedLlm: result.usedLlm,
      notes: result.notes,
    });
    return await db.campaign.update({
      where: { id: campaign.id },
      data: {
        status: "running",
        offering: result.offering as unknown as object,
        icp: result.icp as unknown as object,
        name: campaign.name || result.offering.companyName,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent(campaign.id, "ingest.failed", message, undefined, "error");
    return await db.campaign.update({
      where: { id: campaign.id },
      data: { status: "failed", error: message },
    });
  }
}

// ---------------------------------------------------------------------------
// Stage 2 — inbound
// ---------------------------------------------------------------------------

async function handleInbound(
  db: PrismaClient, campaign: Campaign, inbound: InboundTransport,
  limits: TickLimits, summary: TickSummary, now: () => Date,
): Promise<void> {
  let messages;
  try {
    messages = (await inbound.fetchNew()).slice(0, limits.repliesPerTick);
  } catch (err) {
    summary.notes.push(`Inbound poll failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (messages.length === 0) return;

  const config = campaignConfig(campaign);
  const offering = campaign.offering as unknown as Offering;

  for (const incoming of messages) {
    const contact = await db.contact.findFirst({
      where: { email: incoming.from, lead: { campaignId: campaign.id } },
      include: { lead: true, enrollments: true },
    });
    if (!contact) continue; // not ours

    const analysed = await analyseReply(incoming.body, incoming.subject);
    summary.repliesHandled += 1;

    await db.message.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        enrollmentId: contact.enrollments[0]?.id,
        direction: "inbound",
        status: "received",
        toEmail: incoming.to,
        fromEmail: incoming.from,
        subject: incoming.subject,
        body: incoming.body,
        messageId: incoming.messageId,
        inReplyTo: incoming.inReplyTo,
        analysis: analysed.analysis as unknown as object,
      },
    });

    const enrollment = contact.enrollments[0];
    const sequence = (enrollment?.sequence as Sequence | undefined) ?? DEFAULT_SEQUENCE;

    // Honour stops immediately and globally, before anything else.
    if (analysed.analysis.intent === "unsubscribe" || analysed.analysis.intent === "bounce") {
      summary.stopsHonoured += 1;
      await db.suppression.upsert({
        where: { userId_email: { userId: campaign.userId, email: contact.email } },
        create: {
          userId: campaign.userId,
          email: contact.email,
          reason: analysed.analysis.intent === "bounce" ? "hard_bounce" : "unsubscribed",
          sourceCampaignId: campaign.id,
        },
        update: {},
      });
      if (enrollment) {
        const next = advance(
          { state: enrollment.state, nextStepIndex: enrollment.nextStepIndex } as EnrollmentSnapshot,
          { type: analysed.analysis.intent === "bounce" ? "bounced" : "unsubscribed", at: now() },
          sequence,
        );
        await db.enrollment.update({
          where: { id: enrollment.id },
          data: { state: next.state, nextDueAt: null },
        });
      }
      await logEvent(campaign.id, "reply.stop", `${contact.email} — ${analysed.analysis.intent}; suppressed and cadence stopped.`);
      continue;
    }

    if (analysed.analysis.intent === "auto_reply") {
      await logEvent(campaign.id, "reply.auto", `${contact.email} is away; cadence left running.`);
      continue;
    }

    // A real human replied: pause the cadence and move the deal.
    if (enrollment) {
      const next = advance(
        { state: enrollment.state, nextStepIndex: enrollment.nextStepIndex } as EnrollmentSnapshot,
        { type: "replied", at: now(), intent: analysed.analysis.intent },
        sequence,
      );
      await db.enrollment.update({
        where: { id: enrollment.id },
        data: { state: next.state, repliedAt: now(), nextDueAt: null },
      });
    }

    const deal = await db.deal.upsert({
      where: { leadId: contact.leadId },
      create: { campaignId: campaign.id, leadId: contact.leadId, stage: "engaged" },
      update: {},
    });
    const nextStage = stageFor(analysed.analysis.intent, deal.stage);
    if (nextStage !== deal.stage) {
      await db.deal.update({
        where: { id: deal.id },
        data: {
          stage: nextStage,
          closedAt: nextStage === "won" || nextStage === "lost" ? now() : null,
          meetingAt: nextStage === "meeting_booked" ? now() : deal.meetingAt,
          lostReason: nextStage === "lost" ? analysed.analysis.intent : null,
        },
      });
    }

    await logEvent(campaign.id, "reply.classified",
      `${contact.email}: ${analysed.analysis.intent}${analysed.analysis.objection !== "none" ? ` (${analysed.analysis.objection})` : ""} → ${nextStage}`,
      { confidence: analysed.analysis.confidence, suggestedAction: analysed.suggestedAction });

    // Draft an answer. Anything uncertain waits for a human.
    if (!config) continue;
    // A closed deal gets no further automated replies in either direction:
    // a lost one has said no, and a won one is a customer now, not a prospect.
    if (nextStage === "lost" || nextStage === "won") continue;

    const agentTurns = await db.message.count({
      where: { contactId: contact.id, direction: "outbound", status: "sent" },
    });

    const thread = await db.message.findMany({
      where: { contactId: contact.id },
      orderBy: { createdAt: "asc" },
      take: 10,
    });

    const reply = await composeReply({
      offering,
      lead: (contact.lead.profile as unknown as LeadProfile) ?? {
        companyName: contact.lead.companyName, domain: contact.lead.domain,
        technologies: [], evidence: [], publicContacts: [],
      },
      sender: config.sender,
      meetingLink: campaign.meetingLink ?? undefined,
      analysis: analysed.analysis,
      thread: thread.map((m) => ({
        direction: m.direction === "outbound" ? "out" : "in",
        subject: m.subject, body: m.body, at: m.createdAt,
      })),
    });

    await db.message.create({
      data: {
        campaignId: campaign.id,
        contactId: contact.id,
        enrollmentId: enrollment?.id,
        direction: "outbound",
        status: reply.requiresApproval ? "awaiting_approval" : "queued",
        toEmail: contact.email,
        fromEmail: config.sender.fromEmail,
        subject: reply.draft.subject,
        body: reply.draft.body,
        composedVia: reply.via,
        citedEvidence: reply.draft.citedEvidence as unknown as object,
        inReplyTo: incoming.messageId,
        stepIntent: `reply:${analysed.analysis.intent}`,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Stage 3 — discovery
// ---------------------------------------------------------------------------

async function runDiscovery(
  db: PrismaClient, campaign: Campaign, icp: Icp, offering: Offering,
  sources: ProspectSource[], limits: TickLimits, summary: TickSummary,
): Promise<void> {
  const inFlight = await db.lead.count({
    where: { campaignId: campaign.id, status: { in: ["discovered", "qualifying", "qualified", "enrolled"] } },
  });
  const wanted = Math.min(limits.discoverPerTick, campaign.targetLeads - inFlight);
  if (wanted <= 0) return;

  const existing = await db.lead.findMany({ where: { campaignId: campaign.id }, select: { domain: true } });
  const exclude = new Set<string>([...existing.map((l) => l.domain), offering.domain]);

  const report = await discoverProspects(sources, { icp, offering, limit: wanted, exclude });

  for (const candidate of report.candidates) {
    try {
      await db.lead.create({
        data: {
          campaignId: campaign.id,
          domain: candidate.domain,
          companyName: candidate.companyNameHint ?? candidate.domain,
          url: candidate.url,
          discoveredVia: candidate.discoveredVia,
        },
      });
      summary.discovered += 1;
    } catch {
      // Unique violation — another tick found it first.
    }
  }

  const skipped = report.bySource.filter((s) => s.skipped);
  if (summary.discovered === 0 && skipped.length > 0) {
    summary.notes.push(`No new leads. Sources: ${skipped.map((s) => `${s.source} (${s.skipped})`).join("; ")}`);
  }
  if (summary.discovered > 0) {
    await logEvent(campaign.id, "discovery.found", `Found ${summary.discovered} new companies.`, report.bySource);
  }
}

// ---------------------------------------------------------------------------
// Stage 4 — qualification
// ---------------------------------------------------------------------------

async function runQualification(
  db: PrismaClient, campaign: Campaign, icp: Icp, offering: Offering,
  limits: TickLimits, summary: TickSummary, deps: TickDeps,
): Promise<void> {
  const pending = await db.lead.findMany({
    where: { campaignId: campaign.id, status: "discovered" },
    take: limits.qualifyPerTick,
    orderBy: { createdAt: "asc" },
  });

  for (const lead of pending) {
    await db.lead.update({ where: { id: lead.id }, data: { status: "qualifying" } });
    try {
      const result = await qualify(
        { domain: lead.domain, url: lead.url, discoveredVia: lead.discoveredVia },
        icp, offering, { hostDelayMs: deps.hostDelayMs },
      );

      const rejected = result.rejected ?? (result.fit.band === "disqualified" ? result.fit.disqualifiedBecause : undefined);

      await db.lead.update({
        where: { id: lead.id },
        data: {
          status: rejected ? "rejected" : "qualified",
          companyName: result.profile.companyName,
          profile: result.profile as unknown as object,
          fit: result.fit as unknown as object,
          fitScore: result.fit.score,
          fitBand: result.fit.band,
          rejectedReason: rejected,
          qualifiedAt: new Date(),
        },
      });

      // Persist the contacts we are allowed to approach.
      for (const contact of result.profile.publicContacts.slice(0, 3)) {
        await db.contact.upsert({
          where: { leadId_email: { leadId: lead.id, email: contact.email } },
          create: {
            leadId: lead.id, email: contact.email, name: contact.name,
            title: contact.title, kind: contact.kind, source: contact.source,
          },
          update: {},
        });
      }

      if (rejected) {
        summary.rejected += 1;
        await logEvent(campaign.id, "lead.rejected", `${result.profile.companyName}: ${rejected}`);
      } else {
        summary.qualified += 1;
        await logEvent(campaign.id, "lead.qualified",
          `${result.profile.companyName} scored ${result.fit.score} (${result.fit.band}).`,
          { reasons: result.fit.reasons.slice(0, 3), contacts: result.profile.publicContacts.length });
      }
    } catch (err) {
      await db.lead.update({
        where: { id: lead.id },
        data: { status: "rejected", rejectedReason: err instanceof Error ? err.message : String(err) },
      });
      summary.rejected += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 5 — enrollment
// ---------------------------------------------------------------------------

async function runEnrollment(
  db: PrismaClient, campaign: Campaign, limits: TickLimits,
  summary: TickSummary, now: () => Date,
): Promise<void> {
  const ready = await db.lead.findMany({
    where: {
      campaignId: campaign.id,
      status: "qualified",
      fitScore: { gte: campaign.minFitScore },
      contacts: { some: {} },
    },
    include: { contacts: true },
    orderBy: { fitScore: "desc" },
    take: limits.enrollPerTick,
  });

  const suppressed = new Set(
    (await db.suppression.findMany({ where: { userId: campaign.userId }, select: { email: true } }))
      .map((s) => s.email),
  );

  for (const lead of ready) {
    // One contact per company. Mailing three people at the same 40-person
    // company is how a sender gets reported, and the best contact is already
    // sorted first by qualification.
    const contact = lead.contacts.find((c) => !suppressed.has(c.email));
    if (!contact) {
      await db.lead.update({ where: { id: lead.id }, data: { status: "rejected", rejectedReason: "All contacts suppressed." } });
      continue;
    }

    const sequence: Sequence = isRoleInbox(contact.email) ? ROLE_INBOX_SEQUENCE : DEFAULT_SEQUENCE;
    const enrolledAt = now();
    const due = nextDueAt({ state: "pending", nextStepIndex: 0 }, sequence, enrolledAt);

    try {
      await db.enrollment.create({
        data: {
          campaignId: campaign.id,
          leadId: lead.id,
          contactId: contact.id,
          sequenceName: sequence.name,
          sequence: sequence as unknown as object,
          enrolledAt,
          nextDueAt: due,
        },
      });
      await db.lead.update({ where: { id: lead.id }, data: { status: "enrolled" } });
      await db.deal.upsert({
        where: { leadId: lead.id },
        create: { campaignId: campaign.id, leadId: lead.id, stage: "prospect" },
        update: {},
      });
      summary.enrolled += 1;
      await logEvent(campaign.id, "lead.enrolled", `${lead.companyName} → ${contact.email} on "${sequence.name}".`);
    } catch {
      // Already enrolled (unique on contactId).
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 6 — outbound
// ---------------------------------------------------------------------------

async function runOutbound(
  db: PrismaClient, campaign: Campaign, offering: Offering,
  outbound: OutboundTransport, limits: TickLimits, summary: TickSummary, now: () => Date,
): Promise<void> {
  const config = campaignConfig(campaign);
  if (!config) {
    summary.notes.push("No sender identity configured — nothing can be sent.");
    return;
  }

  // Anything a human already approved, plus cadence steps that are now due.
  const approved = await db.message.findMany({
    where: { campaignId: campaign.id, direction: "outbound", status: "queued" },
    take: limits.sendPerTick,
    orderBy: { createdAt: "asc" },
    include: { contact: true },
  });

  const due = await db.enrollment.findMany({
    where: {
      campaignId: campaign.id,
      state: { in: ["pending", "active"] },
      nextDueAt: { lte: now() },
    },
    include: { contact: true, lead: true },
    orderBy: { nextDueAt: "asc" },
    take: Math.max(0, limits.sendPerTick - approved.length),
  });

  const startOfDay = new Date(now());
  startOfDay.setUTCHours(0, 0, 0, 0);

  const countsFor = async (toEmail: string) => {
    const [sentToday, sentTodayToDomain, lastTouch] = await Promise.all([
      db.message.count({
        where: { direction: "outbound", status: "sent", fromEmail: config.sender.fromEmail, sentAt: { gte: startOfDay } },
      }),
      db.message.count({
        where: {
          direction: "outbound", status: "sent", fromEmail: config.sender.fromEmail,
          sentAt: { gte: startOfDay }, toEmail: { endsWith: `@${domainOf(toEmail)}` },
        },
      }),
      db.message.findFirst({
        where: { direction: "outbound", status: "sent", toEmail },
        orderBy: { sentAt: "desc" },
        select: { sentAt: true },
      }),
    ]);
    return { sentToday, sentTodayToDomain, lastTouch: lastTouch?.sentAt ?? undefined };
  };

  const trySend = async (args: {
    messageId?: string; contactId: string; enrollmentId?: string; toEmail: string; toName?: string;
    subject: string; body: string; stepIndex?: number; stepIntent?: string; composedVia?: string;
    citedEvidence?: unknown; inReplyTo?: string; isReply?: boolean;
  }): Promise<boolean> => {
    const suppression = await db.suppression.findUnique({
      where: { userId_email: { userId: campaign.userId, email: args.toEmail } },
    });
    const counts = await countsFor(args.toEmail);

    const decision = evaluateSend(
      {
        toEmail: args.toEmail,
        now: now(),
        sentToday: counts.sentToday,
        sentTodayToDomain: counts.sentTodayToDomain,
        lastTouchedAt: counts.lastTouch,
        isReply: args.isReply,
        suppressed: Boolean(suppression),
        suppressionReason: suppression?.reason as never,
      },
      config.compliance,
    );

    if (!decision.allowed) {
      summary.blocked += 1;
      const data = {
        status: "blocked" as const,
        blockedCode: decision.code,
        blockedReason: decision.reason,
      };
      if (args.messageId) await db.message.update({ where: { id: args.messageId }, data });
      else
        await db.message.create({
          data: {
            campaignId: campaign.id, contactId: args.contactId, enrollmentId: args.enrollmentId,
            direction: "outbound", toEmail: args.toEmail, fromEmail: config.sender.fromEmail,
            subject: args.subject, body: args.body, stepIndex: args.stepIndex,
            stepIntent: args.stepIntent, composedVia: args.composedVia, ...data,
          },
        });
      await logEvent(campaign.id, "send.blocked", `${args.toEmail}: ${decision.reason}`, { code: decision.code }, "warn");
      return false;
    }

    const result = await outbound.send({
      to: args.toEmail,
      toName: args.toName,
      from: config.sender.fromEmail,
      fromName: config.sender.fromName,
      replyTo: config.sender.replyTo,
      subject: args.subject,
      body: args.body,
      inReplyTo: args.inReplyTo,
    });

    const data = result.ok
      ? { status: "sent" as const, sentAt: now(), messageId: result.messageId, error: null }
      : { status: "failed" as const, error: result.error };

    if (args.messageId) await db.message.update({ where: { id: args.messageId }, data });
    else
      await db.message.create({
        data: {
          campaignId: campaign.id, contactId: args.contactId, enrollmentId: args.enrollmentId,
          direction: "outbound", toEmail: args.toEmail, fromEmail: config.sender.fromEmail,
          subject: args.subject, body: args.body, stepIndex: args.stepIndex,
          stepIntent: args.stepIntent, composedVia: args.composedVia,
          citedEvidence: args.citedEvidence as object, inReplyTo: args.inReplyTo, ...data,
        },
      });

    if (result.ok) {
      summary.sent += 1;
      await logEvent(campaign.id, "send.ok", `${args.stepIntent ?? "message"} → ${args.toEmail} via ${outbound.name}.`);
    } else {
      await logEvent(campaign.id, "send.failed", `${args.toEmail}: ${result.error}`, undefined, "error");
    }
    return result.ok;
  };

  // Approved replies first — a waiting prospect outranks a cold step.
  for (const message of approved) {
    await trySend({
      messageId: message.id,
      contactId: message.contactId,
      enrollmentId: message.enrollmentId ?? undefined,
      toEmail: message.toEmail,
      subject: message.subject,
      body: message.body,
      stepIntent: message.stepIntent ?? undefined,
      composedVia: message.composedVia ?? undefined,
      inReplyTo: message.inReplyTo ?? undefined,
      // Everything in this queue was drafted in answer to an inbound message.
      isReply: true,
    });
  }

  for (const enrollment of due) {
    const sequence = enrollment.sequence as unknown as Sequence;
    const step = sequence.steps[enrollment.nextStepIndex];
    if (!step) {
      await db.enrollment.update({ where: { id: enrollment.id }, data: { state: "exhausted", nextDueAt: null } });
      continue;
    }

    const profile = enrollment.lead.profile as LeadProfile | null;
    const fit = enrollment.lead.fit as FitResult | null;
    if (!profile || !fit) continue;

    const contact: DiscoveredContact = {
      email: enrollment.contact.email,
      name: enrollment.contact.name ?? undefined,
      title: enrollment.contact.title ?? undefined,
      source: enrollment.contact.source,
      kind: enrollment.contact.kind === "role" ? "role" : "individual",
    };

    const composed = await compose({ offering, lead: profile, fit, contact, step, sender: config.sender });

    const ok = await trySend({
      contactId: enrollment.contactId,
      enrollmentId: enrollment.id,
      toEmail: contact.email,
      toName: contact.name,
      subject: composed.draft.subject,
      body: composed.draft.body,
      stepIndex: step.index,
      stepIntent: step.intent,
      composedVia: composed.via,
      citedEvidence: composed.draft.citedEvidence,
    });

    if (!ok) continue;

    const nextState = advance(
      { state: enrollment.state, nextStepIndex: enrollment.nextStepIndex, lastSentAt: enrollment.lastSentAt ?? undefined },
      { type: "sent", at: now() },
      sequence,
    );
    await db.enrollment.update({
      where: { id: enrollment.id },
      data: {
        state: nextState.state,
        nextStepIndex: nextState.nextStepIndex,
        lastSentAt: now(),
        nextDueAt: nextDueAt(nextState, sequence, enrollment.enrolledAt),
      },
    });
    await db.deal.updateMany({
      where: { leadId: enrollment.leadId, stage: "prospect" },
      data: { stage: "contacted" },
    });
  }
}
