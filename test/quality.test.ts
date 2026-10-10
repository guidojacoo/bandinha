import { describe, expect, it } from "vitest";
import {
  MIN_QUALITY, qualitySummary, repairInstructions, scoreQuality,
  stripGreetingAndSignoff,
} from "../src/core/quality";
import { lead } from "./factories";

const EVIDENCE = lead().evidence;
const NAMES = ["Fableworks", "Northwind", "Lena"];

function score(copy: string, subject = "on-call engineers paged", extra: Partial<Parameters<typeof scoreQuality>[0]> = {}) {
  return scoreQuality({ subject, copy, evidence: EVIDENCE, knownNames: NAMES, ...extra });
}

/** The message the agent should be producing. */
const GOOD = `Hi Lena,

Your on-call engineers are paged more than forty times a week, and most of
those alerts turn out to be noise. That is the part that burns people out —
not the incidents, the false ones.

Northwind watches the error budget instead of each error, so the pager only
goes off when the budget is actually burning.

Is alert noise something you are already working on, or has it just become
background?

Dana`;

/** The message a model produces when nobody is checking. */
const BAD = `Hi Lena,

I hope this email finds you well! My name is Dana and I am reaching out
because I came across Fableworks and wanted to connect.

We are a company that provides a best-in-class, cutting-edge observability
solution that helps world-class engineering teams leverage their data to
unlock seamless, end-to-end visibility across their entire ecosystem, and we
have been told we really move the needle for our customers in terms of the
value-add we bring to mission-critical workloads.

If you have a moment, I was wondering whether maybe you would possibly be
open to a quick call? What does your calendar look like? Would Tuesday work?

Thoughts?

Best,
Dana`;

