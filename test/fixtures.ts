import type { ComplianceConfig, Icp, LeadProfile, Offering } from "../src/core/types";

export const NOW = new Date("2026-03-04T14:00:00.000Z"); // a Wednesday, 14:00 UTC

export function offering(over: Partial<Offering> = {}): Offering {
  return {
    companyName: "Northwind Analytics",
    domain: "northwind.example",
    oneLiner: "Error budget tracking for engineering teams running microservices.",
    products: [
      {
        name: "Northwind SLO",
        summary: "Tracks service level objectives across services.",
        capabilities: ["error budget alerts", "burn rate charts", "incident correlation"],
        priceLabel: "$99/month",
      },
    ],
    valueProps: ["cut alert noise by two thirds", "see which service is burning budget"],
    proofPoints: ["Used by Hoverboard Logistics", "SOC 2 Type II certified"],
    pricingModel: "per-seat monthly",
    categories: ["observability", "devops"],
    toneOfVoice: "direct, technical, no hype",
    sources: ["https://northwind.example/", "https://northwind.example/pricing"],
    ...over,
  };
}

export function icp(over: Partial<Icp> = {}): Icp {
  return {
    industries: ["saas", "fintech"],
    sizeMin: 50,
    sizeMax: 500,
    buyerTitles: ["CTO", "VP Engineering", "Head of Platform"],
    painSignals: ["microservices", "on-call", "incident"],
    positiveSignals: ["kubernetes", "observability", "postmortem"],
    negativeSignals: ["error budget tracking platform"],
    geographies: ["united kingdom", "ireland"],
    summary: "Mid-size SaaS running microservices with an on-call rota.",
    ...over,
  };
}

export function lead(over: Partial<LeadProfile> = {}): LeadProfile {
  return {
    companyName: "Hoverboard Logistics",
    domain: "hoverboard.example",
    description: "A SaaS platform for fleet routing built on kubernetes microservices.",
    industry: "saas",
    employeeEstimate: 120,
    location: "London, United Kingdom",
    technologies: ["kubernetes", "postgres"],
    evidence: [
      {
        signal: "on-call",
        quote: "Our engineers run a weekly on-call rota across 40 microservices.",
        source: "https://hoverboard.example/engineering",
      },
    ],
    publicContacts: [
      {
        email: "priya@hoverboard.example",
        name: "Priya Raman",
        title: "VP Engineering",
        source: "https://hoverboard.example/team",
        kind: "individual",
      },
    ],
    ...over,
  };
}

export function complianceConfig(over: Partial<ComplianceConfig> = {}): ComplianceConfig {
  return {
    sender: {
      fromName: "Sam Okafor",
      fromEmail: "sam@northwind.example",
      postalAddress: "12 Dock Road, Bristol BS1 6RR, United Kingdom",
      unsubscribeUrl: "https://northwind.example/unsubscribe?t=abc",
      replyTo: "sam@northwind.example",
    },
    dailySendCap: 50,
    perDomainDailyCap: 2,
    minHoursBetweenTouches: 48,
    timezoneOffsetMinutes: 0,
    sendWindowStartHour: 9,
    sendWindowEndHour: 17,
    sendDays: [1, 2, 3, 4, 5],
    blockedDomains: ["competitor.example"],
    ...over,
  };
}
