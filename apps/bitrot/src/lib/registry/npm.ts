import { RegistryError, type RegistryPackage } from "./types";

const NPM_REGISTRY = process.env.NPM_REGISTRY_URL ?? "https://registry.npmjs.org";

/**
 * Packument documents for packages with thousands of canary releases run to
 * several megabytes (react is ~7 MB). Reading one is fine; reading sixty in a
 * scan is not, so oversized documents are refused and reported rather than
 * silently stalling the scan.
 */
const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

/** npm names are already canonical; a scoped name needs its slash encoded. */
export function encodeNpmName(name: string): string {
  return name.replace("/", "%2F");
}

/** Valid npm names, per the registry's own rules, minus the length checks. */
export function isValidNpmName(name: string): boolean {
  if (!name || name.length > 214) return false;
  return /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name);
}

interface NpmPackument {
  name?: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, NpmVersionDoc>;
  time?: Record<string, string>;
  maintainers?: Array<{ name?: string } | string>;
  license?: unknown;
  repository?: unknown;
  homepage?: unknown;
  description?: string;
}

interface NpmVersionDoc {
  version?: string;
  deprecated?: string | boolean;
  license?: unknown;
  repository?: unknown;
  homepage?: unknown;
  description?: string;
}

export function normaliseLicense(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  // Historic npm shape: {type, url} — and the even older array of those.
  if (Array.isArray(value)) {
    const parts = value.map(normaliseLicense).filter(Boolean);
    return parts.length ? parts.join(" OR ") : undefined;
  }
  if (value && typeof value === "object" && "type" in value) {
    const t = (value as { type?: unknown }).type;
    return typeof t === "string" ? t.trim() || undefined : undefined;
  }
  return undefined;
}

export function normaliseRepositoryUrl(value: unknown): string | undefined {
  let raw: string | undefined;
  if (typeof value === "string") raw = value;
  else if (value && typeof value === "object" && "url" in value) {
    const u = (value as { url?: unknown }).url;
    if (typeof u === "string") raw = u;
  }
  if (!raw) return undefined;

  let url = raw.trim();
  if (!url) return undefined;
  url = url.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "");
  // Shorthand forms npm accepts: "user/repo", "github:user/repo".
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  else if (/^github:/.test(url)) url = `https://github.com/${url.slice(7)}`;
  else if (/^gitlab:/.test(url)) url = `https://gitlab.com/${url.slice(7)}`;
  else if (/^bitbucket:/.test(url)) url = `https://bitbucket.org/${url.slice(10)}`;
  else if (url.startsWith("git@")) url = `https://${url.slice(4).replace(":", "/")}`;
  if (!/^https?:\/\//.test(url)) return undefined;
  return url;
}

/**
 * Converts a raw packument into the shared shape. Split out from the fetch so
 * it can be unit-tested against recorded registry payloads.
 */
export function normaliseNpmPackument(doc: NpmPackument, fetchedAt = new Date()): RegistryPackage {
  const name = doc.name;
  if (!name) throw new RegistryError("Packument has no name", "malformed");

  const latestVersion = doc["dist-tags"]?.latest;
  if (!latestVersion) throw new RegistryError(`${name} has no latest dist-tag`, "malformed");

  const versions = doc.versions ?? {};
  const latestDoc: NpmVersionDoc = versions[latestVersion] ?? {};

  // `time` mixes real version keys with the `created`/`modified` bookkeeping
  // entries, so those two are dropped before anything is read as a release.
  const time = doc.time ?? {};
  const releaseDates: string[] = [];
  for (const [key, iso] of Object.entries(time)) {
    if (key === "created" || key === "modified" || key === "unpublished") continue;
    if (typeof iso !== "string") continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    releaseDates.push(new Date(t).toISOString());
  }
  releaseDates.sort();

  const maintainers = (doc.maintainers ?? [])
    .map((m) => (typeof m === "string" ? m : m?.name))
    .filter((n): n is string => typeof n === "string" && n.length > 0);

  const deprecatedRaw = latestDoc.deprecated;
  const deprecated =
    typeof deprecatedRaw === "string" ? deprecatedRaw.length > 0 : deprecatedRaw === true;

  const firstFromTime = typeof time.created === "string" ? time.created : undefined;

  return {
    ecosystem: "npm",
    name,
    latestVersion,
    description: latestDoc.description ?? doc.description,
    license: normaliseLicense(latestDoc.license ?? doc.license),
    repositoryUrl: normaliseRepositoryUrl(latestDoc.repository ?? doc.repository),
    homepageUrl:
      typeof (latestDoc.homepage ?? doc.homepage) === "string"
        ? ((latestDoc.homepage ?? doc.homepage) as string)
        : undefined,
    maintainerCount: maintainers.length > 0 ? maintainers.length : undefined,
    maintainers: maintainers.length > 0 ? maintainers : undefined,
    deprecated,
    deprecationNote: typeof deprecatedRaw === "string" ? deprecatedRaw : undefined,
    firstPublishAt: releaseDates[0] ?? normaliseIso(firstFromTime),
    lastPublishAt: releaseDates[releaseDates.length - 1],
    releaseDates,
    releaseCount: releaseDates.length || Object.keys(versions).length,
    fetchedAt: fetchedAt.toISOString(),
  };
}

function normaliseIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Fetches and normalises one package from the live npm registry. */
export async function fetchNpmPackage(name: string): Promise<RegistryPackage> {
  if (!isValidNpmName(name)) {
    throw new RegistryError(`"${name}" is not a valid npm package name`, "malformed");
  }

  const url = `${NPM_REGISTRY}/${encodeNpmName(name)}`;
  const res = await fetchWithTimeout(url, {
    headers: { accept: "application/json", "user-agent": "bitrot/0.1 (+dependency lifecycle audit)" },
  });

  if (res.status === 404) throw new RegistryError(`${name} is not published on npm`, "not_found");
  if (!res.ok) {
    throw new RegistryError(`npm registry returned ${res.status} for ${name}`, "network");
  }

  const declaredLength = Number(res.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_DOCUMENT_BYTES) {
    throw new RegistryError(
      `${name} metadata is ${Math.round(declaredLength / 1e6)} MB, above the ${Math.round(
        MAX_DOCUMENT_BYTES / 1e6,
      )} MB scan limit`,
      "too_large",
    );
  }

  let doc: NpmPackument;
  try {
    doc = (await res.json()) as NpmPackument;
  } catch {
    throw new RegistryError(`npm returned unparseable metadata for ${name}`, "malformed");
  }
  return normaliseNpmPackument(doc);
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RegistryError(`npm registry timed out after ${REQUEST_TIMEOUT_MS}ms`, "network");
    }
    throw new RegistryError(
      `Could not reach the npm registry: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  } finally {
    clearTimeout(timer);
  }
}
