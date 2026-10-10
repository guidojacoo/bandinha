import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { db, logEvent } from "../infra/db";
import { DEFAULT_TERMS, formatMoney, renderInvoice } from "../core/billing";
import { closeDeal, confirmMeeting, invoiceFor } from "../agent/billing";
import { headline, reportFor } from "../agent/learning";
import { rate } from "../core/learning";
import { ingest } from "../agent/ingest";
import { pipelineSummary, tick } from "../agent/orchestrator";
import { fromJson, toJson } from "../lib/json";
import { fetchText } from "../infra/http";
import { prospectDomains, world } from "../../fixtures/world";
import { colour, heading, llmForRun, requireDatabase, run } from "./lib";

/**
 * `npm run demo` — the whole thing, start to finish, in one command.
 *
 * It runs against the bundled fixture web (ten sites on reserved `.test`
 * names) rather than real companies, for two reasons that are not negotiable:
 * crawling strangers hard enough to demonstrate a crawler is rude, and
 * mailing strangers to demonstrate a mailer is unlawful.
 *
 * What makes this a proof rather than a screenshot is the last section. Four
 * of the nine prospects are built to be rejected — a competitor, a two-person
 * studio, a company with nothing quotable, and one that publishes only
 * abuse@ — and the demo asserts that each was rejected for the right reason.
 * A gate that silently stops working would pass a demo that only counted
 * emails.
 */

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.FIXTURE_PORT ?? 8080);

