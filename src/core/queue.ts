/**
 * The work queue's policy, as pure functions.
 *
 * The agent stopped being a script the moment it had to run unattended for
 * more than one campaign. A loop in a terminal does not survive a reboot, a
 * cron entry per campaign does not survive a second campaign, and a file lock
 * does not survive a second machine. What survives all three is a queue in
 * the database: work is a row, a worker claims a row, and the claim is the
 * only thing that grants the right to act.
 *
 * Everything that *decides* lives here, with no database and no clock of its
 * own, because queue bugs are the worst kind to debug in production. The two
 * that cost real money are a job that runs twice and a job that silently
 * never runs again, and both are decisions — "may this be claimed?", "is this
 * dead or should it retry?" — rather than queries. So they are decided by
 * total functions over a record, and tested exhaustively.
 *
 * The unit of parallelism is the campaign, not the phase. Inside one campaign
 * the order is a correctness property — replies are read before anything is
 * sent, so that nobody who asked to be left alone thirty seconds ago gets
 * mailed — and splitting a tick across workers to make it faster would trade
 * that away for a speed-up nobody asked for. Across campaigns there is
 * nothing to order, so that is where the work spreads out.
 */

/**
 * `queued`  waiting for its time, claimable by anybody.
 * `running` claimed, with a lease that has to be renewed.
 * `done`    finished. Terminal, and keeps its result for the console.
 * `dead`    failed more times than it is allowed to. Terminal, and loud:
 *           the console shows dead jobs because a dead job is the one state
 *           that needs a person.
 */
export type JobStatus = "queued" | "running" | "done" | "dead";

export const JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "done", "dead"];

/**
 * What there is to do.
 *
 * `ingest` is one URL becoming a sellable position: a crawl, an offering and
 * an ICP. Slow, once per campaign, and the one job a person is waiting on.
 * `tick` is the agent working: replies, discovery, qualification, enrolment,
 * sends. Recurring forever while the campaign runs.
 */
export type JobKind = "ingest" | "tick";

export const JOB_KINDS: readonly JobKind[] = ["ingest", "tick"];

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

/** The fields the policy needs. A row has more; none of the rest decides anything. */
export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** Higher goes first. `ingest` outranks `tick` because somebody is waiting. */
  priority: number;
  /** Incremented when claimed, so it counts starts rather than finishes. */
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  leaseUntil: Date | null;
}

export interface QueuePolicy {
  /** The first retry waits this long. Each further attempt doubles it. */
  baseBackoffMs: number;
  /** And no retry ever waits longer than this. */
  maxBackoffMs: number;
  /**
   * How long a claim is good for.
   *
   * This is the only number in the queue that can cause a double-send if it
   * is wrong, and it is wrong in one specific way: shorter than the work.
   * A worker renews its lease while it runs, so the lease only has to outlast
   * the gap between heartbeats, not the job. Five minutes against a
   * thirty-second heartbeat leaves nine missed beats of headroom.
   */
  leaseMs: number;
  maxAttempts: number;
  /** A tick that did something is worth repeating soon. */
  busyIntervalMs: number;
  /** A tick that found nothing to do is not. */
  idleIntervalMs: number;
  /** However idle it gets, look again at least this often. */
  maxIntervalMs: number;
}

export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  baseBackoffMs: 30_000,
  maxBackoffMs: 30 * 60_000,
  leaseMs: 5 * 60_000,
  maxAttempts: 5,
  busyIntervalMs: 60_000,
  idleIntervalMs: 10 * 60_000,
  maxIntervalMs: 60 * 60_000,
};

export const PRIORITY: Record<JobKind, number> = {
  // Somebody pasted a URL and is watching a spinner. Everything else can wait.
  ingest: 100,
  tick: 0,
};

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/**
 * May this job be claimed right now?
 *
 * Two ways in. The ordinary one is a queued job whose time has come. The
 * other is a running job whose lease has expired, which means the worker
 * holding it stopped breathing — crashed, was killed, lost its network, or
 * the machine went away. Without that second case a single crash would park a
 * campaign forever, and "the agent quietly stopped" is the failure mode this
 * whole design exists to prevent.
 *
 * A running job with no lease at all is *not* claimable. That state should not
 * exist, and inventing a recovery for an impossible state is how a queue
 * learns to double-send.
 */
