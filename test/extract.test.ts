import { describe, expect, it } from "vitest";
import {
  detectTechnologies, extractContacts, findEvidence, guessCompanyName,
  guessEmployeeCount, guessLocation, parsePage, splitSentences,
} from "../src/infra/extract";

const PAGE_URL = "https://fableworks.test/engineering";

const HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Fableworks — logistics software for freight operators</title>
  <meta name="description" content="Fableworks runs a SaaS platform for logistics operators across Europe.">
</head>
<body>
  <nav><a href="/">Home</a><a href="/about">About</a><a href="/team">Team</a><a href="https://twitter.com/x">Twitter</a></nav>
  <header><h1>Fableworks</h1></header>
  <main>
    <h2>Engineering at Fableworks</h2>
    <p>We are a team of 180 people building on Kubernetes and Prometheus across three regions.</p>
    <p>Our on-call engineers are paged more than forty times a week and most of those alerts are noise.</p>
    <p>Contact us: <a href="mailto:Lena.Hoffman@fableworks.test">Lena Hoffman</a>, Head of Engineering.</p>
    <p>General enquiries go to <a href="mailto:hello@fableworks.test">hello@fableworks.test</a>.</p>
    <p>Do not email <a href="mailto:abuse@fableworks.test">abuse@fableworks.test</a>.</p>
    <p>Placeholder: your@example.com</p>
  </main>
  <footer>
    <p>Fableworks GmbH, based in Berlin, Germany. All rights reserved.</p>
    <script>var tracking = "noreply@vendor-analytics.test";</script>
  </footer>
