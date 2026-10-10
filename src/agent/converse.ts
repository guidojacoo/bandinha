import { classifyReply, needsHuman } from "../core/classify";
import { buildCorpus } from "../core/provenance";
import { validateDraft } from "../core/draft";
import { buildFooter } from "../core/compliance";
import { withFooter } from "./compose";
import type {
  DraftMessage, DraftValidation, LeadProfile, ObjectionKind, Offering,
  ProvenanceRecord, ReplyAnalysis, SenderIdentity,
} from "../core/types";
import type { Llm } from "../infra/llm/types";

/**
 * Answering a reply — and knowing when not to.
 *
 * This is where "fully autonomous" gets defined honestly. The agent answers
 * objections itself, because that is drudgery with a known shape and the
 * material to answer them is on the seller's own website. It stops at three
 * things and hands them to a person:
 *
 *  - **Commitment.** "Send the contract" is not an email to be generated. The
 *    agent cannot sign, invoice, or mark its own deal won — a closed deal
 *    needs a payment, a countersignature or a human saying so.
 *  - **Pricing.** Quoting a number for "a team of 30" means inventing a price
 *    the seller never published.
 *  - **Routing.** A referral changes who the deal is with, which is not the
 *    agent's call to make.
 *
 * Two outcomes are absorbing and need no model at all: an opt-out suppresses
 * the address immediately and forever, and a bounce stops the sequence. Both
 * are handled before anything else, because getting them wrong is the one
 * mistake that is both unlawful and unrecoverable.
 */

export type ConverseAction =
  | { kind: "suppress"; reason: "unsubscribed" | "hard_bounce" | "not_interested"; analysis: ReplyAnalysis }
  | { kind: "escalate"; why: string; analysis: ReplyAnalysis }
  | { kind: "reply"; message: DraftMessage; validation: DraftValidation; via: "llm" | "template"; analysis: ReplyAnalysis }
  | { kind: "wait"; why: string; analysis: ReplyAnalysis };

export interface ConverseInput {
  body: string;
  subject?: string;
  offering: Offering;
  profile: LeadProfile;
  sender: SenderIdentity;
  contactName?: string;
  meetingLink?: string;
  pages?: Array<{ url: string; text: string }>;
}

export async function converse(input: ConverseInput, llm: Llm): Promise<ConverseAction> {
  const analysis = classifyReply(input.body, input.subject ?? "");

  // 1. Absorbing outcomes. No model, no discretion, no delay.
  if (analysis.intent === "unsubscribe") {
    return { kind: "suppress", reason: "unsubscribed", analysis };
  }
  if (analysis.intent === "bounce") {
    return { kind: "suppress", reason: "hard_bounce", analysis };
  }
  if (analysis.intent === "not_interested") {
    // Not a legal obligation, but a clear no is a no. Contacting them again
    // would be the behaviour that makes this whole category unwelcome.
    return { kind: "suppress", reason: "not_interested", analysis };
  }

  // 2. An out-of-office carries no intent; the cadence simply waits.
  if (analysis.intent === "auto_reply") {
    return { kind: "wait", why: "Automatic reply — the cadence will pick up where it left off.", analysis };
  }
  if (analysis.intent === "not_now") {
    return { kind: "wait", why: "They asked for a later time. Nothing more should be sent on this cadence.", analysis };
  }

  // 3. The bounded-autonomy line.
  if (needsHuman(analysis.intent, analysis.confidence)) {
    return { kind: "escalate", why: escalationReason(analysis), analysis };
  }

  // 4. Everything left is a conversation the agent can carry: interest, a
  //    meeting to arrange, an objection to answer.
  const drafted = await draftReply(input, analysis, llm);
  return { ...drafted, analysis };
}

function escalationReason(analysis: ReplyAnalysis): string {
  switch (analysis.intent) {
    case "commitment":
      return "They are ready to buy. A person has to take this: the agent cannot sign, invoice or close a deal.";
    case "pricing_question":
      return "They asked what it costs. Quoting a specific deal would mean inventing a price the seller never published.";
    case "referral":
    case "wrong_person":
      return "They pointed at someone else. Who the deal belongs to is not the agent's decision.";
    case "unclear":
      return "The reply could not be read confidently enough to answer it.";
    default:
      return `Low confidence (${analysis.confidence.toFixed(2)}) reading this reply.`;
  }
}

// ---------------------------------------------------------------------------
// Drafting the answer
// ---------------------------------------------------------------------------

