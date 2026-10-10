import { describe, expect, it } from "vitest";
import {
  BOUNCE_HALT, BOUNCE_WARN, COMPLAINT_HALT, MIN_SAMPLE, blocksReplies,
  describeRate, percent, warmupVerdict, type SendingHistory,
} from "../src/core/warmup";

function history(over: Partial<SendingHistory> = {}): SendingHistory {
  return { daysSending: 40, totalSent: 500, totalBounced: 2, totalComplained: 0, sentToday: 0, ...over };
}

/**
 * The warmup exists because the damage it prevents is invisible for weeks. By
 * the time a reply rate drops, the mail has been going to spam for a
 * fortnight and the only fix is a new domain.
 */
describe("the ramp", () => {
  it("starts at a handful on day one, whatever the cap is set to", () => {
    expect(warmupVerdict(30, history({ daysSending: 0 })).dailyCap).toBe(4);
    expect(warmupVerdict(200, history({ daysSending: 0 })).dailyCap).toBe(30);
  });

  it("never goes below a usable floor, even for a tiny cap", () => {
    // 15% of 10 is one. An operator who sets 10 should still get going.
    expect(warmupVerdict(10, history({ daysSending: 0 })).dailyCap).toBe(3);
  });

  it("climbs over four weeks and then stops climbing", () => {
    const caps = [0, 3, 7, 14, 21, 28, 60].map(
      (daysSending) => warmupVerdict(100, history({ daysSending })).dailyCap,
    );
    expect(caps).toEqual([15, 25, 40, 60, 80, 100, 100]);
    // Monotonic: the ramp never takes volume away as the domain ages.
    expect([...caps].sort((a, b) => a - b)).toEqual(caps);
  });

  it("never exceeds what the operator configured", () => {
    for (const daysSending of [0, 10, 30, 365]) {
      expect(warmupVerdict(25, history({ daysSending })).dailyCap).toBeLessThanOrEqual(25);
    }
  });

  it("names the stage and explains itself", () => {
    expect(warmupVerdict(30, history({ daysSending: 1 })).stage).toBe("first_week");
    expect(warmupVerdict(30, history({ daysSending: 10 })).stage).toBe("ramping");
    expect(warmupVerdict(30, history({ daysSending: 40 })).stage).toBe("warm");
    for (const daysSending of [1, 10, 40]) {
      expect(warmupVerdict(30, history({ daysSending })).reason.length).toBeGreaterThan(40);
    }
  });

  it("reports what is left today, not just the cap", () => {
    const verdict = warmupVerdict(30, history({ sentToday: 28 }));
    expect(verdict.dailyCap).toBe(30);
    expect(verdict.remainingToday).toBe(2);
  });

  it("does not go negative when the cap was lowered mid-day", () => {
    expect(warmupVerdict(10, history({ sentToday: 40 })).remainingToday).toBe(0);
  });
});

