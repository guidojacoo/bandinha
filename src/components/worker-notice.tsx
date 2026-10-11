import { queueStats } from "../infra/queue";
import { workersAlive } from "../agent/worker";

/**
 * "Is anything actually running?"
 *
 * The most confusing state this product can be in is a queue full of due work
 * and nothing to consume it. Every page looks healthy — campaigns running,
 * leads qualified, sends scheduled — and nothing ever happens, because the
 * worker was never started or died quietly. There is no way to infer it from
 * any other screen, so it gets said out loud, with the command to fix it.
 */
export async function WorkerNotice({ compact = false }: { compact?: boolean } = {}) {
  const [workers, stats] = await Promise.all([workersAlive(), queueStats()]);

  if (workers.alive > 0) {
    if (compact) return null;
    return (
      <div className="banner good">
        <strong>{workers.alive} worker{workers.alive === 1 ? "" : "s"} running.</strong>{" "}
        {stats.running > 0 ? `${stats.running} job${stats.running === 1 ? "" : "s"} in flight, ` : ""}
        {stats.queued} waiting. <a href="/queue">Queue</a>
      </div>
    );
  }

  const waiting = stats.queued + stats.running;
  if (waiting === 0 && stats.dead === 0) return null;

  return (
    <div className="banner warn">
      <strong>No worker is running.</strong> {waiting} job{waiting === 1 ? "" : "s"} waiting
      {stats.due > 0 ? `, ${stats.due} of them due now` : ""} — nothing will happen until something
      consumes the queue. Start one with <span className="mono">npm run worker</span>, or run{" "}
      <span className="mono">npm start</span>, which runs the console and a worker together.{" "}
      <a href="/queue">Queue</a>
    </div>
  );
}
