import { describe, expect, it } from "vitest";
import { normaliseEntryUrl, priorityOf } from "../src/infra/crawler";
import { parseRobots, robotsAllows } from "../src/infra/http";

describe("normaliseEntryUrl", () => {
  it("accepts a bare domain", () => {
    const result = normaliseEntryUrl("fableworks.test");
    expect(result.ok && result.url).toBe("https://fableworks.test/");
    expect(result.ok && result.domain).toBe("fableworks.test");
  });

  it("strips www from the domain but keeps the URL intact", () => {
    const result = normaliseEntryUrl("https://www.fableworks.test/pricing");
    expect(result.ok && result.domain).toBe("fableworks.test");
    expect(result.ok && result.origin).toBe("https://www.fableworks.test");
  });

  it.each(["", "   ", "not a url", "localhost", "javascript:alert(1)"])("rejects %s", (input) => {
    expect(normaliseEntryUrl(input).ok).toBe(false);
  });
});

describe("priorityOf", () => {
  it("ranks the pages a salesperson would read first", () => {
    expect(priorityOf("/")).toBeGreaterThan(priorityOf("/about"));
    expect(priorityOf("/about")).toBeGreaterThan(priorityOf("/pricing"));
    expect(priorityOf("/team")).toBeGreaterThan(priorityOf("/blog/some-post"));
  });

  it("ranks careers pages highly, because job ads are candid", () => {
    expect(priorityOf("/careers")).toBeGreaterThan(priorityOf("/products"));
  });

  it.each([
    "/privacy-policy", "/terms", "/cookie-policy", "/login", "/signup",
    "/cart", "/wp-admin/edit.php", "/tag/logistics", "/feed",
    "/brochure.pdf", "/logo.png", "/app.js",
  ])("refuses to spend a slot on %s", (path) => {
    expect(priorityOf(path)).toBeLessThan(0);
  });

  it("prefers shallow unknown pages to deep ones", () => {
    expect(priorityOf("/platform-overview")).toBeGreaterThan(priorityOf("/a/b/c/d/e"));
  });

  it("honours an ICP-specific hint", () => {
    expect(priorityOf("/sre-handbook", ["sre"])).toBeGreaterThan(priorityOf("/sre-handbook"));
  });
});

describe("parseRobots", () => {
  it("applies wildcard rules", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nDisallow: /admin");
    expect(robotsAllows(rules, "/private/thing")).toBe(false);
    expect(robotsAllows(rules, "/about")).toBe(true);
  });

  it("lets a rule naming us override the wildcard", () => {
    const rules = parseRobots([
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: MercurioBot",
      "Disallow: /private",
    ].join("\n"));
    expect(robotsAllows(rules, "/about")).toBe(true);
    expect(robotsAllows(rules, "/private")).toBe(false);
  });

  it("honours an allow nested inside a disallow, longest match winning", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /docs\nAllow: /docs/public");
    expect(robotsAllows(rules, "/docs/internal")).toBe(false);
    expect(robotsAllows(rules, "/docs/public/page")).toBe(true);
  });

  it("blocks everything on Disallow: /", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /");
    expect(robotsAllows(rules, "/")).toBe(false);
    expect(robotsAllows(rules, "/anything")).toBe(false);
  });

  it("treats an empty Disallow as permission", () => {
    const rules = parseRobots("User-agent: *\nDisallow:");
    expect(robotsAllows(rules, "/anything")).toBe(true);
  });

  it("reads and clamps a crawl delay", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 5").crawlDelayMs).toBe(5_000);
    expect(parseRobots("User-agent: *\nCrawl-delay: 9999").crawlDelayMs).toBe(30_000);
    expect(parseRobots("User-agent: *\nCrawl-delay: banana").crawlDelayMs).toBe(0);
  });

  it("ignores comments and blank lines", () => {
    const rules = parseRobots("# a comment\n\nUser-agent: *  # us\nDisallow: /x # why");
    expect(robotsAllows(rules, "/x")).toBe(false);
  });

  it("ignores rules aimed at a different bot", () => {
    const rules = parseRobots("User-agent: GPTBot\nDisallow: /");
    expect(robotsAllows(rules, "/anything")).toBe(true);
  });

  it("allows everything when robots.txt is empty", () => {
    expect(robotsAllows(parseRobots(""), "/anything")).toBe(true);
  });
});
