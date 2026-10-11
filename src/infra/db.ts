import { resolve } from "node:path";
import { PrismaClient } from "../generated/prisma";
import { fromJson, toJson } from "../lib/json";
import {
  DEFAULT_BUDGET, forDay, utcDay, type BudgetState, type TaskKind,
} from "../core/budget";
import type { BudgetStore } from "./llm/types";

/**
 * The database: one SQLite file, created by `npm run setup`.
 *
 * Deliberate, not a shortcut. The product has to be free and setup-free end
 * to end, and asking somebody to provision Postgres before they can try a
 * sales agent is where most people stop. Swapping the provider is a one-line
 * change for anyone who outgrows a file.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const DEFAULT_SQLITE_PATH = "data/mercurio.db";

/**
 * The database URL, with any relative SQLite path made absolute.
 *
 * This is not tidying. A relative `file:` path means two different files
 * depending on who reads it: the Prisma CLI resolves it against the
 * directory holding `schema.prisma`, and the client at runtime resolves it
 * against the process's working directory. So `file:./data/mercurio.db` sent
 * `prisma db push` to `prisma/data/mercurio.db` and the application to
 * `./data/mercurio.db`, and a fresh install got a cheerful "Database ready"
 * followed by an app that could not find a database. Found by cloning the
 * repository and following the README, which is the only way that class of
 * bug is ever found.
 *
 * `process.cwd()` is the right base because every entry point here is an npm
 * script, and npm runs scripts from the package root.
 */
export function dbUrl(): string {
  const configured = process.env.DATABASE_URL;
  if (!configured) return fileUrl(resolve(process.cwd(), DEFAULT_SQLITE_PATH));
  if (!configured.startsWith("file:")) return configured;

  const path = configured.slice("file:".length);
  if (path.startsWith("/")) return configured;
  return fileUrl(resolve(process.cwd(), path));
}

function fileUrl(absolutePath: string): string {
  return `file:${absolutePath}`;
}

/** Where the SQLite file is, or null when this is not SQLite at all. */
export function dbFilePath(): string | null {
  const url = dbUrl();
  return url.startsWith("file:") ? url.slice("file:".length) : null;
}

export const db: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: { db: { url: dbUrl() } },
    log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["error"],
  });

// Next.js hot-reloads modules in development, and a fresh PrismaClient per
// reload exhausts SQLite's connection handles within a few minutes.
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;

// ---------------------------------------------------------------------------
// Token budget persistence
// ---------------------------------------------------------------------------

/** The row holding the day's authoritative budget, as opposed to per-model reporting. */
const BUDGET_ROW = "*";

/**
 * The LLM budget, kept in the database.
 *
 * It has to outlive the process: the orchestrator is often a cron job or a
 * CLI invocation rather than a daemon, and an in-memory budget would reset on
 * every tick and sail straight past the provider's daily limit — which is
 * exactly the failure the budget exists to prevent.
 */
export class PrismaBudgetStore implements BudgetStore {
  async load(): Promise<BudgetState> {
    const day = utcDay();
    const row = await db.tokenLedger.findUnique({ where: { day_model: { day, model: BUDGET_ROW } } });
    if (!row) {
      return { day, ...limits(), tokensUsed: 0, requestsUsed: 0, byTask: {} };
    }
    return {
      day,
      ...limits(),
      tokensUsed: row.inputTokens + row.outputTokens,
      requestsUsed: row.requests,
      byTask: fromJson<Partial<Record<TaskKind, number>>>(row.byTask, {}),
    };
  }

  async save(state: BudgetState): Promise<void> {
    const normalised = forDay(state, state.day);
    await db.tokenLedger.upsert({
      where: { day_model: { day: normalised.day, model: BUDGET_ROW } },
      create: {
        day: normalised.day,
        model: BUDGET_ROW,
        requests: normalised.requestsUsed,
        // Only the total matters for budgeting; the split between prompt and
        // completion is kept on the per-model rows.
        inputTokens: normalised.tokensUsed,
        outputTokens: 0,
        byTask: toJson(normalised.byTask),
      },
      update: {
        requests: normalised.requestsUsed,
        inputTokens: normalised.tokensUsed,
        outputTokens: 0,
        byTask: toJson(normalised.byTask),
      },
    });
  }
}

function limits(): Pick<BudgetState, "dailyTokenLimit" | "dailyRequestLimit"> {
  return {
    dailyTokenLimit: Number(process.env.LLM_DAILY_TOKEN_LIMIT ?? DEFAULT_BUDGET.dailyTokenLimit),
    dailyRequestLimit: Number(process.env.LLM_DAILY_REQUEST_LIMIT ?? DEFAULT_BUDGET.dailyRequestLimit),
  };
}

/** Per-model usage, for the console's "where did the day go" panel. */
export async function recordModelUsage(info: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  failed: boolean;
}): Promise<void> {
  const day = utcDay();
  await db.tokenLedger.upsert({
    where: { day_model: { day, model: info.model } },
    create: {
      day,
      model: info.model,
      requests: 1,
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      failures: info.failed ? 1 : 0,
    },
    update: {
      requests: { increment: 1 },
      inputTokens: { increment: info.inputTokens },
      outputTokens: { increment: info.outputTokens },
      failures: { increment: info.failed ? 1 : 0 },
    },
  });
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type EventLevel = "info" | "warn" | "error" | "success";

/**
 * Appends to the campaign's audit log.
 *
 * Every decision the agent makes is written here: why a lead was rejected,
 * why a message was blocked, which claim failed provenance. An autonomous
 * system that cannot explain itself is one nobody will leave running, and
 * this log is what the console's "why?" column reads.
 */
export async function logEvent(
  campaignId: string,
  kind: string,
  message: string,
  options: { level?: EventLevel; data?: unknown } = {},
): Promise<void> {
  await db.event.create({
    data: {
      campaignId,
      kind,
      level: options.level ?? "info",
      message: message.slice(0, 2_000),
      data: options.data === undefined ? null : toJson(options.data),
    },
  });
}

/** True when the schema has been applied to the database file. */
export async function databaseReady(): Promise<{ ok: boolean; error?: string }> {
  try {
    await db.$queryRaw`SELECT 1 FROM users LIMIT 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
