import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "../src/infra/db";
import { GET } from "../src/app/api/health/route";
import { enqueue, registerWorker, workerStopped } from "../src/infra/queue";

/**
 * `GET /api/health`.
 *
 * Unauthenticated, because the thing it is for is a free uptime monitor and
 * those cannot log in — which makes "says nothing an operator would mind a
 * stranger seeing" a property worth testing rather than a comment.
 *
 * The status is the other half. A console that answers while nothing consumes
 * the queue is the one failure this product can have with every page looking
 * perfectly healthy, so `ok` has to mean more than "the server replied".
 */

let userId = "";
let campaignId = "";

async function health(): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await GET();
  return { status: response.status, body: await response.json(), headers: response.headers };
}

beforeAll(async () => {
  const user = await db.user.upsert({
    where: { email: "health-test@mercurio.test" },
    create: { email: "health-test@mercurio.test", passwordHash: await bcrypt.hash("x".repeat(12), 4) },
    update: {},
  });
  userId = user.id;
  const campaign = await db.campaign.create({
    data: {
      userId,
      name: "Acme Confidential Prospecting",
      sourceUrl: "https://secret.test",
      status: "running",
    },
  });
  campaignId = campaign.id;
});

afterEach(async () => {
  await db.job.deleteMany({});
  await db.workerInstance.deleteMany({});
});

afterAll(async () => {
  await db.campaign.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: userId } });
});

describe("the verdict", () => {
  it("is ok when there is nothing to do and nothing doing it", async () => {
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.reasons).toEqual([]);
  });

  it("is ok when a worker is running", async () => {
    await registerWorker("health/worker", 2);
    await enqueue({ kind: "tick", campaignId });
    const { body } = await health();
    expect(body.status).toBe("ok");
    expect(body.workers).toBe(1);
  });

  it("is degraded when work is queued and no worker is running", async () => {
    // Every page in the console looks healthy in this state. This is the only
    // thing that says otherwise.
    await enqueue({ kind: "tick", campaignId });
    const { status, body } = await health();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.reasons).toContain("work is queued and no worker is running");
  });

  it("stops saying ok once a worker stops reporting", async () => {
    await registerWorker("health/leaver", 1);
    await enqueue({ kind: "tick", campaignId });
    expect((await health()).body.status).toBe("ok");

    await workerStopped("health/leaver");
    expect((await health()).body.status).toBe("degraded");
  });

  it("is degraded when something gave up, even with workers running", async () => {
    await registerWorker("health/worker", 1);
    await db.job.create({
      data: { kind: "tick", campaignId, status: "dead", attempts: 5, finishedAt: new Date(), lastError: "boom" },
    });
    const { body } = await health();
    expect(body.status).toBe("degraded");
    expect(body.reasons).toContain("1 job(s) gave up");
  });

  it("notices work that is overdue by more than a lease", async () => {
    await registerWorker("health/worker", 1);
    await enqueue({ kind: "tick", campaignId, runAt: new Date(Date.now() - 2 * 60 * 60_000) });
    const { body } = await health();
    expect(body.status).toBe("degraded");
    expect(String((body.reasons as string[]).join(" "))).toContain("overdue");
  });

  it("returns 200 for degraded and keeps 503 for the thing that cannot wait", async () => {
    // Paging somebody at 3am is for "the database is gone", not "a job is
    // retrying".
    await enqueue({ kind: "tick", campaignId });
    expect((await health()).status).toBe(200);
  });
});

describe("safe to publish", () => {
  it("says nothing about who is being contacted", async () => {
    await enqueue({ kind: "tick", campaignId });
    const response = await GET();
    const text = await response.text();
    expect(text).not.toContain("Acme Confidential Prospecting");
    expect(text).not.toContain("secret.test");
    expect(text).not.toContain("health-test@mercurio.test");
    expect(text).not.toContain(campaignId);
  });

  it("counts campaigns by state without naming them", async () => {
    const { body } = await health();
    expect(body.campaigns).toMatchObject({ running: expect.any(Number) });
  });

  it("is never cached, because a cached answer cannot show an outage", async () => {
    const { headers } = await health();
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("content-type")).toContain("application/json");
  });

  it("says when it was checked, so a stale answer is visible as one", async () => {
    const { body } = await health();
    expect(Date.parse(String(body.at))).toBeGreaterThan(Date.now() - 60_000);
    expect(body.database).toBe(true);
  });
});
