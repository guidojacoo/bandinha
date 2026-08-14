import { FRAME_LENGTH } from "./constants";
import { sumChecksum } from "./checksum";

/**
 * Builds a fixed 16-byte main-channel frame: [cmd][payload up to 14 bytes][checksum].
 * Mirrors OpenH59's `make_packet` / Gadgetbridge's `buildPacket` byte-for-byte.
 */
export function buildFrame(cmd: number, payload: number[] | Uint8Array = []): Uint8Array {
  if (cmd < 0 || cmd > 0xff) throw new RangeError(`cmd out of range: ${cmd}`);
  if (payload.length > FRAME_LENGTH - 2) {
    throw new RangeError(`payload too long: ${payload.length} bytes (max ${FRAME_LENGTH - 2})`);
  }
  const frame = new Uint8Array(FRAME_LENGTH);
  frame[0] = cmd;
  frame.set(payload, 1);
  frame[FRAME_LENGTH - 1] = sumChecksum(frame.subarray(0, FRAME_LENGTH - 1));
  return frame;
}

export interface ParsedFrame {
  cmd: number;
  /** bytes[1..14], i.e. the frame minus cmd and checksum */
  payload: Uint8Array;
  checksumValid: boolean;
  raw: Uint8Array;
}

/** Parses (and checksum-validates) a 16-byte main-channel response frame. */
export function parseFrame(raw: Uint8Array): ParsedFrame {
  if (raw.length !== FRAME_LENGTH) {
    throw new RangeError(`expected a ${FRAME_LENGTH}-byte frame, got ${raw.length}`);
  }
  const expected = sumChecksum(raw.subarray(0, FRAME_LENGTH - 1));
  return {
    cmd: raw[0]!,
    payload: raw.subarray(1, FRAME_LENGTH - 1),
    checksumValid: expected === raw[FRAME_LENGTH - 1],
    raw,
  };
}
