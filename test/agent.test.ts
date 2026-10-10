import { describe, expect, it } from "vitest";
import { converse } from "../src/agent/converse";
import { bestQuote, observationFrom, overlaps, pitchSentence, templateDraft, withFooter } from "../src/agent/compose";
import { enrollmentEventFor, stageFor, isTerminalStage } from "../src/agent/deals";
import { readOffering } from "../src/agent/ingest";
import { validateDraft } from "../src/core/draft";
import { buildCorpus } from "../src/core/provenance";
import { classifyReply } from "../src/core/classify";
import { parsePage } from "../src/infra/extract";
import { parseEml } from "../src/infra/transport/outbox";
import { NullLlm } from "../src/infra/llm";
import type { DealStage } from "../src/core/types";
import { icp, lead, offering, sender } from "./factories";

const llm = new NullLlm();

describe("templateDraft", () => {
  const input = {
    offering: offering(),
    profile: lead(),
    contact: lead().publicContacts[0]!,
    step: { index: 0, delayDays: 0, intent: "first_touch" as const },
    sender,
  };

  it("produces a message that passes the validator with no LLM at all", () => {
    const message = withFooter(templateDraft(input), sender);
    const result = validateDraft(message, {
      sender,
      evidence: input.profile.evidence,
      corpus: buildCorpus(input.offering, input.profile),
      allowedNames: ["Northwind", "Fableworks", "Lena", "Dana"],
    });
    expect(result.problems).toEqual([]);
  });

  it("opens with what was found on their site", () => {
    expect(templateDraft(input).body).toMatch(/paged more than forty times/i);
  });

  it("addresses a person by first name", () => {
    expect(templateDraft(input).body).toMatch(/^Hi Lena,/);
  });

  it("addresses the company when the inbox is shared", () => {
    const shared = {
      ...input,
      contact: { email: "hello@fableworks.test", source: "x", kind: "role" as const },
    };
    expect(templateDraft(shared).body).toMatch(/^Hello Fableworks,/);
  });

  it("declares every claim it makes", () => {
    const message = templateDraft(input);
    expect(message.provenance.length).toBeGreaterThan(0);
    for (const record of message.provenance) {
      expect(record.source).toMatch(/^https?:|^offering:/);
      // The model never gets to mark its own claims verified.
      expect(record.verified).toBe(false);
    }
  });

  it("says it will stop, and stops pitching, on the breakup step", () => {
    const breakup = { ...input, step: { index: 3, delayDays: 6, intent: "breakup" as const } };
    const body = templateDraft(breakup).body;
    expect(body).toMatch(/will stop/i);
    expect(body).not.toMatch(/fifteen minutes/i);
  });

  it("offers the booking link when there is one", () => {
    const withLink = { ...input, meetingLink: "https://cal.test/dana" };
    expect(templateDraft(withLink).body).toContain("https://cal.test/dana");
  });
});

describe("pitchSentence", () => {
  it("does not repeat a company name the one-liner already starts with", () => {
    // "Northwind SLO Northwind SLO tracks error budgets…" shipped once.
    const { text } = pitchSentence(offering());
    expect(text).toBe("Northwind tracks error budgets for microservices teams running Kubernetes.");
  });

  it("prefixes the name when the one-liner does not carry it", () => {
    const { text } = pitchSentence(offering({ oneLiner: "Tracks error budgets for platform teams" }));
    expect(text).toBe("Northwind: Tracks error budgets for platform teams.");
  });

  it("always cites a source", () => {
    expect(pitchSentence(offering()).source).toMatch(/^https?:/);
  });
});

describe("observationFrom", () => {
  it("turns their words into something addressed to them", () => {
    const observation = observationFrom(lead().evidence[0]!);
    expect(observation).toMatch(/^Your on-call engineers are paged/);
  });

  it("handles a quote that does not start with we or our", () => {
    const observation = observationFrom({
      signal: "uptime",
      quote: "Three incidents last quarter affected customer uptime for several hours.",
      source: "x",
    });
    expect(observation).toMatch(/^Three incidents/);
  });

  it("trims a very long quote at a word boundary", () => {
    const observation = observationFrom({
      signal: "x",
      quote: `We ${"run a lot of services ".repeat(20)}`,
      source: "x",
    });
    expect(observation.length).toBeLessThanOrEqual(161);
    expect(observation).not.toMatch(/\s$/);
  });
});

describe("overlaps", () => {
  it("catches two drafts that open identically", () => {
    expect(overlaps("Your on-call engineers are paged constantly and it shows", "Your on-call engineers are paged forty times a week")).toBe(true);
  });

  it("allows genuinely different copy", () => {
    expect(overlaps("Your on-call rotation looks painful", "Three incidents last quarter is a lot")).toBe(false);
  });
});

