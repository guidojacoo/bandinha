import { describe, expect, it } from "vitest";
import { budgetSummary, canSpend, estimateTokens, record, TASK_SHARE } from "../src/core/budget";
import type { BudgetState } from "../src/core/budget";

const DAY = "2026-03-10";

function state(over: Partial<BudgetState> = {}): BudgetState {
  return {
    day: DAY,
    requestsUsed: 0,
    tokensUsed: 0,
    byTask: { extract: 0, classify: 0, compose: 0, reply: 0, enrich: 0 },
    dailyTokenLimit: 100_000,
    dailyRequestLimit: 500,
    ...over,
  };
}

/**
 * Groq's free tier is generous but finite, and "free" is a hard product
 * requirement rather than a nice-to-have. The budget is what stops the agent
 * burning the day's whole allowance extracting one verbose homepage and then
 * having nothing left to answer a prospect who replied.
 */
describe("canSpend", () => {
  it("allows a normal call on a fresh day", () => {
    expect(canSpend(state(), "compose", 2_000, DAY).ok).toBe(true);
  });

  it("blocks when the daily token limit is spent", () => {
    const decision = canSpend(state({ tokensUsed: 100_000 }), "compose", 100, DAY);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/token/i);
  });

  it("blocks when the daily request limit is spent", () => {
    const decision = canSpend(state({ requestsUsed: 500 }), "compose", 100, DAY);
    expect(decision.ok).toBe(false);
    expect(decision.reason).toMatch(/request/i);
  });

  it("ring-fences each task, so extraction cannot starve replies", () => {
    const extractShare = TASK_SHARE.extract * 100_000;
    const spent = state({ tokensUsed: extractShare, byTask: { ...state().byTask, extract: extractShare } });
    expect(canSpend(spent, "extract", 500, DAY).ok).toBe(false);
    // The reply budget is untouched, and a live prospect still gets an answer.
    expect(canSpend(spent, "reply", 500, DAY).ok).toBe(true);
  });

  it("caps a single call so one long page cannot eat the day", () => {
    const decision = canSpend(state(), "compose", 2_000, DAY);
    expect(decision.ok).toBe(true);
    expect(decision.maxTokens).toBeLessThan(TASK_SHARE.compose * 100_000);
    expect(decision.maxTokens).toBeGreaterThanOrEqual(256);
  });

  it("refuses a call whose own estimate would blow the task's share", () => {
    expect(canSpend(state(), "compose", 1_000_000, DAY).ok).toBe(false);
  });

  it("resets when the day rolls over, so a long-running loop survives midnight", () => {
    const exhausted = state({ day: "2026-03-09", tokensUsed: 100_000, requestsUsed: 500 });
    expect(canSpend(exhausted, "compose", 2_000, "2026-03-09").ok).toBe(false);
    expect(canSpend(exhausted, "compose", 2_000, "2026-03-10").ok).toBe(true);
  });

  it("task shares add up to the whole budget", () => {
    const total = Object.values(TASK_SHARE).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});

describe("record", () => {
  it("accumulates tokens and requests", () => {
    const after = record(record(state(), "compose", 1_200, DAY), "compose", 800, DAY);
    expect(after.tokensUsed).toBe(2_000);
    expect(after.requestsUsed).toBe(2);
    expect(after.byTask.compose).toBe(2_000);
  });

  it("starts a fresh ledger on a new day", () => {
    const after = record(state({ tokensUsed: 90_000, requestsUsed: 400 }), "compose", 1_000, "2026-03-11");
    expect(after.day).toBe("2026-03-11");
    expect(after.tokensUsed).toBe(1_000);
    expect(after.requestsUsed).toBe(1);
  });

  it("never records a negative spend", () => {
    expect(record(state(), "compose", -500, DAY).tokensUsed).toBe(0);
  });
});

describe("estimateTokens", () => {
  it("scales with length", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("x".repeat(3_600))).toBeGreaterThan(estimateTokens("x".repeat(360)));
  });

  it("handles empty input", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("budgetSummary", () => {
  it("reports usage in a line an operator can read", () => {
    expect(budgetSummary(state({ tokensUsed: 25_000, requestsUsed: 50 }))).toMatch(/25,?000/);
  });
});
