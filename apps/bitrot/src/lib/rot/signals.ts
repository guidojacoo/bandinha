import type { RegistryPackage } from "../registry/types";
import type { Signal, SignalId } from "./types";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Relative importance of each signal. Only the weights of signals that could
 * actually be evaluated end up in the denominator, so a registry that does not
 * expose an input (PyPI and maintainer lists, say) neither helps nor hurts.
 *
 * `deprecated` carries weight 0 on purpose: it is an override, not evidence.
 * Scored as a weighted term it made every *un*flagged package look healthier
 * than it was — hardly any abandoned package is ever formally deprecated, so
 * a large permanent zero sat in the numerator and capped genuinely dead
 * packages in the 40s. It is applied as a score floor in `scoreOne` instead.
 */
export const WEIGHTS: Record<SignalId, number> = {
  deprecated: 0,
  staleness: 30,
  cadence: 15,
  busFactor: 12,
  drift: 12,
  license: 8,
  immaturity: 8,
  provenance: 5,
};

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function lerp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x1 === x0) return y1;
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

// ---------------------------------------------------------------------------
// Version helpers
//
// Deliberately not a full semver implementation: the only comparison the score
// needs is "how many majors behind is the installed version", and manifests
// carry plenty of non-semver strings (`workspace:*`, git URLs, PEP 440 epochs)
// that must degrade to "unknown" instead of throwing.
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Pulls the first `x.y.z` (or `x.y`, or `x`) out of a version or range string. */
export function coerceVersion(input: string | undefined): ParsedVersion | null {
  if (!input) return null;
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(input);
  if (!match) return null;
  const major = Number(match[1]);
  if (!Number.isFinite(major)) return null;
  return {
    major,
    minor: match[2] ? Number(match[2]) : 0,
    patch: match[3] ? Number(match[3]) : 0,
  };
}

// ---------------------------------------------------------------------------
// Individual signals
// ---------------------------------------------------------------------------

/**
 * Explicitly end-of-life. npm's `deprecated` field and PyPI's
 * "Development Status :: 7 - Inactive" classifier are maintainer statements of
 * intent, so they outrank every inferred signal — see the floor in `scoreOne`.
 */
export function deprecationSignal(pkg: RegistryPackage): Signal {
  const inactive = pkg.developmentStatus?.includes("7 - Inactive") ?? false;
  const value = pkg.deprecated || inactive ? 1 : 0;
  let detail = "Not marked deprecated by its maintainers.";
  if (pkg.deprecated) {
    detail = pkg.deprecationNote
      ? `Maintainers deprecated this package: "${truncate(pkg.deprecationNote, 200)}"`
      : "Maintainers marked this package deprecated.";
  } else if (inactive) {
    detail = 'Classified "Development Status :: 7 - Inactive" on PyPI.';
  }
  return { id: "deprecated", label: "Deprecated", value, weight: WEIGHTS.deprecated, detail };
}

/** Time since the most recent release. The single strongest inferred signal. */
export function stalenessSignal(pkg: RegistryPackage, now: Date): Signal {
  if (!pkg.lastPublishAt) {
    return {
      id: "staleness",
      label: "Staleness",
      value: null,
      weight: WEIGHTS.staleness,
      detail: "The registry did not report a release date.",
    };
  }
  const days = Math.max(0, daysBetween(new Date(pkg.lastPublishAt), now));
  let value: number;
  if (days <= 180) value = 0;
  else if (days <= 365) value = lerp(days, 180, 365, 0, 0.35);
  else if (days <= 730) value = lerp(days, 365, 730, 0.35, 0.7);
  else if (days <= 1460) value = lerp(days, 730, 1460, 0.7, 1);
  else value = 1;

  return {
    id: "staleness",
    label: "Staleness",
    value: clamp01(value),
    weight: WEIGHTS.staleness,
    detail: `Last release was ${formatDuration(days)} ago.`,
  };
}

/**
 * Release cadence now versus a year earlier. Catches the package that looks
 * fine on staleness — it shipped four months ago — but has gone from monthly
 * releases to one a year.
 */
export function cadenceSignal(pkg: RegistryPackage, now: Date): Signal {
  const weight = WEIGHTS.cadence;
  if (pkg.releaseDates.length === 0) {
    return {
      id: "cadence",
      label: "Release cadence",
      value: null,
      weight,
      detail: "No release history available.",
    };
  }
  const cutoffRecent = now.getTime() - 365 * DAY_MS;
  const cutoffPrior = now.getTime() - 730 * DAY_MS;

  let recent = 0;
  let prior = 0;
  for (const iso of pkg.releaseDates) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) continue;
    if (t >= cutoffRecent) recent += 1;
    else if (t >= cutoffPrior) prior += 1;
  }

  let value: number;
  let detail: string;
  if (recent === 0 && prior === 0) {
    value = 0.85;
    detail = "No releases in the last two years.";
  } else if (recent === 0) {
    value = 1;
    detail = `Releases stopped: ${prior} in the prior year, none in the last 12 months.`;
  } else if (recent >= prior) {
    value = 0;
    detail = `${recent} release${recent === 1 ? "" : "s"} in the last 12 months — cadence is steady or rising.`;
  } else {
    value = clamp01(1 - recent / prior);
    detail = `Cadence slowed: ${prior} releases the prior year, ${recent} in the last 12 months.`;
  }

  return { id: "cadence", label: "Release cadence", value, weight, detail };
}