run(async () => {
  await requireDatabase();

  heading("Mercurio demo");
  console.log(`Nine prospects, five of which should be contacted and four of which should not.`);
  console.log(colour.dim(`Everything runs against http://*.test:${PORT} — no real company is crawled, no real address is mailed.\n`));

  // --- 0. the fixture web has to be up -----------------------------------
  const probe = await fetchText(`http://northwind.test:${PORT}/`, { timeoutMs: 4_000 });
  if (!probe.ok) {
    console.log(`${colour.red("✗")} The fixture web is not reachable at http://northwind.test:${PORT}/`);
    console.log(`\n  Two commands, in two terminals:\n`);
    console.log(`    ${colour.bold("sudo npm run fixtures:hosts")}   ${colour.dim("point the .test names at localhost (once)")}`);
    console.log(`    ${colour.bold("npm run fixtures")}              ${colour.dim("serve the fixture web")}`);
    console.log(`\n  Then run ${colour.bold("npm run demo")} again.\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`${colour.green("✓")} Fixture web is up (${world.length} sites).`);

  // --- 1. a clean slate ---------------------------------------------------
  for (const dir of ["./outbox", "./inbox"]) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  }
  const user = await db.user.upsert({
    where: { email: "demo@mercurio.test" },
    create: { email: "demo@mercurio.test", name: "Demo Operator", passwordHash: await bcrypt.hash("demo-password", 10) },
    update: {},
  });
  await db.campaign.deleteMany({ where: { userId: user.id, name: "Northwind (demo)" } });
  await db.suppression.deleteMany({ where: { userId: user.id } });

  // --- 2. one URL in ------------------------------------------------------
  heading("1. Reading the seller's own website");
  const llm = llmForRun();
  console.log(llm.available()
    ? colour.dim("  Groq is configured, so copy is written by the model and checked by the validator.")
    : colour.dim("  No GROQ_API_KEY, so this is the deterministic path end to end."));

  const ingested = await ingest(`http://northwind.test:${PORT}/`, llm, {
    onProgress: (message) => console.log(colour.dim(`  ${message}`)),
  });
  if ("error" in ingested) throw new Error(ingested.error);

  const { offering, icp } = ingested;
  console.log(`\n  Sells:    ${colour.bold(offering.companyName)} — ${offering.oneLiner}`);
  console.log(`  Claims:   ${offering.valueProps.length} sourced value prop(s), ${offering.proofPoints.length} proof point(s)`);
  console.log(`  Buyers:   ${icp.buyerTitles.slice(0, 4).join(", ")}`);
  console.log(`  Looks for: ${icp.painSignals.slice(0, 5).join(", ")}`);
  console.log(`  Avoids:    ${icp.negativeSignals.slice(0, 4).join(", ")}`);

  // --- 3. the campaign ----------------------------------------------------
  // The seed source stands in for open-data discovery here, because the
  // fixture companies do not exist on GitHub or in OpenStreetMap. The live
  // sources are exercised by `npm run discover`.
  process.env.SEED_DOMAINS = prospectDomains().map((d) => `http://${d}:${PORT}/`).join(",");

  // A client to bill, so the run shows the money as well as the pipeline.
  await db.client.deleteMany({ where: { userId: user.id, name: "Northwind (demo client)" } });
  const client = await db.client.create({
    data: {
      userId: user.id,
      name: "Northwind (demo client)",
      contactEmail: "ap@northwind.test",
      billingAddress: "Northwind Software Ltd, 4 Dock Street, Bristol BS1 4RU",
      webhookSecret: randomBytes(24).toString("hex"),
      terms: toJson({ ...DEFAULT_TERMS, minimumInvoiceCents: 0 }),
    },
  });

  const campaign = await db.campaign.create({
    data: {
      userId: user.id,
      clientId: client.id,
      sourceUrl: `http://northwind.test:${PORT}/`,
      name: "Northwind (demo)",
      status: "running",
      offering: toJson(offering),
      icp: toJson({ ...icp, preferredSources: ["seed"], sourceHints: { seed: [] } }),
      // A cap of 60 so the warmup ramp is visibly in effect — day one allows
      // 15% of it, which is nine, exactly the number of fixture prospects.
      // Picking 30 here would have the ramp cap the run at four and the rest
      // of the loop would never execute, which demonstrates the ramp and
      // nothing else.
      complianceConfig: toJson({ dailySendCap: 60 }),
      senderIdentity: toJson({
        fromName: "Dana Reyes",
        fromEmail: "dana@northwind.test",
        postalAddress: "Northwind Software Ltd, 4 Dock Street, Bristol BS1 4RU, United Kingdom",
        unsubscribeUrl: "http://northwind.test/unsubscribe?t=demo",
        replyTo: "dana@northwind.test",
      }),
      meetingLink: "http://northwind.test/book/dana",
      targetLeads: 9,
      // Above the two-person studio's 53 and below every real prospect's 73.
      // That separation is the fit score doing its job; the threshold is
      // where the operator decides how much of the margin to work.
      minFitScore: 60,
      liveSending: false,
    },
  });
  await logEvent(campaign.id, "campaign.created", "Demo campaign created.", { level: "success" });
  console.log(`\n  Campaign ${colour.dim(campaign.id)} — dry run, writing to ./outbox`);

  // --- 4. the agent runs --------------------------------------------------
  //
  // The clock is pinned to a business hour. Not a convenience: the compliance
  // gate refuses to send at night or at the weekend, and the cadence moves a
  // zero-day first touch off a Saturday — both correct, and both mean a demo
  // run on a Sunday afternoon does nothing at all and looks broken. Pinning
  // it exercises the same code paths at a time they will actually fire.
  const clock = businessHour();
  console.log(colour.dim(`\n  Clock pinned to ${clock.toISOString()} — the agent will not send outside business hours.`));

  const rounds: Array<Awaited<ReturnType<typeof tick>>> = [];

  heading("2. Finding, qualifying and writing");
  rounds.push(await tick({
    campaignId: campaign.id,
    llm,
    useDns: false,
    now: clock,
    budget: { maxDiscover: 20, maxQualify: 9, maxSends: 9, maxReplies: 25 },
    onProgress: (message) => console.log(`  ${message}`),
  }));

  // A second tick, because qualification is budgeted per tick by design.
  rounds.push(await tick({
    campaignId: campaign.id,
    llm,
    useDns: false,
    now: clock,
    budget: { maxDiscover: 20, maxQualify: 9, maxSends: 9, maxReplies: 25 },
    onProgress: (message) => console.log(`  ${message}`),
  }));

  heading("3. The prospects reply");
  await runBuyers();

  heading("4. Handling what came back");
  rounds.push(await tick({
    campaignId: campaign.id,
    llm,
    useDns: false,
    now: clock,
    budget: { maxDiscover: 0, maxQualify: 0, maxSends: 9, maxReplies: 25 },
    onProgress: (message) => console.log(`  ${message}`),
  }));

  // Two more rounds of conversation, which is where the escalations surface.
  for (let round = 0; round < 2; round++) {
    await runBuyers();
    rounds.push(await tick({
      campaignId: campaign.id,
      llm,
      useDns: false,
      now: clock,
      budget: { maxDiscover: 0, maxQualify: 0, maxSends: 9, maxReplies: 25 },
      onProgress: (message) => console.log(`  ${message}`),
    }));
  }

  // --- 5. the money ------------------------------------------------------
  heading("5. What it earned");
  await settleAndBill(campaign.id, client.id, client.webhookSecret!);

  // --- 6. what the run taught it ------------------------------------------
  heading("6. What it learned");
  await showLearning(campaign.id);

  // --- 7. what actually happened ------------------------------------------
  await report(campaign.id, rounds);
});

