import { db, logEvent } from "../infra/db";
import { enqueue } from "../infra/queue";
import { toJson } from "../lib/json";
import type { Icp, Offering, SenderIdentity } from "../core/types";

/**
 * Starting a campaign.
 *
 * One function, because there are three ways in — the console's form, `npm
 * run sell`, and a test — and they were each creating the row themselves with
 * slightly different ideas about the defaults. The console capped the lead
 * target at five hundred and the CLI did not; one set the status to `running`
 * before anything had been read. Those differences were not decisions.
 *
 * The important part is the second half of the job: a campaign that exists
 * and has no work queued does nothing, and looks exactly like one that is
 * working. Creating the row and queueing the first piece of work belong in
 * the same place, and in that order.
 */

export interface StartCampaignInput {
  userId: string;
  url: string;
  sender: SenderIdentity;
  meetingLink?: string | null;
  targetLeads?: number;
  minFitScore?: number;
  clientId?: string | null;
  /**
   * The crawl's result, when the caller already did it.
   *
   * `npm run sell` ingests inline on purpose: it prints the offer and the ICP
   * it derived and asks whether they look right, which needs the answer
   * before the campaign exists. The console does not — a dozen pages fetched
   * politely is longer than any hosting platform's request timeout — so it
   * leaves this out and a worker does the reading.
   */
  ingested?: {
    offering: Offering;
    icp: Icp;
    via?: unknown;
    notes?: string[];
  };
}

export interface StartedCampaign {
  id: string;
  name: string;
  status: "running" | "ingesting";
}

/** Clamped in one place, so the console and the CLI cannot disagree. */
function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A name to show until the crawl finds the company's real one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
}

export async function startCampaign(input: StartCampaignInput): Promise<StartedCampaign> {
  const ingested = input.ingested;
  const status = ingested ? "running" : "ingesting";
  const name = ingested?.offering.companyName || hostOf(input.url);

  const campaign = await db.campaign.create({
    data: {
      userId: input.userId,
      clientId: input.clientId ?? null,
      sourceUrl: input.url,
      name,
      status,
      offering: ingested ? toJson(ingested.offering) : null,
      icp: ingested ? toJson(ingested.icp) : null,
      senderIdentity: toJson(input.sender),
      meetingLink: input.meetingLink || null,
      targetLeads: clamp(input.targetLeads, 25, 1, 500),
      minFitScore: clamp(input.minFitScore, 55, 0, 100),
      // Never on at creation. Arming live sending is a separate, deliberate
      // action with a typed confirmation, and the one irreversible thing in
      // the product.
      liveSending: false,
    },
  });

  await logEvent(
    campaign.id,
    "campaign.created",
    ingested ? `Created from ${input.url}.` : `Created from ${input.url}. Reading the site now.`,
    { level: "success", data: ingested ? { via: ingested.via, notes: ingested.notes } : undefined },
  );

  // The work, queued in the same breath as the row. A campaign with nothing
  // queued is indistinguishable from one that is working.
  await enqueue({ kind: ingested ? "tick" : "ingest", campaignId: campaign.id });

  return { id: campaign.id, name, status };
}
