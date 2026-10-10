import { describe, expect, it } from "vitest";
import { classifyReply, detectObjection, stripQuotedText } from "../src/core/classify";

/**
 * Misreading a reply is the most expensive mistake the agent can make: it
 * either keeps mailing somebody who said stop, or writes off a warm buyer.
 * Both have happened in testing, and both are in here.
 */
describe("classifyReply", () => {
  it.each([
    "Yes, this looks interesting — tell me more.",
    "This is relevant for us, we have exactly that problem with alert noise.",
  ])("reads interest: %s", (body) => {
    expect(["interested", "meeting_request"]).toContain(classifyReply(body).intent);
  });

  it.each([
    "Can we set up a call next week? Tuesday or Wednesday works.",
    "Happy to chat — what times suit you?",
    "Sure, worth a short call. Send an invite.",
  ])("reads a meeting request: %s", (body) => {
    expect(classifyReply(body).intent).toBe("meeting_request");
  });

  it.each([
    "What does pricing look like for a team of 30?",
    "How much is this per month?",
    "Can you send me a ballpark on cost?",
  ])("reads a pricing question: %s", (body) => {
    expect(classifyReply(body).intent).toBe("pricing_question");
    expect(classifyReply(body).needsHuman).toBe(true);
  });

  it.each([
    "Send over the contract and we'll get it signed this week.",
    "We're ready to move forward. What do you need from us?",
  ])("reads a commitment: %s", (body) => {
    const analysis = classifyReply(body);
    expect(analysis.intent).toBe("commitment");
    // The agent must never close its own deal.
    expect(analysis.needsHuman).toBe(true);
  });

  it.each([
    ["please remove me from your list", "unsubscribe"],
    ["Unsubscribe.", "unsubscribe"],
    ["Take me off this list and do not contact me again", "unsubscribe"],
    ["STOP", "unsubscribe"],
  ] as const)("reads an opt-out: %s", (body, expected) => {
    const analysis = classifyReply(body);
    expect(analysis.intent).toBe(expected);
    expect(analysis.mustStop).toBe(true);
  });

  it.each([
    "Mail delivery failed: returning message to sender. 550 5.1.1 user unknown",
    "Your message to lena@fableworks.test could not be delivered. Recipient address rejected.",
  ])("reads a bounce: %s", (body) => {
    const analysis = classifyReply(body);
    expect(analysis.intent).toBe("bounce");
    expect(analysis.mustStop).toBe(true);
  });

  it("reads an out-of-office without treating it as interest", () => {
    const analysis = classifyReply("I am out of the office until 3 March with limited access to email.");
    expect(analysis.intent).toBe("auto_reply");
    expect(analysis.mustStop).toBe(false);
  });

  it("treats an incumbent question as an objection, not a rejection", () => {
    // "We already use Datadog, what would you add?" was read as
    // not_interested and marked the deal lost. It is the most answerable
    // objection there is.
    const analysis = classifyReply("We already use Datadog. What would you add on top of that?");
    expect(analysis.intent).toBe("objection");
    expect(analysis.objection).toBe("incumbent");
  });

  it("downgrades a negative-sounding question to an objection", () => {
    const analysis = classifyReply("Not sure we need this — how is it different from what Prometheus gives us?");
    expect(analysis.intent).not.toBe("not_interested");
  });

  it("reads a flat no as not interested", () => {
    const analysis = classifyReply("Thanks but we're not interested.");
    expect(analysis.intent).toBe("not_interested");
    expect(analysis.mustStop).toBe(true);
  });

  it("reads a deferral as not now, and keeps the lead", () => {
    const analysis = classifyReply("Not a priority this quarter. Try me again after June.");
    expect(analysis.intent).toBe("not_now");
    expect(analysis.mustStop).toBe(false);
  });

  it("reads a referral", () => {
    const analysis = classifyReply("I'm not the right person for this — Marco in platform handles tooling.");
    expect(["referral", "wrong_person"]).toContain(analysis.intent);
  });

  it("falls back to unclear rather than guessing", () => {
    const analysis = classifyReply("ok");
    expect(analysis.intent).toBe("unclear");
    expect(analysis.needsHuman).toBe(true);
  });

  it("is not fooled by our own footer in a quoted reply", () => {
    // Our footer contains the word "unsubscribe". Classifying the quoted text
    // marked interested prospects as opt-outs.
    const body = [
      "Yes, let's talk. Tuesday at 10 works for me.",
      "",
      "On Mon, 9 Mar 2026 at 09:00, Dana Reyes <dana@seller.test> wrote:",
      "> Hi Lena, I noticed your on-call rotation is paged forty times a week.",
      "> To stop hearing from me, unsubscribe here: https://seller.test/unsubscribe",
      "> Seller Inc, 12 Rue Example, 75001 Paris, France",
    ].join("\n");
    expect(classifyReply(body).intent).toBe("meeting_request");
  });

  it("reads an opt-out buried under a polite preamble", () => {
    const analysis = classifyReply(
      "Thanks for reaching out, it does look useful and I'll keep you in mind. For now please remove me from your mailing list.",
    );
    expect(analysis.mustStop).toBe(true);
  });

  it("handles an empty body", () => {
    expect(classifyReply("").intent).toBe("unclear");
  });

  it("reports confidence between 0 and 1", () => {
    for (const body of ["unsubscribe", "what does pricing look like?", "ok", ""]) {
      const { confidence } = classifyReply(body);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  it("uses the subject line when the body says nothing", () => {
    expect(classifyReply("", "Undelivered Mail Returned to Sender").intent).toBe("bounce");
  });
});

describe("detectObjection", () => {
  it.each([
    ["too expensive for us right now", "price"],
    ["no budget until next year", "price"],
    ["we already use Datadog for this", "incumbent"],
    ["I'd need to check with my manager", "authority"],
    ["never heard of you, are you GDPR compliant?", "trust"],
    ["we don't have this problem", "need"],
    ["bad timing, we're mid-migration", "timing"],
  ] as const)("reads %s as %s", (body, kind) => {
    expect(detectObjection(body).kind).toBe(kind);
  });

  it("returns none when there is no objection", () => {
    expect(detectObjection("sounds good, send an invite").kind).toBe("none");
  });
});

describe("stripQuotedText", () => {
  it("drops the quoted original", () => {
    const stripped = stripQuotedText("My answer.\n\nOn Mon wrote:\n> original text here");
    expect(stripped).toContain("My answer.");
    expect(stripped).not.toContain("original text here");
  });

  it("drops an Outlook-style divider", () => {
    const stripped = stripQuotedText("Answer.\n\n-----Original Message-----\nFrom: Dana\nsecret");
    expect(stripped).not.toContain("secret");
  });

  it("leaves a reply with no quoting alone", () => {
    expect(stripQuotedText("Just a plain reply.").trim()).toBe("Just a plain reply.");
  });
});
