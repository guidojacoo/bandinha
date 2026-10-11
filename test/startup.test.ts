import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { db } from "../src/infra/db";
import { NullLlm } from "../src/infra/llm";
import { startCampaign, hostOf } from "../src/agent/campaigns";
import { runWorker } from "../src/agent/worker";
import { fromJson } from "../src/lib/json";
import { sender } from "./factories";
import type { Icp, Offering } from "../src/core/types";

/**
 * Pasting a URL in and getting a working campaign out.
 *
 * The path everything else assumes and nothing was testing: the console
 * creates a campaign that has never been read, queues the crawl, and a worker
 * turns it into an offer and an ICP. Every other test either starts from a
 * campaign that already has both, or substitutes the handlers.
 *
 * So this one runs the real crawler against a real HTTP server, the real
 * ingest handler, and the real worker loop, with no model — the deterministic
 * path, which is what somebody with no Groq key gets. If this breaks, the
 * product does not work at all, however green everything else is.
 */

let server: Server;
let origin = "";
let userId = "";

/**
 * A small, plausible site.
 *
 * Written to be ordinary rather than convenient: prose a real company would
 * publish, a pricing page, and a problem stated the way a seller states it.
 * The heuristics have to cope with that much on their own, because the whole
 * no-LLM path is the claim that they can.
 */
const PAGES: Record<string, { title: string; body: string }> = {
  "/": {
    title: "Harbourline — shipping manifests without the spreadsheets",
    body: `
      <h1>Shipping manifests without the spreadsheets</h1>
      <p>Harbourline turns the paperwork behind a container booking into one
      record that customs, the carrier and your own warehouse all read from.
      Freight forwarders using it stop rekeying the same manifest four times.</p>
      <h2>What it does</h2>
      <ul>
        <li>Imports a booking confirmation and builds the manifest from it.</li>
        <li>Validates HS codes before the filing is submitted, not after.</li>
        <li>Keeps one record per shipment that every party reads from.</li>
      </ul>
      <h2>Who it is for</h2>
      <p>Freight forwarders and customs brokers handling more than two hundred
      shipments a month, where a rejected filing costs a day and a demurrage
      charge.</p>
      <p><a href="/pricing">Pricing</a> · <a href="/about">About</a></p>`,
  },
  "/pricing": {
    title: "Harbourline — pricing",
    body: `
      <h1>Pricing</h1>
      <p>From £240 a month for up to five hundred shipments. No per-seat
      charge, because the people who need to read a manifest are not the
      people who pay for the software.</p>
      <p><a href="/">Home</a></p>`,
  },
  "/about": {
    title: "Harbourline — about",
    body: `
      <h1>About Harbourline</h1>
      <p>We are eleven people in Felixstowe and Rotterdam. Between us we spent
      years filing customs entries by hand and decided the rekeying was the
      part worth deleting.</p>
      <p>Reach us at hello@harbourline.example or on +44 1394 000000.</p>
      <p><a href="/">Home</a></p>`,
  },
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    // No robots.txt: a 404 means everything is allowed, which is the common
    // case on a small company's site.
    const page = PAGES[path];
    if (!page) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>${page.title}</title></head><body>${page.body}</body></html>`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "object" && address) origin = `http://127.0.0.1:${address.port}`;

  const user = await db.user.upsert({
    where: { email: "startup-test@mercurio.test" },
    create: { email: "startup-test@mercurio.test", passwordHash: await bcrypt.hash("x".repeat(12), 4) },
    update: {},
  });
  userId = user.id;

  // The crawler's politeness delay is per host and correct in production; a
  // test that waited 1.2s per page would be a test nobody runs.
  process.env.HTTP_PER_HOST_DELAY_MS = "0";
});

