import { redirect } from "next/navigation";
import { db } from "../../infra/db";
import { readSession } from "../../lib/auth";
import { liveWorkers, queueStats } from "../../infra/queue";
import { DEFAULT_QUEUE_POLICY } from "../../core/queue";
import { reviveJob, runTick } from "../actions";
import { Empty, Metric, Pill, SectionHead, ago } from "../../components/ui";
import { fromJson } from "../../lib/json";

export const dynamic = "force-dynamic";

/**
 * The queue.
 *
 * The page that answers "why has nothing happened?", which is the only
 * question an unattended system really has to be able to answer about itself.
 * Three things are visible here and nowhere else: whether a worker is alive,
 * what each campaign's next tick is waiting for, and what gave up.
 */

const STATUS_TONE: Record<string, "good" | "warn" | "bad" | "info" | "neutral"> = {
  queued: "info",
  running: "good",
  done: "neutral",
  dead: "bad",
};

/** "in 4m", for work that is scheduled rather than late. */
function until(date: Date): string {
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/** What a finished tick recorded, as a sentence rather than a JSON blob. */
function describeResult(raw: string | null): string {
  const result = fromJson<Record<string, unknown>>(raw, {});
  const parts: string[] = [];
  const say = (key: string, label: string) => {
    const value = Number(result[key] ?? 0);
    if (value > 0) parts.push(`${value} ${label}`);
  };
  say("repliesRead", "read");
  say("answered", "answered");
  say("discovered", "discovered");
  say("qualified", "qualified");
  say("enrolled", "enrolled");
  say("sent", "sent");
  say("blocked", "blocked");
  say("failed", "failed");
  if (typeof result.skipped === "string") parts.push(String(result.skipped));
  if (typeof result.pages === "number") parts.push(`${result.pages} page(s) read`);
  return parts.length > 0 ? parts.join(", ") : "nothing to do";
}

export default async function QueuePage() {
  let session: Awaited<ReturnType<typeof readSession>> = null;
  try {
    session = await readSession();
  } catch {
    redirect("/login");
  }
  if (!session) redirect("/login");

  const [stats, workers, jobs, dead] = await Promise.all([
    queueStats(),
    liveWorkers(),
    // Scoped to this operator's campaigns. The queue is shared infrastructure;
    // what is in it is not.
    db.job.findMany({
      where: { campaign: { userId: session.userId }, status: { in: ["queued", "running"] } },
      orderBy: [{ status: "asc" }, { runAt: "asc" }],
      take: 50,
      include: { campaign: { select: { id: true, name: true, status: true } } },
    }),
    db.job.findMany({
      where: { campaign: { userId: session.userId }, status: "dead" },
      orderBy: { finishedAt: "desc" },
      take: 20,
      include: { campaign: { select: { id: true, name: true } } },
    }),
  ]);

  const recent = await db.job.findMany({
    where: { campaign: { userId: session.userId }, status: "done" },
    orderBy: { finishedAt: "desc" },
    take: 20,
    include: { campaign: { select: { id: true, name: true } } },
  });

  const starved = workers.length === 0 && stats.queued + stats.running > 0;

  return (
    <main>
      <h1>Queue</h1>
      <p className="lede">
        Work is a row, and a worker claims it. That is what lets you run a second worker, or a tenth
        on a tenth machine: the right to do a piece of work is held by the data, not by a process. A
        campaign has exactly one tick row for its whole life, so nothing here can run twice.
      </p>

      {starved && (
        <div className="banner warn">
          <strong>No worker is running.</strong> Nothing in this queue will move until one is. Start
          one with <span className="mono">npm run worker</span>, or <span className="mono">npm start</span>,
          which runs the console and a worker together.
        </div>
      )}
      {stats.overdue > 0 && !starved && (
        <div className="banner warn">
          <strong>{stats.overdue} job(s) overdue by more than a lease.</strong> Something is claiming
          work and not finishing it, or the workers cannot reach the database.
        </div>
      )}

      <section>
        <div className="grid cols-4">
          <Metric
            value={workers.length}
            label="Workers alive"
            tone={workers.length > 0 ? "good" : "warn"}
            hint={workers.length > 0 ? "heartbeat within two leases" : "npm run worker"}
          />
          <Metric value={stats.queued} label="Waiting" hint={stats.due > 0 ? `${stats.due} due now` : "all scheduled"} />
          <Metric value={stats.running} label="In flight" tone={stats.running > 0 ? "good" : undefined} />
          <Metric
            value={stats.dead}
            label="Gave up"
            tone={stats.dead > 0 ? "bad" : undefined}
            hint={stats.dead > 0 ? "retried until the allowance ran out" : "nothing"}
          />
        </div>
      </section>

      <section>
        <SectionHead
          title="Workers"
          note={<span className="dim">a worker is believed alive while its heartbeat is younger than two leases ({Math.round(DEFAULT_QUEUE_POLICY.leaseMs / 60_000) * 2}m)</span>}
        />
        {workers.length === 0 ? (
          <Empty>
            Nothing is consuming the queue. <span className="mono">npm run worker</span> starts one;
            <span className="mono"> npm run worker -- --concurrency 4</span> starts one that does four
            jobs at a time. They can run on as many machines as you like.
          </Empty>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Worker</th>
                  <th className="num">At once</th>
                  <th className="num">Claimed</th>
                  <th className="num">Done</th>
                  <th className="num">Failed</th>
                  <th>Up for</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((worker) => (
                  <tr key={worker.id}>
                    <td className="mono">{worker.id}</td>
                    <td className="num">{worker.concurrency}</td>
                    <td className="num">{worker.claimed}</td>
                    <td className="num">{worker.done}</td>
                    <td className="num">{worker.failed > 0 ? <span style={{ color: "var(--warn)" }}>{worker.failed}</span> : 0}</td>
                    <td className="dim nowrap">{ago(worker.startedAt)}</td>
                    <td className="dim nowrap">{ago(worker.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <SectionHead title="Waiting and in flight" note={<span className="dim">{jobs.length} shown</span>} />
        {jobs.length === 0 ? (
          <Empty>
            Nothing queued. A running campaign always has a tick scheduled, so an empty queue with
            running campaigns means a worker has them in flight — or that every campaign is paused.
          </Empty>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Job</th>
                  <th>State</th>
                  <th>When</th>
                  <th className="num">Attempt</th>
                  <th>Last error</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      {job.campaign
                        ? (
                          <>
                            <a href={`/campaigns/${job.campaign.id}`} style={{ fontWeight: 560 }}>{job.campaign.name}</a>
                            {/* Two campaigns started from the same site have
                                the same name, and on this page they are
                                otherwise indistinguishable. */}
                            <span className="reason mono">{job.campaign.id}</span>
                          </>
                        )
                        : <span className="dim">—</span>}
                    </td>
                    <td className="mono">{job.kind}</td>
                    <td><Pill tone={STATUS_TONE[job.status] ?? "neutral"} dot>{job.status}</Pill></td>
                    <td className="dim nowrap">
                      {job.status === "running"
                        ? `claimed ${ago(job.startedAt ?? job.updatedAt)}`
                        : until(job.runAt)}
                    </td>
                    <td className="num">{job.attempts} / {job.maxAttempts}</td>
                    <td className="reason mono">{job.lastError ?? ""}</td>
                    <td>
                      {job.status === "queued" && job.campaign && (
                        <form action={runTick}>
                          <input type="hidden" name="campaignId" value={job.campaign.id} />
                          <button className="ghost" type="submit">Run now</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dead.length > 0 && (
        <section>
          <SectionHead
            title="Gave up"
            note={<span className="dim">retried with backoff until the allowance ran out</span>}
          />
          <div className="banner">
            A job here has stopped costing anything and started being visible, which is the point of a
            dead letter. The campaign is tried again an hour after a job dies — a campaign that stays
            stopped until somebody notices is worse than one that retries slowly — so this list is
            where you look for the cause, not a queue you have to drain by hand.
          </div>
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Job</th>
                  <th className="num">Attempts</th>
                  <th>Gave up</th>
                  <th>Why</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dead.map((job) => (
                  <tr key={job.id}>
                    <td>
                      {job.campaign
                        ? <a href={`/campaigns/${job.campaign.id}`}>{job.campaign.name}</a>
                        : <span className="dim">—</span>}
                    </td>
                    <td className="mono">{job.kind}</td>
                    <td className="num">{job.attempts}</td>
                    <td className="dim nowrap">{job.finishedAt ? ago(job.finishedAt) : "—"}</td>
                    <td className="reason mono">{job.lastError ?? ""}</td>
                    <td>
                      <form action={reviveJob}>
                        <input type="hidden" name="jobId" value={job.id} />
                        <button className="ghost" type="submit">Try again</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <SectionHead title="Finished" note={<span className="dim">kept for {Number(process.env.JOB_RETENTION_DAYS ?? 7)} days</span>} />
        {recent.length === 0 ? (
          <Empty>Nothing has finished yet.</Empty>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Job</th>
                  <th>Finished</th>
                  <th>What it did</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((job) => (
                  <tr key={job.id}>
                    <td>
                      {job.campaign
                        ? <a href={`/campaigns/${job.campaign.id}`}>{job.campaign.name}</a>
                        : <span className="dim">—</span>}
                    </td>
                    <td className="mono">{job.kind}</td>
                    <td className="dim nowrap">{job.finishedAt ? ago(job.finishedAt) : "—"}</td>
                    <td className="dim">{describeResult(job.result)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
