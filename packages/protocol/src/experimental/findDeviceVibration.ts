import { CMD } from "../constants";
import { buildFrame } from "../frame";

/**
 * EXPERIMENTAL — not confirmed on a real H59.
 *
 * CMD.FIND_DEVICE (0x50) with payload [0x55, 0xAA] is implemented in
 * Gadgetbridge for the whole Colmi/Yawell ring+band family that the H59
 * shares its command set with (H59Coordinator extends AbstractYawellRingCoordinator
 * with zero protocol overrides — see docs/BLE_PROTOCOL.md for the citation).
 * On screenless rings this makes the ring blink an LED; the H59 is a band
 * with a physical vibration motor, so it is the strongest available
 * candidate for "make the band buzz right now" — but nobody has confirmed
 * that on an actual H59 in any source we found.
 *
 * Use tools/ble-probe/probe.py to test this against real hardware before
 * relying on it anywhere in the product. If it does nothing (or errors),
 * that itself is useful signal — record it in docs/BLE_PROTOCOL.md.
 */
export function experimentalFindDeviceOrVibrate(): Uint8Array {
  return buildFrame(CMD.FIND_DEVICE, [0x55, 0xaa]);
}
