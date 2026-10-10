import { fromJson } from "../lib/json";
import { db } from "../infra/db";
import { describeSources, discoverProspects } from "../infra/sources";
import { inferIcp } from "../core/icp";
import { colour, heading, requireDatabase, run } from "./lib";
import type { Icp, Offering } from "../core/types";

/**
 * `npm run discover [campaignId]` — the open-data sources, run live.
 *
 * Separate from the demo on purpose. The demo proves the agent's behaviour
 * against a fixture web, which is the only honest way to show sending and
 * replying; this command proves the discovery half against the real services,
 * which is the half that cannot be faked without the whole "no paid data
 * vendor" claim becoming a story.
 *
 * With no campaign it runs a worked example, so the sources can be checked
 * before anything is set up.
 */

run(async () => {
  heading("Prospect sources");
  for (const source of describeSources()) {
    const tag = source.confidence === "untested" ? colour.yellow("untested") : colour.green("proven  ");
    const config = source.configured ? "" : colour.dim(` · needs ${source.needs}`);
    console.log(`  ${tag} ${source.id.padEnd(10)} ${source.coverage}${config}`);
  }

  const campaignId = process.argv[2];
  let icp: Icp;
  let label: string;

  if (campaignId) {
    await requireDatabase();
    const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new Error(`No campaign ${campaignId}.`);
    const stored = fromJson<Icp | null>(campaign.icp, null);
    if (!stored) throw new Error("That campaign has no ICP stored yet.");
    icp = stored;
    label = campaign.name;
  } else {
    // A worked example: a real developer-tools ICP, so the npm and GitHub
    // sources have something genuine to answer.
    const offering: Offering = {
      companyName: "Example Observability",
      domain: "example-observability.invalid",
      oneLiner: "Tracks error budgets and burn rate for teams running Kubernetes and OpenTelemetry.",
      products: [{
        name: "Budgets",
        summary: "Service level objective tracking with burn-rate alerting.",
        capabilities: ["error budget tracking", "burn rate alerts", "kubernetes integration", "opentelemetry ingest"],
      }],
      valueProps: [],
      proofPoints: [],
      categories: ["observability", "devops tooling"],
      toneOfVoice: "direct",
      positioningPhrases: ["error budget tracking", "service level objectives"],
      sources: [],
    };
    icp = inferIcp(offering);
    label = "worked example (an observability tool)";
  }

  heading(`Discovering for ${label}`);
  console.log(colour.dim(`  Sources, in order: ${icp.preferredSources.join(" → ")}`));
  console.log(colour.dim(`  Hints: ${JSON.stringify(icp.sourceHints)}\n`));

  const result = await discoverProspects({
    icp,
    limit: Number(process.env.DISCOVER_LIMIT ?? 15),
    onProgress: (message) => console.log(colour.dim(`  ${message}`)),
  });

  heading("Per source");
  for (const entry of result.perSource) {
    const tag = entry.confidence === "untested" ? colour.yellow("untested") : colour.green("proven  ");
    console.log(`  ${tag} ${entry.label}: ${colour.bold(String(entry.found))} found`);
    for (const note of entry.notes) console.log(colour.dim(`      ${note}`));
    for (const error of entry.errors) console.log(colour.yellow(`      ! ${error}`));
  }
  for (const note of result.notes) console.log(colour.dim(`  ${note}`));

  heading(`Candidates (${result.candidates.length})`);
  for (const candidate of result.candidates) {
    console.log(`  ${colour.bold(candidate.domain.padEnd(26))} ${colour.dim(`via ${candidate.via}`)}`);
    console.log(colour.dim(`    ${candidate.reason}`));
    if (candidate.hints?.description) console.log(colour.dim(`    "${candidate.hints.description.slice(0, 90)}"`));
  }

  if (result.candidates.length === 0) {
    console.log(colour.yellow("\n  Nothing found. That is a real answer, not a crash — check the per-source notes above.\n"));
  } else {
    console.log(`\n  ${colour.dim("These are real companies, found in open data, with no paid vendor involved.")}\n`);
  }
});
