import type { DeviceCapabilities } from "@h59/shared";
import type { ParsedFrame } from "./frame";

/**
 * Decodes the response to CMD.SET_TIME (0x01) — the device's own declaration
 * of what it can actually do, independent of marketing claims. Byte offsets
 * verified against OpenH59's `Band.set_time` (docs/APPUNTI-TECNICI.md:
 * "temperatura: NON supportata" was discovered exactly this way).
 *
 * Always prefer this over assuming capabilities by model name: two units
 * sold as "H59" can ship different firmware/sensor configurations.
 */
export function decodeCapabilities(response: ParsedFrame): DeviceCapabilities {
  const b = response.payload; // b[i] here == frame byte (i+1), matches OpenH59's `b = resp[1:]`
  return {
    temperature: b[0] === 1,
    spo2: ((b[3] ?? 0) & 2) !== 0,
    bloodPressure: ((b[3] ?? 0) & 4) !== 0,
    stress: ((b[13] ?? 0) & 16) !== 0,
    hrv: ((b[13] ?? 0) & 32) !== 0,
    sleep: b[8] === 1,
  };
}