</body></html>`;

describe("parsePage", () => {
  const page = parsePage(HTML, PAGE_URL);

  it("reads the title, description and language", () => {
    expect(page.title).toBe("Fableworks — logistics software for freight operators");
    expect(page.description).toMatch(/SaaS platform for logistics/);
    expect(page.lang).toBe("en");
  });

  it("keeps body prose and drops scripts and chrome", () => {
    expect(page.text).toMatch(/paged more than forty times a week/);
    expect(page.text).not.toMatch(/var tracking/);
    expect(page.text).not.toMatch(/All rights reserved/);
  });

  it("harvests same-origin links from the navigation it then strips", () => {
    // The nav is the best map of which pages exist, so links are taken before
    // the chrome is removed.
    expect(page.links).toContain("https://fableworks.test/about");
    expect(page.links).toContain("https://fableworks.test/team");
  });

  it("does not follow off-site links", () => {
    expect(page.links.join(" ")).not.toMatch(/twitter/);
  });

  it("keeps headings, including one inside a header element", () => {
    expect(page.headings).toContain("Fableworks");
    expect(page.headings).toContain("Engineering at Fableworks");
  });

  it("drops fragments so the same page is not crawled twice", () => {
    const withFragments = parsePage('<a href="/about#team">x</a><a href="/about#jobs">y</a>', "https://fableworks.test/");
    expect(withFragments.links).toEqual(["https://fableworks.test/about"]);
  });

  it("survives malformed markup", () => {
    expect(() => parsePage("<html><body><p>unclosed", "https://x.test/")).not.toThrow();
  });

  it("survives an empty document", () => {
    const empty = parsePage("", "https://x.test/");
    expect(empty.text).toBe("");
    expect(empty.links).toEqual([]);
  });
});

describe("extractContacts", () => {
  const contacts = extractContacts(HTML, PAGE_URL, "fableworks.test");
  const emails = contacts.map((c) => c.email);

  it("finds a named individual from a mailto link", () => {
    const lena = contacts.find((c) => c.email === "lena.hoffman@fableworks.test");
    expect(lena?.name).toBe("Lena Hoffman");
    expect(lena?.title?.toLowerCase()).toContain("head of engineering");
    expect(lena?.kind).toBe("individual");
  });

  it("marks a shared inbox as a role address", () => {
    expect(contacts.find((c) => c.email === "hello@fableworks.test")?.kind).toBe("role");
  });

  it("never harvests an abuse address", () => {
    expect(emails).not.toContain("abuse@fableworks.test");
  });

  it("drops placeholder addresses", () => {
    expect(emails).not.toContain("your@example.com");
  });

  it("drops a third-party vendor address found in a script", () => {
    expect(emails.join(" ")).not.toMatch(/vendor-analytics/);
  });

  it("does not invent a name it cannot corroborate", () => {
    const html = '<p>Reach Sarah Connor about anything: <a href="mailto:info@x.test">info@x.test</a></p>';
    expect(extractContacts(html, PAGE_URL, "x.test")[0]?.name).toBeUndefined();
  });

  it("reads a name out of the local part", () => {
    const html = '<a href="mailto:dana.reyes@x.test">email me</a>';
    expect(extractContacts(html, PAGE_URL, "x.test")[0]?.name).toBe("Dana Reyes");
  });

  it("de-duplicates, keeping the richest reading", () => {
    const html = `
      <a href="mailto:lena@fableworks.test">here</a>
      <p>Lena Hoffman, CTO: <a href="mailto:lena@fableworks.test">lena@fableworks.test</a></p>`;
    const result = extractContacts(html, PAGE_URL, "fableworks.test");
    expect(result).toHaveLength(1);
    expect(result[0]?.title?.toLowerCase()).toBe("cto");
  });

  it("finds nothing on a page with no addresses", () => {
    expect(extractContacts("<p>no contact details here</p>", PAGE_URL, "x.test")).toEqual([]);
  });
});

describe("splitSentences", () => {
  it("splits on sentence boundaries", () => {
    expect(splitSentences("One thing. Then another! And a third?")).toHaveLength(3);
  });

  it("keeps decimals and abbreviations intact", () => {
    expect(splitSentences("We run 99.95% uptime for Acme Inc. and others.")).toEqual([
      "We run 99.95% uptime for Acme Inc. and others.",
    ]);
  });

  it("splits on line breaks", () => {
    expect(splitSentences("First line\nSecond line")).toHaveLength(2);
  });

  it("handles empty input", () => {
    expect(splitSentences("")).toEqual([]);
  });
});

describe("findEvidence", () => {
  const page = parsePage(HTML, PAGE_URL);

  it("quotes a sentence that matches an ICP signal", () => {
    const evidence = findEvidence([page], ["on-call"]);
    expect(evidence[0]?.quote).toMatch(/paged more than forty times a week/);
    expect(evidence[0]?.signal).toBe("on-call");
    expect(evidence[0]?.source).toBe(PAGE_URL);
  });

  it("returns nothing when no signal matches", () => {
    expect(findEvidence([page], ["dental implants"])).toEqual([]);
  });

  it("returns at most one quote per signal per page", () => {
    const repetitive = parsePage(
      `<p>${"We have an on-call rotation that pages our engineers constantly. ".repeat(10)}</p>`,
      PAGE_URL,
    );
    expect(findEvidence([repetitive], ["on-call"])).toHaveLength(1);
  });

  it("prefers a sentence where they describe themselves", () => {
    const mixed = parsePage(
      "<p>Many companies have an on-call rotation that is hard to staff properly these days.</p>" +
      "<p>We have an on-call rotation that nobody on the team wants to be part of any more.</p>",
      PAGE_URL,
    );
    expect(findEvidence([mixed], ["on-call"])[0]?.quote).toMatch(/^We have/);
  });

  it("never returns boilerplate as evidence", () => {
    const cookies = parsePage(
      "<p>This website uses cookies policy to ensure you get the best on-call experience.</p>",
      PAGE_URL,
    );
    expect(findEvidence([cookies], ["on-call"])).toEqual([]);
  });

  it("respects the limit", () => {
    const evidence = findEvidence([page], ["on-call", "alerts", "kubernetes", "regions", "team"], 2);
    expect(evidence.length).toBeLessThanOrEqual(2);
  });
});

describe("firmographics", () => {
  const pages = [parsePage(HTML, PAGE_URL)];

  it("detects technologies the site names", () => {
    expect(detectTechnologies(pages)).toContain("kubernetes");
    expect(detectTechnologies(pages)).toContain("prometheus");
  });

  it("reads a stated headcount", () => {
    expect(guessEmployeeCount(pages)).toBe(180);
  });

  it("returns undefined rather than guessing a headcount", () => {
    expect(guessEmployeeCount([parsePage("<p>We are a growing company.</p>", PAGE_URL)])).toBeUndefined();
  });

  it("reads a stated location", () => {
    expect(guessLocation(pages, HTML)).toMatch(/Berlin/);
  });

  it("prefers structured address markup", () => {
    const html = '<span itemprop="addressLocality">Lisbon</span><span itemprop="addressCountry">Portugal</span>';
    expect(guessLocation([], html)).toBe("Lisbon, Portugal");
  });

  it("takes the company name from the title, not the domain", () => {
    expect(guessCompanyName(pages, "fableworks.test")).toBe("Fableworks");
  });

  it("falls back to the domain when the page says nothing", () => {
    expect(guessCompanyName([parsePage("<title>Home</title>", PAGE_URL)], "www.cobble.test")).toBe("Cobble");
  });
});