const REPLY_SYSTEM = `You are replying to a prospect who answered a cold email. Plain text, no markdown.

Hard rules:
- Answer what they actually asked. Do not re-pitch.
- Every factual claim must be listed in "provenance" with the source URL it came from. Only the supplied material may be cited.
- Never invent a price, a customer name, a percentage, or a date you have not been given.
- If they want to meet, propose meeting and stop. Do not also pitch.
- 60 to 120 words. One question at most.

Return JSON exactly like:
{"body":"","provenance":[{"claim":"","source":"","kind":"seller"}]}`;

const OBJECTION_BRIEF: Record<ObjectionKind, string> = {
  price: "They raised cost. Do not negotiate and do not quote a figure you were not given. Acknowledge it, and offer the smallest possible way to find out whether it is worth anything to them.",
  timing: "Wrong time. Agree, and ask when to come back — do not argue them into now.",
  incumbent: "They already use something. This is the most winnable objection there is: ask one specific question about where the incumbent leaves a gap, using only what the supplied material actually claims.",
  authority: "They are not the decision-maker. Make it easy to forward: one short paragraph they could paste to their manager.",
  trust: "They do not know us. Offer the most verifiable thing in the supplied proof points. If there is nothing verifiable, say what they can check for themselves instead of asserting credibility.",
  need: "They say they do not have this problem. Accept it gracefully and ask one question that would tell you whether that is true.",
  none: "Answer plainly and move towards a short call.",
};

async function draftReply(
  input: ConverseInput,
  analysis: ReplyAnalysis,
  llm: Llm,
): Promise<{ kind: "reply"; message: DraftMessage; validation: DraftValidation; via: "llm" | "template" }> {
  const corpus = buildCorpus(input.offering, input.profile, input.pages ?? []);
  const context = {
    sender: input.sender,
    evidence: input.profile.evidence,
    corpus,
    allowedNames: [
      input.offering.companyName,
      input.profile.companyName,
      ...input.offering.products.map((p) => p.name),
      input.contactName ?? "",
      input.sender.fromName,
    ].filter(Boolean),
    isReply: true,
  };

  if (llm.available()) {
    const result = await llm.json<{ body?: string; provenance?: unknown }>(
      {
        task: "reply",
        tier: "large",
        system: REPLY_SYSTEM,
        user: buildReplyBrief(input, analysis),
        maxTokens: 600,
        temperature: 0.3,
      },
      (value) => value as { body?: string; provenance?: unknown },
    );

    if (result.ok && result.data?.body) {
      const message = withFooter(
        { subject: "", body: String(result.data.body).trim(), provenance: readProvenance(result.data.provenance) },
        input.sender,
      );
      const validation = validateDraft(message, context);
      // One attempt only. A reply that fails validation is answered from the
      // template rather than retried: the prospect is waiting, and a second
      // round trip against a rate-limited free tier can take a minute.
      if (validation.ok) return { kind: "reply", message, validation, via: "llm" };
    }
  }

  const message = withFooter(templateReply(input, analysis), input.sender);
  return { kind: "reply", message, validation: validateDraft(message, context), via: "template" };
}

export function buildReplyBrief(input: ConverseInput, analysis: ReplyAnalysis): string {
  return [
    `## They wrote`,
    input.body.slice(0, 1_200),
    "",
    `## How that reads`,
    `Intent: ${analysis.intent}. Objection: ${analysis.objection}.`,
    OBJECTION_BRIEF[analysis.objection],
    "",
    `## Us`,
    `${input.offering.companyName} (${input.offering.domain}): ${input.offering.oneLiner}`,
    input.offering.pricingModel ? `Published pricing: ${input.offering.pricingModel}` : "Pricing is not published, so do not state one.",
    `Capabilities: ${input.offering.products.flatMap((p) => p.capabilities).slice(0, 6).join("; ") || "not stated"}`,
    "",
    `## Claims we may make`,
    ...input.offering.valueProps.slice(0, 5).map((c) => `- "${c.text}" (source: ${c.source})`),
    "",
    `## Proof points (the only third-party facts available)`,
    input.offering.proofPoints.length > 0
      ? input.offering.proofPoints.map((c) => `- "${c.text}" (source: ${c.source})`).join("\n")
      : "(none)",
    "",
    `## Them`,
    `${input.profile.companyName} (${input.profile.domain})`,
    ...input.profile.evidence.slice(0, 2).map((e) => `- from their site: "${e.quote}" (${e.source})`),
    "",
    `## You are`,
    `${input.sender.fromName} <${input.sender.fromEmail}>`,
    input.meetingLink ? `Booking link: ${input.meetingLink}` : "No booking link — propose times instead.",
  ].filter(Boolean).join("\n");
}

