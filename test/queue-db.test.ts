import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "../src/infra/db";
import {
  claim, complete, enqueue, fail, heartbeat, heldBy, liveWorkers, newWorkerName,
  pruneFinished, queueStats, reap, registerWorker, release, revive, workerSeen,
  workerStopped,
} from "../src/infra/queue";
import { DEFAULT_QUEUE_POLICY } from "../src/core/queue";

/**
 * The queue against a real database.
 *
 * The policy is proved in `queue.test.ts` with no database at all. What is
 * left to prove is the part that cannot be: that the claim is genuinely
 * atomic, so two workers racing for one job produce one winner — because the
 * entire case for running more than one worker rests on that single
 * compare-and-set behaving the way the comment says it does.
 */

let campaignA = "";
let campaignB = "";

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { email: "queue-test@mercurio.test" },
    create: { email: "queue-test@mercurio.test", passwordHash: await bcrypt.hash("x".repeat(12), 4) },
    update: {},
  });
  const a = await db.campaign.create({
    data: { userId: user.id, name: "Queue A", sourceUrl: "https://a.test", status: "running" },
  });
  const b = await db.campaign.create({
    data: { userId: user.id, name: "Queue B", sourceUrl: "https://b.test", status: "running" },
  });
  campaignA = a.id;
  campaignB = b.id;
});

beforeEach(async () => {
  await db.job.deleteMany({});
  await db.workerInstance.deleteMany({});
});

afterAll(async () => {
  await db.job.deleteMany({});
  await db.workerInstance.deleteMany({});
  await db.campaign.deleteMany({ where: { id: { in: [campaignA, campaignB] } } });
});

const WORKER = "test/1/aaaa";

describe("enqueue", () => {
  it("creates work", async () => {
    const result = await enqueue({ kind: "tick", campaignId: campaignA });
    expect(result.created).toBe(true);
    expect(await db.job.count({ where: { campaignId: campaignA } })).toBe(1);
  });

  it("cannot be made to create two live jobs for one campaign", async () => {
    // Every path enqueues: the console's button, a finishing tick, a worker
    // starting up. They race, and the unique index decides rather than the
    // ordering.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => enqueue({ kind: "tick", campaignId: campaignA })),
    );
    expect(await db.job.count({ where: { campaignId: campaignA } })).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("keeps different kinds and different campaigns apart", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    await enqueue({ kind: "ingest", campaignId: campaignA });
    await enqueue({ kind: "tick", campaignId: campaignB });
    expect(await db.job.count()).toBe(3);
  });

  it("pulls an existing job forward rather than adding a second", async () => {
    const later = new Date(Date.now() + 60 * 60_000);
    await enqueue({ kind: "tick", campaignId: campaignA, runAt: later });
    const again = await enqueue({ kind: "tick", campaignId: campaignA, runAt: new Date() });
    expect(again.created).toBe(false);
    if (!again.created) expect(again.pulledForward).toBe(true);
    const row = await db.job.findFirstOrThrow({ where: { campaignId: campaignA } });
    expect(row.runAt.getTime()).toBeLessThan(later.getTime());
  });

  it("does not push a job back", async () => {
    const soon = new Date(Date.now() + 1_000);
    await enqueue({ kind: "tick", campaignId: campaignA, runAt: soon });
    const again = await enqueue({ kind: "tick", campaignId: campaignA, runAt: new Date(Date.now() + 60 * 60_000) });
    if (!again.created) expect(again.pulledForward).toBe(false);
    const row = await db.job.findFirstOrThrow({ where: { campaignId: campaignA } });
    expect(row.runAt.getTime()).toBe(soon.getTime());
  });

  it("gives ingest the priority of something somebody is waiting on", async () => {
    const ingest = await enqueue({ kind: "ingest", campaignId: campaignA });
    const tick = await enqueue({ kind: "tick", campaignId: campaignA });
    expect(ingest.job.priority).toBeGreaterThan(tick.job.priority);
  });
});

