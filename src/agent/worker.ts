import { db, logEvent } from "../infra/db";
import {
  claim, complete, enqueue, fail, heartbeat, heldBy, liveWorkers, newWorkerName,
  policy, pruneFinished, reap, registerWorker, release, workerSeen, workerStopped,
  type Job,
} from "../infra/queue";
import { didWork, nextRunAt, type JobKind } from "../core/queue";
import { fromJson } from "../lib/json";
import { ingest } from "./ingest";
import { tick } from "./orchestrator";
import type { Llm } from "../infra/llm/types";
import type { Icp, Offering } from "../core/types";

/**
 * The worker: the thing that actually runs the agent.
 *
 * Everything before this was a command somebody typed. A worker is what makes
 * the product a product — it comes up, finds every campaign that is supposed
 * to be running, works them, and keeps doing that through reboots, failures
 * and however many campaigns get added. Start a second one and the work
 * spreads; start a tenth on a tenth machine and it spreads there too, because
 * the right to do a piece of work is a claimed row rather than anything
 * living in a process.
 *
 * What a worker is *not* allowed to do is assume it is alone. Every
 * assumption of that kind here is written down and defended:
 *
 *   - It never acts on a job it has not claimed.
 *   - It renews the claim while it works, and if a renewal fails — because it
 *     was reaped as stale, or taken — it stops instead of finishing, because
 *     somebody else is doing that work now.
 *   - It hands claims back on a clean shutdown without spending an attempt,
 *     so a rolling restart cannot walk a healthy job to the dead letter.
 *   - It reaps other workers' expired claims, because the case that needs
 *     recovering is precisely the case where a process died.
 */

export interface WorkerContext {
  llm: Llm;
  useDns: boolean;
  now: () => Date;
  say: (line: string) => void;
}

export interface WorkerOptions {
  llm: Llm;
  name?: string;
  concurrency?: number;
  kinds?: JobKind[];
  useDns?: boolean;
  /** Stop after this many jobs. `--once` is this set to one. */
  maxJobs?: number;
  /** Stop when there is nothing left to do, rather than waiting for more. */
  exitWhenIdle?: boolean;
  pollMs?: number;
  seed?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
  onLog?: (line: string) => void;
  /**
   * What to do with a claimed job. Defaults to the real handlers.
   *
   * A seam for the tests, and a deliberate one: the property that matters
   * most about this loop — that N workers racing produce exactly one run of
   * each job — has nothing to do with crawling, composing or sending, and
   * proving it should not require a web server, a model and an inbox.
   */
  handler?: (job: Job, ctx: WorkerContext) => Promise<JobOutcome>;
}

export interface WorkerReport {
  worker: string;
  done: number;
  failed: number;
  dead: number;
  requeued: number;
  claimed: number;
  idleRounds: number;
}

const DEFAULT_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 2);
const DEFAULT_POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2_000);
const REAP_INTERVAL_MS = Number(process.env.WORKER_REAP_INTERVAL_MS ?? 60_000);
const SEED_INTERVAL_MS = Number(process.env.WORKER_SEED_INTERVAL_MS ?? 5 * 60_000);
const PRUNE_INTERVAL_MS = Number(process.env.WORKER_PRUNE_INTERVAL_MS ?? 60 * 60_000);
const JOB_RETENTION_DAYS = Number(process.env.JOB_RETENTION_DAYS ?? 7);

/**
 * How long after a campaign's tick has been dead before trying it again.
 *
 * A dead letter exists so that a broken job stops burning attempts and starts
 * being visible. But a campaign that stays stopped until somebody notices is
 * the silent failure this whole design is against, and most dead ticks are
 * something that passes: a site that was down, a provider having an outage, a
 * release with a bug in it. So the dead letter is loud *and* temporary: the
 * console shows it, and an hour later the campaign is tried again.
 */
const DEAD_COOLOFF_MS = Number(process.env.JOB_DEAD_COOLOFF_MS ?? 60 * 60_000);