/**
 * The deterministic reply.
 *
 * Short on purpose. A template answering a real human has to be the kind of
 * thing a busy person would actually write, and anything longer starts
 * asserting things it has no source for.
 */
export function templateReply(input: ConverseInput, analysis: ReplyAnalysis): DraftMessage {
  const greeting = input.contactName ? `Hi ${input.contactName.split(/\s+/)[0]},` : "Hello,";
  const provenance: ProvenanceRecord[] = [];
  const paragraphs: string[] = [];

  switch (analysis.intent) {
    case "meeting_request":
      paragraphs.push(
        input.meetingLink
          ? `Glad to. Here are my open times: ${input.meetingLink} — grab whichever suits.`
          : `Glad to. I have time most mornings this week and next — what works at your end?`,
      );
      break;

    case "interested": {
      const value = input.offering.valueProps[0];
      if (value) {
        paragraphs.push(value.text);
        provenance.push({ claim: value.text, source: value.source, kind: "seller", verified: false });
      } else {
        paragraphs.push(input.offering.oneLiner);
        provenance.push({
          claim: input.offering.oneLiner,
          source: input.offering.sources[0] ?? `https://${input.offering.domain}`,
          kind: "seller",
          verified: false,
        });
      }
      paragraphs.push(
        input.meetingLink
          ? `Fifteen minutes would tell you whether it is worth more of your time: ${input.meetingLink}`
          : `Fifteen minutes would tell you whether it is worth more of your time — what does your week look like?`,
      );
      break;
    }

    case "objection":
      paragraphs.push(objectionAnswer(input, analysis.objection, provenance));
      break;

    default:
      paragraphs.push(`Thanks for coming back to me. What would be the most useful thing for me to answer?`);
  }

  return {
    subject: "",
    body: `${greeting}\n\n${paragraphs.join("\n\n")}\n\n${input.sender.fromName}`,
    provenance,
  };
}

function objectionAnswer(
  input: ConverseInput,
  objection: ObjectionKind,
  provenance: ProvenanceRecord[],
): string {
  const cite = (claim: string, source: string) => {
    provenance.push({ claim, source, kind: "seller", verified: false });
    return claim;
  };

  switch (objection) {
    case "incumbent": {
      const capability = input.offering.products.flatMap((p) => p.capabilities)[0];
      return capability
        ? `That makes sense — most people we talk to already have something. The part that usually differs is ${capability}. Where does your current setup leave you doing it by hand?`
        : `That makes sense — most people we talk to already have something in place. Where does it leave you doing work by hand?`;
    }
    case "price":
      return input.offering.pricingModel
        ? `Fair. For what it is worth, ${cite(input.offering.pricingModel, input.offering.sources[0] ?? `https://${input.offering.domain}`)} What would it need to save to be worth looking at?`
        : `Fair. Rather than talk numbers in the abstract — what would it need to save you to be worth a look?`;
    case "timing":
      return `Understood, and I would rather come back when it is useful than keep nudging. When is the right time to raise it again?`;
    case "authority":
      return `Of course. If it helps, this is the whole thing in one line: ${cite(input.offering.oneLiner, input.offering.sources[0] ?? `https://${input.offering.domain}`)} Happy to answer anything your side needs before you pass it on.`;
    case "trust": {
      const proof = input.offering.proofPoints[0];
      return proof
        ? `Reasonable. ${cite(proof.text, proof.source)} Everything else is on ${input.offering.domain} if you want to check it yourself.`
        : `Reasonable — you have no reason to take my word for it. Everything we claim is on ${input.offering.domain}, so you can judge it without talking to me.`;
    }
    case "need":
      return `Then I have probably misread what you do, which is fair enough. Out of interest — is that something you have already solved, or does it genuinely not come up?`;
    default:
      return `Happy to answer that properly. What is the part that matters most to you?`;
  }
}

function readProvenance(value: unknown): ProvenanceRecord[] {
  if (!Array.isArray(value)) return [];
  const out: ProvenanceRecord[] = [];
  for (const raw of value) {
    const claim = String((raw as ProvenanceRecord)?.claim ?? "").trim();
    const source = String((raw as ProvenanceRecord)?.source ?? "").trim();
    if (!claim || !source) continue;
    out.push({ claim, source, kind: (raw as ProvenanceRecord)?.kind === "prospect" ? "prospect" : "seller", verified: false });
  }
  return out;
}

export { buildFooter };
