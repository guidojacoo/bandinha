import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { toJson } from "../lib/json";
import {
  DEFAULT_QUEUE_POLICY, PRIORITY, compareForClaim, decideFailure, dedupeKey,
  isJobKind, isPermanentFailure, leaseUntil, workerName,
  type JobKind, type JobRecord, type JobStatus, type QueuePolicy,
} from "../core/queue";

/**
 * The work queue, on the database.
 *
 * Every decision in here is made by `core/queue.ts`; this file is the part
 * that talks to rows. The one piece of real engineering is the claim, and it
 * is worth reading closely because it is what makes more than one worker safe.
 *
 * There is no `SELECT ... FOR UPDATE SKIP LOCKED`, because SQLite has no such
 * thing and the product has to run on a file before it runs on a cluster.
 * Instead the claim is a compare-and-set: read a few candidates, then update
 * one *conditionally on the exact version that was read* — same id, same
 * status, same attempt count. Two workers racing on the same row both issue
 * that update; the first changes `status` and `attempts`, so the second
 * matches nothing and is told `count: 0`. It moves to the next candidate. No
 * locks, no transactions, no vendor features, and the guarantee holds on
 * SQLite, on Postgres, and across machines, because the arbiter is the row
 * itself rather than anything in a process.
 */

export function policy(): QueuePolicy {
  return {
    ...DEFAULT_QUEUE_POLICY,
    leaseMs: Number(process.env.JOB_LEASE_MS ?? DEFAULT_QUEUE_POLICY.leaseMs),
    maxAttempts: Number(process.env.JOB_MAX_ATTEMPTS ?? DEFAULT_QUEUE_POLICY.maxAttempts),
    busyIntervalMs: Number(process.env.TICK_BUSY_INTERVAL_MS ?? DEFAULT_QUEUE_POLICY.busyIntervalMs),
    idleIntervalMs: Number(process.env.TICK_IDLE_INTERVAL_MS ?? DEFAULT_QUEUE_POLICY.idleIntervalMs),
    maxIntervalMs: Number(process.env.TICK_MAX_INTERVAL_MS ?? DEFAULT_QUEUE_POLICY.maxIntervalMs),
  };
}

/** How many rows a claim looks at before giving up for this round. */
const CLAIM_CANDIDATES = 8;

export function newWorkerName(): string {
  return workerName(hostname(), process.pid, randomUUID().replace(/-/g, ""));
}

export interface Job {
  id: string;
  kind: JobKind;
  campaignId: string | null;
  status: JobStatus;
  priority: number;
  payload: string | null;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  leaseUntil: Date | null;
  claimedBy: string | null;
  lastError: string | null;
  result: string | null;
}

function asJob(row: {
  id: string; kind: string; campaignId: string | null; status: string; priority: number;
  payload: string | null; attempts: number; maxAttempts: number; runAt: Date;
  leaseUntil: Date | null; claimedBy: string | null; lastError: string | null; result: string | null;
}): Job {
  return {
    ...row,
    kind: isJobKind(row.kind) ? row.kind : "tick",
    status: row.status as JobStatus,
  };
}

function record(job: Job): JobRecord {
  return {
    id: job.id, kind: job.kind, status: job.status, priority: job.priority,
    attempts: job.attempts, maxAttempts: job.maxAttempts, runAt: job.runAt,
    leaseUntil: job.leaseUntil,
  };
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  kind: JobKind;
  campaignId?: string | null;
  runAt?: Date;
  priority?: number;
  payload?: unknown;
  maxAttempts?: number;
}

export type EnqueueResult =
  | { created: true; job: Job }
  /** One was already live for this key. Possibly pulled earlier. */
  | { created: false; job: Job; pulledForward: boolean };

