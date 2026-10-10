import { describe, expect, it } from "vitest";
import { buildFooter } from "../src/core/compliance";
import { validateDraft, quoteIsUsed, type DraftContext } from "../src/core/draft";
import { buildCorpus } from "../src/core/provenance";
import type { DraftMessage } from "../src/core/types";
import { lead, offering, sender } from "./factories";

const PROSPECT = lead();
const OFFERING = offering();
const FOOTER = buildFooter(sender);

function context(over: Partial<DraftContext> = {}): DraftContext {
  return {
    sender,
    evidence: PROSPECT.evidence,
    corpus: buildCorpus(OFFERING, PROSPECT),
    allowedNames: ["Northwind", "Northwind SLO", "Fableworks", "Lena", "Dana Reyes"],
    ...over,
  };
}

const GOOD_BODY = [
  "Hi Lena,",
  "",
  "You wrote that your on-call engineers are paged more than forty times a week and that most",
  "of those alerts are noise. That is the problem Northwind SLO exists for: it tracks error",
  "budgets so the pager only goes off when the budget is actually burning.",
  "",
  "Worth fifteen minutes to see whether it fits how Fableworks runs its rotation?",
  "",
  "Dana",
  "",
  FOOTER,
].join("\n");

function draft(over: Partial<DraftMessage> = {}): DraftMessage {
  return {
    subject: "forty pages a week",
    body: GOOD_BODY,
    provenance: [
      {
        claim: "your on-call engineers are paged more than forty times a week",
        source: "https://fableworks.test/engineering",
        kind: "prospect",
        verified: false,
      },
      {
        claim: "tracks error budgets",
        source: "offering:seller.test",
        kind: "seller",
        verified: false,
      },
    ],
    ...over,
  };
}

