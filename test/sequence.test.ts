import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEQUENCE, ROLE_INBOX_SEQUENCE, addBusinessDays, advance, initialEnrollment,
  isBusinessDay, isDue, isPaused, isTerminal, nextDueAt,
} from "../src/core/sequence";
import type { EnrollmentSnapshot } from "../src/core/types";

const MON = new Date("2026-03-02T10:00:00Z");
const FRI = new Date("2026-03-06T10:00:00Z");

describe("business days", () => {
  it("knows weekends", () => {
    expect(isBusinessDay(MON)).toBe(true);
    expect(isBusinessDay(new Date("2026-03-07T10:00:00Z"))).toBe(false);
    expect(isBusinessDay(new Date("2026-03-08T10:00:00Z"))).toBe(false);
  });

  it("skips the weekend when adding days", () => {
    expect(addBusinessDays(FRI, 1).toISOString()).toContain("2026-03-09"); // Monday
    expect(addBusinessDays(FRI, 3).toISOString()).toContain("2026-03-11");
  });

  it("moves a zero-day delay off a weekend", () => {
    // A step due "immediately" on a Saturday must not go out on Saturday.
    const sat = new Date("2026-03-07T10:00:00Z");
    expect(isBusinessDay(addBusinessDays(sat, 0))).toBe(true);
  });

  it("preserves the time of day", () => {
    expect(addBusinessDays(MON, 2).getUTCHours()).toBe(10);
  });
});

describe("scheduling", () => {
  it("makes the first touch due immediately on enrollment", () => {
    const due = nextDueAt(initialEnrollment(), DEFAULT_SEQUENCE, MON);
    expect(due).not.toBeNull();
    expect(isDue(initialEnrollment(), DEFAULT_SEQUENCE, MON, MON)).toBe(true);
  });

  it("spaces later steps by their configured business-day delay", () => {
    const after1: EnrollmentSnapshot = { state: "active", nextStepIndex: 1, lastSentAt: MON };
    const due = nextDueAt(after1, DEFAULT_SEQUENCE, MON)!;
    expect(due.toISOString()).toContain("2026-03-05"); // Mon + 3 business days
    expect(isDue(after1, DEFAULT_SEQUENCE, MON, MON)).toBe(false);
  });

  /**
   * The rule that matters most: a prospect who replied must never receive
   * another cadence step. The conversation engine owns them from then on.
   */
  it("never schedules another cadence step once the prospect replied", () => {
    const replied: EnrollmentSnapshot = { state: "replied", nextStepIndex: 1, lastSentAt: MON, repliedAt: MON };
    expect(nextDueAt(replied, DEFAULT_SEQUENCE, MON)).toBeNull();
    expect(isDue(replied, DEFAULT_SEQUENCE, MON, new Date("2027-01-01"))).toBe(false);
  });

  it("schedules nothing for terminal states", () => {
    for (const state of ["won", "lost", "unsubscribed", "bounced", "exhausted"] as const) {
      expect(nextDueAt({ state, nextStepIndex: 1 }, DEFAULT_SEQUENCE, MON), state).toBeNull();
    }
  });

  it("schedules nothing past the end of the cadence", () => {
    const done: EnrollmentSnapshot = { state: "active", nextStepIndex: 99, lastSentAt: MON };
    expect(nextDueAt(done, DEFAULT_SEQUENCE, MON)).toBeNull();
  });

  it("gives role inboxes a shorter cadence than named contacts", () => {
    expect(ROLE_INBOX_SEQUENCE.steps.length).toBeLessThan(DEFAULT_SEQUENCE.steps.length);
  });
});

describe("advance", () => {
  it("walks the cadence and finishes as exhausted", () => {
    let e = initialEnrollment();
    for (let i = 0; i < DEFAULT_SEQUENCE.steps.length; i++) {
      e = advance(e, { type: "sent", at: MON }, DEFAULT_SEQUENCE);
    }
    expect(e.state).toBe("exhausted");
    expect(e.nextStepIndex).toBe(DEFAULT_SEQUENCE.steps.length);
    expect(isTerminal(e.state)).toBe(true);
  });

  it("pauses on a reply", () => {
    const e = advance(initialEnrollment(), { type: "replied", at: MON, intent: "interested" }, DEFAULT_SEQUENCE);
    expect(e.state).toBe("replied");
    expect(isPaused(e.state)).toBe(true);
  });

  it("treats an unsubscribe reply as an opt-out, not a pause", () => {
    const e = advance(initialEnrollment(), { type: "replied", at: MON, intent: "unsubscribe" }, DEFAULT_SEQUENCE);
    expect(e.state).toBe("unsubscribed");
  });

  it("lets an unsubscribe override every other state, including won", () => {
    for (const state of ["pending", "active", "replied", "meeting", "won", "exhausted"] as const) {
      const e = advance({ state, nextStepIndex: 1 }, { type: "unsubscribed", at: MON }, DEFAULT_SEQUENCE);
      expect(e.state, state).toBe("unsubscribed");
    }
  });

  it("lets a bounce override every other state", () => {
    for (const state of ["pending", "active", "replied", "won"] as const) {
      const e = advance({ state, nextStepIndex: 0 }, { type: "bounced", at: MON }, DEFAULT_SEQUENCE);
      expect(e.state, state).toBe("bounced");
    }
  });

  it("does not resurrect a closed enrollment", () => {
    const won: EnrollmentSnapshot = { state: "won", nextStepIndex: 2 };
    expect(advance(won, { type: "sent", at: MON }, DEFAULT_SEQUENCE).state).toBe("won");
    expect(advance(won, { type: "replied", at: MON, intent: "interested" }, DEFAULT_SEQUENCE).state).toBe("won");
  });

  /**
   * A human (or the conversation engine) replying to an engaged prospect must
   * not silently consume a cadence step — otherwise answering two questions
   * burns the rest of the sequence.
   */
  it("records a send during a paused state without advancing the cadence", () => {
    const replied: EnrollmentSnapshot = { state: "replied", nextStepIndex: 1, repliedAt: MON };
    const after = advance(replied, { type: "sent", at: FRI }, DEFAULT_SEQUENCE);
    expect(after.state).toBe("replied");
    expect(after.nextStepIndex).toBe(1);
    expect(after.lastSentAt).toEqual(FRI);
  });

  it("moves through meeting to won", () => {
    let e = advance(initialEnrollment(), { type: "replied", at: MON, intent: "meeting_request" }, DEFAULT_SEQUENCE);
    e = advance(e, { type: "meeting_booked", at: MON }, DEFAULT_SEQUENCE);
    expect(e.state).toBe("meeting");
    e = advance(e, { type: "won", at: FRI }, DEFAULT_SEQUENCE);
    expect(e.state).toBe("won");
  });

  it("accepts a reply after the cadence is exhausted", () => {
    const e = advance({ state: "exhausted", nextStepIndex: 4 }, { type: "replied", at: MON, intent: "interested" }, DEFAULT_SEQUENCE);
    expect(e.state).toBe("replied");
  });
});
