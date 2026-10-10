/**
 * What is actually working, and the honesty to say when you cannot tell.
 *
 * The quality scorer in `core/quality.ts` measures whether copy *looks* like
 * copy that gets replies. This measures whether it *did* — and the two are
 * different questions, because the scorer encodes what is known about cold
 * email in general and a market is specific.
 *
 * Three decisions shape all of it:
 *
 * **It is observational, not an experiment.** A proper A/B test needs
 * hundreds of sends per arm, and the volume caps here are deliberately low
 * because volume is what destroys senders. So this measures attributes of
 * messages that were sent anyway. That means it finds correlation and cannot
 * establish cause, and saying so plainly is the difference between a useful
 * instrument and a lying one.
 *
 * **It ranks by the lower bound, not the rate.** One reply from one send is a
 * 100% reply rate and tells you nothing. Forty from two hundred is 20% and
 * tells you a lot. Ranking by the raw rate puts the first above the second
 * every time, which is how dashboards end up recommending whatever happens to
 * be newest. A Wilson lower bound asks instead: given this sample, what is
 * the worst the true rate plausibly is? — and that ordering is stable.
 *
 * **It refuses to answer when it cannot.** Every finding carries its sample
 * size and a verdict, and below a threshold the verdict is "not enough yet"
 * rather than a number. An agent that reports a confident-sounding figure
 * from four sends teaches its operator to distrust everything it says.
 *
 * The most valuable findings are not about the copy. They are about which
 * pain signal and which discovery source produced the prospects who replied
 * — because those change who gets contacted, which matters more than how.
 */

export type Dimension =
  | "pain_signal"
  | "discovery_source"
  | "step_intent"
  | "composed_via"
  | "quality_band"
  | "subject_length"
  | "contact_kind";

export const DIMENSION_LABEL: Record<Dimension, string> = {
  pain_signal: "The problem they wrote about",
  discovery_source: "Where the lead came from",
  step_intent: "Which touch in the sequence",
  composed_via: "How the copy was written",
  quality_band: "Copy quality band",
  subject_length: "Subject line length",
  contact_kind: "Named person or shared inbox",
};

/** Why each dimension is worth looking at, for the console. */
export const DIMENSION_NOTE: Record<Dimension, string> = {
  pain_signal:
    "The most actionable thing here. If prospects who wrote about on-call pain reply and prospects who merely mention Kubernetes do not, the ICP is wrong and no amount of better copy fixes it.",
  discovery_source:
    "Which free source produces prospects who answer. A source with a good reply rate deserves more of the run's budget than one that merely returns more companies.",
  step_intent:
    "Whether the follow-ups earn their place. A sequence whose second touch never gets a reply is three wasted sends and a reputation cost.",
  composed_via:
    "Whether the model is beating the deterministic template in this market. If it is not, the template is cheaper and more predictable.",
  quality_band:
    "Whether the quality scorer is measuring anything real here. If high-scoring copy does not reply better, the scorer is encoding the wrong things for this market.",
  subject_length:
    "Short subject lines are generally better; this says whether they are better here.",
  contact_kind:
    "Whether writing to a named person beats a shared inbox by enough to justify how much harder they are to find.",
};

/** One message that was sent, and what came of it. */
export interface Outcome {
  /** Values of each dimension for this message. A missing one is skipped. */
  attributes: Partial<Record<Dimension, string>>;
  /** Did a human reply at all? */
  replied: boolean;
  /** Did they reply with interest, a meeting, a price question or a commitment? */
  positive: boolean;
  bounced: boolean;
  optedOut: boolean;
}

export interface Finding {
  value: string;
  sent: number;
  replies: number;
  positives: number;
  bounces: number;
  optOuts: number;
  replyRate: number;
  positiveRate: number;
  /** The worst the reply rate plausibly is, given the sample. Used to rank. */
  lowerBound: number;
  verdict: "too_early" | "weak" | "working" | "strong";
}

export interface DimensionReport {
  dimension: Dimension;
  label: string;
  note: string;
  /** Best first, by lower bound. */
  findings: Finding[];
  /** Set when nothing in this dimension has a usable sample yet. */
  tooEarly?: string;
  /**
   * The gap worth acting on, when there is one.
   *
   * Only populated when two values both have usable samples *and* their
   * intervals do not overlap — which is the only circumstance in which
   * "this one is better" is a defensible thing to say.
   */
  recommendation?: string;
}

/** Below this many sends, a value gets no rate at all. */
export const MIN_SENDS_PER_VALUE = Number(process.env.LEARNING_MIN_SENDS ?? 12);

/** Reply rates, for context. Cold email at 4%+ is doing well. */
const WEAK_BELOW = 0.02;
const STRONG_ABOVE = 0.08;