describe("bestQuote", () => {
  it("prefers the longest usable quote", () => {
    const quote = bestQuote([
      { signal: "a", quote: "Short one that is still over the minimum length threshold.", source: "x" },
      { signal: "b", quote: "A considerably longer sentence that says far more about what they actually struggle with.", source: "y" },
    ]);
    expect(quote?.signal).toBe("b");
  });

  it("returns nothing when every quote is too short", () => {
    expect(bestQuote([{ signal: "a", quote: "Too short.", source: "x" }])).toBeUndefined();
  });
});

describe("readOffering", () => {
  const html = `<!doctype html><html><head>
    <title>Northwind — error budget tracking for platform teams</title>
    <meta name="description" content="Northwind tracks error budgets so your pager only goes off when it matters.">
  </head><body>
    <h1>Northwind</h1>
    <h2>Error budget tracking</h2>
    <p>We help platform teams stop paging engineers for alerts that do not matter.</p>
    <p>Northwind is SOC 2 Type II certified and has been audited every year since 2024.</p>
    <p>This site uses cookies to improve your experience.</p>
  </body></html>`;

  const crawl = {
    domain: "northwind.test",
    origin: "https://northwind.test",
    pages: [parsePage(html, "https://northwind.test/")],
    homeHtml: html,
    html: new Map([["https://northwind.test/", html]]),
    errors: [],
    failed: false,
  };

  const result = readOffering(crawl);

  it("reads the company name and one-liner from their own page", () => {
    expect(result.companyName).toBe("Northwind");
    expect(result.oneLiner).toMatch(/error budgets/i);
  });

  it("sources every value prop to a real page", () => {
    expect(result.valueProps.length).toBeGreaterThan(0);
    for (const claim of result.valueProps) {
      expect(claim.source).toBe("https://northwind.test/");
    }
  });

  it("only takes verifiable proof points", () => {
    expect(result.proofPoints.map((p) => p.text).join(" ")).toMatch(/SOC 2/);
  });

  it("never takes boilerplate as a claim", () => {
    const text = [...result.valueProps, ...result.proofPoints].map((c) => c.text).join(" ");
    expect(text).not.toMatch(/cookies/i);
  });

  it("leaves categories empty rather than guessing", () => {
    // Guessing from word frequency scraped a postal address into the ICP and
    // mistargeted the entire run.
    expect(result.categories).toEqual([]);
  });

  it("captures positioning phrases for competitor detection", () => {
    expect(result.positioningPhrases.join(" ").toLowerCase()).toMatch(/error budget tracking/);
  });
});

describe("converse", () => {
  const base = {
    offering: offering(),
    profile: lead(),
    sender,
    contactName: "Lena Hoffman",
  };

  it("suppresses immediately on an opt-out, with no model involved", async () => {
    const action = await converse({ ...base, body: "Please remove me from your list." }, llm);
    expect(action.kind).toBe("suppress");
    if (action.kind === "suppress") expect(action.reason).toBe("unsubscribed");
  });

  it("suppresses on a bounce", async () => {
    const action = await converse({ ...base, body: "550 5.1.1 user unknown — mail delivery failed" }, llm);
    expect(action.kind).toBe("suppress");
    if (action.kind === "suppress") expect(action.reason).toBe("hard_bounce");
  });

  it("treats a clear no as a stop, not an objection to overcome", async () => {
    const action = await converse({ ...base, body: "Thanks but we're not interested." }, llm);
    expect(action.kind).toBe("suppress");
  });

  it("waits out an out-of-office", async () => {
    const action = await converse({ ...base, body: "I am out of the office until 3 March." }, llm);
    expect(action.kind).toBe("wait");
  });

  it("escalates a commitment rather than closing its own deal", async () => {
    const action = await converse({ ...base, body: "Send over the contract and we'll get it signed this week." }, llm);
    expect(action.kind).toBe("escalate");
    if (action.kind === "escalate") expect(action.why).toMatch(/cannot sign|invoice|close/i);
  });

  it("escalates a pricing question rather than inventing a price", async () => {
    const action = await converse({ ...base, body: "What does pricing look like for a team of 30?" }, llm);
    expect(action.kind).toBe("escalate");
    if (action.kind === "escalate") expect(action.why).toMatch(/price|cost/i);
  });

  it("escalates a referral, because routing is not its call", async () => {
    const action = await converse({ ...base, body: "I'm not the right person — Marco in platform handles tooling." }, llm);
    expect(action.kind).toBe("escalate");
  });

  it("answers a meeting request itself", async () => {
    const action = await converse({ ...base, body: "Happy to chat — what times suit you?", meetingLink: "https://cal.test/dana" }, llm);
    expect(action.kind).toBe("reply");
    if (action.kind === "reply") {
      expect(action.message.body).toContain("https://cal.test/dana");
      expect(action.validation.problems).toEqual([]);
    }
  });

  it("answers an incumbent objection with a question, not a re-pitch", async () => {
    const action = await converse({ ...base, body: "We already use Datadog. What would you add on top of that?" }, llm);
    expect(action.kind).toBe("reply");
    if (action.kind === "reply") {
      expect(action.message.body).toMatch(/\?/);
      expect(action.validation.problems).toEqual([]);
    }
  });

  it("never quotes a price it was not given", async () => {
    const noPricing = { ...base, offering: offering({ pricingModel: undefined }) };
    const action = await converse({ ...noPricing, body: "This feels too expensive for where we are." }, llm);
    if (action.kind === "reply") {
      expect(action.message.body).not.toMatch(/[$€£]\s?\d/);
      expect(action.validation.problems).toEqual([]);
    }
  });

  it("produces a valid reply for every objection kind", async () => {
    const bodies = [
      "Too expensive for us right now.",
      "Bad timing, we're mid-migration.",
      "We already use Datadog for this.",
      "I'd need to check with my manager.",
      "Never heard of you — how would we know this works?",
      "We don't have this problem.",
    ];
    for (const body of bodies) {
      const action = await converse({ ...base, body }, llm);
      if (action.kind === "reply") expect(action.validation.problems).toEqual([]);
      else expect(["escalate", "suppress", "wait"]).toContain(action.kind);
    }
  });
});

