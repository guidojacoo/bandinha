import { db } from "../infra/db";
import { ingest } from "../agent/ingest";
import { startCampaign } from "../agent/campaigns";
import { describeMailSetup } from "../infra/transport";
import { ask, colour, fatal, heading, llmForRun, requireDatabase, run } from "./lib";

/**
 * `npm run sell <url>` — the one input.
 *
 * Reads the seller's own website, works out what it sells and who buys it,
 * and creates a campaign ready for the agent to run. Nothing is contacted
 * here; this step is the part the operator should read before anything goes
 * out, which is why it prints the ICP rather than just storing it.
 */

run(async () => {
  await requireDatabase();

  const url = process.argv[2];
  if (!url) {
    fatal("Usage: npm run sell -- https://your-company.com");
  }

  const user = await db.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) fatal("No operator account yet. Run npm run setup first.");

  heading(`Reading ${url}`);
  const llm = llmForRun();
  if (!llm.available()) {
    console.log(colour.dim("No GROQ_API_KEY, so this runs on the deterministic reader.\n"));
  }

  const result = await ingest(url, llm, { onProgress: (message) => console.log(colour.dim(`  ${message}`)) });
  if ("error" in result) fatal(result.error);

  const { offering, icp, via, notes } = result;

  heading("What you sell");
  console.log(`  ${colour.bold(offering.companyName)} (${offering.domain})`);
  console.log(`  ${offering.oneLiner}`);
  if (offering.pricingModel) console.log(`  Pricing: ${offering.pricingModel}`);
  console.log(`\n  ${colour.bold("Claims outreach may make")} ${colour.dim(`(${offering.valueProps.length})`)}`);
  for (const claim of offering.valueProps.slice(0, 5)) {
    console.log(`    · ${claim.text}`);
    console.log(`      ${colour.dim(claim.source)}`);
  }
  console.log(`\n  ${colour.bold("Proof points")} ${colour.dim(`(${offering.proofPoints.length})`)}`);
  if (offering.proofPoints.length === 0) {
    console.log(colour.dim("    none found — outreach will say nothing about other customers"));
  }
  for (const claim of offering.proofPoints) {
    console.log(`    · ${claim.text}`);
    console.log(`      ${colour.dim(claim.source)}`);
  }

  heading("Who buys it");
  console.log(`  ${icp.summary}`);
  console.log(`  Size:       ${icp.sizeMin}–${icp.sizeMax} people`);
  console.log(`  Titles:     ${icp.buyerTitles.slice(0, 5).join(", ")}`);
  console.log(`  Industries: ${icp.industries.join(", ") || colour.dim("not determined — industry will not be scored")}`);
  console.log(`  Looking for: ${icp.painSignals.slice(0, 6).join(", ")}`);
  console.log(`  Avoiding:    ${icp.negativeSignals.slice(0, 5).join(", ")}`);
  console.log(`  Will search: ${colour.cyan(icp.preferredSources.join(" → "))}`);

  if (notes.length > 0) {
    console.log();
    for (const note of notes) console.log(colour.dim(`  ${note}`));
  }
  console.log(colour.dim(`\n  Derived by: offering ${via.offering}, ICP ${via.icp}.`));

  // --- the sender ---------------------------------------------------------
  heading("Who the mail comes from");
  console.log(colour.dim("Commercial email must identify a real sender at a real postal address"));
  console.log(colour.dim("(CAN-SPAM §7704(a)(5), and equivalents elsewhere). The agent refuses to"));
  console.log(colour.dim("send without one, so there is no way to skip this.\n"));

  const fromName = await ask("Your name:", process.env.SENDER_NAME ?? "");
  const fromEmail = await ask("Your email:", process.env.SENDER_EMAIL ?? "");
  const postalAddress = await ask("Postal address:", process.env.SENDER_POSTAL_ADDRESS ?? "");
  const unsubscribeUrl = await ask("Unsubscribe URL (optional):", process.env.SENDER_UNSUBSCRIBE_URL ?? "");
  const meetingLink = await ask("Booking link (optional):", process.env.MEETING_LINK ?? "");

  if (!fromName || !fromEmail || !postalAddress) {
    fatal("A name, an email address and a postal address are all required before anything can be sent.");
  }

  const targetLeads = Number(await ask("How many leads to work:", "25"));
  const minFitScore = Number(await ask("Minimum fit score (0-100):", "55"));

  // The site was read above, so this campaign starts ready to work. The
  // console's form leaves `ingested` out and a worker does the reading, which
  // is the difference between a CLI somebody is watching and a form
  // submission that has a request timeout.
  const campaign = await startCampaign({
    userId: user.id,
    url,
    sender: { fromName, fromEmail, postalAddress, unsubscribeUrl: unsubscribeUrl || undefined, replyTo: fromEmail },
    meetingLink,
    targetLeads,
    minFitScore,
    ingested: { offering, icp, via, notes: [] },
  });

  heading("Ready");
  const mail = describeMailSetup(false);
  console.log(`  Campaign ${colour.bold(campaign.id)}`);
  console.log(`  ${mail.transport}`);
  console.log(`\n  A tick is already queued for it. Something has to run it:\n`);
  console.log(`    ${colour.bold("npm start")}                        the console and a worker`);
  console.log(`    ${colour.bold("npm run worker")}                   a worker on its own`);
  console.log(`\n  ${colour.dim(`Or watch one happen: npm run agent -- ${campaign.id}`)}`);
  console.log(`  ${colour.dim("Live sending is off. Arm it in the console once you have read what it writes.")}\n`);
});
