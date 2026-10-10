/**
 * Development-only session secret.
 *
 * Guarded so it can never be the secret in production: `sessionSecret()`
 * throws rather than falling back when NODE_ENV is production, so a missing
 * env var on a real deploy cannot silently sign sessions with a value that is
 * public in this repository.
 */
const DEV_SECRET = "rainmaker-development-secret-do-not-use-in-production";

export function sessionSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (raw && raw.length >= 32) return new TextEncoder().encode(raw);
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET must be at least 32 characters in production. Generate one with: openssl rand -base64 32",
    );
  }
  if (raw) throw new Error("SESSION_SECRET is set but shorter than 32 characters.");
  return new TextEncoder().encode(DEV_SECRET);
}
