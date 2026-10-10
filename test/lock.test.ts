import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquire, peek, withLock } from "../src/infra/lock";

/**
 * The lock exists because of one specific, expensive failure: a cron entry
 * firing every ten minutes against a tick that occasionally takes twelve.
 * Two overlapping ticks both read "sent today: 4", both decide there is room,
 * and the daily cap, the per-domain cap and the anti-pester gap are all
 * quietly doubled.
 */
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mercurio-lock-"));
  process.env.LOCK_DIR = dir;
  delete process.env.LOCK_STALE_MS;
});

afterEach(() => {
  delete process.env.LOCK_DIR;
  delete process.env.LOCK_STALE_MS;
});

describe("acquire", () => {
  it("grants a free lock", async () => {
    const result = await acquire("campaign-1");
    expect(result.ok).toBe(true);
    if (result.ok) await result.lock.release();
  });

  it("refuses a second holder while the first is alive", async () => {
    const first = await acquire("campaign-1", "tick A");
    expect(first.ok).toBe(true);

    const second = await acquire("campaign-1", "tick B");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.heldBy).toMatch(/tick A/);
      expect(second.heldBy).toMatch(/pid \d+/);
      expect(second.since).toBeInstanceOf(Date);
    }

    if (first.ok) await first.lock.release();
  });

  it("grants it again after release", async () => {
    const first = await acquire("campaign-1");
    if (first.ok) await first.lock.release();
    expect((await acquire("campaign-1")).ok).toBe(true);
  });

  it("keeps separate campaigns independent", async () => {
    const a = await acquire("campaign-a");
    const b = await acquire("campaign-b");
    expect(a.ok && b.ok).toBe(true);
  });

  it("takes over a lock whose holder has stopped breathing", async () => {
    // A process killed mid-tick leaves its lock behind. A tool that then
    // refuses to run until somebody deletes a file is a tool that stops
    // silently.
    writeFileSync(join(dir, "campaign-1.lock"), JSON.stringify({
      token: "a-token-from-a-dead-process", pid: 999_999,
      host: "a-machine-that-rebooted", label: "tick",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      heartbeatAt: new Date(Date.now() - 3_600_000).toISOString(),
    }));

    const result = await acquire("campaign-1");
    expect(result.ok).toBe(true);
    if (result.ok) await result.lock.release();
  });

  it("does not take over one that is still breathing", async () => {
    writeFileSync(join(dir, "campaign-1.lock"), JSON.stringify({
      token: "a-token-from-a-live-process", pid: 999_999,
      host: "elsewhere", label: "a long tick",
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      heartbeatAt: new Date().toISOString(),
    }));
    expect((await acquire("campaign-1")).ok).toBe(false);
  });

  it("takes over a lock file it cannot reason about", async () => {
    // A process that died mid-write leaves half a JSON document; a file from
    // an older version has no token. Neither can be reasoned about, so both
    // are treated as dead rather than blocking the agent forever.
    writeFileSync(join(dir, "campaign-1.lock"), '{"pid": 12');
    const result = await acquire("campaign-1");
    expect(result.ok).toBe(true);
    if (result.ok) await result.lock.release();
  });

  it("keeps a lock file inside the lock directory whatever the name", async () => {
    // A campaign id is a label, not a path. `..` has no business reaching
    // `join`, and a name that is all punctuation still has to produce a file.
    for (const name of ["../../etc/passwd", "..", "....//....//x", "   "]) {
      const result = await acquire(name);
      expect(result.ok, name).toBe(true);
      if (result.ok) {
        const written = readdirSync(dir);
        expect(written.length, name).toBe(1);
        expect(written[0]!.startsWith("."), name).toBe(false);
        await result.lock.release();
      }
    }
  });
});

describe("the heartbeat", () => {
  it("keeps a long-running lock alive", async () => {
    process.env.LOCK_STALE_MS = "50";
    const first = await acquire("campaign-1", "slow tick");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await new Promise((resolve) => setTimeout(resolve, 80));
    await first.lock.beat();

    // Beating resets the clock, so a contender still sees it as held.
    expect((await acquire("campaign-1")).ok).toBe(false);
    await first.lock.release();
  });

  it("takes over a lock file written by an older version with no token", async () => {
    writeFileSync(join(dir, "campaign-1.lock"), JSON.stringify({
      pid: process.pid, host: "here", label: "old format",
      startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
    }));
    const result = await acquire("campaign-1");
    expect(result.ok).toBe(true);
    if (result.ok) await result.lock.release();
  });

  it("does not stamp its heartbeat onto a lock somebody else took over", async () => {
    process.env.LOCK_STALE_MS = "10";
    const first = await acquire("campaign-1", "tick A");
    if (!first.ok) return;

    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await acquire("campaign-1", "tick B");
    expect(second.ok).toBe(true);

    // A beats, having lost the lock. It must not revive its own claim.
    await first.lock.beat();
    const onDisk = JSON.parse(readFileSync(join(dir, "campaign-1.lock"), "utf8"));
    expect(onDisk.label).toBe("tick B");

    // And A releasing must not delete B's lock.
    await first.lock.release();
    expect(() => readFileSync(join(dir, "campaign-1.lock"), "utf8")).not.toThrow();
    if (second.ok) await second.lock.release();
  });
});

describe("withLock", () => {
  it("runs the work and releases afterwards", async () => {
    const result = await withLock("campaign-1", "tick", async () => 42);
    expect(result).toEqual({ ran: true, result: 42 });
    expect((await acquire("campaign-1")).ok).toBe(true);
  });

  it("releases even when the work throws", async () => {
    await expect(withLock("campaign-1", "tick", async () => {
      throw new Error("tick failed");
    })).rejects.toThrow("tick failed");

    // The important part: a crashed tick does not lock the campaign out.
    expect((await acquire("campaign-1")).ok).toBe(true);
  });

  it("reports who holds it rather than queueing", async () => {
    const held = await acquire("campaign-1", "the first tick");
    const result = await withLock("campaign-1", "the second tick", async () => "should not run");

    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.heldBy).toMatch(/the first tick/);
    if (held.ok) await held.lock.release();
  });

  it("serialises two overlapping attempts rather than running both", async () => {
    // The exact cron-overlap case.
    let ran = 0;
    const slow = withLock("campaign-1", "tick A", async () => {
      ran++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "A";
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const overlapping = await withLock("campaign-1", "tick B", async () => {
      ran++;
      return "B";
    });

    expect(overlapping.ran).toBe(false);
    expect(await slow).toEqual({ ran: true, result: "A" });
    expect(ran).toBe(1);
  });
});

describe("peek", () => {
  it("reports nothing for a free lock", async () => {
    expect(await peek("campaign-1")).toEqual({ held: false });
  });

  it("reports the holder without taking the lock", async () => {
    const held = await acquire("campaign-1", "a running tick");
    const seen = await peek("campaign-1");

    expect(seen.held).toBe(true);
    expect(seen.by).toMatch(/a running tick/);
    expect(seen.since).toBeInstanceOf(Date);

    // The point: peeking did not become the thing that stops the tick.
    if (held.ok) {
      await held.lock.beat();
      await held.lock.release();
    }
  });

  it("reports a stale lock as stale rather than held", async () => {
    process.env.LOCK_STALE_MS = "10";
    const held = await acquire("campaign-1", "a dead tick");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const seen = await peek("campaign-1");
    expect(seen.held).toBe(false);
    expect(seen.stale).toBe(true);
    expect(seen.by).toMatch(/a dead tick/);

    if (held.ok) await held.lock.release();
  });
});
