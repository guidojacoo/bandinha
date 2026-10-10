import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";
import { db, logEvent } from "../infra/db";
import { ingest } from "../agent/ingest";
import { pipelineSummary, tick } from "../agent/orchestrator";
import { toJson } from "../lib/json";
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

  const campaign = await db.campaign.create({
    data: {
      userId: user.id,
      sourceUrl: `http://northwind.test:${PORT}/`,
      name: "Northwind (demo)",
      status: "running",
      offering: toJson(offering),
      icp: toJson({ ...icp, preferredSources: ["seed"], sourceHints: { seed: [] } }),
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

  // --- 5. what actually happened ------------------------------------------
  await report(campaign.id, rounds);
});

/**
 * The next weekday at 10:00 UTC, which is inside the default send window.
 *
 * Today when today is a weekday, so the demo stays close to real time.
 */
function businessHour(): Date {
  const date = new Date();
  date.setUTCHours(10, 0, 0, 0);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) {
    date.setUTCDate(date.getUTCDate() + 1);
  }
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
    db.message.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } }),
    db.event.findMany({ where: { campaignId, kind: "reply.escalated" } }),
    db.suppression.findMany({}),
    pipelineSummary(campaignId),
  ]);

  heading("5. Leads");
  for (const lead of leads) {
    const verdict = lead.status === "enrolled"
      ? colour.green("enrolled")
      : lead.status === "rejected" ? colour.dim("rejected") : lead.status;
    console.log(`  ${lead.domain.padEnd(22)} ${String(lead.fitScore ?? "–").padStart(3)}  ${verdict}`);
    if (lead.rejectedReason) console.log(colour.dim(`    ${lead.rejectedReason}`));
  }

  heading("6. What it wrote");
  const sent = messages.filter((m) => m.direction === "outbound" && m.status === "sent");
  const first = sent.find((m) => m.stepIndex === 0);
  if (first) {
    console.log(colour.dim(`  To: ${first.toEmail}   Subject: ${first.subject}   (${first.composedVia})`));
    console.log();
    for (const line of first.body.split("\n")) console.log(`  ${colour.cyan("│")} ${line}`);
  }

  heading("7. Totals");
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

  heading("8. Did the gates actually fire?");
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
  checks.push({
    label: "commitment and pricing escalated, not closed",
    pass: escalations.length > 0 && pipeline.won === 0,
    detail: `${escalations.length} escalation(s), ${pipeline.won} deal(s) marked won by the agent`,
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
