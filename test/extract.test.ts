import { describe, expect, it } from "vitest";
import { extractEmployeeCount, extractPage, readContactContext } from "../src/infra/crawler/extract";
import { linkPriority } from "../src/infra/crawler/crawl";
import { isAllowed, parseRobots } from "../src/infra/crawler/robots";
import { normaliseUrl, registrableHost } from "../src/infra/crawler/http";

describe("readContactContext", () => {
  it("reads a name and title next to an address", () => {
    expect(readContactContext("Priya Raman, VP Engineering priya@x.test", "priya@x.test")).toEqual({
      name: "Priya Raman",
      title: "VP Engineering",
    });
  });

  it("reads a bare name", () => {
    expect(readContactContext("Dmitri Volkov dmitri@x.test", "dmitri@x.test").name).toBe("Dmitri Volkov");
  });

  it("returns nothing from a wall of unrelated text", () => {
    expect(readContactContext("x".repeat(300), "a@b.test")).toEqual({});
  });
});

describe("extractPage", () => {
  const html = `<!doctype html><html><head>
    <title>Hoverboard — fleet routing</title>
    <meta name="description" content="Fleet routing SaaS.">
    <script type="application/ld+json">{"@type":"Organization","numberOfEmployees":{"value":120},"address":"40 Rivington St, London"}</script>
    <script id="__NEXT_DATA__" type="application/json">{}</script>
    </head><body>
    <nav><a href="/ignored-nav">nav</a></nav>
    <p>Our engineers run a weekly on-call rota across 40 microservices.</p>
    <ul><li><strong>Priya Raman</strong>, VP Engineering <a href="mailto:priya@hoverboard.test">priya@hoverboard.test</a></li>
        <li><a href="mailto:careers@hoverboard.test">careers@hoverboard.test</a></li>
        <li><a href="mailto:info@hoverboard.test">info@hoverboard.test</a></li></ul>
    <a href="https://partner.example/x">partner</a>
    <a href="/pricing">Pricing</a>
    </body></html>`;

  const page = extractPage(html, "https://hoverboard.test/team");

  it("reads title, description and body text", () => {
    expect(page.title).toContain("Hoverboard");
    expect(page.description).toBe("Fleet routing SaaS.");
    expect(page.text).toContain("on-call rota");
  });

  it("prefers JSON-LD for headcount and address", () => {
    expect(page.employeeEstimate).toBe(120);
    expect(page.location).toContain("London");
  });

  it("separates internal from external links", () => {
    expect(page.internalLinks.some((l) => l.endsWith("/pricing"))).toBe(true);
    expect(page.externalLinks.some((l) => l.includes("partner.example"))).toBe(true);
  });

  it("captures a named contact with their title", () => {
    const priya = page.emails.find((e) => e.email === "priya@hoverboard.test");
    expect(priya?.name).toBe("Priya Raman");
    expect(priya?.title).toBe("VP Engineering");
    expect(priya?.kind).toBe("individual");
  });

  it("marks shared inboxes as role addresses", () => {
    expect(page.emails.find((e) => e.email === "info@hoverboard.test")?.kind).toBe("role");
  });

  it("never surfaces addresses nobody should be cold-mailed at", () => {
    expect(page.emails.some((e) => e.email.startsWith("careers@"))).toBe(false);
  });

  it("fingerprints technologies from real markers", () => {
    expect(page.technologies).toContain("next.js");
  });
});

describe("extractEmployeeCount", () => {
  it("reads genuine headcount statements", () => {
    expect(extractEmployeeCount("We are a team of 120 people.")).toBe(120);
    expect(extractEmployeeCount("320 employees across six offices")).toBe(320);
  });

  /** "Trusted by 5,000 customers" is not a headcount. */
  it("ignores customer and user counts", () => {
    expect(extractEmployeeCount("Trusted by 5,000 customers worldwide.")).toBeUndefined();
    expect(extractEmployeeCount("Over 2 million users.")).toBeUndefined();
  });
});

describe("robots.txt", () => {
  it("honours a disallow and an overriding allow", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /clients\nAllow: /clients/public\n");
    expect(isAllowed("https://x.test/clients", rules)).toBe(false);
    expect(isAllowed("https://x.test/clients/public", rules)).toBe(true);
    expect(isAllowed("https://x.test/about", rules)).toBe(true);
  });

  it("prefers a group naming our agent over the wildcard", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: rainmakerbot\nDisallow: /private\n",
      "rainmakerbot",
    );
    expect(isAllowed("https://x.test/about", rules)).toBe(true);
    expect(isAllowed("https://x.test/private", rules)).toBe(false);
  });

  it("treats an empty Disallow as full permission", () => {
    expect(isAllowed("https://x.test/anything", parseRobots("User-agent: *\nDisallow:\n"))).toBe(true);
  });

  it("reads a crawl delay", () => {
    expect(parseRobots("User-agent: *\nCrawl-delay: 3\n").crawlDelaySeconds).toBe(3);
  });
});

describe("crawl targeting", () => {
  it("ranks commercially useful pages above blog posts", () => {
    expect(linkPriority("https://x.test/pricing")).toBeGreaterThan(linkPriority("https://x.test/blog/a-post"));
    expect(linkPriority("https://x.test/about")).toBeGreaterThan(linkPriority("https://x.test/deep/nested/thing"));
  });

  it("refuses assets, legal boilerplate and paginated archives", () => {
    for (const u of ["https://x.test/a.pdf", "https://x.test/privacy", "https://x.test/tag/5", "https://x.test/logo.png"]) {
      expect(linkPriority(u), u).toBe(-1);
    }
  });
});

describe("url handling", () => {
  it("strips tracking parameters and trailing slashes", () => {
    expect(normaliseUrl("https://x.test/a/?utm_source=z&id=1")).toBe("https://x.test/a?id=1");
  });

  /** Port must not be part of a company's identity. */
  it("ignores port and www when identifying a site", () => {
    expect(registrableHost("http://www.x.test:4000/a")).toBe("x.test");
    expect(registrableHost("https://x.test/a")).toBe("x.test");
  });

  it("rejects non-http schemes", () => {
    expect(normaliseUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseUrl("ftp://x.test")).toBeNull();
  });
});