/**
 * Put work on the queue, at most once.
 *
 * The caller does not have to know whether a job already exists, which is the
 * point: `createCampaign` enqueues an ingest, the console's "run now" button
 * enqueues a tick, a finishing tick enqueues the next one, and a worker
 * starting up enqueues one for every running campaign. All of those race, all
 * of them are correct, and none of them can produce two live jobs for the
 * same campaign — the unique index on `dedupeKey` decides, not the ordering.
 *
 * When one already exists, an earlier `runAt` wins. That is what makes "run
 * now" work on a campaign whose next tick is scheduled for an hour's time:
 * the request moves the existing row rather than adding a second.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
  const campaignId = input.campaignId ?? null;
  const key = dedupeKey(input.kind, campaignId);
  const runAt = input.runAt ?? new Date();
  const data = {
    kind: input.kind,
    campaignId,
    dedupeKey: key,
    status: "queued" as const,
    priority: input.priority ?? PRIORITY[input.kind],
    payload: input.payload === undefined ? null : toJson(input.payload),
    runAt,
    maxAttempts: input.maxAttempts ?? policy().maxAttempts,
  };

  // Look before leaping. The unique index is the guarantee, but relying on it
  // as the normal control flow means an expected constraint violation — and a
  // scary line in the operator's log — every single time a tick reschedules
  // itself. So the common case is a read, and the index is left to arbitrate
  // the genuine races.
  const found = await db.job.findUnique({ where: { dedupeKey: key } });
  if (found) return pullForward(found, runAt);

  try {
    return { created: true, job: asJob(await db.job.create({ data })) };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Somebody else created it between the read and the write, which is
    // exactly what the index is for. Their row is as good as ours.
    const existing = await db.job.findUnique({ where: { dedupeKey: key } });
    if (!existing) throw error;
    return pullForward(existing, runAt);
  }
}

/**
 * A live job already exists for this key, so the request becomes "sooner,
 * please" rather than a second job. This is what makes the console's "run
 * now" safe to press twice on a campaign whose next tick is an hour out: it
 * moves the one row that exists.
 */
