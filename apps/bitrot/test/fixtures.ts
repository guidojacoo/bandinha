import type { RegistryPackage } from "../src/lib/registry/types";

export const NOW = new Date("2026-08-15T00:00:00.000Z");

export function daysAgo(days: number, from: Date = NOW): string {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** A healthy npm package. Override just the field under test. */
export function pkg(overrides: Partial<RegistryPackage> = {}): RegistryPackage {
  const releaseDates = overrides.releaseDates ?? [
    daysAgo(700),
    daysAgo(400),
    daysAgo(200),
    daysAgo(120),
    daysAgo(30),
  ];
  return {
    ecosystem: "npm",
    name: "healthy-pkg",
    latestVersion: "3.2.1",
    license: "MIT",
    repositoryUrl: "https://github.com/acme/healthy-pkg",
    maintainerCount: 5,
    deprecated: false,
    firstPublishAt: releaseDates[0],
    lastPublishAt: releaseDates[releaseDates.length - 1],
    releaseDates,
    releaseCount: releaseDates.length,
    fetchedAt: NOW.toISOString(),
    ...overrides,
  };
}
