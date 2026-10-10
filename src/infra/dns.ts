import { promises as dns } from "node:dns";
import type { MxResult } from "../core/deliverability";

/**
 * MX lookups, cached per domain for the life of the process.
 *
 * The one piece of infrastructure that cannot be faked: either a domain
 * accepts mail or it does not, and asking costs one UDP round trip against
 * 20-40% documented bounce rates in this category.
 *
 * Note the fallback to an A/AAAA record. A domain with no MX but with an
 * address record is still a valid mail destination under RFC 5321 §5.1, and
 * plenty of small businesses are configured exactly that way.
 */

const cache = new Map<string, Promise<MxResult>>();

export async function lookupMx(domain: string): Promise<MxResult> {
  const key = domain.trim().toLowerCase();
  if (!key) return { hasMx: false, errored: true, detail: "No domain." };

  const cached = cache.get(key);
  if (cached) return cached;

  const promise = resolve(key);
  cache.set(key, promise);
  return promise;
}

async function resolve(domain: string): Promise<MxResult> {
  try {
    const records = await dns.resolveMx(domain);
    if (records.length > 0) return { hasMx: true, errored: false, detail: `${records.length} MX record(s)` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    // NODATA/NOTFOUND are answers: the domain has no MX. Everything else —
    // timeouts, refusals, no resolver at all — means we could not ask, which
    // is recorded as an error so the address is treated as unknown, not bad.
    if (code !== "ENODATA" && code !== "ENOTFOUND") {
      return { hasMx: false, errored: true, detail: `MX lookup failed (${code || "unknown"})` };
    }
  }

  try {
    const addresses = await dns.resolve(domain);
    if (addresses.length > 0) {
      return { hasMx: true, errored: false, detail: "No MX, but an A record accepts mail (RFC 5321 §5.1)" };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code !== "ENODATA" && code !== "ENOTFOUND") {
      return { hasMx: false, errored: true, detail: `Address lookup failed (${code || "unknown"})` };
    }
  }

  return { hasMx: false, errored: false, detail: "No MX or address record." };
}

/** True when this process can resolve DNS at all. */
export async function dnsAvailable(): Promise<boolean> {
  try {
    await dns.resolveMx("gmail.com");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    return code === "ENODATA";
  }
}
