import { db } from "../infra/db";
import { fromJson } from "../lib/json";
import { warmupFor, pipelineSummary } from "../agent/orchestrator";
import { peek } from "../infra/lock";
import { queueStats } from "../infra/queue";
import { workersAlive } from "../agent/worker";
import { describeRate } from "../core/warmup";
import { formatMoney } from "../core/billing";
import { monthToDate } from "../agent/billing";
import { defaultCompliance } from "../agent/orchestrator";
import { colour, heading, requireDatabase, run } from "./lib";
import type { SenderIdentity } from "../core/types";

/**
 * `npm run health` — is it working, and should anybody intervene?
 *
 * Written for the unattended case. Once the agent is on a timer nobody reads
 * tick logs, so the question that matters is not "what happened" but "is
 * anything wrong and is anything waiting for me". Both answers have to fit on
 * one screen, and the exit code has to be usable from a monitoring check:
 * zero when nothing needs a person, one when something does.
 */

run(async () => {
  await requireDatabase();

  const campaigns = await db.campaign.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { client: true },
  });

  if (campaigns.length === 0) {
    console.log("No campaigns. Run npm run sell -- <url> first.");
    return;
  }

  let needsAttention = 0;

  // --- is anything consuming the queue? -----------------------------------
  //
  // First, because it is the failure that makes every other number on this
  // screen a lie: campaigns running, work scheduled, and nothing to do it.
  const [stats, workers] = await Promise.all([queueStats(), workersAlive()]);
  heading("Workers");
  if (workers.alive > 0) {
    console.log(`  ${colour.green(`${workers.alive} running`)}  ${colour.dim(workers.names.join(", "))}`);
  } else if (stats.queued + stats.running > 0) {
    needsAttention += 1;
    console.log(`  ${colour.red("none running")}, and ${stats.queued + stats.running} job(s) are waiting.`);
    console.log(colour.dim("  Nothing will happen until one is. npm run worker, or npm start for the console and a worker together."));
  } else {
    console.log(colour.dim("  None running, and nothing queued."));
  }
  console.log(colour.dim(`  Queue: ${stats.queued} waiting, ${stats.running} in flight, ${stats.dead} gave up.`));
  if (stats.dead > 0) {
    needsAttention += 1;
    console.log(`  ${colour.yellow(`${stats.dead} job(s) in the dead letter.`)} ${colour.dim("Each campaign is tried again an hour after one dies.")}`);
  }
  if (stats.overdue > 0) {
    needsAttention += 1;
    console.log(`  ${colour.yellow(`${stats.overdue} job(s) overdue by more than a lease.`)}`);
  }

  for (const campaign of campaigns) {
    heading(`${campaign.name}  ${colour.dim(campaign.id)}`);

    const sender = fromJson<SenderIdentity | null>(campaign.senderIdentity, null);
    const configuredCap = sender
      ? { ...defaultCompliance(sender), ...fromJson<{ dailySendCap?: number }>(campaign.complianceConfig, {}) }.dailySendCap
      : 30;

    const [warmup, pipeline, lastRun, escalations, blocked, failed, lock] = await Promise.all([
      warmupFor(campaign.id, configuredCap),
      pipelineSummary(campaign.id),
      db.agentRun.findFirst({ where: { campaignId: campaign.id }, orderBy: { startedAt: "desc" } }),
      db.event.count({ where: { campaignId: campaign.id, kind: "reply.escalated" } }),
      db.message.count({ where: { campaignId: campaign.id, status: "blocked" } }),
      db.message.count({ where: { campaignId: campaign.id, status: "failed" } }),
      // Read-only: a health check must be able to say "a tick is running"
      // without becoming the thing that stops it.
      peek(campaign.id),
    ]);

    // --- is it running? --------------------------------------------------
    const line = (label: string, value: string) => console.log(`  ${label.padEnd(20)} ${value}`);

    if (lock.held) line("right now", colour.green(`a tick is running — ${lock.by}`));
    else if (lock.stale) line("right now", colour.yellow(`a stale lock from ${lock.by}; the next tick will take it over`));

    if (!lastRun) {
      needsAttention += 1;
      line("last tick", colour.yellow("never run"));
    } else {
      const age = Date.now() - lastRun.startedAt.getTime();
      const hours = age / 3_600_000;
      const stale = campaign.status === "running" && hours > STALE_HOURS;
      if (stale || !lastRun.ok) needsAttention += 1;
      line(
        "last tick",
        `${describeAge(age)}${lastRun.ok ? "" : colour.red(" — failed")}${stale ? colour.yellow(" — stale") : ""}`,
      );
      if (!lastRun.ok && lastRun.error) line("", colour.red(lastRun.error.slice(0, 90)));
    }
    line("status", campaign.status === "running" ? colour.green("running") : colour.yellow(campaign.status));
    line("sending", campaign.liveSending ? colour.red("live") : "dry run");

    // --- is it damaging the domain? --------------------------------------
    const tone = warmup.stage === "halted" ? colour.red : warmup.stage === "throttled" ? colour.yellow : colour.dim;
    if (warmup.stage === "halted" || warmup.stage === "throttled") needsAttention += 1;
    line("today's cap", `${warmup.dailyCap} (${warmup.remainingToday} left)  ${tone(warmup.stage)}`);
    line("bounces", describeRate(warmup.bounceRate, warmup.sampled));
    line("complaints", describeRate(warmup.complaintRate, warmup.sampled));
    if (warmup.stage !== "warm") console.log(`  ${colour.dim(warmup.reason)}`);

    // --- is anything waiting for a person? -------------------------------
    if (escalations > 0) needsAttention += 1;
    line("needs a person", escalations > 0 ? colour.yellow(`${escalations}`) : "0");
    line("pipeline", Object.entries(pipeline.byStage).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`).join(", ") || "empty");
    if (blocked > 0) line("blocked messages", colour.dim(`${blocked}`));
    if (failed > 0) {
      needsAttention += 1;
      line("failed sends", colour.red(`${failed}`));
    }

    if (campaign.client) {
      const { invoice } = await monthToDate(campaign.client.id);
      line("billed this month", `${formatMoney(invoice.totalCents, invoice.currency)} to ${campaign.client.name}`);
    }
  }

  heading("Verdict");
  if (needsAttention === 0) {
    console.log(`${colour.green("Nothing needs you.")}\n`);
    return;
  }
  console.log(`${colour.yellow(`${needsAttention} thing(s) need you.`)}`);
  console.log(colour.dim("Escalations are in the console; a halted or throttled campaign needs its list cleaned.\n"));
  // Non-zero so a monitoring check can watch this rather than parsing output.
  process.exitCode = 1;
});

/** Longer than this between ticks on a running campaign is suspicious. */
const STALE_HOURS = Number(process.env.HEALTH_STALE_HOURS ?? 26);

function describeAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