/**
 * What the run taught it, which on nine prospects is almost nothing.
 *
 * Printed anyway, and that is the point: the honest output of a learning
 * layer at this volume is "not enough to say", and an operator should see
 * what that looks like before they see a confident number. Every analytics
 * screen in this category shows a ranked list of percentages from samples
 * this size and lets the reader assume the order means something.
 */
async function showLearning(campaignId: string): Promise<void> {
  const { reports, briefLines } = await reportFor(campaignId);
  const numbers = await headline(campaignId);

  console.log(`  ${numbers.contacted} prospect(s) contacted, ${numbers.replied} replied, ${numbers.positive} usefully.`);
  // Said plainly, because a demo reporting a 100% reply rate without
  // explaining why is the kind of number that makes people distrust
  // everything else on the page.
  console.log(colour.dim(`  Reply rate ${rate(numbers.replyRate)}, which means nothing: the fixture buyers are scripted to answer.`));
  console.log(colour.dim(`  Real cold email at 4%+ is doing well.`));
  console.log();

  for (const report of reports.slice(0, 3)) {
    console.log(`  ${colour.bold(report.label)}`);
    if (report.tooEarly) {
      console.log(`    ${colour.dim(report.tooEarly)}`);
      continue;
    }
    for (const finding of report.findings) {
      const rateText = finding.verdict === "too_early"
        ? colour.dim("not enough to say")
        : `${rate(finding.replyRate)} (at worst ${rate(finding.lowerBound)})`;
      console.log(`    ${finding.value.padEnd(24)} ${String(finding.sent).padStart(3)} sent  ${rateText}`);
    }
    if (report.recommendation) console.log(`    ${colour.dim(report.recommendation)}`);
  }

  console.log();
  console.log(briefLines.length > 0
    ? `  Fed back into the copy: ${briefLines.join(" ")}`
    : colour.dim(`  Nothing held up well enough to feed back into the copy, which is the right answer on ${numbers.contacted} prospects.`));
}

/**
 * Confirms a meeting, takes a payment, and prints the invoice.
 *
 * The payment goes through the real webhook handler rather than calling
 * `closeDeal` directly, signed with the client's own secret — because the
 * claim being demonstrated is that *only* a payment or a person can close a
 * deal, and a demo that bypassed the signature check would not be
 * demonstrating it.
 */