describe("validateDraft", () => {
  it("passes a specific, sourced, compliant message", () => {
    const result = validateDraft(draft(), context());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // --- mechanics ---------------------------------------------------------
  it("rejects an unfilled placeholder", () => {
    const result = validateDraft(draft({ body: GOOD_BODY.replace("Lena", "{{first_name}}") }), context());
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/placeholder/i);
  });

  it.each(["[FIRST_NAME]", "[company]", "<name>", "TODO"])("rejects the placeholder %s", (token) => {
    const result = validateDraft(draft({ body: GOOD_BODY.replace("Lena", token) }), context());
    expect(result.ok).toBe(false);
  });

  it("rejects a subject that is really a paragraph", () => {
    const result = validateDraft(draft({ subject: "a".repeat(120) }), context());
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/Subject/);
  });

  it("rejects an empty subject on a cold email", () => {
    expect(validateDraft(draft({ subject: "  " }), context()).ok).toBe(false);
  });

  it("allows an empty subject on a reply, where the thread already has one", () => {
    const result = validateDraft(draft({ subject: "" }), context({ isReply: true }));
    expect(result.problems.join(" ")).not.toMatch(/Subject/);
  });

  it("rejects a body too short to say anything", () => {
    expect(validateDraft(draft({ body: `Hi Lena, can we talk?\n\n${FOOTER}` }), context()).ok).toBe(false);
  });

  // --- legal footer ------------------------------------------------------
  it("refuses a message with no postal address", () => {
    const result = validateDraft(draft({ body: GOOD_BODY.replace(FOOTER, "Dana") }), context());
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/postal address/i);
  });

  it("refuses a message with no way out", () => {
    const stripped = GOOD_BODY.replace(FOOTER, sender.postalAddress);
    const result = validateDraft(draft({ body: stripped }), context());
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/opt out/i);
  });

  it("accepts a plain-language opt-out instead of a link", () => {
    const body = GOOD_BODY.replace(FOOTER, `Reply "stop" and I'll leave you alone.\n${sender.postalAddress}`);
    const result = validateDraft(draft({ body }), context());
    expect(result.problems.join(" ")).not.toMatch(/opt out/i);
  });

  // --- fabrication -------------------------------------------------------
  it.each([
    ["customer counts", "Trusted by over 4,000 engineering teams."],
    ["press", "As featured in TechCrunch."],
    ["affiliation", "We are YC-backed and Fortune 500 approved."],
    ["superlatives", "The industry-leading error budget platform."],
    ["quantified outcomes", "Teams see 60% fewer pages in the first month."],
    ["guarantees", "Guaranteed to cut your alert volume."],
    ["named customers", "Our customers including Siemens rely on this."],
  ])("refuses an unsupported %s claim", (_label, sentence) => {
    const body = GOOD_BODY.replace("Dana", `${sentence}\n\nDana`);
    const result = validateDraft(draft({ body }), context());
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/Unsupported/);
  });

  it("refuses a claim that cannot be traced to any crawled page", () => {
    const result = validateDraft(draft({
      provenance: [{
        claim: "Northwind is ISO 27001 certified.",
        source: "https://seller.test/security",
        kind: "seller",
        verified: false,
      }],
    }), context());
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/not traceable/i);
  });

  it("allows a quantified claim that the seller actually published", () => {
    const published = offering({
      proofPoints: [{ text: "Customers cut pager volume by 40% in the first quarter.", source: "https://seller.test/customers" }],
    });
    const body = GOOD_BODY.replace("Dana", "You published that customers cut pager volume by 40% in the first quarter.\n\nDana");
    const result = validateDraft(
      draft({
        body,
        provenance: [
          ...draft().provenance,
          { claim: "cut pager volume by 40% in the first quarter", source: "https://seller.test/customers", kind: "seller", verified: false },
        ],
      }),
      context({ corpus: buildCorpus(published, PROSPECT) }),
    );
    expect(result.problems.join(" ")).not.toMatch(/Unsupported/);
  });

  it("warns about a name nothing crawled mentions", () => {
    const body = GOOD_BODY.replace("Dana", "Ask Gartner Research about it.\n\nDana");
    const result = validateDraft(draft({ body }), context());
    expect(result.warnings.join(" ")).toMatch(/Gartner/);
  });

  // --- specificity -------------------------------------------------------
  it("refuses a generic email even when every claim is true", () => {
    // This is the gate's whole point: attaching a quote to the provenance
    // list and then writing boilerplate defeats it.
    const generic = [
      "Hi Lena,",
      "",
      "I am reaching out because Northwind SLO tracks error budgets and I think it could be a",
      "great fit for your team. We work with engineering organisations of all sizes and would",
      "love to show you what we have built.",
      "",
      "Do you have fifteen minutes this week?",
      "",
      "Dana",
      "",
      FOOTER,
    ].join("\n");
    const result = validateDraft(draft({
      body: generic,
      provenance: [{ claim: "tracks error budgets", source: "offering:seller.test", kind: "seller", verified: false }],
    }), context());
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/specific/i);
  });

  it("does not demand fresh evidence in a reply", () => {
    const body = `Thanks Lena — Tuesday at 10 works. I'll send an invite.\n\nMore detail on how the burn rate alerts work when we talk.\n\nDana\n\n${FOOTER}`;
    const result = validateDraft(
      draft({ body, subject: "", provenance: [] }),
      context({ isReply: true }),
    );
    expect(result.problems.join(" ")).not.toMatch(/specific/i);
  });

  // --- spam hygiene (warnings, not blocks) -------------------------------
  it("warns rather than blocks on spam-filter triggers", () => {
    const body = GOOD_BODY.replace("Dana", "Act now, this is a limited time offer!!\n\nDana");
    const result = validateDraft(draft({ body }), context());
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.problems.join(" ")).not.toMatch(/urgency/);
  });

  it("warns when there is no question to answer", () => {
    const body = GOOD_BODY.replace("Worth fifteen minutes to see whether it fits how Fableworks runs its rotation?", "I thought it was worth mentioning.");
    expect(validateDraft(draft({ body }), context()).warnings.join(" ")).toMatch(/no easy way to reply/i);
  });
});

describe("quoteIsUsed", () => {
  const quote = "Our on-call engineers are paged more than forty times a week and most alerts are noise.";

  it("recognises a paraphrase", () => {
    expect(quoteIsUsed(quote, "You mentioned your engineers get paged forty times weekly by noisy alerts.")).toBe(true);
  });

  it("rejects boilerplate that happens to share filler words", () => {
    expect(quoteIsUsed(quote, "We work with engineering teams of all sizes and would love to show you more.")).toBe(false);
  });

  it("handles an empty quote", () => {
    expect(quoteIsUsed("", "anything at all")).toBe(false);
  });
});
