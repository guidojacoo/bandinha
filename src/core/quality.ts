import { quoteIsUsed } from "./draft";
import type { LeadEvidence } from "./types";

/**
 * Scoring the copy.
 *
 * The product's whole claim is that it sends messages worth reading, and
 * "write a good email" is not something a prompt can be trusted to deliver.
 * So quality is measured, named, and enforced: a draft below the threshold is
 * rejected and rewritten against the specific checks it failed, and the
 * failures are stored with the message so the operator can see the agent's
 * own opinion of its work.
 *
 * Every check here comes from something that demonstrably moves reply rates
 * on cold email, not from taste:
 *
 *  - **Short wins.** Reply rate falls off a cliff past ~125 words. The best
 *    performing cold emails are 50–100.
 *  - **It has to be about them.** "You/your" should outnumber "we/our/I".
 *    Copy that spends four sentences on the sender is a brochure.
 *  - **One ask, at the end.** Two questions halve the chance of either being
 *    answered; a question buried mid-paragraph gets skimmed past.
 *  - **Specificity is the whole game.** Research puts AI-written cold copy at
 *    ~0.3% replies against 4%+ human-written, and the difference is that the
 *    human knew something about the person they wrote to.
 *  - **Filler is a tell.** "I hope this finds you well", "I came across your
 *    company", "quick question" — each one tells the reader this is bulk mail
 *    before they reach the substance.
 */

export type QualityCheckId =
  | "length" | "opening" | "filler" | "specificity" | "ask"
  | "readability" | "about_them" | "hedging" | "jargon" | "formatting"
  | "freshness";

export interface QualityCheck {
  id: QualityCheckId;
  label: string;
  /** 0..1. */
  value: number;
  weight: number;
  detail: string;
  /** What to tell a model to fix, when this check is the problem. */
  fix?: string;
}

export interface QualityReport {
  score: number;
  checks: QualityCheck[];
  /** Named failures, worst first. The repair prompt is built from these. */
  failures: QualityCheck[];
  ok: boolean;
  /**
   * Set when a check failed so badly that the score is irrelevant.
   *
   * Only repetition does this. An exact resend of an earlier message still
   * scored 77 on the weighted average — every other check passed, because it
   * was a good email the first time. Averaging cannot express "this
   * specific thing is fatal", so it is an override instead.
   */
  disqualifiedBecause?: string;
}

/**
 * What role this message plays, which changes what "good" means.
 *
 * Judging every message by first-touch rules was a mistake with a visible
 * cost: a follow-up was marked down for not opening with a fresh observation
 * about the prospect, and a breakup for being twenty-five words long. Both
 * were correct as written. A scorer that pushes back on correct copy teaches
 * the writer — model or template — to pad.
 */
export type MessageStage = "first" | "follow_up" | "breakup" | "reply";

/**
 * Per-stage weight multipliers.
 *
 * Zero means the check does not apply at all: a reply has no opening to
 * judge, a breakup needs no fresh evidence because the thread already carries
 * it. A half means it still matters but less.
 */
const STAGE_WEIGHTS: Record<MessageStage, Partial<Record<QualityCheckId, number>>> = {
  first: {},
  follow_up: { opening: 0.4, specificity: 0.5, freshness: 1.4 },
  breakup: { opening: 0, specificity: 0, about_them: 0.3, ask: 1 },
  reply: { opening: 0, specificity: 0, freshness: 0.3 },
};

/** Word-count bands per stage. A breakup should be short. */
const STAGE_LENGTH: Record<MessageStage, [number, number]> = {
  first: [45, 115],
  follow_up: [30, 95],
  breakup: [15, 60],
  reply: [10, 95],
};

export const QUALITY_WEIGHTS: Record<QualityCheckId, number> = {
  specificity: 20,
  opening: 14,
  // A four-touch sequence that sends the same email four times is worse than
  // a single touch: it proves nobody is reading the replies and it is the
  // fastest way to be marked as spam by hand. Weighted accordingly.
  freshness: 14,
  ask: 12,
  length: 10,
  about_them: 10,
  filler: 10,
  hedging: 5,
  jargon: 3,
  readability: 1,
  formatting: 1,
};

/** Below this, a draft is rewritten rather than sent. */
export const MIN_QUALITY = Number(process.env.MIN_MESSAGE_QUALITY ?? 62);

/** A check scoring below this is reported as a failure to fix. */
const FAILING = 0.6;

