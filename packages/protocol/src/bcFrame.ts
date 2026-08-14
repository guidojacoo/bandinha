import { BC_MAGIC } from "./constants";
import { crc16Modbus } from "./checksum";

/**
 * "bc" big-data channel frame: BC(0xBC) | type(1) | len(2 LE) | crc16-modbus(2 LE) | body.
 * Mirrors OpenH59's `bc_frame` / Gadgetbridge's big-data-v2 framing.
 */
export function buildBcFrame(type: number, body: Uint8Array | number[] = []): Uint8Array {
  const bodyBytes = body instanceof Uint8Array ? body : Uint8Array.from(body);
  const frame = new Uint8Array(6 + bodyBytes.length);
  frame[0] = BC_MAGIC;
  frame[1] = type;
  new DataView(frame.buffer).setUint16(2, bodyBytes.length, true);
  new DataView(frame.buffer).setUint16(4, crc16Modbus(bodyBytes), true);
  frame.set(bodyBytes, 6);
  return frame;
}

export interface ParsedBcFrame {
  type: number;
  body: Uint8Array;
  crcValid: boolean;
}

/**
 * Reassembles "bc" channel frames from a stream of BLE notification chunks,
 * which the device is free to split arbitrarily. Feed every raw notification
 * to `push()`; complete frames come back immediately, partial ones are buffered
 * until the rest arrives. Mirrors OpenH59's `Band._on_bc`.
 */
export class BcFrameReassembler {
  private buf: number[] = [];

  push(chunk: Uint8Array): ParsedBcFrame[] {
    this.buf.push(...chunk);
    const frames: ParsedBcFrame[] = [];
    for (;;) {
      const magicIdx = this.buf.indexOf(BC_MAGIC);
      if (magicIdx < 0) {
        this.buf = [];
        return frames;
      }
      if (magicIdx > 0) this.buf.splice(0, magicIdx);
      if (this.buf.length < 6) return frames;

      const header = Uint8Array.from(this.buf.slice(0, 6));
      const len = new DataView(header.buffer).getUint16(2, true);
      const total = 6 + len;
      if (this.buf.length < total) return frames;

      const frameBytes = Uint8Array.from(this.buf.slice(0, total));
      this.buf.splice(0, total);

      const body = frameBytes.subarray(6);
      const expectedCrc = new DataView(frameBytes.buffer, frameBytes.byteOffset).getUint16(4, true);
      frames.push({
        type: frameBytes[1]!,
        body,
        crcValid: crc16Modbus(body) === expectedCrc,
      });
    }
  }

  reset(): void {
    this.buf = [];
  }
}
