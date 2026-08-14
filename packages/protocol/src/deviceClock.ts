/**
 * The H59's clock is naive/local (set via CMD.SET_TIME with local wall-clock
 * BCD values, no timezone info) and it indexes history requests the same
 * way. Requesting a plain UTC midnight makes the device answer with the
 * wrong day whenever the phone isn't in UTC. OpenH59 discovered and worked
 * around this in `Band.heart_rate_history` (docs/APPUNTI-TECNICI.md); this
 * is the same fix: take the real local-midnight instant, then shift it by
 * the local UTC offset so the *wall-clock numbers* land where the device
 * expects them when it (mis)interprets the timestamp as UTC.
 */
export function localMidnightAsDeviceSeconds(daysAgo: number, referenceDate: Date = new Date()): number {
  const local = new Date(referenceDate);
  local.setHours(0, 0, 0, 0);
  local.setDate(local.getDate() - daysAgo);

  const realUtcSeconds = Math.floor(local.getTime() / 1000);
  const offsetSeconds = -local.getTimezoneOffset() * 60; // JS offset is (UTC - local) in minutes; we need (local - UTC) in seconds
  return realUtcSeconds + offsetSeconds;
}
