import { llm } from "../src/infra/llm/client";
import { stripQuotedText } from "../src/core/classify";

/**
 * Simulated buyers.
 *
 * The reply path is half the agent, and it cannot be demonstrated by sending
 * mail into a void. Each persona reads what the agent actually wrote and
 * answers in character, so the loop that runs is the real one: the agent's
 * message goes to the outbox, a persona reads it, a reply lands in the inbox,
 * and the agent classifies and answers it with no special-casing anywhere.
 *
 * With an API key the replies are written by the model; without one they fall
 * back to scripted text. The agent cannot tell the difference either way.
 */

export type Disposition =
  | "warm"          // interested, asks questions, books
  | "incumbent"     // already has a tool; objects, can be won round
  | "later"         // not now, come back next quarter
  | "optout"        // asks to be removed — the agent must stop immediately
  | "silent";       // never replies

export interface BuyerPersona {
  email: string;
  name: string;
  role: string;
  company: string;
  disposition: Disposition;
  /** Replies only from this touch onward; earlier ones are ignored. */
  repliesFromTouch: number;
}

export const PERSONAS: BuyerPersona[] = [
  { email: "priya@hoverboard.test", name: "Priya Raman", role: "VP Engineering", company: "Hoverboard Logistics", disposition: "warm", repliesFromTouch: 1 },
  { email: "dmitri@meridianpay.test", name: "Dmitri Volkov", role: "CTO", company: "Meridian Pay", disposition: "incumbent", repliesFromTouch: 1 },
  { email: "anja@lumen-grid.test", name: "Anja Lindqvist", role: "Head of Platform", company: "Lumen Grid", disposition: "later", repliesFromTouch: 1 },
  { email: "tom.kearney@northgate-health.test", name: "Tom Kearney", role: "Engineering Manager", company: "Northgate Health", disposition: "optout", repliesFromTouch: 1 },
  { email: "info@atlasfreight.test", name: "Atlas Freight", role: "shared inbox", company: "Atlas Freight", disposition: "silent", repliesFromTouch: 99 },
];

export function personaFor(email: string): BuyerPersona | undefined {
  return PERSONAS.find((p) => p.email.toLowerCase() === email.toLowerCase());
}

/** Scripted replies, keyed by disposition and how many we have already sent. */
const SCRIPT: Record<Disposition, string[]> = {
  warm: [
    "This is timely — the on-call noise is genuinely our biggest complaint right now.\nWhat does pricing look like for a team of about 30 engineers?",
    "That works for us. Can you send over a time to talk this week? Happy to get our SRE lead on the call too.",
    "Good to go — we have budget approved for this quarter. Send the paperwork over and we will get it signed.",
  ],
  incumbent: [
    "We already use Datadog for most of this, so I am not sure what you would add.\nWhat is different?",
    "Fair enough, that distinction is clearer than I expected. Worth a short call — what times suit you?",
  ],
  later: [
    "Not right now — we are mid-migration until the new year. Circle back in Q1 and I will take a proper look.",
  ],
  optout: [
    "Please remove me from your list and do not contact me again.",
  ],
  silent: [],
};

const DISPOSITION_BRIEF: Record<Disposition, string> = {
  warm: "You have this exact problem and are receptive. Ask one practical question (pricing, or how it works). Be brief and businesslike.",
  incumbent: "You already use a competing tool and are sceptical but not hostile. Push back once, specifically.",
  later: "The problem is real but the timing is wrong. Decline politely and name when to come back.",
  optout: "You consider this spam. Ask curtly to be removed from the list. Two sentences at most.",
  silent: "",
};

/**
 * Produces a reply in character.
 *
 * `priorReplies` is how many times this persona has already answered, which
 * walks them along their script — warm buyers progress toward a close rather
 * than asking the same question forever.
 */
export async function replyAs(
  persona: BuyerPersona,
  inbound: { subject: string; body: string },
  priorReplies: number,
): Promise<string | null> {
  const script = SCRIPT[persona.disposition];
  if (script.length === 0) return null;
  // Once a persona has worked through its script it falls silent. Repeating
  // the last line forever made the agent and the buyer ping-pong indefinitely.
  if (priorReplies >= script.length) return null;
  const scripted = script[priorReplies]!;

  const model = llm();
  if (!model.enabled) return scripted;

  const written = await model.write({
    label: `simulate:${persona.disposition}`,
    effort: "low",
    maxTokens: 500,
    system:
      `You are ${persona.name}, ${persona.role} at ${persona.company}. You are replying to a cold ` +
      `sales email. Write only the reply body — no subject, no signature block, no quoted text.\n` +
      `Under 60 words. Write like a busy person typing on a phone: plain, direct, no pleasantries.\n` +
      `Stance: ${DISPOSITION_BRIEF[persona.disposition]}`,
    prompt:
      `This is reply number ${priorReplies + 1} in the thread.\n\n` +
      `Subject: ${inbound.subject}\n\n${stripQuotedText(inbound.body)}`,
  });

  return written ?? scripted;
}
