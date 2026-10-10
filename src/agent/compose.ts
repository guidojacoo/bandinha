import { buildCorpus, type SourceCorpus } from "../core/provenance";
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
  via: "llm" | "llm-repaired" | "template";
  /** Every attempt, for the audit log: what was wrong with what. */
  attempts: Array<{ via: string; problems: string[] }>;
}

export async function compose(input: ComposeInput, llm: Llm): Promise<ComposeResult> {
  const corpus = buildCorpus(input.offering, input.profile, input.pages ?? []);
  const context = draftContext(input, corpus);
  const attempts: ComposeResult["attempts"] = [];

  if (llm.available()) {
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const drafted = await askForDraft(input, llm, feedback);
      if (!drafted) break;

      const message = withFooter(drafted, input.sender);
      const validation = validateDraft(message, context);
      attempts.push({ via: attempt === 1 ? "llm" : "llm-repaired", problems: validation.problems });

      if (validation.ok) {
        return { message, validation, via: attempt === 1 ? "llm" : "llm-repaired", attempts };
      }
      // The repair prompt is the validator's own complaints, verbatim. A
      // model told "that claim is not on any page we crawled" removes it;
      // told "try again", it rewrites the same claim in new words.
      feedback = validation.problems.join("\n- ");
    }
  }

  const message = withFooter(templateDraft(input), input.sender);
  const validation = validateDraft(message, context);
  attempts.push({ via: "template", problems: validation.problems });
  return { message, validation, via: "template", attempts };
}

export function draftContext(input: ComposeInput, corpus: SourceCorpus): DraftContext {
  return {
    sender: input.sender,
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
    "First contact. Open with the specific thing you read on their site, in your own words. One sentence on why that connects to what we do. One question. Nothing else.",
  value_add:
    "Second touch, a few days later. Add one concrete thing they did not get last time — a way the problem usually gets solved, or what to look at first. Do not repeat the first email's argument.",
  social_proof:
    "Third touch. Reference the kind of company that has this problem and what changed for them, using ONLY proof points supplied below. If none are supplied, use a specific capability instead and say nothing about other customers.",
  objection_preempt:
    "Name the most likely reason they have not replied — wrong time, already have something, not their call — and make it easy to say so.",
  breakup:
    "Last message. Say you will stop, in one short paragraph, with no guilt and no final pitch. Leave one door open.",
};

const COMPOSE_SYSTEM = `You write one short cold email for a B2B salesperson. Plain text, no markdown, no bullet points.

Hard rules. Breaking any of them means the email is thrown away:
- Every factual claim you make must be listed in "provenance" with the exact source URL it came from. Claims about the prospect come from their pages; claims about us come from ours.
- Never state a customer count, a named customer, a percentage, a funding round, an award or a press mention unless it is in the supplied proof points, word for word.
- Use the supplied quote from their own website. Paraphrase it naturally; do not paste it in quotation marks.
- 90 to 140 words in the body. One question. No "I hope this finds you well", no "I came across your company", no "quick question".
- Write like a person who read their site, not like marketing copy.

Return JSON exactly like:
{"subject":"","body":"","provenance":[{"claim":"","source":"","kind":"prospect"}]}`;

async function askForDraft(
  input: ComposeInput,
  llm: Llm,
  feedback?: string,
): Promise<DraftMessage | null> {
  const brief = buildBrief(input, feedback);

  const result = await llm.json<{ subject?: string; body?: string; provenance?: unknown }>(
    {
      task: "compose",
      tier: "large",
      system: COMPOSE_SYSTEM,
      user: brief,
      maxTokens: 800,
      temperature: feedback ? 0.2 : 0.45,
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

export function buildBrief(input: ComposeInput, feedback?: string): string {
  const quote = bestQuote(input.profile.evidence);
  const lines = [
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
    "",
    `## This message`,
    `Step ${input.step.index + 1}. ${INTENT_BRIEF[input.step.intent]}`,
  ];

  if (input.previousMessages?.length) {
    lines.push("", "## Already sent to them (do not repeat these openings or arguments)");
    for (const previous of input.previousMessages.slice(-3)) {
      lines.push(`- "${previous.subject}": ${previous.body.split("\n").slice(0, 3).join(" ").slice(0, 220)}`);
    }
  }

  if (feedback) {
    lines.push(
      "",
      "## Your previous attempt was rejected",
      "Fix exactly these problems. Do not argue with them, and do not restate a rejected claim in different words:",
      `- ${feedback}`,
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

  const provenance: ProvenanceRecord[] = [];
  const paragraphs: string[] = [];

  if (quote) {
    const observation = observationFrom(quote);
    paragraphs.push(`${observation} — that is what caught my eye on ${input.profile.domain}.`);
    // The *source sentence* is recorded, not the rewrite that appears in the
    // copy. `observationFrom` turns "We run on Kubernetes" into "You run on
    // Kubernetes", which is correct in an email and unverifiable as a claim —
    // one pronoun's difference dropped token overlap below the provenance
    // threshold and blocked an otherwise perfect message. What is being
    // asserted is their sentence; the ledger should carry their sentence, so
    // that anyone following the citation reads what we actually read.
    provenance.push({ claim: quote.quote, source: quote.source, kind: "prospect", verified: false });
  }

  const pitch = pitchSentence(input.offering);
  paragraphs.push(pitch.text);
  provenance.push({ claim: pitch.claim, source: pitch.source, kind: "seller", verified: false });

  if (input.step.intent === "social_proof" && input.offering.proofPoints[0]) {
    const proof = input.offering.proofPoints[0];
    paragraphs.push(proof.text);
    provenance.push({ claim: proof.text, source: proof.source, kind: "seller", verified: false });
  }

  if (input.step.intent === "breakup") {
    paragraphs.push(
      `I will stop here — I would rather not clutter your inbox. If this becomes relevant later, replying to this message will reach me.`,
    );
  } else {
    paragraphs.push(
      input.meetingLink
        ? `Worth fifteen minutes to see whether it applies to how ${input.profile.companyName} works? ${input.meetingLink}`
        : `Worth fifteen minutes to see whether it applies to how ${input.profile.companyName} works?`,
    );
  }

  return {
    subject: subjectFor(input, quote),
    body: `${greeting}\n\n${paragraphs.join("\n\n")}\n\n${input.sender.fromName}`,
    provenance,
  };
}

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
