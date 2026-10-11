import { db } from "../../../infra/db";
import { queueStats } from "../../../infra/queue";
import { workersAlive } from "../../../agent/worker";

/**
 * `GET /api/health` — one request that says whether the system is working.
 *
 * Unauthenticated on purpose, because the thing it is for is a free uptime
 * monitor, and those cannot log in. So it has to be safe to publish: it
 * returns counts and states, and no campaign names, addresses, copy or
 * anything an operator would mind a stranger seeing.
 *
 * The status is the useful part, and it is deliberately not "the HTTP server
 * answered". A console that answers while nothing consumes the queue is the
 * exact failure this product can have without any page looking wrong, so:
 *
 *   ok       the database answers, and either a worker is alive or there is
 *            nothing for one to do.
 *   degraded there is work to do and nothing doing it, or jobs are in the
 *            dead letter. A person should look, but mail is not being lost.
 *   down     the database did not answer. Nothing works.
 *
 * `degraded` returns 200 and `down` returns 503, so a monitor paging someone
 * at 3am does it for the one that cannot wait.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const startedAt = Date.now();

  let database = false;
  let detail: string | undefined;
  try {
    await db.$queryRaw`SELECT 1`;
    database = true;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }

  if (!database) {
    return json({ status: "down", database: false, detail }, 503);
  }

  const [stats, workers, campaigns] = await Promise.all([
    queueStats(),
    workersAlive(),
    db.campaign.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of campaigns) byStatus[row.status] = row._count._all;

  const workLeft = stats.queued + stats.running;
  const starved = workers.alive === 0 && workLeft > 0;
  const status = starved || stats.dead > 0 || stats.overdue > 0 ? "degraded" : "ok";

  const reasons: string[] = [];
  if (starved) reasons.push("work is queued and no worker is running");
  if (stats.overdue > 0) reasons.push(`${stats.overdue} job(s) overdue by more than a lease`);
  if (stats.dead > 0) reasons.push(`${stats.dead} job(s) gave up`);

  return json({
    status,
    reasons,
    database: true,
    workers: workers.alive,
    queue: {
      queued: stats.queued,
      running: stats.running,
      due: stats.due,
      overdue: stats.overdue,
      dead: stats.dead,
      nextRunAt: stats.nextRunAt?.toISOString() ?? null,
    },
    campaigns: byStatus,
    checkedInMs: Date.now() - startedAt,
    at: new Date().toISOString(),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // A monitor polling a cached answer is a monitor that cannot see an
      // outage.
      "cache-control": "no-store",
    },
  });
}