describe("claim", () => {
  it("takes work that is due", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    const taken = await claim({ worker: WORKER });
    expect(taken?.campaignId).toBe(campaignA);
    expect(taken?.status).toBe("running");
    expect(taken?.attempts).toBe(1);
    expect(taken?.claimedBy).toBe(WORKER);
  });

  it("leaves work that is not", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA, runAt: new Date(Date.now() + 60_000) });
    expect(await claim({ worker: WORKER })).toBeNull();
  });

  it("takes a deferred job when an operator asks for it now", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA, runAt: new Date(Date.now() + 60 * 60_000) });
    const taken = await claim({ worker: WORKER, force: true });
    expect(taken).not.toBeNull();
  });

  it("will not steal a live claim, even when forced", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    await claim({ worker: "worker/a" });
    expect(await claim({ worker: "worker/b", force: true })).toBeNull();
  });

  it("takes the ingest before the tick", async () => {
    await enqueue({ kind: "tick", campaignId: campaignB });
    await enqueue({ kind: "ingest", campaignId: campaignA });
    const first = await claim({ worker: WORKER });
    expect(first?.kind).toBe("ingest");
  });

  it("can be asked for one kind only", async () => {
    await enqueue({ kind: "ingest", campaignId: campaignA });
    expect(await claim({ worker: WORKER, kinds: ["tick"] })).toBeNull();
    expect((await claim({ worker: WORKER, kinds: ["ingest"] }))?.kind).toBe("ingest");
  });

  it("gives exactly one of many simultaneous workers the job", async () => {
    // The whole case for scaling out rests on this one assertion.
    await enqueue({ kind: "tick", campaignId: campaignA });
    const winners = (await Promise.all(
      Array.from({ length: 16 }, (_, i) => claim({ worker: `racer/${i}` })),
    )).filter((job) => job !== null);
    expect(winners).toHaveLength(1);

    const row = await db.job.findFirstOrThrow({ where: { campaignId: campaignA } });
    expect(row.claimedBy).toBe(winners[0]?.claimedBy);
    // One claim, one attempt. A lost race must not consume the allowance.
    expect(row.attempts).toBe(1);
  });

  it("hands two campaigns to two workers at once", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    await enqueue({ kind: "tick", campaignId: campaignB });
    const [one, two] = await Promise.all([claim({ worker: "w/1" }), claim({ worker: "w/2" })]);
    expect([one, two].filter(Boolean)).toHaveLength(2);
    expect(new Set([one?.campaignId, two?.campaignId]).size).toBe(2);
  });

  it("takes over a claim whose holder stopped breathing", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    const first = await claim({ worker: "dead/worker" });
    await db.job.update({ where: { id: first!.id }, data: { leaseUntil: new Date(Date.now() - 1) } });
    const second = await claim({ worker: "live/worker" });
    expect(second?.id).toBe(first!.id);
    expect(second?.attempts).toBe(2);
  });

  it("says who holds a job", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    expect(await heldBy("tick", campaignA)).toBeNull();
    await claim({ worker: "someone/else" });
    expect((await heldBy("tick", campaignA))?.worker).toBe("someone/else");
  });
});

describe("heartbeat", () => {
  it("extends the holder's lease", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: WORKER });
    const before = job!.leaseUntil!.getTime();
    const later = new Date(Date.now() + 30_000);
    expect(await heartbeat(job!.id, WORKER, later)).toBe(true);
    const row = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.leaseUntil!.getTime()).toBeGreaterThan(before);
  });

  it("tells a worker its claim is gone", async () => {
    // The signal to abandon the work: somebody else is doing it now, and two
    // processes finishing one tick is the outcome the queue exists to prevent.
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: WORKER });
    await db.job.update({ where: { id: job!.id }, data: { claimedBy: "another/worker" } });
    expect(await heartbeat(job!.id, WORKER)).toBe(false);
  });
});

