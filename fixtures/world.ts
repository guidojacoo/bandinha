/**
 * A small, self-contained internet.
 *
 * The sandbox this was built in has no outbound network access, so proving
 * the agent end-to-end needs somewhere real to crawl. These are served as
 * genuine HTML over genuine HTTP on genuine hostnames (via /etc/hosts), so
 * the crawler, the robots parser, the extractor and the scorer all do exactly
 * what they would do against the live web — only the DNS is local.
 *
 * The spread is deliberate: strong fits, marginal fits, a direct competitor,
 * a company with only a role inbox, and a business that is simply not a
 * prospect. A demo where everything scores 80 proves nothing.
 */

export interface FixturePage {
  path: string;
  title: string;
  description?: string;
  /** Rendered as paragraphs. */
  body: string[];
  emails?: Array<{ address: string; name?: string; title?: string }>;
}

export interface FixtureSite {
  host: string;
  /** Appears in the directory listing. */
  blurb: string;
  employees?: number;
  address?: string;
  /** Injected into the page head to drive technology fingerprinting. */
  techMarkers?: string[];
  robots?: string;
  pages: FixturePage[];
  /** Excluded from the directory (the seller itself). */
  hidden?: boolean;
}

const SELLER: FixtureSite = {
  host: "northwind.test",
  hidden: true,
  blurb: "Error budget tracking for engineering teams.",
  employees: 24,
  address: "12 Dock Road, Bristol BS1 6RR, United Kingdom",
  techMarkers: ["__NEXT_DATA__", "js.stripe.com"],
  pages: [
    {
      path: "/",
      title: "Northwind SLO — error budget tracking for microservices teams",
      description:
        "Northwind SLO tracks service level objectives across your services so the pager points at the service that is actually burning budget.",
      body: [
        "Northwind SLO tracks service level objectives across every service you run, so on-call engineers stop guessing which alert matters.",
        "Teams running dozens of microservices tell us the same thing: the pager fires constantly and almost none of it is actionable. Northwind computes an error budget per service and routes alerts by burn rate, so the only pages you get are the ones that are spending budget you cannot afford.",
        "Customers cut alert noise by two thirds in the first month.",
        "Northwind is SOC 2 Type II certified and runs in your own cloud account if you need it to.",
      ],
    },
    {
      path: "/pricing",
      title: "Pricing — Northwind SLO",
      description: "Simple per-seat pricing. $99 per engineer per month, billed annually.",
      body: [
        "Northwind SLO is $99 per engineer per month, billed annually. There is no separate ingest charge and no per-host fee.",
        "Teams under ten engineers pay $49 per engineer per month.",
        "Every plan includes error budget alerts, burn rate charts and incident correlation.",
      ],
    },
    {
      path: "/customers",
      title: "Customers — Northwind SLO",
      description: "Engineering teams using Northwind SLO.",
      body: [
        "Hoverboard Logistics uses Northwind SLO across its routing platform.",
        "Meridian Pay runs Northwind SLO in production across its payments estate.",
        "Our customers report cutting alert noise by two thirds within the first month of rollout.",
      ],
    },
    {
      path: "/about",
      title: "About — Northwind SLO",
      description: "We are a team of 24 engineers in Bristol.",
      body: [
        "We are a team of 24 engineers in Bristol, United Kingdom.",
        "We write plainly, we do not oversell, and we would rather tell you Northwind is wrong for you than sell you a seat you will not use.",
      ],
      emails: [{ address: "sam@northwind.test", name: "Sam Okafor", title: "Founder" }],
    },
  ],
};

const DIRECTORY: FixtureSite = {
  host: "devopsdirectory.test",
  hidden: true,
  blurb: "A directory of engineering-led software companies.",
  pages: [
    {
      path: "/",
      title: "The Engineering Tooling Directory",
      description: "An open directory of engineering-led software companies and the stacks they run.",
      body: [
        "An open directory of engineering-led software companies, the problems they write about, and the stacks they run.",
        "Listings are free and maintained by the companies themselves.",
      ],
    },
    { path: "/members", title: "Member directory", description: "All listed companies.", body: ["Every company listed in the directory."] },
  ],
};