describe("throttling on the signals that matter", () => {
  it("halves volume and holds the ramp when bounces pass the warning line", () => {
    const verdict = warmupVerdict(100, history({ totalSent: 400, totalBounced: 12 }));
    expect(verdict.stage).toBe("throttled");
    expect(verdict.dailyCap).toBe(50);
    expect(verdict.reason).toMatch(/3\.0% bouncing/);
  });

  it("stops entirely when bounces pass the ceiling", () => {
    const verdict = warmupVerdict(100, history({ totalSent: 400, totalBounced: 30 }));
    expect(verdict.stage).toBe("halted");
    expect(verdict.dailyCap).toBe(0);
    expect(verdict.remainingToday).toBe(0);
    expect(verdict.reason).toMatch(/purchased list/);
  });

  it("stops at Gmail's published complaint threshold", () => {
    // 0.3% is the one number in deliverability that is not folklore.
    const verdict = warmupVerdict(100, history({ totalSent: 1_000, totalComplained: 3 }));
    expect(verdict.stage).toBe("halted");
    expect(verdict.complaintRate).toBeCloseTo(COMPLAINT_HALT, 6);
  });

  it("throttles on complaints before they reach the ceiling", () => {
    const verdict = warmupVerdict(100, history({ totalSent: 1_000, totalComplained: 2 }));
    expect(verdict.stage).toBe("throttled");
    expect(verdict.reason).toMatch(/complaining/);
  });

  it("ignores a rate computed from too few sends", () => {
    // One bounce out of three is 33% and means nothing. Acting on it would
    // halt a campaign on its first morning.
    const verdict = warmupVerdict(30, history({ totalSent: 3, totalBounced: 1, daysSending: 0 }));
    expect(verdict.stage).toBe("first_week");
    expect(verdict.dailyCap).toBeGreaterThan(0);
  });

  it("acts as soon as there is a real sample", () => {
    const verdict = warmupVerdict(30, history({ totalSent: MIN_SAMPLE, totalBounced: MIN_SAMPLE }));
    expect(verdict.stage).toBe("halted");
  });

  it("throttles a warming domain too, rather than only a warm one", () => {
    // A domain doing damage on day three is the worst case, not an exempt one.
    const verdict = warmupVerdict(100, history({ daysSending: 3, totalSent: 100, totalBounced: 4 }));
    expect(verdict.stage).toBe("throttled");
    expect(verdict.dailyCap).toBeLessThan(warmupVerdict(100, history({ daysSending: 3 })).dailyCap);
  });

  it("recovers when the rates come back down", () => {
    const bad = warmupVerdict(100, history({ totalSent: 400, totalBounced: 12 }));
    const better = warmupVerdict(100, history({ totalSent: 900, totalBounced: 12 }));
    expect(bad.stage).toBe("throttled");
    expect(better.stage).toBe("warm");
  });

  it("reports both rates whatever the verdict", () => {
    const verdict = warmupVerdict(30, history({ totalSent: 200, totalBounced: 1, totalComplained: 1 }));
    expect(verdict.bounceRate).toBeCloseTo(0.005, 6);
    expect(verdict.complaintRate).toBeCloseTo(0.005, 6);
  });

  it("handles a domain that has never sent anything", () => {
    const verdict = warmupVerdict(30, { daysSending: 0, totalSent: 0, totalBounced: 0, totalComplained: 0, sentToday: 0 });
    expect(verdict.bounceRate).toBe(0);
    expect(verdict.dailyCap).toBeGreaterThan(0);
  });
});

describe("the thresholds themselves", () => {
  it("warns well before it halts", () => {
    expect(BOUNCE_WARN).toBeLessThan(BOUNCE_HALT);
  });
});

describe("replies are never blocked by a warmup verdict", () => {
  it.each(["halted", "throttled"] as const)("not even when %s", (stage) => {
    const verdict = warmupVerdict(100, history({ totalSent: 500, totalBounced: stage === "halted" ? 50 : 12 }));
    expect(verdict.stage).toBe(stage);
    // A halt is about not sending unwanted mail to strangers. Somebody who
    // wrote to us and is waiting is the opposite case.
    expect(blocksReplies(verdict)).toBe(false);
  });
});

describe("percent", () => {
  it("keeps the precision small rates need", () => {
    expect(percent(0)).toBe("0%");
    expect(percent(0.003)).toBe("0.30%");
    expect(percent(0.05)).toBe("5.0%");
  });
});

describe("describeRate", () => {
  it("marks a rate computed from too few sends", () => {
    // "25% complaining" on a sample of four is arithmetically correct and
    // completely misleading. The policy already ignores it; the display has
    // to say so too, or the operator panics at a number the agent is rightly
    // disregarding.
    expect(describeRate(0.25, false)).toBe("25.0% (too few sent to judge)");
    expect(describeRate(0.25, true)).toBe("25.0%");
  });
});

describe("the verdict says whether its rates are trustworthy", () => {
  it("is unsampled on a handful of sends", () => {
    expect(warmupVerdict(30, history({ totalSent: 4, totalComplained: 1 })).sampled).toBe(false);
  });

  it("is sampled once there is enough to judge", () => {
    expect(warmupVerdict(30, history({ totalSent: 200 })).sampled).toBe(true);
  });
});
