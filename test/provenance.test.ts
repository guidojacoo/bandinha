import { describe, expect, it } from "vitest";
import { buildCorpus, isSupported, verifyProvenance } from "../src/core/provenance";
import type { ProvenanceRecord } from "../src/core/types";
import { claim, lead, offering } from "./factories";

describe("isSupported", () => {
  const source = "Northwind SLO tracks error budgets and alerts you before the budget burns out.";

  it("accepts an exact quote", () => {
    expect(isSupported("tracks error budgets", source)).toBe(true);
  });

  it("accepts a re-punctuated quote", () => {
    expect(isSupported("Northwind SLO tracks error budgets, and alerts you.", source)).toBe(true);
  });

  it("rejects an invented metric", () => {
    expect(isSupported("reduces alert volume by 60%", source)).toBe(false);
  });

  it("rejects a claim built from the source's own words in a new order", () => {
    expect(isSupported("error budgets burn out before Northwind alerts you, so you lose", source)).toBe(false);
  });

  it("requires short claims to match exactly, because there is no signal to fuzz", () => {
    expect(isSupported("error tracking", source)).toBe(false);
    expect(isSupported("error budgets", source)).toBe(true);
  });

  it("rejects an empty claim", () => {
    expect(isSupported("", source)).toBe(false);
  });
});

describe("verifyProvenance", () => {
  const corpus = buildCorpus(
    offering({ proofPoints: [claim("SOC 2 Type II certified since 2024.", "https://seller.test/security")] }),
    lead(),
  );

  const record = (over: Partial<ProvenanceRecord>): ProvenanceRecord => ({
    claim: "SOC 2 Type II certified since 2024.",
    source: "https://seller.test/security",
    kind: "seller",
    verified: false,
    ...over,
  });

  it("verifies a claim against the page it cites", () => {
    const verdict = verifyProvenance([record({})], corpus);
    expect(verdict.ok).toBe(true);
    expect(verdict.records[0]?.verified).toBe(true);
  });

  it("verifies a real claim attributed to the wrong page", () => {
    // Models misattribute constantly. Punishing that would block true claims.
    const verdict = verifyProvenance([record({ source: "https://seller.test/" })], corpus);
    expect(verdict.ok).toBe(true);
  });

  it("fails a fabricated certification", () => {
    const verdict = verifyProvenance([record({ claim: "ISO 27001 certified since 2019." })], corpus);
    expect(verdict.ok).toBe(false);
    expect(verdict.unverified).toHaveLength(1);
  });

  it("fails an invented customer", () => {
    const verdict = verifyProvenance(
      [record({ claim: "Teams at Siemens and Zalando run Northwind in production." })],
      corpus,
    );
    expect(verdict.ok).toBe(false);
  });

  it("verifies a quote taken from the prospect's own site", () => {
    const verdict = verifyProvenance([record({
      claim: "Our on-call engineers are paged more than forty times a week",
      source: "https://fableworks.test/engineering",
      kind: "prospect",
    })], corpus);
    expect(verdict.ok).toBe(true);
  });

  it("passes an empty claim list — nothing asserted, nothing to check", () => {
    expect(verifyProvenance([], corpus).ok).toBe(true);
  });

  it("marks claims unverified when the corpus is empty", () => {
    expect(verifyProvenance([record({})], new Map()).ok).toBe(false);
  });
});

describe("buildCorpus", () => {
  it("keeps extracted facts even when the crawl pages are gone", () => {
    const corpus = buildCorpus(offering());
    expect(isSupported("tracks error budgets for microservices teams", [...corpus.values()].join("\n"))).toBe(true);
  });

  it("merges several pages fetched from the same URL", () => {
    const corpus = buildCorpus(offering(), undefined, [
      { url: "https://seller.test/", text: "first chunk about uptime" },
      { url: "https://seller.test/", text: "second chunk about alerting" },
    ]);
    const text = corpus.get("https://seller.test/") ?? "";
    expect(text).toMatch(/first chunk/);
    expect(text).toMatch(/second chunk/);
  });
});