describe("complete", () => {
  it("finishes, and frees the key so the campaign can be given more work", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: WORKER });
    expect(await complete({ jobId: job!.id, worker: WORKER, result: { sent: 2 } })).toBe(true);

    const row = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.status).toBe("done");
    expect(row.dedupeKey).toBeNull();
    expect(row.result).toContain("\"sent\":2");

    const again = await enqueue({ kind: "tick", campaignId: campaignA });
    expect(again.created).toBe(true);
  });

  it("schedules the next tick in the same breath", async () => {
    // Two round trips would leave a window in which the campaign has no job
    // at all, and a crash inside that window is a campaign that never ticks
    // again.
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: WORKER });
    const runAt = new Date(Date.now() + 600_000);
    await complete({
      jobId: job!.id, worker: WORKER,
      next: { kind: "tick", campaignId: campaignA, runAt },
    });

    const live = await db.job.findMany({ where: { campaignId: campaignA, status: "queued" } });
    expect(live).toHaveLength(1);
    expect(live[0]?.runAt.getTime()).toBe(runAt.getTime());
    expect(live[0]?.dedupeKey).toBe(`tick:${campaignA}`);
  });

  it("refuses a worker that does not hold the job", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: WORKER });
    expect(await complete({ jobId: job!.id, worker: "impostor" })).toBe(false);
    expect((await db.job.findUniqueOrThrow({ where: { id: job!.id } })).status).toBe("running");
  });
});

describe("fail", () => {
  it("puts the job back, later", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: WORKER });
    const result = await fail({ jobId: job!.id, worker: WORKER, error: "fetch failed", jitter: 1 });
    expect(result.outcome).toBe("retry");

    const row = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.status).toBe("queued");
    expect(row.claimedBy).toBeNull();
    expect(row.lastError).toBe("fetch failed");
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now() + DEFAULT_QUEUE_POLICY.baseBackoffMs / 2 - 1_000);
    // It keeps its key: the campaign still has exactly one live job.
    expect(row.dedupeKey).toBe(`tick:${campaignA}`);
  });

  it("gives up after the allowance, and does not wedge the campaign shut", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA, maxAttempts: 1 });
    const job = await claim({ worker: WORKER });
    expect((await fail({ jobId: job!.id, worker: WORKER, error: "fetch failed" })).outcome).toBe("dead");

    const row = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.status).toBe("dead");
    expect(row.dedupeKey).toBeNull();
    expect((await enqueue({ kind: "tick", campaignId: campaignA })).created).toBe(true);
  });

  it("does not spend five attempts on a campaign that no longer exists", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA, maxAttempts: 5 });
    const job = await claim({ worker: WORKER });
    const result = await fail({ jobId: job!.id, worker: WORKER, error: "No campaign camp_gone." });
    expect(result.outcome).toBe("dead");
    const row = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.lastError).toContain("permanent");
  });

  it("will not let a stranger fail somebody else's job", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: WORKER });
    expect((await fail({ jobId: job!.id, worker: "impostor", error: "boom" })).outcome).toBe("lost");
  });
});

describe("release", () => {
  it("hands back a claim without spending an attempt", async () => {
    // A rolling deploy must not walk a healthy job to dead.
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: WORKER });
    expect(job!.attempts).toBe(1);
    expect(await release(job!.id, WORKER)).toBe(true);

    const row = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.claimedBy).toBeNull();
  });
});

describe("reap", () => {
  it("puts an abandoned claim back", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: "killed/worker" });
    await db.job.update({ where: { id: job!.id }, data: { leaseUntil: new Date(Date.now() - 1_000) } });

    expect(await reap()).toEqual({ requeued: 1, dead: 0 });
    const row = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.status).toBe("queued");
    expect(row.lastError).toContain("stopped reporting");
  });

  it("leaves live claims alone", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    await claim({ worker: WORKER });
    expect(await reap()).toEqual({ requeued: 0, dead: 0 });
  });

  it("is safe to run from every worker at once", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: "killed/worker" });
    await db.job.update({ where: { id: job!.id }, data: { leaseUntil: new Date(Date.now() - 1_000) } });

    const results = await Promise.all(Array.from({ length: 8 }, () => reap()));
    expect(results.reduce((sum, r) => sum + r.requeued + r.dead, 0)).toBe(1);
  });

  it("buries a claim that has been abandoned too many times", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA, maxAttempts: 1 });
    const job = await claim({ worker: "killed/worker" });
    await db.job.update({ where: { id: job!.id }, data: { leaseUntil: new Date(Date.now() - 1_000) } });
    expect(await reap()).toEqual({ requeued: 0, dead: 1 });
  });
});

