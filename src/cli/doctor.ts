import { databaseReady, db } from "../infra/db";
import { describeSources } from "../infra/sources";
import { describeMailSetup, imapConfigFromEnv, smtpConfigFromEnv } from "../infra/transport";
import { createInbox, createTransport } from "../infra/transport";
import { dnsAvailable } from "../infra/dns";
import { fetchText } from "../infra/http";
import { MODELS } from "../infra/llm";
import { colour, heading, llmForRun, run } from "./lib";

/**
 * `npm run doctor` — what works here, and what does not.
 *
 * Written because this project has an unusual number of moving parts that can
 * each be absent without breaking anything: no LLM key, no DNS resolver, no
 * SMTP, no SearXNG. Each absence changes what the agent can do, and finding
 * that out from an empty pipeline three hours later is the worst way to learn
 * it. Everything below is checked live, not inferred from configuration.
 */

run(async () => {
  heading("Mercurio doctor");

  let problems = 0;
  let warnings = 0;

  // Padding is computed on the visible width, not the string length. Labels
  // carry colour codes, and padEnd counts those, which skews every column
  // that has a styled suffix.
  const pad = (label: string, width = 22) => {
    const visible = label.replace(/\x1b\[[0-9;]*m/g, "").length;
    return label + " ".repeat(Math.max(1, width - visible));
  };
  const ok = (label: string, detail: string) => console.log(`${colour.green("✓")} ${pad(label)} ${colour.dim(detail)}`);
  const warn = (label: string, detail: string) => {
    warnings += 1;
    console.log(`${colour.yellow("!")} ${pad(label)} ${detail}`);
  };
  const bad = (label: string, detail: string) => {
    problems += 1;
    console.log(`${colour.red("✗")} ${pad(label)} ${detail}`);
  };

  // --- database ----------------------------------------------------------
  const database = await databaseReady();
  if (database.ok) {
    const [users, campaigns, leads] = await Promise.all([db.user.count(), db.campaign.count(), db.lead.count()]);
    ok("database", `${users} account(s), ${campaigns} campaign(s), ${leads} lead(s)`);
  } else {
    bad("database", `not set up — run npm run setup (${database.error})`);
  }

  // --- LLM ---------------------------------------------------------------
  const llm = llmForRun();
  if (!llm.available()) {
    warn("groq", "no GROQ_API_KEY — copy will be deterministic rather than written");
  } else {
    const probe = await llm.text({
      task: "classify",
      tier: "small",
      system: "Reply with the single word: ready",
      user: "Are you reachable?",
      maxTokens: 8,
    });
    if (probe.ok) ok("groq", `${MODELS.small} answered; ${llm.budget().tokensUsed} tokens used today`);
    else if (probe.degraded) warn("groq", `key is set but unusable right now — ${probe.reason}`);
    else bad("groq", probe.reason ?? "unknown failure");
  }

  // --- network -----------------------------------------------------------
  const web = await fetchText("https://registry.npmjs.org/-/v1/search?text=test&size=1", { timeoutMs: 10_000 });
  if (web.ok) ok("outbound http", "the npm registry answered, so open-data discovery can run");
  else bad("outbound http", `cannot reach the npm registry — ${web.error}`);

  if (await dnsAvailable()) {
    ok("dns", "MX lookups work, so the deliverability pre-flight is live");
  } else {
    warn("dns", "no resolver — addresses will be marked unchecked rather than verified");
  }

  // --- discovery sources -------------------------------------------------
  heading("Prospect sources");
  for (const source of describeSources()) {
    const label = `${source.id}${source.confidence === "untested" ? colour.dim(" (untested)") : ""}`;
    if (!source.configured) warn(label, `needs ${source.needs}`);
    else ok(label, source.coverage);
  }

  // --- mail --------------------------------------------------------------
  heading("Mail");
  // Described as it is, not as it would be if a campaign were armed —
  // `describeMailSetup(true)` reports "live sending is armed", which is a
  // confusing thing to read from a diagnostic that armed nothing.
  const mail = describeMailSetup(false);
  console.log(`  transport: ${mail.transport}`);
  console.log(`  inbox:     ${mail.inbox}`);
  console.log(colour.dim("  A campaign also has to be armed in the console before anything is sent."));

  if (smtpConfigFromEnv()) {
    const result = await createTransport({ liveSending: true }).verify();
    if (result.ok) ok("smtp", result.detail);
    else bad("smtp", result.detail);
  } else {
    warn("smtp", "not configured — every send is a dry run written to ./outbox");
  }

  if (imapConfigFromEnv()) {
    const result = await createInbox().verify();
    if (result.ok) ok("imap", result.detail);
    else bad("imap", result.detail);
  } else {
    warn("imap", "not configured — replies are read from ./inbox instead");
  }

  // --- verdict -----------------------------------------------------------
  heading("Verdict");
  if (problems === 0 && warnings === 0) {
    console.log(`${colour.green("Everything checked out.")}\n`);
    return;
  }
  if (problems === 0) {
    console.log(`${colour.yellow(`${warnings} thing(s) are missing, and the agent still runs without them.`)}`);
    console.log(colour.dim("Everything above marked ! degrades a capability rather than breaking the run.\n"));
    return;
  }
  console.log(`${colour.red(`${problems} problem(s)`)} and ${warnings} warning(s). The ✗ lines need fixing.\n`);
  process.exitCode = 1;
});