describe("stageFor", () => {
  const analysis = (body: string) => classifyReply(body);

  it("moves to contacted after the first send", () => {
    expect(stageFor({ current: "prospect", sentCount: 1 })).toBe("contacted");
  });

  it("counts any reply as engagement", () => {
    expect(stageFor({ current: "contacted", sentCount: 1, lastReply: analysis("Interesting, tell me more.") })).toBe("engaged");
  });

  it("books a meeting", () => {
    expect(stageFor({ current: "engaged", sentCount: 2, lastReply: analysis("Can we set up a call next week?") })).toBe("meeting_booked");
  });

  it("treats a commitment as proposal, never as won", () => {
    // The agent cannot observe a signature, so it cannot claim one.
    expect(stageFor({ current: "meeting_booked", sentCount: 3, lastReply: analysis("Send over the contract, we'll sign this week.") })).toBe("proposal");
  });

  it("loses on an opt-out", () => {
    expect(stageFor({ current: "engaged", sentCount: 2, lastReply: analysis("Unsubscribe.") })).toBe("lost");
  });

  it("only ever writes won when a human or a payment says so", () => {
    expect(stageFor({ current: "proposal", sentCount: 3, humanClosed: "won" })).toBe("won");
  });

  it.each<DealStage>(["won", "lost"])("holds the terminal stage %s against any reply", (stage) => {
    for (const body of ["Interesting, tell me more.", "Can we book a call?", "Unsubscribe.", "Send the contract."]) {
      expect(stageFor({ current: stage, sentCount: 9, lastReply: analysis(body) })).toBe(stage);
    }
  });

  it("never moves a deal backwards", () => {
    expect(stageFor({ current: "meeting_booked", sentCount: 4, lastReply: analysis("Interesting, tell me more.") })).toBe("meeting_booked");
  });

  it("knows which stages are terminal", () => {
    expect(isTerminalStage("won")).toBe(true);
    expect(isTerminalStage("proposal")).toBe(false);
  });
});

describe("enrollmentEventFor", () => {
  it("maps an opt-out to an unsubscribe", () => {
    expect(enrollmentEventFor("unsubscribe")).toBe("unsubscribed");
  });

  it("ignores an auto-reply so the cadence is not disturbed", () => {
    expect(enrollmentEventFor("auto_reply")).toBeNull();
  });

  it("pauses the cadence on any other reply", () => {
    expect(enrollmentEventFor("objection")).toBe("replied");
  });
});

describe("parseEml", () => {
  const headers = [
    "Message-ID: <abc@fableworks.test>",
    "Date: Tue, 10 Mar 2026 09:00:00 GMT",
    'From: "Lena Hoffman" <lena.hoffman@fableworks.test>',
    "To: dana@northwind.test",
    "Subject: Re: on-call engineers paged",
  ].join("\r\n");

  it("reads a well-formed message", () => {
    const parsed = parseEml(`${headers}\r\n\r\nWe already use Datadog.`);
    expect(parsed?.from).toBe("lena.hoffman@fableworks.test");
    expect(parsed?.subject).toBe("Re: on-call engineers paged");
    expect(parsed?.body).toBe("We already use Datadog.");
  });

  it("does not lose the body when the blank line is missing", () => {
    // Every reply in the first fixture run came back "unclear" because the
    // sentence the prospect wrote had been parsed as a header.
    const parsed = parseEml(`${headers}\r\nWe already use Datadog. What would you add?`);
    expect(parsed?.body).toBe("We already use Datadog. What would you add?");
  });

  it("unfolds a wrapped header", () => {
    const parsed = parseEml("From: a@b.test\r\nSubject: a very long\r\n subject line\r\n\r\nbody");
    expect(parsed?.subject).toBe("a very long subject line");
  });

  it("returns null when there is no sender", () => {
    expect(parseEml("Subject: orphan\r\n\r\nbody")).toBeNull();
  });

  it("handles a message with no body", () => {
    expect(parseEml(`${headers}\r\n\r\n`)?.body).toBe("");
  });
});
