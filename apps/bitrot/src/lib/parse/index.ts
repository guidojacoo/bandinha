import { parsePackageJson, parsePackageLock } from "./npmManifest";
import { parseRequirementsTxt } from "./requirements";
import { ManifestParseError, type ParsedManifest } from "./types";

export * from "./types";
export { parsePackageJson, parsePackageLock, unwrapNpmAlias } from "./npmManifest";
export { parseRequirementsTxt, exactVersionFrom } from "./requirements";

export type ManifestKind = "package.json" | "package-lock.json" | "requirements.txt";

/**
 * Works out which manifest was pasted.
 *
 * The filename is a hint, not the answer — people paste a lockfile into a box
 * labelled package.json all the time — so the content decides whenever it can
 * speak for itself.
 */
export function detectManifestKind(text: string, filenameHint?: string): ManifestKind {
  const trimmed = text.trimStart();

  if (trimmed.startsWith("{")) {
    // `lockfileVersion` is present in every npm lockfile and in no package.json.
    return /"lockfileVersion"\s*:/.test(text) ? "package-lock.json" : "package.json";
  }

  const hint = filenameHint?.toLowerCase() ?? "";
  if (hint.includes("package-lock")) return "package-lock.json";
  if (hint.includes("package.json")) return "package.json";
  return "requirements.txt";
}

export function parseManifest(text: string, filenameHint?: string): ParsedManifest {
  if (!text.trim()) throw new ManifestParseError("Nothing to scan — the manifest is empty.");

  switch (detectManifestKind(text, filenameHint)) {
    case "package-lock.json":
      return parsePackageLock(text);
    case "package.json":
      return parsePackageJson(text);
    case "requirements.txt":
      return parseRequirementsTxt(text);
  }
}
