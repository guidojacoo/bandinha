import { describe, expect, it } from "vitest";
import {
  MIN_SENDS_PER_VALUE, analyse, analyseAll, brief, qualityBand, rate,
  subjectBand, wilsonLowerBound, wilsonUpperBound, type Outcome,
} from "../src/core/learning";

function outcomes(spec: Array<{ value: string; sent: number; replies: number; positives?: number }>, dimension = "pain_signal" as const): Outcome[] {
  const out: Outcome[] = [];
  for (const group of spec) {
    for (let i = 0; i < group.sent; i++) {
      const replied = i < group.replies;
      out.push({
        attributes: { [dimension]: group.value },
        replied,
        positive: replied && i < (group.positives ?? group.replies),
        bounced: false,
        optedOut: false,
      });
    }
  }
  return out;
}

/**
 * The scorer in core/quality.ts measures whether copy *looks* like copy that
 * gets replies. This measures whether it *did*, which is a different question
 * — the scorer encodes what is known about cold email in general, and a
 * market is specific.
 */
describe("ranking by the lower bound, not the rate", () => {
  it("does not let one reply from one send outrank forty from two hundred", () => {
    // The failure mode of every dashboard that sorts by percentage.
    const report = analyse(outcomes([
      { value: "lucky", sent: 1, replies: 1 },
      { value: "proven", sent: 200, replies: 40 },
    ]), "pain_signal");

    expect(report.findings[0]!.value).toBe("proven");
    expect(report.findings.find((f) => f.value === "lucky")!.verdict).toBe("too_early");
  });

  it("prefers the larger sample when two rates are equal", () => {
    const report = analyse(outcomes([
      { value: "small", sent: 20, replies: 2 },
      { value: "large", sent: 200, replies: 20 },
    ]), "pain_signal");
    expect(report.findings[0]!.value).toBe("large");
  });

  it("still reports the raw rate, so a human can see both", () => {
    const report = analyse(outcomes([{ value: "x", sent: 100, replies: 7 }]), "pain_signal");
    expect(report.findings[0]!.replyRate).toBeCloseTo(0.07, 4);
    expect(report.findings[0]!.lowerBound).toBeLessThan(0.07);
  });
});

describe("refusing to answer", () => {
  it("says nothing at all below the sample threshold", () => {
    const report = analyse(outcomes([
      { value: "a", sent: 4, replies: 2 },
      { value: "b", sent: 3, replies: 0 },
    ]), "pain_signal");
    expect(report.tooEarly).toMatch(/none with the 12 needed/);
    expect(report.recommendation).toBeUndefined();
  });

  it("frames too little data as the caps working, not as a fault", () => {
    // An agent that apologises for low volume teaches its operator to want
    // more volume, which is the thing that burns the domain.
    expect(analyse(outcomes([{ value: "a", sent: 4, replies: 2 }]), "pain_signal").tooEarly).toMatch(/volume caps working/);
  });

  it("handles a dimension with nothing in it", () => {
    const report = analyse([], "discovery_source");
    expect(report.findings).toEqual([]);
    expect(report.tooEarly).toBe("Nothing sent yet.");
  });

  it("skips outcomes that have no value for the dimension", () => {
    const mixed: Outcome[] = [
      { attributes: { pain_signal: "on-call" }, replied: true, positive: true, bounced: false, optedOut: false },
      { attributes: {}, replied: true, positive: true, bounced: false, optedOut: false },
    ];
    const report = analyse(mixed, "pain_signal");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.sent).toBe(1);
  });

  it("declines to pick a winner when the intervals overlap", () => {
    // 3/20 against 2/20 is not a finding, however much it looks like one.
    const report = analyse(outcomes([
      { value: "a", sent: 20, replies: 3 },
      { value: "b", sent: 20, replies: 2 },
    ]), "pain_signal");
    expect(report.recommendation).toMatch(/samples overlap/);
    expect(report.recommendation).toMatch(/not enough to call it/);
  });

  it("picks a winner when the intervals genuinely separate", () => {
    const report = analyse(outcomes([
      { value: "on-call", sent: 200, replies: 40 },
      { value: "kubernetes", sent: 200, replies: 2 },
    ]), "pain_signal");
    expect(report.recommendation).toMatch(/on-call/);
    expect(report.recommendation).toMatch(/difference holds up/);
  });

  it("says plainly that a finding is observed rather than tested", () => {
    // It cannot establish cause, and claiming otherwise is the difference
    // between a useful instrument and a lying one.
    const report = analyse(outcomes([
      { value: "on-call", sent: 200, replies: 40 },
      { value: "kubernetes", sent: 200, replies: 2 },
    ]), "pain_signal");
    expect(report.recommendation).toMatch(/observed, not tested/);
  });
});

