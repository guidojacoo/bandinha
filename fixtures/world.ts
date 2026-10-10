/**
 * A small, self-contained web.
 *
 * Built because proving an autonomous sales agent works requires watching it
 * work end to end, and the honest ways to do that are both bad: crawl real
 * companies hard enough to be rude, or mail real people. So this is a seller,
 * nine prospects and a set of buyers who answer their mail — served over HTTP
 * on names in the reserved `.test` TLD.
 *
 * The prospects are chosen to exercise the gates, not to flatter the agent.
 * Four of the nine should be rejected, and which four is the test:
 *
 *   burnrate.test   a direct competitor — must be disqualified
 *   tinycrew.test   two people — must fail the size signal
 *   opaque.test     a real prospect with nothing quotable — must fail the
 *                   evidence gate, which is the gate most likely to be
 *                   quietly disabled because it rejects good-looking leads
 *   noreply.test    fits perfectly, publishes only abuse@, privacy@ and
 *                   noreply@ — must end with no contacts and no messages
 *
 * The five that should pass differ in how they describe the problem, so the
 * composer has to quote five different sentences rather than one template.
 */

export interface FixtureSite {
  domain: string;
  pages: Record<string, string>;
  /** What the run is expected to do with it, asserted by the demo. */
  expect: "enrol" | "reject";
  because: string;
}

const FOOTER = (name: string, address: string) => `
  <footer>
    <p>${name} — ${address}</p>
    <p><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a></p>
    <p>This site uses cookies to improve your experience.</p>
  </footer>`;

