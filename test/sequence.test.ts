import { describe, expect, it } from "vitest";
import {
  addBusinessDays, advance, DEFAULT_SEQUENCE, initialEnrollment, isBusinessDay,
  isDue, nextDueAt, ROLE_INBOX_SEQUENCE,
} from "../src/core/sequence";
import type { EnrollmentSnapshot, EnrollmentState, ReplyIntent } from "../src/core/types";

const MON = new Date("2026-03-09T09:00:00Z");
const FRI = new Date("2026-03-13T09:00:00Z");
const SAT = new Date("2026-03-14T09:00:00Z");

describe("addBusinessDays", () => {
  it("skips the weekend", () => {
    expect(addBusinessDays(FRI, 1).toISOString()).toBe("2026-03-16T09:00:00.000Z");
    expect(addBusinessDays(FRI, 3).toISOString()).toBe("2026-03-18T09:00:00.000Z");
  });

  it("moves a zero-day delay off a weekend", () => {
    // A step due "immediately" on a Saturday must not be sent on Saturday.
    expect(isBusinessDay(addBusinessDays(SAT, 0))).toBe(true);
  });

  it("preserves the time of day", () => {
    expect(addBusinessDays(MON, 2).toISOString()).toBe("2026-03-11T09:00:00.000Z");
  });

  it("treats a negative delay as zero", () => {
    expect(addBusinessDays(MON, -5).toISOString()).toBe(MON.toISOString());
  });
});

describe("nextDueAt", () => {
  it("schedules the first touch immediately", () => {
    const due = nextDueAt(initialEnrollment(), DEFAULT_SEQUENCE, MON);
    expect(due?.toISOString()).toBe(MON.toISOString());
  });

  it("schedules later steps from the last send", () => {
    const enrollment: EnrollmentSnapshot = { state: "active", nextStepIndex: 1, lastSentAt: MON };
    expect(nextDueAt(enrollment, DEFAULT_SEQUENCE, MON)?.toISOString()).toBe("2026-03-12T09:00:00.000Z");
  });

  it("never schedules anything for a prospect who replied", () => {
    const replied: EnrollmentSnapshot = { state: "replied", nextStepIndex: 1, lastSentAt: MON, repliedAt: MON };
    expect(nextDueAt(replied, DEFAULT_SEQUENCE, MON)).toBeNull();
    expect(isDue(replied, DEFAULT_SEQUENCE, MON, new Date("2027-01-01T09:00:00Z"))).toBe(false);
  });

  it.each<EnrollmentState>(["won", "lost", "unsubscribed", "bounced", "exhausted", "meeting"])(
    "never schedules anything in state %s",
    (state) => {
      expect(nextDueAt({ state, nextStepIndex: 1, lastSentAt: MON }, DEFAULT_SEQUENCE, MON)).toBeNull();
    },
  );

  it("returns null when the sequence runs out", () => {
    const enrollment: EnrollmentSnapshot = { state: "active", nextStepIndex: 99, lastSentAt: MON };
    expect(nextDueAt(enrollment, DEFAULT_SEQUENCE, MON)).toBeNull();
  });

  it("gives a shared inbox a shorter cadence than a person", () => {
    expect(ROLE_INBOX_SEQUENCE.steps.length).toBeLessThan(DEFAULT_SEQUENCE.steps.length);
  });
});

describe("advance", () => {
  const sent = (e: EnrollmentSnapshot) => advance(e, { type: "sent", at: MON }, DEFAULT_SEQUENCE);

  it("walks the sequence and then exhausts it", () => {
    let e = initialEnrollment();
    for (let i = 0; i < DEFAULT_SEQUENCE.steps.length; i++) {
      e = sent(e);
      expect(e.nextStepIndex).toBe(i + 1);
    }
    expect(e.state).toBe("exhausted");
  });

  it("pauses on a reply, from any live state", () => {
    const replied = advance(sent(initialEnrollment()), { type: "replied", at: FRI, intent: "interested" }, DEFAULT_SEQUENCE);
    expect(replied.state).toBe("replied");
    expect(replied.repliedAt).toEqual(FRI);
  });

  it("reopens an exhausted sequence when they finally reply", () => {
    // "Exhausted" means we stopped chasing, not that the door is closed.
    const exhausted: EnrollmentSnapshot = { state: "exhausted", nextStepIndex: 4, lastSentAt: MON };
    expect(advance(exhausted, { type: "replied", at: FRI, intent: "interested" }, DEFAULT_SEQUENCE).state).toBe("replied");
  });

  it("records a conversational send without advancing the cadence", () => {
    const replied: EnrollmentSnapshot = { state: "replied", nextStepIndex: 2, repliedAt: MON };
    const after = advance(replied, { type: "sent", at: FRI }, DEFAULT_SEQUENCE);
    expect(after.state).toBe("replied");
    expect(after.nextStepIndex).toBe(2);
    expect(after.lastSentAt).toEqual(FRI);
  });

  it.each<EnrollmentState>(["pending", "active", "replied", "meeting", "won", "lost", "exhausted"])(
    "lets an unsubscribe win from state %s",
    (state) => {
      const after = advance({ state, nextStepIndex: 1 }, { type: "unsubscribed", at: FRI }, DEFAULT_SEQUENCE);
      expect(after.state).toBe("unsubscribed");
    },
  );

  it.each<EnrollmentState>(["pending", "active", "replied", "meeting", "won", "exhausted"])(
    "lets a bounce win from state %s",
    (state) => {
      expect(advance({ state, nextStepIndex: 1 }, { type: "bounced", at: FRI }, DEFAULT_SEQUENCE).state).toBe("bounced");
    },
  );

  it("treats an unsubscribe reply as an unsubscribe", () => {
    const after = advance(initialEnrollment(), { type: "replied", at: FRI, intent: "unsubscribe" }, DEFAULT_SEQUENCE);
    expect(after.state).toBe("unsubscribed");
  });

  it("holds terminal states against ordinary events", () => {
    // A won deal dragged back to an open stage by a stray reply re-closed
    // itself on every tick of the orchestrator.
    const won: EnrollmentSnapshot = { state: "won", nextStepIndex: 2, lastSentAt: MON };
    for (const event of [
      { type: "sent" as const, at: FRI },
      { type: "replied" as const, at: FRI, intent: "interested" as ReplyIntent },
      { type: "meeting_booked" as const, at: FRI },
      { type: "lost" as const, at: FRI },
    ]) {
      expect(advance(won, event, DEFAULT_SEQUENCE)).toEqual(won);
    }
  });

  it("is total: every state and event pair resolves", () => {
    const states: EnrollmentState[] = [
      "pending", "active", "replied", "meeting", "won", "lost",
      "unsubscribed", "bounced", "exhausted",
    ];
    const events = [
      { type: "sent" as const, at: FRI },
      { type: "replied" as const, at: FRI, intent: "interested" as ReplyIntent },
      { type: "meeting_booked" as const, at: FRI },
      { type: "won" as const, at: FRI },
      { type: "lost" as const, at: FRI },
      { type: "bounced" as const, at: FRI },
      { type: "unsubscribed" as const, at: FRI },
    ];
    for (const state of states) {
      for (const event of events) {
        const after = advance({ state, nextStepIndex: 1 }, event, DEFAULT_SEQUENCE);
        expect(states).toContain(after.state);
        expect(after.nextStepIndex).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
