/**
 * Typed JSON columns on SQLite.
 *
 * SQLite has no JSON column type, so structured fields are stored as TEXT.
 * The point of these helpers is that a malformed or stale value — a row
 * written by an older schema, or a column someone edited by hand — returns
 * the fallback instead of throwing somewhere deep in a render.
 */

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Array-valued column, guaranteed to be an array of the right shape. */
export function fromJsonArray<T>(raw: string | null | undefined, guard?: (x: unknown) => x is T): T[] {
  const parsed = fromJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return guard ? parsed.filter(guard) : (parsed as T[]);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
