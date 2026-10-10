import { runWorker, workersAlive } from "../agent/worker";
import { queueStats } from "../infra/queue";
import { colour, dnsUsable, heading, llmForRun, requireDatabase, run } from "./lib";
import { isJobKind, type JobKind } from "../core/queue";

/**
 * `npm run worker` — the process that does the work.
 *
 * This is the one command a finished install actually needs running. It finds
 * every campaign that is supposed to be working, works them, and keeps doing
 * that: replies read, prospects found, messages composed, sends cleared by the
 * compliance gate, the next tick scheduled from the campaign's own cadence
 * rather than a polling constant.
 *
 * Start a second one and the work spreads out. Start a tenth on a tenth
 * machine and it spreads there too, because the right to do a piece of work is
 * a claimed row, not anything held in a process. Stop one with Ctrl-C and it
 * hands its claims back without spending an attempt, so a restart costs
 * nothing.
 *
 *   --concurrency N   how many jobs at once (default 2, or WORKER_CONCURRENCY)
 *   --once            take one job, finish it, stop
 *   --drain           work until the queue is empty, then stop
 *   --kind tick       only ingests, or only ticks
 *   --no-seed         do not queue work for campaigns that have none
 */

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

run(async () => {
  await requireDatabase();

  const concurrency = Number(value("concurrency") ?? process.env.WORKER_CONCURRENCY ?? 2);
  const once = flag("once");
  const drain = flag("drain");
  const requested = value("kind");
  if (requested && !isJobKind(requested)) {
    throw new Error(`--kind must be one of ingest, tick (got ${requested}).`);
  }
  const kinds: JobKind[] | undefined = requested && isJobKind(requested) ? [requested] : undefined;

  const useDns = await dnsUsable();
  const llm = llmForRun();

  heading("Mercurio worker");
  const others = await workersAlive();
  if (others.alive > 0) {
    console.log(`${others.alive} other worker(s) already running: ${others.names.join(", ")}`);
    console.log(colour.dim("The work spreads across all of them; nothing is done twice.\n"));
  }
  console.log(`${llm.available() ? `Model: ${llm.name}` : "No model configured — deterministic copy."}`);
  if (!useDns) console.log(colour.dim("No DNS resolver here, so addresses are marked unchecked rather than verified."));
  console.log(
    `Concurrency ${colour.bold(String(concurrency))}${kinds ? `, ${kinds.join("/")} only` : ""}` +
    `${once ? ", one job then stop" : drain ? ", until the queue is empty" : ""}\n`,
  );

  /**
   * Ctrl-C once asks for a clean stop: no new claims, and the jobs in flight
   * are handed back rather than abandoned. Twice means now.
   */
  const controller = new AbortController();
  let asked = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (asked) {
        console.log(colour.yellow("\nStopping immediately."));
        process.exit(130);
      }
      asked = true;
      console.log(colour.yellow("\nFinishing the jobs in flight, then stopping. Ctrl-C again to stop now."));
      controller.abort();
    });
  }

  const report = await runWorker({
    llm,
    concurrency,
    kinds,
    useDns,
    maxJobs: once ? 1 : undefined,
    exitWhenIdle: once || drain,
    seed: !flag("no-seed"),
    signal: controller.signal,
    onLog: (line) => console.log(`  ${line}`),
  });

  const stats = await queueStats();
  heading("Stopped");
  console.log(`  ${report.done} job(s) done, ${report.failed} failed, ${report.dead} gave up.`);
  if (report.requeued > 0) console.log(`  ${report.requeued} abandoned job(s) recovered from other workers.`);
  console.log(colour.dim(`  Queue now: ${stats.queued} waiting, ${stats.running} running, ${stats.dead} dead.`));
  if (stats.dead > 0) {
    console.log(colour.yellow(`  ${stats.dead} job(s) in the dead letter — see the Queue page in the console.`));
  }
  console.log("");
});
