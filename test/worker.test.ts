import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "../src/infra/db";
import { NullLlm } from "../src/infra/llm";
import { claim, enqueue, queueStats } from "../src/infra/queue";
import {
  earliestDue, handleIngest, handleTick, runWorker, seedQueue, workersAlive,
  type JobOutcome, type WorkerContext,
} from "../src/agent/worker";
import { DEFAULT_QUEUE_POLICY } from "../src/core/queue";
import { toJson } from "../src/lib/json";
import { icp, offering } from "./factories";

/**
 * The worker loop.
 *
 * One property matters more than everything else in this file: however many
 * workers are running, each job runs once. That is the entire case for being
 * able to start a second worker, and it is proved here by racing several of
 * them over a queue and counting.
 *
 * The handlers are substituted for most of it. Deliberately — whether the
 * claim discipline holds has nothing to do with crawling, composing or
 * sending, and the orchestrator's own behaviour is tested where it lives.
 */

const llm = new NullLlm();
let userId = "";

async function campaign(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await db.campaign.create({
    data: {
      userId,
      name: "Worker test",
      sourceUrl: "https://worker.test",
      status: "running",
      offering: toJson(offering()),
      icp: toJson(icp()),
      ...overrides,
    },
  });
  return row.id;
}

function context(): WorkerContext {
  return { llm, useDns: false, now: () => new Date(), say: () => {} };
}

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { email: "worker-test@mercurio.test" },
    create: { email: "worker-test@mercurio.test", passwordHash: await bcrypt.hash("x".repeat(12), 4) },
    update: {},
  });
  userId = user.id;
});

beforeEach(async () => {
  await db.job.deleteMany({});
  await db.workerInstance.deleteMany({});
  await db.campaign.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await db.job.deleteMany({});
  await db.workerInstance.deleteMany({});
  await db.campaign.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: userId } });
});

describe("exactly once, however many workers", () => {
  it("runs each job once when six workers race for it", async () => {
    const campaigns = await Promise.all(Array.from({ length: 10 }, () => campaign()));
    for (const id of campaigns) await enqueue({ kind: "tick", campaignId: id });

    const runs: string[] = [];
    const handler = async (job: { campaignId: string | null }): Promise<JobOutcome> => {
      // Long enough that the workers genuinely overlap.
      await new Promise((resolve) => setTimeout(resolve, 15));
      runs.push(job.campaignId ?? "?");
      return { log: [], result: {}, next: undefined };
    };

    const reports = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        runWorker({
          llm, name: `racer/${i}`, concurrency: 2, exitWhenIdle: true,
          seed: false, pollMs: 1, handler, onLog: () => {},
        })),
    );

    expect(runs).toHaveLength(10);
    expect(new Set(runs).size).toBe(10);
    expect(reports.reduce((sum, r) => sum + r.done, 0)).toBe(10);
    expect((await queueStats()).queued).toBe(0);
  });

  it("does not run a job twice when its own handler is slower than one poll", async () => {
    const id = await campaign();
    await enqueue({ kind: "tick", campaignId: id });

    let running = 0;
    let overlapped = false;
    const handler = async (): Promise<JobOutcome> => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 40));
      running -= 1;
      return { log: [], result: {}, next: undefined };
    };

    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        runWorker({
          llm, name: `slow/${i}`, concurrency: 2, exitWhenIdle: true,
          seed: false, pollMs: 1, handler, onLog: () => {},
        })),
    );

    expect(overlapped).toBe(false);
  });

  it("spreads ten campaigns across workers rather than queueing behind one", async () => {
    const campaigns = await Promise.all(Array.from({ length: 8 }, () => campaign()));
    for (const id of campaigns) await enqueue({ kind: "tick", campaignId: id });

    let peak = 0;
    let active = 0;
    const handler = async (): Promise<JobOutcome> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return { log: [], result: {}, next: undefined };
    };

    await Promise.all([
      runWorker({ llm, name: "a", concurrency: 2, exitWhenIdle: true, seed: false, pollMs: 1, handler }),
      runWorker({ llm, name: "b", concurrency: 2, exitWhenIdle: true, seed: false, pollMs: 1, handler }),
    ]);

    // Four slots across two workers; anything above one proves the work is
    // genuinely running in parallel rather than serialising on a global lock.
    expect(peak).toBeGreaterThan(1);
  });
});

