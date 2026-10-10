import * as z from "zod/v4";
import { llm } from "../infra/llm/client";
import { classifyReply } from "../core/classify";
import { buildFooter } from "../core/compliance";
import { validateDraft, withFooter } from "../core/draft";
import type {
  DealStage, DraftMessage, LeadProfile, ObjectionKind, Offering,
  ReplyAnalysis, ReplyIntent, SenderIdentity,
} from "../core/types";

/**
 * Stage 6 — handle what comes back.
 *
 * The deterministic classifier in `core/classify` runs first and owns the
 * decisions that must never be wrong (opt-out, bounce). The model is only
 * allowed to refine the *commercial* reading — is this interest, an
 * objection, a referral — and it can never overturn a stop.
 */

const RefineSchema = z.object({
  intent: z
    .enum([
      "interested", "meeting_request", "pricing_question", "commitment", "objection",
      "not_now", "not_interested", "referral", "wrong_person", "unclear",
    ])
    .describe("What the person actually wants."),
  objection: z
    .enum(["price", "timing", "incumbent", "authority", "trust", "need", "none"])
    .describe("The underlying objection, if any."),
  confidence: z.number().describe("0 to 1."),
  reasoning: z.string().describe("One sentence on why."),
  /** Surfaced to the operator on the thread. */
  suggestedAction: z.string().describe("What a good salesperson would do next, in one sentence."),
});

/**
 * How to answer each objection.
 *
 * These are instructions to the model, not canned text — a canned rebuttal
 * reads like a canned rebuttal. Each one says what a good salesperson does,
 * which is mostly "concede the point and narrow the ask".
 */
export const OBJECTION_PLAYBOOK: Record<ObjectionKind, string> = {
  // Keyed by objection; `commitment` is handled by the intent brief instead.
  price:
    "Do not discount and do not argue. Reframe against the cost of the problem they already " +
    "have, using a real number from the proof points if one exists. Offer the smallest " +
    "possible starting point.",
  timing:
    "Accept it completely. Do not push. Ask for one specific thing: permission to come back " +
    "at a named time, and confirm that date in writing.",
  incumbent:
    "Never attack the incumbent. Ask one genuine question about where it falls short for their " +
    "specific setup, and offer to be useful alongside it rather than instead of it.",
  authority:
    "Make it easy to forward. Offer a short written summary they can pass upward, and ask who " +
    "else should see it.",
  trust:
    "Lead with the most concrete proof point available and offer verifiable evidence — a " +
    "reference, documentation, a security page. Never over-claim to compensate.",
  need:
    "Ask one honest diagnostic question. If they genuinely do not have the problem, say so and " +
    "close the loop gracefully — a clean no is a good outcome.",
  none: "Answer the question directly and move toward a concrete next step.",
};

/** The pipeline stage a reply should move the deal to. */
export function stageFor(intent: ReplyIntent, current: DealStage): DealStage {
  // Closed is closed. Without this, a buyer repeating "we're good to go"
  // after the deal was won dragged it back to `proposal`, where the close
  // path marked it won again — once per tick, forever.
  if (current === "won" || current === "lost") return current;

  switch (intent) {
    /**
     * A verbal yes moves the deal to `proposal`, not to `won`.
     *
     * The agent cannot know a sale closed — only that someone said they
     * would. `won` is reserved for an observed real-world event: a
     * countersignature, a payment webhook, or an operator confirming it.
     * Letting the agent declare its own wins would make the pipeline a
     * record of its own optimism.
     */
    case "commitment":
      return "proposal";
    case "meeting_request":
      return current === "proposal" ? current : "meeting_booked";
    case "interested":
    case "pricing_question":
      return current === "meeting_booked" || current === "proposal" ? current : "engaged";
    case "objection":
    case "not_now":
    case "referral":
    case "wrong_person":
      return current === "prospect" || current === "contacted" ? "engaged" : current;
    case "not_interested":
    case "unsubscribe":
      return "lost";
    case "bounce":
      return "lost";
    default:
      return current;
  }
}

export interface AnalysedReply {
  analysis: ReplyAnalysis;
  /** Model's one-line recommendation, when available. */
  suggestedAction?: string;
  reasoning?: string;
  refinedByLlm: boolean;
}

