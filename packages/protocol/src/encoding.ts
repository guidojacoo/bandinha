/**
 * UTF-16 (with BOM) encoder, needed for the "bc" channel login frame (type
 * 0x4A), which mirrors what the QWatch Pro app sends: Python's `str.encode('utf-16')`
 * — a BOM followed by native-endian (little-endian, in practice) code units.
 */
export function encodeUtf16WithBom(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[2 + i * 2] = code & 0xff;
    out[2 + i * 2 + 1] = (code >> 8) & 0xff;
  }
  return out;
}
