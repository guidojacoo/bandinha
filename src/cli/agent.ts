import { db } from "../infra/db";
import { tick, pipelineSummary, type TickSummary } from "../agent/orchestrator";
import { withLock } from "../infra/lock";
import { colour, heading, llmForRun, requireDatabase, fatal, run } from "./lib";
import { dnsUsable } from "./lib";

/**
 * `npm run agent -- <campaignId> [--loop] [--once]` — the agent running.
 *
 * A tick is idempotent and resumable, so this command is equally at home as a
 * one-shot, a loop in a terminal, or a cron entry. `--loop` is the autonomous
 * mode: it keeps ticking until there is nothing left to do, then stops rather
 * than spinning — a loop that runs forever with nothing to do looks identical
 * to one that is stuck.
 */

const IDLE_TICKS_BEFORE_STOPPING = 3;

/**
 * How many failures in a row before giving up.
 *
 * A loop that retries forever on a broken campaign looks identical to one
 * that is working, which is the worst property an unattended process can
 * have. Three strikes, with backoff between them, then stop loudly.
 */
const MAX_CONSECUTIVE_FAILURES = Number(process.env.AGENT_MAX_FAILURES ?? 3);

run(async () => {
  await requireDatabase();

  const campaignId = process.argv[2];
  const loop = process.argv.includes("--loop");
  const intervalMs = Number(process.env.AGENT_INTERVAL_MS ?? 20_000);
  const maxTicks = Number(process.env.AGENT_MAX_TICKS ?? 200);

  if (!campaignId) {
    const campaigns = await db.campaign.findMany({ orderBy: { createdAt: "desc" }, take: 10 });
    if (campaigns.length === 0) fatal("No campaigns yet. Run npm run sell -- <url> first.");
    console.log("Pick a campaign:\n");
    for (const campaign of campaigns) {
      console.log(`  ${colour.bold(campaign.id)}  ${campaign.name} ${colour.dim(`(${campaign.status}, from ${campaign.sourceUrl})`)}`);
    }
    console.log(`\nThen: ${colour.bold("npm run agent -- <id> --loop")}\n`);
    return;
  }

  const llm = llmForRun();
  const useDns = await dnsUsable();
  if (!useDns) {
    console.log(colour.dim("No DNS resolver here, so addresses are marked unchecked rather than verified.\n"));
  }

  /**
   * One tick, under a lock.
   *
   * The lock is what makes this safe to put in a cron entry. A schedule that
   * fires every ten minutes against a tick that occasionally takes twelve
   * will overlap, and two overlapping ticks both read "sent today: 4", both
   * decide there is room, and quietly double the daily cap, the per-domain
   * cap and the anti-pester gap. Every one of those is a deliberate
   * protection and they are worth nothing if a second process walks past.
   */
  const runOnce = async (label: string) => {
    const outcome = await withLock(campaignId, label, () =>
      tick({
        campaignId,
        llm,
        useDns,
        onProgress: (message) => console.log(`  ${message}`),
      }));

    if (!outcome.ran) {
      console.log(colour.yellow(`  Another tick is already running: ${outcome.heldBy}, since ${outcome.since.toISOString()}.`));
      console.log(colour.dim("  Skipped rather than queued — overlapping ticks double every send cap."));
      return null;
    }
    return outcome.result;
  };

  if (!loop) {
    heading("One tick");
    const summary = await runOnce("one-shot");
    if (summary) console.log(`\n  ${describe(summary)}`);
    await showPipeline(campaignId);
    return;
  }

  // --- the loop ---------------------------------------------------------
  let idle = 0;
  let consecutiveFailures = 0;

  for (let ticks = 0; ticks < maxTicks; ticks++) {
    heading(`Tick ${ticks + 1} of up to ${maxTicks}`);

    let summary: Awaited<ReturnType<typeof tick>> | null = null;
    try {
      summary = await runOnce(`loop tick ${ticks + 1}`);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(colour.red(`  Tick failed: ${message}`));

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        fatal(`${consecutiveFailures} ticks failed in a row. Stopping rather than looping on a broken campaign — the last error was: ${message}`);
      }

      // Exponential backoff, because the usual cause is something that needs
      // time (a rate limit, a mailbox that is down) and retrying hard makes
      // every one of those worse.
      const backoff = Math.min(15 * 60_000, intervalMs * 2 ** consecutiveFailures);
      console.log(colour.dim(`  Waiting ${Math.round(backoff / 1000)}s before trying again (failure ${consecutiveFailures} of ${MAX_CONSECUTIVE_FAILURES}).`));
      await sleep(backoff);
      continue;
    }

    if (summary) console.log(`\n  ${describe(summary)}`);

    if (summary && didNothing(summary)) {
      idle += 1;
      if (idle >= IDLE_TICKS_BEFORE_STOPPING) {
        console.log(colour.dim(`\n  Nothing to do for ${idle} ticks — stopping rather than spinning.`));
        break;
      }
    } else {
      idle = 0;
    }

    await sleep(intervalMs);
  }

  await showPipeline(campaignId);
});

async function showPipeline(campaignId: string): Promise<void> {
  const pipeline = await pipelineSummary(campaignId);
  heading("Pipeline");
  for (const [stage, count] of Object.entries(pipeline.byStage)) {
    if (count > 0) console.log(`  ${stage.padEnd(16)} ${count}`);
  }
  console.log(`\n  ${colour.bold(`${pipeline.needsHuman}`)} conversation(s) waiting for a person.`);
  if (pipeline.needsHuman > 0) {
    console.log(colour.dim("  Those are commitments, pricing questions and referrals — the agent will not answer them itself."));
  }
  console.log();
}

function describe(summary: TickSummary): string {
  const parts = [
    summary.repliesRead > 0 ? `${summary.repliesRead} reply(ies) read` : "",
    summary.answered > 0 ? `${summary.answered} answered` : "",
    summary.escalated > 0 ? colour.yellow(`${summary.escalated} escalated`) : "",
    summary.suppressed > 0 ? `${summary.suppressed} suppressed` : "",
    summary.discovered > 0 ? `${summary.discovered} discovered` : "",
    summary.qualified > 0 ? colour.green(`${summary.qualified} qualified`) : "",
    summary.rejected > 0 ? colour.dim(`${summary.rejected} rejected`) : "",
    summary.enrolled > 0 ? `${summary.enrolled} enrolled` : "",
    summary.sent > 0 ? colour.green(`${summary.sent} sent`) : "",
    summary.blocked > 0 ? colour.yellow(`${summary.blocked} blocked`) : "",
    summary.failed > 0 ? colour.red(`${summary.failed} failed`) : "",
  ].filter(Boolean);
  const body = parts.length > 0 ? parts.join(", ") : colour.dim("nothing to do");
  const warmup = summary.warmup && summary.warmup.stage !== "warm"
    ? colour.dim(` · ${summary.warmup.stage}: ${summary.warmup.dailyCap}/day`)
    : "";
  return `${body}  ${colour.dim(`· ${summary.llm}`)}${warmup}`;
}

function didNothing(summary: TickSummary): boolean {
  return (
    summary.repliesRead === 0 && summary.discovered === 0 && summary.qualified === 0 &&
    summary.rejected === 0 && summary.enrolled === 0 && summary.sent === 0 && summary.blocked === 0
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
