import { createServer, type Server } from "node:http";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { db } from "../infra/db";
import { startCampaign } from "../agent/campaigns";
import { runWorker, workersAlive } from "../agent/worker";
import { queueStats } from "../infra/queue";
import { fromJson } from "../lib/json";
import { colour, heading, llmForRun, requireDatabase, run } from "./lib";
import type { Icp, Offering } from "../core/types";

/**
 * `npm run acceptance` — does the finished product actually work?
 *
 * Not a unit test and not the demo. The demo proves the *agent*: evidence,
 * copy, compliance, billing, replies. This proves the *product*: that a
 * person who installs it, starts it and pastes a URL gets a working campaign
 * and a console that renders — which is a different claim, made of different
 * parts, and the one that is easiest to break without any test noticing.
 *
 * It needs the console running, because the thing being checked is partly
 * the console. `npm start` provides it.
 *
 * Everything it creates is cleaned up, and nothing is ever sent: the campaign
 * it makes is a dry run like every other, and it is deleted at the end.
 */

const BASE = (process.env.ACCEPTANCE_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const EMAIL = "acceptance@mercurio.test";
const COOKIE = "mercurio_session";

interface Check {
  label: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];
function check(label: string, pass: boolean, detail: string): boolean {
  checks.push({ label, pass, detail });
  console.log(
    pass
      ? `  ${colour.green("✓")} ${label.padEnd(48)} ${colour.dim(detail.slice(0, 64))}`
      : `  ${colour.red("✗")} ${label.padEnd(48)} ${detail.slice(0, 64)}`,
  );
  return pass;
}

/**
 * A session cookie, signed the way the console signs them.
 *
 * Not a back door: it is the same secret and the same claim set the login
 * form produces, and without it this would have to drive a browser — which
 * would mean a three-hundred-megabyte dev dependency for a project whose
 * whole argument is that it has no moving parts.
 */
async function sessionCookie(userId: string): Promise<string> {
  const value = process.env.AUTH_SECRET ?? "";
  if (value.length < 24) throw new Error("AUTH_SECRET is unset or too short; run npm run setup.");
  const token = await new SignJWT({ email: EMAIL })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(value));
  return `${COOKIE}=${token}`;
}

async function get(path: string, cookie: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { cookie, "user-agent": "mercurio-acceptance" },
    redirect: "manual",
  });
  return { status: response.status, body: await response.text() };
}

