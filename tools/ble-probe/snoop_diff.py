#!/usr/bin/env python3
"""
Alarm-discovery helper: diffs two Android HCI snoop logs to surface command
bytes that only appear while the official QWatch Pro app is doing the one
thing we can't decode yet (setting/toggling an alarm).

Capture procedure (reuses the workflow already written up for this protocol
family — see docs/BLE_PROTOCOL.md "How to discover the alarm command"):

  1. Capture BASELINE.log: enable HCI snoop logging on Android, connect
     QWatch Pro to the band, do nothing alarm-related for ~20s (just sit on
     the home screen), pull the log.
  2. Turn snoop logging off and back on (or just start a fresh capture) and
     capture ACTION.log: open QWatch Pro's alarm screen and set ONE alarm,
     nothing else, pull the log.
  3. Run:
       python snoop_diff.py diff BASELINE.log ACTION.log
     Command bytes that show up in ACTION but never in BASELINE are your
     best candidates for the alarm-set command. Cross-check the full frame
     bytes against the time you tapped "save" in the app.

Usage:
    python snoop_diff.py dump <btsnoop_hci.log>
    python snoop_diff.py diff <baseline.log> <action.log>
"""
from __future__ import annotations

import struct
import sys
from collections import Counter

KNOWN_CMDS = {
    0x01: "set_time", 0x03: "battery", 0x04: "phone_name", 0x08: "power_off",
    0x0A: "preferences", 0x0D: "sleep_history(legacy)", 0x15: "hr_history",
    0x16: "hr_log_settings", 0x21: "goals", 0x37: "stress_history",
    0x39: "hrv_history", 0x43: "steps", 0x48: "today_summary",
    0x50: "find_device(EXPERIMENTAL)", 0x69: "realtime", 0x6A: "realtime_stop",
    0x73: "notification(incoming)", 0xBC: "big_data(sleep/spo2)", 0xFF: "factory_reset",
}


def parse_btsnoop(path: str) -> list[tuple[int, str, bytes]]:
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"btsnoop\x00":
        raise ValueError(f"{path} is not a btsnoop file (missing magic header)")
    off = 16
    records = []
    while off + 24 <= len(data):
        olen, ilen, flags, _drops, ts = struct.unpack_from(">IIIIq", data, off)
        off += 24
        pkt = data[off : off + ilen]
        off += ilen
        if len(pkt) < ilen:
            break
        direction = "RECV" if (flags & 0x01) else "SENT"
        records.append((ts, direction, pkt))
    return records


def extract_att_value(pkt: bytes) -> tuple[int, int, bytes] | None:
    """From an H4/ACL/L2CAP/ATT packet, extract (opcode, handle, value) for write/notify ops."""
    if not pkt or pkt[0] != 0x02 or len(pkt) < 9:
        return None
    l2_len, cid = struct.unpack_from("<HH", pkt, 5)
    if cid != 0x0004:  # ATT channel
        return None
    att = pkt[9:]
    if not att:
        return None
    opcode = att[0]
    if opcode in (0x52, 0x12, 0x1B, 0x1D) and len(att) >= 3:  # write cmd/req, notify, indicate
        handle = struct.unpack_from("<H", att, 1)[0]
        return opcode, handle, att[3:]
    return None


def iter_16byte_frames(path: str):
    for ts, direction, pkt in parse_btsnoop(path):
        att = extract_att_value(pkt)
        if att is None:
            continue
        _opcode, handle, value = att
        if len(value) == 16:
            yield ts, direction, handle, value


def dump(path: str) -> None:
    print(f"=== {path} ===")
    seen = Counter()
    for ts, direction, handle, value in iter_16byte_frames(path):
        cmd = value[0]
        name = KNOWN_CMDS.get(cmd, "??? UNKNOWN")
        arrow = "phone->band" if direction == "SENT" else "band->phone"
        seen[cmd] += 1
        print(f"[{ts:>18}] {arrow} handle=0x{handle:04x} cmd=0x{cmd:02x} ({name})  {value.hex(' ')}")
    print(f"\nCommand bytes seen: {dict(sorted(seen.items()))}")


def diff(baseline_path: str, action_path: str) -> None:
    baseline_cmds = {v[0] for _, _, _, v in iter_16byte_frames(baseline_path)}
    print(f"Baseline ({baseline_path}): cmd bytes seen = {sorted(hex(c) for c in baseline_cmds)}\n")

    print(f"Frames from {action_path} whose command byte did NOT appear in the baseline:\n")
    novel = []
    for ts, direction, handle, value in iter_16byte_frames(action_path):
        if value[0] not in baseline_cmds:
            novel.append((ts, direction, handle, value))
            arrow = "phone->band" if direction == "SENT" else "band->phone"
            name = KNOWN_CMDS.get(value[0], "??? UNKNOWN — candidate!")
            print(f"[{ts:>18}] {arrow} handle=0x{handle:04x} cmd=0x{value[0]:02x} ({name})  {value.hex(' ')}")

    if not novel:
        print(
            "(none) — the alarm command might not be a 16-byte main-channel frame at all.\n"
            "Re-run with `dump` on both logs and also check the bc/big-data channel "
            "(handles matching de5bf72a-.../de5bf729-...) and any frame length other than 16."
        )
    else:
        print(
            f"\n{len(novel)} novel frame(s) found. The phone->band one closest in time to when "
            "you tapped 'save alarm' is your best candidate — try replaying its exact bytes with:\n"
            "  python -m h59_probe send-raw --address ADDR --cmd 0xNN --payload NN,NN,... "
            "--i-understand-this-is-experimental"
        )


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("dump", "diff"):
        print(__doc__)
        sys.exit(1)
    if sys.argv[1] == "dump":
        if len(sys.argv) != 3:
            print("Usage: python snoop_diff.py dump <btsnoop_hci.log>")
            sys.exit(1)
        dump(sys.argv[2])
    else:
        if len(sys.argv) != 4:
            print("Usage: python snoop_diff.py diff <baseline.log> <action.log>")
            sys.exit(1)
        diff(sys.argv[2], sys.argv[3])


if __name__ == "__main__":
    main()
