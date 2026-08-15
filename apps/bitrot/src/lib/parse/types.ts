import type { Ecosystem } from "../registry/types";

export interface ParsedDependency {
  name: string;
  /** The range exactly as written in the manifest, e.g. "^4.17.21". */
  range?: string;
  /** Exact version, when the source is a lockfile. */
  resolvedVersion?: string;
  /** Where it was declared: "dependencies", "devDependencies", … */
  section?: string;
}

export interface ParsedManifest {
  ecosystem: Ecosystem;
  /** Human label for the detected format, e.g. "package-lock.json". */
  kind: string;
  dependencies: ParsedDependency[];
  /** Things skipped or truncated, surfaced to the user rather than hidden. */
  warnings: string[];
}

export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestParseError";
  }
}

/**
 * Upper bound on dependencies scanned in one go. A lockfile for a mid-sized
 * app resolves well over a thousand packages; scanning all of them would mean
 * a thousand registry round-trips per submission.
 */
export const MAX_DEPENDENCIES = 200;
