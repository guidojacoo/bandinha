import { buildCorpus, type SourceCorpus } from "../core/provenance";
import {
  MIN_QUALITY, qualitySummary, repairInstructions, scoreQuality, stripGreetingAndSignoff,
  type MessageStage, type QualityReport,
} from "../core/quality";
import { buildFooter } from "../core/compliance";
import { validateDraft, type DraftContext } from "../core/draft";
import { similar } from "../core/evidence";
import type {
  DiscoveredContact, DraftMessage, DraftValidation, LeadEvidence, LeadProfile,
  Offering, ProvenanceRecord, SenderIdentity, SequenceStep, SourcedClaim, StepIntent,
} from "../core/types";
import type { Llm } from "../infra/llm/types";
import type { PageText } from "../infra/extract";

/**
 * Writing the message.
 *
 * Three things make this different from asking a model for a cold email:
 *
 *  1. **The quote comes first.** The opening line is built from a sentence on
 *     the prospect's own site before any model is involved. That sentence is
 *     why we are allowed to write at all, and burying it in paragraph three
 *     wastes it.
 *  2. **Every claim is declared.** The model is asked to return its factual
 *     claims alongside the copy, and `core/provenance.ts` checks each one
 *     against pages actually crawled. A claim that cannot be traced does not
 *     get softened — the message is rejected and rewritten.
 *  3. **Failure is a template, not an error.** No key, no budget, a model
 *     that will not produce valid output after two attempts: all of them end
 *     with a deterministic message that passes the same validator. Blunter
 *     copy beats no outreach, and it keeps the agent's behaviour predictable
 *     when the free tier runs out mid-run.
 */

export interface ComposeInput {
  offering: Offering;
  profile: LeadProfile;
  contact: DiscoveredContact;
  step: SequenceStep;
  sender: SenderIdentity;
  /** Pages crawled from both sides, for provenance. */
  pages?: Array<{ url: string; text: string }>;
  meetingLink?: string;
  previousMessages?: Array<{ subject: string; body: string }>;
}

export interface ComposeResult {
  message: DraftMessage;
  validation: DraftValidation;
  /** The agent's own measured opinion of the copy it is about to send. */
  quality: QualityReport;
  via: "llm" | "llm-repaired" | "template";
  /** Every attempt, for the audit log: what was wrong with what. */
  attempts: Array<{ via: string; score: number; problems: string[]; failures: string[] }>;
}

/** Which quality standard applies to this step. */
export function stageFor(intent: StepIntent): MessageStage {
  if (intent === "first_touch") return "first";
  if (intent === "breakup") return "breakup";
  return "follow_up";
}

/** How many times the model gets to try before the template takes over. */
const MAX_LLM_ATTEMPTS = Number(process.env.COMPOSE_ATTEMPTS ?? 3);