run(async () => {
  await requireDatabase();

  heading("Mercurio acceptance");
  console.log(`Checking the product the way somebody using it would: ${colour.bold(BASE)}\n`);

  // --- 0. is it even up? ---------------------------------------------------
  interface Health { status?: string; workers?: number; reasons?: string[] }
  let health: Health | null = null;
  try {
    const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8_000) });
    health = (await response.json()) as Health;
  } catch {
    console.log(colour.red(`  The console is not answering at ${BASE}.\n`));
    console.log(`  Start it with ${colour.bold("npm start")} and run this again.`);
    console.log(colour.dim(`  Or point this at a different address: ACCEPTANCE_BASE_URL=https://… npm run acceptance\n`));
    process.exitCode = 1;
    return;
  }

  check("the console answers, and says what it thinks", health?.status !== undefined, `status ${health?.status}`);

  // --- 1. an operator, and a campaign the way the console makes one --------
  const user = await db.user.upsert({
    where: { email: EMAIL },
    create: { email: EMAIL, name: "Acceptance", passwordHash: await bcrypt.hash(`x${Date.now()}`, 4) },
    update: {},
  });
  const cookie = await sessionCookie(user.id);

  // A site to read.
  //
  // Served by this process, on loopback, for two reasons. Crawling a
  // stranger's website to check your own install works is rude, and the
  // obvious local alternative — the console itself — is rejected by the
  // crawler, because `localhost` has no dot in it and is therefore not a
  // hostname. This run found that out the first time it was tried.
  //
  // `ACCEPTANCE_TARGET` points it at something real when you want that.
  const site = await serveSite();
  const target = process.env.ACCEPTANCE_TARGET ?? site.url;
  const campaign = await startCampaign({
    userId: user.id,
    url: target,
    sender: {
      fromName: "Acceptance Run",
      fromEmail: "acceptance@mercurio.test",
      postalAddress: "Nowhere at all, this campaign is deleted at the end",
      replyTo: "acceptance@mercurio.test",
    },
    targetLeads: 1,
  });

  check("pasting a URL creates a campaign immediately", campaign.status === "ingesting", `status ${campaign.status}`);

  const queued = await db.job.findFirst({ where: { campaignId: campaign.id } });
  check("and queues the crawl rather than doing it inline", queued?.kind === "ingest", `${queued?.kind ?? "nothing"} queued`);

  // --- 2. something has to do the work ------------------------------------
  const alive = await workersAlive();
  if (alive.alive === 0) {
    console.log(colour.yellow(`\n  No worker is running, so this run will do the work itself.`));
    console.log(colour.dim(`  In production that is the failure /api/health calls "degraded".\n`));
  }

  const report = await runWorker({
    llm: llmForRun(),
    name: "acceptance",
    concurrency: 1,
    kinds: ["ingest"],
    exitWhenIdle: true,
    seed: false,
    pollMs: 200,
    maxJobs: 1,
    onLog: (line) => console.log(colour.dim(`    ${line}`)),
  });

  const after = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
  const offering = fromJson<Offering | null>(after.offering, null);
  const icp = fromJson<Icp | null>(after.icp, null);

  check("a worker reads the site and the campaign comes up running",
    after.status === "running", `${report.done} job(s) done, status ${after.status}`);
  check("with an offer derived from pages it actually read",
    Boolean(offering && offering.sources.length > 0), offering ? `${offering.sources.length} page(s)` : "nothing");
  check("and an idea of who buys it",
    Boolean(icp && icp.buyerTitles.length > 0), icp ? icp.buyerTitles.slice(0, 2).join(", ") : "nothing");
  check("every claim in the offer points at one of those pages",
    Boolean(offering) && [...offering!.valueProps, ...offering!.proofPoints].every((c) => offering!.sources.includes(c.source)),
    `${(offering?.valueProps.length ?? 0) + (offering?.proofPoints.length ?? 0)} claim(s)`);

  const next = await db.job.findUnique({ where: { dedupeKey: `tick:${campaign.id}` } });
  check("and the first tick already scheduled", next !== null, next ? `${next.status}, ${next.runAt.toISOString()}` : "nothing");

  // --- 3. the console itself ----------------------------------------------
  const pages: Array<[string, RegExp]> = [
    ["/", /Campaigns/],
    [`/campaigns/${campaign.id}`, /Sending reputation/],
    ["/queue", /Queue/],
    ["/sources", /./],
    ["/learning", /./],
    ["/billing", /./],
    ["/suppressions", /./],
    ["/new", /New campaign/],
  ];
  for (const [path, expected] of pages) {
    const { status, body } = await get(path, cookie);
    check(`${path} renders for a signed-in operator`, status === 200 && expected.test(body), `HTTP ${status}`);
  }

  // --- 4. and it is still a locked door ------------------------------------
  const anonymous = await fetch(`${BASE}/`, { redirect: "manual" });
  check("a stranger is sent to the login page",
    anonymous.status === 307 || anonymous.status === 302 || (anonymous.headers.get("location") ?? "").includes("/login"),
    `HTTP ${anonymous.status} → ${anonymous.headers.get("location") ?? "no redirect"}`);

  const leaked = await fetch(`${BASE}/api/health`);
  const healthBody = await leaked.text();
  check("the health endpoint leaks nothing a stranger should not see",
    !healthBody.includes(campaign.id) && !healthBody.includes(EMAIL),
    `${healthBody.length} bytes`);

  // --- 5. invariants, on the real database ---------------------------------
  const live = await db.job.findMany({ where: { status: { in: ["queued", "running"] } } });
  const keys = live.map((job) => `${job.kind}:${job.campaignId}`);
  check("at most one live job per campaign, per kind",
    new Set(keys).size === keys.length, `${live.length} live job(s)`);

  const stats = await queueStats();
  check("nothing has been quietly abandoned", stats.overdue === 0,
    `${stats.queued} waiting, ${stats.running} running, ${stats.dead} dead`);

  const sent = await db.message.count({ where: { campaignId: campaign.id, status: "sent" } });
  check("this run sent nothing to anybody", sent === 0, `${sent} message(s)`);

  // --- clean up -------------------------------------------------------------
  await site.close();
  await db.campaign.delete({ where: { id: campaign.id } }).catch(() => undefined);
  await db.user.delete({ where: { id: user.id } }).catch(() => undefined);

  const failures = checks.filter((c) => !c.pass);
  console.log();
  if (failures.length === 0) {
    console.log(`  ${colour.green(`All ${checks.length} checks passed.`)}`);
    console.log(colour.dim("  Paste a URL in and you get a working campaign out.\n"));
  } else {
    console.log(`  ${colour.red(`${failures.length} of ${checks.length} checks failed.`)}\n`);
    process.exitCode = 1;
  }
});

/**
 * One small, ordinary company website, on loopback.
 *
 * Ordinary on purpose: prose a real company would publish, a problem stated
 * the way a seller states it, and a second page to follow. The heuristics
 * have to cope with that much unaided, because the no-LLM path is the claim
 * that they can, and an acceptance run that used copy written to flatter the
 * extractor would be checking nothing.
 */
async function serveSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const pages: Record<string, string> = {
    "/": `
      <h1>Kestrel — stock counts that match the shelf</h1>
      <p>Kestrel reconciles what the warehouse system thinks it has against
      what was actually picked, every night, and tells you which SKUs drifted.
      Independent retailers using it stop discovering a shortfall when a
      customer is standing in front of it.</p>
      <h2>What it does</h2>
      <ul>
        <li>Reads the day's picks and compares them to the recorded stock.</li>
        <li>Flags the lines that drifted, with the orders that caused it.</li>
        <li>Posts a correction your system can accept without a stock take.</li>
      </ul>
      <h2>Who it is for</h2>
      <p>Independent retailers and small distributors running more than two
      thousand SKUs, where a full stock take costs a trading day.</p>
      <p><a href="/pricing">Pricing</a></p>`,
    "/pricing": `
      <h1>Pricing</h1>
      <p>From £180 a month for up to five thousand SKUs. No per-seat charge.</p>
      <p><a href="/">Home</a></p>`,
  };

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const page = pages[path];
    if (!page) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>Kestrel</title></head><body>${page}</body></html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    // 127.0.0.1 rather than localhost: the crawler requires a hostname, and
    // a name with no dot in it is not one.
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
