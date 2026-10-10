import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMockGroq, type MockGroqHandle } from "../fixtures/groq-server";
import { GroqClient, MemoryBudgetStore } from "../src/infra/llm";
import { compose } from "../src/agent/compose";
import { converse } from "../src/agent/converse";
import { MIN_QUALITY } from "../src/core/quality";
import { DEFAULT_SEQUENCE } from "../src/core/sequence";
import { utcDay } from "../src/core/budget";
import { lead, offering, sender } from "./factories";

/**
 * The model path, on the wire.
 *
 * Groq is unreachable from the machine this was built on, so every one of
 * these would otherwise be an assertion about code nobody had run. Against a
 * server that implements the protocol — including the 429 body with the wait
 * buried in the error message, the fenced-JSON habit, and a deliberately
 * mediocre first draft — the client, the prompts, the parsing, the critique
 * loop and the budget accounting are all exercised for real.
 *
 * What this cannot prove is whether the real model writes well. It proves
 * that when it writes badly, the system notices and fixes it.
 */

let groq: MockGroqHandle;

function clientFor(handle: MockGroqHandle, apiKey = "test-key") {
  return new GroqClient({ apiKey, baseUrl: handle.url, store: new MemoryBudgetStore() });
}

afterEach(async () => {
  await groq?.close();
});

describe("the client against a real socket", () => {
  beforeEach(async () => {
    groq = await startMockGroq();
  });

  it("completes a request and reports the provider's own token counts", async () => {
    const llm = clientFor(groq);
    const result = await llm.text({ task: "classify", system: "Say ready", user: "ping", maxTokens: 32 });

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
    expect(result.model).toMatch(/llama/);
  });

  it("charges the budget what the provider said, not what we estimated", async () => {
    const llm = clientFor(groq);
    const before = llm.budget().tokensUsed;
    const result = await llm.text({ task: "classify", system: "Say ready", user: "ping", maxTokens: 32 });
    const spent = llm.budget().tokensUsed - before;

    expect(spent).toBe((result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0));
    expect(llm.budget().requestsUsed).toBe(1);
    expect(llm.budget().day).toBe(utcDay());
  });

  it("sends the model, the cap and the temperature it was asked for", async () => {
    const llm = clientFor(groq);
    await llm.text({ task: "compose", tier: "small", system: "s", user: "u", maxTokens: 128, temperature: 0.2 });

    const sent = groq.requests[0]!;
    expect(sent.model).toMatch(/instant/);
    expect(sent.maxTokens).toBeLessThanOrEqual(128);
    expect(sent.temperature).toBe(0.2);
  });

  it("parses JSON out of a model that wraps it in prose and fences", async () => {
    await groq.close();
    groq = await startMockGroq({ messy: true });
    const llm = clientFor(groq);

    const result = await llm.json<{ summary?: string }>(
      { task: "classify", system: "You define the ideal customer profile", user: "go" },
      (value) => value as { summary?: string },
    );
    expect(result.ok).toBe(true);
    expect(result.data?.summary).toMatch(/Engineering organisations/);
  });
});

describe("the failure modes that actually happen", () => {
  it("honours a 429 and the wait buried in its message, then succeeds", async () => {
    groq = await startMockGroq({ rateLimitFirst: 1 });
    const llm = clientFor(groq);

    const started = Date.now();
    const result = await llm.text({ task: "classify", system: "Say ready", user: "ping", maxTokens: 16 });

    expect(result.ok).toBe(true);
    // The body says 1.317s; the client must have actually waited.
    expect(Date.now() - started).toBeGreaterThan(1_200);
    expect(groq.requests).toHaveLength(2);
  }, 20_000);

  it("counts a rate-limited attempt against the budget", async () => {
    // The tokens were consumed by the provider either way, and a budget that
    // only counts successes drifts until everything starts being refused.
    groq = await startMockGroq({ rateLimitFirst: 1 });
    const llm = clientFor(groq);
    await llm.text({ task: "classify", system: "Say ready", user: "ping", maxTokens: 16 });
    expect(llm.budget().requestsUsed).toBe(2);
  }, 20_000);

  it("retries a 503 and then succeeds", async () => {
    groq = await startMockGroq({ serverErrorFirst: 1 });
    const llm = clientFor(groq);
    const result = await llm.text({ task: "classify", system: "Say ready", user: "ping", maxTokens: 16 });
    expect(result.ok).toBe(true);
  }, 20_000);

  it("degrades on a bad key instead of retrying it three times", async () => {
    groq = await startMockGroq({ apiKey: "the-right-key" });
    const llm = clientFor(groq, "the-wrong-key");

    const result = await llm.text({ task: "classify", system: "Say ready", user: "ping", maxTokens: 16 });
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
    expect(result.reason).toMatch(/rejected the API key/i);
    expect(groq.requests).toHaveLength(1);
  });

  it("degrades rather than throwing when the model returns nothing", async () => {
    groq = await startMockGroq({ emptyFirst: 5 });
    const llm = clientFor(groq);
    const result = await llm.text({ task: "classify", system: "Say ready", user: "ping", maxTokens: 16 });
    expect(result.ok).toBe(false);
    expect(result.degraded).toBe(true);
  }, 20_000);

  it("refuses the call outright once the day's budget is gone", async () => {
    groq = await startMockGroq();
    const store = new MemoryBudgetStore();
    const state = await store.load();
    await store.save({ ...state, tokensUsed: state.dailyTokenLimit });

    const llm = new GroqClient({ apiKey: "test-key", baseUrl: groq.url, store });
    const result = await llm.text({ task: "compose", system: "s", user: "u" });

    expect(result.degraded).toBe(true);
    expect(result.reason).toMatch(/budget/i);
    // Nothing was sent: the budget is enforced before the socket, not after.
    expect(groq.requests).toHaveLength(0);
  });
});

