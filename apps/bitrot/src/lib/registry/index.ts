import { fetchNpmPackage } from "./npm";
import { fetchPypiPackage, normalisePypiName } from "./pypi";
import type { Ecosystem, RegistryPackage } from "./types";

export * from "./types";
export { fetchNpmPackage, isValidNpmName, normaliseNpmPackument, normaliseLicense, normaliseRepositoryUrl } from "./npm";
export {
  fetchPypiPackage,
  normalisePypiName,
  normalisePypiResponse,
  pickPypiRepository,
  pickDevelopmentStatus,
  isValidPypiName,
} from "./pypi";

/** The name used as the cache key and shown in the UI. */
export function canonicalName(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "pypi" ? normalisePypiName(name) : name.trim();
}

export function fetchPackage(ecosystem: Ecosystem, name: string): Promise<RegistryPackage> {
  return ecosystem === "npm" ? fetchNpmPackage(name) : fetchPypiPackage(name);
}

/**
 * Runs `worker` over `items` with a bounded number in flight.
 *
 * Scans fan out to one registry request per dependency; without a bound a
 * 200-dependency lockfile would open 200 sockets at once and get throttled.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
