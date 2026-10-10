/**
 * `npm run demo`
 *
 * Proves the whole loop end-to-end against the local fixture web: one URL in,
 * companies discovered and qualified, outreach written and sent, buyers
 * replying in character, objections handled, opt-outs honoured, deals closed.
 *
 * Two things are simulated and nothing else: the websites (served locally,
 * but over real HTTP) and the buyers (personas that answer what the agent
 * actually wrote). The crawler, scorer, composer, compliance gate, cadence
 * engine, transports and classifier are the production ones.
 *
 * The clock is advanced deliberately. Cadence delays are measured in business
 * days, so a real-time demo would sit idle for a week to show touch two.
 */
import "../lib/loadEnv";
import { rm } from "node:fs/promises";
import { prisma } from "../infra/db";
import { ensureOperator } from "../lib/operator";
import { tick } from "../agent/orchestrator";
import { DryRunTransport, MaildirInbound } from "../infra/transport";
import { sourcesFromEnv } from "../infra/sources";
import { ingest } from "../agent/ingest";
import { llm } from "../infra/llm/client";
import { approveMessage, markWon } from "../agent/deals";
import { personaFor, replyAs } from "../../fixtures/buyers";
import { SELLER_HOST, DIRECTORY_HOST } from "../../fixtures/world";
import { bullet, c, heading, kv, ok, parseArgs, warn } from "./ui";

const PORT = process.env.FIXTURE_PORT ?? "4000";
const SELLER_URL = `http://${SELLER_HOST}:${PORT}`;
const DIRECTORY_URL = `http://${DIRECTORY_HOST}:${PORT}/members`;

