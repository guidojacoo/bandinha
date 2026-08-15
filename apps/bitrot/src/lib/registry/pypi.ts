import { RegistryError, type RegistryPackage } from "./types";

const PYPI_REGISTRY = process.env.PYPI_REGISTRY_URL ?? "https://pypi.org";
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * PEP 503 name normalisation: lowercase, and any run of `-`, `_` or `.`
 * collapses to a single `-`. `Flask_SQLAlchemy` and `flask-sqlalchemy` are the
 * same project, and the cache key has to agree with that.
 */
export function normalisePypiName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

export function isValidPypiName(name: string): boolean {
  if (!name || name.length > 214) return false;
  return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(name);
}

interface PypiResponse {
  info?: {
    name?: string;
    version?: string;
    summary?: string;
    license?: string;
    license_expression?: string;
    classifiers?: string[];
    yanked?: boolean;
    yanked_reason?: string | null;
    home_page?: string | null;
    project_urls?: Record<string, string> | null;
  };
  releases?: Record<string, Array<{ upload_time_iso_8601?: string; yanked?: boolean }>>;
}

const REPO_URL_KEYS = ["source", "source code", "repository", "code", "github", "sourcecode"];

/** Picks the most repository-ish of the project URLs PyPI exposes. */
export function pickPypiRepository(
  projectUrls: Record<string, string> | null | undefined,
  homePage?: string | null,
): string | undefined {
  const entries = Object.entries(projectUrls ?? {});
  for (const key of REPO_URL_KEYS) {
    const hit = entries.find(([k]) => k.trim().toLowerCase() === key);
    if (hit?.[1]) return hit[1];
  }
  // Fall back to any URL that looks like a code host.
  const codeHost = entries.find(([, v]) => /github\.com|gitlab\.com|bitbucket\.org|codeberg\.org/i.test(v));
  if (codeHost) return codeHost[1];
  if (homePage && /github\.com|gitlab\.com|bitbucket\.org|codeberg\.org/i.test(homePage)) {
    return homePage;
  }
  return undefined;
}

export function pickDevelopmentStatus(classifiers: string[] | undefined): string | undefined {
  return classifiers?.find((c) => c.startsWith("Development Status ::"));
}

/** Converts a raw PyPI JSON response into the shared shape. */
export function normalisePypiResponse(
  doc: PypiResponse,
  fetchedAt = new Date(),
): RegistryPackage {
  const info = doc.info;
  if (!info?.name) throw new RegistryError("PyPI response has no name", "malformed");
  const latestVersion = info.version;
  if (!latestVersion) throw new RegistryError(`${info.name} has no version`, "malformed");

  // A version's release date is its earliest file upload; versions with no
  // files at all (yanked-and-purged) contribute nothing.
  const releaseDates: string[] = [];
  for (const files of Object.values(doc.releases ?? {})) {
    let earliest: number | undefined;
    for (const f of files ?? []) {
      if (!f.upload_time_iso_8601) continue;
      const t = Date.parse(f.upload_time_iso_8601);
      if (Number.isNaN(t)) continue;
      if (earliest === undefined || t < earliest) earliest = t;
    }
    if (earliest !== undefined) releaseDates.push(new Date(earliest).toISOString());
  }
  releaseDates.sort();

  const license = (info.license_expression?.trim() || info.license?.trim()) ?? undefined;
  const developmentStatus = pickDevelopmentStatus(info.classifiers);

  return {
    ecosystem: "pypi",
    name: normalisePypiName(info.name),
    latestVersion,
    description: info.summary ?? undefined,
    // PyPI lets `license` carry an entire license *text*; anything that long is
    // a body, not an identifier, so it is reported as unclear rather than
    // rendered into the UI.
    license: license && license.length <= 64 ? license : undefined,
    repositoryUrl: pickPypiRepository(info.project_urls, info.home_page),
    homepageUrl: info.home_page ?? undefined,
    // PyPI's JSON API does not expose the maintainer/owner list, so bus factor
    // is left unscored rather than inferred from the author string.
    maintainerCount: undefined,
    deprecated: info.yanked === true,
    deprecationNote: info.yanked_reason ?? undefined,
    developmentStatus,
    firstPublishAt: releaseDates[0],
    lastPublishAt: releaseDates[releaseDates.length - 1],
    releaseDates,
    releaseCount: releaseDates.length || Object.keys(doc.releases ?? {}).length,
    fetchedAt: fetchedAt.toISOString(),
  };
}

/** Fetches and normalises one package from the live PyPI registry. */
export async function fetchPypiPackage(name: string): Promise<RegistryPackage> {
  if (!isValidPypiName(name)) {
    throw new RegistryError(`"${name}" is not a valid PyPI project name`, "malformed");
  }

  const url = `${PYPI_REGISTRY}/pypi/${encodeURIComponent(name)}/json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "bitrot/0.1 (+dependency lifecycle audit)" },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new RegistryError(`PyPI timed out after ${REQUEST_TIMEOUT_MS}ms`, "network");
    }
    throw new RegistryError(
      `Could not reach PyPI: ${err instanceof Error ? err.message : String(err)}`,
      "network",
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) throw new RegistryError(`${name} is not published on PyPI`, "not_found");
  if (!res.ok) throw new RegistryError(`PyPI returned ${res.status} for ${name}`, "network");

  let doc: PypiResponse;
  try {
    doc = (await res.json()) as PypiResponse;
  } catch {
    throw new RegistryError(`PyPI returned unparseable metadata for ${name}`, "malformed");
  }
  return normalisePypiResponse(doc);
}
