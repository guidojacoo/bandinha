/**
 * `npm run sell -- <url>`
 *
 * The whole product in one command: point it at a website and it learns what
 * that company sells, finds companies that would buy it, writes to them,
 * reads the replies and works the pipeline — until you stop it.
 */
import "../lib/loadEnv";
import { prisma } from "../infra/db";
import { ensureOperator } from "../lib/operator";
import { tick, type TickSummary } from "../agent/orchestrator";
import { outboundFromEnv, transportStatus } from "../infra/transport";
import { llm } from "../infra/llm/client";
import { sourcesFromEnv } from "../infra/sources";
import { ingest } from "../agent/ingest";
import type { SenderIdentity } from "../core/types";
import { senderIdentityProblems } from "../core/compliance";
import { bullet, c, fail, heading, kv, ok, parseArgs, warn } from "./ui";

function senderFrom(flags: Record<string, string | true>, derived: {
  companyName: string; domain: string; postalAddress?: string; emails: string[];
}): SenderIdentity {
  const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
  return {
    fromName: str(flags["from-name"]) ?? process.env.SENDER_NAME ?? derived.companyName,
    fromEmail:
      str(flags["from-email"]) ?? process.env.SENDER_EMAIL ?? derived.emails[0] ?? `hello@${derived.domain}`,
    postalAddress:
      str(flags["postal-address"]) ?? process.env.SENDER_POSTAL_ADDRESS ?? derived.postalAddress ?? "",
    unsubscribeUrl: str(flags["unsubscribe-url"]) ?? process.env.UNSUBSCRIBE_URL,
    replyTo: str(flags["reply-to"]) ?? process.env.SENDER_REPLY_TO,
  };
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const url = positional[0];

  if (!url || flags.help) {
    console.log(`
${c.bold("rainmaker sell")} — autonomous B2B sales from one URL

  npm run sell -- <url> [options]

Options
  --ticks <n>            Stop after n orchestrator ticks (default: run until idle)
  --interval <seconds>   Seconds between ticks (default 5)
  --target <n>           How many leads to keep in flight (default 25)
  --min-fit <n>          Minimum fit score to contact (default 55)
  --from-name <name>     Sender display name          (env SENDER_NAME)
  --from-email <addr>    Sender address               (env SENDER_EMAIL)
  --postal-address <s>   Required on commercial mail  (env SENDER_POSTAL_ADDRESS)
  --unsubscribe-url <u>  One-click opt-out link       (env UNSUBSCRIBE_URL)
  --meeting-link <url>   Where interested buyers book (env MEETING_LINK)
  --host-delay <ms>      Crawl politeness delay per host

Sending is dry-run unless SEND_MODE=live and SMTP is configured.
`);
    process.exit(url ? 0 : 1);
  }

  const num = (v: string | true | undefined, d: number) =>
    typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : d;

  const operator = await ensureOperator();
  if (operator.created) ok(`Created operator account ${operator.email}`);

  const hostDelayMs = typeof flags["host-delay"] === "string" ? Number(flags["host-delay"]) : undefined;

  // --- Learn the product before creating anything, so the sender identity
  //     can be derived from the seller's own site. ---
  heading(`Reading ${url}`);
  const learned = await ingest(url, { hostDelayMs });
  ok(`Crawled ${learned.crawl.pages.length} pages from ${learned.crawl.host}`);
  kv("Company", learned.offering.companyName);
  kv("Sells", learned.offering.oneLiner);
  if (learned.offering.products.length) kv("Products", learned.offering.products.map((p) => p.name).join(", "));
  if (learned.offering.proofPoints.length) kv("Proof points", String(learned.offering.proofPoints.length));
  kv("Extraction", learned.usedLlm ? "model" : "heuristic (no API key)");
  for (const note of learned.notes) warn(note);

  heading("Ideal customer profile");
  kv("Industries", learned.icp.industries.slice(0, 5).join(", ") || "—");
  kv("Size", `${learned.icp.sizeMin}–${learned.icp.sizeMax} employees`);
  kv("Buyers", learned.icp.buyerTitles.slice(0, 4).join(", ") || "—");
  kv("Pain signals", learned.icp.painSignals.slice(0, 6).join(", ") || "—");
  if (learned.icp.negativeSignals.length) kv("Disqualifiers", learned.icp.negativeSignals.slice(0, 4).join(", "));

  const sender = senderFrom(flags, {
    companyName: learned.offering.companyName,
    domain: learned.offering.domain,
    postalAddress: learned.sellerPostalAddress,
    emails: learned.sellerEmails,
  });

  heading("Sender identity");
  kv("From", `${sender.fromName} <${sender.fromEmail}>`);
  kv("Postal address", sender.postalAddress || c.red("missing"));
  const identityProblems = senderIdentityProblems(sender);
  const transport = outboundFromEnv();
  kv("Transport", `${transport.name} ${transport.live ? c.red("(LIVE)") : c.green("(dry run)")}`);
  bullet(transportStatus());
  if (identityProblems.length > 0) {
    for (const p of identityProblems) fail(p);
    warn("Discovery and qualification will run, but no message can be sent until this is fixed.");
  }

  const model = llm();
  if (!model.enabled) warn(model.disabledReason!);

  const available = sourcesFromEnv().filter((s) => s.available());
  heading("Prospect sources");
  if (available.length === 0) {
    fail("No prospect sources configured.");
    bullet("Set SEED_DOMAINS, DIRECTORY_URLS, or a search key (BRAVE_API_KEY / SERPER_API_KEY / SEARXNG_URL).");
  } else {
    for (const s of available) ok(s.name);
  }

  const campaign = await prisma.campaign.create({
    data: {
      userId: operator.id,
      sourceUrl: url,
      name: learned.offering.companyName,
      status: "running",
      offering: learned.offering as unknown as object,
      icp: learned.icp as unknown as object,
      senderIdentity: sender as unknown as object,
      targetLeads: num(flags.target, 25),
      minFitScore: num(flags["min-fit"], 55),
      meetingLink:
        (typeof flags["meeting-link"] === "string" ? flags["meeting-link"] : undefined) ??
        process.env.MEETING_LINK,
      liveSending: transport.live,
    },
  });

  heading(`Campaign ${campaign.id}`);
  bullet(`Watch it at ${c.cyan(`http://localhost:3000/campaigns/${campaign.id}`)}`);

  // --- The autonomous loop ---
  const maxTicks = typeof flags.ticks === "string" ? Number(flags.ticks) : Infinity;
  const intervalMs = num(flags.interval, 5) * 1000;
  let idleTicks = 0;

  for (let i = 1; i <= maxTicks; i++) {
    const summary = await tick(campaign.id, { hostDelayMs });
    printTick(i, summary);

    const didSomething =
      summary.discovered + summary.qualified + summary.enrolled + summary.sent + summary.repliesHandled > 0;
    idleTicks = didSomething ? 0 : idleTicks + 1;

    // Three quiet ticks in a row means the funnel is drained or waiting on
    // cadence delays — there is nothing useful left to do right now.
    if (idleTicks >= 3) {
      heading("Idle");
      bullet("Nothing left to do this pass — leads are waiting on cadence delays or replies.");
      bullet(`Resume with: ${c.cyan(`npm run agent -- --campaign ${campaign.id} --loop`)}`);
      break;
    }
    if (i < maxTicks) await new Promise((r) => setTimeout(r, intervalMs));
  }

  await printSummary(campaign.id);
  await prisma.$disconnect();
}

function printTick(n: number, s: TickSummary): void {
  const parts = [
    s.discovered && `${s.discovered} found`,
    s.qualified && `${s.qualified} qualified`,
    s.rejected && `${s.rejected} rejected`,
    s.enrolled && `${s.enrolled} enrolled`,
    s.sent && c.green(`${s.sent} sent`),
    s.blocked && c.yellow(`${s.blocked} blocked`),
    s.repliesHandled && c.cyan(`${s.repliesHandled} replies`),
    s.stopsHonoured && `${s.stopsHonoured} opt-outs`,
  ].filter(Boolean);
  console.log(`  ${c.dim(`tick ${String(n).padStart(2)}`)}  ${parts.join("  ") || c.dim("idle")}`);
  for (const note of s.notes) console.log(`            ${c.dim(note)}`);
}

async function printSummary(campaignId: string): Promise<void> {
  const [leads, enrolled, sent, blocked, replies, deals] = await Promise.all([
    prisma.lead.count({ where: { campaignId } }),
    prisma.enrollment.count({ where: { campaignId } }),
    prisma.message.count({ where: { campaignId, direction: "outbound", status: "sent" } }),
    prisma.message.count({ where: { campaignId, direction: "outbound", status: "blocked" } }),
    prisma.message.count({ where: { campaignId, direction: "inbound" } }),
    prisma.deal.groupBy({ by: ["stage"], where: { campaignId }, _count: true }),
  ]);

  heading("Pipeline");
  kv("Companies found", leads);
  kv("Contacts enrolled", enrolled);
  kv("Messages sent", sent);
  if (blocked) kv("Blocked by compliance", c.yellow(String(blocked)));
  kv("Replies received", replies);
  for (const d of deals) kv(`  ${d.stage}`, d._count);
}

main().catch(async (err) => {
  fail(err instanceof Error ? err.message : String(err));
  await prisma.$disconnect();
  process.exit(1);
});
