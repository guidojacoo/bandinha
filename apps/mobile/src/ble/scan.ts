import type { Device } from "react-native-ble-plx";
import { bleManager } from "./manager";
import { requestBlePermissions } from "./permissions";

export interface ScanResult {
  id: string;
  name: string;
  rssi: number | null;
}

/** H59 units advertise as "H59_xxxx" — see docs/BLE_PROTOCOL.md. */
function looksLikeH59(name: string | null): boolean {
  return !!name && name.toUpperCase().startsWith("H59");
}

export class BleUnavailableError extends Error {
  constructor(public reason: "permissions" | "powered_off" | "unauthorized" | "unsupported") {
    super(`Bluetooth unavailable: ${reason}`);
  }
}

/**
 * Scans for nearby H59 bands for `durationMs`, calling `onFound` once per
 * newly-seen device. Throws BleUnavailableError up front if Bluetooth isn't
 * usable (permissions denied, adapter off, unsupported) — check for that
 * specifically in the pairing screen to show the right guidance.
 */
export async function scanForH59(
  onFound: (device: ScanResult) => void,
  durationMs = 12000,
): Promise<void> {
  const perms = await requestBlePermissions();
  if (!perms.granted) throw new BleUnavailableError("permissions");

  const state = await bleManager.state();
  if (state === "PoweredOff") throw new BleUnavailableError("powered_off");
  if (state === "Unauthorized") throw new BleUnavailableError("unauthorized");
  if (state !== "PoweredOn") throw new BleUnavailableError("unsupported");

  const seen = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    bleManager
      .startDeviceScan(null, { allowDuplicates: false }, (error, device: Device | null) => {
        if (error) {
          bleManager.stopDeviceScan();
          reject(error);
          return;
        }
        if (!device || seen.has(device.id) || !looksLikeH59(device.name)) return;
        seen.add(device.id);
        onFound({ id: device.id, name: device.name ?? "H59", rssi: device.rssi });
      })
      .catch(reject);

    setTimeout(() => {
      bleManager.stopDeviceScan();
      resolve();
    }, durationMs);
  });
}

export function stopScan(): void {
  bleManager.stopDeviceScan();
}