function page(options: {
  title: string;
  description?: string;
  nav?: string[];
  body: string;
  footer: string;
}): string {
  const nav = (options.nav ?? ["/", "/about", "/contact"])
    .map((href) => `<a href="${href}">${href === "/" ? "Home" : href.replace("/", "")}</a>`)
    .join(" ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${options.title}</title>
  ${options.description ? `<meta name="description" content="${options.description}">` : ""}
</head>
<body>
  <nav>${nav}</nav>
  <main>${options.body}</main>
  ${options.footer}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The seller
// ---------------------------------------------------------------------------

const NORTHWIND_FOOTER = FOOTER("Northwind Software Ltd", "4 Dock Street, Bristol BS1 4RU, United Kingdom");
const NORTHWIND_NAV = ["/", "/product", "/pricing", "/customers", "/security", "/about", "/contact"];

export const seller: FixtureSite = {
  domain: "northwind.test",
  expect: "enrol",
  because: "This is the seller; the agent reads it rather than prospecting it.",
  pages: {
    "/": page({
      title: "Northwind — error budget tracking for platform teams",
      description: "Northwind tracks error budgets so your pager only goes off when something that matters is actually breaking.",
      nav: NORTHWIND_NAV,
      body: `
        <h1>Northwind</h1>
        <h2>Error budget tracking for platform teams</h2>
        <p>Northwind watches your service level objectives and tells you when a budget is burning, so your
           on-call engineers stop being woken by alerts that nobody acts on.</p>
        <p>We help platform teams cut alert volume without turning off the alerts that matter.</p>
        <p>It replaces the spreadsheet where most teams track uptime by hand.</p>
        <p>Teams connect Prometheus or OpenTelemetry in an afternoon and see their first burn-rate alert the same day.</p>`,
      footer: NORTHWIND_FOOTER,
    }),
    "/product": page({
      title: "Product — Northwind",
      nav: NORTHWIND_NAV,
      body: `
        <h1>How Northwind works</h1>
        <h2>Error budget tracking</h2>
        <p>Define an objective once and Northwind calculates the budget, the burn rate and the time left
           before you breach it.</p>
        <h2>Burn rate alerts</h2>
        <p>Alerts fire on the rate a budget is being consumed, not on every individual error, which is what
           stops the pager going off at three in the morning for nothing.</p>
        <h2>Kubernetes integration</h2>
        <p>It reads the metrics you already export, so you avoid instrumenting anything twice.</p>`,
      footer: NORTHWIND_FOOTER,
    }),
    "/pricing": page({
      title: "Pricing — Northwind",
      nav: NORTHWIND_NAV,
      body: `
        <h1>Pricing</h1>
        <p>Northwind is $90 per month for up to twenty-five services, billed monthly, cancel whenever you like.</p>
        <p>There is a free tier for three services, which is enough to try it on something real.</p>`,
      footer: NORTHWIND_FOOTER,
    }),
    "/customers": page({
      title: "Customers — Northwind",
      nav: NORTHWIND_NAV,
      body: `
        <h1>Who uses Northwind</h1>
        <p>Northwind is used by platform teams at eleven companies running production Kubernetes.</p>
        <p>Riverbend Logistics reduced their out-of-hours pages from forty a week to six in the first month.</p>`,
      footer: NORTHWIND_FOOTER,
    }),
    "/security": page({
      title: "Security — Northwind",
      nav: NORTHWIND_NAV,
      body: `
        <h1>Security</h1>
        <p>Northwind is SOC 2 Type II certified and has been audited annually since 2024.</p>
        <p>We store metric aggregates only and never receive your logs or customer data.</p>`,
      footer: NORTHWIND_FOOTER,
    }),
    "/about": page({
      title: "About — Northwind",
      nav: NORTHWIND_NAV,
      body: `
        <h1>About Northwind</h1>
        <p>We are a team of nine in Bristol, most of us previously on-call for systems we did not choose.</p>`,
      footer: NORTHWIND_FOOTER,
    }),
    "/contact": page({
      title: "Contact — Northwind",
      nav: NORTHWIND_NAV,
      body: `
        <h1>Contact</h1>
        <p>Sales: <a href="mailto:dana@northwind.test">Dana Reyes</a>, Head of Sales.</p>`,
      footer: NORTHWIND_FOOTER,
    }),
    "/privacy": page({ title: "Privacy policy — Northwind", nav: NORTHWIND_NAV, body: "<h1>Privacy policy</h1><p>Boilerplate.</p>", footer: NORTHWIND_FOOTER }),
    "/terms": page({ title: "Terms — Northwind", nav: NORTHWIND_NAV, body: "<h1>Terms</h1><p>Boilerplate.</p>", footer: NORTHWIND_FOOTER }),
  },
};

// ---------------------------------------------------------------------------
// Prospects
// ---------------------------------------------------------------------------

interface ProspectSpec {
  domain: string;
  company: string;
  tagline: string;
  description: string;
  industry: string;
  location: string;
  headcount: string;
  /** The sentence the evidence gate should find and the composer should quote. */
  painSentence?: string;
  extraPain?: string;
  technologies: string;
  contacts: Array<{ email: string; name?: string; title?: string }>;
  expect: FixtureSite["expect"];
  because: string;
  /** Replaces the careers page entirely, for the awkward cases. */
  careersOverride?: string;
}

function prospect(spec: ProspectSpec): FixtureSite {
  const footer = FOOTER(spec.company, spec.location);
  const nav = ["/", "/about", "/engineering", "/careers", "/contact"];

  return {
    domain: spec.domain,
    expect: spec.expect,
    because: spec.because,
    pages: {
      "/": page({
        title: `${spec.company} — ${spec.tagline}`,
        description: spec.description,
        nav,
        body: `
          <h1>${spec.company}</h1>
          <h2>${spec.tagline}</h2>
          <p>${spec.description}</p>
          <p>${spec.company} operates in ${spec.industry}. ${spec.headcount}</p>`,
        footer,
      }),
      "/about": page({
        title: `About — ${spec.company}`,
        nav,
        body: `
          <h1>About ${spec.company}</h1>
          <p>${spec.description}</p>
          <p>${spec.headcount} We are based in ${spec.location}.</p>`,
        footer,
      }),
      "/engineering": page({
        title: `Engineering — ${spec.company}`,
        nav,
        body: `
          <h1>Engineering at ${spec.company}</h1>
          <p>We run on ${spec.technologies}.</p>
          ${spec.painSentence ? `<p>${spec.painSentence}</p>` : ""}
          ${spec.extraPain ? `<p>${spec.extraPain}</p>` : ""}`,
        footer,
      }),
      "/careers": spec.careersOverride ?? page({
        title: `Careers — ${spec.company}`,
        nav,
        body: `
          <h1>Join ${spec.company}</h1>
          <h2>Site Reliability Engineer</h2>
          ${spec.painSentence ? `<p>${spec.painSentence}</p>` : "<p>We are hiring across the board.</p>"}
          <p>You would work on ${spec.technologies}.</p>`,
        footer,
      }),
      "/contact": page({
        title: `Contact — ${spec.company}`,
        nav,
        body: `
          <h1>Contact ${spec.company}</h1>
          <ul>
            ${spec.contacts
              .map((c) => `<li><a href="mailto:${c.email}">${c.name ?? c.email}</a>${c.title ? `, ${c.title}` : ""}</li>`)
              .join("\n            ")}
          </ul>`,
        footer,
      }),
      "/privacy": page({ title: `Privacy — ${spec.company}`, nav, body: "<h1>Privacy</h1><p>Boilerplate.</p>", footer }),
    },
  };
}

export const prospects: FixtureSite[] = [
  prospect({
    domain: "fableworks.test",
    company: "Fableworks",
    tagline: "logistics software for freight operators",
    description: "Fableworks runs a SaaS platform that freight operators across Europe use to plan and track shipments.",
    industry: "logistics software",
    location: "Berlin, Germany",
    headcount: "We are a team of 180 people.",
    painSentence: "Our on-call engineers are paged more than forty times a week and most of those alerts turn out to be noise nobody acts on.",
    extraPain: "We track uptime for each customer in a spreadsheet that somebody updates by hand every Monday morning.",
    technologies: "Kubernetes, Prometheus and PostgreSQL",
    contacts: [
      { email: "lena.hoffman@fableworks.test", name: "Lena Hoffman", title: "Head of Engineering" },
      { email: "hello@fableworks.test" },
    ],
    expect: "enrol",
    because: "On-target: right size, right stack, says the problem in its own words, publishes a named engineering lead.",
  }),

  prospect({
    domain: "meridianpay.test",
    company: "Meridian Pay",
    tagline: "payment infrastructure for marketplaces",
    description: "Meridian Pay provides payment routing and reconciliation for online marketplaces in twelve countries.",
    industry: "payments",
    location: "Lisbon, Portugal",
    headcount: "We are 240 employees.",
    painSentence: "We have no reliable way to tell whether a degraded payment route is bad enough to wake somebody up, so we wake somebody up every time.",
    technologies: "Kubernetes, Kafka and Go",
    contacts: [{ email: "p.almeida@meridianpay.test", name: "Paulo Almeida", title: "VP Engineering" }],
    expect: "enrol",
    because: "Describes exactly the decision Northwind automates, in different words from every other fixture.",
  }),

  prospect({
    domain: "atlasgrid.test",
    company: "Atlas Grid",
    tagline: "grid analytics for renewable operators",
    description: "Atlas Grid builds forecasting and monitoring software for wind and solar operators.",
    industry: "energy software",
    location: "Copenhagen, Denmark",
    headcount: "Atlas Grid has 95 staff.",
    painSentence: "Last quarter we breached our uptime commitment twice before anyone noticed the error rate had been climbing for days.",
    technologies: "Kubernetes, OpenTelemetry and Python",
    contacts: [
      { email: "sofie@atlasgrid.test", name: "Sofie Lund", title: "Director of Platform" },
      { email: "careers@atlasgrid.test" },
    ],
    expect: "enrol",
    because: "Should enrol the named director and never the careers address.",
  }),

  prospect({
    domain: "quaypoint.test",
    company: "Quaypoint",
    tagline: "clinical scheduling for private practices",
    description: "Quaypoint provides appointment scheduling and records software for private medical practices.",
    industry: "healthcare software",
    location: "Dublin, Ireland",
    headcount: "We are a team of 60.",
    painSentence: "Our engineers spend most of Monday working out which of last week's alerts were real incidents and which were noise.",
    technologies: "Kubernetes, Prometheus and TypeScript",
    contacts: [{ email: "eoin.murphy@quaypoint.test", name: "Eoin Murphy", title: "Engineering Manager" }],
    expect: "enrol",
    because: "A different industry with the same problem — checks that fit is driven by evidence, not sector.",
  }),

  prospect({
    domain: "harborstack.test",
    company: "Harborstack",
    tagline: "developer platform for internal tools",
    description: "Harborstack gives engineering teams a single place to build and run their internal tools.",
    industry: "developer tooling",
    location: "Rotterdam, Netherlands",
    headcount: "Harborstack is 120 people.",
    painSentence: "We have service level objectives written down but nothing that tells us when we are about to miss one.",
    technologies: "Kubernetes, Terraform and Go",
    contacts: [
      { email: "info@harborstack.test" },
      { email: "m.devries@harborstack.test", name: "Marijke de Vries", title: "Head of Platform" },
    ],
    expect: "enrol",
    because: "Publishes a shared inbox first; the ranking must still prefer the named individual.",
  }),

  // --- the four that must be rejected ------------------------------------

  prospect({
    domain: "burnrate.test",
    company: "Burnrate",
    tagline: "error budget tracking and service level objectives",
    description: "Burnrate is error budget tracking and service level objective management for platform teams.",
    industry: "observability",
    location: "Austin, United States",
    headcount: "Burnrate is 45 people.",
    painSentence: "Our customers tell us their on-call engineers are paged constantly by alerts that do not matter.",
    technologies: "Kubernetes and Prometheus",
    contacts: [{ email: "sales@burnrate.test", name: "Sam Reed", title: "Head of Sales" }],
    expect: "reject",
    because: "A direct competitor. Must be disqualified on self-description, despite scoring well on every other signal.",
  }),

  prospect({
    domain: "tinycrew.test",
    company: "Tinycrew",
    tagline: "a two-person studio",
    description: "Tinycrew is a two-person studio building small web products for clients.",
    industry: "web development",
    location: "Porto, Portugal",
    headcount: "There are 2 of us.",
    painSentence: "We get woken up by alerts from the one service we host ourselves and it is genuinely annoying.",
    technologies: "Docker and PostgreSQL",
    contacts: [{ email: "hi@tinycrew.test", name: "Ana Dias", title: "Founder" }],
    expect: "reject",
    because: "Two people cannot buy a platform tool. Must fail the size signal even though the pain is real.",
  }),

  prospect({
    domain: "opaque.test",
    company: "Opaque Systems",
    tagline: "enterprise grade data orchestration",
    description: "Opaque Systems delivers enterprise grade data orchestration at scale.",
    industry: "data infrastructure",
    location: "Zurich, Switzerland",
    headcount: "Opaque Systems has 150 employees.",
    technologies: "Kubernetes and Spark",
    contacts: [{ email: "t.weber@opaque.test", name: "Tobias Weber", title: "CTO" }],
    careersOverride: page({
      title: "Careers — Opaque Systems",
      nav: ["/", "/about", "/engineering", "/careers", "/contact"],
      body: `
        <h1>Careers</h1>
        <h2>Enterprise grade opportunities</h2>
        <p>Best in class synergy driven outcomes for world class teams.</p>`,
      footer: FOOTER("Opaque Systems", "Zurich, Switzerland"),
    }),
    expect: "reject",
    because: "Plausible on paper and says nothing quotable anywhere. Must fail the evidence gate rather than be mailed generically.",
  }),

  prospect({
    domain: "noreply.test",
    company: "Noreply Industries",
    tagline: "industrial telemetry at scale",
    description: "Noreply Industries collects and analyses telemetry from industrial equipment.",
    industry: "industrial software",
    location: "Turin, Italy",
    headcount: "We are 300 people.",
    painSentence: "Our on-call rotation is paged dozens of times a week and almost none of it is actionable.",
    technologies: "Kubernetes, Prometheus and Rust",
    contacts: [
      { email: "abuse@noreply.test" },
      { email: "privacy@noreply.test" },
      { email: "noreply@noreply.test" },
    ],
    expect: "reject",
    // Its addresses are filtered at extraction, which empties the
    // contactability signal and drops the score below the threshold. Either
    // route is correct; what must never happen is a message to abuse@.
    because: "A perfect fit that publishes only abuse, privacy and no-reply addresses. Must end up with no contacts and no messages.",
  }),
];

export const world: FixtureSite[] = [seller, ...prospects];

export function siteFor(host: string): FixtureSite | undefined {
  const domain = host.split(":")[0]?.toLowerCase().replace(/^www\./, "") ?? "";
  return world.find((site) => site.domain === domain);
}

/** Domains the demo feeds the seed source, excluding the seller. */
export function prospectDomains(): string[] {
  return prospects.map((p) => p.domain);
}
