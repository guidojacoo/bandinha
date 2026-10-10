/**
 * `npm run agent -- [--campaign <id>] [--loop]`
 *
 * Runs the orchestrator against existing campaigns. This is what you leave
 * running: `sell` creates the campaign and gets it moving, `agent` keeps it
 * moving — polling for replies, sending what is due, and topping the funnel
 * back up as leads drop out.
 */
import "../lib/loadEnv";
import { prisma } from "../infra/db";
import { tick, type TickSummary } from "../agent/orchestrator";
import { transportStatus } from "../infra/transport";
import { bullet, c, fail, heading, parseArgs } from "./ui";

async function runOnce(campaignId: string, label: string): Promise<TickSummary> {
  const summary = await tick(campaignId);
  const parts = [
    summary.discovered && `${summary.discovered} found`,
    summary.qualified && `${summary.qualified} qualified`,
    summary.rejected && `${summary.rejected} rejected`,
    summary.enrolled && `${summary.enrolled} enrolled`,
    summary.sent && c.green(`${summary.sent} sent`),
    summary.blocked && c.yellow(`${summary.blocked} blocked`),
    summary.repliesHandled && c.cyan(`${summary.repliesHandled} replies`),
    summary.stopsHonoured && c.red(`${summary.stopsHonoured} opt-outs`),
  ].filter(Boolean);

  console.log(
    `  ${c.dim(new Date().toISOString().slice(11, 19))} ${label.padEnd(22)} ${parts.join("  ") || c.dim("idle")}`,
  );
  for (const note of summary.notes) console.log(`            ${c.dim(note)}`);
  return summary;
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(`
${c.bold("rainmaker agent")} — keep campaigns moving

  npm run agent -- [options]

  --campaign <id>     Only run this campaign (default: every running campaign)
  --loop              Keep running instead of ticking once
  --interval <secs>   Seconds between passes when looping (default 60)
`);
    process.exit(0);
  }

  const only = typeof flags.campaign === "string" ? flags.campaign : undefined;
  const intervalMs = (typeof flags.interval === "string" ? Number(flags.interval) : 60) * 1000;
  const loop = Boolean(flags.loop);

  heading("Rainmaker agent");
  bullet(transportStatus());
  if (loop) bullet(`Looping every ${intervalMs / 1000}s. Ctrl-C to stop.`);

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log(`\n  ${c.dim("stopping after the current pass…")}`);
  });

  do {
    const campaigns = await prisma.campaign.findMany({
      where: only ? { id: only } : { status: { in: ["running", "ingesting"] } },
      select: { id: true, name: true },
      orderBy: { createdAt: "asc" },
    });

    if (campaigns.length === 0) {
      bullet(only ? `No campaign ${only}.` : "No running campaigns.");
      break;
    }

    for (const campaign of campaigns) {
      if (stopping) break;
      try {
        await runOnce(campaign.id, campaign.name);
      } catch (err) {
        fail(`${campaign.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (loop && !stopping) await new Promise((r) => setTimeout(r, intervalMs));
  } while (loop && !stopping);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  fail(err instanceof Error ? err.message : String(err));
  await prisma.$disconnect();
  process.exit(1);
});
