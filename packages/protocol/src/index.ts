/**
 * @h59/protocol — H59 / Colmi-QC BLE protocol library.
 *
 * This package only deals in bytes: it builds command frames and parses
 * response frames. It has no dependency on any BLE library, so it is fully
 * unit-testable without hardware (see test/) and reusable from both
 * apps/mobile (react-native-ble-plx) and tools/ble-probe-adjacent Node
 * scripts.
 *
 * Multi-packet responses (HR/steps/stress/HRV history) must be collected by
 * the transport layer — subscribe to CHARACTERISTIC_NOTIFY, buffer every
 * frame whose `cmd` matches the request until the device goes quiet (or a
 * timeout elapses), then hand the whole array to the matching parser. This
 * mirrors how OpenH59's `Band._request` and the mobile BLE device layer both
 * work.
 */

export * from "./constants";
export * from "./checksum";
export * from "./frame";
export * from "./bcFrame";
export * from "./capability";
export * from "./bcd";
export * from "./encoding";
export * from "./commands";
export * from "./syncPlan";
export * from "./deviceClock";

export * from "./parsers/battery";
export * from "./parsers/realtime";
export * from "./parsers/heartRateHistory";
export * from "./parsers/slotHistory";
export * from "./parsers/stepsHistory";
export * from "./parsers/sleepBlob";
export * from "./parsers/spo2History";

export * from "./experimental/findDeviceVibration";
export * from "./experimental/alarm";