export function analyse(outcomes: Outcome[], dimension: Dimension): DimensionReport {
  const buckets = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    const value = outcome.attributes[dimension];
    if (!value) continue;
    const existing = buckets.get(value);
    if (existing) existing.push(outcome);
    else buckets.set(value, [outcome]);
  }

  const findings = [...buckets.entries()]
    .map(([value, group]) => finding(value, group))
    // Unusable samples sort to the bottom whatever their numbers say, which
    // the lower bound alone does not achieve: one reply from one send has a
    // Wilson lower bound of 0.21, *above* a solid forty from two hundred at
    // 0.15. The interval is doing its job — with n = 1 the true rate really
    // could be high — but a sample that small has no business holding a
    // position in a ranking at all.
    .sort((a, b) => {
      const aEarly = a.sent < MIN_SENDS_PER_VALUE;
      const bEarly = b.sent < MIN_SENDS_PER_VALUE;
      if (aEarly !== bEarly) return aEarly ? 1 : -1;
      return b.lowerBound - a.lowerBound || b.sent - a.sent;
    });

  const report: DimensionReport = {
    dimension,
    label: DIMENSION_LABEL[dimension],
    note: DIMENSION_NOTE[dimension],
    findings,
  };

  const usable = findings.filter((f) => f.verdict !== "too_early");
  if (usable.length === 0) {
    const total = findings.reduce((sum, f) => sum + f.sent, 0);
    report.tooEarly = findings.length === 0
      ? "Nothing sent yet."
      : `${total} message(s) across ${findings.length} value(s), none with the ${MIN_SENDS_PER_VALUE} needed to say anything. This is not a problem, it is the volume caps working.`;
    return report;
  }

  report.recommendation = recommend(usable);
  return report;
}

function finding(value: string, group: Outcome[]): Finding {
  const sent = group.length;
  const replies = group.filter((o) => o.replied).length;
  const positives = group.filter((o) => o.positive).length;

  const replyRate = sent > 0 ? replies / sent : 0;
  const lowerBound = wilsonLowerBound(replies, sent);

  return {
    value,
    sent,
    replies,
    positives,
    bounces: group.filter((o) => o.bounced).length,
    optOuts: group.filter((o) => o.optedOut).length,
    replyRate,
    positiveRate: sent > 0 ? positives / sent : 0,
    lowerBound,
    verdict:
      sent < MIN_SENDS_PER_VALUE ? "too_early"
        : lowerBound >= STRONG_ABOVE ? "strong"
          : replyRate <= WEAK_BELOW ? "weak"
            : "working",
  };
}

/**
 * Says which value is better, but only when that is defensible.
 *
 * The condition is that the best value's lower bound clears the worst value's
 * upper bound — the intervals do not overlap. Anything weaker and the honest
 * answer is that they cannot be told apart yet, which is what most of these
 * comparisons actually are at the volumes this product sends at.
 */
function recommend(usable: Finding[]): string | undefined {
  if (usable.length < 2) return undefined;

  const best = usable[0]!;
  const worst = usable[usable.length - 1]!;
  if (best.value === worst.value) return undefined;

  if (best.lowerBound <= wilsonUpperBound(worst.replies, worst.sent)) {
    return `"${best.value}" is ahead of "${worst.value}" (${rate(best.replyRate)} against ${rate(worst.replyRate)}), but the samples overlap — ${best.sent} and ${worst.sent} sends are not enough to call it.`;
  }

  return `"${best.value}" replies at ${rate(best.replyRate)} across ${best.sent} sends against "${worst.value}" at ${rate(worst.replyRate)} across ${worst.sent}. The difference holds up. Worth shifting the run toward it — though this is observed, not tested, so something else about those prospects may be doing the work.`;
}

/**
 * The lower end of a Wilson score interval, at about 95% confidence.
 *
 * Chosen over the textbook normal approximation because that one misbehaves
 * exactly where this lives: small samples and rates near zero, where it
 * happily returns negative lower bounds. Wilson stays inside 0..1 and is
 * well behaved at n = 1.
 */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denominator);
}

export function wilsonUpperBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 1;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.min(1, (centre + margin) / denominator);
}

export function rate(value: number): string {
  if (value === 0) return "0%";
  return value < 0.1 ? `${(value * 100).toFixed(1)}%` : `${Math.round(value * 100)}%`;
}

/** The band a quality score falls into, for the quality dimension. */
export function qualityBand(score: number): string {
  if (score >= 90) return "90-100";
  if (score >= 75) return "75-89";
  if (score >= 62) return "62-74";
  return "below the bar";
}

/** Subject length as a band, since the exact word count is noise. */
export function subjectBand(subject: string): string {
  const words = subject.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return "none (a reply in thread)";
  if (words <= 3) return "1-3 words";
  if (words <= 5) return "4-5 words";
  return "6 or more words";
}

/**
 * Everything, ordered by how actionable it is.
 *
 * Targeting first, because changing who you contact matters more than
 * changing what you say to them, and the two dimensions that change targeting
 * are the pain signal and the discovery source.
 */
export const DIMENSIONS_BY_USEFULNESS: Dimension[] = [
  "pain_signal",
  "discovery_source",
  "step_intent",
  "contact_kind",
  "composed_via",
  "quality_band",
  "subject_length",
];

export function analyseAll(outcomes: Outcome[]): DimensionReport[] {
  return DIMENSIONS_BY_USEFULNESS.map((dimension) => analyse(outcomes, dimension));
}

/**
 * One line for the composer's brief: what this market has replied to.
 *
 * Deliberately conservative. It only says anything when a dimension produced
 * a defensible recommendation, and it never tells the model what to write —
 * only what has worked, which the model may then use or not. Feeding a weak
 * signal into every prompt as an instruction would turn a 14-send
 * coincidence into the house style.
 */
export function brief(reports: DimensionReport[]): string[] {
  const lines: string[] = [];
  for (const report of reports) {
    if (!report.recommendation || report.recommendation.includes("not enough to call it")) continue;
    const best = report.findings.find((f) => f.verdict === "strong" || f.verdict === "working");
    if (!best) continue;
    lines.push(`${report.label}: "${best.value}" has replied at ${rate(best.replyRate)} across ${best.sent} sends.`);
  }
  return lines;
}
