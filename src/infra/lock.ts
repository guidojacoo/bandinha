import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

/**
 * A lock, so two instances cannot double-send.
 *
 * The single most expensive thing that can go wrong when nobody is watching.
 * A cron entry that fires every ten minutes against a tick that occasionally
 * takes twelve will overlap, and two overlapping ticks both read "sent today:
 * 4", both decide there is room, and both send — so the daily cap, the
 * per-domain cap and the anti-pester gap are all quietly doubled. Every one of
 * those is a deliberate protection, and they are worth nothing if a second
 * process can walk past them.
 *
 * A file rather than a database row, deliberately: the tick that needs
 * excluding includes the part where the database is being migrated or is
 * unreachable, and a lock that depends on the thing it is protecting is not a
 * lock. `writeFile` with the exclusive flag is atomic on every platform this
 * runs on.
 *
 * Stale locks are the other half of the problem. A process killed mid-tick
 * leaves its lock behind, and a tool that then refuses to run until somebody
 * deletes a file by hand is a tool that stops silently. So a lock carries its
 * owner and its heartbeat, and one that has stopped breathing is taken over.
 */

/**
 * Read at call time, not at module scope.
 *
 * The same mistake as reading the LLM endpoint once at import: a module-scope
 * `process.env` read cannot be changed afterwards, which makes the thing
 * untestable and, more to the point, makes it impossible to run two
 * independently-configured agents in one process.
 */
function lockDir(): string {
  return process.env.LOCK_DIR ?? "./data/locks";
}

/** A lock older than this with no heartbeat is assumed dead. */
function staleAfterMs(): number {
  const configured = Number(process.env.LOCK_STALE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 15 * 60_000;
}

interface LockFile {
  /**
   * Who holds this lock, uniquely.
   *
   * A token rather than the pid, which was the first version and is wrong:
   * two locks taken in the same process share a pid, so a holder that had
   * already lost its lock to a takeover could not tell, and its next
   * heartbeat stamped its own claim back over the new holder's. The pid and
   * host stay, for the message a human reads.
   */
  token: string;
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
  label: string;
}

export interface Lock {
  /** Call periodically during long work, so the lock is not judged stale. */
  beat(): Promise<void>;
  release(): Promise<void>;
}

export type LockResult =
  | { ok: true; lock: Lock }
  | { ok: false; heldBy: string; since: Date };

export async function acquire(name: string, label = "tick"): Promise<LockResult> {
  // Leading dots stripped as well as path separators: a name is a label, not
  // a path, and `..` has no business reaching `join`.
  const safe = name.replace(/[^\w.-]/g, "_").replace(/^\.+/, "") || "lock";
  const path = join(lockDir(), `${safe}.lock`);
  await mkdir(dirname(path), { recursive: true });

  const mine: LockFile = {
    token: randomUUID(),
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    label,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" fails if the file exists, atomically. The check-then-write that
      // would otherwise be written here has a window two processes can both
      // pass through.
      await writeFile(path, JSON.stringify(mine, null, 2), { encoding: "utf8", flag: "wx" });
      return { ok: true, lock: makeLock(path, mine) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const existing = await read(path);
      if (!existing) {
        // Unreadable or truncated: a process died mid-write. Take it.
        await rm(path, { force: true });
        continue;
      }

      const age = Date.now() - Date.parse(existing.heartbeatAt);
      if (Number.isFinite(age) && age < staleAfterMs()) {
        return {
          ok: false,
          heldBy: `${existing.label} (pid ${existing.pid} on ${existing.host})`,
          since: new Date(existing.startedAt),
        };
      }

      // Stale. Taking it over rather than refusing, because a tool that stops
      // until a human deletes a file is a tool that stops silently.
      await rm(path, { force: true });
    }
  }

  return { ok: false, heldBy: "another process that keeps retaking the lock", since: new Date() };
}

function makeLock(path: string, mine: LockFile): Lock {
  let released = false;
  return {
    async beat() {
      if (released) return;
      // Re-read before writing: if another process took the lock over
      // because we looked stale, we must not stamp our heartbeat onto theirs.
      const current = await read(path);
      if (!current || current.token !== mine.token) {
        released = true;
        return;
      }
      await writeFile(path, JSON.stringify({ ...mine, heartbeatAt: new Date().toISOString() }, null, 2), "utf8");
    },
    async release() {
      if (released) return;
      released = true;
      const current = await read(path);
      // Only release a lock that is still ours. Releasing one a takeover has
      // already handed to somebody else would let a third process in.
      if (!current || current.token === mine.token) await rm(path, { force: true });
    },
  };
}

async function read(path: string): Promise<LockFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as LockFile;
    // A file without a token is from an older version, or half-written.
    // Either way it cannot be reasoned about, so it is treated as dead.
    return typeof parsed?.token === "string" && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Who holds a lock, without taking it.
 *
 * For a health check, which must be able to say "a tick is running right
 * now" without becoming the thing that stops it. `acquire` would have taken
 * the lock to find out, which is the wrong answer to a read-only question.
 */
export async function peek(name: string): Promise<{ held: boolean; by?: string; since?: Date; stale?: boolean }> {
  const safe = name.replace(/[^\w.-]/g, "_").replace(/^\.+/, "") || "lock";
  const existing = await read(join(lockDir(), `${safe}.lock`));
  if (!existing) return { held: false };

  const age = Date.now() - Date.parse(existing.heartbeatAt);
  const stale = !Number.isFinite(age) || age >= staleAfterMs();
  return {
    held: !stale,
    by: `${existing.label} (pid ${existing.pid} on ${existing.host})`,
    since: new Date(existing.startedAt),
    stale,
  };
}

/** Runs `work` under a lock, or returns why it could not. */
export async function withLock<T>(
  name: string,
  label: string,
  work: (lock: Lock) => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false; heldBy: string; since: Date }> {
  const acquired = await acquire(name, label);
  if (!acquired.ok) return { ran: false, heldBy: acquired.heldBy, since: acquired.since };

  const beat = setInterval(() => void acquired.lock.beat().catch(() => {}), 60_000);
  try {
    return { ran: true, result: await work(acquired.lock) };
  } finally {
    clearInterval(beat);
    await acquired.lock.release().catch(() => {});
  }
}