describe("revive", () => {
  it("puts a dead job back with a clean slate", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA, maxAttempts: 1 });
    const job = await claim({ worker: WORKER });
    await fail({ jobId: job!.id, worker: WORKER, error: "fetch failed" });

    expect(await revive(job!.id)).toBe(true);
    const row = await db.job.findUniqueOrThrow({ where: { id: job!.id } });
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(0);
    expect(row.dedupeKey).toBe(`tick:${campaignA}`);
  });

  it("refuses when live work already holds the key", async () => {
    // Otherwise reviving a dead tick duplicates one that is already running.
    await enqueue({ kind: "tick", campaignId: campaignA, maxAttempts: 1 });
    const job = await claim({ worker: WORKER });
    await fail({ jobId: job!.id, worker: WORKER, error: "fetch failed" });
    await enqueue({ kind: "tick", campaignId: campaignA });

    expect(await revive(job!.id)).toBe(false);
  });

  it("does nothing to a job that is not dead", async () => {
    const { job } = await enqueue({ kind: "tick", campaignId: campaignA });
    expect(await revive(job.id)).toBe(false);
  });
});

describe("looking at the queue", () => {
  it("counts what is waiting, running and dead", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    await enqueue({ kind: "tick", campaignId: campaignB, runAt: new Date(Date.now() + 60_000) });
    await claim({ worker: WORKER, kinds: ["tick"] });

    const stats = await queueStats();
    expect(stats.running).toBe(1);
    expect(stats.queued).toBe(1);
    expect(stats.due).toBe(0);
    expect(stats.nextRunAt).not.toBeNull();
  });

  it("notices when nothing is consuming the queue", async () => {
    // One number that answers "is a worker actually running?" without
    // trusting a worker to say so.
    await enqueue({
      kind: "tick", campaignId: campaignA,
      runAt: new Date(Date.now() - DEFAULT_QUEUE_POLICY.leaseMs - 60_000),
    });
    expect((await queueStats()).overdue).toBe(1);
  });

  it("prunes finished history", async () => {
    await enqueue({ kind: "tick", campaignId: campaignA });
    const job = await claim({ worker: WORKER });
    await complete({ jobId: job!.id, worker: WORKER, now: new Date(Date.now() - 86_400_000) });
    expect(await pruneFinished(new Date(Date.now() - 3_600_000))).toBe(1);
    expect(await db.job.count()).toBe(0);
  });
});

describe("workers announcing themselves", () => {
  it("registers, counts and retires", async () => {
    const name = newWorkerName();
    await registerWorker(name, 3);
    await workerSeen(name, { claimed: 2, done: 1, failed: 1 });

    const alive = await liveWorkers();
    expect(alive).toHaveLength(1);
    expect(alive[0]?.concurrency).toBe(3);
    expect(alive[0]?.done).toBe(1);

    await workerStopped(name);
    expect(await liveWorkers()).toHaveLength(0);
  });

  it("stops believing a worker that was killed without saying goodbye", async () => {
    const name = newWorkerName();
    await registerWorker(name, 1);
    await db.workerInstance.update({
      where: { id: name },
      data: { lastSeenAt: new Date(Date.now() - 3 * DEFAULT_QUEUE_POLICY.leaseMs) },
    });
    expect(await liveWorkers()).toHaveLength(0);
  });

  it("gives every worker in one process a different name", async () => {
    const names = new Set(Array.from({ length: 8 }, () => newWorkerName()));
    expect(names.size).toBe(8);
  });
});
