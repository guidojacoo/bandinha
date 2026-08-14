/**
 * UNKNOWN — no native "set alarm on device" command has been discovered in
 * any public source (OpenH59, Gadgetbridge, colmi_r02_client) as of this
 * writing. A Gadgetbridge maintainer confirmed, when asked to add alarm
 * support for H59, that it is not implemented and would require BLE
 * sniffing to reverse-engineer (see docs/BLE_PROTOCOL.md for the citation
 * and ATT handle hints they left).
 *
 * Deliberately not wired into the app. Use tools/ble-probe together with
 * OpenH59's docs/GUIDA_SNOOP_LOG.md capture procedure (snoop the official
 * QWatch Pro app while setting an alarm) to discover the real command, then
 * implement it here — do not guess a command and ship it.
 *
 * Until this exists, alarms are delivered as local phone notifications
 * (apps/mobile) which do not depend on this at all.
 */
export function buildSetAlarmCommand(): never {
  throw new Error(
    "Native device alarm command is UNKNOWN — see packages/protocol/src/experimental/alarm.ts and docs/BLE_PROTOCOL.md before implementing this.",
  );
}