/** How many people can ship a fix. npm exposes this; PyPI's JSON API does not. */
export function busFactorSignal(pkg: RegistryPackage): Signal {
  const weight = WEIGHTS.busFactor;
  const count = pkg.maintainerCount;
  if (count === undefined || count <= 0) {
    return {
      id: "busFactor",
      label: "Bus factor",
      value: null,
      weight,
      detail:
        pkg.ecosystem === "pypi"
          ? "PyPI does not publish the maintainer list, so this is not scored."
          : "The registry did not report maintainers.",
    };
  }
  let value: number;
  if (count === 1) value = 1;
  else if (count === 2) value = 0.45;
  else if (count === 3) value = 0.2;
  else value = 0;

  const detail =
    count === 1
      ? "A single account can publish this package — nobody else can ship a fix."
      : `${count} accounts can publish this package.`;

  return { id: "busFactor", label: "Bus factor", value, weight, detail };
}

/**
 * Distance between the version in use and the latest published one. For 0.x
 * releases the minor acts as the major, per semver's own rule that 0.y is
 * allowed to break.
 */
export function driftSignal(
  latestVersion: string | undefined,
  inUse: string | undefined,
): Signal {
  const weight = WEIGHTS.drift;
  const latest = coerceVersion(latestVersion);
  const current = coerceVersion(inUse);
  if (!latest || !current) {
    return {
      id: "drift",
      label: "Version drift",
      value: null,
      weight,
      detail: "No comparable version pinned in the manifest.",
    };
  }

  const zeroVer = latest.major === 0 && current.major === 0;
  const behind = zeroVer ? latest.minor - current.minor : latest.major - current.major;
  const unit = zeroVer ? "0.x minor" : "major";

  if (behind <= 0) {
    const identical =
      latest.major === current.major &&
      latest.minor === current.minor &&
      latest.patch === current.patch;
    return {
      id: "drift",
      label: "Version drift",
      value: identical ? 0 : 0.15,
      weight,
      detail: identical
        ? "Running the latest published version."
        : "Behind by a minor or patch release only.",
    };
  }

  let value: number;
  if (behind === 1) value = 0.5;
  else if (behind === 2) value = 0.8;
  else value = 1;

  return {
    id: "drift",
    label: "Version drift",
    value,
    weight,
    detail: `${behind} ${unit} version${behind === 1 ? "" : "s"} behind the latest release.`,
  };
}

const MISSING_LICENSES = new Set(["", "unknown", "unlicensed", "none", "proprietary", "see license"]);

/** A dependency you cannot legally identify is a dependency you cannot ship. */
export function licenseSignal(pkg: RegistryPackage): Signal {
  const raw = pkg.license?.trim() ?? "";
  const missing = MISSING_LICENSES.has(raw.toLowerCase());
  return {
    id: "license",
    label: "License clarity",
    value: missing ? 1 : 0,
    weight: WEIGHTS.license,
    detail: missing
      ? "No usable license declared in the registry metadata."
      : `Declared license: ${raw}.`,
  };
}

/**
 * Brand-new packages with almost no history. Not rot in the decay sense, but
 * the same "do not depend on this yet" conclusion — and the shape a
 * typosquat or a hallucinated package name has on first publish.
 */
export function immaturitySignal(pkg: RegistryPackage, now: Date): Signal {
  const weight = WEIGHTS.immaturity;
  if (!pkg.firstPublishAt) {
    return {
      id: "immaturity",
      label: "Maturity",
      value: null,
      weight,
      detail: "The registry did not report a first-release date.",
    };
  }
  const ageDays = Math.max(0, daysBetween(new Date(pkg.firstPublishAt), now));
  const releases = pkg.releaseCount;

  let value = 0;
  let detail = `First published ${formatDuration(ageDays)} ago across ${releases} release${releases === 1 ? "" : "s"}.`;
  if (ageDays < 90 && releases < 5) {
    value = 1;
    detail = `Only ${formatDuration(ageDays)} old with ${releases} release${releases === 1 ? "" : "s"} — almost no track record.`;
  } else if (ageDays < 90) {
    value = 0.6;
    detail = `Less than 3 months old (${releases} releases).`;
  } else if (ageDays < 180 && releases < 5) {
    value = 0.5;
    detail = `Under 6 months old with only ${releases} release${releases === 1 ? "" : "s"}.`;
  }

  return { id: "immaturity", label: "Maturity", value, weight, detail };
}

/** No public source repository means no way to audit, fork, or take over. */
export function provenanceSignal(pkg: RegistryPackage): Signal {
  const missing = !pkg.repositoryUrl;
  return {
    id: "provenance",
    label: "Source provenance",
    value: missing ? 1 : 0,
    weight: WEIGHTS.provenance,
    detail: missing
      ? "No source repository linked — the published artifact cannot be traced to code."
      : `Source: ${pkg.repositoryUrl}`,
  };
}

// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function formatDuration(days: number): string {
  const d = Math.round(days);
  if (d < 1) return "less than a day";
  if (d === 1) return "1 day";
  if (d < 60) return `${d} days`;
  const months = Math.round(d / 30.44);
  if (months < 24) return `${months} month${months === 1 ? "" : "s"}`;
  const years = (d / 365.25).toFixed(1).replace(/\.0$/, "");
  return `${years} years`;
}
