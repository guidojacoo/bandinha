export type Ecosystem = "npm" | "pypi";

export const ECOSYSTEMS: readonly Ecosystem[] = ["npm", "pypi"] as const;

export function isEcosystem(value: string): value is Ecosystem {
  return (ECOSYSTEMS as readonly string[]).includes(value);
}

/**
 * Registry metadata normalised across npm and PyPI.
 *
 * Every field here is derived from data the public registries already serve.
 * Fields that a given registry does not expose stay `undefined` rather than
 * being guessed — the scoring engine drops unknown signals from the weighting
 * instead of assuming a value (see `scoreOne` in ../rot/score.ts).
 */
export interface RegistryPackage {
  ecosystem: Ecosystem;
  /** Canonical name: as-published for npm, PEP 503 normalised for PyPI. */
  name: string;
  latestVersion: string;
  description?: string;
  license?: string;
  repositoryUrl?: string;
  homepageUrl?: string;

  /**
   * Number of accounts that can publish this package.
   *
   * npm publishes this. PyPI's JSON API does not expose the maintainer list,
   * so this stays undefined for PyPI and the bus-factor signal is skipped.
   */
  maintainerCount?: number;
  maintainers?: string[];

  /** npm: `deprecated` on the latest version. PyPI: latest release yanked. */
  deprecated: boolean;
  deprecationNote?: string;

  /** PyPI "Development Status :: ..." trove classifier, when present. */
  developmentStatus?: string;

  /** ISO timestamp of the first ever release. */
  firstPublishAt?: string;
  /** ISO timestamp of the most recent release. */
  lastPublishAt?: string;
  /** ISO timestamps of every release, ascending. Drives the cadence signal. */
  releaseDates: string[];
  /** Total number of published versions. */
  releaseCount: number;

  /** When this record was read from the registry. */
  fetchedAt: string;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly kind: "not_found" | "network" | "malformed" | "too_large",
  ) {
    super(message);
    this.name = "RegistryError";
  }
}
