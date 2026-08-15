import { isValidNpmName } from "../registry/npm";
import { ManifestParseError, MAX_DEPENDENCIES, type ParsedDependency, type ParsedManifest } from "./types";

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/**
 * Specifiers that do not name a package on the public registry — a workspace
 * sibling, a tarball, a git checkout. There is no registry record to score, so
 * they are skipped explicitly instead of 404-ing one by one.
 */
function isNonRegistrySpec(spec: string): boolean {
  return /^(workspace:|file:|link:|portal:|git\+|git:|https?:|github:|gitlab:|bitbucket:|ssh:)/i.test(
    spec.trim(),
  );
}

/**
 * `"my-lodash": "npm:lodash@^4"` installs lodash under a different name. The
 * thing to score is the real package, so the alias is unwrapped here.
 */
export function unwrapNpmAlias(spec: string): { name: string; range?: string } | null {
  const m = /^npm:(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/.exec(spec.trim());
  if (!m?.[1]) return null;
  return { name: m[1], range: m[2] };
}

function parseJson(text: string, what: string): Record<string, unknown> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new ManifestParseError(
      `${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ManifestParseError(`${what} must be a JSON object.`);
  }
  return doc as Record<string, unknown>;
}

/** Parses a `package.json` — direct dependencies only, ranges not resolved. */
export function parsePackageJson(text: string): ParsedManifest {
  const doc = parseJson(text, "package.json");
  const warnings: string[] = [];
  const seen = new Map<string, ParsedDependency>();

  for (const section of DEP_SECTIONS) {
    const block = doc[section];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;

    for (const [rawName, rawSpec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof rawSpec !== "string") continue;
      let name = rawName;
      let range: string | undefined = rawSpec;

      const alias = rawSpec.startsWith("npm:") ? unwrapNpmAlias(rawSpec) : null;
      if (alias) {
        name = alias.name;
        range = alias.range;
      } else if (isNonRegistrySpec(rawSpec)) {
        warnings.push(`Skipped ${rawName}: "${rawSpec}" does not resolve to a registry package.`);
        continue;
      }

      if (!isValidNpmName(name)) {
        warnings.push(`Skipped "${rawName}": not a valid npm package name.`);
        continue;
      }
      // A package listed in several sections is one package; the first section
      // encountered wins, which is the order in DEP_SECTIONS.
      if (!seen.has(name)) seen.set(name, { name, range, section });
    }
  }

  if (seen.size === 0) {
    throw new ManifestParseError(
      "No dependencies found. Does this package.json have a dependencies block?",
    );
  }

  return { ecosystem: "npm", kind: "package.json", dependencies: [...seen.values()], warnings };
}

interface LockEntry {
  version?: string;
  resolved?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
}

/**
 * Parses `package-lock.json`. Unlike package.json this gives exact installed
 * versions and, crucially, the transitive tree — which is where abandoned
 * packages actually hide.
 */
export function parsePackageLock(text: string): ParsedManifest {
  const doc = parseJson(text, "package-lock.json");
  const warnings: string[] = [];
  const seen = new Map<string, ParsedDependency>();

  const packages = doc.packages;
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    // lockfileVersion 2/3: flat map keyed by install path.
    for (const [path, rawEntry] of Object.entries(packages as Record<string, unknown>)) {
      if (path === "" || !rawEntry || typeof rawEntry !== "object") continue;
      const entry = rawEntry as LockEntry;
      if (entry.link) continue; // workspace symlink, not a registry package

      const name = path.split("node_modules/").pop();
      if (!name || !isValidNpmName(name)) continue;
      if (entry.resolved && !/^https?:\/\//.test(entry.resolved)) continue;

      const existing = seen.get(name);
      // Prefer the shallowest copy — that is the one most of the tree uses.
      if (!existing) {
        seen.set(name, {
          name,
          resolvedVersion: entry.version,
          range: entry.version,
          section: entry.dev ? "devDependencies" : "dependencies",
        });
      }
    }
  } else if (doc.dependencies && typeof doc.dependencies === "object") {
    // lockfileVersion 1: nested tree.
    const walk = (node: Record<string, unknown>, depth: number): void => {
      if (depth > 12) return;
      for (const [name, rawEntry] of Object.entries(node)) {
        if (!rawEntry || typeof rawEntry !== "object") continue;
        const entry = rawEntry as LockEntry & { dependencies?: Record<string, unknown> };
        if (isValidNpmName(name) && !seen.has(name)) {
          seen.set(name, {
            name,
            resolvedVersion: entry.version,
            range: entry.version,
            section: entry.dev ? "devDependencies" : "dependencies",
          });
        }
        if (entry.dependencies) walk(entry.dependencies, depth + 1);
      }
    };
    walk(doc.dependencies as Record<string, unknown>, 0);
  } else {
    throw new ManifestParseError("This lockfile has neither a `packages` nor a `dependencies` map.");
  }

  if (seen.size === 0) throw new ManifestParseError("No packages found in the lockfile.");

  let dependencies = [...seen.values()];
  if (dependencies.length > MAX_DEPENDENCIES) {
    warnings.push(
      `Lockfile resolves ${dependencies.length} packages; scanning the first ${MAX_DEPENDENCIES}.`,
    );
    dependencies = dependencies.slice(0, MAX_DEPENDENCIES);
  }

  return { ecosystem: "npm", kind: "package-lock.json", dependencies, warnings };
}
