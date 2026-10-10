/**
 * Sending-reputation warmup.
 *
 * The one piece of this product that protects the thing everything else
 * depends on. A new sending domain that emits thirty messages on its first
 * day is a new sending domain with a damaged reputation, and the damage is
 * not visible for weeks — by the time the reply rate drops, the mail has been
 * going to spam for a fortnight and the only fix is a new domain.
 *
 * So the daily cap is not a constant. It ramps from a handful to whatever the
 * operator configured, over weeks, and it *un*-ramps the moment the two
 * signals that matter turn bad:
 *
 *  - **Bounces.** Receiving systems read a high bounce rate as evidence that
 *    the sender is working from a purchased list. Over roughly 2% is a
 *    warning; over 5% is a problem. The documented failure mode for this
 *    whole product category is 20-40%.
 *  - **Complaints.** Gmail's published threshold is 0.3% — three in a
 *    thousand — and it is the one number in deliverability that is not
 *    folklore, because Google states it.
 *
 * Everything here is pure arithmetic over counts the database already has, so
 * the policy is testable without sending anything.
 */

export interface SendingHistory {
  /** Days since the first message went out. Zero on the first day. */
  daysSending: number;
  /** Messages successfully handed to a transport, all time. */
  totalSent: number;
  /** Hard bounces, all time. */
  totalBounced: number;
  /** Opt-outs and complaints, all time. */
  totalComplained: number;
  /** Sent today, for the remaining-today figure. */
  sentToday: number;
}

export interface WarmupVerdict {
  /** Today's cap. Never above the configured one. */
  dailyCap: number;
  /** How many more may go out today. */
  remainingToday: number;
  /** Which phase of the ramp, for the console. */
  stage: "first_week" | "ramping" | "warm" | "throttled" | "halted";
  /** One line an operator can act on. */
  reason: string;
  bounceRate: number;
  complaintRate: number;
  /**
   * Whether enough has been sent for those two rates to mean anything.
   *
   * Exposed because the rates are shown to a human, and "25% complaining" on
   * a sample of four is both arithmetically correct and completely
   * misleading. The policy already ignores an unsampled rate; the display
   * has to say so too, or the operator panics at a number the agent is
   * rightly disregarding.
   */
  sampled: boolean;
}

/**
 * The ramp, in days-since-first-send to a fraction of the configured cap.
 *
 * Fractions rather than absolute numbers, so an operator who sets a cap of 10
 * gets a gentle ramp to 10 and one who sets 200 gets a gentle ramp to 200.
 * A fixed schedule in messages would be simultaneously too aggressive for the
 * first and pointlessly slow for the second.
 */
const RAMP: Array<{ afterDays: number; fraction: number }> = [
  { afterDays: 0, fraction: 0.15 },
  { afterDays: 3, fraction: 0.25 },
  { afterDays: 7, fraction: 0.4 },
  { afterDays: 14, fraction: 0.6 },
  { afterDays: 21, fraction: 0.8 },
  { afterDays: 28, fraction: 1 },
];

/** Below this many sent, a rate is noise and is not acted on. */
export const MIN_SAMPLE = 20;

/** Bounce rate at which the ramp stops advancing, and at which it stops. */
export const BOUNCE_WARN = 0.02;
export const BOUNCE_HALT = 0.05;

/** Gmail publishes 0.3%. Half of it is the point at which to worry. */
export const COMPLAINT_WARN = 0.0015;
export const COMPLAINT_HALT = 0.003;

/** The floor, so a ramp never reduces the cap to zero on day one. */
const MINIMUM_CAP = Number(process.env.WARMUP_MINIMUM_DAILY ?? 3);

export function warmupVerdict(configuredCap: number, history: SendingHistory): WarmupVerdict {
  const cap = Math.max(0, Math.floor(configuredCap));
  const bounceRate = rate(history.totalBounced, history.totalSent);
  const complaintRate = rate(history.totalComplained, history.totalSent);

  const fraction = RAMP.reduce(
    (current, step) => (history.daysSending >= step.afterDays ? step.fraction : current),
    RAMP[0]!.fraction,
  );
  const ramped = Math.max(Math.min(cap, MINIMUM_CAP), Math.floor(cap * fraction));

  const sampled = history.totalSent >= MIN_SAMPLE;
  const finish = (dailyCap: number, stage: WarmupVerdict["stage"], reason: string): WarmupVerdict => ({
    dailyCap,
    remainingToday: Math.max(0, dailyCap - history.sentToday),
    stage,
    reason,
    bounceRate,
    complaintRate,
    sampled,
  });

  // Health first. A ramp that keeps advancing while the bounce rate climbs is
  // worse than no ramp at all, because it does the damage faster.
  if (sampled && bounceRate >= BOUNCE_HALT) {
    return finish(0, "halted",
      `${percent(bounceRate)} of mail is bouncing, over the ${percent(BOUNCE_HALT)} ceiling. Sending is stopped until the list is cleaned — receiving systems read this as a purchased list.`);
  }
  if (sampled && complaintRate >= COMPLAINT_HALT) {
    return finish(0, "halted",
      `${percent(complaintRate)} of recipients have complained or opted out, at or over Gmail's published ${percent(COMPLAINT_HALT)} threshold. Sending is stopped.`);
  }
  if (sampled && (bounceRate >= BOUNCE_WARN || complaintRate >= COMPLAINT_WARN)) {
    // Held at the current step rather than advancing, and halved.
    const throttled = Math.max(Math.min(cap, MINIMUM_CAP), Math.floor(ramped / 2));
    return finish(throttled, "throttled",
      bounceRate >= BOUNCE_WARN
        ? `${percent(bounceRate)} bouncing, over the ${percent(BOUNCE_WARN)} warning line. Volume halved to ${throttled} a day and the ramp is held until it recovers.`
        : `${percent(complaintRate)} complaining, over the ${percent(COMPLAINT_WARN)} warning line. Volume halved to ${throttled} a day.`);
  }

  if (history.daysSending < 7) {
    return finish(ramped, "first_week",
      `Day ${history.daysSending + 1} on this domain: ${ramped} a day of a configured ${cap}. A new domain that sends its full volume immediately is treated as a spammer.`);
  }
  if (fraction < 1) {
    return finish(ramped, "ramping",
      `Day ${history.daysSending} on this domain: ${ramped} a day, reaching the full ${cap} after four weeks.`);
  }
  return finish(cap, "warm",
    sampled
      ? `Warm: ${cap} a day, ${percent(bounceRate)} bouncing and ${percent(complaintRate)} complaining.`
      : `Warm: ${cap} a day. Too few sent to judge bounce and complaint rates yet.`);
}

function rate(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

export function percent(value: number): string {
  if (value === 0) return "0%";
  return value < 0.01 ? `${(value * 100).toFixed(2)}%` : `${(value * 100).toFixed(1)}%`;
}

/** A rate as a human should read it, with an unsampled one marked as such. */
export function describeRate(value: number, sampled: boolean): string {
  return sampled ? percent(value) : `${percent(value)} (too few sent to judge)`;
}

/**
 * Whether a bad verdict should block a reply as well as a cold touch.
 *
 * It should not. A halt is about not sending unwanted mail to strangers; a
 * person who wrote to us and is waiting for an answer is the opposite case,
 * and leaving them hanging to protect a reputation metric would be both rude
 * and self-defeating.
 */
export function blocksReplies(verdict: WarmupVerdict): boolean {
  return false;
}
