import { createInterface } from "node:readline/promises";
import { databaseReady, db } from "../infra/db";
import { createLlm } from "../infra/llm";
import { PrismaBudgetStore, recordModelUsage } from "../infra/db";
import { dnsAvailable } from "../infra/dns";
import type { Llm } from "../infra/llm/types";

/** Shared plumbing for the command-line entry points. */

export const colour = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export function heading(text: string): void {
  console.log(`\n${colour.bold(text)}\n${colour.dim("─".repeat(Math.min(72, text.length + 8)))}`);
}

export async function ask(question: string, fallback = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(fallback ? `${question} ${colour.dim(`[${fallback}]`)} ` : `${question} `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} (y/N)`, "n");
  return /^y(es)?$/i.test(answer);
}

/**
 * The LLM, wired to the persistent budget.
 *
 * The budget has to survive the process: the orchestrator is usually a cron
 * job or a one-shot command, and an in-memory budget would reset on every
 * invocation and sail straight past the provider's daily limit.
 */
export function llmForRun(): Llm {
  return createLlm({
    store: new PrismaBudgetStore(),
    onCall: (info) => {
      void recordModelUsage({
        model: info.model,
        inputTokens: info.usage?.inputTokens ?? 0,
        outputTokens: info.usage?.outputTokens ?? 0,
        failed: Boolean(info.error) || info.status >= 400,
      });
    },
  });
}

export async function requireDatabase(): Promise<void> {
  const ready = await databaseReady();
  if (ready.ok) return;
  console.error(colour.red("The database has not been set up yet."));
  console.error(`Run ${colour.bold("npm run setup")} first. (${ready.error})`);
  process.exit(1);
}

/**
 * Whether this machine can resolve DNS.
 *
 * Checked once per run rather than per address: in a sandbox or a locked-down
 * CI container there is no resolver at all, and the deliverability pre-flight
 * should then record "not checked" instead of marking every address risky.
 */
export async function dnsUsable(): Promise<boolean> {
  if (process.env.SKIP_DNS === "1") return false;
  return dnsAvailable();
}

export async function closeDatabase(): Promise<void> {
  await db.$disconnect();
}

export function fatal(message: string): never {
  console.error(`\n${colour.red("✗")} ${message}\n`);
  process.exit(1);
}

/** Wraps a command so a thrown error is a message, not a stack trace. */
export function run(main: () => Promise<void>): void {
  main()
    .then(async () => {
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error(`\n${colour.red("✗")} ${error instanceof Error ? error.message : String(error)}`);
      if (process.env.DEBUG === "1" && error instanceof Error) console.error(error.stack);
      await closeDatabase().catch(() => {});
      process.exit(1);
    });
}
