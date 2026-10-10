import type { ObjectionKind, ReplyAnalysis, ReplyIntent } from "./types";

/**
 * Deterministic reply classification.
 *
 * This runs before (and as a floor under) any LLM judgement. The asymmetry
 * matters: mistaking interest for indifference costs a deal, but mistaking
 * "take me off this list" for a pricing question means continuing to mail
 * someone who told you to stop — which is both unlawful and the fastest way
 * to get a sending domain blocked. So opt-out detection is deliberately
 * over-eager and, once it fires, nothing downstream can override it.
 */

/**
 * Removes the quoted original from a reply.
 *
 * Without this the classifier reads our own outreach back to itself: our mail
 * carries the word "unsubscribe" in its footer, so every single reply would
 * classify as an opt-out.
 */
export function stripQuotedText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    // Quote markers.
    if (t.startsWith(">")) break;
    // "On Mon, 3 Mar 2026 at 10:02, Alice <a@co.com> wrote:"
    if (/^on .{10,120}\bwrote:\s*$/i.test(t)) break;
    // Outlook / Gmail separators.
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(t)) break;
    if (/^_{5,}$/.test(t)) break;
    if (/^from:\s.+/i.test(t) && kept.length > 0) break;
    if (/^sent from my \w+/i.test(t)) continue;
    kept.push(line);
  }

  return kept.join("\n").trim();
}

interface CueSet {
  intent: ReplyIntent;
  weight: number;
  patterns: RegExp[];
}

/** Opt-out language. Matched against the reply only, never the quoted thread. */
const OPT_OUT_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bopt(?:ing)?[- ]?out\b/i,
  /\btake me off\b/i,
  /\bremove me\b/i,
  /\bremove (?:my|this) (?:email|address|name)\b/i,
  /\bstop (?:emailing|contacting|messaging)\b/i,
  /\bdo not (?:contact|email|write)\b/i,
  /\bdon'?t (?:contact|email) me\b/i,
  /\bno (?:further|more) (?:emails|contact|messages)\b/i,
  /\bdelete my (?:data|details|information)\b/i,
];

const BOUNCE_PATTERNS: RegExp[] = [
  /\bmail delivery (?:failed|subsystem)\b/i,
  /\bundeliverable\b/i,
  /\bdelivery status notification\b/i,
  /\baddress not found\b/i,
  /\brecipient (?:address )?rejected\b/i,
  /\buser unknown\b/i,
  /\b550[ -]5\.\d\.\d\b/,
  /\bmailer-daemon\b/i,
];

const AUTO_REPLY_PATTERNS: RegExp[] = [
  /\bout of (?:the )?office\b/i,
  /\bautomatic reply\b/i,
  /\bauto[- ]?reply\b/i,
  /\bon (?:annual |parental )?leave\b/i,
  /\bon holiday until\b/i,
  /\bI am currently away\b/i,
  /\bwill be back on\b/i,
];

