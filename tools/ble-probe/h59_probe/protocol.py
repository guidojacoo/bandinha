"""
Minimal H59 / Colmi-QC BLE protocol primitives, independently re-implemented
from the reverse-engineering writeup in docs/BLE_PROTOCOL.md (cross-checked
across OpenH59, Gadgetbridge and colmi_r02_client — see that file for
citations). This intentionally duplicates a slice of what
packages/protocol (TypeScript) does: this tool exists to run standalone
against real hardware with `bleak`, without needing the Node/mobile toolchain
installed, so it needs its own small protocol layer.

Only SUPPORTED, cross-validated commands live here. Anything experimental is
kept in cli.py behind explicit flags so it can never run by accident.
"""
from __future__ import annotations

from dataclasses import dataclass

SERVICE_UART = "6e40fff0-b5a3-f393-e0a9-e50e24dcca9e"
CHARACTERISTIC_WRITE = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
CHARACTERISTIC_NOTIFY = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

CMD_SET_TIME = 0x01
CMD_BATTERY = 0x03
CMD_FIND_DEVICE = 0x50  # EXPERIMENTAL — see cli.py vibrate-test


def checksum(frame: bytearray) -> int:
    return sum(frame[:15]) & 0xFF


def build_frame(cmd: int, payload: bytes = b"") -> bytearray:
    if not (0 <= cmd <= 0xFF):
        raise ValueError(f"cmd out of range: {cmd}")
    if len(payload) > 14:
        raise ValueError(f"payload too long: {len(payload)} bytes (max 14)")
    frame = bytearray(16)
    frame[0] = cmd
    frame[1 : 1 + len(payload)] = payload
    frame[15] = checksum(frame)
    return frame


def byte_to_bcd(value: int) -> int:
    return ((value // 10) << 4) | (value % 10)


@dataclass
class Capabilities:
    temperature: bool
    spo2: bool
    blood_pressure: bool
    stress: bool
    hrv: bool
    sleep: bool

    @classmethod
    def from_set_time_response(cls, frame: bytes) -> "Capabilities":
        b = frame[1:]  # payload only, matches OpenH59's `b = resp[1:]`
        return cls(
            temperature=b[0] == 1,
            spo2=bool(b[3] & 2),
            blood_pressure=bool(b[3] & 4),
            stress=bool(b[13] & 16),
            hrv=bool(b[13] & 32),
            sleep=b[8] == 1,
        )


def build_set_time_now() -> bytearray:
    import datetime

    now = datetime.datetime.now()
    payload = bytes(
        [
            byte_to_bcd(now.year % 100),
            byte_to_bcd(now.month),
            byte_to_bcd(now.day),
            byte_to_bcd(now.hour),
            byte_to_bcd(now.minute),
            byte_to_bcd(now.second),
            1,
        ]
    )
    return build_frame(CMD_SET_TIME, payload)


def build_battery_request() -> bytearray:
    return build_frame(CMD_BATTERY)


def parse_battery(frame: bytes) -> tuple[int, bool]:
    return frame[1], bool(frame[2])
