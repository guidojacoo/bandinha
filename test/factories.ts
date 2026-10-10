import type {
  ComplianceConfig, Icp, LeadProfile, Offering, SenderIdentity, SourcedClaim,
} from "../src/core/types";

export function claim(text: string, source = "https://seller.test/features"): SourcedClaim {
  return { text, source };
}

export const sender: SenderIdentity = {
  fromName: "Dana Reyes",
  fromEmail: "dana@seller.test",
  postalAddress: "Seller Inc, 12 Rue Example, 75001 Paris, France",
  unsubscribeUrl: "https://seller.test/unsubscribe?t=abc",
  replyTo: "dana@seller.test",
};

export function offering(overrides: Partial<Offering> = {}): Offering {
  return {
    companyName: "Northwind",
    domain: "seller.test",
    oneLiner: "Northwind tracks error budgets for microservices teams running Kubernetes.",
    products: [{
      name: "Northwind SLO",
      summary: "Service level objective tracking that alerts before the budget burns.",
      capabilities: ["error budget tracking", "burn rate alerts", "kubernetes integration"],
      priceLabel: "from $90/month",
    }],
    valueProps: [
      claim("Stop paging engineers for alerts that do not matter."),
      claim("Replace manual spreadsheet reporting of uptime."),
    ],
    proofPoints: [claim("SOC 2 Type II certified since 2024.", "https://seller.test/security")],
    pricingModel: "per service, monthly",
    categories: ["observability", "devops tooling"],
    toneOfVoice: "direct, technical, no hype",
    positioningPhrases: ["service level objectives", "error budget tracking"],
    sources: ["https://seller.test/", "https://seller.test/features", "https://seller.test/security"],
    ...overrides,
  };
}

export function icp(overrides: Partial<Icp> = {}): Icp {
  return {
    industries: ["observability", "devops tooling", "saas"],
    sizeMin: 50,
    sizeMax: 500,
    buyerTitles: ["VP Engineering", "Head of Engineering", "SRE Lead"],
    painSignals: ["on-call", "pager fatigue", "incident response", "uptime"],
    positiveSignals: ["kubernetes", "microservices", "prometheus"],
    negativeSignals: ["error budget tracking", "service level objectives"],
    geographies: ["united states", "germany"],
    summary: "Engineering orgs of 50-500 running microservices with on-call pain.",
    preferredSources: ["github", "seed"],
    sourceHints: { github: ["kubernetes", "observability"], seed: [] },
    ...overrides,
  };
}

export function lead(overrides: Partial<LeadProfile> = {}): LeadProfile {
  return {
    companyName: "Fableworks",
    domain: "fableworks.test",
    description: "Fableworks runs a SaaS platform for logistics operators.",
    industry: "saas",
    employeeEstimate: 180,
    location: "Berlin, Germany",
    technologies: ["kubernetes", "prometheus"],
    evidence: [{
      signal: "on-call",
      quote: "Our on-call engineers are paged more than forty times a week and most alerts are noise.",
      source: "https://fableworks.test/engineering",
    }],
    publicContacts: [{
      email: "lena@fableworks.test",
      name: "Lena Hoffman",
      title: "Head of Engineering",
      source: "https://fableworks.test/team",
      kind: "individual",
    }],
    ...overrides,
  };
}

export function compliance(overrides: Partial<ComplianceConfig> = {}): ComplianceConfig {
  return {
    sender,
    dailySendCap: 40,
    perDomainDailyCap: 2,
    minHoursBetweenTouches: 48,
    timezoneOffsetMinutes: 0,
    sendWindowStartHour: 8,
    sendWindowEndHour: 17,
    sendDays: [1, 2, 3, 4, 5],
    blockedDomains: ["blocked.test"],
    ...overrides,
  };
}