// ---------------------------------------------------------------------------
// The phrase lists
// ---------------------------------------------------------------------------

/** Openings and connectives that announce bulk mail. */
const FILLER = [
  /\bi hope (?:this|you)\b/i,
  /\bhope you(?:'re| are) (?:doing )?(?:well|good)\b/i,
  /\bhope this (?:email )?finds you\b/i,
  /\bi came across\b/i,
  /\bi stumbled (?:up)?on\b/i,
  /\bi(?:'m| am) reaching out\b/i,
  /\bi wanted to reach out\b/i,
  /\bquick question\b/i,
  /\bjust (?:wanted|checking|following up|reaching)\b/i,
  /\bi noticed that you\b/i,
  /\bmy name is\b/i,
  /\bwe are a (?:company|platform|team) that\b/i,
  /\bwithout further ado\b/i,
  /\bper my last email\b/i,
  /\bcircling back\b/i,
  /\bas you may know\b/i,
  /\bin today's (?:fast[- ]paced|competitive)\b/i,
  /\bat the end of the day\b/i,
  /\bi'?d love to (?:pick your brain|connect|chat about how)\b/i,
  /\blet me know if (?:this|that) (?:sounds|is) (?:of )?interest\b/i,
  /\bthoughts\?$/im,
];

/** Hedges that make an ask easy to ignore. */
const HEDGES = [
  /\bif you (?:have|had) (?:a moment|time|a minute|the time)\b/i,
  /\bi was wondering (?:if|whether)\b/i,
  /\bwould you (?:possibly|perhaps)\b/i,
  /\bmaybe\b/i, /\bperhaps\b/i, /\bsort of\b/i, /\bkind of\b/i,
  /\bi think (?:maybe|perhaps)\b/i,
  /\bno pressure\b/i,
  /\bfeel free to\b/i,
  /\bwhenever (?:you|is) (?:convenient|get a chance)\b/i,
  /\bat your convenience\b/i,
  /\bsorry to bother\b/i,
  /\bjust in case\b/i,
];

/** Words that mean nothing and signal a template. */
const JARGON = [
  "synergy", "synergies", "leverage", "leveraging", "best-in-class",
  "best in class", "cutting-edge", "cutting edge", "state-of-the-art",
  "world-class", "world class", "game-changer", "game changing", "disrupt",
  "disruptive", "paradigm", "holistic", "robust", "seamless", "seamlessly",
  "turnkey", "scalable solution", "value-add", "value add", "low-hanging",
  "move the needle", "circle back", "touch base", "bandwidth", "ideate",
  "unlock", "supercharge", "revolutionize", "revolutionise", "transformative",
  "next-generation", "next generation", "end-to-end solution", "ecosystem",
  "mission-critical", "frictionless", "bleeding edge", "10x", "rockstar",
];

/** Openings that correctly signal "this is a follow-up, not a new pitch". */
const CONTINUITY = [
  /\bfollowing up\b/i,
  /\bone more thing\b/i,
  /\bno reply is usually\b/i,
  /\blast (?:one|message|note)\b/i,
  /\bi(?:'ll| will) (?:stop|leave)\b/i,
  /\bbefore i (?:close|stop|leave)\b/i,
];

const ABOUT_US = /\b(?:we|we're|we've|our|ours|us|i|i'm|i've|my|mine)\b/gi;
const ABOUT_THEM = /\b(?:you|you're|you've|your|yours|yourself)\b/gi;

// ---------------------------------------------------------------------------
// The scorer
// ---------------------------------------------------------------------------

export interface QualityInput {
  subject: string;
  /** The body with the compliance footer already removed. */
  copy: string;
  /** The quotes that justified contacting them. */
  evidence: LeadEvidence[];
  /** Names the copy may legitimately use: company, product, person. */
  knownNames?: string[];
  /** Which role this message plays. Defaults to a first touch. */
  stage?: MessageStage;
  /** Everything already sent to this person, for the repetition check. */
  previousMessages?: Array<{ subject: string; body: string }>;
}

export function scoreQuality(input: QualityInput): QualityReport {
  const copy = input.copy.trim();
  const stage = input.stage ?? "first";
  const multipliers = STAGE_WEIGHTS[stage];

  const raw: QualityCheck[] = [
    lengthCheck(copy, input),
    openingCheck(copy, input),
    fillerCheck(copy, input.subject),
    specificityCheck(copy, input),
    askCheck(copy, input),
    readabilityCheck(copy),
    aboutThemCheck(copy),
    hedgingCheck(copy),
    jargonCheck(copy),
    formattingCheck(copy, input.subject),
    freshnessCheck(copy, input),
  ];

  const checks = raw.map((check) => {
    const multiplier = multipliers[check.id];
    return multiplier === undefined ? check : { ...check, weight: Math.round(check.weight * multiplier) };
  });

  const total = checks.reduce((sum, check) => sum + check.weight, 0);
  const score = total === 0
    ? 0
    : Math.round((checks.reduce((sum, check) => sum + check.value * check.weight, 0) / total) * 100);

  const failures = checks
    .filter((check) => check.value < FAILING && check.weight > 0)
    .sort((a, b) => (b.weight * (1 - b.value)) - (a.weight * (1 - a.value)));

  const freshness = checks.find((check) => check.id === "freshness");
  const disqualifiedBecause =
    freshness && freshness.weight > 0 && freshness.value <= 0.15
      ? `This is substantially the message already sent: ${freshness.detail}`
      : undefined;

  return {
    score: disqualifiedBecause ? Math.min(score, MIN_QUALITY - 1) : score,
    checks,
    failures,
    ok: !disqualifiedBecause && score >= MIN_QUALITY,
    disqualifiedBecause,
  };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

export function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

/**
 * Length. 50–110 words is the sweet spot; past ~140 reply rate collapses.
 *
 * Scored as a plateau rather than a point, because a 70-word email and a
 * 95-word email are equally fine and penalising one of them would make the
 * scorer fight the writer over nothing.
 */
function lengthCheck(copy: string, input: QualityInput): QualityCheck {
  const count = words(stripGreetingAndSignoff(copy)).length;
  const [lo, hi] = STAGE_LENGTH[input.stage ?? "first"];
  // Overshoot is penalised steeply — decaying over a third of the limit, not
  // over the limit. A linear decay meant a 135-word email still scored 0.83,
  // which is past the point where reply rate is documented to collapse.
  const value =
    count >= lo && count <= hi ? 1
      : count < lo ? Math.max(0, count / lo)
        : Math.max(0, 1 - (count - hi) / (hi / 3));

  return {
    id: "length", label: "Length", value, weight: QUALITY_WEIGHTS.length,
    detail: `${count} words${value === 1 ? "" : ` (aim for ${lo}–${hi})`}.`,
    fix: value === 1 ? undefined
      : count > hi
        ? `Cut it to ${hi} words or fewer. Delete whole sentences rather than trimming adjectives.`
        : `It is too short to say anything useful. Aim for at least ${lo} words.`,
  };
}

/**
 * The opening line.
 *
 * The highest-leverage sentence in the message: it decides whether the rest
 * is read. It has to be about them and it has to be specific — not a
 * greeting, not the sender's name, not a statement about the market.
 */
function openingCheck(copy: string, input: QualityInput): QualityCheck {
  const stage = input.stage ?? "first";
  const first = sentences(stripGreetingAndSignoff(copy))[0] ?? "";

  // A follow-up legitimately opens by picking the thread back up rather than
  // with a fresh observation; demanding one is how a second touch ends up
  // restating the first.
  if (stage === "follow_up" && CONTINUITY.some((pattern) => pattern.test(first))) {
    return { id: "opening", label: "Opening", value: 1, weight: QUALITY_WEIGHTS.opening, detail: "Picks the thread up rather than restating it." };
  }
  if (!first) {
    return { id: "opening", label: "Opening", value: 0, weight: QUALITY_WEIGHTS.opening, detail: "No opening sentence.", fix: "Open with the specific thing you read on their site." };
  }

  const problems: string[] = [];
  if (FILLER.some((pattern) => pattern.test(first))) problems.push("opens with filler");
  if (/^(?:we|our|i|my)\b/i.test(first)) problems.push("opens by talking about us");
  if (words(first).length > 32) problems.push("opening sentence is too long to scan");

  const mentionsThem = ABOUT_THEM.test(first) || (input.knownNames ?? []).some((name) => name && first.includes(name));
  ABOUT_THEM.lastIndex = 0;
  if (!mentionsThem) problems.push("opening does not refer to them");

  const usesEvidence = input.evidence.some((e) => quoteIsUsed(e.quote, first));
  const value = problems.length === 0 ? (usesEvidence ? 1 : 0.75) : Math.max(0, 0.6 - 0.25 * problems.length);

  return {
    id: "opening", label: "Opening", value, weight: QUALITY_WEIGHTS.opening,
    detail: problems.length === 0
      ? usesEvidence ? "Opens with something specific from their own site." : "Opens about them, but not with the quote."
      : problems.join("; ") + ".",
    fix: value >= 0.75 ? undefined
      : "Make the first sentence a specific observation about them, drawn from their own site. No greeting-adjacent filler, no sentence starting with We or I.",
  };
}

function fillerCheck(copy: string, subject: string): QualityCheck {
  const haystack = `${subject}\n${copy}`;
  const hits = FILLER.filter((pattern) => pattern.test(haystack)).map((pattern) => haystack.match(pattern)?.[0] ?? "");
  const value = Math.max(0, 1 - hits.length * 0.45);
  return {
    id: "filler", label: "Filler", value, weight: QUALITY_WEIGHTS.filler,
    detail: hits.length === 0 ? "No stock phrases." : `Stock phrases: ${hits.slice(0, 3).map((h) => JSON.stringify(h)).join(", ")}.`,
    fix: hits.length === 0 ? undefined : `Delete these phrases entirely and do not replace them: ${hits.slice(0, 4).join("; ")}.`,
  };
}

/**
 * Specificity: how much of this could only have been written to them.
 *
 * Counted rather than judged — the evidence quote being used, their name,
 * their technologies, concrete numbers. A message that scores zero here is a
 * form letter however well written it is.
 */
function specificityCheck(copy: string, input: QualityInput): QualityCheck {
  let points = 0;
  const found: string[] = [];

  if (input.evidence.some((e) => quoteIsUsed(e.quote, copy))) {
    points += 2;
    found.push("uses their own words");
  }
  for (const name of (input.knownNames ?? []).slice(0, 4)) {
    if (name && name.length > 2 && copy.includes(name)) {
      points += 0.5;
      found.push(name);
      break;
    }
  }
  // A concrete figure that is theirs, not a claim about us.
  if (/\b\d{1,4}\b/.test(copy)) {
    points += 0.5;
    found.push("a concrete number");
  }

  // A follow-up inherits specificity from the thread, so naming the company
  // is enough; a first touch has to carry it on its own.
  const needed = (input.stage ?? "first") === "first" ? 2.5 : 1;
  const value = Math.min(1, points / needed);
  return {
    id: "specificity", label: "Specificity", value, weight: QUALITY_WEIGHTS.specificity,
    detail: found.length > 0 ? found.join(", ") + "." : "Nothing in this could only have been written to them.",
    fix: value >= FAILING ? undefined
      : "Rewrite so at least one sentence could only have been written to this company, drawn from the quote supplied. Do not add facts you were not given.",
  };
}

/**
 * The ask. Exactly one question, near the end.
 *
 * Two questions halve the chance of either being answered, and a question
 * buried in the middle gets skimmed past on the way to the signature.
 */
function askCheck(copy: string, input: QualityInput): QualityCheck {
  const stripped = stripGreetingAndSignoff(copy);
  const questions = (stripped.match(/\?/g) ?? []).length;

  if ((input.stage ?? "first") === "breakup") {
    // A breakup message that asks for something is not a breakup.
    const value = questions === 0 ? 1 : 0.5;
    return {
      id: "ask", label: "The ask", value, weight: QUALITY_WEIGHTS.ask,
      detail: questions === 0 ? "No ask, which is right for a last message." : "A breakup message should not ask for anything.",
      fix: value === 1 ? undefined : "Remove the question. This is the message that says you will stop.",
    };
  }

  if (questions === 0) {
    return {
      id: "ask", label: "The ask", value: 0.2, weight: QUALITY_WEIGHTS.ask,
      detail: "No question, so there is no obvious way to reply.",
      fix: "End with one question they can answer in a single line.",
    };
  }
  if (questions > 1) {
    return {
      id: "ask", label: "The ask", value: 0.35, weight: QUALITY_WEIGHTS.ask,
      detail: `${questions} questions; the reader answers none of them.`,
      fix: "Keep exactly one question. Delete the others.",
    };
  }

  // Where is it? A question in the final third is the ask; earlier is rhetoric.
  const at = stripped.lastIndexOf("?");
  const position = at / Math.max(1, stripped.length);
  const value = position >= 0.6 ? 1 : 0.7;
  return {
    id: "ask", label: "The ask", value, weight: QUALITY_WEIGHTS.ask,
    detail: value === 1 ? "One question, at the end." : "One question, but buried before the end.",
    fix: value === 1 ? undefined : "Move the question to the last line.",
  };
}

/** Long sentences are skimmed. Plain words are read. */
function readabilityCheck(copy: string): QualityCheck {
  const list = sentences(stripGreetingAndSignoff(copy));
  if (list.length === 0) {
    return { id: "readability", label: "Readability", value: 0, weight: QUALITY_WEIGHTS.readability, detail: "Nothing to read." };
  }
  const lengths = list.map((s) => words(s).length);
  const longest = Math.max(...lengths);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;

  const value = Math.min(1, Math.max(0, 1 - Math.max(0, mean - 20) / 20) * Math.max(0, 1 - Math.max(0, longest - 35) / 35));
  return {
    id: "readability", label: "Readability", value, weight: QUALITY_WEIGHTS.readability,
    detail: `${Math.round(mean)} words per sentence, longest ${longest}.`,
    fix: value >= FAILING ? undefined : "Break the long sentences up. Aim for under twenty words each.",
  };
}

/** Is it about them, or about us? */
function aboutThemCheck(copy: string): QualityCheck {
  const stripped = stripGreetingAndSignoff(copy);
  ABOUT_US.lastIndex = 0;
  ABOUT_THEM.lastIndex = 0;
  const us = (stripped.match(ABOUT_US) ?? []).length;
  const them = (stripped.match(ABOUT_THEM) ?? []).length;

  if (us + them === 0) {
    return { id: "about_them", label: "About them", value: 0.5, weight: QUALITY_WEIGHTS.about_them, detail: "Impersonal throughout." };
  }
  const ratio = them / (us + them);
  // Parity is fine; heavily us-weighted is a brochure.
  const value = Math.min(1, ratio / 0.5);
  return {
    id: "about_them", label: "About them", value, weight: QUALITY_WEIGHTS.about_them,
    detail: `${them} "you" to ${us} "we".`,
    fix: value >= FAILING ? undefined : "Rewrite from their side. More sentences about their situation than about ours.",
  };
}

function hedgingCheck(copy: string): QualityCheck {
  const hits = HEDGES.filter((pattern) => pattern.test(copy)).map((pattern) => copy.match(pattern)?.[0] ?? "");
  const value = Math.max(0, 1 - hits.length * 0.4);
  return {
    id: "hedging", label: "Hedging", value, weight: QUALITY_WEIGHTS.hedging,
    detail: hits.length === 0 ? "Direct." : `Hedges: ${hits.slice(0, 3).join(", ")}.`,
    fix: hits.length === 0 ? undefined : `Remove the hedging: ${hits.slice(0, 3).join("; ")}. Ask plainly.`,
  };
}

function jargonCheck(copy: string): QualityCheck {
  const lower = copy.toLowerCase();
  const hits = JARGON.filter((term) => new RegExp(`\\b${escapeRegex(term)}\\b`).test(lower));
  const value = Math.max(0, 1 - hits.length * 0.4);
  return {
    id: "jargon", label: "Jargon", value, weight: QUALITY_WEIGHTS.jargon,
    detail: hits.length === 0 ? "Plain language." : `Jargon: ${hits.slice(0, 3).join(", ")}.`,
    fix: hits.length === 0 ? undefined : `Say these in plain words instead: ${hits.slice(0, 3).join("; ")}.`,
  };
}

/** A first touch that looks like a deck is deleted. */
function formattingCheck(copy: string, subject: string): QualityCheck {
  const problems: string[] = [];
  if (/^\s*[-*•]\s/m.test(copy)) problems.push("bullet list");
  if ((copy.match(/https?:\/\/\S+/g) ?? []).length > 1) problems.push("more than one link");
  if (/\b[A-Z]{5,}\b/.test(copy)) problems.push("shouting");
  if (/!{2,}/.test(copy)) problems.push("repeated exclamation marks");
  if (words(subject).length > 7) problems.push("subject line too long");
  if (/^[A-Z][a-z]+(?: [A-Z][a-z]+)+$/.test(subject.trim()) && words(subject).length > 3) problems.push("title-cased subject reads as marketing");

  const value = Math.max(0, 1 - problems.length * 0.35);
  return {
    id: "formatting", label: "Formatting", value, weight: QUALITY_WEIGHTS.formatting,
    detail: problems.length === 0 ? "Reads like an email." : problems.join("; ") + ".",
    fix: problems.length === 0 ? undefined : `Fix: ${problems.join("; ")}. Write it as flowing sentences, lowercase subject, at most one link.`,
  };
}

/**
 * Does this say anything the last message did not?
 *
 * The check that exists because the first template produced a *perfect*
 * score on all four touches of a sequence — and the same email every time.
 * Nothing else in the scorer could see it, because every individual message
 * was fine. Quality is a property of the sequence, not only of the draft.
 */
function freshnessCheck(copy: string, input: QualityInput): QualityCheck {
  const previous = input.previousMessages ?? [];
  if (previous.length === 0) {
    return { id: "freshness", label: "Freshness", value: 1, weight: 0, detail: "First message to them." };
  }

  const current = contentWords(stripGreetingAndSignoff(copy));
  if (current.size === 0) {
    return { id: "freshness", label: "Freshness", value: 0, weight: QUALITY_WEIGHTS.freshness, detail: "Nothing to compare." };
  }

  let worst = 0;
  let worstSubject = "";
  for (const earlier of previous) {
    const before = contentWords(stripGreetingAndSignoff(earlier.body));
    if (before.size === 0) continue;
    const shared = [...current].filter((word) => before.has(word)).length;
    const overlap = shared / Math.min(current.size, before.size);
    if (overlap > worst) {
      worst = overlap;
      worstSubject = earlier.subject;
    }
    // An identical opening sentence is a repeat whatever the rest says.
    if (opening(copy) && opening(copy) === opening(earlier.body)) {
      worst = Math.max(worst, 0.95);
      worstSubject = earlier.subject;
    }
  }

  const value = worst <= 0.35 ? 1 : Math.max(0, 1 - (worst - 0.35) / 0.4);
  return {
    id: "freshness", label: "Freshness", value, weight: QUALITY_WEIGHTS.freshness,
    detail: value === 1
      ? "Says something the earlier messages did not."
      : `${Math.round(worst * 100)}% of this repeats "${worstSubject}".`,
    fix: value >= FAILING ? undefined
      : "This repeats what you already sent them. Make a different point: do not restate the observation or the pitch from the earlier message.",
  };
}

function contentWords(text: string): Set<string> {
  const stop = new Set([
    ...FUNCTION_WORDS_FOR_FRESHNESS,
  ]);
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
      .filter((word) => word.length > 3 && !stop.has(word)),
  );
}

const FUNCTION_WORDS_FOR_FRESHNESS = [
  "that", "this", "with", "from", "they", "them", "their", "there", "then",
  "have", "been", "were", "what", "when", "which", "would", "could", "your",
  "about", "into", "over", "just", "also", "more", "most", "than", "some",
  "very", "much", "like", "want", "need", "make", "take", "come", "work",
  "well", "even", "only", "same", "such", "does", "will", "here", "where",
];

function opening(body: string): string {
  const first = sentences(stripGreetingAndSignoff(body))[0] ?? "";
  return first.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 8).join(" ");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drops the greeting and the sign-off.
 *
 * "Hi Lena," and "Dana" are not prose and should not count toward length,
 * the you-versus-we ratio, or the opening sentence — the first version
 * scored every message's opening as "Hi Lena" and found it unspecific.
 */
export function stripGreetingAndSignoff(copy: string): string {
  const lines = copy.split("\n");
  while (lines.length > 0 && isGreeting(lines[0] ?? "")) lines.shift();
  while (lines.length > 0 && isSignoff(lines[lines.length - 1] ?? "")) lines.pop();
  return lines.join("\n").trim();
}

function isGreeting(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  return /^(hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^.?!]{0,40}[,:]?$/i.test(t);
}

function isSignoff(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  if (/^(best|thanks|cheers|regards|best regards|all the best|kind regards|sincerely|speak soon)[,.]?$/i.test(t)) return true;
  // A bare name on its own line.
  return /^[A-Z][a-zA-Z'’-]{1,20}(?: [A-Z][a-zA-Z'’-]{1,20})?$/.test(t) && words(t).length <= 2;
}

export function qualitySummary(report: QualityReport): string {
  if (report.failures.length === 0) return `${report.score}/100`;
  return `${report.score}/100 — ${report.failures.slice(0, 3).map((f) => f.label.toLowerCase()).join(", ")}`;
}

/** The repair instructions, as a model should receive them. */
export function repairInstructions(report: QualityReport): string[] {
  return report.failures.map((failure) => failure.fix).filter((fix): fix is string => Boolean(fix));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
