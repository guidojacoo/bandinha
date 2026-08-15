import { isValidPypiName, normalisePypiName } from "../registry/pypi";
import { ManifestParseError, MAX_DEPENDENCIES, type ParsedDependency, type ParsedManifest } from "./types";

/** Comparison operators PEP 508 allows in a requirement specifier. */
const SPECIFIER = /^([A-Za-z0-9._-]+)\s*(\[[^\]]*\])?\s*(.*)$/;

/**
 * Pulls the exact version out of a specifier when the requirement pins one.
 * `==1.2.3` pins; `>=1.2` does not, and is left unresolved so version drift is
 * reported as unknown rather than guessed from a lower bound.
 */
export function exactVersionFrom(specifier: string): string | undefined {
  const trimmed = specifier.trim();
  if (!trimmed) return undefined;
  // Reject compound specifiers like ">=1.0,<2.0" — no single version in use.
  if (trimmed.includes(",")) return undefined;
  const m = /^===?\s*([^\s;]+)$/.exec(trimmed);
  return m?.[1];
}

/**
 * Parses a `requirements.txt`.
 *
 * Handles comments, environment markers, extras, line continuations, and the
 * `-r`/`-e`/`--flag` directives pip understands. Nested `-r` files cannot be
 * followed (the content was pasted, not mounted), so they are reported.
 */
export function parseRequirementsTxt(text: string): ParsedManifest {
  const warnings: string[] = [];
  const seen = new Map<string, ParsedDependency>();

  // Join backslash continuations before anything else.
  const joined = text.replace(/\\\r?\n/g, " ");

  for (const rawLine of joined.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    // A `#` only starts a comment at line start or after whitespace.
    line = line.replace(/(^|\s)#.*$/, "$1").trim();
    if (!line) continue;

    if (/^-r\b|^--requirement\b/.test(line)) {
      warnings.push(`Cannot follow "${line}" — paste that file separately.`);
      continue;
    }
    if (/^-e\b|^--editable\b/.test(line)) {
      warnings.push(`Skipped editable install "${line}".`);
      continue;
    }
    if (line.startsWith("-")) continue; // --index-url, --hash, etc.
    if (/^[a-z+]+:\/\//i.test(line)) {
      warnings.push(`Skipped direct URL requirement "${truncate(line, 60)}".`);
      continue;
    }

    // Drop the environment marker; it constrains when to install, not what.
    const [requirement] = line.split(";");
    if (!requirement) continue;

    // PEP 508 direct reference: "name @ https://…" — no registry version.
    if (requirement.includes("@")) {
      const name = requirement.split("@")[0]?.trim();
      warnings.push(`Skipped "${name ?? line}": pinned to a direct URL, not a PyPI release.`);
      continue;
    }

    const m = SPECIFIER.exec(requirement.trim());
    if (!m?.[1]) continue;
    const rawName = m[1];
    const specifier = (m[3] ?? "").trim();

    if (!isValidPypiName(rawName)) {
      warnings.push(`Skipped "${rawName}": not a valid PyPI project name.`);
      continue;
    }

    const name = normalisePypiName(rawName);
    if (seen.has(name)) continue;
    seen.set(name, {
      name,
      range: specifier || undefined,
      resolvedVersion: exactVersionFrom(specifier),
      section: "requirements",
    });
  }

  if (seen.size === 0) {
    throw new ManifestParseError("No requirements found. Is this an empty or comment-only file?");
  }

  let dependencies = [...seen.values()];
  if (dependencies.length > MAX_DEPENDENCIES) {
    warnings.push(
      `File lists ${dependencies.length} requirements; scanning the first ${MAX_DEPENDENCIES}.`,
    );
    dependencies = dependencies.slice(0, MAX_DEPENDENCIES);
  }

  return { ecosystem: "pypi", kind: "requirements.txt", dependencies, warnings };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