async function settleAndBill(campaignId: string, clientId: string, secret: string): Promise<void> {
  // A meeting is billable only once a person confirms it. The classifier
  // reading "happy to chat, what times suit?" as a meeting request is not
  // enough to bill a client on.
  const meeting = await db.deal.findFirst({
    where: { campaignId, stage: { in: ["meeting_booked", "proposal"] } },
    include: { lead: true },
    orderBy: { updatedAt: "desc" },
  });
  if (meeting) {
    await confirmMeeting(meeting.leadId, "demo operator");
    console.log(`  ${colour.green("✓")} Meeting with ${meeting.lead.companyName} confirmed by a person — now billable.`);
  }

  // The payment, through the signed webhook.
  const paying = await db.deal.findFirst({
    where: { campaignId, stage: "proposal" },
    include: { lead: true },
    orderBy: { updatedAt: "desc" },
  });

  if (paying) {
    const body = JSON.stringify({
      domain: paying.lead.domain,
      amountCents: 1_080_000,
      currency: "USD",
      reference: "pi_demo_3Kx91",
    });
    const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");

    const { POST } = await import("../app/api/payments/[clientId]/route");
    const response = await POST(
      new Request(`http://localhost/api/payments/${clientId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mercurio-signature": signature },
        body,
      }),
      { params: Promise.resolve({ clientId }) },
    );
    const result = (await response.json()) as { ok?: boolean; stage?: string; reason?: string };
    console.log(
      result.ok
        ? `  ${colour.green("✓")} Payment webhook closed ${paying.lead.companyName} at ${formatMoney(1_080_000)} — signature verified.`
        : `  ${colour.red("✗")} Payment webhook refused: ${result.reason}`,
    );

    // And prove the signature is actually load-bearing.
    const forged = await POST(
      new Request(`http://localhost/api/payments/${clientId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mercurio-signature": "0".repeat(64) },
        body: JSON.stringify({ domain: "fableworks.test", amountCents: 999_999 }),
      }),
      { params: Promise.resolve({ clientId }) },
    );
    console.log(
      forged.status === 401
        ? `  ${colour.green("✓")} An unsigned payment notification is refused (401).`
        : `  ${colour.red("✗")} An unsigned payment notification was accepted — the signature check is not working.`,
    );
  }

  const { invoice } = await invoiceFor(clientId);
  console.log();
  for (const line of renderInvoice(invoice, {
    from: "You",
    to: "Northwind Software Ltd, 4 Dock Street, Bristol BS1 4RU",
    reference: "demo-0001",
    notes: "Every line above can be checked against the messages in ./outbox.",
  }).split("\n")) {
    console.log(`  ${colour.dim("│")} ${line}`);
  }
}

/**
 * A business hour guaranteed to be *after* anything enrolled during this run.
 *
 * Subtler than it looks, and it cost a confusing run to work out. Enrollments
 * are written at the real wall clock, and the cadence schedules a zero-day
 * first touch with `addBusinessDays`, which rolls off a weekend while keeping
 * the time of day. So an enrollment created on a Saturday at 17:29 is first
 * due on Monday at 17:29 — and a clock pinned to "the next weekday at 10:00"
 * is Monday at 10:00, which is *earlier*. Nothing is due, nothing sends, and
 * the demo looks broken for reasons that have nothing to do with the agent.
 *
 * Pinning a full business day past that point is correct whatever time of day
 * the demo is run at.
 */
function businessHour(): Date {
  const date = new Date();
  // Roll off a weekend first, then one clear business day forward.
  const nextBusinessDay = () => {
    do {
      date.setUTCDate(date.getUTCDate() + 1);
    } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  };
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
  nextBusinessDay();
  date.setUTCHours(10, 0, 0, 0);
  return date;
}