const CUES: CueSet[] = [
  {
    // Checked with the highest weight: an explicit yes must not be read as a
    // mere pricing question just because it mentions budget.
    intent: "commitment",
    weight: 4,
    patterns: [
      /\bsend (?:over |me )?(?:the )?(?:paperwork|contract|agreement|invoice|order form|msa)\b/i,
      /\b(?:we|i)(?:'ve| have)? (?:got |have )?budget (?:approved|signed off|in place)\b/i,
      /\blet'?s (?:do it|go ahead|get started|proceed)\b/i,
      /\bhappy to (?:proceed|go ahead|sign)\b/i,
      /\bwe'?re in\b/i,
      /\bready to (?:buy|sign|start|proceed)\b/i,
      /\bgood to go\b/i,
      /\bwhere do (?:i|we) sign\b/i,
    ],
  },
  {
    intent: "meeting_request",
    weight: 3,
    patterns: [
      /\b(?:book|schedule|set ?up|arrange)\s+(?:a\s+)?(?:call|meeting|demo|chat|time)\b/i,
      /\bhappy to (?:chat|talk|meet|jump on)\b/i,
      /\bcalendar\b/i,
      /\bcalendly\b/i,
      /\bwhat(?:'s| is) your availability\b/i,
      /\b(?:next|this) week (?:work|works|good)\b/i,
      /\blet'?s (?:talk|chat|meet|set up)\b/i,
      // Added after a buyer wrote "Worth a short call — what times suit you?"
      // and it classified as `unclear`, stalling a deal that was ready to book.
      /\bwhat times? (?:suit|work)\b/i,
      /\bwhen (?:suits|works|would suit)\b/i,
      /\bworth a (?:short |quick |brief )?(?:call|chat)\b/i,
      /\b(?:short|quick|brief|15|20|30)[- ]?(?:minute |min )?call\b/i,
      /\bare you free\b/i,
      /\bsend (?:me |over )?(?:a few |some )?times?\b/i,
      /\bget (?:something|time) in the diary\b/i,
      /\bjump on a call\b/i,
    ],
  },
  {
    intent: "pricing_question",
    weight: 2,
    patterns: [
      /\bhow much (?:is|does|would|are)\b/i,
      /\bwhat(?:'s| is| are) (?:the |your )?(?:pricing|price|cost|rates?)\b/i,
      // "What does pricing look like for a team of 30?" — the single most
      // common way a warm buyer asks, and it matches none of the above.
      /\bwhat (?:does|do|would) .{0,30}\b(?:cost|pricing|price)\b/i,
      /\b(?:pricing|price|cost)s? look like\b/i,
      /\bsend (?:me )?(?:a )?(?:quote|pricing|proposal|numbers)\b/i,
      /\bper (?:seat|user|month|year)\b/i,
      /\bbudget for this\b/i,
      /\bballpark\b/i,
    ],
  },
  {
    intent: "interested",
    weight: 2,
    patterns: [
      /\b(?:this |that )?(?:sounds|looks) (?:interesting|good|great|useful|relevant)\b/i,
      /\bI'?d be interested\b/i,
      /\btell me more\b/i,
      /\bmore (?:info|information|details)\b/i,
      /\bcan you send\b/i,
      /\bkeen to (?:learn|hear|know)\b/i,
    ],
  },
  {
    intent: "referral",
    weight: 3,
    patterns: [
      /\b(?:talk|speak|reach out) to\b.{0,40}\b(?:instead|about this)\b/i,
      /\bforward(?:ing|ed)? (?:this|you) (?:to|on)\b/i,
      /\bcopying in\b/i,
      /\bthe right person (?:is|would be)\b/i,
      /\bcc'?ing\b/i,
    ],
  },
  {
    intent: "wrong_person",
    weight: 3,
    patterns: [
      /\b(?:I'?m|I am) not the right person\b/i,
      /\bnot my (?:area|remit|department|team)\b/i,
      /\bwrong (?:person|department|contact)\b/i,
      /\bno longer (?:work|with)\b/i,
      /\bI don'?t (?:handle|own|manage) (?:this|that)\b/i,
    ],
  },
  {
    intent: "not_now",
    weight: 2,
    patterns: [
      /\bnot (?:right now|at the moment|this (?:quarter|year))\b/i,
      /\bcircle back\b/i,
      /\breach out (?:again )?in\b/i,
      /\bcheck back\b/i,
      /\bmaybe (?:later|next)\b/i,
      /\brevisit (?:this )?in\b/i,
      /\bbad timing\b/i,
    ],
  },
  {
    intent: "not_interested",
    weight: 3,
    patterns: [
      /\bnot interested\b/i,
      /\bno thanks?\b/i,
      /\bwe'?re (?:all )?(?:set|good|sorted|covered)\b/i,
      /\bnot a (?:fit|priority)\b/i,
      /\bno need\b/i,
      /\bplease stop\b/i,
      // "we already use X" deliberately lives under `objection` instead:
      // it is the most winnable objection there is, and treating it as a
      // refusal closed live deals as lost.
    ],
  },
  {
    intent: "objection",
    weight: 2,
    patterns: [
      /\btoo expensive\b/i,
      /\bcan'?t afford\b/i,
      /\bno budget\b/i,
      /\bwe already (?:use|using|have)\b/i,
      /\balready (?:use|using|have) \w+/i,
      /\bnot sure what you(?:'d| would)? add\b/i,
      /\bwhat(?:'s| is) different\b/i,
      /\bhow (?:is|are) (?:this|you) different\b/i,
      /\bhow (?:do|would) (?:I|we) know\b/i,
      /\bnever heard of\b/i,
      /\bneed (?:approval|sign[- ]?off)\b/i,
    ],
  },
];

const OBJECTIONS: Array<{ kind: ObjectionKind; patterns: RegExp[] }> = [
  { kind: "price", patterns: [/\btoo expensive\b/i, /\bprice\b/i, /\bcost(?:ly)?\b/i, /\bno budget\b/i, /\bcan'?t afford\b/i, /\bcheaper\b/i] },
  { kind: "timing", patterns: [/\bnot (?:right )?now\b/i, /\bnext (?:quarter|year)\b/i, /\bbad timing\b/i, /\btoo busy\b/i, /\bcircle back\b/i] },
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
 * Classifies a reply body.
 *
 * `rawBody` should be the full message; quoted history is stripped internally.
 */
export function classifyReply(rawBody: string, subject = ""): ReplyAnalysis {
  const body = stripQuotedText(rawBody);
  const haystack = `${subject}\n${body}`;

  // 1. Bounces first — a mailer daemon is not a prospect with an opinion.
  const bounceCues = anyMatch(haystack, BOUNCE_PATTERNS);
  if (bounceCues.length > 0) {
    return {
      intent: "bounce", objection: "none", confidence: 0.95,
      cues: bounceCues, mustStop: true, needsHuman: false,
    };
  }

  // 2. Opt-out next, and it is absorbing. Checked against the stripped reply
  //    so our own footer's "unsubscribe" cannot trigger it.
  const optOutCues = anyMatch(body, OPT_OUT_PATTERNS);
  if (optOutCues.length > 0) {
    return {
      intent: "unsubscribe", objection: "none", confidence: 0.97,
      cues: optOutCues, mustStop: true, needsHuman: false,
    };
  }

  // 3. Auto-replies carry no intent; the cadence should simply wait.
  const autoCues = anyMatch(haystack, AUTO_REPLY_PATTERNS);
  if (autoCues.length > 0) {
    return {
      intent: "auto_reply", objection: "none", confidence: 0.85,
      cues: autoCues, mustStop: false, needsHuman: false,
    };
  }

  // 4. Weighted cue vote across the remaining intents.
  const scores = new Map<ReplyIntent, { score: number; cues: string[] }>();
  for (const cue of CUES) {
    const hits = anyMatch(body, cue.patterns);
    if (hits.length === 0) continue;
    const prev = scores.get(cue.intent) ?? { score: 0, cues: [] };
    scores.set(cue.intent, {
      score: prev.score + hits.length * cue.weight,
      cues: [...prev.cues, ...hits],
    });
  }

  if (scores.size === 0) {
    return {
      intent: "unclear", objection: "none", confidence: 0.2,
      cues: [], mustStop: false, needsHuman: true,
    };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const [intent, top] = ranked[0]!;
  const runnerUp = ranked[1]?.[1].score ?? 0;
  // Confidence rises with the margin over the next-best reading.
  const confidence = Math.min(0.95, 0.5 + (top.score - runnerUp) / (top.score + runnerUp + 1) * 0.45);

  const objection = detectObjection(body);

  /**
   * Someone asking a question has not closed the door.
   *
   * "We already use Datadog, what would you add?" read as a flat refusal and
   * marked the deal lost. A refusal with a question in it is an objection,
   * which is a live conversation, not a dead one.
   */
  const asksSomething = /\?/.test(body);
  let resolvedIntent = intent;
  if (intent === "not_interested" && asksSomething && objection.kind !== "none") {
    resolvedIntent = "objection";
  }

  const hardNo = resolvedIntent === "not_interested";

  return {
    intent: resolvedIntent,
    objection:
      resolvedIntent === "objection" || resolvedIntent === "not_interested" ? objection.kind : "none",
    confidence,
    cues: top.cues,
    // A flat "not interested" ends the cadence, but unlike an unsubscribe it
    // is a sales outcome, not a legal instruction — recorded as a stop either way.
    mustStop: hardNo,
    needsHuman: confidence < 0.55 || resolvedIntent === "referral" || resolvedIntent === "wrong_person",
  };
}