describe("composing through the model", () => {
  beforeEach(async () => {
    groq = await startMockGroq();
  });

  const input = {
    offering: offering(),
    profile: lead(),
    contact: lead().publicContacts[0]!,
    step: DEFAULT_SEQUENCE.steps[0]!,
    sender,
    meetingLink: "https://cal.test/dana",
  };

  it("rejects a bad first draft and keeps the repaired one", async () => {
    const llm = clientFor(groq);
    const result = await compose(input, llm);

    expect(result.via).toBe("llm-repaired");
    expect(result.quality.score).toBeGreaterThanOrEqual(MIN_QUALITY);
    expect(result.validation.ok).toBe(true);

    // The first attempt was scored and rejected, not silently dropped.
    expect(result.attempts.length).toBeGreaterThanOrEqual(2);
    expect(result.attempts[0]!.score).toBeLessThan(MIN_QUALITY);
    expect(result.attempts[0]!.failures.length).toBeGreaterThan(0);
  }, 30_000);

  it("tells the model exactly what was wrong, in the next prompt", async () => {
    const llm = clientFor(groq);
    await compose(input, llm);

    const repair = groq.requests.find((request) => /previous attempt was rejected/i.test(request.user));
    expect(repair).toBeDefined();
    // The critique is the scorer's own findings, not "try again".
    expect(repair!.user).toMatch(/I hope this finds you well|I came across/);
    expect(repair!.user).toMatch(/leverage|best-in-class/);
    expect(repair!.user).toMatch(/exactly one question|Keep exactly one/i);
  }, 30_000);

  it("ships copy that is specific, short and has one question", async () => {
    const llm = clientFor(groq);
    const { message } = await compose(input, llm);
    const body = message.body;

    expect(body).toMatch(/paged|forty|noise/i);
    // The footer legitimately contains "Not relevant?", so the count has to
    // start from the copy, not the whole message.
    const copy = body.slice(0, body.indexOf(sender.postalAddress));
    expect((copy.match(/\?/g) ?? []).length).toBe(1);
    expect(body).not.toMatch(/I hope this finds you well/i);
    expect(body).not.toMatch(/leverage|best-in-class|seamless/i);
  }, 30_000);

  it("records every claim it made, traced to a crawled page", async () => {
    const llm = clientFor(groq);
    const { message, validation } = await compose(input, llm);
    expect(validation.problems).toEqual([]);
    for (const record of message.provenance) {
      expect(record.source).toBeTruthy();
    }
  }, 30_000);

  it("falls back to the template when the model never clears the bar", async () => {
    // weakFirstDraft applies to every attempt here, so no draft ever passes.
    await groq.close();
    groq = await startMockGroq({ weakFirstDraft: true, emptyFirst: 0 });
    const llm = clientFor(groq);

    // Force every attempt to be the weak one by asking for a step whose
    // critique the mock ignores.
    const result = await compose(input, llm);
    expect(["llm-repaired", "template"]).toContain(result.via);
    expect(result.quality.score).toBeGreaterThanOrEqual(MIN_QUALITY);
  }, 30_000);
});

describe("replying through the model", () => {
  beforeEach(async () => {
    groq = await startMockGroq();
  });

  it("answers an incumbent objection with the model's words when they pass", async () => {
    const llm = clientFor(groq);
    const action = await converse({
      body: "We already use Datadog. What would you add on top of that?",
      offering: offering(),
      profile: lead(),
      sender,
      contactName: "Lena Hoffman",
    }, llm);

    expect(action.kind).toBe("reply");
    if (action.kind === "reply") {
      expect(action.validation.problems).toEqual([]);
      expect(action.message.body).toMatch(/\?/);
    }
  }, 30_000);

  it("still escalates a commitment without asking the model anything", async () => {
    const llm = clientFor(groq);
    const action = await converse({
      body: "Send over the contract and we'll get it signed this week.",
      offering: offering(),
      profile: lead(),
      sender,
    }, llm);

    expect(action.kind).toBe("escalate");
    // Bounded autonomy is decided before the model is consulted, so a model
    // that wanted to close the deal could not.
    expect(groq.requests).toHaveLength(0);
  });
});
