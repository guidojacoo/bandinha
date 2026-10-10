/**
 * The pure core.
 *
 * Nothing in here opens a socket, touches the database, or reads the clock.
 * Every decision that has to be *right* — who may be contacted, whether a
 * claim is supported, whether an address will bounce, what a reply means,
 * when the next touch is due, whether there is budget left to think — is
 * decided by a function in this directory with its inputs passed in.
 *
 * That is why the test suite can cover the dangerous paths exhaustively
 * without an inbox, a DNS resolver, or an LLM.
 */

export * from "./types";

export { assessEvidence, isUsableQuote, similar, MIN_QUOTE_CHARS, MAX_QUOTE_CHARS } from "./evidence";
export type { EvidenceVerdict } from "./evidence";

export {
  checkDeliverability, mayContact, domainOf, localPartOf, isValidSyntax,
  isRoleInbox, isNeverContact, isDisposable, isFreeMailbox,
} from "./deliverability";
export type { MxResult } from "./deliverability";

export { buildCorpus, verifyProvenance, isSupported } from "./provenance";
export type { SourceCorpus, ProvenanceVerdict } from "./provenance";

export { canSpend, record as recordSpend, estimateTokens, budgetSummary, forDay, utcDay, TASK_SHARE, DEFAULT_BUDGET } from "./budget";
export type { BudgetState, BudgetDecision, TaskKind } from "./budget";

export {
  scoreFit, bandFor, FIT_WEIGHTS, containsKeyword, matchedKeywords,
  leadCorpus, selfDescription, findDisqualifier,
} from "./fit";

export {
  evaluateSend, senderIdentityProblems, isInsideWindow, nextWindowOpening,
  buildFooter, hasOptOut, localParts,
} from "./compliance";

export {
  DEFAULT_SEQUENCE, ROLE_INBOX_SEQUENCE, advance, initialEnrollment,
  isDue, nextDueAt, stepAt, isTerminal, isPaused, addBusinessDays, isBusinessDay,
} from "./sequence";
export type { EnrollmentEvent } from "./sequence";

export { classifyReply, detectObjection, stripQuotedText, needsHuman } from "./classify";

export { validateDraft, quoteIsUsed, MAX_SUBJECT_CHARS, MIN_BODY_CHARS, MAX_BODY_CHARS } from "./draft";
export type { DraftContext } from "./draft";

export { inferIcp, normaliseIcp, routeSources, competitorPhrases } from "./icp";
export type { SourceId } from "./icp";
