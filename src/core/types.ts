/**
 * Rainmaker domain model.
 *
 * Everything in `src/core` is pure: no network, no database, no clock except
 * one that is passed in. That is deliberate — the parts of a sales agent that
 * must be *provably* right (who we are allowed to contact, how we score a
 * prospect, when the next touch is due) should be testable without mocking an
 * inbox.
 */

export type Channel = "email";

export const CHANNELS: readonly Channel[] = ["email"] as const;

// ---------------------------------------------------------------------------
// What we sell — extracted from the seller's own website
// ---------------------------------------------------------------------------

export interface Product {
  name: string;
  /** One sentence a buyer would recognise. */
  summary: string;
  /** Concrete capabilities, as the site states them. */
  capabilities: string[];
  /** Price as published, when the site publishes one. */
  priceLabel?: string;
}

export interface Offering {
  companyName: string;
  domain: string;
  /** What the company does, in one sentence. */
  oneLiner: string;
  products: Product[];
  /** Benefit claims the site makes. Used to ground outreach copy. */
  valueProps: string[];
  /**
   * Named customers, metrics, certifications — anything that is evidence
   * rather than assertion. Outreach may only cite things from here.
   */
  proofPoints: string[];
  pricingModel?: string;
  /** Industry/category labels, e.g. "observability", "dental practices". */
  categories: string[];
  /** How the company writes, so outreach does not sound like a different firm. */
  toneOfVoice: string;
  /**
   * Category phrases lifted from page titles and taglines.
   *
   * Kept separate from `valueProps` because they are fragments, not prose:
   * "error budget tracking for microservices teams" identifies a competitor
   * perfectly but reads terribly when quoted in the middle of an email.
   */
  positioningPhrases?: string[];
  /** Where each fact came from, so a claim can always be traced to a page. */
  sources: string[];
}

// ---------------------------------------------------------------------------
// Who buys it
// ---------------------------------------------------------------------------

export interface Icp {
  /** Industries or verticals that buy this. */
  industries: string[];
  /** Employee-count band. */
  sizeMin: number;
  sizeMax: number;
  /** Job titles with budget or pain. */
  buyerTitles: string[];
  /** Observable problems this buyer has that the offering solves. */
  painSignals: string[];
  /**
   * Things that, if observed on a prospect's site, mean they are a good fit.
   * Each is a lowercase keyword matched against crawled text.
   */
  positiveSignals: string[];
  /** Observations that disqualify — competitor, wrong model, too early. */
  negativeSignals: string[];
  geographies: string[];
  /** Free-text summary for prompting. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Who we found
// ---------------------------------------------------------------------------

export interface LeadEvidence {
  /** Lowercase keyword or phrase actually found. */
  signal: string;
  /** The sentence it appeared in, for grounding outreach. */
  quote: string;
  /** Page URL it came from. */
  source: string;
}

export interface LeadProfile {
  companyName: string;
  domain: string;
  description?: string;
  industry?: string;
  /** Best estimate of headcount; undefined when unknown rather than guessed. */
  employeeEstimate?: number;
  location?: string;
  technologies: string[];
  evidence: LeadEvidence[];
  /** Publicly published role inboxes, e.g. sales@, hello@. */
  publicContacts: DiscoveredContact[];
}

