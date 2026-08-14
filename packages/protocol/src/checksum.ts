/** Main-channel checksum: sum of all preceding bytes, mod 256. */
export function sumChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (const b of bytes) sum += b;
  return sum & 0xff;
}

/**
 * CRC16/MODBUS, used to validate "bc" (big-data) channel frame bodies.
 * Polynomial 0xA001, init 0xFFFF, no final XOR — verified against real
 * frames captured from the official app (see OpenH59 docs/APPUNTI-TECNICI.md).
 */
export function crc16Modbus(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}