export async function analyseReply(body: string, subject = ""): Promise<AnalysedReply> {
  const baseline = classifyReply(body, subject);

  // Stops are not negotiable — the model is not consulted and cannot override.
  if (baseline.mustStop || baseline.intent === "bounce" || baseline.intent === "auto_reply") {
    return { analysis: baseline, refinedByLlm: false };
  }

  const refined = await llm().extract(RefineSchema, {
    label: "converse:classify",
    effort: "low",
    maxTokens: 1500,
    system:
      "You classify replies to B2B sales emails. Be literal: read what the person wrote, " +
      "not what a salesperson would like it to mean. A polite brush-off is not interest.",
    prompt: `Subject: ${subject}\n\nReply:\n${body}`,
  });

  if (!refined) return { analysis: baseline, refinedByLlm: false };

  return {
    analysis: {
      ...baseline,
      intent: refined.intent,
      objection: refined.objection,
      confidence: refined.confidence,
      // A low-confidence read, a referral or a wrong-person reply still wants
      // a human, whatever the model thinks.
      needsHuman:
        refined.confidence < 0.55 || refined.intent === "referral" || refined.intent === "wrong_person",
    },
    suggestedAction: refined.suggestedAction,
    reasoning: refined.reasoning,
    refinedByLlm: true,
  };
}

// ---------------------------------------------------------------------------
// Replying
// ---------------------------------------------------------------------------

const ReplyDraftSchema = z.object({
  subject: z.string().describe("Keep the thread's subject, prefixed with 'Re: ' if not already."),
  body: z.string().describe("Plain text, under 110 words. No footer — one is appended."),
  citedEvidence: z.array(z.string()).describe("Seller claims made, copied verbatim from the inputs."),
});

/**
 * How many times the agent will answer one prospect before it stops and asks
 * a human to look.
 *
 * An agent that always has one more thing to say is a nuisance, and a thread
 * that has gone six rounds without reaching a meeting is not going to be
 * rescued by a seventh message.
 */
export const MAX_AGENT_REPLIES_PER_THREAD = 4;

export interface ReplyContext {
  offering: Offering;
  lead: LeadProfile;
  sender: SenderIdentity;
  /** Oldest first: the thread so far. */
  thread: Array<{ direction: "out" | "in"; subject: string; body: string; at: Date }>;
  analysis: ReplyAnalysis;
  /** Where the operator wants interested prospects to land. */
  meetingLink?: string;
}

export interface ReplyResult {
  draft: DraftMessage;
  via: "llm" | "template";
  /** True when this must be reviewed by a person before it goes out. */
  requiresApproval: boolean;
}

function threadTranscript(ctx: ReplyContext): string {
  return ctx.thread
    .slice(-6)
    .map((m) => `[${m.direction === "out" ? "US" : "THEM"}] ${m.subject}\n${m.body.trim()}`)
    .join("\n\n---\n\n");
}

/**
 * Objection responses that work without a model.
 *
 * Grounded entirely in the extracted offering, so they stay truthful: each
 * one concedes the point and narrows the ask, which is what a good
 * salesperson does and what a generic "happy to help" conspicuously does not.
 */
function templateObjectionReply(ctx: ReplyContext): string {
  const { offering, lead } = ctx;
  const differentiator = offering.valueProps[0]?.replace(/[.\s]+$/, "");
  const proof = offering.proofPoints[0];

  switch (ctx.analysis.objection) {
    case "incumbent":
      return [
        `Most teams we speak to already have something in place, so that is fair.`,
        differentiator
          ? `The difference is narrower than a replacement: ${differentiator}.`
          : `${offering.companyName} is usually run alongside what you already have rather than instead of it.`,
        `Where does your current setup fall short — is it the volume of alerts, or working out which one matters?`,
      ].join(" ");
    case "price":
      return [
        `Understood, and I am not going to argue the number.`,
        proof ? `For context: ${proof}.` : ``,
        `If it helps, the smallest sensible starting point is one team rather than the whole estate. Worth sizing that?`,
      ].filter(Boolean).join(" ");
    case "timing":
      return `That is fair, and I would rather not chase you through a migration. When would be a sensible month to come back? I will put it in the diary and leave you alone until then.`;
    case "authority":
      return `Makes sense. Would it help if I put a short summary together that you can forward on — one page, no deck? Happy to send it over, and tell me who else should see it.`;
    case "trust":
      return [
        `Reasonable question.`,
        proof ? `${proof}.` : `Happy to point you at documentation and a reference if that would help.`,
        `I would rather you checked than took my word for it.`,
      ].join(" ");
    case "need":
      return `Possibly not, and that is a fine answer. One question so I stop guessing: does ${lead.companyName} already have a reliable way to tell which service is causing a given alert? If yes, I will leave it there.`;
    default:
      return `Thanks for coming back to me — tell me what would be most useful and I will get it to you.`;
  }
}