describe("the loop", () => {
  it("takes one job and stops when asked to", async () => {
    const a = await campaign();
    const b = await campaign();
    await enqueue({ kind: "tick", campaignId: a });
    await enqueue({ kind: "tick", campaignId: b });

    const report = await runWorker({
      llm, name: "once", concurrency: 1, maxJobs: 1, exitWhenIdle: true,
      seed: false, pollMs: 1, handler: async () => ({ log: [], result: {}, next: undefined }),
    });

    expect(report.done).toBe(1);
    expect((await queueStats()).queued).toBe(1);
  });

  it("schedules the next tick from what the handler decided", async () => {
    const id = await campaign();
    await enqueue({ kind: "tick", campaignId: id });
    const next = new Date(Date.now() + 900_000);

    await runWorker({
      llm, name: "sched", concurrency: 1, exitWhenIdle: true, seed: false, pollMs: 1,
      handler: async () => ({ log: [], result: { sent: 1 }, next }),
    });

    const queued = await db.job.findMany({ where: { campaignId: id, status: "queued" } });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.runAt.getTime()).toBe(next.getTime());
  });

  it("retries a job that threw, and records why", async () => {
    const id = await campaign();
    await enqueue({ kind: "tick", campaignId: id });

    const report = await runWorker({
      llm, name: "flaky", concurrency: 1, exitWhenIdle: true, seed: false, pollMs: 1,
      maxJobs: 1,
      handler: async () => { throw new Error("fetch failed"); },
    });

    expect(report.failed).toBe(1);
    const row = await db.job.findFirstOrThrow({ where: { campaignId: id } });
    expect(row.status).toBe("queued");
    expect(row.lastError).toBe("fetch failed");
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("gives up loudly, on the campaign, where somebody will see it", async () => {
    const id = await campaign();
    await enqueue({ kind: "tick", campaignId: id, maxAttempts: 1 });

    await runWorker({
      llm, name: "doomed", concurrency: 1, exitWhenIdle: true, seed: false, pollMs: 1, maxJobs: 1,
      handler: async () => { throw new Error("fetch failed"); },
    });

    const row = await db.job.findFirstOrThrow({ where: { campaignId: id } });
    expect(row.status).toBe("dead");
    const events = await db.event.findMany({ where: { campaignId: id, kind: "tick.dead" } });
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe("error");
  });

  it("marks a campaign failed when its ingest gives up, rather than spinning forever", async () => {
    const id = await campaign({ status: "ingesting", offering: null, icp: null });
    await enqueue({ kind: "ingest", campaignId: id, maxAttempts: 1 });

    await runWorker({
      llm, name: "ingest-doomed", concurrency: 1, exitWhenIdle: true, seed: false, pollMs: 1, maxJobs: 1,
      handler: async () => { throw new Error("Could not read https://worker.test"); },
    });

    const row = await db.campaign.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Could not read");
  });

  it("hands its claims back when it is asked to stop, without spending an attempt", async () => {
    const id = await campaign();
    await enqueue({ kind: "tick", campaignId: id });

    const controller = new AbortController();
    const running = runWorker({
      llm, name: "interrupted", concurrency: 1, exitWhenIdle: true, seed: false, pollMs: 1,
      signal: controller.signal,
      handler: async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Thrown to stand in for a process that never finishes the work.
        throw new Error("stopped mid-flight");
      },
    });
    await running;

    const row = await db.job.findFirstOrThrow({ where: { campaignId: id } });
    expect(row.status).toBe("queued");
  });

  it("announces itself while it runs and retires when it stops", async () => {
    const id = await campaign();
    await enqueue({ kind: "tick", campaignId: id });

    let aliveDuring = 0;
    await runWorker({
      llm, name: "visible", concurrency: 1, exitWhenIdle: true, seed: false, pollMs: 1,
      handler: async () => {
        aliveDuring = (await workersAlive()).alive;
        return { log: [], result: {}, next: undefined };
      },
    });

    expect(aliveDuring).toBe(1);
    expect((await workersAlive()).alive).toBe(0);
  });
});

describe("seedQueue", () => {
  it("gives every running campaign something to do", async () => {
    const a = await campaign();
    const b = await campaign();
    const report = await seedQueue();
    expect(report.ticks).toBe(2);
    expect(await db.job.count({ where: { campaignId: { in: [a, b] } } })).toBe(2);
  });

  it("queues an ingest for a campaign that has not been read yet", async () => {
    await campaign({ status: "ingesting", offering: null, icp: null });
    const report = await seedQueue();
    expect(report).toMatchObject({ ingests: 1, ticks: 0 });
  });

  it("queues an ingest for a running campaign whose ICP went missing", async () => {
    // A half-written campaign is otherwise a campaign that ticks forever and
    // never does anything, because the tick needs an offering and an ICP.
    await campaign({ status: "running", icp: null });
    expect(await seedQueue()).toMatchObject({ ingests: 1 });
  });

  it("leaves paused and failed campaigns alone", async () => {
    await campaign({ status: "paused" });
    await campaign({ status: "failed" });
    expect(await seedQueue()).toMatchObject({ ticks: 0, ingests: 0 });
  });

  it("is safe to run from every worker at once", async () => {
    const id = await campaign();
    await Promise.all(Array.from({ length: 6 }, () => seedQueue()));
    expect(await db.job.count({ where: { campaignId: id } })).toBe(1);
  });

  it("does not add to a campaign that already has work queued", async () => {
    const id = await campaign();
    await enqueue({ kind: "tick", campaignId: id, runAt: new Date(Date.now() + 600_000) });
    expect(await seedQueue()).toMatchObject({ ticks: 0 });
    expect(await db.job.count({ where: { campaignId: id } })).toBe(1);
  });

  it("leaves a freshly dead job in the dead letter where it can be seen", async () => {
    const id = await campaign();
    await db.job.create({
      data: {
        kind: "tick", campaignId: id, status: "dead", attempts: 5,
        finishedAt: new Date(), lastError: "boom",
      },
    });
    expect(await seedQueue()).toMatchObject({ skippedDead: 1, ticks: 0 });
  });

  it("but tries the campaign again once the dead job has gone cold", async () => {
    // A campaign that stays stopped until a person notices is the silent
    // failure this whole design is against.
    const id = await campaign();
    await db.job.create({
      data: {
        kind: "tick", campaignId: id, status: "dead", attempts: 5,
        finishedAt: new Date(Date.now() - 3 * 60 * 60_000), lastError: "boom",
      },
    });
    expect(await seedQueue()).toMatchObject({ ticks: 1 });
  });

  it("is what makes a worker self-starting", async () => {
    const id = await campaign();
    let ran = "";
    await runWorker({
      llm, name: "self-starting", concurrency: 1, exitWhenIdle: true, pollMs: 1,
      handler: async (job) => { ran = job.campaignId ?? ""; return { log: [], result: {}, next: undefined }; },
    });
    // Nothing enqueued it. The worker found the campaign itself.
    expect(ran).toBe(id);
  });
});

