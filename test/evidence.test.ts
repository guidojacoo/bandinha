import { describe, expect, it } from "vitest";
import { assessEvidence, isUsableQuote, similar } from "../src/core/evidence";
import { lead } from "./factories";

/**
 * The evidence gate is the product's main claim, so these tests are written
 * adversarially: every case is something a crawler actually hands you and
 * that a naive implementation would happily quote back to a stranger.
 */
describe("isUsableQuote", () => {
  it("accepts a specific sentence about the company", () => {
    expect(isUsableQuote("Our on-call engineers are paged more than forty times a week.")).toBe(true);
  });

  it("rejects quotes that are too short to carry information", () => {
    expect(isUsableQuote("We use Kubernetes.")).toBe(false);
  });

  it("rejects quotes long enough to be a whole page", () => {
    expect(isUsableQuote(`We are a company that ${"does things ".repeat(40)}`)).toBe(false);
  });

  it.each([
    ["cookie banners", "This website uses cookies policy to ensure you get the best experience on our site."],
    ["footers", "Copyright 2026 Fableworks GmbH. All rights reserved. Registered in Berlin, Germany."],
    ["privacy links", "Please read our privacy policy carefully before you use any part of this website."],
    ["JS warnings", "You have JavaScript disabled, please enable javascript to continue using this site."],
    ["social prompts", "Follow us on social media to hear about everything we are doing this year."],
  ])("rejects %s", (_label, text) => {
    expect(isUsableQuote(text)).toBe(false);
  });

  it("rejects navigation menus flattened into a line", () => {
    expect(isUsableQuote("Home About Us Our Team Blog FAQ Help Log In Sign Up Buy Now Get A Demo")).toBe(false);
  });

  it("rejects a noun pile with no verb, because it is a heading", () => {
    expect(isUsableQuote("Enterprise grade logistics orchestration platform for modern freight")).toBe(false);
  });
});

describe("assessEvidence", () => {
  it("passes a lead with one quotable observation", () => {
    const verdict = assessEvidence(lead());
    expect(verdict.ok).toBe(true);
    expect(verdict.usable).toHaveLength(1);
  });

  it("blocks a lead whose only evidence is boilerplate", () => {
    const verdict = assessEvidence(lead({
      evidence: [{
        signal: "uptime",
        quote: "This website uses cookies policy to ensure you get the best experience.",
        source: "https://fableworks.test/",
      }],
    }));
    expect(verdict.ok).toBe(false);
    expect(verdict.usable).toEqual([]);
  });

  it("blocks a lead with no evidence at all", () => {
    expect(assessEvidence(lead({ evidence: [] })).ok).toBe(false);
  });

  it("lets the operator opt into generic outreach, and says so", () => {
    const verdict = assessEvidence(lead({ evidence: [] }), { requireEvidence: false });
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toMatch(/gate is disabled/);
  });

  it("de-duplicates the same sentence found on two pages", () => {
    const quote = "Our on-call engineers are paged more than forty times a week and most alerts are noise.";
    const verdict = assessEvidence(lead({
      evidence: [
        { signal: "on-call", quote, source: "https://fableworks.test/engineering" },
        { signal: "on-call", quote: `${quote} `, source: "https://fableworks.test/blog/alerts" },
      ],
    }));
    expect(verdict.usable).toHaveLength(1);
  });

  it("prefers the longer, more specific quote", () => {
    const verdict = assessEvidence(lead({
      evidence: [
        { signal: "uptime", quote: "We have had three incidents that affected customer uptime.", source: "a" },
        { signal: "on-call", quote: "Our on-call rotation has four engineers and we are paged forty times a week by alerts that do not matter.", source: "b" },
      ],
    }));
    expect(verdict.usable[0]?.signal).toBe("on-call");
  });
});

describe("similar", () => {
  it("treats re-punctuated sentences as the same", () => {
    expect(similar("We are paged forty times a week.", "we are paged forty times a week")).toBe(true);
  });

  it("keeps different sentences apart", () => {
    expect(similar("Our on-call rotation is painful", "We are hiring three backend engineers")).toBe(false);
  });
});

describe("looksLikeNavigation, via isUsableQuote", () => {
  it("accepts ordinary prose that happens to be full of short words", () => {
    // This exact sentence was rejected as a navigation menu — 55% of its
    // words are three characters or shorter, and it is perfect evidence.
    expect(isUsableQuote("We get woken up by alerts from the one service we host ourselves and it is genuinely annoying.")).toBe(true);
  });

  it("still rejects a capitalised menu with no connective words", () => {
    expect(isUsableQuote("Platform Pricing Customers Resources Company Careers Login Start Free")).toBe(false);
  });

  it("rejects a pipe-separated breadcrumb", () => {
    expect(isUsableQuote("Engineering | Observability | Reliability | Incident Response and Alerting")).toBe(false);
  });
});