export function isClaimable(job: JobRecord, now: Date): boolean {
  if (job.status === "queued") return job.runAt.getTime() <= now.getTime();
  if (job.status === "running") return leaseExpired(job, now);
  return false;
}

export function leaseExpired(job: JobRecord, now: Date): boolean {
  if (job.status !== "running" || job.leaseUntil === null) return false;
  return job.leaseUntil.getTime() <= now.getTime();
}

/**
 * The order work is taken in: priority first, then oldest due.
 *
 * Due time rather than creation time, so a job that was deliberately deferred
 * does not jump the queue on the strength of having been created early.
 */
export function compareForClaim(a: JobRecord, b: JobRecord): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  return a.runAt.getTime() - b.runAt.getTime();
}

export function leaseUntil(now: Date, policy: QueuePolicy): Date {
  return new Date(now.getTime() + policy.leaseMs);
}

// ---------------------------------------------------------------------------
// Failing
// ---------------------------------------------------------------------------

/**
 * Exponential backoff with equal jitter.
 *
 * The exponent is the obvious half: a provider that just rate-limited you
 * will rate-limit you again in one second. The jitter is the half that gets
 * left out, and it matters here for a specific reason — a worker restart
 * fails every in-flight job at the same instant, and without jitter all of
 * them come back at the same instant too, which is how a transient failure
 * becomes a self-inflicted thundering herd against someone else's free tier.
 *
 * The jitter is a parameter rather than a call to `Math.random`, so that a
 * test can pin it and this function stays total.
 */
export function backoffMs(attempt: number, policy: QueuePolicy, jitter = 0.5): number {
  const n = Math.max(1, Math.floor(attempt));
  const exponential = policy.baseBackoffMs * 2 ** (n - 1);
  const capped = Math.min(policy.maxBackoffMs, exponential);
  const clamped = Math.min(1, Math.max(0, jitter));
  // Equal jitter: half the delay is fixed, half is spread. Never zero, which
  // an immediate retry would effectively be.
  return Math.round(capped * (0.5 + 0.5 * clamped));
}

export type FailureDecision =
  | { action: "retry"; attempt: number; runAt: Date; delayMs: number }
  | { action: "dead"; attempt: number };

/**
 * Retry, or give up?
 *
 * `attempts` counts starts, so a job that has just failed its first run
 * arrives here with `attempts === 1`. It is dead when it has used its whole
 * allowance, and that is checked against the job's own `maxAttempts` rather
 * than the policy's, because the allowance is a property of the work: a crawl
 * that hit a flaky host deserves several goes, and a job carrying a payload
 * the code cannot parse deserves exactly one.
 */
export function decideFailure(job: JobRecord, now: Date, policy: QueuePolicy, jitter = 0.5): FailureDecision {
  const attempt = Math.max(1, job.attempts);
  const allowance = Math.max(1, job.maxAttempts);
  if (attempt >= allowance) return { action: "dead", attempt };
  const delayMs = backoffMs(attempt, policy, jitter);
  return { action: "retry", attempt, runAt: new Date(now.getTime() + delayMs), delayMs };
}

/**
 * Some failures are not worth retrying.
 *
 * Five goes at a campaign that does not exist is five goes at the same
 * answer, and it buries the real failures in the console. This is a
 * deliberately short list: "we are certain another attempt is pointless" is a
 * strong claim, and the default has to be to try again.
 */
export function isPermanentFailure(message: string): boolean {
  return /\bno campaign\b|\bnot found\b|\bunknown job kind\b|\bmissing payload\b/i.test(message);
}

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

