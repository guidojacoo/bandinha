import {
  canSpend, DEFAULT_BUDGET, estimateTokens, forDay, record, utcDay,
  type BudgetState, type TaskKind,
} from "../../core/budget";
import { fetchText } from "../http";
import type { BudgetStore, Llm, LlmRequest, LlmResult, LlmUsage } from "./types";

/**
 * Groq, through its OpenAI-compatible endpoint.
 *
 * Chosen because its free tier is the only one that makes an autonomous agent
 * plausible at zero cost: large open models at a few hundred tokens per
 * second, with a daily allowance rather than a trial credit. The cost of that
 * choice is hard rate limits, so this client is built around them:
 *
 *  - Every call is priced against the day's budget *before* it is made, and
 *    the per-task shares in `core/budget.ts` stop extraction starving replies.
 *  - A 429 is honoured, not retried blindly: `retry-after` is respected, and
 *    after the last attempt the call degrades instead of throwing.
 *  - Degrading is a first-class outcome. No key, no budget, no network — the
 *    caller gets `degraded: true` and uses its deterministic path. The agent
 *    gets slower and blunter, never broken.
 */

const ENDPOINT = process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";

/**
 * Model tiers.
 *
 * `large` writes and reasons; `small` classifies and extracts. Both are
 * free-tier models on Groq. Overridable by environment variable because
 * free-tier model names change faster than this file will.
 */
export const MODELS = {
  large: process.env.GROQ_MODEL_LARGE ?? "llama-3.3-70b-versatile",
  small: process.env.GROQ_MODEL_SMALL ?? "llama-3.1-8b-instant",
};

const MAX_ATTEMPTS = Number(process.env.GROQ_MAX_ATTEMPTS ?? 3);

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

export class MemoryBudgetStore implements BudgetStore {
  private state: BudgetState = {
    day: utcDay(),
    ...DEFAULT_BUDGET,
    tokensUsed: 0,
    requestsUsed: 0,
    byTask: {},
  };

  async load(): Promise<BudgetState> {
    this.state = forDay(this.state, utcDay());
    return this.state;
  }

  async save(state: BudgetState): Promise<void> {
    this.state = state;
  }
}

export interface GroqOptions {
  apiKey?: string;
  store?: BudgetStore;
  /** Called after every attempt, for the run log. */
  onCall?: (info: { model: string; task: TaskKind; usage?: LlmUsage; status: number; error?: string }) => void;
}

export class GroqClient implements Llm {
  readonly name = "groq";
  private readonly apiKey: string;
  private readonly store: BudgetStore;
  private readonly onCall: GroqOptions["onCall"];
  private state: BudgetState | null = null;
  /** Set when the provider told us to wait; respected across calls. */
  private cooldownUntil = 0;

