/**
 * Development-only session secret.
 *
 * Guarded so it can never be the secret in production: `sessionSecret()`
 * throws instead of falling back when NODE_ENV is production. Without that
 * guard a missing env var on a real deploy would silently sign every session
 * with a value that is public in this repository.
 */
const DEV_SESSION_SECRET = "bitrot-development-secret-do-not-use-in-production";

export function sessionSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (raw && raw.length >= 32) return new TextEncoder().encode(raw);

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET must be set to at least 32 characters in production. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  if (raw) {
    throw new Error("SESSION_SECRET is set but shorter than 32 characters — generate a longer one.");
  }
  return new TextEncoder().encode(DEV_SESSION_SECRET);
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy apps/bitrot/.env.example to apps/bitrot/.env and fill it in.",
    );
  }
  return url;
}

/** How long a cached registry record stays fresh before it is re-fetched. */
export function cacheTtlMs(): number {
  const hours = Number(process.env.REGISTRY_CACHE_TTL_HOURS ?? "6");
  return (Number.isFinite(hours) && hours > 0 ? hours : 6) * 60 * 60 * 1000;
}