function pullForward(
  row: Parameters<typeof asJob>[0],
  runAt: Date,
): Promise<EnqueueResult> | EnqueueResult {
  if (row.status === "queued" && row.runAt.getTime() > runAt.getTime()) {
    return db.job
      .update({ where: { id: row.id }, data: { runAt } })
      .then((moved) => ({ created: false as const, job: asJob(moved), pulledForward: true }));
  }
  return { created: false, job: asJob(row), pulledForward: false };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/**
 * Take one job, or return null.
 *
 * `force` is the console's "run now": it allows claiming a queued job whose
 * time has not come. It cannot override a live claim, which is the part that
 * matters — pressing the button while a tick is running gets you "already
 * running", never a second tick.
 */
export async function claim(options: {
  worker: string;
  kinds?: JobKind[];
  now?: Date;
  jobId?: string;
  force?: boolean;
}): Promise<Job | null> {
  const now = options.now ?? new Date();
  const p = policy();
  const kinds = options.kinds;

  const candidates = options.jobId
    ? await db.job.findMany({ where: { id: options.jobId } })
    : await db.job.findMany({
        where: {
          ...(kinds ? { kind: { in: kinds } } : {}),
          OR: [
            { status: "queued", ...(options.force ? {} : { runAt: { lte: now } }) },
            // A claim whose holder stopped breathing. Without this, one crash
            // parks a campaign forever, and a campaign that quietly stopped is
            // the failure this design exists to prevent.
            { status: "running", leaseUntil: { lte: now } },
          ],
        },
        orderBy: [{ priority: "desc" }, { runAt: "asc" }],
        take: CLAIM_CANDIDATES,
      });

  const ordered = candidates.map(asJob).sort((a, b) => compareForClaim(record(a), record(b)));

  for (const candidate of ordered) {
    if (candidate.status === "queued") {
      if (!options.force && candidate.runAt.getTime() > now.getTime()) continue;
    } else if (candidate.status === "running") {
      // Never steal a live claim, not even with force.
      if (!candidate.leaseUntil || candidate.leaseUntil.getTime() > now.getTime()) continue;
    } else {
      continue;
    }

    // The compare-and-set. `status` and `attempts` together are the version
    // that was read; if either moved, somebody else got there first.
    const taken = await db.job.updateMany({
      where: { id: candidate.id, status: candidate.status, attempts: candidate.attempts },
      data: {
        status: "running",
        claimedBy: options.worker,
        attempts: candidate.attempts + 1,
        leaseUntil: leaseUntil(now, p),
        startedAt: now,
        // A reclaimed job keeps its key; a terminal one has already dropped it.
        dedupeKey: dedupeKey(candidate.kind, candidate.campaignId),
      },
    });
    if (taken.count !== 1) continue;

    const mine = await db.job.findUnique({ where: { id: candidate.id } });
    if (mine && mine.claimedBy === options.worker) return asJob(mine);
  }

  return null;
}

/** Who holds this job, for the "already running" message. */
export async function heldBy(kind: JobKind, campaignId: string | null): Promise<{ worker: string; since: Date } | null> {
  const row = await db.job.findUnique({ where: { dedupeKey: dedupeKey(kind, campaignId) } });
  if (!row || row.status !== "running" || !row.claimedBy) return null;
  return { worker: row.claimedBy, since: row.startedAt ?? row.updatedAt };
}

// ---------------------------------------------------------------------------
// Holding, finishing, failing
// ---------------------------------------------------------------------------

/**
 * Renew the lease.
 *
 * Returns false when the claim is gone — reaped as expired, or taken by
 * somebody else. A worker that sees false should abandon the work rather than
 * finish it, because somebody else is now doing it, and two processes
 * finishing the same tick is the one outcome the queue exists to prevent.
 */
export async function heartbeat(jobId: string, worker: string, now = new Date()): Promise<boolean> {
  const result = await db.job.updateMany({
    where: { id: jobId, status: "running", claimedBy: worker },
    data: { leaseUntil: leaseUntil(now, policy()) },
  });
  return result.count === 1;
}

/**
 * Done — and schedule the next one in the same breath.
 *
 * One transaction, update before create, for a reason that is easy to miss:
 * the finished row still holds the dedupe key, so the next job can only be
 * created once that key has been released. Doing it in two round trips leaves
 * a window where the campaign has no job at all, and a crash inside that
 * window is a campaign that never ticks again.
 */
export async function complete(options: {
  jobId: string;
  worker: string;
  result?: unknown;
  next?: { kind: JobKind; campaignId: string | null; runAt: Date; priority?: number };
  now?: Date;
}): Promise<boolean> {
  const now = options.now ?? new Date();
  const finish = db.job.updateMany({
    where: { id: options.jobId, status: "running", claimedBy: options.worker },
    data: {
      status: "done",
      finishedAt: now,
      leaseUntil: null,
      dedupeKey: null,
      lastError: null,
      result: options.result === undefined ? undefined : toJson(options.result),
    },
  });

  if (!options.next) {
    const done = await finish;
    return done.count === 1;
  }

  const next = options.next;
  const [finished] = await db.$transaction([
    finish,
    db.job.create({
      data: {
        kind: next.kind,
        campaignId: next.campaignId,
        dedupeKey: dedupeKey(next.kind, next.campaignId),
        status: "queued",
        priority: next.priority ?? PRIORITY[next.kind],
        runAt: next.runAt,
        maxAttempts: policy().maxAttempts,
      },
    }),
  ]);
  return finished.count === 1;
}

export type FailResult =
  | { outcome: "retry"; runAt: Date; attempt: number }
  | { outcome: "dead"; attempt: number }
  | { outcome: "lost" };

/**
 * It threw. Decide whether to try again.
 *
 * A dead job keeps its key cleared like any other terminal row, so the
 * campaign is free to be given new work — a dead tick must not wedge a
 * campaign shut. It is loud instead: the console lists dead jobs, and that is
 * the one queue state that wants a person to look at it.
 */
export async function fail(options: {
  jobId: string;
  worker: string;
  error: string;
  now?: Date;
  jitter?: number;
}): Promise<FailResult> {
  const now = options.now ?? new Date();
  const row = await db.job.findUnique({ where: { id: options.jobId } });
  if (!row || row.claimedBy !== options.worker || row.status !== "running") return { outcome: "lost" };

  const job = asJob(row);
  const permanent = isPermanentFailure(options.error);
  const decision = permanent
    ? ({ action: "dead", attempt: job.attempts } as const)
    : decideFailure(record(job), now, policy(), options.jitter ?? Math.random());

  const message = options.error.slice(0, 2_000);

  if (decision.action === "dead") {
    const dead = await db.job.updateMany({
      where: { id: job.id, status: "running", claimedBy: options.worker },
      data: {
        status: "dead", finishedAt: now, leaseUntil: null, dedupeKey: null,
        lastError: permanent ? `${message} (not retried: permanent)` : message,
      },
    });
    return dead.count === 1 ? { outcome: "dead", attempt: decision.attempt } : { outcome: "lost" };
  }

  const requeued = await db.job.updateMany({
    where: { id: job.id, status: "running", claimedBy: options.worker },
    data: {
      status: "queued", claimedBy: null, leaseUntil: null, startedAt: null,
      runAt: decision.runAt, lastError: message,
    },
  });
  return requeued.count === 1
    ? { outcome: "retry", runAt: decision.runAt, attempt: decision.attempt }
    : { outcome: "lost" };
}

/**
 * Hand back a claim without consuming an attempt.
 *
 * For a worker shutting down cleanly, which is a different thing from a job
 * failing: the work was never tried. Charging it an attempt would mean a
 * rolling deploy could walk a healthy job all the way to dead.
 */
export async function release(jobId: string, worker: string, runAt = new Date()): Promise<boolean> {
  const row = await db.job.findUnique({ where: { id: jobId } });
  if (!row || row.claimedBy !== worker || row.status !== "running") return false;
  const result = await db.job.updateMany({
    where: { id: jobId, status: "running", claimedBy: worker },
    data: {
      status: "queued", claimedBy: null, leaseUntil: null, startedAt: null,
      runAt, attempts: Math.max(0, row.attempts - 1),
    },
  });
  return result.count === 1;
}

/**
 * Expired claims, put back or put down.
 *
 * Any worker may reap, and several reaping at once is harmless: each requeue
 * is the same compare-and-set as a claim, so only one of them lands. The
 * alternative — a dedicated reaper process — is one more thing to keep alive,
 * and the thing it would be protecting is the case where processes die.
 */
export async function reap(now = new Date(), jitter?: number): Promise<{ requeued: number; dead: number }> {
  const expired = await db.job.findMany({
    where: { status: "running", leaseUntil: { lte: now } },
    take: 50,
  });

  let requeued = 0;
  let dead = 0;
  for (const row of expired) {
    const job = asJob(row);
    const decision = decideFailure(record(job), now, policy(), jitter ?? Math.random());
    const reason = `Lease expired — ${row.claimedBy ?? "a worker"} stopped reporting.`;
    if (decision.action === "dead") {
      const result = await db.job.updateMany({
        where: { id: job.id, status: "running", attempts: job.attempts },
        data: { status: "dead", finishedAt: now, leaseUntil: null, dedupeKey: null, lastError: reason },
      });
      dead += result.count;
    } else {
      const result = await db.job.updateMany({
        where: { id: job.id, status: "running", attempts: job.attempts },
        data: {
          status: "queued", claimedBy: null, leaseUntil: null, startedAt: null,
          runAt: decision.runAt, lastError: reason,
        },
      });
      requeued += result.count;
    }
  }
  return { requeued, dead };
}

/** Put a dead job back, by hand, from the console. */
export async function revive(jobId: string, now = new Date()): Promise<boolean> {
  const row = await db.job.findUnique({ where: { id: jobId } });
  if (!row || row.status !== "dead") return false;
  const kind = isJobKind(row.kind) ? row.kind : "tick";
  const key = dedupeKey(kind, row.campaignId);
  // Something live may have taken the key while this was dead, in which case
  // there is already a job doing this work and reviving would duplicate it.
  const live = await db.job.findUnique({ where: { dedupeKey: key } });
  if (live && live.id !== row.id) return false;
  const result = await db.job.updateMany({
    where: { id: jobId, status: "dead" },
    data: {
      status: "queued", attempts: 0, runAt: now, dedupeKey: key,
      claimedBy: null, leaseUntil: null, startedAt: null, finishedAt: null,
    },
  });
  return result.count === 1;
}

// ---------------------------------------------------------------------------
// Looking at it
// ---------------------------------------------------------------------------

export async function queueStats(now = new Date()): Promise<{
  queued: number; running: number; dead: number; due: number; overdue: number; nextRunAt: Date | null;
}> {
  const [queued, running, dead, due, next] = await Promise.all([
    db.job.count({ where: { status: "queued" } }),
    db.job.count({ where: { status: "running" } }),
    db.job.count({ where: { status: "dead" } }),
    db.job.count({ where: { status: "queued", runAt: { lte: now } } }),
    db.job.findFirst({ where: { status: "queued" }, orderBy: { runAt: "asc" }, select: { runAt: true } }),
  ]);
  return {
    queued, running, dead, due,
    // Work that was due more than a lease ago and still is: the signal that
    // nothing is consuming the queue. One number that answers "is a worker
    // actually running?" without trusting a worker to say so.
    overdue: await db.job.count({
      where: { status: "queued", runAt: { lte: new Date(now.getTime() - policy().leaseMs) } },
    }),
    nextRunAt: next?.runAt ?? null,
  };
}

export async function recentJobs(limit = 25) {
  return db.job.findMany({
    orderBy: [{ updatedAt: "desc" }],
    take: limit,
    include: { campaign: { select: { id: true, name: true, userId: true } } },
  });
}

// ---------------------------------------------------------------------------
// Workers announcing themselves
// ---------------------------------------------------------------------------

export async function registerWorker(name: string, concurrency: number): Promise<void> {
  await db.workerInstance.upsert({
    where: { id: name },
    create: { id: name, host: hostname(), concurrency },
    update: { lastSeenAt: new Date(), concurrency, stoppedAt: null },
  });
}

export async function workerSeen(name: string, counters: { claimed?: number; done?: number; failed?: number } = {}): Promise<void> {
  await db.workerInstance.updateMany({
    where: { id: name },
    data: {
      lastSeenAt: new Date(),
      ...(counters.claimed ? { claimed: { increment: counters.claimed } } : {}),
      ...(counters.done ? { done: { increment: counters.done } } : {}),
      ...(counters.failed ? { failed: { increment: counters.failed } } : {}),
    },
  });
}

export async function workerStopped(name: string): Promise<void> {
  await db.workerInstance.updateMany({ where: { id: name }, data: { stoppedAt: new Date(), lastSeenAt: new Date() } });
}

/**
 * Workers believed to be alive.
 *
 * "Believed" is doing real work in that sentence. A worker that was killed
 * with -9 never gets to set `stoppedAt`, so liveness is inferred from a
 * heartbeat younger than two lease periods — long enough to survive a slow
 * tick, short enough that a dead worker stops being listed as alive.
 */
export async function liveWorkers(now = new Date()) {
  const cutoff = new Date(now.getTime() - 2 * policy().leaseMs);
  return db.workerInstance.findMany({
    where: { stoppedAt: null, lastSeenAt: { gte: cutoff } },
    orderBy: { lastSeenAt: "desc" },
    take: 50,
  });
}

/** Finished rows are history, and history has a size. */
export async function pruneFinished(olderThan: Date): Promise<number> {
  const result = await db.job.deleteMany({
    where: { status: { in: ["done"] }, finishedAt: { lt: olderThan } },
  });
  return result.count;
}
