import { PermissionsAndroid, Platform } from "react-native";

/**
 * Android requires runtime permission grants for BLE scanning; iOS handles
 * this via the Info.plist usage description (NSBluetoothAlwaysUsageDescription,
 * set in app.json) plus a one-time system prompt — no explicit request call needed.
 *
 * Android 12+ (API 31+) uses BLUETOOTH_SCAN/BLUETOOTH_CONNECT.
 * Older Android ties BLE scanning to location permission.
 */
export async function requestBlePermissions(): Promise<{ granted: boolean; reason?: string }> {
  if (Platform.OS !== "android") return { granted: true };

  if (Platform.Version >= 31) {
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    const granted = Object.values(results).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
    return { granted, reason: granted ? undefined : "Bluetooth scan/connect permission denied" };
  }

  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  const granted = result === PermissionsAndroid.RESULTS.GRANTED;
  return { granted, reason: granted ? undefined : "Location permission denied (required for BLE scan pre-Android 12)" };
}