export async function compose(input: ComposeInput, llm: Llm): Promise<ComposeResult> {
  const corpus = buildCorpus(input.offering, input.profile, input.pages ?? []);
  const context = draftContext(input, corpus);
  const attempts: ComposeResult["attempts"] = [];

  const judge = (message: DraftMessage): { validation: DraftValidation; quality: QualityReport } => {
    const validation = validateDraft(message, context);
    const quality = scoreQuality({
      subject: message.subject,
      copy: stripFooter(message.body, input.sender),
      evidence: input.profile.evidence,
      knownNames: context.allowedNames,
      stage: stageFor(input.step.intent),
      previousMessages: input.previousMessages,
    });
    return { validation, quality };
  };

  /**
   * Best of N, not first-that-passes.
   *
   * Two separate bars have to be cleared, and they fail differently.
   * `validateDraft` is about truth and legality — an unsupported claim or a
   * missing postal address is fatal and no amount of rewriting around it
   * counts. `scoreQuality` is about whether the thing is worth reading, and
   * a model's second attempt is usually better than its first but not always.
   * So every attempt is kept, the best valid one wins, and the critique that
   * drives the next attempt is the scorer's own named failures rather than
   * "try again".
   */
  let best: { message: DraftMessage; validation: DraftValidation; quality: QualityReport; via: ComposeResult["via"] } | null = null;

  if (llm.available()) {
    let critique: string[] = [];

    for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
      const drafted = await askForDraft(input, llm, critique);
      if (!drafted) break;

      const message = withFooter(drafted, input.sender);
      const { validation, quality } = judge(message);
      const via: ComposeResult["via"] = attempt === 1 ? "llm" : "llm-repaired";

      attempts.push({
        via,
        score: quality.score,
        problems: validation.problems,
        failures: quality.failures.map((failure) => failure.label),
      });

      if (validation.ok && (!best || quality.score > best.quality.score)) {
        best = { message, validation, quality, via };
      }
      // Good enough to stop paying for attempts.
      if (validation.ok && quality.score >= MIN_QUALITY + 12) break;

      critique = [...validation.problems, ...repairInstructions(quality)];
      if (critique.length === 0) break;
    }
  }

  if (best && best.quality.ok) {
    return { message: best.message, validation: best.validation, quality: best.quality, via: best.via, attempts };
  }

  // The template is not a last resort here, it is a competitor: if the model
  // could not beat a deterministic draft on the same scoring, the
  // deterministic draft is what goes out.
  const templated = withFooter(templateDraft(input), input.sender);
  const judged = judge(templated);
  attempts.push({
    via: "template",
    score: judged.quality.score,
    problems: judged.validation.problems,
    failures: judged.quality.failures.map((failure) => failure.label),
  });

  if (best && best.quality.score > judged.quality.score) {
    return { message: best.message, validation: best.validation, quality: best.quality, via: best.via, attempts };
  }
  return { message: templated, validation: judged.validation, quality: judged.quality, via: "template", attempts };
}

function stripFooter(body: string, sender: SenderIdentity): string {
  const at = body.indexOf(sender.postalAddress.trim());
  return (at > 0 ? body.slice(0, at) : body).trim();
}

