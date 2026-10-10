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

/**
 * Prompting that works for a person and for a pipe.
 *
 * Two problems, both found rather than anticipated. Creating a readline
 * interface per question discards whatever is already buffered on stdin, so
 * the second answer in `printf 'a\nb\n' | npm run setup` vanished. And a
 * single interface still drops lines, because readline emits them whether or
 * not a question is pending — fast piped input arrives before the second
 * `question()` call and is thrown away.
 *
 * So lines are buffered here instead, and end-of-input resolves pending
 * questions with their defaults rather than hanging. Setup is therefore
 * scriptable, which matters for a container or a CI run.
 */
let io: {
  rl: ReturnType<typeof createInterface>;
  lines: string[];
  waiting: Array<(line: string | null) => void>;
  closed: boolean;
} | null = null;

function stdinReader() {
  if (io) return io;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const state = { rl, lines: [] as string[], waiting: [] as Array<(line: string | null) => void>, closed: false };

  rl.on("line", (line) => {
    const next = state.waiting.shift();
    if (next) next(line);
    else state.lines.push(line);
  });
  rl.on("close", () => {
    state.closed = true;
    while (state.waiting.length > 0) state.waiting.shift()?.(null);
  });

  io = state;
  return state;
}

export function closePrompt(): void {
  io?.rl.close();
  io = null;
}

export async function ask(question: string, fallback = ""): Promise<string> {
  const state = stdinReader();
  process.stdout.write(fallback ? `${question} ${colour.dim(`[${fallback}]`)} ` : `${question} `);

  const buffered = state.lines.shift();
  const line = buffered !== undefined
    ? buffered
    : state.closed
      ? null
      : await new Promise<string | null>((resolve) => state.waiting.push(resolve));

  if (line === null) {
    // Input ended. Echo the default so a scripted run is readable.
    process.stdout.write(`${colour.dim(fallback || "(no answer)")}\n`);
    return fallback;
  }
  const answer = line.trim();
  // `terminal: false` means readline does not echo, so a piped run would
  // otherwise print a prompt with no visible answer next to it.
  process.stdout.write(`${answer || colour.dim(fallback)}\n`);
  return answer || fallback;
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
  closePrompt();
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
