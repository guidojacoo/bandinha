/**
 * LLM budget arithmetic.
 *
 * Free inference tiers are small — Groq's is roughly 1,000 requests and
 * 200K tokens per day on the larger models, 30 requests a minute. A sales
 * agent that burns the day's allowance on the first ten prospects and then
 * errors for twenty hours is useless.
 *
 * So spend is rationed: calls are priced before they are made, cheap models
 * handle cheap work, and when the budget runs low the agent degrades to
 * deterministic templates instead of failing. Pure arithmetic, so the policy
 * is testable without a model.
 */

export type TaskKind = "extract" | "classify" | "compose" | "reply" | "enrich";

/** How much of the day's allowance each kind of work may consume. */
export const TASK_SHARE: Record<TaskKind, number> = {
  // Done once per campaign and everything downstream depends on it.
  extract: 0.2,
  // High volume, low value per call — must stay cheap.
  classify: 0.1,
  enrich: 0.15,
  // The actual product. Gets the largest share.
  compose: 0.4,
  // Fewer calls than compose, but each one matters more.
  reply: 0.15,
};

export interface BudgetState {
  /** The UTC day this ledger covers, as YYYY-MM-DD. */
  day: string;
  /** Tokens allowed per UTC day across all models. */
  dailyTokenLimit: number;
  /** Requests allowed per UTC day. */
  dailyRequestLimit: number;
  tokensUsed: number;
  requestsUsed: number;
  /** Per-kind consumption so far today. */
  byTask: Partial<Record<TaskKind, number>>;
}

export interface BudgetDecision {
  ok: boolean;
  reason: string;
  /** Suggested max_tokens for this call given what is left. */
  maxTokens: number;
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The ledger as of `day`, zeroed if it belongs to an earlier one.
 *
 * The orchestrator is a long-running loop, so it holds this state in memory
 * across midnight. Without this the agent would stop working at 00:00 until
 * someone restarted it.
 */
export function forDay(state: BudgetState, day: string): BudgetState {
  if (state.day === day) return state;
  return { ...state, day, tokensUsed: 0, requestsUsed: 0, byTask: {} };
}

export const DEFAULT_BUDGET: Pick<BudgetState, "dailyTokenLimit" | "dailyRequestLimit"> = {
  // Groq's documented free tier for larger models, kept conservative.
  dailyTokenLimit: Number(process.env.LLM_DAILY_TOKEN_LIMIT ?? 180_000),
  dailyRequestLimit: Number(process.env.LLM_DAILY_REQUEST_LIMIT ?? 900),
};

/**
 * Reserve a slice of the day's allowance.
 *
 * `estimatedTokens` is the caller's own estimate of the whole round trip.
 * Being wrong is fine — actual spend is recorded afterwards — but being
 * wildly optimistic means the budget runs out sooner, so callers estimate
 * from real prompt length rather than guessing.
 */
export function canSpend(
  state: BudgetState,
  task: TaskKind,
  estimatedTokens: number,
  today: string = utcDay(),
): BudgetDecision {
  state = forDay(state, today);
  if (state.requestsUsed >= state.dailyRequestLimit) {
    return { ok: false, reason: "Daily request limit reached.", maxTokens: 0 };
  }

  const remaining = state.dailyTokenLimit - state.tokensUsed;
  if (remaining <= 0) {
    return { ok: false, reason: "Daily token budget exhausted.", maxTokens: 0 };
  }

  const taskCap = Math.floor(state.dailyTokenLimit * TASK_SHARE[task]);
  const taskUsed = state.byTask[task] ?? 0;
  const taskRemaining = taskCap - taskUsed;

  if (taskRemaining <= 0) {
    return {
      ok: false,
      reason: `The ${task} share of today's token budget is spent (${taskUsed}/${taskCap}).`,
      maxTokens: 0,
    };
  }

  // Never let one call take more than a quarter of what a task has left —
  // otherwise a single long page can eat the whole day's composing.
  const ceiling = Math.max(256, Math.floor(Math.min(taskRemaining, remaining) / 4));
  if (estimatedTokens > ceiling * 4) {
    return {
      ok: false,
      reason: `Estimated ${estimatedTokens} tokens exceeds what remains for ${task}.`,
      maxTokens: 0,
    };
  }

  return { ok: true, reason: "Within budget.", maxTokens: ceiling };
}

export function record(
  state: BudgetState,
  task: TaskKind,
  tokens: number,
  today: string = utcDay(),
): BudgetState {
  const base = forDay(state, today);
  // A provider that returns no usage block must not be able to credit the
  // budget back; unknown spend counts as zero, never as negative.
  const spent = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
  return {
    ...base,
    tokensUsed: base.tokensUsed + spent,
    requestsUsed: base.requestsUsed + 1,
    byTask: { ...base.byTask, [task]: (base.byTask[task] ?? 0) + spent },
  };
}

/**
 * Rough token count.
 *
 * Deliberately crude — about 4 characters per token for English prose, with
 * a margin. Precise counting would need the model's tokenizer, which is not
 * worth a dependency for a budgeting heuristic that only needs to avoid
 * overshooting.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function budgetSummary(state: BudgetState): string {
  const pct = Math.round((state.tokensUsed / Math.max(1, state.dailyTokenLimit)) * 100);
  return `${state.tokensUsed.toLocaleString()}/${state.dailyTokenLimit.toLocaleString()} tokens (${pct}%), ${state.requestsUsed}/${state.dailyRequestLimit} requests today`;
}
