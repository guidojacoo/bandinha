import { db } from "../infra/db";
import { fromJson } from "../lib/json";
import {
  analyseAll, brief, qualityBand, subjectBand,
  type DimensionReport, type Outcome,
} from "../core/learning";
import type { LeadProfile, ReplyAnalysis } from "../core/types";

/**
 * Attributing replies back to what produced them.
 *
 * Reads only what the pipeline already stored: the first message to each
 * prospect, the attributes it had, and whether anybody replied. Nothing extra
 * is recorded for this, which matters — a learning layer that needs its own
 * instrumentation drifts out of step with the thing it is measuring.
 *
 * Per *prospect*, not per message. A four-touch sequence is one attempt at
 * one company, and counting the touches separately would quadruple the
 * denominator and quarter the apparent reply rate.
 */

/** Replies that mean something good, as opposed to merely arriving. */
const POSITIVE_INTENTS = new Set([
  "interested", "meeting_request", "pricing_question", "commitment", "referral",
]);

export async function outcomesFor(campaignId: string): Promise<Outcome[]> {
  const leads = await db.lead.findMany({
    where: { campaignId, status: "enrolled" },
    include: {
      // Messages hang off a contact, not off a lead — a company can publish
      // several addresses and the agent writes to one of them. Flattened
      // here rather than denormalised in the schema.
      contacts: { include: { messages: { orderBy: { createdAt: "asc" } } } },
      enrollments: true,
    },
  });

  const outcomes: Outcome[] = [];

  for (const lead of leads) {
    const messages = lead.contacts
      .flatMap((contact) => contact.messages)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const first = messages.find(
      (message) => message.direction === "outbound" && message.status === "sent" && message.stepIndex === 0,
    );
    // Never contacted means nothing to attribute. A lead that was enrolled
    // and then blocked by the warmup ramp is not evidence about anything.
    if (!first) continue;

    const inbound = messages.filter((message) => message.direction === "inbound");
    const analyses = inbound.map((message) => fromJson<ReplyAnalysis | null>(message.analysis, null));
    const human = analyses.filter((analysis) => analysis && analysis.intent !== "bounce" && analysis.intent !== "auto_reply");

    const profile = fromJson<LeadProfile | null>(lead.profile, null);
    const contact = lead.contacts.find((c) => c.email === first.toEmail);

    outcomes.push({
      attributes: {
        // The signal the evidence matched. The most actionable dimension
        // there is: it says whether the ICP is pointed at the right problem.
        pain_signal: profile?.evidence?.[0]?.signal,
        // Which free source produced a prospect who answered.
        discovery_source: lead.discoveredVia.split(":")[0]?.trim() || undefined,
        step_intent: first.stepIntent ?? undefined,
        composed_via: first.composedVia ?? undefined,
        quality_band: first.qualityScore === null ? undefined : qualityBand(first.qualityScore),
        subject_length: subjectBand(first.subject),
        contact_kind: contact ? (contact.kind === "role" ? "shared inbox" : "named person") : undefined,
      },
      replied: human.length > 0,
      positive: human.some((analysis) => analysis && POSITIVE_INTENTS.has(analysis.intent)),
      bounced: lead.enrollments.some((enrollment) => enrollment.state === "bounced"),
      optedOut: analyses.some((analysis) => analysis?.intent === "unsubscribe"),
    });
  }

  return outcomes;
}

export async function reportFor(campaignId: string): Promise<{
  outcomes: Outcome[];
  reports: DimensionReport[];
  briefLines: string[];
}> {
  const outcomes = await outcomesFor(campaignId);
  const reports = analyseAll(outcomes);
  return { outcomes, reports, briefLines: brief(reports) };
}

/**
 * The headline numbers, for the console and the health check.
 *
 * Reply rate over *prospects contacted*, which is the only denominator that
 * means anything to somebody deciding whether this is working.
 */
export async function headline(campaignId: string): Promise<{
  contacted: number;
  replied: number;
  positive: number;
  replyRate: number;
  positiveRate: number;
}> {
  const outcomes = await outcomesFor(campaignId);
  const contacted = outcomes.length;
  const replied = outcomes.filter((outcome) => outcome.replied).length;
  const positive = outcomes.filter((outcome) => outcome.positive).length;
  return {
    contacted,
    replied,
    positive,
    replyRate: contacted > 0 ? replied / contacted : 0,
    positiveRate: contacted > 0 ? positive / contacted : 0,
  };
}
