import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's zodOutputFormat is built against Zod 4 internals, which zod
// 3.25 exposes at the `zod/v4` subpath. Schemas passed to `extract` must
// come from the same subpath or the types will not line up.
import type * as z from "zod/v4";

/**
 * The agent's reasoning layer.
 *
 * Two deliberate properties:
 *
 * 1. **Optional.** Every caller has a deterministic fallback. Without an API
 *    key the agent still ingests, scores, sequences and sends — it just writes
 *    from templates instead of composing. That keeps the whole pipeline
 *    runnable and testable in environments with no model access, and means a
 *    key outage degrades quality rather than stopping sales.
 * 2. **Structured by default.** Extraction goes through `messages.parse()`
 *    with a Zod schema, so a malformed model response is a typed failure
 *    rather than a string the next stage has to guess at.
 */

export const DEFAULT_MODEL = process.env.RAINMAKER_MODEL ?? "claude-opus-5-5";

export type Effort = "low" | "medium" | "high";

export interface LlmUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: number;
}

export interface LlmRequest {
  system: string;
  prompt: string;
  /** Caps generation. Extraction needs little; composition needs more. */
  maxTokens?: number;
  effort?: Effort;
  /** Labels the call in the usage log, e.g. "compose:first_touch". */
  label?: string;
}

export class Llm {
  private client: Anthropic | null;
  readonly model: string;
  readonly usage: LlmUsage = { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
  /** Human-readable trail of what the model was asked to do. */
  readonly log: Array<{ label: string; ok: boolean; detail?: string }> = [];

  constructor(apiKey = process.env.ANTHROPIC_API_KEY, model = DEFAULT_MODEL) {
    this.model = model;
    // The SDK retries 429s and 5xx itself; two extra attempts is plenty for
    // a background agent that can simply try again on the next tick.
    this.client = apiKey ? new Anthropic({ apiKey, maxRetries: 2 }) : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** Why the LLM is off, for surfacing in the dashboard. */
  get disabledReason(): string | null {
    return this.enabled ? null : "ANTHROPIC_API_KEY is not set — running on deterministic fallbacks.";
  }

  private record(label: string, ok: boolean, detail?: string): void {
    this.log.push({ label, ok, detail });
    if (this.log.length > 200) this.log.shift();
    if (!ok) this.usage.failures += 1;
  }

  /**
   * Structured extraction. Returns null on any failure, so callers must have
   * a fallback — there is no path where a model hiccup takes the agent down.
   */
  async extract<T extends z.ZodType>(
    schema: T,
    req: LlmRequest,
  ): Promise<z.infer<T> | null> {
    if (!this.client) return null;
    const label = req.label ?? "extract";

    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? 8000,
        system: req.system,
        output_config: {
          format: zodOutputFormat(schema),
          effort: req.effort ?? "medium",
        },
        messages: [{ role: "user", content: req.prompt }],
      });

      this.usage.calls += 1;
      this.usage.inputTokens += response.usage?.input_tokens ?? 0;
      this.usage.outputTokens += response.usage?.output_tokens ?? 0;

      if (response.stop_reason === "refusal") {
        this.record(label, false, `model declined: ${response.stop_details?.category ?? "unknown"}`);
        return null;
      }
      // parsed_output is null when the model could not satisfy the schema.
      const parsed = response.parsed_output;
      if (parsed == null) {
        this.record(label, false, "response did not match the schema");
        return null;
      }
      this.record(label, true);
      return parsed as z.infer<T>;
    } catch (err) {
      this.record(label, false, describeError(err));
      return null;
    }
  }

  /** Free-text generation, for prose the schema cannot express. */
  async write(req: LlmRequest): Promise<string | null> {
    if (!this.client) return null;
    const label = req.label ?? "write";

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 2000,
        system: req.system,
        output_config: { effort: req.effort ?? "medium" },
        messages: [{ role: "user", content: req.prompt }],
      });

      this.usage.calls += 1;
      this.usage.inputTokens += response.usage?.input_tokens ?? 0;
      this.usage.outputTokens += response.usage?.output_tokens ?? 0;

      if (response.stop_reason === "refusal") {
        this.record(label, false, `model declined: ${response.stop_details?.category ?? "unknown"}`);
        return null;
      }

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();

      if (!text) {
        this.record(label, false, "empty response");
        return null;
      }
      this.record(label, true);
      return text;
    } catch (err) {
      this.record(label, false, describeError(err));
      return null;
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "authentication failed — check ANTHROPIC_API_KEY";
  if (err instanceof Anthropic.RateLimitError) return "rate limited";
  if (err instanceof Anthropic.NotFoundError) return "model not found — check RAINMAKER_MODEL";
  if (err instanceof Anthropic.BadRequestError) return `bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "could not reach the Anthropic API";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

let shared: Llm | null = null;

/** Process-wide client, so usage totals accumulate across a run. */
export function llm(): Llm {
  if (!shared) shared = new Llm();
  return shared;
}

/** Test seam. */
export function setLlm(instance: Llm | null): void {
  shared = instance;
}