describe("verdicts", () => {
  it.each([
    [200, 2, "weak"],
    [200, 10, "working"],
    [400, 80, "strong"],
    [5, 5, "too_early"],
  ] as const)("calls %i sends with %i replies %s", (sent, replies, verdict) => {
    expect(analyse(outcomes([{ value: "x", sent, replies }]), "pain_signal").findings[0]!.verdict).toBe(verdict);
  });

  it("needs a real sample before calling anything strong", () => {
    // 100% of twelve is not strong, it is twelve.
    const report = analyse(outcomes([{ value: "x", sent: MIN_SENDS_PER_VALUE, replies: MIN_SENDS_PER_VALUE }]), "pain_signal");
    expect(report.findings[0]!.verdict).toBe("strong");
    expect(report.findings[0]!.lowerBound).toBeLessThan(1);
  });
});

describe("counts carried alongside the rates", () => {
  it("keeps bounces and opt-outs per value", () => {
    const list: Outcome[] = [
      { attributes: { discovery_source: "npm" }, replied: false, positive: false, bounced: true, optedOut: false },
      { attributes: { discovery_source: "npm" }, replied: true, positive: false, bounced: false, optedOut: true },
    ];
    const finding = analyse(list, "discovery_source").findings[0]!;
    expect(finding.bounces).toBe(1);
    expect(finding.optOuts).toBe(1);
  });

  it("separates a reply from a useful reply", () => {
    const report = analyse(outcomes([{ value: "x", sent: 100, replies: 20, positives: 4 }]), "pain_signal");
    expect(report.findings[0]!.replyRate).toBeCloseTo(0.2, 4);
    expect(report.findings[0]!.positiveRate).toBeCloseTo(0.04, 4);
  });
});

describe("the Wilson interval", () => {
  it("stays inside zero and one at n = 1", () => {
    // The normal approximation returns a negative lower bound here, which is
    // why it is not used.
    expect(wilsonLowerBound(1, 1)).toBeGreaterThan(0);
    expect(wilsonLowerBound(1, 1)).toBeLessThan(1);
    expect(wilsonLowerBound(0, 1)).toBe(0);
    expect(wilsonUpperBound(0, 1)).toBeLessThan(1);
  });

  it("tightens as the sample grows", () => {
    const narrow = wilsonUpperBound(100, 1_000) - wilsonLowerBound(100, 1_000);
    const wide = wilsonUpperBound(1, 10) - wilsonLowerBound(1, 10);
    expect(narrow).toBeLessThan(wide);
  });

  it("brackets the observed rate", () => {
    for (const [successes, total] of [[7, 100], [40, 200], [1, 3], [0, 50]] as const) {
      const p = successes / total;
      expect(wilsonLowerBound(successes, total)).toBeLessThanOrEqual(p);
      expect(wilsonUpperBound(successes, total)).toBeGreaterThanOrEqual(p);
    }
  });

  it("handles an empty sample without dividing by zero", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonUpperBound(0, 0)).toBe(1);
  });
});

describe("analyseAll", () => {
  it("puts targeting ahead of wording", () => {
    // Changing who you contact matters more than changing what you say.
    const order = analyseAll([]).map((r) => r.dimension);
    expect(order[0]).toBe("pain_signal");
    expect(order[1]).toBe("discovery_source");
    expect(order.indexOf("subject_length")).toBeGreaterThan(order.indexOf("pain_signal"));
  });

  it("explains why each dimension is worth looking at", () => {
    for (const report of analyseAll([])) {
      expect(report.note.length).toBeGreaterThan(60);
    }
  });
});

describe("brief", () => {
  it("passes a finding to the composer only once it holds up", () => {
    const strong = analyseAll(outcomes([
      { value: "on-call", sent: 200, replies: 40 },
      { value: "kubernetes", sent: 200, replies: 2 },
    ]));
    expect(brief(strong).join(" ")).toMatch(/on-call/);
  });

  it("stays silent on a finding that does not", () => {
    // A 14-send coincidence must not become the house style.
    const weak = analyseAll(outcomes([
      { value: "a", sent: 14, replies: 3 },
      { value: "b", sent: 14, replies: 2 },
    ]));
    expect(brief(weak)).toEqual([]);
  });

  it("stays silent when there is nothing at all", () => {
    expect(brief(analyseAll([]))).toEqual([]);
  });
});

describe("banding", () => {
  it.each([[95, "90-100"], [80, "75-89"], [65, "62-74"], [40, "below the bar"]] as const)(
    "puts a score of %i in %s", (score, band) => {
      expect(qualityBand(score)).toBe(band);
    });

  it.each([
    ["", "none (a reply in thread)"],
    ["forty pages", "1-3 words"],
    ["forty pages a week", "4-5 words"],
    ["improving your observability strategy today for teams", "6 or more words"],
  ] as const)("bands the subject %s", (subject, band) => {
    expect(subjectBand(subject)).toBe(band);
  });
});

describe("rate", () => {
  it("keeps precision where cold-email rates live", () => {
    expect(rate(0)).toBe("0%");
    expect(rate(0.04)).toBe("4.0%");
    expect(rate(0.2)).toBe("20%");
  });
});