/** A Monday, so the first touch is due immediately rather than next week. */
const START = new Date("2026-10-12T09:00:00.000Z");
const OUTBOX = "outbox";
const INBOX = "inbox";

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE campaigns, leads, contacts, enrollments, messages, deals, suppressions, events, agent_runs RESTART IDENTITY CASCADE`,
  );
  await rm(OUTBOX, { recursive: true, force: true });
  await rm(INBOX, { recursive: true, force: true });
}

/**
 * Lets the fixture buyers answer anything the agent has sent them and not
 * yet heard back about. Replies are written into the inbox directory as real
 * RFC 5322 files and picked up by the ordinary inbound transport.
 */
async function runBuyers(campaignId: string, inbound: MaildirInbound, at: Date): Promise<number> {
  const sent = await prisma.message.findMany({
    where: { campaignId, direction: "outbound", status: "sent" },
    orderBy: { sentAt: "asc" },
    include: { contact: true },
  });

  let replied = 0;
  for (const message of sent) {
    const persona = personaFor(message.toEmail);
    if (!persona) continue;

    // How many times this persona has already answered, and whether they have
    // seen this particular message.
    const [priorReplies, answeredAlready] = await Promise.all([
      prisma.message.count({ where: { campaignId, direction: "inbound", contactId: message.contactId } }),
      prisma.message.count({
        where: { campaignId, direction: "inbound", contactId: message.contactId, createdAt: { gt: message.createdAt } },
      }),
    ]);
    if (answeredAlready > 0) continue;
    if (priorReplies + 1 < persona.repliesFromTouch) continue;

    const body = await replyAs(persona, { subject: message.subject, body: message.body }, priorReplies);
    if (!body) continue;

    await inbound.deliver({
      from: persona.email,
      to: message.fromEmail,
      subject: message.subject.startsWith("Re:") ? message.subject : `Re: ${message.subject}`,
      body: `${body}\n\nOn ${at.toUTCString()}, ${message.fromEmail} wrote:\n> ${message.body.split("\n").join("\n> ")}`,
      inReplyTo: message.messageId ?? undefined,
    });
    replied += 1;
  }
  return replied;
}

/**
 * The human in the loop.
 *
 * The agent deliberately holds two things back for a person: a reply it is
 * not confident about, and anything involving signing or money. This stands
 * in for that person so the demo can show a complete funnel — it approves
 * held replies and confirms the payment that turns a proposal into a win.
 * Nothing here is something the agent decided on its own.
 */
async function runOperator(campaignId: string, userId: string): Promise<string | null> {
  const actions: string[] = [];

  const held = await prisma.message.findMany({
    where: { campaignId, direction: "outbound", status: "awaiting_approval" },
  });
  for (const m of held) await approveMessage(m.id);
  if (held.length) actions.push(`${held.length} reply approved by operator`);

  // A payment provider confirming the money landed is what closes a deal.
  const proposals = await prisma.deal.findMany({
    where: { campaignId, stage: "proposal" },
    include: { lead: true },
  });
  for (const deal of proposals) {
    await markWon(
      deal.id,
      { by: "payment", provider: "stripe", reference: `pi_demo_${deal.id.slice(-8)}` },
      { valueCents: 99_00 * 30 * 12, note: "30 seats, annual" },
    );
    actions.push(`${deal.lead.companyName} paid — won`);
  }

  return actions.length ? actions.join("; ") : null;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const days = typeof flags.days === "string" ? Number(flags.days) : 12;

  heading("Rainmaker — end-to-end demo");
  bullet(`Seller:    ${c.cyan(SELLER_URL)}`);
  bullet(`Directory: ${c.cyan(DIRECTORY_URL)}`);
  bullet(`Model:     ${llm().enabled ? c.green(llm().model) : c.yellow("none — deterministic fallbacks")}`);
  bullet(`Transport: ${c.green("dry run")} (messages written to ./${OUTBOX}, nobody is contacted)`);

  await reset();
  const operator = await ensureOperator();

  // Point the directory source at the fixture web for this run only.
  process.env.DIRECTORY_URLS = DIRECTORY_URL;

  heading("Learning the product");
  const learned = await ingest(SELLER_URL, { hostDelayMs: 10 });
  ok(`${learned.offering.companyName} — ${learned.offering.oneLiner}`);
  kv("Categories", learned.icp.industries.slice(0, 4).join(", ") || "—");
  kv("Pain signals", learned.icp.painSignals.slice(0, 5).join(", "));
  kv("Disqualifiers", learned.icp.negativeSignals.slice(0, 3).join(", "));

  const campaign = await prisma.campaign.create({
    data: {
      userId: operator.id,
      sourceUrl: SELLER_URL,
      name: learned.offering.companyName,
      status: "running",
      offering: learned.offering as unknown as object,
      icp: learned.icp as unknown as object,
      senderIdentity: {
        fromName: "Sam Okafor",
        fromEmail: `sam@${learned.offering.domain}`,
        postalAddress: learned.sellerPostalAddress ?? "12 Dock Road, Bristol BS1 6RR, United Kingdom",
        unsubscribeUrl: `${SELLER_URL}/unsubscribe`,
        replyTo: `sam@${learned.offering.domain}`,
      } as unknown as object,
      // Weekends included so a twelve-day simulation is not mostly idle.
      complianceConfig: { sendDays: [0, 1, 2, 3, 4, 5, 6] } as unknown as object,
      meetingLink: `${SELLER_URL}/book`,
      targetLeads: 10,
      // Lower than the 55 default so the demo exercises every buyer
      // behaviour, including the opt-out and the "not now". The heuristic
      // ICP (no API key) scores conservatively, and a 55 bar would contact
      // only two companies.
      minFitScore: 40,
    },
  });

  const outbound = new DryRunTransport(OUTBOX);
  const inbound = new MaildirInbound(INBOX);
  const sources = sourcesFromEnv();

  heading("Running the agent");
  console.log(c.dim("  day   found  qual  enrol   sent  blocked  replies  stops"));

  for (let day = 0; day < days; day++) {
    const clock = new Date(START.getTime() + day * 86_400_000);
    const now = () => clock;

    // Two passes a day: one to act, one to process whatever came back.
    const first = await tick(campaign.id, { sources, outbound, inbound, now, hostDelayMs: 10 });
    const replies = await runBuyers(campaign.id, inbound, clock);
    const second = await tick(campaign.id, { sources, outbound, inbound, now, hostDelayMs: 10 });
    const humanActions = await runOperator(campaign.id, operator.id);

    const row = {
      found: first.discovered + second.discovered,
      qual: first.qualified + second.qualified,
      enrol: first.enrolled + second.enrolled,
      sent: first.sent + second.sent,
      blocked: first.blocked + second.blocked,
      replies: first.repliesHandled + second.repliesHandled,
      stops: first.stopsHonoured + second.stopsHonoured,
    };
    const n = (v: number, colour?: (s: string) => string) =>
      (v === 0 ? c.dim("·") : colour ? colour(String(v)) : String(v)).padStart(v === 0 ? 6 : 6);

    console.log(
      `  ${clock.toISOString().slice(5, 10)}  ${n(row.found)} ${n(row.qual)} ${n(row.enrol)} ` +
        `${n(row.sent, c.green)} ${n(row.blocked, c.yellow)} ${n(row.replies, c.cyan)} ${n(row.stops, c.red)}` +
        (replies ? c.dim(`   (${replies} buyer replies queued)`) : "") +
        (humanActions ? c.dim(`   (${humanActions})`) : ""),
    );
  }

  await report(campaign.id);
  await prisma.$disconnect();
}

async function report(campaignId: string): Promise<void> {
  const leads = await prisma.lead.findMany({
    where: { campaignId },
    orderBy: [{ fitScore: "desc" }],
    include: { deals: true, contacts: { include: { enrollments: true } } },
  });

  heading("Funnel");
  console.log(`  ${"COMPANY".padEnd(24)} ${"FIT".padStart(4)}  ${"BAND".padEnd(13)} ${"STAGE".padEnd(15)} WHY NOT`);
  for (const lead of leads) {
    const stage = lead.deals[0]?.stage ?? "—";
    const colour =
      stage === "won" ? c.green : stage === "lost" ? c.red : stage === "meeting_booked" ? c.cyan : (s: string) => s;
    console.log(
      `  ${lead.companyName.slice(0, 24).padEnd(24)} ${String(lead.fitScore ?? "—").padStart(4)}  ` +
        `${(lead.fitBand ?? "—").padEnd(13)} ${colour(stage.padEnd(15))} ${c.dim((lead.rejectedReason ?? "").slice(0, 40))}`,
    );
  }

  const [sent, blocked, inboundCount, suppressed] = await Promise.all([
    prisma.message.count({ where: { campaignId, direction: "outbound", status: "sent" } }),
    prisma.message.findMany({ where: { campaignId, direction: "outbound", status: "blocked" }, select: { blockedCode: true } }),
    prisma.message.count({ where: { campaignId, direction: "inbound" } }),
    prisma.suppression.count(),
  ]);

  heading("Totals");
  kv("Messages sent", sent);
  kv("Replies received", inboundCount);
  kv("Blocked by compliance", blocked.length ? `${blocked.length} (${[...new Set(blocked.map((b) => b.blockedCode))].join(", ")})` : "0");
  kv("Suppressed (opt-outs)", suppressed);

  const stages = await prisma.deal.groupBy({ by: ["stage"], where: { campaignId }, _count: true });
  for (const s of stages) kv(`Deals · ${s.stage}`, s._count);

  // Show one real message so the output can be judged, not just counted.
  const sample = await prisma.message.findFirst({
    where: { campaignId, direction: "outbound", status: "sent" },
    orderBy: { sentAt: "asc" },
  });
  if (sample) {
    heading("First message sent (verbatim)");
    console.log(c.dim(`  To: ${sample.toEmail}   Subject: ${sample.subject}   [composed via ${sample.composedVia}]`));
    console.log(sample.body.split("\n").map((l) => `  ${l}`).join("\n"));
  }

  const thread = await prisma.message.findMany({
    where: { campaignId, direction: "inbound" },
    orderBy: { createdAt: "asc" },
    take: 3,
    include: { contact: true },
  });
  if (thread.length) {
    heading("Replies received");
    for (const m of thread) {
      const a = m.analysis as { intent?: string; objection?: string; confidence?: number } | null;
      console.log(
        `  ${c.bold(m.contact.email.padEnd(34))} ${c.cyan(a?.intent ?? "?")}` +
          (a?.objection && a.objection !== "none" ? c.dim(` / ${a.objection}`) : ""),
      );
      console.log(c.dim(`    "${m.body.split("\n")[0]?.slice(0, 96)}"`));
    }
  }

  const evts = await prisma.event.findMany({
    where: { campaignId, kind: { in: ["reply.stop", "send.blocked"] } },
    take: 6,
    orderBy: { createdAt: "asc" },
  });
  if (evts.length) {
    heading("Compliance decisions");
    for (const e of evts) bullet(`${c.yellow(e.kind)} ${e.message}`);
  }
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
