import { describe, expect, it } from "vitest";
import { compose, stageFor, templateDraft, topicOf, withFooter } from "../src/agent/compose";
import { buildFooter } from "../src/core/compliance";
import { quoteIsUsed, validateDraft } from "../src/core/draft";
import { buildCorpus } from "../src/core/provenance";
import { MIN_QUALITY, scoreQuality } from "../src/core/quality";
import { DEFAULT_SEQUENCE } from "../src/core/sequence";
import { NullLlm } from "../src/infra/llm";
import type { ComposeInput } from "../src/agent/compose";
import { lead, offering, sender } from "./factories";

const OFFERING = offering();
const PROSPECT = lead();
const FOOTER = buildFooter(sender);
const NAMES = ["Northwind", "Fableworks", "Lena", "Dana"];

function input(over: Partial<ComposeInput> = {}): ComposeInput {
  return {
    offering: OFFERING,
    profile: PROSPECT,
    contact: PROSPECT.publicContacts[0]!,
    step: DEFAULT_SEQUENCE.steps[0]!,
    sender,
    meetingLink: "https://cal.test/dana",
    ...over,
  };
}

function judge(message: { subject: string; body: string }, step: number, previous: Array<{ subject: string; body: string }> = []) {
  return scoreQuality({
    subject: message.subject,
    copy: message.body.replace(FOOTER, "").trim(),
    evidence: PROSPECT.evidence,
    knownNames: NAMES,
    stage: stageFor(DEFAULT_SEQUENCE.steps[step]!.intent),
    previousMessages: previous,
  });
}

/**
 * The property that matters most and is easiest to lose: a four-touch
 * sequence has to make four different arguments. The first version of the
 * templates ignored the step intent entirely and produced the same email four
 * times — each one scoring a perfect 100 on its own.
 */
describe("the whole sequence", () => {
  const sent: Array<{ subject: string; body: string }> = [];
  const drafts = DEFAULT_SEQUENCE.steps.map((step, index) => {
    const message = withFooter(templateDraft(input({ step, previousMessages: [...sent] })), sender);
    const report = judge(message, index, [...sent]);
    sent.push({ subject: message.subject, body: message.body });
    return { step, message, report };
  });

  it("clears the quality bar at every step", () => {
    for (const { step, report } of drafts) {
      expect(report.score, `step ${step.index + 1} (${step.intent}) scored ${report.score}`).toBeGreaterThanOrEqual(MIN_QUALITY);
    }
  });

  it("passes the truthfulness validator at every step", () => {
    for (const { step, message } of drafts) {
      const result = validateDraft(message, {
        sender,
        evidence: PROSPECT.evidence,
        corpus: buildCorpus(OFFERING, PROSPECT),
        allowedNames: NAMES,
        isFirstTouch: step.intent === "first_touch",
      });
      expect(result.problems, `step ${step.index + 1} (${step.intent})`).toEqual([]);
    }
  });

  it("never repeats an opening sentence", () => {
    const openings = drafts.map(({ message }) =>
      message.body.split("\n").filter(Boolean)[1]?.slice(0, 50) ?? "");
    expect(new Set(openings).size).toBe(openings.length);
  });

  it("only draws on their site on the first touch", () => {
    // A follow-up that re-reads their own sentence back to them is the agent
    // forgetting it has already spoken to this person.
    const quote = PROSPECT.evidence[0]!.quote;
    expect(quoteIsUsed(quote, drafts[0]!.message.body)).toBe(true);
    for (const { step, message } of drafts.slice(1)) {
      expect(quoteIsUsed(quote, message.body.replace(FOOTER, "")), `step ${step.index + 1}`).toBe(false);
    }
  });

  it("asks exactly one question per step, and none on the breakup", () => {
    for (const { step, message } of drafts) {
      const copy = message.body.replace(FOOTER, "");
      const questions = (copy.match(/\?/g) ?? []).length;
      expect(questions, `step ${step.index + 1} (${step.intent})`).toBe(step.intent === "breakup" ? 0 : 1);
    }
  });

  it("disqualifies a resend outright rather than marking it down", () => {
    // Guard on the guard. A resend scores well on every other check —
    // it was a good email the first time — so a weighted average cannot
    // express that it is fatal.
    const first = drafts[0]!.message;
    const repeat = judge(first, 1, [{ subject: first.subject, body: first.body }]);
    expect(repeat.ok).toBe(false);
    expect(repeat.disqualifiedBecause).toMatch(/already sent/);
    expect(repeat.failures.map((f) => f.id)).toContain("freshness");
  });

  it("makes no unverifiable claim on a follow-up that asserts nothing", () => {
    // The second touch deliberately carries no provenance, because it makes
    // no factual claim — the argument was made in message one.
    expect(drafts[1]!.message.provenance).toEqual([]);
  });

  it("says plainly when there is no proof to show", () => {
    const noProof = withFooter(
      templateDraft(input({ offering: offering({ proofPoints: [] }), step: DEFAULT_SEQUENCE.steps[2]! })),
      sender,
    );
    expect(noProof.body).toMatch(/nothing to show you|without talking to me/i);
    expect(noProof.body).not.toMatch(/customers (?:like|including)/i);
  });
});

describe("the ask", () => {
  it("asks about their situation, not their calendar", () => {
    const body = templateDraft(input()).body;
    expect(body).toMatch(/already working on|become background/i);
    expect(body).not.toMatch(/do you have (?:fifteen|15|a few) minutes/i);
  });

  it("still offers the booking link for the ones who are ready", () => {
    expect(templateDraft(input()).body).toContain("https://cal.test/dana");
  });

  it("drops the link when there is none", () => {
    const body = templateDraft(input({ meetingLink: undefined })).body;
    expect(body).not.toMatch(/https:\/\/cal/);
    expect(body).toMatch(/\?$/m);
  });
});

describe("topicOf", () => {
  it("uses the matched signal when it is a usable phrase", () => {
    expect(topicOf({ signal: "on-call", quote: "x".repeat(50), source: "s" })).toBe("on-call");
  });

  it("falls back to the quote's distinctive words", () => {
    const topic = topicOf({
      signal: "",
      quote: "Our deployment pipeline takes eleven minutes and blocks everybody else.",
      source: "s",
    });
    expect(topic).toMatch(/deployment|pipeline/);
  });

  it("never returns an empty topic", () => {
    expect(topicOf({ signal: "", quote: "a b c", source: "s" })).toBe("this");
  });
});

describe("compose with no model available", () => {
  it("returns the template, scored, with the attempt recorded", async () => {
    const result = await compose(input(), new NullLlm());
    expect(result.via).toBe("template");
    expect(result.validation.ok).toBe(true);
    expect(result.quality.score).toBeGreaterThanOrEqual(MIN_QUALITY);
    expect(result.attempts).toEqual([
      { via: "template", score: result.quality.score, problems: [], failures: result.quality.failures.map((f) => f.label) },
    ]);
  });
});
