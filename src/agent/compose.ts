import * as z from "zod/v4";
import { llm } from "../infra/llm/client";
import { buildFooter } from "../core/compliance";
import { validateDraft, withFooter } from "../core/draft";
import type {
  DiscoveredContact, DraftMessage, FitResult, LeadProfile, Offering,
  SenderIdentity, SequenceStep,
} from "../core/types";

/**
 * Stage 5 — write the message.
 *
 * Two rules shape everything here:
 *
 * 1. **Specific or nothing.** The opening line must reference something real
 *    the crawler found on the prospect's own site. Generic outreach is both
 *    worthless and indistinguishable from spam, so when there is no evidence
 *    the composer says so rather than padding with flattery.
 * 2. **Nothing reaches a transport unvalidated.** The draft goes through
 *    `validateDraft`; if it fails, the problems are fed back to the model for
 *    one repair attempt, and if it still fails the deterministic template is
 *    used. A model that invents a customer logo cannot get that logo sent.
 */

const DraftSchema = z.object({
  subject: z.string().describe("Lowercase-ish, under 60 characters, specific, no exclamation marks."),
  body: z.string().describe("Plain text. Under 120 words. No signature block — one is appended."),
  citedEvidence: z
    .array(z.string())
    .describe(
      "Every factual claim about the SELLER made in the body, each copied verbatim from the " +
      "provided value propositions or proof points. Claims not listed here will be rejected.",
    ),
});

const INTENT_BRIEF: Record<SequenceStep["intent"], string> = {
  first_touch:
    "First contact. Open with the specific thing you found on their site. One sentence on the " +
    "problem it implies, one on what we do about it. Ask for a short conversation.",
  value_add:
    "Second touch, no reply yet. Do not say 'just following up' or 'bumping this'. Lead with a " +
    "concrete, useful observation or number. Make it worth reading on its own.",
  social_proof:
    "Third touch. Lead with a named customer or published metric from the proof points. " +
    "Keep it to three sentences.",
  objection_preempt:
    "Name the most likely reason they have not replied (already have a tool, no time, not a " +
    "priority) and address it in one line.",
  breakup:
    "Final touch. Short, warm, no guilt. Say you will stop here and leave the door open.",
};

export interface ComposeContext {
  offering: Offering;
  lead: LeadProfile;
  fit: FitResult;
  contact: DiscoveredContact;
  step: SequenceStep;
  sender: SenderIdentity;
}

function evidenceBlock(lead: LeadProfile): string {
  if (lead.evidence.length === 0) return "(none found)";
  return lead.evidence
    .slice(0, 5)
    .map((e) => `- "${e.quote}" — ${e.source}`)
    .join("\n");
}

function systemPrompt(ctx: ComposeContext): string {
  return `You write cold B2B outreach for ${ctx.offering.companyName}.

Voice: ${ctx.offering.toneOfVoice}

Hard rules:
- Under 120 words. Short sentences. No preamble, no "I hope this finds you well".
- The first line must reference the specific evidence provided about THIS company.
  If no evidence is provided, say plainly why you are writing instead of inventing rapport.
- Never claim anything about the seller that is not in the value propositions or proof
  points given to you. List every such claim in citedEvidence, copied verbatim.
- Never invent a customer name, a statistic, a mutual connection, or a previous conversation.
- No exclamation marks. No "quick question". No "circling back". No fake urgency.
- One ask, and make it small.
- Write as ${ctx.sender.fromName}. Do not add a signature or footer; one is appended.`;
}

function userPrompt(ctx: ComposeContext): string {
  const { offering, lead, fit, contact, step } = ctx;
  return `TOUCH ${step.index + 1} — ${step.intent}
${INTENT_BRIEF[step.intent]}

WHAT WE SELL
${offering.companyName}: ${offering.oneLiner}
Value propositions (the only seller claims you may make):
${offering.valueProps.map((v) => `- ${v}`).join("\n") || "- (none extracted)"}
Proof points (the only evidence you may cite):
${offering.proofPoints.map((p) => `- ${p}`).join("\n") || "- (none extracted)"}

WHO WE ARE WRITING TO
${lead.companyName} (${lead.domain})${lead.industry ? ` — ${lead.industry}` : ""}
${lead.description ?? ""}
Contact: ${contact.name ?? contact.email}${contact.title ? `, ${contact.title}` : ""}${
    contact.kind === "role" ? " (shared inbox — write to the team, not a person)" : ""
  }

EVIDENCE FOUND ON THEIR SITE (quote or reference one of these)
${evidenceBlock(lead)}

WHY WE THINK THEY FIT
${fit.reasons.slice(0, 3).map((r) => `- ${r}`).join("\n") || "- (weak fit)"}`;
}

/**
 * States what the seller does in one clean sentence.
 *
 * The naive version — company name followed by the one-liner — produced
 * "Northwind SLO northwind SLO tracks service level objectives…", because
 * most one-liners already open with the company's own name.
 */
