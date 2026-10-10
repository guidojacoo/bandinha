import type { BudgetState, TaskKind } from "../../core/budget";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResult<T> {
  ok: boolean;
  data?: T;
  /** The raw text, kept for debugging a parse failure. */
  raw?: string;
  /** Why the call did not happen or did not parse. */
  reason?: string;
  usage?: LlmUsage;
  model?: string;
  /**
   * True when no model was consulted and the caller must fall back.
   *
   * Distinguished from a plain failure on purpose: `degraded` means the
   * system is working as designed with no LLM available — no key, budget
   * spent, provider unreachable — and the deterministic path should take
   * over quietly. A non-degraded failure is a bug worth surfacing.
   */
  degraded: boolean;
}

export interface LlmRequest {
  task: TaskKind;
  system: string;
  user: string;
  /** Prefer a smaller, faster model for cheap work. */
  tier?: "small" | "large";
  maxTokens?: number;
  temperature?: number;
}

export interface Llm {
  readonly name: string;
  available(): boolean;
  text(request: LlmRequest): Promise<LlmResult<string>>;
  json<T>(request: LlmRequest, parse: (value: unknown) => T): Promise<LlmResult<T>>;
  budget(): BudgetState;
}

/** Where the day's spend is kept between runs. */
export interface BudgetStore {
  load(): Promise<BudgetState>;
  save(state: BudgetState): Promise<void>;
}