export function templateReply(ctx: ReplyContext): DraftMessage {
  const last = ctx.thread.filter((m) => m.direction === "in").at(-1);
  const subject = last?.subject?.replace(/^(re:\s*)?/i, "Re: ") ?? `Re: ${ctx.offering.companyName}`;

  const bodies: Partial<Record<ReplyIntent, string>> = {
    meeting_request: ctx.meetingLink
      ? `Good — here is my calendar: ${ctx.meetingLink}\n\nGrab whatever slot suits. If none of them work, send me two times and I will make them work.`
      : `Good — send me two or three times that suit and I will work around you.`,
    pricing_question: ctx.offering.pricingModel
      ? `Pricing is ${ctx.offering.pricingModel}. For ${ctx.lead.companyName} specifically I would want to know roughly how many engineers would use it before quoting a number I can stand behind. Shall I put that together?`
      : `Happy to put exact numbers together for ${ctx.lead.companyName} — roughly how many people would use it?`,
    interested: `Glad it landed. The quickest way to work out whether it is actually useful is a short call — would that work this week or next?`,
    not_now: `Understood, and thank you for being straight with me. I will come back later in the year rather than chase you in the meantime — say the word if you would rather I did not.`,
    commitment: `That is great news. I will get the paperwork over to you today and copy in whoever needs to see it on your side.`,
    objection: templateObjectionReply(ctx),
  };

  const body = bodies[ctx.analysis.intent] ?? templateObjectionReply(ctx);

  return {
    subject: subject.slice(0, 78),
    body: `${body}\n\n${ctx.sender.fromName}`,
    // Anything quoted above comes from the extracted offering, so it is
    // declared here and checked by validateDraft like any other claim.
    citedEvidence: [ctx.offering.valueProps[0], ctx.offering.proofPoints[0], ctx.offering.pricingModel].filter(
      (s): s is string => Boolean(s),
    ),
  };
}

export async function composeReply(ctx: ReplyContext): Promise<ReplyResult> {
  const footer = buildFooter(ctx.sender);
  const model = llm();
  const agentTurns = ctx.thread.filter((m) => m.direction === "out").length;
  // A human looks before we answer anything we did not confidently
  // understand, and before the agent talks itself in circles.
  const requiresApproval =
    ctx.analysis.needsHuman ||
    ctx.analysis.confidence < 0.6 ||
    agentTurns >= MAX_AGENT_REPLIES_PER_THREAD ||
    // A commitment means money and terms. A person signs that off.
    ctx.analysis.intent === "commitment";

  if (!model.enabled) {
    const t = templateReply(ctx);
    return { draft: { ...t, body: withFooter(t.body, footer) }, via: "template", requiresApproval };
  }

  const playbook = OBJECTION_PLAYBOOK[ctx.analysis.objection];

  const drafted = await model.extract(ReplyDraftSchema, {
    label: `converse:reply:${ctx.analysis.intent}`,
    effort: "medium",
    maxTokens: 2000,
    system:
      `You are ${ctx.sender.fromName}, replying on behalf of ${ctx.offering.companyName}.\n` +
      `Voice: ${ctx.offering.toneOfVoice}\n\n` +
      `Rules:\n` +
      `- Answer the question they actually asked, first sentence.\n` +
      `- Under 110 words. No filler, no "great question", no exclamation marks.\n` +
      `- Only make claims listed in the value propositions or proof points, and list them in citedEvidence.\n` +
      `- Never invent pricing, a discount, a deadline, a customer or a capability.\n` +
      `- If you cannot answer accurately, say a colleague will follow up with specifics.\n` +
      `- No signature or footer; one is appended.`,
    prompt:
      `THEIR INTENT: ${ctx.analysis.intent}\n` +
      `OBJECTION: ${ctx.analysis.objection}\n` +
      `HOW TO HANDLE IT: ${playbook}\n\n` +
      `WHAT WE SELL\n${ctx.offering.companyName}: ${ctx.offering.oneLiner}\n` +
      `Pricing: ${ctx.offering.pricingModel ?? "not published — do not invent one"}\n` +
      `Value propositions:\n${ctx.offering.valueProps.map((v) => `- ${v}`).join("\n") || "- (none)"}\n` +
      `Proof points:\n${ctx.offering.proofPoints.map((p) => `- ${p}`).join("\n") || "- (none)"}\n` +
      (ctx.meetingLink ? `Meeting link you may share: ${ctx.meetingLink}\n` : "") +
      `\nTHREAD SO FAR\n${threadTranscript(ctx)}`,
  });

  if (!drafted) {
    const t = templateReply(ctx);
    return { draft: { ...t, body: withFooter(t.body, footer) }, via: "template", requiresApproval };
  }

  const draft: DraftMessage = { ...drafted, body: withFooter(drafted.body, footer) };
  const check = validateDraft(draft, ctx.offering);

  // A reply that fails validation is not silently downgraded — it is sent to
  // a human, because replying wrongly mid-conversation is worse than waiting.
  return {
    draft: check.ok ? draft : { ...templateReply(ctx), body: withFooter(templateReply(ctx).body, footer) },
    via: check.ok ? "llm" : "template",
    requiresApproval: requiresApproval || !check.ok,
  };
}
