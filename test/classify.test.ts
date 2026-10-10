import { describe, expect, it } from "vitest";
import { classifyReply, detectObjection, stripQuotedText } from "../src/core/classify";

describe("stripQuotedText", () => {
  /**
   * Without this the classifier reads our own footer back: every outbound
   * message contains the word "unsubscribe", so every reply looked like an
   * opt-out and the whole pipeline would halt on first contact.
   */
  it("removes the quoted original so our own footer is not classified", () => {
    const reply = [
      "Sounds interesting, can you send pricing?",
      "",
      "On Mon, 2 Mar 2026 at 10:02, Sam <sam@northwind.example> wrote:",
      "> Hi Priya — quick question about your on-call rota.",
      "> Not relevant? Unsubscribe: https://northwind.example/unsubscribe",
    ].join("\n");
    const stripped = stripQuotedText(reply);
    expect(stripped).toContain("send pricing");
    expect(stripped.toLowerCase()).not.toContain("unsubscribe");
  });

  it("handles Outlook separators and mobile signatures", () => {
    expect(stripQuotedText("No thanks.\n-----Original Message-----\nFrom: Sam")).toBe("No thanks.");
    expect(stripQuotedText("Interested!\nSent from my iPhone")).toBe("Interested!");
  });
});

describe("opt-out detection", () => {
  it("catches the many ways people ask to be removed", () => {
    for (const body of [
      "Please unsubscribe me.",
      "Take me off this list.",
      "Remove me from your database.",
      "Stop emailing me.",
      "Do not contact me again.",
      "opt out please",
      "Please delete my data.",
      "No further emails thanks",
    ]) {
      const r = classifyReply(body);
      expect(r.intent, body).toBe("unsubscribe");
      expect(r.mustStop, body).toBe(true);
    }
  });

  it("does not fire on our own quoted footer", () => {
    const reply = "Yes let's book a call.\n\n> Not relevant? Unsubscribe: https://x.example/u";
    expect(classifyReply(reply).intent).not.toBe("unsubscribe");
  });

  it("outranks every other reading in the same message", () => {
    const r = classifyReply("This looks interesting but please remove me from your list.");
    expect(r.intent).toBe("unsubscribe");
    expect(r.mustStop).toBe(true);
  });
});

describe("bounces and auto-replies", () => {
  it("detects delivery failures", () => {
    for (const body of [
      "Delivery Status Notification (Failure)",
      "550-5.1.1 The email account that you tried to reach does not exist",
      "Mail delivery failed: returning message to sender",
      "Address not found",
    ]) {
      const r = classifyReply(body);
      expect(r.intent, body).toBe("bounce");
      expect(r.mustStop, body).toBe(true);
    }
  });

  it("detects out-of-office without treating it as disinterest", () => {
    const r = classifyReply("Automatic reply: I am currently away and will be back on 14 March.");
    expect(r.intent).toBe("auto_reply");
    expect(r.mustStop).toBe(false);
    expect(r.needsHuman).toBe(false);
  });
});

describe("intent classification", () => {
  const cases: Array<[string, string]> = [
    ["Happy to chat — what's your availability next week?", "meeting_request"],
    ["Can you send me a quote? What's the pricing per seat?", "pricing_question"],
    ["This sounds interesting, tell me more.", "interested"],
    ["I'm not the right person, try our head of platform.", "wrong_person"],
    ["Not right now, circle back in Q3.", "not_now"],
    ["Not interested, we're all set.", "not_interested"],
  ];

  for (const [body, expected] of cases) {
    it(`reads "${body.slice(0, 38)}…" as ${expected}`, () => {
      expect(classifyReply(body).intent).toBe(expected);
    });
  }

  it("flags an unreadable reply for a human instead of guessing", () => {
    const r = classifyReply("ok");
    expect(r.intent).toBe("unclear");
    expect(r.needsHuman).toBe(true);
    expect(r.confidence).toBeLessThan(0.5);
  });

  it("routes referrals and wrong-person replies to a human", () => {
    expect(classifyReply("Forwarding this to Dana who owns it.").needsHuman).toBe(true);
    expect(classifyReply("Wrong person — not my department.").needsHuman).toBe(true);
  });

  it("stops the cadence on a flat no", () => {
    expect(classifyReply("Not interested.").mustStop).toBe(true);
  });
});

describe("regressions from the end-to-end run", () => {
  /**
   * A warm buyer asked "What does pricing look like for a team of about 30
   * engineers?" and it classified as `unclear`, which routed the reply to a
   * human and stalled the deal for the rest of the simulation.
   */
  it("reads the common phrasings of a pricing question", () => {
    for (const body of [
      "What does pricing look like for a team of about 30 engineers?",
      "How much would this be for 50 seats?",
      "Can you send me a ballpark?",
      "What is your pricing?",
      "What would it cost us?",
    ]) {
      expect(classifyReply(body).intent, body).toBe("pricing_question");
    }
  });

  /**
   * "We already use Datadog ... what is different?" classified as
   * `not_interested`, which marked the deal lost. An incumbent objection with
   * a question in it is the most winnable reply there is.
   */
  it("treats an incumbent mention as an objection, not a refusal", () => {
    const r = classifyReply(
      "We already use Datadog for most of this, so I am not sure what you would add. What is different?",
    );
    expect(r.intent).toBe("objection");
    expect(r.objection).toBe("incumbent");
    expect(r.mustStop).toBe(false);
  });

  it("still treats an unambiguous refusal as one", () => {
    for (const body of ["Not interested.", "No thanks, we're all set.", "Not a fit for us."]) {
      const r = classifyReply(body);
      expect(r.intent, body).toBe("not_interested");
      expect(r.mustStop, body).toBe(true);
    }
  });

  it("does not let a trailing question rescue a flat no with no objection in it", () => {
    const r = classifyReply("Not interested. Who gave you my address?");
    expect(r.intent).toBe("not_interested");
  });
});

describe("objection detection", () => {
  it("names the objection behind a negative reply", () => {
    expect(detectObjection("way too expensive for us").kind).toBe("price");
    expect(detectObjection("we already use Datadog").kind).toBe("incumbent");
    expect(detectObjection("I'd need sign-off from procurement").kind).toBe("authority");
    expect(detectObjection("never heard of you, do you have case studies?").kind).toBe("trust");
    expect(detectObjection("bad timing, too busy this quarter").kind).toBe("timing");
    expect(detectObjection("thanks!").kind).toBe("none");
  });

  it("attaches the objection to an objection-intent reply", () => {
    const r = classifyReply("Looks useful but it's too expensive and we already use Datadog.");
    expect(["objection", "not_interested"]).toContain(r.intent);
    expect(r.objection).not.toBe("none");
  });
});
