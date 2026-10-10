import type { ObjectionKind, ReplyAnalysis, ReplyIntent } from "./types";

/**
 * Deterministic reply classification.
 *
 * Runs before, and as a floor under, any model judgement. The asymmetry
 * matters: mistaking interest for indifference costs a deal, but mistaking
 * "take me off this list" for a pricing question means continuing to mail
 * someone who told you to stop — unlawful, and the fastest way to get a
 * sending domain blocked. Opt-out detection is deliberately over-eager and,
 * once it fires, nothing downstream can override it.
 */

/**
 * Removes the quoted original from a reply.
 *
 * Without this the classifier reads our own footer back: every outbound
 * message contains the word "unsubscribe", so every single reply classified
 * as an opt-out and the pipeline halted on first contact.
 */
export function stripQuotedText(raw: string): string {
  const kept: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(">")) break;
    if (/^on .{10,160}\bwrote:\s*$/i.test(t)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (/^_{5,}$/.test(t)) break;
    if (/^from:\s.+/i.test(t) && kept.length > 0) break;
    if (/^sent from my \w+/i.test(t)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

const OPT_OUT: RegExp[] = [
  /\bunsubscribe\b/i, /\bopt(?:ing)?[- ]?out\b/i, /\btake me off\b/i, /\bremove me\b/i,
  /\bremove (?:my|this) (?:email|address|name)\b/i, /\bstop (?:emailing|contacting|messaging)\b/i,
  /\bdo not (?:contact|email|write)\b/i, /\bdon'?t (?:contact|email) me\b/i,
  /\bno (?:further|more) (?:emails|contact|messages)\b/i, /\bdelete my (?:data|details|information)\b/i,
  /\bhow did you get my\b/i,
  /\bremove (?:me )?from (?:your |the |this )?(?:mailing |email |distribution )?list\b/i,
  /\bleave me alone\b/i,
  // A bare "stop" or "unsubscribe" is the entire reply. Anchored, because
  // "stop" inside a sentence usually means something else entirely
  // ("this would stop the pager going off at 3am").
  /^\s*(?:stop|unsubscribe|remove|no)\s*[.!]?\s*$/i,
];

const BOUNCE: RegExp[] = [
  /\bmail delivery (?:failed|subsystem)\b/i, /\bundeliverable\b/i, /\bdelivery status notification\b/i,
  /\baddress not found\b/i, /\brecipient (?:address )?rejected\b/i, /\buser unknown\b/i,
  /\b5\d\d[ -]5\.\d\.\d\b/, /\bmailer-daemon\b/i, /\bmailbox (?:is )?full\b/i,
  /\bundelivered mail\b/i, /\breturned to sender\b/i, /\bcould not be delivered\b/i,
  /\bdelivery (?:has )?failed\b/i, /\bno such (?:user|address|recipient)\b/i,
];

const AUTO_REPLY: RegExp[] = [
  /\bout of (?:the )?office\b/i, /\bautomatic reply\b/i, /\bauto[- ]?reply\b/i,
  /\bon (?:annual |parental )?leave\b/i, /\bon holiday until\b/i,
  /\bI am currently away\b/i, /\bwill be back on\b/i, /\bmaternity leave\b/i,
];

interface CueSet { intent: ReplyIntent; weight: number; patterns: RegExp[] }

const CUES: CueSet[] = [
  {
    // Highest weight: an explicit yes must not read as a pricing question
    // just because it mentions budget.
    intent: "commitment", weight: 4,
    patterns: [
      /\bsend (?:over |me )?(?:the )?(?:paperwork|contract|agreement|invoice|order form|msa)\b/i,
      /\b(?:we|i)(?:'ve| have)? (?:got |have )?budget (?:approved|signed off|in place)\b/i,
      /\blet'?s (?:do it|go ahead|get started|proceed)\b/i,
      /\bhappy to (?:proceed|go ahead|sign)\b/i, /\bwe'?re in\b/i,
      /\bready to (?:buy|sign|start|proceed|move forward|go ahead)\b/i,
      /\bgood to go\b/i, /\bwhere do (?:i|we) sign\b/i,
      /\b(?:let'?s|we want to) move forward\b/i, /\bwhat do you need from (?:us|me)\b/i,
      /\bget it signed\b/i, /\bsend (?:the |over the )?(?:paperwork|contract)\b/i,
    ],
  },
  {
    intent: "meeting_request", weight: 3,
    patterns: [
      /\b(?:book|schedule|set ?up|arrange)\s+(?:a\s+)?(?:call|meeting|demo|chat|time)\b/i,
      /\bhappy to (?:chat|talk|meet|jump on)\b/i, /\bcalendar\b/i, /\bcalendly\b/i,
      /\bwhat(?:'s| is) your availability\b/i, /\b(?:next|this) week (?:work|works|good)\b/i,
      /\blet'?s (?:talk|chat|meet|set up)\b/i, /\bwhat times? (?:suit|work)\b/i,
      /\bwhen (?:suits|works|would suit)\b/i, /\bworth a (?:short |quick |brief )?(?:call|chat)\b/i,
      /\b(?:short|quick|brief|15|20|30)[- ]?(?:minute |min )?call\b/i, /\bare you free\b/i,
      /\bsend (?:me |over )?(?:a few |some )?times?\b/i, /\bjump on a call\b/i,
    ],
  },
  {
    intent: "pricing_question", weight: 2,
    patterns: [
      /\bhow much (?:is|does|would|are)\b/i,
      /\bwhat(?:'s| is| are) (?:the |your )?(?:pricing|price|cost|rates?)\b/i,
      /\bwhat (?:does|do|would) .{0,30}\b(?:cost|pricing|price)\b/i,
      /\b(?:pricing|price|cost)s? look like\b/i,
      /\bsend (?:me )?(?:a )?(?:quote|pricing|proposal|numbers)\b/i,
      /\bper (?:seat|user|month|year)\b/i, /\bbudget for this\b/i, /\bballpark\b/i,
    ],
  },
  {
    intent: "interested", weight: 2,
    patterns: [
      /\b(?:this |that )?(?:sounds|looks) (?:interesting|good|great|useful|relevant)\b/i,
      /\bI'?d be interested\b/i, /\btell me more\b/i, /\bmore (?:info|information|details)\b/i,
      /\bcan you send\b/i, /\bkeen to (?:learn|hear|know)\b/i, /\bthis is timely\b/i,
      /\b(?:this|that) is (?:relevant|timely|useful|interesting)\b/i,
      /\bwe (?:do )?have (?:exactly )?(?:that|this) problem\b/i,
      /\bthat'?s (?:exactly )?(?:our|the) problem\b/i, /\bresonates\b/i,
      /\brelevant for us\b/i,
    ],
  },
  {
    intent: "referral", weight: 3,
    patterns: [
      /\b(?:talk|speak|reach out) to\b.{0,40}\b(?:instead|about this)\b/i,
      /\bforward(?:ing|ed)? (?:this|you) (?:to|on)\b/i, /\bcopying in\b/i,
      /\bthe right person (?:is|would be)\b/i, /\bcc'?ing\b/i,
    ],
  },
  {
    intent: "wrong_person", weight: 3,
    patterns: [
      /\b(?:I'?m|I am) not the right person\b/i, /\bnot my (?:area|remit|department|team)\b/i,
      /\bwrong (?:person|department|contact)\b/i, /\bno longer (?:work|with)\b/i,
      /\bI don'?t (?:handle|own|manage) (?:this|that)\b/i,
    ],
  },
  {
    intent: "not_now", weight: 2,
    patterns: [
      /\bnot (?:right now|at the moment|this (?:quarter|year))\b/i, /\bcircle back\b/i,
      /\breach out (?:again )?in\b/i, /\bcheck back\b/i, /\bmaybe (?:later|next)\b/i,
      /\brevisit (?:this )?in\b/i, /\bbad timing\b/i, /\bmid-?migration\b/i,
      // "Not a priority this quarter, try me again after June" is a
      // deferral, not a refusal; reading it as one throws away a warm lead
      // that told us exactly when to come back.
      /\btry (?:me|us) again\b/i, /\bask (?:me|us) again\b/i,
      /\bnot a (?:priority|focus) (?:this|right|at)\b/i, /\bnext (?:quarter|year)\b/i,
    ],
  },
  {
    intent: "not_interested", weight: 3,
    patterns: [
      /\bnot interested\b/i, /\bno thanks?\b/i, /\bwe'?re (?:all )?(?:set|good|sorted|covered)\b/i,
      /\bnot a (?:fit|priority)\b/i, /\bno need\b/i, /\bplease stop\b/i,
      // "we already use X" lives under `objection`: it is the most winnable
      // objection there is, and treating it as refusal closed live deals.
    ],
  },
  {
    intent: "objection", weight: 2,
    patterns: [
      /\btoo expensive\b/i, /\bcan'?t afford\b/i, /\bno budget\b/i,
      /\bwe already (?:use|using|have)\b/i, /\balready (?:use|using|have) \w+/i,
      /\bnot sure what you(?:'d| would)? add\b/i, /\bwhat(?:'s| is) different\b/i,
      /\bhow (?:is|are) (?:this|you) different\b/i, /\bhow (?:do|would) (?:I|we) know\b/i,
      /\bnever heard of\b/i, /\bneed (?:approval|sign[- ]?off)\b/i,
    ],
  },
];

const OBJECTIONS: Array<{ kind: ObjectionKind; patterns: RegExp[] }> = [
  { kind: "price", patterns: [/\btoo expensive\b/i, /\bprice\b/i, /\bcost(?:ly)?\b/i, /\bno budget\b/i, /\bcan'?t afford\b/i, /\bcheaper\b/i] },
  { kind: "timing", patterns: [/\bnot (?:right )?now\b/i, /\bnext (?:quarter|year)\b/i, /\bbad timing\b/i, /\btoo busy\b/i, /\bcircle back\b/i, /\bmigration\b/i] },
  { kind: "incumbent", patterns: [/\balready (?:use|using|have)\b/i, /\bwe use \w+/i, /\bcurrent (?:vendor|provider|supplier|tool)\b/i, /\bunder contract\b/i] },
  { kind: "authority", patterns: [/\bneed (?:approval|sign[- ]?off)\b/i, /\bnot my (?:call|decision)\b/i, /\bmy (?:boss|manager|cto|ceo)\b/i, /\bprocurement\b/i] },
  { kind: "trust", patterns: [/\bnever heard of\b/i, /\bhow (?:do|would) (?:I|we) know\b/i, /\breferences?\b/i, /\bcase stud(?:y|ies)\b/i, /\bsecurity review\b/i] },
  { kind: "need", patterns: [/\bdon'?t (?:need|have) (?:this|that|a)\b/i, /\bnot a (?:fit|priority)\b/i, /\bno need\b/i, /\bnot relevant\b/i] },
];

function anyMatch(text: string, patterns: RegExp[]): string[] {
  const hits: string[] = [];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}

export function detectObjection(text: string): { kind: ObjectionKind; cues: string[] } {
  let best: { kind: ObjectionKind; cues: string[] } = { kind: "none", cues: [] };
  for (const o of OBJECTIONS) {
    const cues = anyMatch(text, o.patterns);
    if (cues.length > best.cues.length) best = { kind: o.kind, cues };
  }
  return best;
}

/**
 * Where bounded autonomy is actually drawn.
 *
 * The agent prospects, writes, sends, and handles objections on its own. It
 * stops short of three things, every time:
 *
 *  - **Commitment.** "Send the contract" is where a person takes over. The
 *    agent cannot sign, invoice, or mark its own deal won.
 *  - **Pricing.** Quoting a number for "a team of 30" means inventing a
 *    price the seller never published.
 *  - **Routing.** A referral or a wrong-person reply changes who the deal is
 *    with, which is not the agent's call.
 *
 * Plus anything it is not confident about. This is the honest version of
 * "fully autonomous": autonomous through the part that is drudgery, escalating
 * the part where being wrong costs money or credibility.
 */
export function needsHuman(intent: ReplyIntent, confidence: number): boolean {
  if (["commitment", "pricing_question", "referral", "wrong_person"].includes(intent)) return true;
  if (intent === "unclear") return true;
  return confidence < 0.55;
}

export function classifyReply(rawBody: string, subject = ""): ReplyAnalysis {
  const body = stripQuotedText(rawBody);
  const haystack = `${subject}\n${body}`;

  // 1. Bounces first — a mailer daemon is not a prospect with an opinion.
  const bounceCues = anyMatch(haystack, BOUNCE);
  if (bounceCues.length > 0) {
    return { intent: "bounce", objection: "none", confidence: 0.95, cues: bounceCues, mustStop: true, needsHuman: false };
  }

  // 2. Opt-out next, and absorbing. Checked against the stripped reply so
  //    our own footer cannot trigger it.
  const optOutCues = anyMatch(body, OPT_OUT);
  if (optOutCues.length > 0) {
    return { intent: "unsubscribe", objection: "none", confidence: 0.97, cues: optOutCues, mustStop: true, needsHuman: false };
  }

  // 3. Auto-replies carry no intent; the cadence should simply wait.
  const autoCues = anyMatch(haystack, AUTO_REPLY);
  if (autoCues.length > 0) {
    return { intent: "auto_reply", objection: "none", confidence: 0.85, cues: autoCues, mustStop: false, needsHuman: false };
  }

  const scores = new Map<ReplyIntent, { score: number; cues: string[] }>();
  for (const cue of CUES) {
    const hits = anyMatch(body, cue.patterns);
    if (hits.length === 0) continue;
    const prev = scores.get(cue.intent) ?? { score: 0, cues: [] };
    scores.set(cue.intent, { score: prev.score + hits.length * cue.weight, cues: [...prev.cues, ...hits] });
  }

  if (scores.size === 0) {
    return { intent: "unclear", objection: "none", confidence: 0.2, cues: [], mustStop: false, needsHuman: true };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const [intent, top] = ranked[0]!;
  const runnerUp = ranked[1]?.[1].score ?? 0;
  const confidence = Math.min(0.95, 0.5 + ((top.score - runnerUp) / (top.score + runnerUp + 1)) * 0.45);

  const objection = detectObjection(body);

  /**
   * Someone asking a question has not closed the door. "We already use
   * Datadog, what would you add?" read as a flat refusal and marked a live
   * deal lost; a refusal with a question in it is an objection.
   */
  const resolvedIntent: ReplyIntent =
    intent === "not_interested" && /\?/.test(body) && objection.kind !== "none" ? "objection" : intent;

  return {
    intent: resolvedIntent,
    objection: resolvedIntent === "objection" || resolvedIntent === "not_interested" ? objection.kind : "none",
    confidence,
    cues: top.cues,
    mustStop: resolvedIntent === "not_interested",
    needsHuman: needsHuman(resolvedIntent, confidence),
  };
}