describe("scoreQuality", () => {
  it("passes a specific, short, you-focused message", () => {
    const report = score(GOOD);
    expect(report.score).toBeGreaterThanOrEqual(MIN_QUALITY);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("fails the message a model writes when nobody is checking", () => {
    const report = score(BAD);
    expect(report.ok).toBe(false);
    expect(report.score).toBeLessThan(45);
  });

  it("separates the two by a wide margin, so the threshold is not a coin flip", () => {
    expect(score(GOOD).score - score(BAD).score).toBeGreaterThan(35);
  });

  it("names every problem with the bad one", () => {
    const ids = score(BAD).failures.map((f) => f.id);
    for (const id of ["filler", "jargon", "hedging", "ask", "about_them", "opening", "specificity"]) {
      expect(ids).toContain(id);
    }
  });

  it("does not flag length on a message that is bloated in style, not in words", () => {
    // 105 words, and bad for every other reason. A scorer that reported
    // "too long" here would send a model off fixing the wrong thing.
    expect(score(BAD).checks.find((c) => c.id === "length")!.value).toBe(1);
  });

  it("hands a model specific instructions rather than 'do better'", () => {
    const instructions = repairInstructions(score(BAD));
    expect(instructions.length).toBeGreaterThan(3);
    for (const instruction of instructions) expect(instruction.length).toBeGreaterThan(20);
  });
});

describe("length", () => {
  it("penalises a message past the point replies collapse", () => {
    const long = `Hi Lena,\n\nYour on-call engineers are paged forty times a week. ${"This is a sentence about that problem and what it costs you. ".repeat(14)}\n\nWorth a look?\n\nDana`;
    const check = score(long).checks.find((c) => c.id === "length")!;
    expect(check.value).toBeLessThan(0.6);
    expect(check.fix).toMatch(/Cut it/);
  });

  it("penalises a message too short to say anything", () => {
    expect(score("Hi Lena,\n\nInterested?\n\nDana").checks.find((c) => c.id === "length")!.value).toBeLessThan(0.5);
  });

  it("judges a reply on a shorter scale", () => {
    const reply = "Tuesday at ten works. I will send an invite with a short agenda.";
    expect(score(reply, "", { stage: "reply" }).checks.find((c) => c.id === "length")!.value).toBe(1);
  });
});

describe("opening", () => {
  it("rewards opening with their own words", () => {
    expect(score(GOOD).checks.find((c) => c.id === "opening")!.value).toBe(1);
  });

  it("penalises opening by talking about us", () => {
    const copy = "Hi Lena,\n\nWe build error budget tracking for platform teams. Your on-call engineers are paged forty times a week.\n\nWorth a word?\n\nDana";
    const check = score(copy).checks.find((c) => c.id === "opening")!;
    expect(check.value).toBeLessThan(0.6);
    expect(check.detail).toMatch(/about us/);
  });

  it("does not judge a reply on its opening", () => {
    expect(score("Thanks — Tuesday works.", "", { stage: "reply" }).checks.find((c) => c.id === "opening")!.weight).toBe(0);
  });

  it("does not mistake the greeting for the opening sentence", () => {
    // The first version scored every message's opening as "Hi Lena" and
    // reported it as unspecific.
    expect(stripGreetingAndSignoff(GOOD).startsWith("Your on-call engineers")).toBe(true);
  });
});

describe("the ask", () => {
  it("wants exactly one question, at the end", () => {
    expect(score(GOOD).checks.find((c) => c.id === "ask")!.value).toBe(1);
  });

  it("penalises an interrogation", () => {
    const copy = "Hi Lena,\n\nYour on-call engineers are paged forty times a week by noise. Is that a problem? Who owns it? Would you want to talk?\n\nDana";
    const check = score(copy).checks.find((c) => c.id === "ask")!;
    expect(check.value).toBeLessThan(0.5);
    expect(check.fix).toMatch(/exactly one question/);
  });

  it("penalises having no way to reply", () => {
    const copy = "Hi Lena,\n\nYour on-call engineers are paged more than forty times a week and most of it is noise. Northwind watches the error budget instead of each error.\n\nDana";
    expect(score(copy).checks.find((c) => c.id === "ask")!.value).toBeLessThan(0.5);
  });

  it("wants a breakup message to ask for nothing", () => {
    const copy = "Hi Lena,\n\nI will stop here rather than keep filling your inbox. If alert noise becomes somebody's problem to fix, replying to this will reach me.\n\nDana";
    expect(score(copy, "closing the loop", { stage: "breakup" }).checks.find((c) => c.id === "ask")!.value).toBe(1);
  });

  it("marks a breakup that still pitches", () => {
    const copy = "Hi Lena,\n\nI will stop here. But would you like a demo first?\n\nDana";
    expect(score(copy, "closing the loop", { stage: "breakup" }).checks.find((c) => c.id === "ask")!.value).toBeLessThan(1);
  });
});

describe("about them", () => {
  it("rewards copy weighted toward the reader", () => {
    expect(score(GOOD).checks.find((c) => c.id === "about_them")!.value).toBeGreaterThan(0.6);
  });

  it("penalises a brochure", () => {
    const copy = "Hi Lena,\n\nWe built our platform because we believe our customers deserve better. We have spent our careers on this and our team is proud of what we have made.\n\nShall we talk?\n\nDana";
    expect(score(copy).checks.find((c) => c.id === "about_them")!.value).toBeLessThan(0.5);
  });

  it("does not count the greeting or the signature", () => {
    // "Hi Lena" and "Dana" are not prose.
    const bare = stripGreetingAndSignoff("Hi Lena,\n\nYou are paged constantly.\n\nDana");
    expect(bare).toBe("You are paged constantly.");
  });
});

describe("filler, hedging and jargon", () => {
  it.each([
    "I hope this finds you well",
    "I came across your company",
    "Quick question for you",
    "Just following up on my last note",
    "circling back on this",
  ])("flags %s", (phrase) => {
    const copy = `Hi Lena,\n\n${phrase}. Your on-call engineers are paged more than forty times a week by noise.\n\nWorth a word?\n\nDana`;
    expect(score(copy).checks.find((c) => c.id === "filler")!.value).toBeLessThan(1);
  });

  it("flags hedged asks", () => {
    const copy = "Hi Lena,\n\nYour on-call engineers are paged forty times a week by noise. If you have a moment, I was wondering whether maybe you would be open to talking?\n\nDana";
    expect(score(copy).checks.find((c) => c.id === "hedging")!.value).toBeLessThan(0.5);
  });

  it("flags buzzwords", () => {
    const copy = "Hi Lena,\n\nYour on-call engineers are paged forty times a week. We leverage a best-in-class, seamless solution.\n\nWorth a word?\n\nDana";
    expect(score(copy).checks.find((c) => c.id === "jargon")!.value).toBeLessThan(0.5);
  });

  it("leaves clean copy alone", () => {
    for (const id of ["filler", "hedging", "jargon"] as const) {
      expect(score(GOOD).checks.find((c) => c.id === id)!.value).toBe(1);
    }
  });
});

describe("specificity", () => {
  it("rewards using their own sentence", () => {
    expect(score(GOOD).checks.find((c) => c.id === "specificity")!.value).toBeGreaterThan(0.6);
  });

  it("fails a form letter, however well written", () => {
    const copy = "Hello,\n\nMost engineering teams struggle with alert noise, and it is usually the pager that breaks people rather than the incidents.\n\nIs that something worth half an hour?\n\nDana";
    const check = score(copy).checks.find((c) => c.id === "specificity")!;
    expect(check.value).toBeLessThan(0.6);
    expect(check.fix).toMatch(/could only have been written to this company/);
  });
});

describe("formatting", () => {
  it("rejects a first touch that looks like a deck", () => {
    const copy = "Hi Lena,\n\nYour engineers are paged forty times a week.\n\n- Error budgets\n- Burn rate alerts\n- Kubernetes\n\nWorth a word?\n\nDana";
    expect(score(copy).checks.find((c) => c.id === "formatting")!.value).toBeLessThan(1);
  });

  it("rejects a marketing subject line", () => {
    expect(score(GOOD, "Transform Your Observability Strategy Today").checks.find((c) => c.id === "formatting")!.value).toBeLessThan(1);
  });

  it("accepts a short lowercase subject", () => {
    expect(score(GOOD, "forty pages a week").checks.find((c) => c.id === "formatting")!.value).toBe(1);
  });
});

describe("qualitySummary", () => {
  it("is one line an operator can read", () => {
    expect(qualitySummary(score(GOOD))).toMatch(/^\d+\/100$/);
    expect(qualitySummary(score(BAD))).toMatch(/—/);
  });
});
