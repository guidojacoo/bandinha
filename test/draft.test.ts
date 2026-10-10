import { describe, expect, it } from "vitest";
import { validateDraft, verifyCitations, withFooter } from "../src/core/draft";
import { buildFooter } from "../src/core/compliance";
import type { DraftMessage } from "../src/core/types";
import { complianceConfig, offering } from "./fixtures";

const FOOTER = buildFooter(complianceConfig().sender);

function draft(over: Partial<DraftMessage> = {}): DraftMessage {
  return {
    subject: "40 microservices and one on-call rota",
    body: withFooter(
      [
        "Hi Priya,",
        "",
        "Your engineering page mentions a weekly on-call rota across 40 microservices.",
        "Northwind SLO tracks error budgets per service so the pager points at the one",
        "that is actually burning budget. Teams using it cut alert noise by two thirds.",
        "",
        "Worth fifteen minutes next week?",
        "",
        "Sam",
      ].join("\n"),
      FOOTER,
    ),
    citedEvidence: ["cut alert noise by two thirds", "Northwind SLO"],
    ...over,
  };
}

describe("verifyCitations", () => {
  it("accepts claims that trace back to the extracted offering", () => {
    expect(verifyCitations(draft(), offering()).ok).toBe(true);
  });

  /** The anti-fabrication check: models invent customer logos unprompted. */
  it("rejects an invented customer logo", () => {
    const d = draft({ citedEvidence: ["Used by Google and Netflix"] });
    const result = verifyCitations(d, offering());
    expect(result.ok).toBe(false);
    expect(result.unknown[0]).toContain("Google");
  });

  it("accepts a real proof point from the site", () => {
    expect(verifyCitations(draft({ citedEvidence: ["SOC 2 Type II certified"] }), offering()).ok).toBe(true);
  });
});

describe("validateDraft", () => {
  it("passes a clean, grounded, compliant message", () => {
    const result = validateDraft(draft(), offering());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects a message with no opt-out", () => {
    const d = draft({ body: "Hi Priya,\n\nWant to buy some observability tooling for your team today?\n\nSam" });
    const r = validateDraft(d, offering());
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/opt-out/);
  });

  it("rejects unrendered template placeholders", () => {
    for (const bad of ["Hi {{first_name}}", "Hi [FIRST_NAME]", "Hi {name}", "TODO: personalise"]) {
      const r = validateDraft(draft({ subject: bad }), offering());
      expect(r.ok, bad).toBe(false);
      expect(r.problems.join(" "), bad).toMatch(/placeholder/);
    }
  });

  it("rejects model self-disclosure artifacts", () => {
    const d = draft({ body: withFooter("Hi,\n\nAs an AI, I noticed your site mentions microservices and thought this might help your team.\n\nSam", FOOTER) });
    const r = validateDraft(d, offering());
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/as an AI/i);
  });

  it("rejects guaranteed-results and risk-free claims", () => {
    for (const claim of ["We guarantee ROI within 30 days.", "It is completely risk-free.", "100% guaranteed."]) {
      const d = draft({ body: withFooter(`Hi,\n\n${claim} Our product tracks error budgets for microservices teams everywhere.\n\nSam`, FOOTER) });
      expect(validateDraft(d, offering()).ok, claim).toBe(false);
    }
  });

  it("rejects a cold message faking a reply thread", () => {
    const r = validateDraft(draft({ subject: "Re: our conversation last week" }), offering());
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/fakes a reply/);
  });

  it("rejects shouting and spam-trigger language", () => {
    expect(validateDraft(draft({ subject: "ACT NOW LIMITED TIME ONLY OFFER" }), offering()).ok).toBe(false);
    const d = draft({ body: withFooter("Hi,\n\nClick here now to claim your free money bonus from our observability platform today.\n\nSam", FOOTER) });
    expect(validateDraft(d, offering()).ok).toBe(false);
  });

  it("rejects an over-long subject that clients would truncate", () => {
    const r = validateDraft(draft({ subject: "x".repeat(90) }), offering());
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/truncate/);
  });

  it("rejects an over-long body", () => {
    const r = validateDraft(draft({ body: withFooter("Hi,\n\n" + "word ".repeat(400), FOOTER) }), offering());
    expect(r.ok).toBe(false);
  });

  it("warns without failing on soft problems", () => {
    const d = draft({
      body: withFooter("Hi Priya,\n\nSee https://a.example https://b.example https://c.example https://d.example for the error budget details your microservices team needs.\n\nSam", FOOTER),
    });
    const r = validateDraft(d, offering());
    expect(r.warnings.join(" ")).toMatch(/links/);
  });
});

describe("withFooter", () => {
  it("appends the footer when the body has no opt-out", () => {
    expect(withFooter("Hello", FOOTER)).toContain("Unsubscribe");
  });

  it("does not double-append when one is already present", () => {
    const once = withFooter("Hello", FOOTER);
    expect(withFooter(once, FOOTER)).toBe(once);
  });
});

