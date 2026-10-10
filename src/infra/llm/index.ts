export * from "./types";
export { GroqClient, NullLlm, MemoryBudgetStore, MODELS, extractJson, parseRetryAfter } from "./groq";

import { GroqClient, NullLlm, type GroqOptions } from "./groq";
import type { Llm } from "./types";

/**
 * The LLM for this run.
 *
 * Returns a working client when a key is present and a `NullLlm` when it is
 * not. Nothing downstream branches on which it got — every caller handles
 * `degraded` anyway, because the budget can run out mid-run even with a
 * perfectly good key.
 */
export function createLlm(options: GroqOptions = {}): Llm {
  const client = new GroqClient(options);
  return client.available() ? client : new NullLlm();
}