describe("handleTick", () => {
  it("does nothing to a paused campaign, and does not come straight back", async () => {
    const id = await campaign({ status: "paused" });
    const { job } = await enqueue({ kind: "tick", campaignId: id });
    const outcome = await handleTick({ ...job, campaignId: id }, context());
    expect(outcome.result).toMatchObject({ skipped: "paused" });
    expect(outcome.next!.getTime() - Date.now()).toBeGreaterThan(DEFAULT_QUEUE_POLICY.idleIntervalMs);
  });

  it("routes a campaign that was never ingested back to ingest", async () => {
    const id = await campaign({ status: "ingesting", offering: null, icp: null });
    const { job } = await enqueue({ kind: "tick", campaignId: id });
    const outcome = await handleTick({ ...job, campaignId: id }, context());
    expect(outcome.result).toMatchObject({ skipped: "ingesting" });
    expect(await db.job.count({ where: { campaignId: id, kind: "ingest" } })).toBe(1);
  });

  it("fails permanently on a campaign that has gone", async () => {
    const { job } = await enqueue({ kind: "tick", campaignId: null });
    await expect(handleTick({ ...job, campaignId: "camp_gone" }, context())).rejects.toThrow(/No campaign/);
  });
});

describe("handleIngest", () => {
  it("does not crawl a site twice after a crash between the write and the finish", async () => {
    const id = await campaign({ status: "ingesting" });
    const { job } = await enqueue({ kind: "ingest", campaignId: id });
    const outcome = await handleIngest({ ...job, campaignId: id }, context());
    expect(outcome.result).toMatchObject({ alreadyIngested: true });
    expect((await db.campaign.findUniqueOrThrow({ where: { id } })).status).toBe("running");
  });
});

describe("pacing", () => {
  it("reads the next due step off the campaign's own enrollments", async () => {
    const id = await campaign();
    const lead = await db.lead.create({
      data: { campaignId: id, domain: "x.test", companyName: "X", url: "https://x.test", discoveredVia: "seed" },
    });
    const contact = await db.contact.create({
      data: { leadId: lead.id, email: "a@x.test", kind: "role", source: "https://x.test" },
    });
    const due = new Date(Date.now() + 86_400_000);
    await db.enrollment.create({
      data: {
        campaignId: id, leadId: lead.id, contactId: contact.id,
        sequenceName: "default", sequence: toJson({ name: "default", steps: [] }),
        state: "active", nextDueAt: due,
      },
    });

    expect((await earliestDue(id))?.getTime()).toBe(due.getTime());
  });

  it("has no opinion when nothing is scheduled", async () => {
    expect(await earliestDue(await campaign())).toBeNull();
  });

  it("ignores enrollments that have finished", async () => {
    const id = await campaign();
    const lead = await db.lead.create({
      data: { campaignId: id, domain: "y.test", companyName: "Y", url: "https://y.test", discoveredVia: "seed" },
    });
    const contact = await db.contact.create({
      data: { leadId: lead.id, email: "b@y.test", kind: "role", source: "https://y.test" },
    });
    await db.enrollment.create({
      data: {
        campaignId: id, leadId: lead.id, contactId: contact.id,
        sequenceName: "default", sequence: toJson({ name: "default", steps: [] }),
        state: "unsubscribed", nextDueAt: new Date(Date.now() + 1000),
      },
    });
    expect(await earliestDue(id)).toBeNull();
  });
});

describe("claiming through the queue is what excludes everything else", () => {
  it("a worker cannot start a tick an operator's own run is holding", async () => {
    const id = await campaign();
    await enqueue({ kind: "tick", campaignId: id });
    // Stands in for `npm run agent`, which takes the same claim.
    await claim({ worker: "cli/operator", force: true });

    let ran = false;
    await runWorker({
      llm, name: "worker", concurrency: 1, exitWhenIdle: true, seed: false, pollMs: 1,
      handler: async () => { ran = true; return { log: [], result: {}, next: undefined }; },
    });
    expect(ran).toBe(false);
  });
});
