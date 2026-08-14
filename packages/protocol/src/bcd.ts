/** Binary-coded decimal helpers used by CMD.SET_TIME. */
export function byteToBcd(value: number): number {
  return ((Math.floor(value / 10) & 0x0f) << 4) | (value % 10 & 0x0f);
}

export function bcdToByte(bcd: number): number {
  return ((bcd >> 4) & 0x0f) * 10 + (bcd & 0x0f);
}