afterEach(async () => {
  await db.job.deleteMany({});
  await db.workerInstance.deleteMany({});
  await db.campaign.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: userId } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("a campaign created the way the console creates one", () => {
  it("exists immediately, with the crawl queued rather than done", async () => {
    const started = await startCampaign({ userId, url: `${origin}/`, sender });

    expect(started.status).toBe("ingesting");
    // The host, until the crawl finds the real name. Better than a blank, and
    // better than a name the agent has not read anywhere.
    expect(started.name).toBe("127.0.0.1");

    const row = await db.campaign.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.offering).toBeNull();
    expect(row.icp).toBeNull();

    const job = await db.job.findFirstOrThrow({ where: { campaignId: started.id } });
    expect(job.kind).toBe("ingest");
    expect(job.status).toBe("queued");
  });

  it("is turned into an offer and an ICP by a worker, with no model at all", async () => {
    const started = await startCampaign({ userId, url: `${origin}/`, sender });

    const report = await runWorker({
      llm: new NullLlm(),
      name: "startup/worker",
      concurrency: 1,
      exitWhenIdle: true,
      seed: false,
      pollMs: 10,
      maxJobs: 1,
    });
    expect(report.done).toBe(1);

    const row = await db.campaign.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.status).toBe("running");
    expect(row.error).toBeNull();

    const offering = fromJson<Offering | null>(row.offering, null);
    const icp = fromJson<Icp | null>(row.icp, null);
    expect(offering).not.toBeNull();
    expect(icp).not.toBeNull();

    // Read off the site rather than invented.
    expect(offering!.companyName.toLowerCase()).toContain("harbourline");
    expect(row.name.toLowerCase()).toContain("harbourline");
    expect(offering!.oneLiner.length).toBeGreaterThan(10);
    expect(offering!.valueProps.length).toBeGreaterThan(0);
    expect(offering!.sources.length).toBeGreaterThan(1);

    // An ICP with no idea who buys cannot qualify anybody, so it is the one
    // part of a derived ICP worth asserting on.
    expect(icp!.buyerTitles.length).toBeGreaterThan(0);
    expect(icp!.preferredSources.length).toBeGreaterThan(0);
  });

  it("every claim in the offering points at a page that was actually read", async () => {
    // The evidence rule, at the very first step: an offering is the seller's
    // own copy, and even that is sourced.
    const started = await startCampaign({ userId, url: `${origin}/`, sender });
    await runWorker({
      llm: new NullLlm(), name: "startup/sourced", concurrency: 1,
      exitWhenIdle: true, seed: false, pollMs: 10, maxJobs: 1,
    });

    const row = await db.campaign.findUniqueOrThrow({ where: { id: started.id } });
    const offering = fromJson<Offering | null>(row.offering, null)!;
    const claims = [...offering.valueProps, ...offering.proofPoints];
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim.source).toMatch(/^http:\/\/127\.0\.0\.1:/);
      // And the page it points at is one the crawl actually read.
      expect(offering.sources).toContain(claim.source);
    }
  });

  it("schedules its first tick as soon as the crawl is done", async () => {
    // What makes it autonomous rather than a command somebody has to repeat.
    const started = await startCampaign({ userId, url: `${origin}/`, sender });
    await runWorker({
      llm: new NullLlm(), name: "startup/next", concurrency: 1,
      exitWhenIdle: true, seed: false, pollMs: 10, maxJobs: 1,
    });

    const next = await db.job.findFirstOrThrow({ where: { campaignId: started.id, status: "queued" } });
    expect(next.kind).toBe("tick");
    expect(next.dedupeKey).toBe(`tick:${started.id}`);
  });

  it("does not crawl the site twice if the ingest runs again", async () => {
    const started = await startCampaign({ userId, url: `${origin}/`, sender });
    await runWorker({
      llm: new NullLlm(), name: "startup/once", concurrency: 1,
      exitWhenIdle: true, seed: false, pollMs: 10, maxJobs: 1,
    });
    const first = await db.campaign.findUniqueOrThrow({ where: { id: started.id } });

    // A retry after a crash between the write and the complete.
    await db.job.deleteMany({ where: { campaignId: started.id } });
    const { enqueue } = await import("../src/infra/queue");
    await enqueue({ kind: "ingest", campaignId: started.id });
    await runWorker({
      llm: new NullLlm(), name: "startup/again", concurrency: 1,
      exitWhenIdle: true, seed: false, pollMs: 10, maxJobs: 1,
    });

    const second = await db.campaign.findUniqueOrThrow({ where: { id: started.id } });
    expect(second.offering).toBe(first.offering);
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it("marks the campaign failed, with the reason, when the site cannot be read", async () => {
    // The state that used to be a spinner that never resolved.
    const started = await startCampaign({ userId, url: `${origin}/nothing-here`, sender });
    await db.job.updateMany({ where: { campaignId: started.id }, data: { maxAttempts: 1 } });

    await runWorker({
      llm: new NullLlm(), name: "startup/broken", concurrency: 1,
      exitWhenIdle: true, seed: false, pollMs: 10, maxJobs: 1,
    });

    const row = await db.campaign.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();

    const job = await db.job.findFirstOrThrow({ where: { campaignId: started.id } });
    expect(job.status).toBe("dead");
    expect(job.lastError).toBeTruthy();
  });

  it("starts ready to work when the caller already read the site", async () => {
    // What `npm run sell` does: it prints the offer and asks whether it looks
    // right, which needs the answer before the campaign exists.
    const started = await startCampaign({
      userId,
      url: `${origin}/`,
      sender,
      ingested: {
        offering: {
          companyName: "Harbourline", domain: "harbourline.example",
          oneLiner: "Shipping manifests without the spreadsheets",
          products: [], valueProps: [], proofPoints: [], categories: [],
          toneOfVoice: "plain", positioningPhrases: [], sources: [`${origin}/`],
        } satisfies Offering,
        icp: { buyerTitles: ["Operations Director"], preferredSources: ["seed"] } as unknown as Icp,
      },
    });

    expect(started.status).toBe("running");
    expect(started.name).toBe("Harbourline");
    const job = await db.job.findFirstOrThrow({ where: { campaignId: started.id } });
    expect(job.kind).toBe("tick");
  });
});

describe("the defaults", () => {
  it("clamps the lead target the same way whoever asks", async () => {
    // The console capped this at five hundred and the CLI did not. That was
    // not a decision either way.
    const silly = await startCampaign({ userId, url: `${origin}/`, sender, targetLeads: 9_999, minFitScore: 500 });
    const row = await db.campaign.findUniqueOrThrow({ where: { id: silly.id } });
    expect(row.targetLeads).toBe(500);
    expect(row.minFitScore).toBe(100);
  });

  it("falls back rather than storing a NaN", async () => {
    const odd = await startCampaign({ userId, url: `${origin}/`, sender, targetLeads: Number.NaN });
    const row = await db.campaign.findUniqueOrThrow({ where: { id: odd.id } });
    expect(row.targetLeads).toBe(25);
  });

  it("never arms live sending at creation", async () => {
    // The only irreversible action in the product, and it is never a default.
    const started = await startCampaign({ userId, url: `${origin}/`, sender });
    const row = await db.campaign.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.liveSending).toBe(false);
  });

  it("reads a host out of whatever it is given", () => {
    expect(hostOf("https://www.example.com/pricing")).toBe("example.com");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
