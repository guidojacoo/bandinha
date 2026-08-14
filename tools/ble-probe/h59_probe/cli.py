"""
H59 BLE research CLI. This is a HARDWARE RESEARCH TOOL, not part of the
product — it exists to answer the open questions in docs/BLE_PROTOCOL.md
(vibration, alarms) against a real device and print evidence you can act on
or share back.

Usage:
    python -m h59_probe scan
    python -m h59_probe capabilities --address ADDR
    python -m h59_probe vibrate-test --address ADDR
    python -m h59_probe watch --address ADDR
    python -m h59_probe send-raw --address ADDR --cmd 0x50 --payload 55,AA --i-understand-this-is-experimental

Wear the band, turn your phone's Bluetooth OFF first (the band only talks to
one master at a time — see tools/ble-probe/README.md).
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from bleak import BleakScanner

from . import protocol
from .connection import H59Probe


async def cmd_scan(_args: argparse.Namespace) -> None:
    print("Scanning for 10s... (wear the band, phone Bluetooth OFF)")
    devices = await BleakScanner.discover(timeout=10)
    if not devices:
        print("No BLE devices found at all — check adapter / permissions.")
        return
    print(f"\n{'ADDRESS':<40} NAME")
    for d in devices:
        marker = "  <-- looks like an H59" if d.name and d.name.upper().startswith("H59") else ""
        print(f"{d.address:<40} {d.name or '(no name)'}{marker}")


async def cmd_capabilities(args: argparse.Namespace) -> None:
    async with H59Probe(args.address) as probe:
        frames = await probe.send_and_collect(protocol.build_set_time_now(), "set_time", wait_s=3.0)
        matching = [f for f in frames if f and f[0] == protocol.CMD_SET_TIME]
        if not matching:
            print("\nNo response to set_time — could not read capabilities.")
        else:
            caps = protocol.Capabilities.from_set_time_response(matching[0])
            print("\nDevice capabilities (from cmd 0x01 response bitmap):")
            for field, value in caps.__dict__.items():
                print(f"  {field:<16} {'yes' if value else 'no'}")

        bat_frames = await probe.send_and_collect(protocol.build_battery_request(), "battery", wait_s=2.0)
        matching_bat = [f for f in bat_frames if f and f[0] == protocol.CMD_BATTERY]
        if matching_bat:
            level, charging = protocol.parse_battery(matching_bat[0])
            print(f"\nBattery: {level}% (charging={charging})")


async def cmd_vibrate_test(args: argparse.Namespace) -> None:
    print(
        "\n=== EXPERIMENTAL: vibration / find-device test ===\n"
        "Sending cmd 0x50 (payload 55 AA) — the 'find device' command used by\n"
        "Gadgetbridge for the ring/band family the H59 shares its protocol with.\n"
        "This is UNCONFIRMED on a real H59. WATCH AND FEEL THE BAND NOW.\n"
    )
    async with H59Probe(args.address) as probe:
        frame = protocol.build_frame(protocol.CMD_FIND_DEVICE, bytes([0x55, 0xAA]))
        responses = await probe.send_and_collect(frame, "find_device (EXPERIMENTAL)", wait_s=4.0)
        print(f"\nDid the band vibrate, blink, beep, or do anything at all? Note it down.")
        if responses:
            print(f"Device sent {len(responses)} response frame(s):")
            for r in responses:
                print(f"  {r.hex(' ')}")
        else:
            print("Device sent no response frame (that alone doesn't mean it did nothing physically).")
        print(
            "\nPlease report the result (felt vibration / saw blink / nothing / error) so "
            "docs/BLE_PROTOCOL.md can be updated from EXPERIMENTAL to SUPPORTED or ruled out."
        )


async def cmd_watch(args: argparse.Namespace) -> None:
    print("Watching for spontaneous notifications (Ctrl-C to stop)...")
    async with H59Probe(args.address):
        try:
            await asyncio.sleep(3600)
        except KeyboardInterrupt:
            pass


async def cmd_send_raw(args: argparse.Namespace) -> None:
    if not args.i_understand_this_is_experimental:
        print(
            "Refusing to send an arbitrary command without --i-understand-this-is-experimental.\n"
            "This sends a raw, possibly-undocumented command to real hardware. Worst realistic\n"
            "case for an unrecognized command byte is the device ignoring it or replying with an\n"
            "error bit (cmd | 0x80) — but we cannot guarantee that for every possible byte, so this\n"
            "flag exists to make sure you're doing this on purpose. See tools/ble-probe/README.md.",
            file=sys.stderr,
        )
        sys.exit(1)

    cmd = int(args.cmd, 0)
    payload = bytes(int(b, 16) for b in args.payload.split(",")) if args.payload else b""
    frame = protocol.build_frame(cmd, payload)

    async with H59Probe(args.address) as probe:
        responses = await probe.send_and_collect(frame, f"raw cmd=0x{cmd:02x}", wait_s=args.wait)
        print(f"\n{len(responses)} response frame(s):")
        for r in responses:
            flagged = " <-- error/unsupported bit set" if r and (r[0] & 0x80) else ""
            print(f"  {r.hex(' ')}{flagged}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="h59_probe", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("scan", help="List nearby BLE devices").set_defaults(func=cmd_scan)

    p = sub.add_parser("capabilities", help="Read device capability bitmap + battery")
    p.add_argument("--address", required=True)
    p.set_defaults(func=cmd_capabilities)

    p = sub.add_parser("vibrate-test", help="EXPERIMENTAL: test the find-device/vibration command")
    p.add_argument("--address", required=True)
    p.set_defaults(func=cmd_vibrate_test)

    p = sub.add_parser("watch", help="Connect and log spontaneous notifications")
    p.add_argument("--address", required=True)
    p.set_defaults(func=cmd_watch)

    p = sub.add_parser("send-raw", help="EXPERIMENTAL: send an arbitrary command frame")
    p.add_argument("--address", required=True)
    p.add_argument("--cmd", required=True, help="command byte, e.g. 0x50 or 80")
    p.add_argument("--payload", default="", help="comma-separated hex bytes, e.g. 55,AA")
    p.add_argument("--wait", type=float, default=3.0)
    p.add_argument("--i-understand-this-is-experimental", action="store_true")
    p.set_defaults(func=cmd_send_raw)

    args = parser.parse_args()
    try:
        asyncio.run(args.func(args))
    except RuntimeError as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