async function runBuyers(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("npx", ["tsx", "fixtures/buyers.ts"], {
      env: process.env,
      maxBuffer: 4_000_000,
    });
    for (const line of stdout.trim().split("\n")) console.log(`  ${line}`);
  } catch (error) {
    console.log(colour.yellow(`  Could not run the fixture buyers: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function report(campaignId: string, rounds: Array<Awaited<ReturnType<typeof tick>>>): Promise<void> {
  const [leads, messages, escalations, suppressions, pipeline] = await Promise.all([
    db.lead.findMany({ where: { campaignId }, include: { contacts: true }, orderBy: { fitScore: "desc" } }),
    db.message.findMany({ where: { campaignId }, include: { contact: true }, orderBy: { createdAt: "asc" } }),
    db.event.findMany({ where: { campaignId, kind: "reply.escalated" } }),
    db.suppression.findMany({}),
    pipelineSummary(campaignId),
  ]);

  heading("7. Leads");
  for (const lead of leads) {
    const verdict = lead.status === "enrolled"
      ? colour.green("enrolled")
      : lead.status === "rejected" ? colour.dim("rejected") : lead.status;
    console.log(`  ${lead.domain.padEnd(22)} ${String(lead.fitScore ?? "–").padStart(3)}  ${verdict}`);
    if (lead.rejectedReason) console.log(colour.dim(`    ${lead.rejectedReason}`));
  }

  heading("8. What it wrote");
  const sent = messages.filter((m) => m.direction === "outbound" && m.status === "sent");
  const first = sent.find((m) => m.stepIndex === 0);
  if (first) {
    console.log(colour.dim(`  To: ${first.toEmail}   Subject: ${first.subject}   (${first.composedVia})`));
    console.log();
    for (const line of first.body.split("\n")) console.log(`  ${colour.cyan("│")} ${line}`);
  }

  heading("9. Totals");
  const totals = rounds.reduce(
    (sum, round) => ({
      discovered: sum.discovered + round.discovered,
      qualified: sum.qualified + round.qualified,
      rejected: sum.rejected + round.rejected,
      enrolled: sum.enrolled + round.enrolled,
      sent: sum.sent + round.sent,
      blocked: sum.blocked + round.blocked,
      repliesRead: sum.repliesRead + round.repliesRead,
      answered: sum.answered + round.answered,
    }),
    { discovered: 0, qualified: 0, rejected: 0, enrolled: 0, sent: 0, blocked: 0, repliesRead: 0, answered: 0 },
  );

  console.log(`  discovered   ${totals.discovered}`);
  console.log(`  qualified    ${totals.qualified}`);
  console.log(`  rejected     ${totals.rejected}`);
  console.log(`  enrolled     ${totals.enrolled}`);
  console.log(`  sent         ${totals.sent}  ${colour.dim("(to ./outbox — nothing left this machine)")}`);
  console.log(`  blocked      ${totals.blocked}`);
  console.log(`  replies read ${totals.repliesRead}`);
  console.log(`  answered     ${totals.answered}`);
  console.log(`  escalated    ${escalations.length}  ${colour.dim("(waiting for a person)")}`);
  console.log(`  suppressed   ${suppressions.length}`);
  console.log(`\n  Pipeline: ${Object.entries(pipeline.byStage).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`).join(", ")}`);

  heading("10. Did the gates actually fire?");
  const checks: Array<{ label: string; pass: boolean; detail: string }> = [];
  const byDomain = new Map(leads.map((l) => [l.domain, l]));

  for (const site of world.filter((s) => s.expect === "reject")) {
    const lead = byDomain.get(site.domain);
    checks.push({
      label: `${site.domain} rejected`,
      pass: lead?.status === "rejected",
      detail: lead ? `${lead.status}${lead.rejectedReason ? ` — ${lead.rejectedReason}` : ""}` : "never discovered",
    });
  }

  const competitor = byDomain.get("burnrate.test");
  checks.push({
    label: "competitor disqualified on self-description",
    pass: competitor?.fitBand === "disqualified",
    detail: `band ${competitor?.fitBand ?? "none"}`,
  });

  const noreply = byDomain.get("noreply.test");
  checks.push({
    label: "abuse@ and privacy@ never mailed",
    pass: !messages.some((m) => m.toEmail.endsWith("@noreply.test")) &&
      (noreply?.contacts.length ?? 0) === 0,
    detail: `${noreply?.contacts.length ?? 0} contact(s) stored for a site publishing only abuse, privacy and no-reply`,
  });

  checks.push({
    label: "no message sent without a postal address",
    pass: sent.every((m) => m.body.includes("Bristol BS1 4RU")),
    detail: `${sent.length} sent`,
  });
  checks.push({
    label: "no message sent without a way out",
    pass: sent.every((m) => /unsubscribe/i.test(m.body)),
    detail: `${sent.length} sent`,
  });
  checks.push({
    label: "every claim traced to a crawled page",
    pass: sent.every((m) => m.provenance !== null && m.provenance !== "null"),
    detail: `${sent.length} sent`,
  });
  checks.push({
    label: "opt-out suppressed globally",
    pass: suppressions.some((s) => s.reason === "unsubscribed"),
    detail: suppressions.map((s) => `${s.email} (${s.reason})`).join(", ") || "none",
  });
  const agentClosed = await db.deal.count({ where: { campaignId, stage: "won", closedBy: null } });
  checks.push({
    label: "the agent closed no deal by itself",
    pass: escalations.length > 0 && agentClosed === 0,
    detail: `${escalations.length} escalation(s), ${agentClosed} deal(s) won with nobody recorded as closing them`,
  });
  const billable = await db.billableEvent.findMany({ where: { campaignId }, include: { lead: true } });
  const wonDeals = await db.deal.findMany({ where: { campaignId, stage: "won" } });

  checks.push({
    label: "billed one contact per prospect, not one per message",
    // A four-touch sequence is one contact delivered. Charging per message
    // would pay the operator to send a fourth email to somebody who ignored
    // three, which is the behaviour the product's own gates exist to prevent.
    pass: billable.filter((e) => e.kind === "contact_delivered").length === sent.filter((m) => m.stepIndex === 0).length,
    detail: `${billable.filter((e) => e.kind === "contact_delivered").length} contact(s) billed, ${sent.length} message(s) sent`,
  });
  // One reply charge per prospect, not per message: Fableworks replied three
  // times in this run and is charged once. And nothing is charged for a
  // bounce, an out-of-office, or somebody asking to be left alone.
  const chargeableRepliers = new Set(
    messages
      .filter((m) => {
        if (m.direction !== "inbound") return false;
        const intent = fromJson<{ intent?: string }>(m.analysis, {}).intent ?? "";
        return !["bounce", "auto_reply", "unsubscribe"].includes(intent);
      })
      .map((m) => m.contact.leadId),
  );
  const billedReplies = billable.filter((e) => e.kind === "reply_received");
  checks.push({
    label: "one reply charge per prospect, none for a bounce or a complaint",
    pass: billedReplies.length === chargeableRepliers.size &&
      billedReplies.every((e) => !/bounce|out of office|unsubscribe/i.test(e.evidence)),
    detail: `${billedReplies.length} charged, ${chargeableRepliers.size} prospect(s) replied chargeably, ${messages.filter((m) => m.direction === "inbound").length} inbound message(s)`,
  });
  checks.push({
    label: "a meeting was billed only after a person confirmed it",
    pass: billable.filter((e) => e.kind === "meeting_confirmed").every((e) => /confirmed as a real meeting/i.test(e.evidence)),
    detail: `${billable.filter((e) => e.kind === "meeting_confirmed").length} meeting(s) billed`,
  });
  checks.push({
    label: "every won deal was closed by a payment or a person",
    pass: wonDeals.length > 0 && wonDeals.every((d) => d.closedBy === "payment" || d.closedBy === "operator"),
    detail: wonDeals.map((d) => `${d.closedBy ?? "nobody"}${d.paymentReference ? ` (${d.paymentReference})` : ""}`).join(", ") || "none",
  });
  checks.push({
    label: "every charge carries its evidence",
    pass: billable.length > 0 && billable.every((e) => e.evidence.length > 30),
    detail: `${billable.length} charge(s)`,
  });

  checks.push({
    label: "nothing sent to a suppressed address afterwards",
    // Compared on `createdAt`, which is the real clock on both rows. `sentAt`
    // carries the tick's pinned clock, so comparing the two would be
    // comparing different timelines and would fail whatever the agent did.
    pass: suppressions.every((s) => {
      const suppressedAt = s.createdAt.getTime();
      return !sent.some((m) => m.toEmail === s.email && m.createdAt.getTime() > suppressedAt);
    }),
    detail: `${suppressions.length} suppression(s)`,
  });

  let failures = 0;
  for (const check of checks) {
    if (check.pass) {
      console.log(`  ${colour.green("✓")} ${check.label.padEnd(46)} ${colour.dim(check.detail.slice(0, 70))}`);
    } else {
      failures += 1;
      console.log(`  ${colour.red("✗")} ${check.label.padEnd(46)} ${check.detail.slice(0, 70)}`);
    }
  }

  console.log();
  if (failures === 0) {
    console.log(`  ${colour.green(`All ${checks.length} checks passed.`)}`);
    console.log(colour.dim(`  Read the messages in ./outbox — that is exactly what would have been sent.\n`));
  } else {
    console.log(`  ${colour.red(`${failures} of ${checks.length} checks failed.`)} A gate is not doing its job.\n`);
    process.exitCode = 1;
  }
}
