import type { DealStage, EnrollmentState, ReplyAnalysis, ReplyIntent } from "../core/types";

/**
 * Deal stages, derived rather than decided.
 *
 * The stage is a function of what has actually happened — messages sent,
 * replies received, a meeting agreed — so it cannot drift from the evidence.
 * Two rules matter more than the rest:
 *
 *  1. **Terminal stages absorb.** A won or lost deal stays where it is. An
 *     earlier version let a stray reply drag a won deal back to `proposal`,
 *     where it re-closed itself on every tick of the orchestrator, producing
 *     an endless run and a wildly wrong pipeline total.
 *  2. **The agent never writes `won`.** Not once, under any reply. A closed
 *     deal requires a payment, a countersigned document, or a person saying
 *     so. An agent that marks its own deals won is a demo, not a product —
 *     and it is the single easiest way for this category to lie to the people
 *     paying for it.
 */

const TERMINAL: DealStage[] = ["won", "lost"];

export function isTerminalStage(stage: DealStage): boolean {
  return TERMINAL.includes(stage);
}

/** How far through the pipeline each stage is, for ratchet logic and sorting. */
export const STAGE_ORDER: DealStage[] = [
  "prospect", "contacted", "engaged", "meeting_booked", "proposal", "won", "lost",
];

export function stageRank(stage: DealStage): number {
  const index = STAGE_ORDER.indexOf(stage);
  return index < 0 ? 0 : index;
}

export interface StageInput {
  current: DealStage;
  sentCount: number;
  lastReply?: ReplyAnalysis;
  meetingBooked?: boolean;
  /** Set by a person, or by a payment webhook. Never by the agent. */
  humanClosed?: "won" | "lost";
}

export function stageFor(input: StageInput): DealStage {
  // A human decision, or a payment, outranks everything.
  if (input.humanClosed) return input.humanClosed;
  if (isTerminalStage(input.current)) return input.current;

  const intent = input.lastReply?.intent;

  if (intent === "unsubscribe" || intent === "not_interested" || intent === "bounce") return "lost";
  // Ratcheted, and that mattered: this used to return `meeting_booked`
  // outright, so a prospect who had already asked for a contract — a deal at
  // `proposal` — was dragged back a stage by the meeting they had booked
  // earlier. The demo found it by confirming a meeting on a deal that had
  // moved on, after which the payment webhook could no longer find a proposal
  // to close and the sale vanished.
  if (input.meetingBooked || intent === "meeting_request") return advanceStage(input.current, "meeting_booked");

  // "Send me the contract" is a proposal stage, not a win. The win is the
  // signature, which the agent cannot observe.
  if (intent === "commitment" || intent === "pricing_question") return "proposal";

  if (intent && ["interested", "objection", "not_now", "referral", "wrong_person", "unclear"].includes(intent)) {
    // A reply is engagement even when it is a complaint. It is the only
    // honest reading: somebody read it and typed something back.
    return advanceStage(input.current, "engaged");
  }

  if (input.sentCount > 0) return advanceStage(input.current, "contacted");
  return input.current;
}

/**
 * The two rules, in one function.
 *
 * A deal never moves backwards, and a terminal stage absorbs. Both exist
 * because the stage is *derived*: it is recomputed from the evidence on every
 * tick, and anything recomputed that often will eventually be recomputed with
 * stale or partial evidence. Making the transition monotonic means that costs
 * nothing — the worst case is that a stage is briefly behind, rather than a
 * won deal quietly becoming an open one.
 *
 * Exported because the derivation is not the only writer. A person confirming
 * a meeting in the console writes a stage too, and had its own copy of this
 * rule with the ratchet left out.
 */
export function advanceStage(current: DealStage, candidate: DealStage): DealStage {
  if (isTerminalStage(current)) return current;
  return stageRank(candidate) > stageRank(current) ? candidate : current;
}

/** Enrollment state implied by a reply, for `core/sequence.ts`. */
export function enrollmentEventFor(intent: ReplyIntent): "replied" | "unsubscribed" | "bounced" | null {
  if (intent === "unsubscribe") return "unsubscribed";
  if (intent === "bounce") return "bounced";
  if (intent === "auto_reply") return null;
  return "replied";
}

export interface PipelineTotals {
  byStage: Record<DealStage, number>;
  /** Deals a person needs to look at, which is the number that matters. */
  needsHuman: number;
  open: number;
  won: number;
  lost: number;
}

export function summarise(deals: Array<{ stage: string }>, escalations: number): PipelineTotals {
  const byStage = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0])) as Record<DealStage, number>;
  for (const deal of deals) {
    const stage = deal.stage as DealStage;
    if (stage in byStage) byStage[stage] += 1;
  }
  return {
    byStage,
    needsHuman: escalations,
    open: STAGE_ORDER.filter((s) => !isTerminalStage(s)).reduce((sum, s) => sum + byStage[s], 0),
    won: byStage.won,
    lost: byStage.lost,
  };
}

/** The enrollment states that mean the cadence is finished with a contact. */
export function isClosed(state: EnrollmentState): boolean {
  return ["won", "lost", "unsubscribed", "bounced"].includes(state);
}
