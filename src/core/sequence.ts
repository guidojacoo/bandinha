import type {
  EnrollmentSnapshot,
  EnrollmentState,
  ReplyIntent,
  Sequence,
  SequenceStep,
} from "./types";

/**
 * The cadence engine.
 *
 * A pure reducer over enrollment state plus a due-date calculator. Keeping it
 * free of IO means the awkward cases — a reply arriving between two scheduled
 * touches, an unsubscribe on a finished sequence, a bounce on step one — are
 * exhaustively testable instead of being discovered in production by a
 * prospect who got mailed after asking not to be.
 */

export const DEFAULT_SEQUENCE: Sequence = {
  name: "Standard 4-touch",
  steps: [
    { index: 0, kind: "email", delayDays: 0, intent: "first_touch" },
    { index: 1, kind: "email", delayDays: 3, intent: "value_add" },
    { index: 2, kind: "email", delayDays: 4, intent: "social_proof" },
    { index: 3, kind: "email", delayDays: 6, intent: "breakup" },
  ],
};

/**
 * A shorter, gentler cadence for shared role inboxes (info@, hello@).
 *
 * A generic inbox is read by someone who did not choose to hear from us, so it
 * gets two touches rather than four.
 */
export const ROLE_INBOX_SEQUENCE: Sequence = {
  name: "Role inbox 2-touch",
  steps: [
    { index: 0, kind: "email", delayDays: 0, intent: "first_touch" },
    { index: 1, kind: "email", delayDays: 5, intent: "breakup" },
  ],
};

// ---------------------------------------------------------------------------
// Business-day arithmetic
// ---------------------------------------------------------------------------

const WEEKEND = new Set([0, 6]); // Sunday, Saturday

export function isBusinessDay(date: Date): boolean {
  return !WEEKEND.has(date.getUTCDay());
}

/**
 * Adds whole business days, preserving the time of day.
 *
 * `addBusinessDays(friday, 1)` is Monday; a zero-day delay still skips forward
 * off a weekend, because a cadence step that lands on Saturday should not be
 * sent on Saturday.
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

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export function stepAt(sequence: Sequence, index: number): SequenceStep | undefined {
  return sequence.steps[index];
}

export function isTerminal(state: EnrollmentState): boolean {
  return (
    state === "won" ||
    state === "lost" ||
    state === "unsubscribed" ||
    state === "bounced" ||
    state === "exhausted"
  );
}

/** States in which the cadence is paused pending a human or the prospect. */
export function isPaused(state: EnrollmentState): boolean {
  return state === "replied" || state === "meeting";
}

/**
 * When the next cadence step becomes due, or null if none ever will.
 *
 * Returns null for terminal and paused states — a prospect who replied must
 * never be dripped at again by the cadence; the conversation engine owns them
 * from that point on.
 */
export function nextDueAt(
  enrollment: EnrollmentSnapshot,
  sequence: Sequence,
  enrolledAt: Date,
): Date | null {
  if (isTerminal(enrollment.state) || isPaused(enrollment.state)) return null;

  const step = stepAt(sequence, enrollment.nextStepIndex);
  if (!step) return null;

  const anchor = enrollment.lastSentAt ?? enrolledAt;
  return addBusinessDays(anchor, step.delayDays);
}

export function isDue(
  enrollment: EnrollmentSnapshot,
  sequence: Sequence,
  enrolledAt: Date,
  now: Date,
): boolean {
  const due = nextDueAt(enrollment, sequence, enrolledAt);
  return due !== null && due.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type EnrollmentEvent =
  | { type: "sent"; at: Date }
  | { type: "replied"; at: Date; intent: ReplyIntent }
  | { type: "meeting_booked"; at: Date }
  | { type: "won"; at: Date }
  | { type: "lost"; at: Date }
  | { type: "bounced"; at: Date }
  | { type: "unsubscribed"; at: Date };

/**
 * Advances an enrollment. Total and pure: every (state, event) pair resolves.
 *
 * Unsubscribe and bounce are absorbing and win from any state, including
 * `won` — a customer who asks to stop hearing from us stops hearing from us.
 */
export function advance(
  current: EnrollmentSnapshot,
  event: EnrollmentEvent,
  sequence: Sequence,
): EnrollmentSnapshot {
  // Absorbing states that override everything.
  if (event.type === "unsubscribed") {
    return { ...current, state: "unsubscribed" };
  }
  if (event.type === "bounced") {
    return { ...current, state: "bounced" };
  }

  // Once genuinely finished, only an opt-out or a bounce can move it.
  if (current.state === "won" || current.state === "lost" || current.state === "unsubscribed" || current.state === "bounced") {
    return current;
  }

  switch (event.type) {
    case "sent": {
      const nextIndex = current.nextStepIndex + 1;
      const exhausted = nextIndex >= sequence.steps.length;
      // A send into a paused state is a human-authored reply, not a cadence
      // step: record the timestamp but do not advance the cadence pointer.
      if (isPaused(current.state)) {
        return { ...current, lastSentAt: event.at };
      }
      return {
        ...current,
        state: exhausted ? "exhausted" : "active",
        nextStepIndex: nextIndex,
        lastSentAt: event.at,
      };
    }

    case "replied": {
      if (event.intent === "unsubscribe") return { ...current, state: "unsubscribed", repliedAt: event.at };
      // A reply pauses the cadence even after it has run out of steps —
      // "exhausted" means we stopped chasing, not that the door is closed.
      return { ...current, state: "replied", repliedAt: event.at };
    }

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