export interface PacingInput {
  /** Did the tick actually do anything? */
  didWork: boolean;
  /** The earliest moment this campaign has something due, if it knows. */
  nextDueAt?: Date | null;
  now: Date;
  policy: QueuePolicy;
}

/**
 * When should this campaign be looked at again?
 *
 * Polling every twenty seconds is what a script does. It is defensible with
 * one campaign and absurd with five hundred: the overwhelming majority of
 * ticks on a healthy pipeline have nothing to do, because the next touch is
 * forty-eight hours away by design. So the campaign's own schedule sets the
 * pace — the sequence reducer already knows when the next step is due, and
 * that is a far better answer than a constant.
 *
 * Three inputs, in order of authority:
 *
 *   - A tick that did something gets looked at again shortly. Work tends to
 *     arrive in bursts (a discovery run produces a dozen qualifications), and
 *     a burst should be worked through rather than spread over hours.
 *   - Otherwise, the next due step, if there is one. Not *at* it — a few
 *     seconds after, so a rounding error cannot land the tick a moment early
 *     and make it do nothing.
 *   - Otherwise an idle interval, because things arrive that no schedule
 *     predicted: a reply, a bounce, an operator arming the campaign.
 *
 * And a ceiling over all of it, so a campaign can never be quietly forgotten.
 */
export function nextRunAt(input: PacingInput): Date {
  const { now, policy } = input;
  const at = (ms: number) => new Date(now.getTime() + Math.min(policy.maxIntervalMs, Math.max(1_000, ms)));

  if (input.didWork) return at(policy.busyIntervalMs);

  const due = input.nextDueAt ?? null;
  if (due) {
    const untilDue = due.getTime() - now.getTime() + 5_000;
    // Something is already overdue and the tick still did nothing: a cap, a
    // send window, a warmup ramp. Waiting the idle interval is right — the
    // thing in the way is measured in hours, not seconds.
    if (untilDue <= 0) return at(policy.idleIntervalMs);
    return at(Math.min(untilDue, policy.maxIntervalMs));
  }

  return at(policy.idleIntervalMs);
}

/** Whether a tick summary counts as having done something. */
export function didWork(summary: {
  repliesRead?: number; discovered?: number; qualified?: number;
  enrolled?: number; sent?: number; answered?: number;
}): boolean {
  return Boolean(
    (summary.repliesRead ?? 0) + (summary.discovered ?? 0) + (summary.qualified ?? 0) +
    (summary.enrolled ?? 0) + (summary.sent ?? 0) + (summary.answered ?? 0),
  );
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * At most one job of a kind per campaign, enforced by the database.
 *
 * This is the whole double-send defence, and it is worth being precise about
 * why it is a unique index rather than a lock. A lock is held by a process;
 * when the process is on another machine, or is a web request rather than a
 * worker, or is a cron entry someone added by hand, the lock is not shared
 * and the protection is imaginary. A unique index is held by the data.
 *
 * The trick that makes it work on both SQLite and Postgres is that the key is
 * cleared when the job reaches a terminal state. Both treat NULLs in a unique
 * index as distinct, so finished jobs pile up harmlessly while at most one
 * live job per key exists at any instant — no partial index, no vendor
 * extension, no second table.
 *
 * The practical consequence is the nice one: a running campaign has exactly
 * one `tick` row for its whole life, moving between queued and running.
 * "Run now" is not a second job, it is claiming the one that exists a little
 * early, which is why pressing the button twice cannot send anything twice.
 */
export function dedupeKey(kind: JobKind, campaignId: string | null): string {
  return campaignId ? `${kind}:${campaignId}` : kind;
}

/**
 * Who holds a claim.
 *
 * Host and pid so a person can find the process, and a random tail because
 * two workers in one container share a hostname, and `--concurrency 4` means
 * four claims in one process sharing a pid. Identity that is not unique is
 * the bug that made the file lock take over its own replacement's claim.
 */
export function workerName(host: string, pid: number, random: string): string {
  return `${host}/${pid}/${random.slice(0, 8)}`;
}