function pitchSentence(offering: Offering): string {
  const line = offering.oneLiner.trim().replace(/\s+/g, " ");
  if (!line) return `${offering.companyName} — see ${offering.domain}.`;
  const startsWithName = line.toLowerCase().startsWith(offering.companyName.toLowerCase().split(" ")[0] ?? "");
  const sentence = startsWithName ? line : `${offering.companyName}: ${line}`;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** Deterministic template, used when no model is available or repair failed. */
export function templateDraft(ctx: ComposeContext): DraftMessage {
  const { offering, lead, contact, step } = ctx;
  const who = contact.name?.split(" ")[0] ?? "there";
  const topEvidence = lead.evidence[0];

  const opener = topEvidence
    ? `I was reading your site and saw this: "${truncate(topEvidence.quote, 150)}"`
    : `I came across ${lead.companyName} while looking at ${lead.industry ?? "companies in your space"}.`;

  // Value props are only usable verbatim as their own sentence. Splicing one
  // into a carrier phrase ("Teams use it to …") produced ungrammatical copy,
  // because an extracted prop is often a noun phrase, not a verb phrase.
  //
  // It also has to say something the pitch did not: the first value prop is
  // frequently the same sentence as the one-liner, which printed the identical
  // line twice.
  const pitch = pitchSentence(offering);
  const prop = offering.valueProps.find(
    (v) => v.length > 15 && v.length < 140 && !overlaps(v, pitch),
  );
  const supporting = prop ? `${prop.replace(/[.\s]+$/, "")}.` : undefined;

  const asks: Record<SequenceStep["intent"], string> = {
    first_touch: "Worth a short call to see if it is relevant?",
    value_add: "Happy to send a two-minute walkthrough if it would help.",
    social_proof: "Would a short call be useful?",
    objection_preempt: "If you already have this covered, just say so and I will close the loop.",
    breakup: "I will leave it there — if the timing changes, my door is open.",
  };

  const body = [
    `Hi ${who},`,
    "",
    opener,
    "",
    pitch,
    ...(supporting ? ["", supporting] : []),
    "",
    asks[step.intent],
    "",
    ctx.sender.fromName,
  ].join("\n");

  return {
    subject: subjectFor(ctx),
    body,
    citedEvidence: [supporting, offering.companyName, offering.oneLiner].filter(
      (s): s is string => Boolean(s),
    ),
  };
}

/** Words too generic to carry a subject line. */
const WEAK_SIGNAL = new Set([
  "across", "level", "budget", "tracks", "service", "services", "platform",
  "pager", "points", "objectives", "teams", "team", "company", "software",
]);

function subjectFor(ctx: ComposeContext): string {
  // Prefer a concrete signal actually observed on their site, but only if it
  // is a real term — "Hoverboard Logistics + across" is worse than nothing.
  const signal = ctx.lead.evidence
    .map((e) => e.signal)
    .find((sig) => sig && sig !== "llm:buying-signal" && !WEAK_SIGNAL.has(sig) && sig.length > 3);

  if (signal) return `${ctx.lead.companyName} + ${signal}`.slice(0, 70);

  const category = ctx.offering.categories.find((cat) => !WEAK_SIGNAL.has(cat) && cat.length > 3);
  return category
    ? `${category} at ${ctx.lead.companyName}`.slice(0, 70)
    : `${ctx.offering.companyName} <> ${ctx.lead.companyName}`.slice(0, 70);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * True when two sentences say substantially the same thing.
 *
 * Two tests, because word overlap alone let a near-paraphrase through — the
 * supporting line opened with the same seven words as the pitch and the email
 * read as a stutter. Omitting the line is always better than repeating it.
 */
function overlaps(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  const A = norm(a);
  const B = norm(b);
  if (A.length === 0 || B.length === 0) return false;

  // Same opening clause — the most visible kind of repetition.
  const opening = 5;
  if (A.slice(0, opening).join(" ") === B.slice(0, opening).join(" ")) return true;

  const setA = new Set(A);
  const shared = B.filter((w) => setA.has(w)).length;
  return shared / Math.min(setA.size, B.length) > 0.45;
}

export interface ComposeResult {
  draft: DraftMessage;
  /** "llm" | "llm-repaired" | "template" — shown in the UI for auditability. */
  via: "llm" | "llm-repaired" | "template";
  /** Validation problems that forced a fallback, if any. */
  rejectedBecause?: string[];
}

export async function compose(ctx: ComposeContext): Promise<ComposeResult> {
  const footer = buildFooter(ctx.sender);
  const model = llm();

  const finish = (draft: DraftMessage, via: ComposeResult["via"], rejectedBecause?: string[]): ComposeResult => ({
    draft: { ...draft, body: withFooter(draft.body, footer) },
    via,
    rejectedBecause,
  });

  if (!model.enabled) return finish(templateDraft(ctx), "template");

  const first = await model.extract(DraftSchema, {
    label: `compose:${ctx.step.intent}`,
    system: systemPrompt(ctx),
    prompt: userPrompt(ctx),
    effort: "medium",
    maxTokens: 2000,
  });

  if (!first) return finish(templateDraft(ctx), "template", ["model call failed"]);

  const candidate: DraftMessage = { ...first, body: withFooter(first.body, footer) };
  const check = validateDraft(candidate, ctx.offering);
  if (check.ok) return { draft: candidate, via: "llm" };

  // One repair attempt with the specific objections fed back. This recovers
  // most failures — usually an over-long subject or an unlisted claim.
  const repaired = await model.extract(DraftSchema, {
    label: `compose:${ctx.step.intent}:repair`,
    system: systemPrompt(ctx),
    prompt:
      `${userPrompt(ctx)}\n\nYour previous draft was rejected for these reasons:\n` +
      `${check.problems.map((p) => `- ${p}`).join("\n")}\n\n` +
      `Rewrite it so none of those apply. Do not add a footer.`,
    effort: "medium",
    maxTokens: 2000,
  });

  if (repaired) {
    const second: DraftMessage = { ...repaired, body: withFooter(repaired.body, footer) };
    if (validateDraft(second, ctx.offering).ok) {
      return { draft: second, via: "llm-repaired", rejectedBecause: check.problems };
    }
  }

  return finish(templateDraft(ctx), "template", check.problems);
}
