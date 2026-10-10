import { describe, expect, it } from "vitest";
import { extractJson, NullLlm, parseRetryAfter } from "../src/infra/llm";

describe("extractJson", () => {
  it("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips markdown fences", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("finds JSON buried in prose", () => {
    expect(extractJson('Sure! Here is the ICP you asked for:\n{"industries":["saas"]}\nHope that helps.'))
      .toEqual({ industries: ["saas"] });
  });

  it("parses an array response", () => {
    expect(extractJson('Here you go: ["a","b"]')).toEqual(["a", "b"]);
  });

  it("handles braces inside strings", () => {
    // A lazy regex would stop at the first } inside the string value.
    expect(extractJson('{"note":"use {{name}} here","ok":true}')).toEqual({ note: "use {{name}} here", ok: true });
  });

  it("handles escaped quotes inside strings", () => {
    expect(extractJson('{"quote":"they said \\"no\\" twice"}')).toEqual({ quote: 'they said "no" twice' });
  });

  it("handles nested objects", () => {
    expect(extractJson('{"a":{"b":{"c":1}}}')).toEqual({ a: { b: { c: 1 } } });
  });

  it("returns null when there is no JSON", () => {
    expect(extractJson("I am afraid I cannot help with that.")).toBeNull();
  });

  it("returns null on truncated JSON", () => {
    expect(extractJson('{"industries":["saas",')).toBeNull();
  });

  it("handles an empty response", () => {
    expect(extractJson("")).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  it("reads the wait Groq reports in seconds", () => {
    expect(parseRetryAfter("Rate limit reached. Please try again in 7.482s.")).toBe(7_482);
  });

  it("reads a wait in minutes", () => {
    expect(parseRetryAfter("Limit reached, try again in 2m.")).toBe(120_000);
  });

  it("returns null when the message says nothing useful", () => {
    expect(parseRetryAfter("Too many requests")).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});

describe("NullLlm", () => {
  const llm = new NullLlm();

  it("reports itself unavailable", () => {
    expect(llm.available()).toBe(false);
  });

  it("degrades rather than failing, so callers fall back", () => {
    return llm.text().then((result) => {
      expect(result.ok).toBe(false);
      expect(result.degraded).toBe(true);
      expect(result.reason).toMatch(/deterministic/i);
    });
  });

  it("reports an untouched budget", () => {
    expect(llm.budget().tokensUsed).toBe(0);
  });
});
