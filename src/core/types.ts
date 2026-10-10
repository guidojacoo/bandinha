/**
 * Mercurio domain model.
 *
 * Everything in `src/core` is pure: no network, no database, and no clock
 * except one passed in. The parts of a sales agent that must be *provably*
 * right — who we may contact, whether a claim is true, whether an address
 * will bounce, when the next touch is due — belong here, where they can be
 * tested exhaustively without an inbox.
 *
 * SQLite has no enums, so these union types are the single source of truth;
 * the database stores them as strings.
 */

export type Channel = "email";

// ---------------------------------------------------------------------------
// What we sell
// ---------------------------------------------------------------------------

export interface Product {
  name: string;
  summary: string;
  capabilities: string[];
  priceLabel?: string;
}

/**
 * A fact extracted from the seller's own website.
 *
 * Claims are not free-floating strings: each carries the page it came from,
 * so outreach can be checked against its sources rather than trusted.
 */
export interface SourcedClaim {
  text: string;
  /** URL of the page this was read from. */
  source: string;
}

export interface Offering {
  companyName: string;
  domain: string;
  oneLiner: string;
  products: Product[];
  /** Benefit claims, each tied to the page that makes it. */
  valueProps: SourcedClaim[];
  /**
   * Verifiable evidence only — named customers, published metrics,
   * certifications. Outreach may cite nothing else about the seller.
   */
  proofPoints: SourcedClaim[];
  pricingModel?: string;
  categories: string[];
  toneOfVoice: string;
  /** Category phrases from titles and taglines; used to spot competitors. */
  positioningPhrases: string[];
  /** Every page that was read. */
  sources: string[];
}

// ---------------------------------------------------------------------------
// Who buys it
// ---------------------------------------------------------------------------