/** Renew a claim three times per lease, so two missed renewals are survivable. */
function heartbeatMs(): number {
  return Math.max(5_000, Math.floor(policy().leaseMs / 3));
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SeedReport {
  ticks: number;
  ingests: number;
  skippedDead: number;
}

/**
 * Make sure every campaign that is supposed to be working has work queued.
 *
 * This is the function that makes the system self-starting. A campaign
 * created while no worker was running, a queue emptied by a database restore,
 * a job that died an hour ago — all of them are repaired by running this,
 * and it is safe to run from every worker at once because `enqueue` cannot
 * produce a second live job for a campaign.
 */
export async function seedQueue(now = new Date()): Promise<SeedReport> {
  const report: SeedReport = { ticks: 0, ingests: 0, skippedDead: 0 };

  const campaigns = await db.campaign.findMany({
    where: { status: { in: ["running", "ingesting"] } },
    select: { id: true, status: true, offering: true, icp: true },
  });

  for (const campaign of campaigns) {
    const kind: JobKind =
      campaign.status === "ingesting" || !campaign.offering || !campaign.icp ? "ingest" : "tick";

    // A job that died recently is deliberately left alone: the console is
    // showing it, and retrying it every five minutes would bury the signal.
    const lastDead = await db.job.findFirst({
      where: { campaignId: campaign.id, kind, status: "dead" },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    });
    if (lastDead?.finishedAt && now.getTime() - lastDead.finishedAt.getTime() < DEAD_COOLOFF_MS) {
      report.skippedDead += 1;
      continue;
    }

    const result = await enqueue({ kind, campaignId: campaign.id, runAt: now });
    if (result.created) {
      if (kind === "ingest") report.ingests += 1;
      else report.ticks += 1;
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

export interface JobOutcome {
  /** Lines worth showing. */
  log: string[];
  /** What the console shows as this job's result. */
  result: unknown;
  /** When this campaign should be looked at again, if ever. */
  next?: Date;
}

/**
 * One URL becoming a sellable position.
 *
 * Slow — a dozen pages, politely, with a model call at the end — and the one
 * job a person is sitting watching, which is why it has its own kind and the
 * priority that goes with it. It used to run inside the form submission,
 * where a thirty-second crawl was a thirty-second POST and any hosting
 * platform's request timeout was a broken campaign.
 */
export async function handleIngest(job: Job, ctx: WorkerContext): Promise<JobOutcome> {
  const campaignId = job.campaignId;
  if (!campaignId) throw new Error("Ingest job with no campaign: missing payload.");

  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error(`No campaign ${campaignId}.`);

  // Already done. A retry after a crash between the write and the complete
  // must not crawl the site a second time.
  if (campaign.offering && campaign.icp) {
    if (campaign.status === "ingesting") {
      await db.campaign.update({ where: { id: campaignId }, data: { status: "running" } });
    }
    return { log: ["Already ingested."], result: { alreadyIngested: true }, next: ctx.now() };
  }

  const log: string[] = [];
  const result = await ingest(campaign.sourceUrl, ctx.llm, {
    maxPages: Number(process.env.INGEST_MAX_PAGES ?? 12),
    onProgress: (line) => {
      log.push(line);
      ctx.say(line);
    },
  });

  if ("error" in result) {
    // Thrown rather than recorded, so the queue's backoff applies: a site
    // that was down for a minute is the common case, and the campaign is only
    // marked failed once the job has run out of attempts.
    throw new Error(result.error);
  }

  await db.campaign.update({
    where: { id: campaignId },
    data: {
      name: result.offering.companyName || campaign.name,
      offering: JSON.stringify(result.offering),
      icp: JSON.stringify(result.icp),
      status: "running",
      error: null,
    },
  });

  await logEvent(campaignId, "campaign.ingested", `Read ${result.crawl.pages.length} page(s) of ${campaign.sourceUrl}.`, {
    level: "success",
    data: { via: result.via, notes: result.notes },
  });

  return {
    log,
    result: {
      pages: result.crawl.pages.length,
      via: result.via,
      offering: result.offering.oneLiner,
      buyers: result.icp.buyerTitles,
    },
    // Straight into the first tick. The campaign is not sending anything yet
    // — live sending is armed separately — but discovery and qualification
    // can start immediately, which is what makes the console fill up while
    // the operator is still reading the ICP.
    next: ctx.now(),
  };
}

/**
 * The agent working: replies, discovery, qualification, enrolment, sends.
 *
 * The unit of parallelism is this job, which is to say the campaign. Inside a
 * tick the order is a correctness property — replies are read before anything
 * is sent, so nobody who asked to be left alone thirty seconds ago gets
 * mailed — so a tick is never split across workers to make it faster.
 */
export async function handleTick(job: Job, ctx: WorkerContext): Promise<JobOutcome> {
  const campaignId = job.campaignId;
  if (!campaignId) throw new Error("Tick job with no campaign: missing payload.");

  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error(`No campaign ${campaignId}.`);

  const p = policy();

  if (campaign.status === "paused" || campaign.status === "failed") {
    // Nothing to do and nothing to wait for. Unpausing goes through the
    // console, which pulls this job forward, so a long sleep here costs
    // nothing in responsiveness.
    return {
      log: [`Campaign is ${campaign.status}.`],
      result: { skipped: campaign.status },
      next: new Date(ctx.now().getTime() + p.maxIntervalMs),
    };
  }

  if (campaign.status === "ingesting" || !campaign.offering || !campaign.icp) {
    await enqueue({ kind: "ingest", campaignId, runAt: ctx.now() });
    return { log: ["Still ingesting; queued the ingest."], result: { skipped: "ingesting" }, next: undefined };
  }

  const log: string[] = [];
  const summary = await tick({
    campaignId,
    llm: ctx.llm,
    useDns: ctx.useDns,
    onProgress: (line) => {
      log.push(line);
      ctx.say(line);
    },
  });

  const nextDueAt = await earliestDue(campaignId);
  const next = nextRunAt({ didWork: didWork(summary), nextDueAt, now: ctx.now(), policy: p });

  return {
    log,
    result: {
      sent: summary.sent, blocked: summary.blocked, failed: summary.failed,
      discovered: summary.discovered, qualified: summary.qualified,
      rejected: summary.rejected, enrolled: summary.enrolled,
      repliesRead: summary.repliesRead, answered: summary.answered,
      escalated: summary.escalated, suppressed: summary.suppressed,
      llm: summary.llm,
    },
    next,
  };
}

/**
 * When does this campaign next have something to do?
 *
 * The sequence reducer already knows, which is a far better answer than a
 * polling constant: most ticks on a healthy pipeline have nothing to do,
 * because the next touch is forty-eight hours away by design.
 */
export async function earliestDue(campaignId: string): Promise<Date | null> {
  const next = await db.enrollment.findFirst({
    where: { campaignId, state: { in: ["pending", "active"] }, nextDueAt: { not: null } },
    orderBy: { nextDueAt: "asc" },
    select: { nextDueAt: true },
  });
  return next?.nextDueAt ?? null;
}

export async function runJob(job: Job, ctx: WorkerContext): Promise<JobOutcome> {
  switch (job.kind) {
    case "ingest": return handleIngest(job, ctx);
    case "tick": return handleTick(job, ctx);
    default: throw new Error(`Unknown job kind: ${String(job.kind)}`);
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runWorker(options: WorkerOptions): Promise<WorkerReport> {
  const name = options.name ?? newWorkerName();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? (() => new Date());
  const say = options.onLog ?? (() => {});
  const ctx: WorkerContext = { llm: options.llm, useDns: options.useDns ?? false, now, say };

  const report: WorkerReport = {
    worker: name, done: 0, failed: 0, dead: 0, requeued: 0, claimed: 0, idleRounds: 0,
  };

  let stopping = false;
  const stop = () => { stopping = true; };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stopping = true;

  await registerWorker(name, concurrency);
  if (options.seed !== false) {
    const seeded = await seedQueue(now());
    if (seeded.ticks + seeded.ingests > 0) {
      say(`Queued ${seeded.ticks} tick(s) and ${seeded.ingests} ingest(s) for campaigns that had none.`);
    }
    if (seeded.skippedDead > 0) {
      say(`${seeded.skippedDead} campaign(s) have a job in the dead letter and are being left alone for now.`);
    }
  }

  /** Jobs this worker currently holds, so shutdown can hand them back. */
  const inFlight = new Map<string, Job>();
  let budget = options.maxJobs ?? Infinity;

  const housekeeping = (async () => {
    let lastReap = 0;
    let lastSeed = now().getTime();
    let lastPrune = 0;
    while (!stopping) {
      const t = now().getTime();
      if (t - lastReap >= REAP_INTERVAL_MS) {
        lastReap = t;
        const reaped = await reap(now()).catch(() => ({ requeued: 0, dead: 0 }));
        report.requeued += reaped.requeued;
        report.dead += reaped.dead;
        if (reaped.requeued + reaped.dead > 0) {
          say(`Recovered ${reaped.requeued} abandoned job(s); ${reaped.dead} gave up.`);
        }
      }
      if (options.seed !== false && t - lastSeed >= SEED_INTERVAL_MS) {
        lastSeed = t;
        await seedQueue(now()).catch(() => undefined);
      }
      if (t - lastPrune >= PRUNE_INTERVAL_MS) {
        lastPrune = t;
        await pruneFinished(new Date(t - JOB_RETENTION_DAYS * 86_400_000)).catch(() => 0);
      }
      await workerSeen(name).catch(() => undefined);
      await sleep(Math.min(5_000, pollMs), options.signal);
    }
  })();

  const slot = async (index: number): Promise<void> => {
    while (!stopping && budget > 0) {
      const job = await claim({ worker: name, kinds: options.kinds, now: now() }).catch((error) => {
        say(`Could not reach the queue: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });

      if (!job) {
        report.idleRounds += 1;
        if (options.exitWhenIdle) return;
        // Spread the pollers out so N workers do not all wake together.
        await sleep(pollMs + Math.floor(Math.random() * pollMs), options.signal);
        continue;
      }

      budget -= 1;
      report.claimed += 1;
      inFlight.set(job.id, job);
      await workerSeen(name, { claimed: 1 }).catch(() => undefined);
      say(`[${index}] ${job.kind}${job.campaignId ? ` ${job.campaignId}` : ""} (attempt ${job.attempts})`);

      // Renew the claim while the work runs. If a renewal fails the claim is
      // gone — reaped or taken — and finishing anyway is the one thing that
      // could double-send.
      let lost = false;
      const beat = setInterval(() => {
        void heartbeat(job.id, name, now()).then((held) => {
          if (!held) {
            lost = true;
            say(`[${index}] lost the claim on ${job.id}; another worker has it.`);
          }
        }).catch(() => undefined);
      }, heartbeatMs());

      try {
        const outcome = await (options.handler ?? runJob)(job, ctx);
        clearInterval(beat);
        if (lost) {
          inFlight.delete(job.id);
          report.failed += 1;
          continue;
        }
        const ok = await complete({
          jobId: job.id,
          worker: name,
          result: outcome.result,
          now: now(),
          next: outcome.next && job.campaignId
            ? { kind: job.kind === "ingest" ? "tick" : job.kind, campaignId: job.campaignId, runAt: outcome.next }
            : undefined,
        });
        report.done += ok ? 1 : 0;
        await workerSeen(name, { done: 1 }).catch(() => undefined);
      } catch (error) {
        clearInterval(beat);
        const message = error instanceof Error ? error.message : String(error);
        const outcome = await fail({ jobId: job.id, worker: name, error: message, now: now() });
        report.failed += 1;
        if (outcome.outcome === "dead") {
          report.dead += 1;
          say(`[${index}] ${job.kind} gave up after ${outcome.attempt} attempt(s): ${message}`);
          await onDead(job, message);
        } else if (outcome.outcome === "retry") {
          say(`[${index}] ${job.kind} failed, retrying at ${outcome.runAt.toISOString()}: ${message}`);
        }
        await workerSeen(name, { failed: 1 }).catch(() => undefined);
      } finally {
        inFlight.delete(job.id);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, (_, i) => slot(i + 1)));
  } finally {
    stopping = true;
    await housekeeping.catch(() => undefined);
    // Hand back anything still held without spending an attempt: a rolling
    // restart must not walk a healthy job towards the dead letter.
    for (const job of inFlight.values()) {
      await release(job.id, name, now()).catch(() => undefined);
    }
    await workerStopped(name).catch(() => undefined);
  }

  return report;
}

/**
 * A job has run out of attempts.
 *
 * Recorded against the campaign, because the queue page is not where somebody
 * looks when a campaign stops producing. An ingest that dies leaves the
 * campaign unusable, and saying so on the campaign is the difference between
 * a visible failure and a spinner that never resolves.
 */
async function onDead(job: Job, message: string): Promise<void> {
  if (!job.campaignId) return;
  await logEvent(job.campaignId, `${job.kind}.dead`, `Gave up after ${job.attempts} attempt(s): ${message}`, {
    level: "error",
    data: { jobId: job.id, kind: job.kind },
  }).catch(() => undefined);

  if (job.kind === "ingest") {
    await db.campaign
      .update({ where: { id: job.campaignId }, data: { status: "failed", error: message } })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Is anything running?
// ---------------------------------------------------------------------------

/**
 * Whether any worker is believed to be consuming the queue.
 *
 * The console asks this, because the single most confusing state the product
 * can be in is a queue full of due work and nothing to run it: every page
 * looks healthy, the campaign simply never does anything. Better to say so.
 */
export async function workersAlive(now = new Date()): Promise<{ alive: number; names: string[] }> {
  const workers = await liveWorkers(now);
  return { alive: workers.length, names: workers.map((w) => w.id) };
}

/** Typed read of what a finished tick job recorded, for the console. */
export function jobResult(raw: string | null): Record<string, unknown> {
  return fromJson<Record<string, unknown>>(raw, {});
}

export type { Offering, Icp };

// ---------------------------------------------------------------------------
// Running one thing by hand
// ---------------------------------------------------------------------------

export type HolderOutcome<T> =
  | { ran: true; value: T }
  | { ran: false; heldBy: string; since: Date };

/**
 * Do something as the holder of a campaign's job.
 *
 * What `npm run agent` runs under, and the reason a hand-run tick and a
 * worker cannot collide. The campaign's job row is the single thing that
 * grants the right to tick it, so an operator typing a command and a worker
 * on another machine are competing for the same row and exactly one of them
 * wins — which a file lock could never arrange, because the other process was
 * never on the same filesystem.
 *
 * It claims with `force`, because an operator asking for a tick now means
 * now, even if the next one was scheduled for an hour's time. What force
 * cannot do is take a live claim: pressing the button while a tick is running
 * gets "already running", never a second tick.
 */
export async function asJobHolder<T>(options: {
  kind: JobKind;
  campaignId: string;
  worker?: string;
  now?: () => Date;
  run: (job: Job) => Promise<{ value: T; result?: unknown; next?: Date }>;
}): Promise<HolderOutcome<T>> {
  const now = options.now ?? (() => new Date());
  const name = options.worker ?? newWorkerName();

  const { job } = await enqueue({ kind: options.kind, campaignId: options.campaignId, runAt: now() });
  const mine = await claim({ worker: name, jobId: job.id, force: true, now: now() });
  if (!mine) {
    const held = await heldBy(options.kind, options.campaignId);
    return {
      ran: false,
      heldBy: held?.worker ?? "another process",
      since: held?.since ?? now(),
    };
  }

  const beat = setInterval(() => {
    void heartbeat(mine.id, name, now()).catch(() => undefined);
  }, heartbeatMs());

  try {
    const outcome = await options.run(mine);
    clearInterval(beat);
    await complete({
      jobId: mine.id,
      worker: name,
      result: outcome.result,
      now: now(),
      next: outcome.next
        ? { kind: options.kind === "ingest" ? "tick" : options.kind, campaignId: options.campaignId, runAt: outcome.next }
        : undefined,
    });
    return { ran: true, value: outcome.value };
  } catch (error) {
    clearInterval(beat);
    const message = error instanceof Error ? error.message : String(error);
    await fail({ jobId: mine.id, worker: name, error: message, now: now() }).catch(() => undefined);
    throw error;
  }
}