const PROSPECTS: FixtureSite[] = [
  {
    host: "hoverboard.test",
    blurb: "Fleet routing SaaS built on Kubernetes.",
    employees: 120,
    address: "40 Rivington Street, London EC2A 3QP, United Kingdom",
    techMarkers: ["__NEXT_DATA__", "kubernetes", "datadoghq", "postgres"],
    pages: [
      {
        path: "/",
        title: "Hoverboard Logistics — fleet routing for same-day delivery",
        description: "A SaaS platform for same-day fleet routing, built on Kubernetes microservices.",
        body: [
          "Hoverboard Logistics is a SaaS platform for same-day fleet routing, used by couriers across the United Kingdom.",
          "We are a team of 120 people, most of them engineers.",
        ],
      },
      {
        path: "/engineering",
        title: "Engineering at Hoverboard",
        description: "How we build and run the routing platform.",
        body: [
          "Our engineers run a weekly on-call rota across roughly 40 microservices deployed on Kubernetes.",
          "We hold a blameless postmortem after every incident, and we publish the write-up internally within two working days.",
          "The hardest part of running this many services is knowing which alert actually matters at three in the morning.",
        ],
      },
      {
        path: "/team",
        title: "Team — Hoverboard Logistics",
        description: "The people building Hoverboard.",
        body: ["A small leadership team, mostly engineers."],
        emails: [
          { address: "priya@hoverboard.test", name: "Priya Raman", title: "VP Engineering" },
          { address: "info@hoverboard.test" },
        ],
      },
    ],
  },
  {
    host: "meridianpay.test",
    blurb: "Payments infrastructure for marketplaces.",
    employees: 210,
    address: "8 Barrow Street, Dublin D04 Y2X2, Ireland",
    techMarkers: ["kubernetes", "terraform", "postgres", "__NEXT_DATA__"],
    pages: [
      {
        path: "/",
        title: "Meridian Pay — payments infrastructure for marketplaces",
        description: "Payments infrastructure for online marketplaces, serving fintech and commerce platforms.",
        body: [
          "Meridian Pay provides payments infrastructure for online marketplaces across fintech and commerce.",
          "Our platform processes settlement for over four hundred marketplaces.",
        ],
      },
      {
        path: "/engineering",
        title: "Engineering — Meridian Pay",
        description: "Running payments reliably.",
        body: [
          "We operate a 24/7 on-call rota across our payments microservices, with Terraform-managed infrastructure on Kubernetes.",
          "Every incident gets a postmortem. Our reliability team has been working on reducing alert fatigue for two quarters.",
          "When settlement is late, it is a regulatory problem, not just an engineering one.",
        ],
      },
      {
        path: "/contact",
        title: "Contact Meridian Pay",
        description: "Get in touch.",
        body: ["Talk to our team."],
        emails: [
          { address: "dmitri@meridianpay.test", name: "Dmitri Volkov", title: "CTO" },
          { address: "security@meridianpay.test" },
        ],
      },
    ],
  },
  {
    host: "lumen-grid.test",
    blurb: "Grid analytics for renewable operators.",
    employees: 65,
    address: "Kungsgatan 12, 111 35 Stockholm, Sweden",
    techMarkers: ["kubernetes", "postgres"],
    pages: [
      {
        path: "/",
        title: "Lumen Grid — analytics for renewable energy operators",
        description: "Grid analytics software for renewable energy operators.",
        body: [
          "Lumen Grid builds analytics software for renewable energy operators managing distributed assets.",
          "We are a team of 65 across Stockholm and Berlin.",
        ],
      },
      {
        path: "/platform",
        title: "Platform — Lumen Grid",
        description: "How the platform runs.",
        body: [
          "The platform runs as a set of microservices on Kubernetes, with an on-call rota shared across the platform team.",
          "Reliability matters because operators make dispatch decisions on our numbers.",
        ],
        emails: [{ address: "anja@lumen-grid.test", name: "Anja Lindqvist", title: "Head of Platform" }],
      },
    ],
  },
  {
    host: "northgate-health.test",
    blurb: "Clinical workflow software for private healthcare.",
    employees: 140,
    address: "2 Pembroke Place, Manchester M15 6AY, United Kingdom",
    techMarkers: ["kubernetes", "postgres", "datadoghq"],
    pages: [
      {
        path: "/",
        title: "Northgate Health — clinical workflow software",
        description: "SaaS clinical workflow software for private healthcare providers.",
        body: [
          "Northgate Health builds SaaS clinical workflow software for private healthcare providers.",
          "Our systems are used in over ninety clinics.",
        ],
      },
      {
        path: "/engineering",
        title: "Engineering — Northgate Health",
        description: "Building reliable clinical software.",
        body: [
          "We run an on-call rota covering our microservices estate, and every incident gets a postmortem within a week.",
          "Downtime in a clinical setting is not an abstraction, so we invest heavily in observability.",
        ],
        emails: [{ address: "tom.kearney@northgate-health.test", name: "Tom Kearney", title: "Engineering Manager" }],
      },
    ],
  },
  {
    host: "atlasfreight.test",
    blurb: "Freight forwarding and customs brokerage.",
    employees: 320,
    address: "Hafenstrasse 4, 20459 Hamburg, Germany",
    pages: [
      {
        path: "/",
        title: "Atlas Freight — freight forwarding and customs",
        description: "Freight forwarding and customs brokerage across Europe.",
        body: [
          "Atlas Freight handles freight forwarding and customs brokerage for importers across Europe.",
          "We employ 320 people across six offices.",
          "Our internal systems team maintains the booking portal and keeps an on-call rota for it.",
        ],
      },
      {
        path: "/contact",
        title: "Contact Atlas Freight",
        description: "Our offices.",
        body: ["Reach our team in Hamburg."],
        emails: [{ address: "info@atlasfreight.test" }],
      },
    ],
  },
  {
    host: "sloscope.test",
    blurb: "SLO and error budget tracking.",
    employees: 30,
    address: "500 Howard Street, San Francisco CA 94105, United States",
    techMarkers: ["__NEXT_DATA__", "kubernetes"],
    pages: [
      {
        path: "/",
        title: "SLOScope — error budget tracking platform",
        description: "SLOScope is an error budget tracking platform for microservices teams running an on-call rota.",
        body: [
          "SLOScope is an error budget tracking platform for microservices teams. We help on-call engineers see burn rate at a glance.",
          "Track service level objectives across Kubernetes services and cut alert noise.",
        ],
        emails: [{ address: "hello@sloscope.test" }],
      },
    ],
  },
  {
    host: "tinybakery.test",
    blurb: "A family bakery in Leeds.",
    employees: 6,
    address: "14 Kirkgate, Leeds LS1 6BY, United Kingdom",
    techMarkers: ["wp-content"],
    pages: [
      {
        path: "/",
        title: "Tiny Bakery — sourdough and pastries in Leeds",
        description: "A family bakery in Leeds making sourdough, pastries and celebration cakes.",
        body: [
          "Tiny Bakery is a family bakery in Leeds making sourdough, pastries and celebration cakes.",
          "We have been on Kirkgate since 2011. Six of us work here.",
        ],
        emails: [{ address: "hello@tinybakery.test" }],
      },
    ],
  },
  {
    host: "quietleaf.test",
    blurb: "A design and research consultancy.",
    employees: 12,
    robots: "User-agent: *\nDisallow: /clients\nAllow: /\n",
    pages: [
      {
        path: "/",
        title: "Quietleaf — design and research consultancy",
        description: "A small design and research consultancy working with public sector teams.",
        body: [
          "Quietleaf is a design and research consultancy working with public sector and charity teams.",
          "We are twelve people, working remotely.",
        ],
      },
      {
        // Disallowed by robots.txt above — the crawler must skip this.
        path: "/clients",
        title: "Clients — Quietleaf",
        description: "Who we work with.",
        body: ["Our client list is commercially confidential."],
        emails: [{ address: "studio@quietleaf.test" }],
      },
    ],
  },
];

export const SITES: FixtureSite[] = [SELLER, DIRECTORY, ...PROSPECTS];

export const SELLER_HOST = SELLER.host;
export const DIRECTORY_HOST = DIRECTORY.host;
export const PROSPECT_HOSTS = PROSPECTS.map((s) => s.host);
export const ALL_HOSTS = SITES.map((s) => s.host);

export function siteByHost(host: string): FixtureSite | undefined {
  const bare = host.toLowerCase().split(":")[0]!.replace(/^www\./, "");
  return SITES.find((s) => s.host === bare);
}