export interface Icp {
  industries: string[];
  sizeMin: number;
  sizeMax: number;
  buyerTitles: string[];
  /** Lowercase keywords observable on a prospect's own public website. */
  painSignals: string[];
  positiveSignals: string[];
  /** Phrases that mean "this company sells what we sell". */
  negativeSignals: string[];
  geographies: string[];
  summary: string;
  /**
   * Which discovery sources suit this ICP, best first. Derived at ingest:
   * a developer tool should prospect GitHub, a local service should
   * prospect OpenStreetMap.
   */
  preferredSources: string[];
  /** Free-text hints a source can use, e.g. OSM amenity tags, GitHub topics. */
  sourceHints: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Who we found
// ---------------------------------------------------------------------------

/**
 * A sentence found on the prospect's own site that shows the pain.
 *
 * This is the single most important structure in the product. Outreach that
 * cannot attach one of these is not sent at all — see `core/evidence.ts`.
 */
export interface LeadEvidence {
  /** Which ICP signal it matched. */
  signal: string;
  /** The sentence, verbatim, quotable back to them. */
  quote: string;
  source: string;
}

export interface DiscoveredContact {
  email: string;
  name?: string;
  title?: string;
  /** Page the address was published on. */
  source: string;
  kind: "role" | "individual";
}

export interface LeadProfile {
  companyName: string;
  domain: string;
  description?: string;
  industry?: string;
  employeeEstimate?: number;
  location?: string;
  technologies: string[];
  evidence: LeadEvidence[];
  publicContacts: DiscoveredContact[];
}

// ---------------------------------------------------------------------------
// Fit scoring
// ---------------------------------------------------------------------------

export type FitSignalId =
  | "evidence"
  | "industry"
  | "size"
  | "technology"
  | "geography"
  | "contactability"
  | "disqualifiers";

export interface FitSignal {
  id: FitSignalId;
  label: string;
  /** 0..1 rot/fit contribution; null when the site does not answer it. */
  value: number | null;
  weight: number;
  detail: string;
}

export type FitBand = "strong" | "good" | "marginal" | "poor" | "disqualified";

export interface FitResult {
  score: number;
  band: FitBand;
  signals: FitSignal[];
  reasons: string[];
  disqualifiedBecause?: string;
}

// ---------------------------------------------------------------------------
// Deliverability
// ---------------------------------------------------------------------------

export type DeliverabilityVerdict = "deliverable" | "risky" | "undeliverable";

export type DeliverabilityReasonCode =
  | "ok"
  | "syntax"
  | "never_contact"
  | "disposable"
  | "no_mx"
  | "dns_error"
  | "role_inbox"
  | "free_mailbox"
  | "unchecked";

export interface DeliverabilityCheck {
  email: string;
  verdict: DeliverabilityVerdict;
  code: DeliverabilityReasonCode;
  detail: string;
  /** True when an MX lookup was actually performed. */
  mxChecked: boolean;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * One factual claim in an outgoing message, with where it came from.
 *
 * Fabricated customer logos and invented metrics are a documented failure of
 * this product category, not a hypothetical. Every claim a message makes is
 * recorded here and checked against what was actually crawled before the
 * message can be sent.
 */
export interface ProvenanceRecord {
  /** The claim as it appears (or nearly appears) in the message. */
  claim: string;
  /** Where it came from: a page on the seller's site or the prospect's. */
  source: string;
  kind: "seller" | "prospect";
  /** False when the claim could not be matched back to its source text. */
  verified: boolean;
}

// ---------------------------------------------------------------------------
// Outreach
// ---------------------------------------------------------------------------

export type StepIntent =
  | "first_touch"
  | "value_add"
  | "social_proof"
  | "objection_preempt"
  | "breakup";

export interface SequenceStep {
  index: number;
  /** Business days to wait after the previous step. */
  delayDays: number;
  intent: StepIntent;
}

export interface Sequence {
  name: string;
  steps: SequenceStep[];
}

export type EnrollmentState =
  | "pending" | "active" | "replied" | "meeting"
  | "won" | "lost" | "unsubscribed" | "bounced" | "exhausted";

export interface EnrollmentSnapshot {
  state: EnrollmentState;
  nextStepIndex: number;
  lastSentAt?: Date;
  repliedAt?: Date;
}

export interface DraftMessage {
  subject: string;
  body: string;
  /** Claims the copy makes, each to be verified before sending. */
  provenance: ProvenanceRecord[];
}

export interface DraftValidation {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

export type ReplyIntent =
  | "interested" | "meeting_request" | "pricing_question" | "commitment"
  | "objection" | "not_now" | "not_interested" | "unsubscribe"
  | "wrong_person" | "referral" | "auto_reply" | "bounce" | "unclear";

export type ObjectionKind =
  | "price" | "timing" | "incumbent" | "authority" | "trust" | "need" | "none";

export interface ReplyAnalysis {
  intent: ReplyIntent;
  objection: ObjectionKind;
  confidence: number;
  cues: string[];
  /** The agent must stop contacting this person immediately. */
  mustStop: boolean;
  /** A human should look before anything else is sent. */
  needsHuman: boolean;
}

export type DealStage =
  | "prospect" | "contacted" | "engaged"
  | "meeting_booked" | "proposal" | "won" | "lost";

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

export type SuppressionReason =
  | "unsubscribed" | "hard_bounce" | "complained"
  | "manual" | "not_interested" | "undeliverable";

export interface SenderIdentity {
  fromName: string;
  fromEmail: string;
  /** Required on commercial mail by CAN-SPAM §7704(a)(5). */
  postalAddress: string;
  unsubscribeUrl?: string;
  replyTo?: string;
}

export interface ComplianceConfig {
  sender: SenderIdentity;
  dailySendCap: number;
  perDomainDailyCap: number;
  minHoursBetweenTouches: number;
  /** Minutes to add to UTC to get the sending locale's local time. */
  timezoneOffsetMinutes: number;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
  sendDays: number[];
  blockedDomains: string[];
}

export interface SendAttempt {
  toEmail: string;
  now: Date;
  sentToday: number;
  sentTodayToDomain: number;
  lastTouchedAt?: Date;
  suppressed: boolean;
  suppressionReason?: SuppressionReason;
  /**
   * True when answering something the recipient sent us. Frequency rules
   * exist to stop cold outreach becoming harassment; they must never gag a
   * reply to a live question.
   */
  isReply?: boolean;
  /** Result of the pre-flight check, when one was run. */
  deliverability?: DeliverabilityCheck;
}

export type ComplianceBlockCode =
  | "suppressed" | "blocked_domain" | "invalid_recipient" | "undeliverable"
  | "daily_cap" | "domain_cap" | "too_soon" | "outside_window"
  | "missing_sender_identity" | "no_evidence";

export type ComplianceDecision =
  | { allowed: true }
  | { allowed: false; code: ComplianceBlockCode; reason: string; retryAt?: Date };