export interface DiscoveredContact {
  email: string;
  /** Role or person name when the page states one. */
  name?: string;
  title?: string;
  /** Page the address was published on — the lawful-basis paper trail. */
  source: string;
  /** A shared role inbox (info@) vs a named individual. */
  kind: "role" | "individual";
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type FitSignalId =
  | "industry"
  | "size"
  | "painSignals"
  | "technology"
  | "geography"
  | "contactability"
  | "disqualifiers";

export interface FitSignal {
  id: FitSignalId;
  label: string;
  /** 0..1 — how well the prospect matches on this dimension. null = unknown. */
  value: number | null;
  weight: number;
  detail: string;
}

export type FitBand = "strong" | "good" | "marginal" | "poor" | "disqualified";

export interface FitResult {
  /** 0..100, higher = better prospect. */
  score: number;
  band: FitBand;
  signals: FitSignal[];
  /** Ordered best-first, ready to show a human or feed a prompt. */
  reasons: string[];
  /** Set when a hard disqualifier fired; the lead must not be contacted. */
  disqualifiedBecause?: string;
}

// ---------------------------------------------------------------------------
// Outreach
// ---------------------------------------------------------------------------

export type StepKind = "email";

export interface SequenceStep {
  /** 0-based position in the cadence. */
  index: number;
  kind: StepKind;
  /** Business days to wait after the previous step before sending this one. */
  delayDays: number;
  /** What this touch is for — steers generation. */
  intent:
    | "first_touch"
    | "value_add"
    | "social_proof"
    | "objection_preempt"
    | "breakup";
}

export interface Sequence {
  name: string;
  steps: SequenceStep[];
}

export type EnrollmentState =
  | "pending"      // enrolled, nothing sent yet
  | "active"       // mid-cadence
  | "replied"      // prospect responded; cadence paused
  | "meeting"      // meeting booked
  | "won"
  | "lost"
  | "unsubscribed"
  | "bounced"
  | "exhausted";   // cadence finished with no reply

export interface EnrollmentSnapshot {
  state: EnrollmentState;
  /** Index of the next step to send; equals steps.length when exhausted. */
  nextStepIndex: number;
  lastSentAt?: Date;
  repliedAt?: Date;
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export type ReplyIntent =
  | "interested"
  | "meeting_request"
  | "pricing_question"
  /** An explicit yes: send the contract, we have budget, let's proceed. */
  | "commitment"
  | "objection"
  | "not_now"
  | "not_interested"
  | "unsubscribe"
  | "wrong_person"
  | "referral"
  | "auto_reply"
  | "bounce"
  | "unclear";

export type ObjectionKind =
  | "price"
  | "timing"
  | "incumbent"
  | "authority"
  | "trust"
  | "need"
  | "none";

export interface ReplyAnalysis {
  intent: ReplyIntent;
  objection: ObjectionKind;
  /** 0..1 — how strongly the text supports this reading. */
  confidence: number;
  /** Phrases that drove the classification, for auditability. */
  cues: string[];
  /** True when the agent must stop contacting this person immediately. */
  mustStop: boolean;
  /** True when a human should look before anything else is sent. */
  needsHuman: boolean;
}

export type DealStage =
  | "prospect"
  | "contacted"
  | "engaged"
  | "meeting_booked"
  | "proposal"
  | "won"
  | "lost";

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

export type SuppressionReason =
  | "unsubscribed"
  | "hard_bounce"
  | "complained"
  | "manual"
  | "not_interested";

export interface SenderIdentity {
  fromName: string;
  fromEmail: string;
  /** Required by CAN-SPAM §7704(a)(5): a real postal address. */
  postalAddress: string;
  /** Where "unsubscribe" resolves to. */
  unsubscribeUrl?: string;
  replyTo?: string;
}

export interface ComplianceConfig {
  sender: SenderIdentity;
  /** Max messages per calendar day across the whole workspace. */
  dailySendCap: number;
  /** Max messages to any one recipient domain per day. */
  perDomainDailyCap: number;
  /** Minimum whole days between two touches to the same contact. */
  minHoursBetweenTouches: number;
  /**
   * Minutes to add to UTC to get the sending locale's local time
   * (e.g. -180 for UTC-3). Send windows below are evaluated in that locale.
   */
  timezoneOffsetMinutes: number;
  /** Local-time hours (0-23) during which sending is allowed, [start, end). */
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  /** Days of week allowed, 0=Sunday. */
  sendDays: number[];
  /** Refuse to contact these domains entirely. */
  blockedDomains: string[];
}

export interface SendAttempt {
  toEmail: string;
  now: Date;
  /**
   * True when this message answers something the recipient sent us.
   *
   * Frequency rules exist to stop cold outreach becoming harassment. They
   * must not apply to a reply: a prospect who asks a question at 10am and is
   * told nothing for 48 hours because of an anti-spam throttle is a lost
   * deal, and a silence they never asked for.
   */
  isReply?: boolean;
  /** Sends already made today, workspace-wide. */
  sentToday: number;
  /** Sends already made today to this recipient's domain. */
  sentTodayToDomain: number;
  /** When this contact was last messaged, if ever. */
  lastTouchedAt?: Date;
  suppressed: boolean;
  suppressionReason?: SuppressionReason;
}

export type ComplianceDecision =
  | { allowed: true }
  | { allowed: false; code: ComplianceBlockCode; reason: string; retryAt?: Date };

export type ComplianceBlockCode =
  | "suppressed"
  | "blocked_domain"
  | "invalid_recipient"
  | "daily_cap"
  | "domain_cap"
  | "too_soon"
  | "outside_window"
  | "missing_sender_identity";

// ---------------------------------------------------------------------------
// Drafted message
// ---------------------------------------------------------------------------

export interface DraftMessage {
  subject: string;
  body: string;
  /** Which evidence the copy leans on; used to verify nothing was invented. */
  citedEvidence: string[];
}

export interface DraftValidation {
  ok: boolean;
  problems: string[];
  warnings: string[];
}