  constructor(options: GroqOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.GROQ_API_KEY ?? "").trim();
    this.store = options.store ?? new MemoryBudgetStore();
    this.onCall = options.onCall;
  }

  available(): boolean {
    return this.apiKey.length > 0;
  }

  budget(): BudgetState {
    return this.state ?? { day: utcDay(), ...DEFAULT_BUDGET, tokensUsed: 0, requestsUsed: 0, byTask: {} };
  }

  async text(request: LlmRequest): Promise<LlmResult<string>> {
    if (!this.available()) {
      return degraded("No GROQ_API_KEY is set, so the deterministic path is being used.");
    }

    const state = forDay(await this.store.load(), utcDay());
    this.state = state;

    const estimate = estimateTokens(request.system) + estimateTokens(request.user) + (request.maxTokens ?? 700);
    const decision = canSpend(state, request.task, estimate);
    if (!decision.ok) return degraded(decision.reason);

    const wait = this.cooldownUntil - Date.now();
    if (wait > 0) {
      if (wait > 30_000) return degraded(`Provider asked for a ${Math.round(wait / 1000)}s cooldown.`);
      await sleep(wait);
    }

    const model = request.tier === "small" ? MODELS.small : MODELS.large;
    const maxTokens = Math.min(request.maxTokens ?? decision.maxTokens, decision.maxTokens);

    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetchText(`${ENDPOINT}/chat/completions`, {
        method: "POST",
        immediate: true,
        timeoutMs: Number(process.env.GROQ_TIMEOUT_MS ?? 45_000),
        accept: "application/json",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          max_tokens: Math.max(64, maxTokens),
          temperature: request.temperature ?? 0.3,
          stream: false,
        }),
      });

      let parsed: ChatResponse = {};
      try {
        parsed = JSON.parse(response.body) as ChatResponse;
      } catch { /* handled below via status */ }

      const usage: LlmUsage | undefined = parsed.usage
        ? {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          }
        : undefined;

      // Spend is recorded whether or not the content was usable: the tokens
      // were consumed either way, and a budget that only counts successes
      // drifts until the provider starts refusing everything.
      const spent = usage ? usage.inputTokens + usage.outputTokens : estimate;
      this.state = record(this.state ?? state, request.task, spent);
      await this.store.save(this.state);
      this.onCall?.({ model, task: request.task, usage, status: response.status, error: response.error });

      if (response.status === 429 || response.status === 503) {
        const retryAfter = parseRetryAfter(parsed.error?.message) ?? backoffMs(attempt);
        this.cooldownUntil = Date.now() + retryAfter;
        lastError = `${response.status} rate limited; waited ${Math.round(retryAfter / 1000)}s`;
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(Math.min(retryAfter, 20_000));
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        return degraded("Groq rejected the API key, so the deterministic path is being used.");
      }

      if (!response.ok) {
        lastError = parsed.error?.message ?? response.error ?? `HTTP ${response.status}`;
        if (attempt === MAX_ATTEMPTS || response.status < 500) break;
        await sleep(backoffMs(attempt));
        continue;
      }

      const content = parsed.choices?.[0]?.message?.content?.trim() ?? "";
      if (!content) {
        lastError = "Model returned an empty completion.";
        if (attempt === MAX_ATTEMPTS) break;
        continue;
      }

      return { ok: true, data: content, raw: content, usage, model, degraded: false };
    }

    // Every failure degrades rather than throwing. A sales run that dies
    // because a rate limit was hit at prospect 40 is worse than one that
    // finishes the remaining 60 on templates and says so.
    return degraded(`Groq unavailable after ${MAX_ATTEMPTS} attempt(s): ${lastError}`);
  }

  async json<T>(request: LlmRequest, parse: (value: unknown) => T): Promise<LlmResult<T>> {
    const result = await this.text({
      ...request,
      system: `${request.system}\n\nReply with JSON only. No prose, no markdown fences.`,
      temperature: request.temperature ?? 0.1,
    });
    if (!result.ok || !result.data) return { ...result, data: undefined } as LlmResult<T>;

    const extracted = extractJson(result.data);
    if (extracted === null) {
      return { ok: false, raw: result.data, reason: "Response contained no JSON object.", usage: result.usage, model: result.model, degraded: true };
    }

    try {
      return { ok: true, data: parse(extracted), raw: result.data, usage: result.usage, model: result.model, degraded: false };
    } catch (error) {
      return {
        ok: false,
        raw: result.data,
        reason: `JSON did not match the expected shape: ${error instanceof Error ? error.message : String(error)}`,
        usage: result.usage,
        model: result.model,
        // A schema mismatch is still a reason to fall back, not to stop.
        degraded: true,
      };
    }
  }
}

/** An LLM that is never available. Used offline and in tests. */
export class NullLlm implements Llm {
  readonly name = "none";
  available(): boolean { return false; }
  budget(): BudgetState {
    return { day: utcDay(), ...DEFAULT_BUDGET, tokensUsed: 0, requestsUsed: 0, byTask: {} };
  }
  async text(): Promise<LlmResult<string>> {
    return degraded("No LLM configured; using the deterministic path.");
  }
  async json<T>(): Promise<LlmResult<T>> {
    return degraded("No LLM configured; using the deterministic path.") as LlmResult<T>;
  }
}

function degraded(reason: string): LlmResult<never> & { degraded: true } {
  return { ok: false, reason, degraded: true };
}

/**
 * Pulls a JSON value out of a completion.
 *
 * Models wrap JSON in prose and markdown fences however firmly they are told
 * not to. Brace matching rather than a regex, because a nested object inside
 * a string would break a lazy pattern.
 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = trimmed.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(trimmed.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Groq reports its own wait time in the error message. */
export function parseRetryAfter(message?: string): number | null {
  if (!message) return null;
  const seconds = message.match(/try again in ([\d.]+)s/i);
  if (seconds?.[1]) return Math.ceil(Number(seconds[1]) * 1000);
  const minutes = message.match(/try again in ([\d.]+)m/i);
  if (minutes?.[1]) return Math.ceil(Number(minutes[1]) * 60_000);
  return null;
}

function backoffMs(attempt: number): number {
  // 2s, 4s, 8s with jitter, so parallel workers do not retry in lockstep.
  return Math.round(2 ** attempt * 1000 * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
