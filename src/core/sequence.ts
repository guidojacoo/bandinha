import type { EnrollmentSnapshot, EnrollmentState, ReplyIntent, Sequence, SequenceStep } from "./types";

/**
 * The cadence engine: a pure reducer plus a due-date calculator.
 *
 * Keeping it free of IO means the awkward cases — a reply arriving between
 * two scheduled touches, an unsubscribe on a finished sequence, a bounce on
 * step one — are exhaustively testable, rather than discovered in production
 * by a prospect who got mailed after asking not to be.
 */

export const DEFAULT_SEQUENCE: Sequence = {
  name: "Standard 4-touch",
  steps: [
    { index: 0, delayDays: 0, intent: "first_touch" },
    { index: 1, delayDays: 3, intent: "value_add" },
    { index: 2, delayDays: 4, intent: "social_proof" },
    { index: 3, delayDays: 6, intent: "breakup" },
  ],
};

/** A shared inbox is read by someone who did not choose to hear from us. */
export const ROLE_INBOX_SEQUENCE: Sequence = {
  name: "Role inbox 2-touch",
  steps: [
    { index: 0, delayDays: 0, intent: "first_touch" },
    { index: 1, delayDays: 5, intent: "breakup" },
  ],
};

const WEEKEND = new Set([0, 6]);

export function isBusinessDay(date: Date): boolean {
  return !WEEKEND.has(date.getUTCDay());
}

/**
 * Adds whole business days, preserving the time of day. A zero-day delay
 * still moves off a weekend — a step due "immediately" on a Saturday must
 * not be sent on Saturday.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const out = new Date(from.getTime());
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    if (isBusinessDay(out)) remaining -= 1;
  }
  while (!isBusinessDay(out)) out.setUTCDate(out.getUTCDate() + 1);
  return out;
}

export function isTerminal(state: EnrollmentState): boolean {
  return ["won", "lost", "unsubscribed", "bounced", "exhausted"].includes(state);
}

export function isPaused(state: EnrollmentState): boolean {
  return state === "replied" || state === "meeting";
}

export function stepAt(sequence: Sequence, index: number): SequenceStep | undefined {
  return sequence.steps[index];
}

/**
 * When the next cadence step is due, or null if none ever will be.
 *
 * Null for terminal *and* paused states: a prospect who replied must never
 * be dripped at again by the cadence. The conversation engine owns them.
 */
export function nextDueAt(enrollment: EnrollmentSnapshot, sequence: Sequence, enrolledAt: Date): Date | null {
  if (isTerminal(enrollment.state) || isPaused(enrollment.state)) return null;
  const step = stepAt(sequence, enrollment.nextStepIndex);
  if (!step) return null;
  return addBusinessDays(enrollment.lastSentAt ?? enrolledAt, step.delayDays);
}

export function isDue(enrollment: EnrollmentSnapshot, sequence: Sequence, enrolledAt: Date, now: Date): boolean {
  const due = nextDueAt(enrollment, sequence, enrolledAt);
  return due !== null && due.getTime() <= now.getTime();
}

export type EnrollmentEvent =
  | { type: "sent"; at: Date }
  | { type: "replied"; at: Date; intent: ReplyIntent }
  | { type: "meeting_booked"; at: Date }
  | { type: "won"; at: Date }
  | { type: "lost"; at: Date }
  | { type: "bounced"; at: Date }
  | { type: "unsubscribed"; at: Date };

/**
 * Total and pure: every (state, event) pair resolves.
 *
 * Unsubscribe and bounce are absorbing and win from any state, including
 * `won` — a customer who asks to stop hearing from us stops hearing from us.
 */
export function advance(current: EnrollmentSnapshot, event: EnrollmentEvent, sequence: Sequence): EnrollmentSnapshot {
  if (event.type === "unsubscribed") return { ...current, state: "unsubscribed" };
  if (event.type === "bounced") return { ...current, state: "bounced" };

  if (["won", "lost", "unsubscribed", "bounced"].includes(current.state)) return current;

  switch (event.type) {
    case "sent": {
      // A send into a paused state is a human-authored or conversational
      // reply, not a cadence step: record the time, do not advance the pointer.
      if (isPaused(current.state)) return { ...current, lastSentAt: event.at };
      const nextIndex = current.nextStepIndex + 1;
      return {
        ...current,
        state: nextIndex >= sequence.steps.length ? "exhausted" : "active",
        nextStepIndex: nextIndex,
        lastSentAt: event.at,
      };
    }
    case "replied":
      if (event.intent === "unsubscribe") return { ...current, state: "unsubscribed", repliedAt: event.at };
      // A reply pauses the cadence even after it ran out of steps —
      // "exhausted" means we stopped chasing, not that the door is closed.
      return { ...current, state: "replied", repliedAt: event.at };
    case "meeting_booked":
      return { ...current, state: "meeting", repliedAt: current.repliedAt ?? event.at };
    case "won":
      return { ...current, state: "won" };
    case "lost":
      return { ...current, state: "lost" };
  }
}

export function initialEnrollment(): EnrollmentSnapshot {
  return { state: "pending", nextStepIndex: 0 };
}
