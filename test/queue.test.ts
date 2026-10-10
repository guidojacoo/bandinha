import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUEUE_POLICY, JOB_KINDS, PRIORITY, backoffMs, compareForClaim,
  decideFailure, dedupeKey, didWork, isClaimable, isJobKind, isPermanentFailure,
  leaseExpired, leaseUntil, nextRunAt, workerName,
  type JobRecord, type QueuePolicy,
} from "../src/core/queue";

/**
 * The queue's policy.
 *
 * Two bugs here cost real money: a job that runs twice, and a job that
 * silently never runs again. Both are decisions rather than queries, so both
 * can be pinned down here, with no database and no clock.
 */

const NOW = new Date("2026-03-10T12:00:00Z");

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_1",
    kind: "tick",
    status: "queued",
    priority: 0,
    attempts: 0,
    maxAttempts: 5,
    runAt: NOW,
    leaseUntil: null,
    ...overrides,
  };
}

const policy: QueuePolicy = DEFAULT_QUEUE_POLICY;

describe("isClaimable", () => {
  it("takes a queued job whose time has come", () => {
    expect(isClaimable(job({ runAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(true);
  });

  it("takes one due exactly now", () => {
    expect(isClaimable(job({ runAt: NOW }), NOW)).toBe(true);
  });

  it("leaves one that is not due yet", () => {
    expect(isClaimable(job({ runAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(false);
  });

  it("takes over a claim whose lease has expired", () => {
    const abandoned = job({ status: "running", leaseUntil: new Date(NOW.getTime() - 1_000) });
    expect(isClaimable(abandoned, NOW)).toBe(true);
  });

  it("does not touch a live claim", () => {
    const held = job({ status: "running", leaseUntil: new Date(NOW.getTime() + 60_000) });
    expect(isClaimable(held, NOW)).toBe(false);
  });

  it("does not invent a recovery for a running job with no lease", () => {
    // This state should not exist. A queue that guesses what to do with an
    // impossible state is a queue that learns to double-send.
    expect(isClaimable(job({ status: "running", leaseUntil: null }), NOW)).toBe(false);
  });

  it("never reopens a terminal job", () => {
    expect(isClaimable(job({ status: "done" }), NOW)).toBe(false);
    expect(isClaimable(job({ status: "dead" }), NOW)).toBe(false);
  });

  it("only calls a lease expired on a running job", () => {
    expect(leaseExpired(job({ status: "queued", leaseUntil: new Date(0) }), NOW)).toBe(false);
  });
});

describe("compareForClaim", () => {
  it("puts the ingest somebody is waiting on before a routine tick", () => {
    const ingest = job({ id: "a", kind: "ingest", priority: PRIORITY.ingest, runAt: new Date(NOW.getTime() + 1000) });
    const tick = job({ id: "b", kind: "tick", priority: PRIORITY.tick, runAt: new Date(0) });
    expect([tick, ingest].sort(compareForClaim)[0]?.id).toBe("a");
  });

  it("orders equal priorities by when they became due, not when they were made", () => {
    const later = job({ id: "later", runAt: new Date(NOW.getTime() + 60_000) });
    const sooner = job({ id: "sooner", runAt: NOW });
    expect([later, sooner].sort(compareForClaim).map((j) => j.id)).toEqual(["sooner", "later"]);
  });

  it("is a total order over a mixed queue", () => {
    const jobs = [
      job({ id: "1", priority: 0, runAt: new Date(3) }),
      job({ id: "2", priority: 100, runAt: new Date(9) }),
      job({ id: "3", priority: 0, runAt: new Date(1) }),
      job({ id: "4", priority: 100, runAt: new Date(2) }),
    ];
    expect(jobs.sort(compareForClaim).map((j) => j.id)).toEqual(["4", "2", "3", "1"]);
  });
});

describe("backoff", () => {
  it("doubles each attempt", () => {
    const delays = [1, 2, 3, 4].map((n) => backoffMs(n, policy, 1));
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000]);
  });

  it("is capped, so a retry is never scheduled for next week", () => {
    expect(backoffMs(40, policy, 1)).toBe(policy.maxBackoffMs);
  });

  it("spreads retries out, because a restart fails everything at once", () => {
    const none = backoffMs(1, policy, 0);
    const full = backoffMs(1, policy, 1);
    expect(none).toBeLessThan(full);
    expect(none).toBeGreaterThan(0);
  });

  it("never returns zero, which would be an immediate retry", () => {
    for (const jitter of [-1, 0, 0.5, 1, 2]) {
      expect(backoffMs(1, policy, jitter)).toBeGreaterThan(0);
    }
  });

  it("treats a nonsense attempt number as the first", () => {
    expect(backoffMs(0, policy, 1)).toBe(backoffMs(1, policy, 1));
    expect(backoffMs(-5, policy, 1)).toBe(backoffMs(1, policy, 1));
  });
});

describe("decideFailure", () => {
  it("retries while the allowance lasts", () => {
    const decision = decideFailure(job({ attempts: 1, maxAttempts: 3 }), NOW, policy, 1);
    expect(decision.action).toBe("retry");
    if (decision.action === "retry") {
      expect(decision.runAt.getTime()).toBe(NOW.getTime() + 30_000);
    }
  });

  it("gives up when the job has used it", () => {
    expect(decideFailure(job({ attempts: 3, maxAttempts: 3 }), NOW, policy).action).toBe("dead");
  });

  it("honours the job's own allowance, not the policy's", () => {
    // A job carrying a payload the code cannot parse deserves exactly one go.
    expect(decideFailure(job({ attempts: 1, maxAttempts: 1 }), NOW, policy).action).toBe("dead");
  });

  it("cannot be talked into an infinite retry by a zero allowance", () => {
    expect(decideFailure(job({ attempts: 1, maxAttempts: 0 }), NOW, policy).action).toBe("dead");
  });

  it("walks a repeatedly failing job to dead and no further", () => {
    let attempts = 0;
    const seen: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      attempts += 1;
      const decision = decideFailure(job({ attempts, maxAttempts: 3 }), NOW, policy);
      seen.push(decision.action);
      if (decision.action === "dead") break;
    }
    expect(seen).toEqual(["retry", "retry", "dead"]);
  });
});

describe("isPermanentFailure", () => {
  it("does not retry work whose target has gone", () => {
    expect(isPermanentFailure("No campaign abc123.")).toBe(true);
    expect(isPermanentFailure("Unknown job kind: sweep")).toBe(true);
  });

  it("retries anything that might be weather", () => {
    for (const transient of [
      "fetch failed", "ETIMEDOUT", "SQLITE_BUSY: database is locked",
      "429 Too Many Requests", "socket hang up", "EAI_AGAIN",
    ]) {
      expect(isPermanentFailure(transient)).toBe(false);
    }
  });
});

describe("nextRunAt", () => {
  it("comes straight back after a tick that did something", () => {
    const at = nextRunAt({ didWork: true, now: NOW, policy });
    expect(at.getTime() - NOW.getTime()).toBe(policy.busyIntervalMs);
  });

  it("sleeps until the next step is due, plus a moment", () => {
    const due = new Date(NOW.getTime() + 4 * 60 * 60_000);
    const at = nextRunAt({ didWork: false, nextDueAt: due, now: NOW, policy });
    // Clamped by the ceiling, so it will look again within the hour.
    expect(at.getTime() - NOW.getTime()).toBe(policy.maxIntervalMs);
  });

  it("wakes just after a step that is due soon, never just before", () => {
    const due = new Date(NOW.getTime() + 90_000);
    const at = nextRunAt({ didWork: false, nextDueAt: due, now: NOW, policy });
    expect(at.getTime()).toBeGreaterThan(due.getTime());
  });

  it("does not spin on something overdue that the tick still would not do", () => {
    // Overdue but blocked by a cap, a send window or the warmup ramp. Those
    // clear in hours, so hammering the campaign every second achieves nothing.
    const at = nextRunAt({ didWork: false, nextDueAt: new Date(NOW.getTime() - 60 * 60_000), now: NOW, policy });
    expect(at.getTime() - NOW.getTime()).toBe(policy.idleIntervalMs);
  });

  it("still looks again when nothing at all is scheduled", () => {
    // Replies, bounces and an operator arming a campaign are not on any
    // schedule, so idle can never mean never.
    const at = nextRunAt({ didWork: false, nextDueAt: null, now: NOW, policy });
    expect(at.getTime() - NOW.getTime()).toBe(policy.idleIntervalMs);
  });

  it("never schedules in the past, whatever it is given", () => {
    const silly: QueuePolicy = { ...policy, busyIntervalMs: -1, idleIntervalMs: 0 };
    for (const input of [
      { didWork: true, now: NOW, policy: silly },
      { didWork: false, now: NOW, policy: silly },
      { didWork: false, nextDueAt: new Date(0), now: NOW, policy: silly },
    ]) {
      expect(nextRunAt(input).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it("obeys the ceiling however quiet things are", () => {
    const quiet: QueuePolicy = { ...policy, idleIntervalMs: 10 * 24 * 60 * 60_000 };
    const at = nextRunAt({ didWork: false, now: NOW, policy: quiet });
    expect(at.getTime() - NOW.getTime()).toBe(quiet.maxIntervalMs);
  });
});

describe("didWork", () => {
  it("counts anything that changed the pipeline", () => {
    expect(didWork({ sent: 1 })).toBe(true);
    expect(didWork({ repliesRead: 2 })).toBe(true);
    expect(didWork({ discovered: 5 })).toBe(true);
    expect(didWork({ enrolled: 1 })).toBe(true);
  });

  it("does not count a tick that only decided not to do things", () => {
    // Blocked and failed are deliberately absent: a tick that blocked ten
    // sends on a cap has nothing more to do this minute, and coming straight
    // back would spin.
    expect(didWork({ blocked: 10, failed: 3 } as Record<string, number>)).toBe(false);
    expect(didWork({})).toBe(false);
  });
});

describe("identity", () => {
  it("names at most one live job per kind per campaign", () => {
    expect(dedupeKey("tick", "camp_1")).toBe("tick:camp_1");
    expect(dedupeKey("ingest", "camp_1")).not.toBe(dedupeKey("tick", "camp_1"));
    expect(dedupeKey("tick", "camp_1")).not.toBe(dedupeKey("tick", "camp_2"));
  });

  it("has a key for work that belongs to no campaign", () => {
    expect(dedupeKey("tick", null)).toBe("tick");
  });

  it("distinguishes two workers in one process", () => {
    // The bug that let the file lock take over its own replacement's claim:
    // host and pid are shared by concurrent workers in one container.
    const a = workerName("box", 42, "aaaaaaaabbbb");
    const b = workerName("box", 42, "ccccccccdddd");
    expect(a).not.toBe(b);
    expect(a.startsWith("box/42/")).toBe(true);
  });

  it("knows its own kinds", () => {
    for (const kind of JOB_KINDS) expect(isJobKind(kind)).toBe(true);
    expect(isJobKind("sweep")).toBe(false);
  });

  it("leases forward, never backward", () => {
    expect(leaseUntil(NOW, policy).getTime()).toBe(NOW.getTime() + policy.leaseMs);
  });
});