export function draftContext(input: ComposeInput, corpus: SourceCorpus): DraftContext {
  return {
    sender: input.sender,
    isFirstTouch: input.step.intent === "first_touch",
    evidence: input.profile.evidence,
    corpus,
    allowedNames: [
      input.offering.companyName,
      input.profile.companyName,
      ...input.offering.products.map((p) => p.name),
      input.contact.name ?? "",
      firstName(input.contact.name),
      input.sender.fromName,
      firstName(input.sender.fromName),
    ].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// The model path
// ---------------------------------------------------------------------------

const INTENT_BRIEF: Record<StepIntent, string> = {
  first_touch:
    "First contact. Three short paragraphs: (1) the specific thing you read on their site, in your own words, and why it would matter to them; (2) one sentence on the mechanism that addresses it; (3) one question. Nothing else.",
  value_add:
    "Second touch, a few days later. Do NOT restate the first email's observation or its pitch — they already read it. Say how the problem is usually approached, make it cheap for them to tell you it is already solved, and ask what they do today.",
  social_proof:
    "Third touch. Point at the single most verifiable thing in the proof points below and invite them to check it themselves. If no proof points are supplied, say plainly that you have nothing they could verify and name the capability instead. Never imply a customer you were not given.",
  objection_preempt:
    "Name the three likely reasons for silence — wrong time, already have something, not their call — say any of them is a fine answer, and ask which it is.",
  breakup:
    "Last message. Fifteen to fifty words. Say you will stop, with no guilt and no final pitch, and leave one door open. Ask nothing.",
};

/**
 * The composing prompt.
 *
 * Written against the same checks `core/quality.ts` measures, so the model is
 * aiming at the target it will be scored on rather than at a vague notion of
 * "good". The banned-phrase list is explicit because models reach for those
 * phrases by default — they are the most common openings in the training
 * data and the most reliable signal to a reader that nobody wrote this.
 */
const COMPOSE_SYSTEM = `You write one cold email for a B2B salesperson. Plain text. No markdown, no bullet points, no headings.

## What makes this work
The reader gets forty of these a week. The only reason to read yours is that it contains something that could not have been written to anyone else. That sentence is supplied to you below — build the email around it.

## Hard rules. Breaking any one of them throws the email away.
- Every factual claim you make must appear in "provenance" with the exact source URL it came from. Claims about the prospect come from their pages; claims about us come from ours.
- Never state a customer count, a named customer, a percentage, a funding round, an award or a press mention unless it is in the supplied proof points, word for word.
- Use the supplied quote from their own site. Paraphrase it in your own words; do not paste it in quotation marks.
- Write more sentences about them than about us.
- Exactly one question, and it is the last line.
- 45 to 115 words in the body, excluding the greeting and the sign-off.

## Never write any of these
"I hope this finds you well" · "I came across" · "I'm reaching out" · "quick question" · "just following up" · "my name is" · "we are a company that" · "circling back" · "touch base" · "let me know if this is of interest" · "thoughts?"
No hedging: no "if you have a moment", "I was wondering whether", "maybe", "feel free to", "no pressure".
No jargon: no "leverage", "best-in-class", "cutting-edge", "seamless", "robust", "unlock", "move the needle", "end-to-end", "ecosystem", "game-changer".

## The ask
Ask about their situation, not their calendar. "Do you have fifteen minutes" asks for a commitment before they know whether they care. "Is this something you are already working on, or has it just become background?" costs them one line and starts the conversation in which a meeting becomes obvious.

## Subject line
Two to five words, lowercase, concrete, drawn from what you observed. Not a sentence, not title case, no colon, no question mark. "forty pages a week" — not "Improving Your Alerting Strategy".

Return JSON exactly like:
{"subject":"","body":"","provenance":[{"claim":"","source":"","kind":"prospect"}]}`;

async function askForDraft(
  input: ComposeInput,
  llm: Llm,
  critique: string[] = [],
): Promise<DraftMessage | null> {
  const brief = buildBrief(input, critique);

  const result = await llm.json<{ subject?: string; body?: string; provenance?: unknown }>(
    {
      task: "compose",
      tier: "large",
      system: COMPOSE_SYSTEM,
      user: brief,
      maxTokens: 800,
      // A rewrite should obey the critique, not explore; a first attempt
      // benefits from some latitude.
      temperature: critique.length > 0 ? 0.2 : 0.5,
    },
    (value) => value as { subject?: string; body?: string; provenance?: unknown },
  );

  if (!result.ok || !result.data?.body) return null;

  return {
    subject: String(result.data.subject ?? "").trim().slice(0, 120),
    body: String(result.data.body).trim(),
    provenance: readProvenance(result.data.provenance),
  };
}

export function buildBrief(input: ComposeInput, critique: string[] = []): string {
  const quote = bestQuote(input.profile.evidence);
  const lines = [
    `## This message`,
    `Step ${input.step.index + 1}, intent "${input.step.intent}". ${INTENT_BRIEF[input.step.intent]}`,
    "",
    `## Us`,
    `${input.offering.companyName} (${input.offering.domain}): ${input.offering.oneLiner}`,
    `Source for the line above: ${input.offering.sources[0] ?? `https://${input.offering.domain}`}`,
    input.offering.pricingModel ? `Pricing: ${input.offering.pricingModel}` : "",
    `Capabilities: ${input.offering.products.flatMap((p) => p.capabilities).slice(0, 6).join("; ") || "not stated"}`,
    "",
    `## Claims we are allowed to make about ourselves`,
    ...claimLines(input.offering.valueProps),
    "",
    `## Proof points (the ONLY third-party facts you may state)`,
    input.offering.proofPoints.length > 0 ? claimLines(input.offering.proofPoints).join("\n") : "(none — say nothing about other customers)",
    "",
    `## Them`,
    `${input.profile.companyName} (${input.profile.domain})`,
    input.profile.description ? `How they describe themselves: ${input.profile.description}` : "",
    input.profile.employeeEstimate ? `Roughly ${input.profile.employeeEstimate} people.` : "",
    input.profile.location ? `Based in ${input.profile.location}.` : "",
    input.profile.technologies.length > 0 ? `Technologies named on their site: ${input.profile.technologies.slice(0, 8).join(", ")}.` : "",
    "",
    `## The quote you must use`,
    quote ? `"${quote.quote}"\nSource: ${quote.source}` : "(no quote available — do not imply you read anything specific)",
    "",
    `## Who you are writing to`,
    `${input.contact.name ?? "unknown name"}${input.contact.title ? `, ${input.contact.title}` : ""} <${input.contact.email}>`,
    input.contact.kind === "role"
      ? "This is a shared inbox, so address the company rather than a person and keep it even shorter."
      : "",
    "",
    `## You are`,
    `${input.sender.fromName} <${input.sender.fromEmail}>`,
    input.meetingLink ? `Booking link you may offer: ${input.meetingLink}` : "",
  ];

  if (input.previousMessages?.length) {
    lines.push("", "## Already sent to them (do not repeat these openings or arguments)");
    for (const previous of input.previousMessages.slice(-3)) {
      lines.push(`- "${previous.subject}": ${previous.body.split("\n").slice(0, 3).join(" ").slice(0, 220)}`);
    }
  }

  if (critique.length > 0) {
    lines.push(
      "",
      "## Your previous attempt was rejected",
      "Fix exactly these, and nothing else. Do not argue with them, and do not restate a rejected claim in different words:",
      ...critique.map((item) => `- ${item}`),
    );
  }

  return lines.filter((l) => l !== "").join("\n");
}

function claimLines(claims: SourcedClaim[]): string[] {
  return claims.slice(0, 6).map((claim) => `- "${claim.text}" (source: ${claim.source})`);
}

function readProvenance(value: unknown): ProvenanceRecord[] {
  if (!Array.isArray(value)) return [];
  const out: ProvenanceRecord[] = [];
  for (const raw of value) {
    const claim = String((raw as ProvenanceRecord)?.claim ?? "").trim();
    const source = String((raw as ProvenanceRecord)?.source ?? "").trim();
    if (!claim || !source) continue;
    const kind = (raw as ProvenanceRecord)?.kind === "seller" ? "seller" : "prospect";
    // `verified` is never taken from the model — it is decided by
    // `verifyProvenance` against the crawl. Trusting it here would be asking
    // the model to grade its own homework.
    out.push({ claim, source, kind, verified: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The deterministic path
// ---------------------------------------------------------------------------

/**
 * The template message.
 *
 * Not a placeholder. It is assembled from the same sourced material as the
 * model path and passes the same validator, so a run with no LLM at all still
 * sends specific, provenance-checked outreach — just in a recognisable shape.
 *
 * Two bugs this shape exists to avoid, both found by reading real output:
 * a one-liner that already begins with the company name produced "Northwind
 * SLO Northwind SLO tracks…", and a noun-phrase capability spliced into a
 * verb carrier produced "Teams use it to error budget tracking for
 * microservices teams."
 */
export function templateDraft(input: ComposeInput): DraftMessage {
  const quote = bestQuote(input.profile.evidence);
  const greeting = input.contact.kind === "role" || !input.contact.name
    ? `Hello ${input.profile.companyName},`
    : `Hi ${firstName(input.contact.name)},`;

  const cite: Cite = (claim, source, kind = "seller") => {
    provenance.push({ claim, source, kind, verified: false });
    return claim;
  };
  const provenance: ProvenanceRecord[] = [];

  const paragraphs = STEP_TEMPLATES[input.step.intent](input, quote, cite);

  return {
    subject: subjectFor(input, quote),
    body: `${greeting}\n\n${paragraphs.filter(Boolean).join("\n\n")}\n\n${input.sender.fromName}`,
    provenance,
  };
}

type Cite = (claim: string, source: string, kind?: "seller" | "prospect") => string;

/**
 * One shape per step, because a sequence has to make a different point each
 * time.
 *
 * The first version of this ignored `step.intent` entirely and produced the
 * same four emails. Every one of them scored 100 on its own and the sequence
 * was worthless: a four-touch cadence that repeats itself proves nobody is
 * reading, and it is the fastest way to be marked as spam by hand. Only the
 * first touch is allowed to open with the observation; the later ones have to
 * earn their place on something else.
 */
const STEP_TEMPLATES: Record<StepIntent, (input: ComposeInput, quote: LeadEvidence | undefined, cite: Cite) => string[]> = {
  /** Observation, what it costs, the mechanism, one question. */
  first_touch: (input, quote, cite) => {
    const lines: string[] = [];

    if (quote) {
      // The claim recorded is their sentence verbatim; the copy carries the
      // second-person rewrite. `observationFrom` turns "We run on X" into
      // "You run on X", which is right in an email and unverifiable as a
      // citation.
      cite(quote.quote, quote.source, "prospect");
      lines.push(`${observationFrom(quote)} — that is what caught my eye on ${input.profile.domain}.`);
    } else {
      lines.push(`${input.profile.companyName} came up while I was looking at ${input.offering.categories[0] ?? "this space"}.`);
    }

    const pitch = pitchSentence(input.offering);
    cite(pitch.claim, pitch.source);
    lines.push(pitch.text);

    lines.push(askFor(input, quote));
    return lines;
  },

  /**
   * No re-observation. Leads with how the problem is usually approached and
   * asks what they do today — a question that is easier to answer than a
   * meeting request, which is the point of a second touch.
   */
  value_add: (input) => {
    const capability = input.offering.products.flatMap((p) => p.capabilities)[0];
    // No claim, so no provenance: a follow-up that asserts nothing cannot
    // assert anything false, and it does not need to — the first message
    // already made the argument.
    return [
      capability
        ? `Following up once. The teams that get on top of this usually start with ${capability.toLowerCase()} rather than with the alerts themselves.`
        : `Following up once. The teams that get on top of this usually change what they measure before they change their tooling.`,
      `If you have already done that at ${input.profile.companyName}, say so and I will leave it there.`,
      `What do you do about it today?`,
    ];
  },

  /**
   * Proof, and only proof the seller actually published. With none available
   * it says so rather than reaching for something plausible — which is the
   * exact failure mode the research documents.
   */
  social_proof: (input, _quote, cite) => {
    const proof = input.offering.proofPoints[0];
    if (proof) {
      return [
        `One more thing and then I will leave it. The one claim I can point you at that you could check yourself: ${cite(proof.text, proof.source)}`,
        `Does that matter for how you would judge something like this, or is your problem somewhere else entirely?`,
      ];
    }
    const capability = input.offering.products.flatMap((p) => p.capabilities)[0];
    return [
      `One more thing and then I will leave it. I have nothing to show you from other customers that you could verify, so I would rather not pretend otherwise.`,
      capability
        ? `What I can say is that ${capability.toLowerCase()} is the whole of it — everything else is on ${input.offering.domain} if you want to check it.`
        : `Everything we claim is on ${input.offering.domain}, so you can judge it without talking to me.`,
      `Is the problem worth half an hour to you, or not really?`,
    ];
  },

  /** Names the likely reason for silence and makes it cheap to say so. */
  objection_preempt: (input) => [
    `No reply is usually one of three things: wrong time, you already have something that does this, or it is not your call. Any of those is a fine answer and I would rather know which.`,
    `Which one is it for you?`,
  ],

  /** Short, no ask, one door left open. */
  breakup: (input) => [
    `I will stop here rather than keep filling your inbox.`,
    `If this becomes somebody's problem to fix later, replying to this message will reach me.`,
  ],
};

/**
 * The ask.
 *
 * A question about their situation, not about their calendar. "Do you have
 * fifteen minutes" asks for a commitment before they know whether they care;
 * "is this something you are working on" costs them one line and starts the
 * conversation in which the meeting becomes obvious.
 */
function askFor(input: ComposeInput, quote: LeadEvidence | undefined): string {
  const topic = quote ? topicOf(quote) : (input.offering.categories[0] ?? "this");
  return input.meetingLink
    ? `Is ${topic} something you are already working on, or has it just become background? Happy to talk if it is the former: ${input.meetingLink}`
    : `Is ${topic} something you are already working on, or has it just become background?`;
}

/** A two-or-three word noun phrase naming what the quote is about. */
export function topicOf(evidence: LeadEvidence): string {
  const signal = evidence.signal.trim().toLowerCase();
  if (signal.length >= 4 && signal.split(" ").length <= 3 && !/^\d/.test(signal)) return signal;

  const words = evidence.quote
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4 && !TOPIC_STOP.has(word));
  return words.slice(0, 2).join(" ") || "this";
}

const TOPIC_STOP = new Set([
  "about", "after", "their", "there", "these", "those", "which", "while",
  "would", "could", "should", "being", "where", "every", "other", "because",
  "through", "before", "between", "something", "anything", "nothing", "most",
  "times", "weeks", "turns",
]);

/**
 * The quote turned into something sayable.
 *
 * Trims a leading "We"/"Our" so it reads as an observation rather than a
 * paste, and keeps it short enough to be the opening clause of a sentence.
 */
export function observationFrom(evidence: LeadEvidence): string {
  let text = evidence.quote.trim().replace(/[.!?]+$/, "");
  text = text.replace(/^(?:we|our team|our engineers|i)\s+/i, (match) =>
    /^our team/i.test(match) ? "Your team " : /^our engineers/i.test(match) ? "Your engineers " : "You ",
  );
  text = text.replace(/^our\s+/i, "Your ");
  if (text.length > 160) {
    const cut = text.slice(0, 160);
    text = `${cut.slice(0, cut.lastIndexOf(" "))}`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One sentence about what we do, assembled so it does not read like a bug.
 *
 * A capability is usually a noun phrase ("error budget tracking"), so it goes
 * after a preposition, never after "helps teams to". And the one-liner is
 * used as-is when it already names the company, rather than prefixing the
 * name again.
 */
export function pitchSentence(offering: Offering): { text: string; claim: string; source: string } {
  const source = offering.sources[0] ?? `https://${offering.domain}`;
  const oneLiner = offering.oneLiner.trim().replace(/[.!?]+$/, "");
  const namesItself = new RegExp(`^${escapeRegex(offering.companyName)}\\b`, "i").test(oneLiner);

  const text = namesItself ? `${oneLiner}.` : `${offering.companyName}: ${oneLiner}.`;
  return { text, claim: oneLiner, source };
}

function subjectFor(input: ComposeInput, quote?: LeadEvidence): string {
  if (input.step.intent === "breakup") return `closing the loop — ${input.profile.companyName}`;
  if (quote) {
    const keywords = quote.quote
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4 && !STOP_WORDS.has(w))
      .slice(0, 3);
    if (keywords.length >= 2) return keywords.join(" ");
  }
  return `${input.profile.companyName} + ${input.offering.companyName}`;
}

const STOP_WORDS = new Set([
  "about", "after", "again", "their", "there", "these", "those", "which",
  "while", "would", "could", "should", "being", "where", "every", "other",
  "because", "through", "before", "between", "something", "anything",
]);

/**
 * Appends the compliance footer, if the body does not already carry one.
 *
 * The footer is not decoration: a commercial email without a postal address
 * and a working opt-out is unlawful under CAN-SPAM §7704(a)(5) and is what
 * gets a domain blocklisted. `validateDraft` refuses a message without it, so
 * this runs on both the model and template paths.
 */
export function withFooter(message: DraftMessage, sender: SenderIdentity): DraftMessage {
  if (message.body.includes(sender.postalAddress.trim())) return message;
  return { ...message, body: `${message.body.trim()}\n\n${buildFooter(sender)}` };
}

export function bestQuote(evidence: LeadEvidence[]): LeadEvidence | undefined {
  return evidence
    .slice()
    .sort((a, b) => b.quote.length - a.quote.length)
    .find((e) => e.quote.length >= 40);
}

/** True when two drafts would read as the same email. */
export function overlaps(a: string, b: string): boolean {
  const opening = (text: string) => text.split(/\s+/).slice(0, 5).join(" ").toLowerCase();
  if (opening(a) === opening(b)) return true;
  return similar(a, b);
}

function firstName(name?: string): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type { PageText };
